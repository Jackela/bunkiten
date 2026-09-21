// galgame ACP server —— 入口与装配（v1.7 拆模块，零依赖 Node）：
// spawn grok agent stdio (ACP)、SSE 推流、资产落盘流水线、逐轮快照、进程生命周期都在这里的 startServer 闭包装配。
// 用法：node server/acp-server.mjs  →  http://localhost:7800 ；或 import { startServer }
//
// 模块地图（同目录 server/）：
//   config.mjs 路径/端口（GAME_ROOT/SESSION_FILE/WORLDS_ROOT 等公共依赖，零依赖叶子）
//   protocol-lines.mjs 注入 agent 的 RULES 原文 + 五种协议行 parse* + 质量守卫追问指令 SUPPLEMENT_PROMPT
//   assets.mjs 美术资产路径契约纯函数（sanitize/白名单/落盘判定/差分拆分）
//   presets.mjs preset.md 解析 + assetTargetFile + 剧本导出包（buildPresetBundle/importPresetBundle）
//   snapshots.mjs 世界三文件与逐轮快照的地基（WORLD_FILES/WORLD_ID_RE/读写/选择/fork 纯函数）
//   worlds.mjs 世界线索引/CRUD/导出导入/migrateLegacyState/migrateWorldsSchema/角色面板解析
//   audio.mjs presets/<id>/audio/ 扫描（AUDIO_KINDS/AUDIO_EXTS/AUDIO_FILE_RE re-export 给 doctor）
//   http-util.mjs 本地端点防护（跨站 403/body 413）+ /app 静态托管的 MIME 与目录解析
//   acp.mjs ACP 子进程封装（spawn/JSON-RPC request/sessionId 存取/boot/会话图片定位）
//   routes.mjs HTTP 路由链（createRequestHandler(ctx)，闭包能力由本文件注入）
// 本文件继续逐名 re-export 拆出的全部符号——外部 import 面（electron/main.js、tests/、scripts/doctor.mjs）
// 逐字不变。pickEffort 与 isMainTurn 留在这里：契约 lint（tests/contract.test.ts ⑥）从本文件源码
// 抓它们的函数体（必须引用 shared 真源的 DIRECTIVE_PREFIX_RE）；FONT_PRESETS/DIALOG_TEXTURES/DEFAULT_THEME
// 同理钉在本文件（契约 lint ⑥ 与 src/theme.ts 比对字面量），presets.mjs 反向 import（仅函数内引用，环形安全）。
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
// 协议常量唯一真源（v1.7，docs/adr/0012）：指令前缀正则与章标记正则在 shared/protocol.mjs，
// 前者 pickEffort 与 isMainTurn 共用同一份值、后者 parseChapterMark（客户端）与质量守卫豁免（本文件）
// 共用同一份值；本文件不再自持副本（契约 lint ⑤⑥组断言这一点）。
import { CHAPTER_MARK_RE, DIRECTIVE_PREFIX_RE } from "../shared/protocol.mjs";
import { PROVIDER_IDS } from "../shared/providers.mjs";
import { GAME_ROOT, BASE_PORT, PORT_MAX_RETRY, SESSION_FILE, WORLDS_ROOT } from "./config.mjs";
import {
  PRESET_ID_RE,
  ASSET_FILE_RE,
  sanitizeAssetName,
  splitAssetVariant,
  mtimeOf,
  presetAssetsDir,
  presetIdFromPath,
  resolvePersistPreset,
} from "./assets.mjs";
import { scanPresets, assetTargetFile } from "./presets.mjs";
import { RULES, SUPPLEMENT_PROMPT, parseArtLine, parseExpressionLine, parsePresetAddedLine, parseTreeLine, parseAudioLine } from "./protocol-lines.mjs";
import { WORLD_ID_RE, parseTreePointer, readWorldFiles, writeSnapshot, writeTurnLog } from "./snapshots.mjs";
import { readWorldsIndex, presetFromStateFile, worldChapterNo, migrateLegacyState, migrateWorldsSchema } from "./worlds.mjs";
import { createAcpSession } from "./acp.mjs";
import { readCredentials, writeCredentials, mergeCredentials, validateCredentialsPatch, publicView, credentialsToEnv, secretsOf, sanitizeErrorMessage } from "./credentials.mjs";
import { testLlm, testImage } from "./credentials-probe.mjs";
import { loadCatalog, refreshCatalog } from "./providers-catalog.mjs";
import { mediaMcpServers } from "./media-mcp.mjs";
import { createRequestHandler } from "./routes.mjs";

