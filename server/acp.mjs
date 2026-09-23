// ACP 子进程封装（v1.7 拆模块，v1.11 多后端；docs/adr/0022）：spawn 引擎、JSON-RPC request/响应分发、
// sessionId 存取（断线续档）、boot 握手（session/load 降级 session/new + 推理档位）、权限请求兜底、会话图片定位。
// 与 HTTP 层的接缝是两个回调：onChunk（agent_message_chunk 文本）与 onSeg（tool_call 进度 label）——
// 流式【图】标记扫描、seg 计数与 SSE broadcast 留在入口的 startServer 闭包里（那里才有 registry 与 clients）。
//
// 多后端形态：本工厂**只认 server/engines.mjs 的描述符**（spawn 三件套、会话扩展、档位形状、图片根），
// 不出现品牌字面量——grok 与 Codex（codex-acp）走同一条 ACP 传输。描述符里的每个字面量都有
// docs/adr/0022「第 0 步实证」背书。
import { spawn } from "child_process";
import readline from "readline";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * ACP 的权限请求应答（规格：`{outcome:{outcome:"selected", optionId}}`；规格明文允许客户端自动放行）。
 * 单机游戏里引擎本就以「全自动」起（grok 的 `--always-approve` / codex 的 `agent-full-access`），
 * 这里只作兜底：优先 `allow_once`，其次 `allow_always`，再次任何 allow 形态的选项；都没有就 `cancelled`。
 * @param {any} params session/request_permission 的 params
 * @returns {{outcome: {outcome: "selected", optionId: string} | {outcome: "cancelled"}}} 应答 result
 */
function answerPermission(params) {
  const options = /** @type {any[]} */ (Array.isArray(params?.options) ? params.options : []);
  const byKind = (/** @type {string} */ k) => options.find((o) => o?.kind === k);
  const pick =
    byKind("allow_once") ??
    byKind("allow_always") ??
    options.find((o) => String(o?.kind ?? "").startsWith("allow")) ??
    options.find((o) => String(o?.optionId ?? "").startsWith("allow"));
  return pick
    ? { outcome: { outcome: "selected", optionId: String(pick.optionId) } }
    : { outcome: { outcome: "cancelled" } };
}

/**
 * 建 ACP 会话（工厂）。除「后端可换」外，行为与单后端时代逐字一致（日志/超时/JSON-RPC 错误回复都不变）。
 * @param {object} opts
 * @param {import("./engines.mjs").EngineDescriptor} opts.engine 后端描述符（server/engines.mjs）
 * @param {string} opts.cmd 引擎可执行文件（描述符 spawn 三件套之一；Windows 的 .cmd 会被描述符换成整条命令行，见 engines.mjs 的 windowsSafeSpawn）
 * @param {string[]} opts.args 引擎参数
 * @param {boolean} [opts.shell] 是否经平台 shell 起（Windows 的 .cmd/.bat 必须；由描述符给出）
 * @param {Record<string, string>} [opts.env] 额外注入子进程的 env（**我们的值优先**——展开顺序是
 *   `{...process.env, ...env}`，同名键由这里覆盖；各引擎的 env 由描述符的 spawn() 给出）
 * @param {string} opts.gameRoot 引擎 cwd（grok 的 `<gameRoot>/.grok` 插件目录与 codex 的 skill 源都在这里）
 * @param {string} opts.sessionFile 断线续档文件（config.SESSION_FILE；记 `{engine, sessionId}`）
 * @param {string} opts.rules 注入 agent 的规则原文（grok 进 `_meta`、codex 进 config.toml 的 developer_instructions）
 * @param {string} opts.effort 初始推理档位（entry.EFFORT；下发形状由描述符决定）
 * @param {(text: string) => void} opts.onChunk agent_message_chunk 的文本（入口做标记扫描 + broadcast）
 * @param {(label: string) => void} opts.onSeg tool_call/tool_call_update 的进度标题（入口 seg+=1 + broadcast）
 * @param {Array<object>} [opts.mcpServers] 挂到会话上的 MCP server 列表（ACP McpServerStdio 形态；
 *   配了图片自备 key 时才给，见 server/media-mcp.mjs 的 mediaMcpServers——两引擎都支持该字段）
 * @returns {{proc: import("child_process").ChildProcess, request: (method: string, params?: object|null, timeoutMs?: number) => Promise<any>,
 *   boot: () => Promise<void>, resolveImage: (name: string) => string|null, sessionId: string|null}} sessionId 是 getter——
 *   sendPrompt 与 /img 路由经它读当前会话；request 的 Promise resolve 整个响应 msg（result/error 都在）
 */
