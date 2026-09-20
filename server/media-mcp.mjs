// 出图工具（v1.10，docs/adr/0019）：自建 MCP server（stdio JSON-RPC，零依赖），把「玩家自备的
// OpenAI 兼容图像服务」变成一个引擎可调用的工具 `generate_image`。
//
// 为什么是 MCP 而不是「服务端抢先出图」：出图的三条路径（制作中清单、游戏内首现背景、素材重绘）
// 里只有前两者有客户端指令可拦，首现背景是引擎自己在回合中间决定要画的——服务端在收到 `美术：…` 时
// 抢先出图覆盖不全（ADR-0019「被否决的替代」）。挂在会话上的 MCP server 则天然覆盖三条路径。
//
// 与 grok CLI 的接线（第 0 步实证，docs/ARCHITECTURE.md「引擎凭据与自备 key」）：
//   · CLI 认 session/new 与 session/load 的 `mcpServers`（ACP 形态 `{name, command, args, env:[{name,value}]}`），
//     子进程 cwd = 会话 cwd、env = 父进程 env + 我们给的变量；
//   · 它的工具**不直接进模型工具表**，而是经 `search_tool` 发现、`use_tool` 调用（catalog 键
//     `bunkiten-media__generate_image`）——所以 SKILL.md 的契约句要连着这条路一起写。
//
// 安全纪律：key 从 `~/.bunkiten/credentials.json`（0600）自己读，**不进 env、不进命令行参数**；
// 任何失败都回 `{ok:false, error}` 的工具结果（不抛栈、不写日志明文），让引擎静默回退内置 image_gen。
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { ART_KINDS } from "../shared/protocol.mjs";
import { GAME_ROOT } from "./config.mjs";
import { PRESET_ID_RE, presetIdFromPath, sanitizeAssetName } from "./assets.mjs";
import { assetTargetFile } from "./presets.mjs";
import { readCredentials, sanitizeErrorMessage } from "./credentials.mjs";

/** MCP server 名（catalog 前缀，同时也是设置屏/文档里说的那个名字；契约 lint ⑦ 组钉住它与 SKILL 的一致） */
export const MEDIA_MCP_NAME = "bunkiten-media";

/** 工具名（catalog 键 = `${MEDIA_MCP_NAME}__${MEDIA_TOOL_NAME}` = `bunkiten-media__generate_image`） */
export const MEDIA_TOOL_NAME = "generate_image";

/** 一次生成的墙钟上限（毫秒）：超了放弃——引擎那边还有自己的工具超时，早失败早回退 */
export const GENERATE_TIMEOUT_MS = 90_000;

/** 下载 provider 返回图片 URL 的上限（毫秒） */
export const DOWNLOAD_TIMEOUT_MS = 45_000;

/** 美术类型白名单的 string 视图（ART_KINDS 是真源；这里只为一处运行期校验放宽类型） */
const ART_KIND_LIST = /** @type {string[]} */ ([...ART_KINDS]);

/** 出图尺寸的按类型默认（OpenAI 兼容口径的 `<宽>x<高>`；立绘/封面竖构图、背景 16:9） */
export const DEFAULT_SIZES = Object.freeze({ 立绘: "1024x1536", 封面: "1024x1536", 背景: "1536x1024" });

/**
 * 工具定义（tools/list 的条目；inputSchema 就是引擎 `search_tool` 会看到的 schema）。
 * outRelPath 让引擎给出目标相对路径（`presets/<剧本 id>/assets/<类型>-<名字>.jpg`）——
 * 我们只从它解析出剧本 id，落盘路径仍由 assets.mjs 的纯函数重建（不信任字符串拼路径）。
 */