// ---------- 外部 import 面保活：拆出模块的既有导出符号逐名 re-export（electron/tests/doctor 从这里 import） ----------
export { PRESET_ID_RE, ASSET_FILE_RE, ASSET_KINDS, presetAssetsDir, assetRelPath, presetIdFromPath, legacyAssetCandidates, resolvePersistPreset } from "./assets.mjs";
export { AUDIO_KINDS, AUDIO_EXTS, AUDIO_FILE_RE, scanPresetAudio } from "./audio.mjs";
export {
  FM_KEYS,
  THEME_KEYS,
  parseFrontmatter,
  normalizeTheme,
  parseCharacterSections,
  parseCharacters,
  parseSectionLines,
  scanPresets,
  assetTargetFile,
  buildPresetBundle,
  importPresetBundle,
} from "./presets.mjs";
export { RULES_SENTENCES, RULES, SUPPLEMENT_PROMPT, parseArtLine, parseExpressionLine, parsePresetAddedLine, parseTreeLine, parseAudioLine } from "./protocol-lines.mjs";
export {
  WORLD_FILES,
  parseTreePointer,
  readWorldFiles,
  writeWorldFiles,
  normalizeSnapshot,
  isSnapshotEntry,
  readSnapshots,
  readSnapshot,
  writeSnapshot,
  writeTurnLog,
  LOGS_DIRNAME,
  selectSnapshotForNode,
  forkTreeMarkdown,
  forkNote,
  __snapshotCacheStats, // 测试探针（仅 tests/server.test.ts 断言缓存命中用，不是对外 API）
} from "./snapshots.mjs";
export {
  moveToTrash,
  readWorldsIndex,
  writeWorldsIndex,
  presetFromStateFile,
  worldChapterNo,
  parseStateFile,
  stateViewFor,
  createWorld,
  forkWorld,
  restoreWorld,
  updateWorld,
  exportWorld,
  importWorld,
  deleteWorld,
  listWorlds,
  migrateLegacyState,
  migrateWorldsSchema,
} from "./worlds.mjs";
export { isCrossSiteRequest, readBodyText } from "./http-util.mjs";
// 引擎凭据（v1.10）：纯函数面经入口 re-export（tests 与 doctor 侧统一从入口 import，与其余拆出符号同款）
export {
  CREDENTIALS_VERSION,
  CREDENTIALS_DIRNAME,
  CREDENTIALS_FILENAME,
  LLM_MODES,
  IMAGE_MODES,
  defaultCredentials,
  normalizeCredentials,
  credentialsPath,
  readCredentials,
  writeCredentials,
  mergeCredentials,
  validateCredentialsPatch,
  maskKey,
  hasKey,
  llmReady,
  publicView,
  credentialsToEnv,
  sanitizeErrorMessage,
  secretsOf,
} from "./credentials.mjs";
export { testLlm, testImage, PROBE_TIMEOUT_MS, PROBE_IMAGE_SIZE } from "./credentials-probe.mjs";
// 服务目录更新通道（v1.10，docs/adr/0020）：纯函数面经入口 re-export（与其余拆出符号同款；
// 单测也可直接从 server/providers-catalog.mjs import）
export {
  CATALOG_FILENAME,
  CATALOG_VERSION,
  CATALOG_TTL_MS,
  CATALOG_TIMEOUT_MS,
  CATALOG_URLS,
  validateCatalogDocument,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
  loadCatalog,
  refreshCatalog,
  __resetCatalogMemo, // 测试探针（仅 tests/providers-catalog.test.ts 清进程内 memo 用，不是对外 API）
} from "./providers-catalog.mjs";
export { MEDIA_MCP_NAME, MEDIA_TOOL_NAME, TOOL_DEFINITION, DEFAULT_SIZES, GENERATE_TIMEOUT_MS, imageSizeFor, imagesEndpoint, resolveOutputPath, pickImagePayload, requestImage, generateImage, mediaMcpPath, mediaMcpServers, handleMcpMessage } from "./media-mcp.mjs";
// 剧本体检（v1.8）的纯函数视图：路由链住在 routes.mjs，这里只把测试面（tests/server.test.ts 直测 tmp 根）
// 一起 re-export——与本文件其余拆出符号同款（外部 import 面永远是入口）。
export { presetCheckResult, presetCheckView } from "./routes.mjs";

export const EFFORT = process.env.EFFORT || "medium"; // 正戏回合档位：低推理换节奏，可设 high
// 建档/规划类回合（出清单、改树、装配）不需要高推理：单独一档更省、更快（v1.6 分档）
export const EFFORT_PLANNING = process.env.EFFORT_PLANNING || "low";

// ---------- 主题白名单与兜底（钉在入口源码：契约 lint ⑥ 从这里抓字面量与 src/theme.ts 比对） ----------
// 字体族/对话框质感白名单（v1.7）：与 src/theme.ts 的 FONT_PRESETS/DIALOG_TEXTURES 同集。
// 导出给 server/presets.mjs 的 normalizeTheme（逐键兜底的真值），不抄第二份。
export const FONT_PRESETS = ["serif", "song", "kai", "hei"];
export const DIALOG_TEXTURES = ["plain", "silk", "paper", "glass"];
// theme 兜底：块缺失或格式坏时整套默认（aurora 为兜底母题）
export const DEFAULT_THEME = Object.freeze({ accent: "#c9a86a", accent2: "#e8e4da", motif: "aurora", font: "serif", dialog: "plain" });

/**
 * 提示词里的世界段嗅探（纯函数）：开局指令中段的 `世界：<worldId>。` 与续玩指令的 `继续世界：<worldId>。`。
 * @param {string} text 发给引擎的提示词原文
 * @returns {string|null} 世界 id
 */
export function parseWorldRef(text) {
  const m = /世界[：:]\s*([A-Za-z0-9_-]+)\s*[。.]/.exec(String(text || ""));
  return m ? m[1] : null;
}

/**
 * 提示词是不是客户端指令（纯函数）：**只有指令才允许改变「当前剧本」**。
 * 玩家自由输入（比如自己打一句「世界：rift-mark。」）不得改变落盘目录，否则美术会归错剧本。
 * @param {string} text 发给引擎的提示词原文
 * @returns {boolean} 以 `开局：` 或 `继续世界：` 开头（客户端两条开局/续玩指令的固定前缀）
 */
export function isDirectivePrompt(text) {
  return /^\s*(开局：|继续世界：)/.test(String(text || ""));
}

/**
 * 回合档位选择（纯函数）：建档/规划类回合走 planning 档，其余（正戏/自由输入）走正戏档。
 * 前缀集合来自 `shared/protocol.mjs` 的 `DIRECTIVE_PREFIX_RE`（v1.7 与 isMainTurn 统一成一份真源，
 * 此前两处各持一份手写正则、仅交替顺序不同）；「创作模式：」等前缀与 `isDirectivePrompt` 无关，只影响推理档位。
 * 档位值可注入（缺省模块常量）以便单测不依赖环境变量。
 * @param {string} text 发给引擎的提示词原文
 * @param {string} [main] 正戏档位（缺省 EFFORT）
 * @param {string} [planning] 规划档位（缺省 EFFORT_PLANNING）
 * @returns {string} 本次回合应使用的 reasoning_effort
 */
export function pickEffort(text, main = EFFORT, planning = EFFORT_PLANNING) {
  return DIRECTIVE_PREFIX_RE.test(String(text || "")) ? planning : main;
}

// ---------- server ----------
/**
 * startServer 的句柄（listenWithRetry 的 resolve 值）。
 * @typedef {Object} ServerHandle
 * @property {number} port 实际监听端口（EADDRINUSE 重试后可能与 BASE_PORT 不同）
 * @property {import("http").Server} server
 * @property {import("child_process").ChildProcess} proc grok 子进程
 */
