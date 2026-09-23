// 引擎凭据（v1.10，docs/adr/0019；v1.11 加顶层 engine 字段，docs/adr/0022）：GUI 里填的自备 key 与
// 引擎选择的落盘/读取/脱敏/转注入 env 的全部纯函数。
// 磁盘位置固定 `~/.bunkiten/credentials.json`（目录 0700 / 文件 0600）——**不放 GAME_ROOT**：
// 开发态 GAME_ROOT 等于仓库根，state/ 的 gitignore 规则不覆盖新文件，放那里迟早被 git 收走。
//
// 铁律（安全面，任何调用方都不许越过）：
//   · 明文只出现在磁盘这一处：不写日志、不进快照/回合日志/导出包、HTTP 响应一律走 publicView；
//   · 读路径永不抛：坏 JSON / 缺键 / 多余键 / 类型不对一律逐键回默认（凭据坏掉不该让 server 起不来）；
//   · 写路径原子：临时文件 + rename（进程被杀也不会留下半截 JSON），文件 0600、目录 0700。
//
// 与目录真源的关系：provider 的**形态**真源是 shared/providers.mjs 的 PROVIDER_ID_RE，本模块不抄第二份；
// 「写进去的 id 是不是当前目录里的服务」这件事由调用点把白名单（内置表 ∪ 当前目录）注入进来判（见
// validateCredentialsPatch 的第三参）——本模块**不 import providers-catalog.mjs**（后者已 import 本模块的
// CREDENTIALS_DIRNAME，反向会成环），所以读路径只按形态保留、写路径按注入的白名单严校验。
import fs from "fs";
import os from "os";
import path from "path";
import { PROVIDER_IDS, PROVIDER_ID_RE } from "../shared/providers.mjs";
import { DEFAULT_ENGINE_ID, ENGINE_IDS } from "../shared/engines.mjs";

/** 凭据文件的当前结构版本（结构变更才升；读路径对未知版本仍然逐键容错） */
export const CREDENTIALS_VERSION = 1;

/** 凭据目录名（放在用户主目录下：`~/.bunkiten/`） */
export const CREDENTIALS_DIRNAME = ".bunkiten";

/** 凭据文件名 */
export const CREDENTIALS_FILENAME = "credentials.json";

/** LLM 组的两种模式：沿用 grok 登录态 / 自备 key */
export const LLM_MODES = Object.freeze(["session", "byok"]);

/** 图片组的两种模式：不出图 / 自备 key */
export const IMAGE_MODES = Object.freeze(["off", "byok"]);

// 字段长度上限（校验与容错共用；超长一律截断而不是整份拒绝——凭据文件是玩家可手改的）
const MAX_URL = 500;
const MAX_KEY = 1000;
const MAX_MODEL = 200;
const MAX_SIZE = 40;

/**
 * 一组凭据（LLM 或图片）。
 * @typedef {Object} CredentialGroup
 * @property {string} mode LLM: session|byok；image: off|byok（非法值由 normalize 回该组默认）
 * @property {string} provider 服务目录 id（形态见 shared/providers.mjs 的 PROVIDER_ID_RE；读路径形态非法才回落默认）
 * @property {string} baseUrl 服务地址（空串=未填）
 * @property {string} apiKey 明文 key（**只在磁盘与内存里**；任何响应/日志都不许落它）
 * @property {string} model 模型 id
 * @property {string} [size] 仅图片组：出图尺寸（空串=按类型自动；对有尺寸语义的服务是**通用覆盖**，背景优先看 sizeBackground）
 * @property {string} [sizeBackground] 仅图片组：背景专用尺寸（空串=回落 size，再回落按类型默认的横构图）
 */

/**
 * 凭据文档（磁盘形状，version 1）。
 * @typedef {Object} Credentials
 * @property {number} version 结构版本
 * @property {string} engine 叙事引擎后端 id（shared/engines.mjs 的 ENGINE_IDS 之一；缺省/未知值回落默认）
 * @property {CredentialGroup} llm LLM 组
 * @property {CredentialGroup} image 图片组
 */