export const TOOL_DEFINITION = Object.freeze({
  name: MEDIA_TOOL_NAME,
  description:
    "生成一张剧本美术（立绘/背景/封面）并落盘到 presets/<剧本 id>/assets/（封面为 presets/<剧本 id>/cover.jpg）。" +
    "返回 { ok, relPath }，relPath 可直接用在【图】标记里（文件已在盘上，命中缓存即可复用）。" +
    "失败时返回 { ok:false, error }，调用方应静默回退内置 image_gen 或跳过本次出图。",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "出图提示词（外形、构图、光线；不要写剧情正文）" },
      kind: { type: "string", enum: [...ART_KINDS], description: "美术类型：立绘（含表情差分）/ 背景 / 封面" },
      name: { type: "string", description: "立绘=角色名；背景=地点名；封面=剧本标题" },
      variant: { type: "string", description: "立绘表情差分名（可选，如 微笑；基础立绘留空）" },
      outRelPath: {
        type: "string",
        description: "目标相对路径，形如 presets/<剧本 id>/assets/立绘-薇拉.jpg 或 presets/<剧本 id>/cover.jpg（剧本 id 由它解析）",
      },
    },
    required: ["prompt", "kind", "name", "outRelPath"],
  },
});

/**
 * 出图尺寸（纯函数）：取值链——
 *   1. 背景专用 `sizeBackground`（只对背景生效）；
 *   2. 通用 `size`（两格都空时的玩家覆盖，历史语义：对所有类型生效）；
 *   3. 按类型默认（立绘/封面竖构图、背景横构图）。
 * @param {string} kind 美术类型（立绘/背景/封面）
 * @param {{size?: string, sizeBackground?: string}} [image] 图片组凭据（缺省=全按类型默认）
 * @returns {string} `<宽>x<高>`
 */
export function imageSizeFor(kind, image = {}) {
  const k = String(kind || "").trim();
  const general = String(image?.size || "").trim();
  const background = String(image?.sizeBackground || "").trim();
  const picked = k === "背景" ? background || general : general;
  if (picked) return picked;
  return DEFAULT_SIZES[/** @type {keyof typeof DEFAULT_SIZES} */ (kind)] || "1024x1024";
}

/**
 * 出图端点（纯函数）：base_url 去尾斜杠后接 `/images/generations`。
 * @param {string} baseUrl 服务地址（settings 里的 base_url）
 * @returns {string} 完整 URL
 */
export function imagesEndpoint(baseUrl) {
  return `${String(baseUrl || "").trim().replace(/\/+$/, "")}/images/generations`;
}

/**
 * 目标落盘路径（纯函数）：只从 outRelPath 解析剧本 id，再由 assets/presets 的既有纯函数重建路径。
 * 封面走 `presets/<id>/cover.jpg`（assetTargetFile 的封面分支），立绘/背景走 assetRelPath 形态；
 * 差分名拼在名字里（`<名>-<变体>`，与 splitAssetVariant 的口径一致）。
 * @param {{kind?: string, name?: string, variant?: string, outRelPath?: string}} p 工具入参
 * @returns {{rel: string} | {error: string}} 相对 GAME_ROOT 的落盘路径，或人话错误
 */
export function resolveOutputPath({ kind = "", name = "", variant = "", outRelPath = "" } = {}) {
  const k = String(kind || "").trim();
  if (!ART_KIND_LIST.includes(k)) return { error: `kind 必须是 ${ART_KINDS.join("/")}` };
  const presetId = presetIdFromPath(outRelPath);
  if (!presetId || !PRESET_ID_RE.test(presetId)) {
    return { error: "outRelPath 必须是 presets/<剧本 id>/assets/… 或 presets/<剧本 id>/cover.jpg，且剧本 id 合法" };
  }
  const rawName = String(name || "").trim();
  if (!rawName) return { error: "name 不能为空" };
  if (k === "封面") {
    // 封面：剧本 id 已从 outRelPath 解析出来，**不给 rawName**——assetTargetFile 的封面分支会先按标题反查剧本，
    // 两个剧本同名时会写到另一个里去；我们这里的 id 是权威的。
    const rel = assetTargetFile("封面", "", presetId);
    return rel ? { rel } : { error: "封面路径构造失败" };
  }
  const variantName = String(variant || "").trim();
  // 引擎可能把变体写进 name（`薇拉-微笑`）又另给了 variant——别拼成 `薇拉-微笑-微笑`
  const withVariant = variantName && !rawName.endsWith(`-${variantName}`) ? `${rawName}-${variantName}` : rawName;
  const rel = assetTargetFile(k, sanitizeAssetName(withVariant), presetId);
  return rel ? { rel } : { error: "资产路径构造失败" };
}