export function createAcpSession({ engine, cmd, args, env = {}, shell = false, gameRoot, sessionFile, rules, effort, onChunk, onSeg, mcpServers = [] }) {
  // 引擎 skill 注入（ADR 0021 的 grok 面）：grok CLI 把项目级 skill 按「文件夹信任」门控，`--plugin-dir
  // <gameRoot>/.grok` 是 session 级、always-trusted 的注入通道（参数在描述符里）。前提：该目录里只有
  // commands/ 与 skills/（无 hooks/MCP），而 plugin-dir 会 always-trust 其 hooks/MCP。
  // codex 面：规则进 config.toml 的 developer_instructions、skill 由描述符的 prepare() 落进 CODEX_HOME。
  const proc = spawn(cmd, args, { cwd: gameRoot, env: { ...process.env, ...env }, shell });
  // spawn 失败（缺二进制、无执行权限）时 Node 在子进程对象上发 'error'：**没有监听器就是未捕获异常**，
  // 而 Electron 主进程没有 uncaughtException 兜底（冒泡即闪退）——v1.11 真链路实测过：PATH 里没有
  // codex-acp 时整个 server 直接退出。这里吞下来并记一笔，request() 据此立刻失败，boot 落回既有的
  // 「boot failed」分支（HTTP 照样起，启动屏/提示词各自给人话）。
  /** @type {Error|null} */
  let spawnError = null;
  proc.on("error", (e) => {
    spawnError = e;
    console.error(`[acp] ${engine.id} spawn failed: ${e.message}`);
  });
  // 进程没起来时往 stdin 写会以 EPIPE 报错——同样要接住（否则又是一次未捕获异常）
  proc.stdin.on("error", () => {});
  proc.stderr.on("data", (d) => process.stderr.write(`[${engine.id}] ` + d.toString().slice(0, 300)));
  proc.on("exit", (code) => console.error(`[acp] ${engine.id} agent exited: ${code}`));
  const rl = readline.createInterface({ input: proc.stdout });

  let nextId = 1;
  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  /** @type {string|null} */
  let sessionId = null;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
      return;
    }
    if (!msg.method) return;
    if (msg.id !== undefined) {
      // Agent→Client 请求：权限请求按 ACP 规格应答（v1.11 新增，见 answerPermission；grok 用
      // --always-approve 从不发它，codex 侧是兜底，实证见 docs/adr/0022），其余保持既有口径——回 -32601。
      const result = msg.method === "session/request_permission" ? answerPermission(msg.params) : null;
      const reply = result
        ? { jsonrpc: "2.0", id: msg.id, result }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported by game shell" } };
      proc.stdin.write(JSON.stringify(reply) + "\n");
      return;
    }
    if (msg.method !== "session/update") return;
    const u = msg.params.update;
    if (u.sessionUpdate === "agent_message_chunk") {
      onChunk(u.content?.text ?? "");
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      onSeg(String(u.title || u.toolCall?.title || "工作"));
    }
  });

  /**
   * @param {string} method JSON-RPC 方法名
   * @param {object|null} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} resolve 整个响应 msg（result/error 都在里面，由调用方分辨）
   */
  function request(method, params, timeoutMs = 120000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (spawnError) {
        reject(new Error(`引擎进程没起来（${spawnError.message}）`));
        return;
      }
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // 引擎自产图的会话根（grok：`~/.grok/sessions/<encode(gameRoot)>`；codex：null = 没有这条通道，
  // 出图主路径是 media-mcp，见 docs/adr/0022）。null 时 resolveImage 一律 404。
  /** @type {string|null} */
  const imagesRoot = engine.sessionImagesRoot({ home: os.homedir(), gameRoot });

  function sessionImagesDir() {
    // 唯一调用点 resolveImage 入口有 `!imagesRoot || !sessionId → return null` 守卫（boot 完成前的
    // 【图】补落盘路径曾违反旧不变式直接 TypeError），走到这里时两者必非空——cast 依赖该守卫。
    return path.join(/** @type {string} */ (imagesRoot), /** @type {string} */ (sessionId), "images");
  }

  // 会话图索引（v1.7 读路径索引化）：imageName → 该名字最新的一份（跨会话续档时 /img 反复来查，
  // 原先每次未命中都 readdirSync 扫全部历史会话目录逐个 statSync）。挂在会话实例闭包而非模块级：
  // gameRoot/sessionId 都是本工厂的入参与状态，换一个会话实例索引自然隔离，不会串根。
  /** @type {Map<string, {absPath: string, mtimeMs: number}>} */
  const imageIndex = new Map();
  let imageIndexScannedAt = 0; // 上次全量重建的时间戳（TTL 节流用）
  const IMAGE_INDEX_TTL_MS = 5000;

  // 全量重建索引：扫会话根下所有会话目录的 images/，同名取 mtime 最新
  function rebuildImageIndex() {
    imageIndex.clear();
    if (imagesRoot) {
      try {
        for (const d of fs.readdirSync(imagesRoot, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const imagesDir = path.join(imagesRoot, d.name, "images");
          let names = [];
          try {
            names = fs.readdirSync(imagesDir);
          } catch {
            continue;
          }
          for (const name of names) {
            const f = path.join(imagesDir, name);
            try {
              const st = fs.statSync(f);
              const prev = imageIndex.get(name);
              if (!prev || st.mtimeMs > prev.mtimeMs) imageIndex.set(name, { absPath: f, mtimeMs: st.mtimeMs });
            } catch {}
          }
        }
      } catch {}
    }
    imageIndexScannedAt = Date.now();
  }

  // 图片落在 per-session 目录：当前会话没有时，查会话图索引（miss 才全量重建）
  /** @param {string} name 图片文件名 @returns {string|null} 绝对路径；找不到时 null */
  function resolveImage(name) {
    // boot 前 / 无会话 / 该引擎没有图片通道：安全返回 null（此前 sessionId 为 null 时
    // path.join(..., null) 会抛 TypeError，flushArtLines 的【图】补落盘路径没有守卫，
    // 这个修复让 /img 走正常 404 而不是 500）
    if (!imagesRoot || !sessionId) return null;
    const cur = path.join(sessionImagesDir(), name);
    if (fs.existsSync(cur)) return cur;
    const hit = imageIndex.get(name);
    if (hit) {
      try {
        fs.statSync(hit.absPath); // 命中但文件还在才算数
        return hit.absPath;
      } catch {
        imageIndex.delete(name); // 已被删：剔除后走下面的重扫找次新
      }
    } else if (Date.now() - imageIndexScannedAt < IMAGE_INDEX_TTL_MS) {
      // /img 未命中是低频路径：会话目录被外部清掉后不该每个请求都全量重扫一遍——
      // TTL 内的 miss 直接判 miss。选 TTL 而非目录 mtime 是因为多层父目录的 mtime 不可靠（下级变化不一定冒泡）。
      return null;
    }
    rebuildImageIndex();
    const again = imageIndex.get(name);
    return again ? again.absPath : null;
  }

  function saveSessionId() {
    try { fs.writeFileSync(sessionFile, JSON.stringify({ engine: engine.id, sessionId }) + "\n"); } catch {}
  }

  /**
   * 读断线续档（v1.11 起带引擎标记：换过引擎的存档 sessionId 互不通用，boot 会跳过 load 直接 new）。
   * @returns {{engine: string, sessionId: string} | null} 存档；没有/坏了回 null
   */
  function loadSavedSession() {
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      if (typeof data.sessionId !== "string" || !data.sessionId) return null;
      // v1.11 之前写的文件没有 engine 字段：按 grok 读（那时唯一的后端），行为与今天一致
      const engineId = typeof data.engine === "string" && data.engine ? data.engine : "grok";
      return { engine: engineId, sessionId: data.sessionId };
    } catch { return null; }
  }

  async function boot() {
    await new Promise((r) => setTimeout(r, 800));
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    // session/load 是能力位（第 0 步实证：grok 与 codex-acp 都支持）；不支持就不试，直接 session/new
    const loadSupported = init?.result?.agentCapabilities?.loadSession === true;

    // 会话级扩展（grok 的 `_meta:{yoloMode,rules}`）；描述符给 null 时整段不带（codex 的规则走 config.toml）
    const meta = engine.sessionMeta({ rules });
    const metaParam = meta ? { _meta: meta } : {};

    // 断线续档：优先 session/load 复用上次会话，失败降级 session/new 并覆写。换过引擎的存档直接跳过。
    // mcpServers 两条路径都传（第 0 步实证：session/load 与 session/new 一样会拉起 MCP 子进程）。
    const saved = loadSavedSession();
    let booted = false;
    if (loadSupported && saved && saved.engine === engine.id) {
      try {
        const r = await request("session/load", {
          sessionId: saved.sessionId, cwd: gameRoot, mcpServers, ...metaParam,
        }, 60000);
        if (r.error) throw new Error(r.error.message || "session/load rejected");
        sessionId = r.result?.sessionId || saved.sessionId;
        booted = true;
        console.log(`[acp] session/load 复用会话: ${sessionId}`);
      } catch (e) {
        console.log(`[acp] session/load 失败（${e.message}），降级 session/new`);
      }
    }
    if (!booted) {
      const s = await request("session/new", {
        cwd: gameRoot, mcpServers, ...metaParam,
      });
      if (s.error) throw new Error(s.error.message || "session/new rejected");
      sessionId = s.result.sessionId;
      console.log(`[acp] session/new 新会话: ${sessionId}`);
    }
    saveSessionId();
    console.log(`[acp] ${engine.id} session ready: ${sessionId}`);
    // 游戏回合不需要 high 档推理，降到 medium 提速（失败忽略；load/new 会话同样生效）。
    // 下发形状按后端：grok 收 `{configId, value:{value}}`，codex 收 `{configId, value}`（第 0 步实证）。
    const option = engine.effortOption(effort);
    if (option) {
      try {
        await request("session/set_config_option", { sessionId, ...option });
        console.log(`[acp] reasoning_effort -> ${effort}`);
      } catch { /* 不支持就保持默认 */ }
    }
  }

  return {
    proc,
    request,
    boot,
    resolveImage,
    get sessionId() { return sessionId; },
  };
}