/** @returns {Credentials} 出厂默认（引擎 grok、LLM 沿用登录态、图片不出图——与 v1.10 的行为完全一致） */
export function defaultCredentials() {
  return {
    version: CREDENTIALS_VERSION,
    engine: DEFAULT_ENGINE_ID,
    llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
    image: { mode: "off", provider: "openai", baseUrl: "", apiKey: "", model: "", size: "", sizeBackground: "" },
  };
}

/** @param {unknown} v @returns {string} 字符串化并去掉首尾空白（非字符串给空串） */
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 单字段容错：长度截断（凭据文件是玩家可手改的，超长只截断不整份拒绝）。
 * @param {unknown} v 原值
 * @param {number} max 上限
 * @returns {string}
 */
function field(v, max) {
  return str(v).slice(0, max);
}

/**
 * 任意输入 → 合法凭据（逐键容错，永不抛）。坏键回默认、好键保留——单键写坏不整份丢弃。
 * @param {unknown} raw 候选（通常是 JSON.parse 的结果）
 * @returns {Credentials} 可直接使用的凭据
 */
export function normalizeCredentials(raw) {
  const out = defaultCredentials();
  if (!raw || typeof raw !== "object") return out;
  const doc = /** @type {Record<string, any>} */ (raw);
  // 引擎（v1.11，docs/adr/0022）：只认真源里的 id，其余回落默认——v1.10 及以前的凭据文件没有这个键，
  // 读出来就是 grok，行为与升级前完全一致。
  const engineId = field(doc.engine, 20);
  out.engine = ENGINE_IDS.includes(engineId) ? engineId : DEFAULT_ENGINE_ID;
  /** @type {Array<{key: "llm"|"image", modes: readonly string[], defMode: string, hasSize: boolean}>} */
  const groups = [
    { key: "llm", modes: LLM_MODES, defMode: "session", hasSize: false },
    { key: "image", modes: IMAGE_MODES, defMode: "off", hasSize: true },
  ];
  for (const g of groups) {
    const src = doc[g.key];
    if (!src || typeof src !== "object") continue;
    const target = /** @type {Record<string, string>} */ (out[g.key]);
    const mode = field(src.mode, 20);
    target.mode = g.modes.includes(mode) ? mode : g.defMode;
    const provider = field(src.provider, 40);
    // 读路径放宽：**只要 id 形态合法就原样保留**，不拿内置 PROVIDER_IDS 当白名单。
    // 理由（docs/adr/0020）：服务目录可被远端更新注入新 id，读路径（启动/GET）不能依赖目录是否可达——
    // 若在目录暂时抓不到（回落内置表）时按内置表收口，玩家已存的远程 id 会被静默改写成默认值（目录抖一下配置就丢）。
    // 取舍：手改凭据文件塞一个「形态合法但目录里没有」的 id 也会被保留；但那是写路径（validateCredentialsPatch）
    // 该拦的事，而读路径的铁律是「永不抛、永不整份丢弃」（见文件头），provider 也只是个下拉选键，不是安全边界。
    target.provider = PROVIDER_ID_RE.test(provider) ? provider : out[g.key].provider;
    target.baseUrl = field(src.baseUrl, MAX_URL);
    target.apiKey = field(src.apiKey, MAX_KEY);
    target.model = field(src.model, MAX_MODEL);
    if (g.hasSize) {
      target.size = field(src.size, MAX_SIZE);
      target.sizeBackground = field(src.sizeBackground, MAX_SIZE);
    }
  }
  return out;
}

/**
 * 凭据文件的绝对路径。
 * @param {string} [root] 用户主目录（缺省 os.homedir()；单测/harness 传临时 HOME）
 * @returns {string} `~/.bunkiten/credentials.json`
 */
export function credentialsPath(root = os.homedir()) {
  return path.join(root, CREDENTIALS_DIRNAME, CREDENTIALS_FILENAME);
}

/**
 * 读凭据：文件不存在 / 坏 JSON / 结构不对一律回默认（**永不抛**——启动路径不能因凭据挂掉）。
 * @param {string} [root] 用户主目录（缺省 os.homedir()）
 * @returns {Credentials} 合法凭据
 */