/**
 * 从 provider 响应里取出图片字节（纯函数）：优先 b64_json，其次 url（由调用方下载）。
 * @param {any} payload 响应 JSON
 * @returns {{bytes: Buffer} | {url: string} | {error: string}} 三种形态之一
 */
export function pickImagePayload(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : typeof payload?.data === "string" ? payload.data : undefined;
  if (item === undefined || item === null) return { error: "响应里没有 data[0]" };
  const b64 = typeof item === "string" ? (item.startsWith("http") ? "" : item) : item.b64_json || item.b64 || item.base64 || "";
  if (b64) {
    try {
      return { bytes: Buffer.from(String(b64), "base64") };
    } catch {
      return { error: "base64 解码失败" };
    }
  }
  const url = typeof item === "string" && item.startsWith("http") ? item : item.url;
  if (typeof url === "string" && /^https?:\/\//.test(url)) return { url };
  return { error: "响应里既没有 b64_json 也没有 url" };
}

/** @param {number} ms 超时毫秒 @returns {{signal: AbortSignal, clear: () => void}} */
function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout ${ms}ms`)), ms);
  t.unref?.();
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

/**
 * 调一次 OpenAI 兼容的出图端点（可注入 fetch 以便单测；错误一律脱敏成短句）。
 * 兼容梯子：先带 `size` 与 `response_format=b64_json`；若服务端 400 且明确抱怨这两个参数之一，
 * 就去掉它再试一次（最多再退两次）——gpt-image-1 不接受 response_format、xAI 口径用 aspect_ratio
 * 而不认 size，靠这层退让一家都不用手写适配。
 * @param {object} p 参数
 * @param {string} p.baseUrl 服务地址
 * @param {string} p.apiKey 明文 key（只进 Authorization 头）
 * @param {string} p.model 出图模型
 * @param {string} p.prompt 提示词
 * @param {string} p.size 尺寸（`<宽>x<高>`）
 * @param {typeof fetch} [p.fetchImpl] 注入的 fetch（缺省全局 fetch）
 * @returns {Promise<{bytes: Buffer, status: number} | {error: string, status?: number}>} 图片字节或人话错误
 *   注：返回的字节可能是 PNG/WebP（服务商决定），落盘仍按资产契约叫 `.jpg`——`/img` 直服声明 image/jpeg，
 *   浏览器按内容嗅探照常渲染；不转码（引图像库会破坏 server 树零依赖），见 docs/ARCHITECTURE.md「引擎凭据与自备 key」。
 */
export async function requestImage({ baseUrl, apiKey, model, prompt, size, fetchImpl = fetch }) {
  const url = imagesEndpoint(baseUrl);
  const secrets = [apiKey];
  /** @type {Record<string, unknown>} */
  let body = { model, prompt, n: 1, size, response_format: "b64_json" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = timeoutSignal(GENERATE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: t.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // 参数不被接受时退让：去 size / 去 response_format 各重试一次（只认服务端明说的那个参数）
        const lower = text.toLowerCase();
        const canDropSize = "size" in body && /size/.test(lower) && /(unsupported|unknown|invalid|not\s+allowed|unrecognized)/.test(lower);
        const canDropFormat = "response_format" in body && /response_format/.test(lower);
        if (attempt < 2 && canDropFormat) {
          body = { model, prompt, n: 1, size };
          continue;
        }
        if (attempt < 2 && canDropSize) {
          const { size: _drop, ...rest } = body;
          body = rest;
          continue;
        }
        return { error: sanitizeErrorMessage(`HTTP ${res.status} ${text.slice(0, 300)}`, secrets), status: res.status };
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return { error: "服务端返回的不是 JSON", status: res.status };
      }
      const picked = pickImagePayload(payload);
      if ("bytes" in picked) return { bytes: picked.bytes, status: res.status };
      if ("url" in picked) {
        const d = timeoutSignal(DOWNLOAD_TIMEOUT_MS);
        try {
          const r2 = await fetchImpl(picked.url, { signal: d.signal });
          if (!r2.ok) return { error: `下载图片失败：HTTP ${r2.status}`, status: res.status };
          return { bytes: Buffer.from(await r2.arrayBuffer()), status: res.status };
        } catch (e) {
          return { error: sanitizeErrorMessage(`下载图片失败：${e?.message ?? e}`, secrets), status: res.status };
        } finally {
          d.clear();
        }
      }
      return { error: picked.error, status: res.status };
    } catch (e) {
      const msg = e?.name === "AbortError" || /timeout/.test(String(e?.message)) ? `出图超时（${GENERATE_TIMEOUT_MS / 1000}s）` : `出图请求失败：${e?.message ?? e}`;
      return { error: sanitizeErrorMessage(msg, secrets) };
    } finally {
      t.clear();
    }
  }
  return { error: "出图请求失败：参数不被服务接受" };
}

/**
 * 工具的完整行为（可注入依赖以便单测）：读凭据 → 校验 → 出图 → 落盘 → 回相对路径。
 * 永不抛：任何失败都变成 `{ok:false, error}`（引擎据此静默回退）。
 * @param {{prompt?: string, kind?: string, name?: string, variant?: string, outRelPath?: string}} params 工具入参
 * @param {object} [deps] 依赖注入
 * @param {import("./credentials.mjs").Credentials} [deps.creds] 凭据（缺省读磁盘）
 * @param {string} [deps.gameRoot] 游戏根（缺省 GAME_ROOT）
 * @param {typeof fetch} [deps.fetchImpl] fetch 实现
 * @returns {Promise<{ok: true, relPath: string, bytes: number} | {ok: false, error: string}>}
 */
export async function generateImage(params, deps = {}) {
  const creds = deps.creds ?? readCredentials();
  const gameRoot = deps.gameRoot ?? GAME_ROOT;
  const prompt = String(params?.prompt || "").trim();
  if (!prompt) return { ok: false, error: "prompt 不能为空" };
  if (creds.image.mode !== "byok") return { ok: false, error: "未配置图片服务" };
  const { baseUrl, apiKey, model } = creds.image;
  if (!baseUrl || !apiKey || !model) return { ok: false, error: "图片服务配置不完整（需要地址、密钥与模型）" };
  const target = resolveOutputPath(params);
  if ("error" in target) return { ok: false, error: target.error };
  const size = imageSizeFor(String(params?.kind || ""), creds.image);
  const out = await requestImage({ baseUrl, apiKey, model, prompt, size, fetchImpl: deps.fetchImpl });
  if ("error" in out) return { ok: false, error: out.error };
  const abs = path.join(gameRoot, target.rel);
  try {
    if (!path.resolve(abs).startsWith(path.resolve(gameRoot) + path.sep)) return { ok: false, error: "落盘路径越界" };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, out.bytes);
  } catch (e) {
    return { ok: false, error: `写入失败：${e?.message ?? e}` };
  }
  return { ok: true, relPath: target.rel, bytes: out.bytes.length };
}

// ---------------- 与 ACP 会话的接线（入口 acp.mjs 消费） ----------------

/**
 * asar 内路径 → `app.asar.unpacked/` 里的真实路径（纯函数，单测直测）。
 * 开发态没有这两段，原样返回；打包态 `electron-builder.yml` 的 asarUnpack 保证解开的那份存在。
 * @param {string} p 任意路径
 * @returns {string} 替换后的路径
 */
export function asarUnpackedPath(p) {
  return String(p).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

/**
 * 本文件在磁盘上的真实路径：打包态它在 app.asar 里，而**子进程读不了 asar**——
 * electron-builder.yml 的 asarUnpack 把 server/media-mcp.mjs 同时放到 `app.asar.unpacked/`，
 * 这里把路径里的 `app.asar` 段换成 `app.asar.unpacked`（见 {@link asarUnpackedPath}）。
 * @returns {string} 可直接喂给 spawn 的脚本路径
 */
export function mediaMcpPath() {
  return asarUnpackedPath(fileURLToPath(new URL("./media-mcp.mjs", import.meta.url)));
}

/**
 * 要挂到 ACP 会话上的 MCP server 列表（**只有配了图片自备 key 才挂**——没配的人不该多一个常驻子进程）。
 * 形态是 ACP 的 McpServerStdio：`{name, command, args, env:[{name,value}]}`（第 0 步实证：CLI 认这个形态，
 * 子进程 cwd = 会话 cwd、env = 父进程 env ∪ 这里给的变量）。
 * ELECTRON_RUN_AS_NODE：打包态/开发态的 `process.execPath` 都是 Electron 可执行文件，
 * 不带这个变量就会起出第二个 Electron 应用而不是 Node 脚本。
 * @param {import("./credentials.mjs").Credentials} creds 凭据
 * @returns {Array<{name: string, command: string, args: string[], env: Array<{name: string, value: string}>}>} MCP server 列表
 */
export function mediaMcpServers(creds) {
  if (creds.image.mode !== "byok") return [];
  return [
    {
      name: MEDIA_MCP_NAME,
      command: process.execPath,
      args: [mediaMcpPath()],
      env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
    },
  ];
}

// ---------------- MCP stdio 传输（JSON-RPC 2.0，逐行） ----------------

/** @param {object} obj @returns {void} 写一行 JSON-RPC 到 stdout */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * 处理一条 MCP 消息（导出以便单测直接喂消息，不必 spawn）。
 * @param {any} msg 解析后的 JSON-RPC 消息
 * @param {(msg: object) => void} respond 回一条 JSON-RPC 消息
 * @param {(params: object) => Promise<{ok?: boolean}>} callTool 工具执行器（缺省 generateImage）
 * @returns {Promise<void>}
 */
export async function handleMcpMessage(msg, respond, callTool = (p) => generateImage(p)) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return;
  const id = msg.id;
  if (msg.method === "initialize") {
    respond({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: MEDIA_MCP_NAME, version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized" || id === undefined) return; // 通知类消息：不回复
  if (msg.method === "tools/list") {
    respond({ jsonrpc: "2.0", id, result: { tools: [TOOL_DEFINITION] } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = String(msg.params?.name || "");
    const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
    if (name !== MEDIA_TOOL_NAME) {
      respond({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `未知工具：${name}` }) }], isError: true },
      });
      return;
    }
    let out;
    try {
      out = await callTool(args);
    } catch (e) {
      // 工具执行器理论上不抛（generateImage 自己兜底）；这里再兜一层，绝不让 MCP 会话因一次出图崩掉
      out = { ok: false, error: `出图失败：${e?.message ?? e}` };
    }
    respond({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(out) }], isError: out.ok !== true },
    });
    return;
  }
  respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的 MCP 方法：${msg.method}` } });
}

/** 起 stdio 循环（只在被直接运行时调用） */
function serve() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    void handleMcpMessage(msg, send);
  });
  rl.on("close", () => process.exit(0)); // 父进程（引擎）退出 → stdin 关 → 跟着退，不留孤儿
}

// 直接运行：node server/media-mcp.mjs（引擎的 MCP 子进程入口）
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) serve();