/** @type {Promise<ServerHandle>|null} */
let instance = null;
/** @type {(() => Promise<void>)|null} */
let stopServerFn = null;

// 优雅退出：停 HTTP server（先断 SSE）+ kill grok 子进程；幂等，供 Electron will-quit 与信号处理复用
export function stopServer() {
  return stopServerFn ? stopServerFn() : Promise.resolve();
}

export function startServer() {
  if (instance) return instance;

  let seg = 0;
  let busy = false;

  // assets registry：<剧本 id>|type|sanitizedName -> AssetEntry；磁盘真况见 listAssets()
  /**
   * @typedef {Object} AssetEntry
   * @property {string} type 立绘 | 背景 | 封面
   * @property {string} name sanitize 后的名字（差分形如 `薇拉-微笑`）
   * @property {string} rawName 标记里的原始名
   * @property {string} presetId 落盘剧本 id（拿不到剧本的占位条目为空串）
   * @property {string} file 落盘目标相对路径（占位条目为空串）
   * @property {string} srcRel 标记里的原始路径
   * @property {boolean} ready 目标文件是否已就绪
   * @property {boolean} [regen] 第四段「重绘」：覆盖同名文件
   */
  /** @type {Map<string, AssetEntry>} */
  const assetRegistry = new Map();
  let currentPresetId = ""; // 当前剧本 id（sendPrompt 嗅探世界段得出；/img 的旧档直服与嗅探比对用它）
  /** @type {string|null} */ let currentWorldId = null; // 当前世界 id（sniffPreset 一并保存；逐轮快照按它落盘 history/NNNN.json）
  let lastEffort = EFFORT; // 上次已生效的推理档位（boot 已设 EFFORT；档位变化才再发 set_config_option）
  let turnText = ""; // 当前回合 chunk 文本累积，用于流式解析【图】标记行
  let artScanPos = 0;

  /** @type {Set<import("http").ServerResponse>} */
  const clients = new Set();
  /** @param {object} obj 广播事件（JSON.stringify 后走 SSE） */
  function broadcast(obj) {
    const s = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) res.write(s);
  }

  // ACP 会话（spawn/JSON-RPC/sessionId/boot 都封装在 acp.mjs）：流式 chunk 与进度 label 回调进本闭包，
  // 这里才有 assetRegistry 与 SSE clients——标记扫描与 broadcast 因此留在入口（ingestChunkText/handleArtLine）。
  //
  // 凭据在**每次 spawn 时**现读（v1.10，docs/adr/0019）：`credentialsToEnv` 的键覆盖继承来的同名 env
  //（我们的值优先），`mediaMcpServers` 只在图片侧配了自备 key 时才挂 MCP 子进程。重启（restartAcp）
  // 就是拿同一份逻辑再建一次会话——所以「保存 key → 立刻重启引擎」不需要再碰任何别的状态。
  /** @returns {ReturnType<typeof createAcpSession>} */
  function buildAcp() {
    const creds = readCredentials();
    return createAcpSession({
      gameRoot: GAME_ROOT,
      sessionFile: SESSION_FILE,
      rules: RULES,
      effort: EFFORT,
      env: credentialsToEnv(creds),
      mcpServers: mediaMcpServers(creds),
      onChunk: (text) => {
        ingestChunkText(text);
        broadcast({ type: "chunk", seg, text });
      },
      onSeg: (label) => {
        seg += 1;
        broadcast({ type: "seg", seg, label });
      },
    });
  }
  let acp = buildAcp();

  // ---------- 引擎凭据的闭包面（v1.10，docs/adr/0019）：路由链只做转手，判定都在 credentials*.mjs ----------

  /**
   * 优雅重启引擎会话（POST /api/engine/restart 的落地）：杀旧 grok 子进程 → 按**当前**凭据重建会话 → 重新握手。
   * env 只在 spawn 时读一次，所以「保存 key 立刻生效」必须走这里。回合进行中拒绝——杀进程等于把这一回合
   * 的推演连同落盘一起截断（客户端会停在「待重同步」态），宁可让玩家等这一回合结束。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function restartAcp() {
    if (busy) return { ok: false, error: "正在演绎中，等这一回合结束再重启" };
    const old = acp;
    try { old.proc.kill(); } catch {}
    // 等旧进程退出再拉新的：两个 grok 进程同时持同一会话目录会互相踩 session 文件
    await new Promise((resolve) => {
      if (old.proc.exitCode !== null || old.proc.signalCode !== null) return resolve(undefined);
      const t = setTimeout(() => { try { old.proc.kill("SIGKILL"); } catch {} resolve(undefined); }, 1500);
      old.proc.once("exit", () => { clearTimeout(t); resolve(undefined); });
    });
    acp = buildAcp();
    lastEffort = EFFORT; // 新会话的 boot() 会把档位设成 EFFORT，记账跟着复位（否则同档位不再下发）
    try {
      await acp.boot();
    } catch (e) {
      console.error("[acp] restart failed:", e.message);
      return { ok: false, error: `重启后引擎握手失败：${e.message}` };
    }
    console.log(`[acp] engine restarted: ${acp.sessionId}`);
    return { ok: true };
  }

  /** @returns {object} 脱敏视图（永不回明文 key） */
  function credentialsView() {
    return publicView(readCredentials());
  }

  /**
   * 局部更新凭据：校验 → 合并 → 原子落盘 → 回脱敏视图。
   * @param {{llm?: Record<string, unknown>, image?: Record<string, unknown>}} patch 待写入的分组字段（未出现的键不动；空串=清该字段）
   * @param {string[]} clear 要整组清空的组名
   * @returns {{ok: boolean, error?: string, view?: object}}
   */
  function updateCredentials(patch, clear) {
    const check = validateCredentialsPatch(patch, clear, allowedProviderIds());
    if (!check.ok) return { ok: false, error: check.error };
    try {
      const next = mergeCredentials(readCredentials(), patch, clear);
      writeCredentials(os.homedir(), next);
      console.log(`[acp] credentials updated: llm=${next.llm.mode} image=${next.image.mode}`); // 只记模式，不记 key
      return { ok: true, view: publicView(next) };
    } catch (e) {
      return { ok: false, error: `写入凭据失败：${e.message}` };
    }
  }

  /**
   * 测一次连接（读当前凭据；错误信息再过一遍 secretsOf 脱敏——探针自己也会脱敏，这里是第二道保险）。
   * @param {string} target "llm" | "image"
   * @returns {Promise<{ok: boolean, status: number, ms: number, error?: string, detail?: string}>}
   */
  async function testCredentials(target) {
    const creds = readCredentials();
    const secrets = secretsOf(creds);
    const out = target === "llm" ? await testLlm(creds.llm) : await testImage(creds.image);
    return out.error ? { ...out, error: sanitizeErrorMessage(out.error, secrets) } : out;
  }

  // ---------- 服务目录的闭包面（v1.10，docs/adr/0020）：路由链只转手，判定都在 providers-catalog.mjs ----------

  /**
   * 服务目录候选（GET /api/providers 的响应主体）。只读视图：GUI 拿它画下拉，
   * **绝不据此改写玩家已存的 baseUrl / key**（见 server/providers-catalog.mjs 的铁律）。
   * @returns {{providers: object[], source: string, fetchedAt: string|null}} source = remote/cache/bundled
   */
  function providersView() {
    return loadCatalog({ root: os.homedir() });
  }

  /**
   * POST /api/credentials 允许写入的 provider id 集合：**内置表 ∪ 当前目录**（remote/cache/bundled 都算）。
   * 为什么写路径要合并目录 id：目录可被远端更新注入新 id，`providersView` 已经把它下发给下拉了，
   * 不合并的话「不换版本用上新服务」在保存这一步就被 400「不在服务目录里」挡住——正是那条通道的核心收益不可达。
   * 为什么读路径不这么做（读路径也不能这么做）：读路径不能依赖目录可达（一次抓不到就回落内置表），
   * 否则玩家已存的远程 id 会被静默改写；所以读路径按「id 形态合法即保留」放宽（见 credentials.mjs 的 normalizeCredentials），
   * 写路径仍严校验。方向：credentials.mjs 不 import 本模块的目录（providers-catalog.mjs 已 import credentials.mjs
   * 的 CREDENTIALS_DIRNAME，反向会成环），故白名单从**调用点注入**，而不是让 credentials.mjs 自己拉目录。
   * @returns {Set<string>} 允许写入的 provider id
   */
  function allowedProviderIds() {
    const ids = new Set(PROVIDER_IDS);
    for (const p of loadCatalog({ root: os.homedir() }).providers) ids.add(p.id);
    return ids;
  }

  // ---------- 资产持久化：按「剧本 + 类型 + 名字」落盘（封面 presets/<id>/cover.jpg；重绘标志覆盖同名文件） ----------
  // 「拿不到剧本」告警去重（同一 key 只警告一次）：回合末补扫、每条 /img 预载都会反复走到同一资产，
  // 不去重会把控制台刷爆，真正的告警反而看不见。
  const warnedPresetless = new Set();
  /** @param {string} type @param {string} name sanitize 后的名字 @param {string} rawName 标记里的原始名 */
  function warnPresetlessOnce(type, name, rawName) {
    const key = `${type}|${name}`;
    if (warnedPresetless.has(key)) return;
    warnedPresetless.add(key);
    console.warn(`[acp] 拿不到当前剧本，暂不落盘（等【新剧本】或带 &preset= 的请求补落）: ${type}|${rawName}`);
  }
  // 旧档路径提示去重（预载/轮播会反复命中同一条老路径）
  const warnedLegacyPaths = new Set();
  /** @param {string} rel 旧档相对路径 */
  function warnLegacyPathOnce(rel) {
    if (warnedLegacyPaths.has(rel)) return;
    warnedLegacyPaths.add(rel);
    console.warn(`[acp] 请求了旧档资产路径（v1.5 之前的全局 assets/ 格式），只按当前剧本目录直服: ${rel}`);
  }

  /**
   * 落盘一个资产（流式【图】标记与回合末补扫共用）。
   * 目标随剧本走：presets/<剧本 id>/assets/<类型>-<名>.jpg（封面 presets/<id>/cover.jpg）。
   * 剧本 id 只认「调用方显式传入」或「标记路径自带 presets/<id>/…」（resolvePersistPreset），
   * **不再回退 currentPresetId**（B1）：创作模式装配新剧本时 currentPresetId 还是上一局的剧本，
   * 一退回就会把新剧本的立绘写进旧剧本的 assets 目录。
   * 拿不到剧本时不落盘，registry 留 ready:false 占位（同一 key 只告警一次），
   * 等【新剧本】<id> 标记（handleArtLine 用它重试整批占位项）或带 &preset= 的 /img 请求补落。
   * @param {string} type 立绘 | 背景 | 封面
   * @param {string} rawName 标记里的原始名（角色名/地点名/剧本标题）
   * @param {string} srcRel 标记里的原始路径（images/N.jpg 或 presets/<id>/assets/…）
   * @param {boolean} [regen] 第四段「重绘」：覆盖同名文件
   * @param {string} [presetId] 调用方解析出的剧本 id（【新剧本】补落盘会显式给出新剧本 id）
   * @returns {boolean} 目标文件是否已就绪
   */
  function persistAsset(type, rawName, srcRel, regen = false, presetId = "") {
    const name = sanitizeAssetName(rawName);
    const { presetId: pid } = resolvePersistPreset({ queryPreset: presetId, srcRel });
    const file = assetTargetFile(type, rawName, pid || "");
    if (!file) {
      const key = `${pid || ""}|${type}|${name}`;
      const entry = assetRegistry.get(key) || { type, name, rawName, presetId: pid || "", file: "", srcRel, ready: false };
      entry.rawName = rawName;
      entry.srcRel = srcRel;
      entry.regen = regen;
      entry.ready = false;
      assetRegistry.set(key, entry);
      warnPresetlessOnce(type, name, rawName);
      return false;
    }
    const finalPid = presetIdFromPath(file) || pid || ""; // 封面按标题反查到的剧本也算数
    const key = `${finalPid}|${type}|${name}`;
    const abs = path.join(GAME_ROOT, file);
    const entry = assetRegistry.get(key) || { type, name, rawName, presetId: finalPid, file, srcRel, ready: false };
    entry.presetId = finalPid;
    entry.rawName = rawName;
    entry.srcRel = srcRel;
    entry.file = file;
    entry.regen = regen;
    if (regen || !fs.existsSync(abs)) {
      // 标记出现时图片文件应已生成（引擎先 image_gen 再输出标记）；当前会话没有就跨会话扫描
      const src = acp.resolveImage(path.basename(srcRel));
      if (!src) {
        entry.ready = false;
        assetRegistry.set(key, entry);
        return false;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(src, abs);
    }
    entry.ready = true;
    assetRegistry.set(key, entry);
    // 清掉此前「拿不到剧本」留下的同名占位项（那些 key 里的剧本 id 是空串）
    for (const [k, e] of assetRegistry) {
      if (k !== key && !e.ready && e.type === type && e.name === name) assetRegistry.delete(k);
    }
    console.log(`[acp] asset persisted: ${file}`);
    return true;
  }

  /** @param {string} line 已到达完整行的协议行候选 */
  function handleArtLine(line) {
    const art = parseArtLine(line);
    if (art) { persistAsset(art.type, art.name, art.srcRel, art.regen); return; }
    const expr = parseExpressionLine(line);
    if (expr) { broadcast({ type: "expression", character: expr.character, variant: expr.variant }); return; }
    // 【树】= 剧情编辑回合的静默刷新信号（客户端收到即重取 /api/tree）：此前漏接线，只在单测里被直接调用过
    if (parseTreeLine(line)) { broadcast({ type: "treeEdited" }); return; }
    const added = parsePresetAddedLine(line);
    if (added) {
      const newId = String(added.id || "").trim();
      if (PRESET_ID_RE.test(newId)) {
        // 【新剧本】<id> = 装配期的补落盘信号（B1）：装配时【图】标记先到（那时还没人知道新剧本 id，
        // 这批条目的 presetId 是空串），标记后到就把它们全部按新剧本 id 重试一次——这批就是新剧本的美术。
        currentPresetId = newId;
        const pending = [...assetRegistry.values()].filter((e) => !e.ready);
        for (const e of pending) persistAsset(e.type, e.rawName ?? e.name, e.srcRel, e.regen === true, newId);
      } else {
        console.warn(`[acp] 【新剧本】id 非法，已忽略（不改当前剧本）: ${added.id}`);
      }
      broadcast({ type: "presetAdded", id: added.id });
    }
    // 分支顺序末位的 audio（CONTRACTS §1）：演出指令，只转发事件，不落盘、不生成、不进 registry
    const audio = parseAudioLine(line);
    if (audio) broadcast({ type: "audio", kind: audio.kind, name: audio.name });
  }

  // 只解析已到达完整行（\n 结尾）的部分，避免流式 chunk 截断标记
  /** @param {string} text agent_message_chunk 的文本增量 */
  function ingestChunkText(text) {
    turnText += text;
    let nl;
    while ((nl = turnText.indexOf("\n", artScanPos)) !== -1) {
      handleArtLine(turnText.slice(artScanPos, nl));
      artScanPos = nl + 1;
    }
  }

  function flushArtLines() {
    if (artScanPos < turnText.length) handleArtLine(turnText.slice(artScanPos));
    artScanPos = turnText.length;
    // 图片文件可能晚于标记落盘，回合结束补一次。
    // 剧本 id 一律用条目上记的（`e.presetId` 为空=装配期还没拿到新剧本 id）——**不回退 currentPresetId**（B1）：
    // 那一退回就是"新剧本的美术写进上一局剧本"，正确出口是【新剧本】<id> 的补落盘或带 &preset= 的 /img。
    for (const [, e] of [...assetRegistry]) {
      if (!e.ready) persistAsset(e.type, e.rawName ?? e.name, e.srcRel, e.regen === true, e.presetId || "");
    }
  }

  /**
   * 某剧本的画廊数据：只扫该剧本的 assets/ 与封面（磁盘为准），registry 补尚未落盘的项。
   * variant 从文件名解析；inUse 只扫**该剧本的世界**（index.json 按 preset 过滤）的 state.md 是否含该名。
   * 资产随故事走，跨剧本不再串味——所以剧本 id 是必填参数。
   * @param {string} presetId 剧本 id（调用方已用 PRESET_ID_RE 校验）
   * @returns {Array<object>} 资产项列表
   */
  function listAssets(presetId) {
    /** @type {string[]} */
    const stateTexts = [];
    for (const e of readWorldsIndex(WORLDS_ROOT)) {
      if (e.preset !== presetId) continue;
      try { stateTexts.push(fs.readFileSync(path.join(WORLDS_ROOT, e.worldId, "state.md"), "utf8")); } catch {}
    }
    /** @param {string} name */
    const inUse = (name) => stateTexts.some((t) => t.includes(name));
    const out = new Map();
    /** @param {string} key @param {string} type @param {string} rest @param {string} file @param {boolean} ready */
    const push = (key, type, rest, file, ready) => {
      const { name, variant } = splitAssetVariant(rest);
      // preset 必填：客户端画廊按它做防御性过滤（跨剧本条目一律丢弃并告警）
      out.set(key, { type, name, variant, file, ready, preset: presetId, inUse: inUse(name), mtime: mtimeOf(path.join(GAME_ROOT, file)) });
    };
    try {
      for (const f of fs.readdirSync(presetAssetsDir(presetId))) {
        // 只认立绘/背景：封面不在 assets/ 里（契约是 presets/<id>/cover.jpg，另见下面那条），
        // `assets/封面-X.jpg` 是死路径，扫了只会给画廊塞进永远 404 的项。
        // 文件名正则取 shared 真源（ASSET_FILE_RE，由 ASSET_KINDS 构造）：落盘白名单与画廊扫描同一份
        const m = ASSET_FILE_RE.exec(f);
        // file 用**磁盘上的真实文件名**拼（v1.5 之前的素材可能是 .jpeg，硬拼 .jpg 会让画廊 404）
        if (m) push(`${m[1]}|${m[2]}`, m[1], m[2], `presets/${presetId}/assets/${f}`, true);
      }
    } catch {}
    try {
      // 封面随 preset 目录分发：presets/<id>/cover.jpg，name 用剧本标题
      const file = `presets/${presetId}/cover.jpg`;
      const preset = scanPresets().presets.find((p) => p.id === presetId);
      if (preset && fs.existsSync(path.join(GAME_ROOT, file))) push(`封面|${preset.title}`, "封面", preset.title, file, true);
    } catch {}
    for (const [, e] of assetRegistry) {
      if (e.presetId !== presetId) continue;
      const key = `${e.type}|${e.name}`; // 与磁盘扫描同键去重（registry 键含剧本 id）
      if (!out.has(key)) push(key, e.type, e.name, e.file, e.ready);
    }
    return [...out.values()];
  }

  /**
   * /img 从会话命中时顺手落盘（src 是绝对路径）。
   * 剧本 id 与 persistAsset 用同一套判定（resolvePersistPreset）：显式传入 → 来源路径解析 → 都不行就不落盘。
   * **不回退 currentPresetId**（B1）：调用方（/img 与【新剧本】补落盘）自己决定该用哪个剧本，判定只有一处。
   * @param {string} type 立绘 | 背景 | 封面
   * @param {string} rawName 标记里的原始名
   * @param {string} src 会话图片的绝对路径
   * @param {string} [presetId] 调用方解析出的剧本 id（不给即视为拿不到剧本）
   * @param {string} [srcRel] 原始来源路径（images/N.jpg 或 presets/<id>/assets/…，用于路径兜底解析）
   * @returns {boolean} 是否新落盘（目标已存在或拿不到剧本时为 false）
   */
  function persistAssetFromFile(type, rawName, src, presetId = "", srcRel = "") {
    const name = sanitizeAssetName(rawName);
    const { presetId: pid } = resolvePersistPreset({ queryPreset: presetId, srcRel });
    const file = assetTargetFile(type, rawName, pid || "");
    if (!file) {
      warnPresetlessOnce(type, name, rawName);
      return false;
    }
    const abs = path.join(GAME_ROOT, file);
    if (fs.existsSync(abs)) return false;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(src, abs);
    const finalPid = presetIdFromPath(file) || pid || "";
    assetRegistry.set(`${finalPid}|${type}|${name}`, {
      type, name, rawName, presetId: finalPid, file, srcRel, ready: true,
    });
    console.log(`[acp] asset persisted: ${file}`);
    return true;
  }

  /**
   * 提示词里的世界段 → 当前剧本：开局指令的 `世界：<worldId>。` / 续玩指令的 `继续世界：<worldId>。`
   * 是流式落盘唯一可靠的剧本来源（/img 的 &preset= 与标记路径是另外两条兜底）。
   * 两道闸：
   * 1. 只嗅探**以客户端指令开头**的提示词（isDirectivePrompt）——玩家自由输入里写一句
   *    「世界：rift-mark。」不该把后续美术的落盘目录改掉；
   * 2. 世界 → 剧本先查 `state/worlds/index.json`，查不到或记录里的 preset 不合法时
   *    回退读该世界 `state.md` 的 `- preset: <id>`（与 SKILL 的「当前剧本 id」口径一致，可自愈索引缺失）；
   *    仍然拿不到就保持原值不动（宁可沿用上一局，也不乱归档）并告警。
   * @param {string} text 发给引擎的提示词原文
   */
  function sniffPreset(text) {
    if (!isDirectivePrompt(text)) return;
    const worldId = parseWorldRef(text);
    if (!worldId) return;
    // 世界 id 与剧本 id **一并**在这里落定：指令没给世界段（非指令/无段）时保持上次值，
    // 逐轮快照的落盘目录随之确定（否则快照会写进错误的世界）。
    currentWorldId = worldId;
    const entry = readWorldsIndex(WORLDS_ROOT).find((e) => e.worldId === worldId);
    // 真分支意味着上面的 `entry?.preset || ""` 非空（entry 必已存在），`?.` 在此处与 `.` 等价——checkJs 逼出的等价收窄
    let preset = PRESET_ID_RE.test(entry?.preset || "") ? entry?.preset : "";
    if (!preset) {
      preset = presetFromStateFile(worldId);
      if (preset) console.warn(`[acp] 世界 ${worldId} 未在 index.json 里记到合法 preset，改用其 state.md 的 preset: ${preset}`);
    }
    if (!PRESET_ID_RE.test(preset) || preset === currentPresetId) {
      if (!PRESET_ID_RE.test(preset)) {
        console.warn(`[acp] 世界 ${worldId} 查不到合法 preset（索引与 state.md 都没有），保持当前剧本: ${currentPresetId || "（无）"}`);
      }
      return;
    }
    currentPresetId = preset;
    console.log(`[acp] current preset: ${currentPresetId} (world ${worldId})`);
  }

  // 档位分档（CONTRACTS §4）：正戏/自由输入走 EFFORT，规划/建档类走 EFFORT_PLANNING；
  // 与上次已生效的档位不同才发 set_config_option，失败静默（不支持就保持现状，下次变化再试）。
  /** @param {string} effort 要生效的推理档位（显式值——质量守卫的追问直接给低档，不走 pickEffort） */
  async function applyEffortValue(effort) {
    if (effort === lastEffort) return;
    try {
      await acp.request("session/set_config_option", {
        sessionId: acp.sessionId, configId: "reasoning_effort", value: { value: effort },
      });
      lastEffort = effort;
      console.log(`[acp] reasoning_effort -> ${effort}`);
    } catch { /* 引擎不支持档位：静默，不阻断回合 */ }
  }
  /** @param {string} text 发给引擎的提示词原文 */
  function applyEffort(text) {
    return applyEffortValue(pickEffort(text));
  }

  // 正戏回合判定（纯逻辑，CONTRACTS §2）：规划/美术/剧情/装配/创作模式回合（前缀正则与 pickEffort 同一份
  // 真源 shared/protocol.mjs 的 DIRECTIVE_PREFIX_RE，v1.7 统一两份手写副本）、以及带「待命：」的开局指令
  // 都不推进剧情正文，不该产生逐轮快照（「待命：」是后缀判定，不属前缀集合，保持原地）。
  /** @param {string} text 发给引擎的提示词原文 @returns {boolean} 是否正戏回合 */
  function isMainTurn(text) {
    const s = String(text || "").trim();
    if (DIRECTIVE_PREFIX_RE.test(s)) return false;
    if (s.includes("待命：")) return false;
    return true;
  }

  // 逐轮快照（CONTRACTS §2）：正戏回合结束后把当前世界三文件全文存一份 history/NNNN.json。
  // 调用点固定在 flushArtLines() 之后、busy=false 之前——此刻本轮所有落盘都已定型，内容不会再多变。
  /** @param {string} text 发给引擎的提示词原文 */
  function writeTurnSnapshot(text) {
    if (!isMainTurn(text)) return;
    const worldId = currentWorldId;
    if (!worldId || !WORLD_ID_RE.test(worldId)) return; // 还没定下世界（未开局）→ 无从落快照
    const files = readWorldFiles(path.join(WORLDS_ROOT, worldId));
    const res = writeSnapshot(WORLDS_ROOT, worldId, {
      kind: "turn",
      nodeId: parseTreePointer(files.tree),
      chapterNo: files.tree != null ? worldChapterNo(files.tree) : null,
      files,
    });
    if (res.ok) console.log(`[acp] snapshot written: ${worldId}/history/${String(res.seq).padStart(4, "0")}.json`);
    // 回合原文日志（v1.7）：与快照同一判定、同一时机，但是独立的 logs/NNNN.json 条目。
    // 快照去重（duplicate）时日志照写——日志记的是叙事原文，与三文件去重是两回事；seq 对齐取舍见 writeTurnLog。
    // text 用 turnText 全文：若本回合触发过质量守卫追问，追问补发的回合尾已在其中（追问不另立条目）。
    const log = writeTurnLog(WORLDS_ROOT, worldId, { seq: res.seq, prompt: text, text: turnText });
    if (log.ok) console.log(`[acp] turn log written: ${worldId}/logs/${String(log.seq).padStart(4, "0")}.json`);
  }

  // 质量守卫（v1.7，每轮协议要求每回合带 **行动** 选项段）：正戏回合缺 `**行动**` 时，在同一 busy
  // 窗口内自动补发一次内部追问（SUPPLEMENT_PROMPT，只要求补发回合尾）。追问属于同一回合：
  // chunks 流进同一 turnText（客户端看到的是同一回合的补全，省一次 turn_end）、不另写快照与
  // log 条目（log 的 text 自然含补全后的全文）。只此一次——这里是单次 if、无重试循环，
  // 追问失败（引擎 error/超时）或补全后仍缺 `**行动**` 都放弃：log 里留痕，玩家仍可自由输入。
  // 客户端语义不变：SSE chunk 照常流，无需任何 client 改动。
  /** @param {string} text 发给引擎的提示词原文 */
  async function supplementMissingOptions(text) {
    if (!isMainTurn(text) || !currentWorldId) return;
    if (turnText.includes("**行动**")) return;
    // 章末回合豁免：输出【章】第 N 章 完 的回合是每轮协议「以选项结束」的唯一合法例外
    //（SKILL「章节与剧情树」明文该轮不再出选项；RULES 第 3 句的协议行枚举也声明了这条章标记），
    // 缺 **行动** 不是引擎忘写——正则真源 CHAPTER_MARK_RE（shared/protocol.mjs），不追问。
    if (CHAPTER_MARK_RE.test(turnText)) return;
    console.log("[acp] 回合缺 **行动** 选项段，自动追问一次");
    try {
      // 追问只要回合尾，走低档（SUPPLEMENT_PROMPT 不在 DIRECTIVE_PREFIX_RE 前缀集，pickEffort 会给正戏档，
      // 所以直接指定）；档位已由 lastEffort 记账，下个正戏回合的 applyEffort 会自动拉回。
      await applyEffortValue(EFFORT_PLANNING);
      // 追问只要回合尾，120s 足够（主回合 600s 是整轮叙事+美术的预算，追问不该占满）；
      // 超时与引擎 error 同路：catch 里 warn 后放弃，不转 409、不影响回合成功收尾
      const s = await acp.request("session/prompt", {
        sessionId: acp.sessionId, prompt: [{ type: "text", text: SUPPLEMENT_PROMPT }],
      }, 120_000);
      if (s && s.error) throw new Error(`引擎补充回合失败：${s.error.message ?? JSON.stringify(s.error)}`);
    } catch (e) {
      console.warn(`[acp] 追问失败，放弃（回合日志里留痕）: ${e.message}`);
    }
  }

  /**
   * 发一个游戏回合给引擎（POST /prompt 的落地）。
   * @param {string} text 提示词原文
   * @returns {Promise<{ok: boolean, error?: string}>} error 在回合失败（busy/引擎未就绪/引擎回 error/超时）时给出
   */
  async function sendPrompt(text) {
    if (busy || !acp.sessionId) return { ok: false, error: busy ? "上一回合还在进行" : "引擎未就绪" };
    sniffPreset(text);
    busy = true;
    seg = 0;
    turnText = "";
    artScanPos = 0;
    broadcast({ type: "turn_start" });
    try {
      await applyEffort(text); // 档位变化才 set_config_option（在 session/prompt 之前）
      const r = await acp.request("session/prompt", {
        sessionId: acp.sessionId, prompt: [{ type: "text", text }],
      }, 600000);
      // acp.request 会 resolve 整个响应 msg：引擎按 JSON-RPC 回 error response（而不是断流/超时）时
      // 以前被当成功回合处理（照写快照、广播 turn_end、HTTP 200）——这里显式抛错，落进下方 catch
      //（error 事件 + busy 复位 + 不写快照 + POST /prompt 409），与超时/进程崩掉同一错误路径。
      if (r && r.error) {
        throw new Error(`引擎回合失败：${r.error.message ?? JSON.stringify(r.error)}`);
      }
      flushArtLines();
      // 质量守卫：flushArtLines 之后、writeTurnSnapshot 之前——追问补的回合尾也要进本轮快照与日志的定稿
      await supplementMissingOptions(text);
      flushArtLines(); // 追问回合的输出里可能还有协议行（【立绘】/音频三行），补扫一次
      writeTurnSnapshot(text); // 逐轮快照 + 回合日志：flushArtLines 之后、busy=false 之前
      // 先复位再广播：客户端收到 turn_end 会立即发下一条（制作流水线自动推进），
      // 若广播后才复位会撞 409 窗口（v1.4 实测抓到的竞态）
      busy = false;
      broadcast({ type: "turn_end" });
      return { ok: true };
    } catch (e) {
      flushArtLines();
      busy = false;
      broadcast({ type: "error", message: e.message });
      return { ok: false, error: e.message };
    }
  }

  // 旧版扁平 state/*.md 一次性迁入 state/worlds/main/（幂等；已是多世界布局或无旧数据时不动）
  if (migrateLegacyState(path.join(GAME_ROOT, "state"), WORLDS_ROOT)) {
    console.log("[acp] legacy state/*.md → state/worlds/main/ 已迁移");
  }
  // 索引 schema 升级（ROADMAP §1 / ADR-0018）必须紧跟其后：上一步可能刚用新写形态（{schema:1, worlds}）
  // 建出索引，那时本步是 no-op；更老的裸数组索引（v1.8 及以前）在这里一次性升上来。
  // 两种输入都在 listen 之前跑完——HTTP 一开门，索引已是当前形态（没有「读到一半的世界」的窗口）。
  if (migrateWorldsSchema(WORLDS_ROOT)) {
    console.log("[acp] state/worlds/index.json 已升级：裸数组 → {schema: 1, worlds}");
  }

  // 服务目录更新（v1.10，docs/adr/0020）：非阻塞抓一次发布源（先主后备）→ 校验 → 落 `~/.bunkiten/providers.json`。
  // `void` 掉：启动不被网络拖住，失败静默（refreshCatalog 永不抛），抓不到就继续用缓存/内置兜底。
  // 两个开关：`BUNKITEN_DISABLE_UPDATE=1` 直接跳过（打包冒烟用，与 electron-updater 同款）；`BUNKITEN_PROVIDERS_URL` 覆盖源（测试/镜像）。
  void refreshCatalog({ root: os.homedir() });

  // ---------- HTTP ----------
  const server = http.createServer(createRequestHandler({
    clients,
    sendPrompt,
    listAssets,
    persistAssetFromFile,
    resolveImage: (name) => acp.resolveImage(name),
    warnLegacyPathOnce,
    credentialsView,
    updateCredentials,
    testCredentials,
    restartEngine: restartAcp,
    providersView,
    get currentPresetId() { return currentPresetId; },
    get sessionId() { return acp.sessionId; },
  }));

  /** @param {number} attempt 端口重试序号（0 = BASE_PORT 本尊） @returns {Promise<ServerHandle>} */
  function listenWithRetry(attempt) {
    return new Promise((resolve, reject) => {
      const port = BASE_PORT + attempt;
      /** @param {Error & {code?: string}} e EADDRINUSE 等系统错误带 code */
      const onError = (e) => {
        if (e.code === "EADDRINUSE" && attempt < PORT_MAX_RETRY) {
          server.removeListener("error", onError);
          resolve(listenWithRetry(attempt + 1));
        } else {
          reject(e);
        }
      };
      server.once("error", onError);
      server.listen(port, () => {
        server.removeListener("error", onError);
        // 端口以**实际监听结果**为准：双栈/被占重试时，早先 attempt 的回调可能迟到触发，
        // 用闭包 port 会打印出假的「第一行」（真实 socket 可能在下一个端口），
        // 进而骗过按首行解析端口的测试编排（tests/helpers/stack.mjs）。
        // TCP 监听的 address() 恒为 AddressInfo（string 分支是 IPC/pipe 才有的）——cast 表达这个分支不变式
        const actualPort = /** @type {import("net").AddressInfo|null} */ (server.address())?.port ?? port;
        console.log(`[acp] http://localhost:${actualPort}  (game root: ${GAME_ROOT})`);
        resolve({ port: actualPort, server, proc: acp.proc });
      });
    });
  }

  instance = listenWithRetry(0).then(async (handle) => {
    try { await acp.boot(); } catch (e) { console.error("[acp] boot failed:", e.message); }
    return handle;
  });

  let stopped = false;
  stopServerFn = async () => {
    if (stopped) return;
    stopped = true;
    let handle = null;
    try { handle = await instance; } catch { /* 启动失败也要清理子进程 */ }
    for (const res of clients) res.destroy(); // SSE 长连接会拖住 server.close 回调
    clients.clear();
    if (handle) await /** @type {Promise<void>} */ (new Promise((resolve) => handle.server.close(() => resolve())));
    // 杀**当前**的引擎进程：重启过就可能是新拉起的那个（旧 handle.proc 只是启动时的快照）
    try { acp.proc.kill(); } catch {}
    setTimeout(() => { try { acp.proc.kill("SIGKILL"); } catch {} }, 1500).unref(); // SIGTERM 不退则强杀
  };

  /** @param {string} sig 信号名（SIGINT/SIGTERM） */
  const signalExit = (sig) => {
    console.log(`[acp] ${sig} received, shutting down`);
    // signalExit 只在 startServer 已赋值 stopServerFn 之后才可能被进程信号触发——cast 表达这个顺序不变式
    /** @type {() => Promise<void>} */ (stopServerFn)().catch(() => {}).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => signalExit("SIGINT"));
  process.on("SIGTERM", () => signalExit("SIGTERM"));
  return instance;
}

// 直接运行：node server/acp-server.mjs
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) startServer();