export function readCredentials(root = os.homedir()) {
  try {
    const file = credentialsPath(root);
    if (!fs.existsSync(file)) return defaultCredentials();
    return normalizeCredentials(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return defaultCredentials();
  }
}

/**
 * 写凭据：目录 0700、文件 0600，临时文件 + rename 原子落盘。
 * 返回写下去的那份（已 normalize）——调用方拿它回脱敏视图，避免「响应与磁盘不一致」。
 * @param {string} root 用户主目录
 * @param {unknown} next 待写入的凭据（先 normalize）
 * @returns {Credentials} 实际落盘的凭据
 */
export function writeCredentials(root, next) {
  const creds = normalizeCredentials(next);
  const file = credentialsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600); // rename 保留 tmp 的权限，这里显式再钉一次（旧文件可能带别的 mode）
  return creds;
}

/**
 * 局部更新：patch 里出现的键才动（空串=清该字段），clear 里的组整组回默认。
 * 纯函数（不碰磁盘）——路由读取→merge→write→回脱敏视图，四步各自可测。
 * @param {Credentials} current 当前凭据
 * @param {{engine?: string, llm?: Record<string, unknown>, image?: Record<string, unknown>}} [patch] 顶层标量（引擎）与分组的局部字段
 * @param {string[]} [clear] 要整组清空的组名（"llm" | "image"）
 * @returns {Credentials} 合并后的凭据（已 normalize）
 */
export function mergeCredentials(current, patch = {}, clear = []) {
  const base = normalizeCredentials(current);
  /** @type {Record<string, any>} */
  const next = { version: CREDENTIALS_VERSION, engine: base.engine, llm: { ...base.llm }, image: { ...base.image } };
  for (const key of clear) {
    if (key === "llm" || key === "image") next[key] = defaultCredentials()[key];
  }
  const patchOf = /** @type {Record<string, any>} */ (patch);
  // 顶层标量：引擎（v1.11）。出现才动；非法值由写路径的校验先挡，这里只负责合并。
  if (typeof patchOf.engine === "string") next.engine = patchOf.engine;
  for (const key of ["llm", "image"]) {
    const src = patchOf[key];
    if (!src || typeof src !== "object") continue;
    const allowed = key === "image" ? ["mode", "provider", "baseUrl", "apiKey", "model", "size", "sizeBackground"] : ["mode", "provider", "baseUrl", "apiKey", "model"];
    for (const f of allowed) {
      if (f in src) next[key][f] = src[f];
    }
  }
  return normalizeCredentials(next);
}

/**
 * 校验一次局部更新（路由在写盘前调用；纯函数，单测直测）。
 * 规则：只认已知字段与合法模式；provider 必须在 `allowedProviderIds` 里；地址非空时必须是 http(s) URL；
 * 出图尺寸非空时是 `<宽>x<高>` 或 auto；长度上限与 normalize 一致（这里**拒绝**而不是截断——手填的错值该让玩家看见）。
 *
 * 为什么 provider 白名单要注入（而不是本模块自己拉目录）：服务目录可被远端更新注入**新 id**，不认它的话
 * 「不换版本用上新服务」在保存这一步就被 400 挡住（/api/providers 已把它下发给下拉了）——这是动态目录的核心收益。
 * 而本模块**不能 import providers-catalog.mjs**（后者已 import 本模块的 CREDENTIALS_DIRNAME，反向会成环），
 * 所以白名单（内置表 ∪ 当前目录）从调用点注入：入口 acp-server.mjs 的 updateCredentials 闭包持有目录 memo。
 * 默认值仍是内置 PROVIDER_IDS：直测/无目录上下文时写路径照旧只认内置表（**严**校验，形状合法但不在集合里也拒）。
 * @param {{engine?: string, llm?: Record<string, unknown>, image?: Record<string, unknown>}} patch 待写入的局部字段
 * @param {string[]} [clear] 要整组清空的组名
 * @param {Iterable<string>} [allowedProviderIds] 允许写入的 provider id 集合（Set 或数组；缺省内置 PROVIDER_IDS）
 * @returns {{ok: true} | {ok: false, error: string}} 校验结果
 */
export function validateCredentialsPatch(patch = {}, clear = [], allowedProviderIds = PROVIDER_IDS) {
  const allowedIds = allowedProviderIds instanceof Set ? allowedProviderIds : new Set(allowedProviderIds);
  for (const key of clear) {
    if (key !== "llm" && key !== "image") return { ok: false, error: `未知的清除目标：${key}` };
  }
  const patchOf = /** @type {Record<string, any>} */ (patch);
  // 顶层标量：引擎（v1.11，docs/adr/0022）——只认 shared/engines.mjs 真源里的 id
  if (patchOf.engine !== undefined) {
    if (typeof patchOf.engine !== "string") return { ok: false, error: "engine 必须是字符串" };
    if (!ENGINE_IDS.includes(str(patchOf.engine))) return { ok: false, error: `engine 只能是 ${ENGINE_IDS.join(" / ")}` };
  }
  const specs = [
    { key: "llm", modes: LLM_MODES, fields: ["mode", "provider", "baseUrl", "apiKey", "model"] },
    { key: "image", modes: IMAGE_MODES, fields: ["mode", "provider", "baseUrl", "apiKey", "model", "size", "sizeBackground"] },
  ];
  for (const spec of specs) {
    const src = patchOf[spec.key];
    if (src === undefined) continue;
    if (!src || typeof src !== "object") return { ok: false, error: `${spec.key} 必须是对象` };
    for (const f of Object.keys(src)) {
      if (!spec.fields.includes(f)) return { ok: false, error: `未知字段：${spec.key}.${f}` };
      const v = /** @type {any} */ (src)[f];
      if (typeof v !== "string") return { ok: false, error: `${spec.key}.${f} 必须是字符串` };
    }
    if ("mode" in src && !spec.modes.includes(str(src.mode))) {
      return { ok: false, error: `${spec.key}.mode 只能是 ${spec.modes.join(" / ")}` };
    }
    if ("provider" in src && !allowedIds.has(str(src.provider))) {
      return { ok: false, error: `${spec.key}.provider 不在服务目录里` };
    }
    if ("baseUrl" in src) {
      const u = str(src.baseUrl);
      if (u.length > MAX_URL) return { ok: false, error: `${spec.key}.baseUrl 过长` };
      if (u && !/^https?:\/\/[^\s]+$/.test(u)) return { ok: false, error: `${spec.key}.baseUrl 需要是 http(s) 地址` };
    }
    if ("apiKey" in src && str(src.apiKey).length > MAX_KEY) return { ok: false, error: `${spec.key}.apiKey 过长` };
    if ("model" in src && str(src.model).length > MAX_MODEL) return { ok: false, error: `${spec.key}.model 过长` };
    // 尺寸两格（通用 + 背景专用）同一套校验与上限
    for (const sizeField of spec.key === "image" ? ["size", "sizeBackground"] : []) {
      if (!(sizeField in src)) continue;
      const s = str(/** @type {any} */ (src)[sizeField]);
      if (s && !/^(auto|\d{1,5}x\d{1,5})$/.test(s)) return { ok: false, error: "出图尺寸形如 1024x1536，或留空按类型自动" };
      if (s.length > MAX_SIZE) return { ok: false, error: "出图尺寸过长" };
    }
  }
  return { ok: true };
}

/**
 * key 的掩码显示（屏上唯一允许出现的形态）：`sk-…4f2a`。
 * 长度 ≤ 8 的 key 不给任何前缀/后缀（短 key 露出头尾等于露大半），整串打点。
 * @param {string} s 明文 key（空串给空串）
 * @returns {string} 掩码
 */
export function maskKey(s) {
  const k = str(s);
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/**
 * 某组是否已配好 key（GUI 的「已配置/未配置」与 /api/auth 的 hasCredentials 都看它）。
 * @param {Credentials} creds 凭据
 * @param {"llm" | "image"} group 组名
 * @returns {boolean} 该组 mode 已开且 apiKey 非空
 */
export function hasKey(creds, group) {
  const g = group === "llm" ? creds.llm : creds.image;
  return g.apiKey.trim() !== "";
}

/**
 * LLM 侧是否「配全了自备 key」（能不开 grok 登录就开玩；boot 屏的第三个态与 /api/auth 看它）。
 * 判据：mode=byok 且地址与密钥都非空。模型名可以留空（CLI 会用自己的默认模型名），
 * 但那种情况下能不能对上服务端是玩家自己的事——这里只回答「够不够开工」。
 * @param {Credentials} creds 凭据
 * @returns {boolean}
 */
export function llmReady(creds) {
  return creds.llm.mode === "byok" && creds.llm.baseUrl.trim() !== "" && creds.llm.apiKey.trim() !== "";
}

/**
 * 脱敏视图（HTTP 出口的唯一形状）：**永不含明文**。
 * hasKey 让 GUI 画「已配置」；apiKeyMasked 让 key 格在失焦后显示 `sk-…4f2a`；engine 让设置屏画引擎选择器。
 * @param {Credentials} creds 凭据
 * @returns {{version: number, engine: string, llm: object, image: object}} 脱敏视图
 */
export function publicView(creds) {
  const group = (/** @type {CredentialGroup} */ g, /** @type {boolean} */ withSize) => ({
    mode: g.mode,
    provider: g.provider,
    baseUrl: g.baseUrl,
    model: g.model,
    ...(withSize ? { size: g.size || "", sizeBackground: g.sizeBackground || "" } : {}),
    hasKey: g.apiKey.trim() !== "",
    apiKeyMasked: maskKey(g.apiKey),
  });
  return {
    version: CREDENTIALS_VERSION,
    engine: creds.engine,
    llm: group(creds.llm, false),
    image: group(creds.image, true),
  };
}

/**
 * 凭据 → 注入引擎子进程的 env（只生成非空项；**我们的值优先**，与 process.env 合并时覆盖同名键）。
 * LLM 走 grok CLI 的 BYOK 通道（docs：GROK_MODELS_BASE_URL + XAI_API_KEY + GROK_DEFAULT_MODEL，
 * 第 0 步实证见 docs/ARCHITECTURE.md「引擎凭据与自备 key」）：地址进 GROK_MODELS_BASE_URL、
 * key 进 XAI_API_KEY、模型进 GROK_DEFAULT_MODEL。
 * 另加一个 GROK_CONFIG 覆盖（内联 JSON，只设 `models.session_summary`）：CLI 起会话时会用**它自己的**
 * 默认模型名去打一次 `{base}/responses` 生成会话标题，对第三方端点必然 404（只留一条 stderr 杂音）；
 * 把 session_summary 指到玩家配的模型，那条请求就变成一次正常的 chat 调用（实测：/responses 消失）。
 * 图片凭据**不进 env**——那是 media MCP server 自己读凭据文件的事（少一条把 key 摊在进程环境里的路径）。
 * @param {Credentials} creds 凭据
 * @returns {Record<string, string>} 要注入的 env 键值（未配置时是空对象）
 */
export function credentialsToEnv(creds) {
  const out = /** @type {Record<string, string>} */ ({});
  const llm = creds.llm;
  if (llm.mode !== "byok") return out;
  if (llm.baseUrl) out.GROK_MODELS_BASE_URL = llm.baseUrl;
  if (llm.apiKey) out.XAI_API_KEY = llm.apiKey;
  if (llm.model) {
    out.GROK_DEFAULT_MODEL = llm.model;
    out.GROK_CONFIG = JSON.stringify({ models: { session_summary: llm.model } });
  }
  return out;
}

/**
 * 错误信息脱敏：把可能夹带 key 的文本（HTTP 错误体、异常 message）压成可上屏的一句。
 * 先按明文 key 逐个替换成掩码（长短都能命中），再压空白、截断 200 字。
 * @param {unknown} message 原始错误信息
 * @param {string[]} [secrets] 需要抹掉的明文（通常是各组 apiKey）
 * @returns {string} 可安全回给客户端/日志的短句
 */
export function sanitizeErrorMessage(message, secrets = []) {
  let text = String(message ?? "").replace(/\s+/g, " ").trim();
  for (const s of secrets) {
    const k = str(s);
    if (k.length >= 6) text = text.split(k).join(maskKey(k));
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 所有组的明文 key 列表（脱敏与 /test 的 secrets 参数用；顺序稳定）
 * @param {Credentials} creds 凭据
 * @returns {string[]} 各组非空的明文 key
 */
export function secretsOf(creds) {
  return [creds.llm.apiKey, creds.image.apiKey].filter((s) => s.trim() !== "");
}
