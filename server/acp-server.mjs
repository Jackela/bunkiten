// galgame ACP server —— 入口与装配（v1.7 拆模块，零依赖 Node）：
// spawn grok agent stdio (ACP)、SSE 推流、资产落盘流水线、逐轮快照、进程生命周期都在这里的 startServer 闭包装配。
// 用法：node server/acp-server.mjs  →  http://localhost:7800 ；或 import { startServer }
//
// 模块地图（同目录 server/，v1.13 补全——这份地图此前停在 v1.7 的 10 个模块，
// 而 AGENTS.md 又让读者来这里找地图，结果是「文档指着地图、地图缺一半」）：
//   config.mjs 路径/端口（GAME_ROOT/SESSION_FILE/WORLDS_ROOT/gameHome 等公共依赖，零依赖叶子）
//   errors.mjs 未知错误的读取口（errText/errName：catch 变量在 strict 下是 unknown）
//   protocol-lines.mjs 注入 agent 的 RULES 原文 + 五种协议行 parse* + 质量守卫追问指令 SUPPLEMENT_PROMPT
//   assets.mjs 美术资产路径契约纯函数（sanitize/白名单/落盘判定/差分拆分）
//   presets.mjs preset.md 解析 + assetTargetFile + 剧本导出包（buildPresetBundle/importPresetBundle）
//   snapshots.mjs 世界三文件与逐轮快照的地基（WORLD_FILES/WORLD_ID_RE/读写/选择/fork 纯函数）
//   worlds.mjs 世界线索引/CRUD/导出导入/migrateLegacyState/migrateWorldsSchema/角色面板解析
//   audio.mjs presets/<id>/audio/ 扫描（AUDIO_KINDS/AUDIO_EXTS/AUDIO_FILE_RE re-export 给 doctor）
//   http-util.mjs 本地端点防护（跨站 403/body 413）+ /app 静态托管的 MIME 与目录解析
//   acp.mjs ACP 子进程封装（spawn/JSON-RPC request/sessionId 存取/boot/会话图片定位）
//   engines.mjs 引擎描述符表（spawn 三件套/规则注入/档位形状/登录探测/CODEX_HOME 准备，v1.11）
//   engine-auth.mjs 登录/登出编排（GUI 按钮 → 玩家自己 CLI 的单例在途登录 + 收尾，v1.11）
//   credentials.mjs 引擎凭据（~/.bunkiten/credentials.json 的 normalize/读写/校验/env/脱敏，v1.10）
//   credentials-probe.mjs 「测试连接」探活（LLM 先 /models 再退化最小 completion；图片走最小生成，v1.10）
//   providers-catalog.mjs 服务目录在线更新（抓取/校验/缓存/三级回落/单飞刷新，v1.10，ADR-0020）
//   media-mcp.mjs 自建出图 MCP server（bunkiten-media__generate_image，零依赖 stdio，v1.10）
//   routes.mjs HTTP 路由链（createRequestHandler(ctx)，闭包能力由本文件注入）
// 本文件继续逐名 re-export 拆出的全部符号——外部 import 面（electron/main.js、tests/、scripts/doctor.mjs）
// 逐字不变。pickEffort 与 isMainTurn 留在这里：契约 lint（tests/contract.test.ts ⑥）从本文件源码
// 抓它们的函数体（必须引用 shared 真源的 DIRECTIVE_PREFIX_RE）；FONT_PRESETS/DIALOG_TEXTURES/DEFAULT_THEME
// 同理钉在本文件（契约 lint ⑥ 与 src/theme.ts 比对字面量），presets.mjs 反向 import（仅函数内引用，环形安全）。
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// 协议常量唯一真源（v1.7，docs/adr/0012）：指令前缀正则与章标记正则在 shared/protocol.mjs，
// 前者 pickEffort 与 isMainTurn 共用同一份值、后者 parseChapterMark（客户端）与质量守卫豁免（本文件）
// 共用同一份值；本文件不再自持副本（契约 lint ⑤⑥组断言这一点）。
import { CHAPTER_MARK_RE, DIRECTIVE_PREFIX_RE } from "../shared/protocol.mjs";
import { PROVIDER_IDS } from "../shared/providers.mjs";
import { GAME_ROOT, BASE_PORT, PORT_MAX_RETRY, SESSION_FILE, WORLDS_ROOT, gameHome } from "./config.mjs";
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
import {
  RULES,
  SUPPLEMENT_PROMPT,
  parseArtLine,
  parseExpressionLine,
  parsePresetAddedLine,
  parseTreeLine,
  parseAudioLine,
} from "./protocol-lines.mjs";
import { WORLD_ID_RE, parseTreePointer, readWorldFiles, writeSnapshot, writeTurnLog } from "./snapshots.mjs";
import {
  readWorldsIndex,
  presetFromStateFile,
  worldChapterNo,
  migrateLegacyState,
  migrateWorldsSchema,
} from "./worlds.mjs";
export { parseStateFile, stateViewFor } from "./state-view.mjs"; // v1.13 拆出（角色面板解析）
import { createAcpSession } from "./acp.mjs";
import { engineFor, prepareSpawn } from "./engines.mjs";
import { killPendingLogins, runLogout, startLogin } from "./engine-auth.mjs";
import {
  readCredentials,
  writeCredentials,
  mergeCredentials,
  validateCredentialsPatch,
  publicView,
  secretsOf,
  sanitizeErrorMessage,
} from "./credentials.mjs";
import { testLlm, testImage } from "./credentials-probe.mjs";
import { loadCatalog, refreshCatalog, revalidateCatalog } from "./providers-catalog.mjs";
import { mediaMcpServers } from "./media-mcp.mjs";
import { createRequestHandler } from "./routes.mjs";
import { errText } from "./errors.mjs";

// ---------- 外部 import 面保活：拆出模块的既有导出符号逐名 re-export（electron/tests/doctor 从这里 import） ----------
// v1.13 清理：删掉四个**零消费者**的 re-export（LOGS_DIRNAME / PROBE_IMAGE_SIZE / CATALOG_TIMEOUT_MS /
// GENERATE_TIMEOUT_MS）——它们仍在自己模块里导出（内部用得上），只是没有外部 import 面，挂在桶里纯属噪声。
// 判断口径：全仓（server/shared/src/tests/scripts/electron，去注释后）扫过一遍，确认无人引用。
export {
  PRESET_ID_RE,
  ASSET_FILE_RE,
  ASSET_KINDS,
  presetAssetsDir,
  assetRelPath,
  presetIdFromPath,
  legacyAssetCandidates,
  resolvePersistPreset,
} from "./assets.mjs";
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
export {
  RULES_SENTENCES,
  RULES,
  SUPPLEMENT_PROMPT,
  parseArtLine,
  parseExpressionLine,
  parsePresetAddedLine,
  parseTreeLine,
  parseAudioLine,
} from "./protocol-lines.mjs";
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
  createWorld,
  forkWorld,
  restoreWorld,
  updateWorld,
  labelSnapshot,
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
export { testLlm, testImage, PROBE_TIMEOUT_MS } from "./credentials-probe.mjs";
// 服务目录更新通道（v1.10，docs/adr/0020）：纯函数面经入口 re-export（与其余拆出符号同款；
// 单测也可直接从 server/providers-catalog.mjs import）
export {
  CATALOG_FILENAME,
  CATALOG_VERSION,
  CATALOG_TTL_MS,
  CATALOG_URLS,
  validateCatalogDocument,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
  loadCatalog,
  refreshCatalog,
  revalidateCatalog,
  __resetCatalogMemo, // 测试探针（仅 tests/providers-catalog.test.ts 清进程内 memo 用，不是对外 API）
} from "./providers-catalog.mjs";
export {
  MEDIA_MCP_NAME,
  MEDIA_TOOL_NAME,
  TOOL_DEFINITION,
  DEFAULT_SIZES,
  imageSizeFor,
  imagesEndpoint,
  resolveOutputPath,
  pickImagePayload,
  requestImage,
  generateImage,
  mediaMcpPath,
  mediaMcpServers,
  handleMcpMessage,
} from "./media-mcp.mjs";
// 剧本体检（v1.8）的纯函数视图：路由链住在 routes.mjs，这里只把测试面（tests/server.test.ts 直测 tmp 根）
// 一起 re-export——与本文件其余拆出符号同款（外部 import 面永远是入口）。
export { presetCheckResult, presetCheckView } from "./routes.mjs";

export const EFFORT = process.env.EFFORT || "medium"; // 正戏回合档位：低推理换节奏，可设 high
// 建档/规划类回合（出清单、改树、装配）不需要高推理：单独一档更省、更快（v1.6 分档）
export const EFFORT_PLANNING = process.env.EFFORT_PLANNING || "low";

// ---------- 主题白名单与兜底：**真源在 shared/theme.mjs**（v1.13） ----------
// 此前这三个常量定义在本文件、presets.mjs 反向 import 本文件（acp-server ↔ presets 成环，
// 只靠「跨环引用都在函数体内」活着）。现在真源搬去 shared：环没有了，客户端也不再自己抄一份。
// 这里 re-export 是给「外部 import 面逐字不变」用的（`parseFrontmatter`/`normalizeTheme` 那一族同款纪律）。
export { FONT_PRESETS, DIALOG_TEXTURES, FALLBACK_THEME } from "../shared/theme.mjs";

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

/**
 * 优雅退出：停 HTTP server（先断 SSE 再等连接散尽）+ kill 引擎子进程。
 * 幂等（重复调用是 no-op），且**允许在没起过服务时调用**——Electron 的 `will-quit` 与信号处理
 * 都直接调它，不该因为「服务没起来」而抛。
 * @returns {Promise<void>} 收尾完成（没有实例时立即 resolve）
 */
export function stopServer() {
  return stopServerFn ? stopServerFn() : Promise.resolve();
}

/**
 * 起服务（**进程级单例**）：重复调用返回同一个 promise，不会起第二个实例。
 *
 * 装配面（这个闭包就是本文件的全部内容）：HTTP/SSE、资产落盘流水线、逐轮快照与回合日志、
 * 质量守卫追问、引擎会话生命周期，以及凭据 / 服务目录 / 登录三条运行时闭包。
 * 配置一律从 `config.mjs` 的进程全局读（GAME_ROOT/端口/`BUNKITEN_HOME`）——要换根目录请用环境变量，
 * 不要指望在这里传参（集成测试正是以「起子进程 + 注入 env」的方式跑的）。
 * @returns {Promise<ServerHandle>} 句柄（含实际端口与 base URL）
 */
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
  // 凭据在**每次 spawn 时**现读（v1.10，docs/adr/0019）：后端的 spawn 三件套（命令/参数/env）由
  // server/engines.mjs 的描述符按当前 `creds.engine` 给出（v1.11，docs/adr/0022）——grok 注入 BYOK
  // 四件套、codex 注入 CODEX_HOME 等；我们的值优先，覆盖继承来的同名 env。`mediaMcpServers` 只在图片侧
  // 配了自备 key 时才挂 MCP 子进程（两引擎都走 ACP 的 mcpServers 字段）。重启（restartAcp）就是拿同一份
  // 逻辑再建一次会话——所以「保存 key / 切引擎 → 立刻重启引擎」不需要再碰任何别的状态。
  /** @type {import("./engines.mjs").EngineDescriptor} 当前会话的描述符（buildAcp 每次赋值） */
  let engine = engineFor(undefined);
  /** @returns {ReturnType<typeof createAcpSession>} */
  function buildAcp() {
    const creds = readCredentials();
    const plan = prepareSpawn({ creds, home: gameHome(), gameRoot: GAME_ROOT, rules: RULES });
    engine = plan.engine;
    return createAcpSession({
      engine: plan.engine,
      cmd: plan.spawn.cmd,
      args: plan.spawn.args,
      env: plan.spawn.env,
      // Windows 的 .cmd 引擎（npm 装的 grok）要经 shell 起——由描述符的 windowsSafeSpawn 决定（见 engines.mjs）
      shell: plan.spawn.shell === true,
      gameRoot: GAME_ROOT,
      sessionFile: SESSION_FILE,
      rules: plan.rules,
      effort: EFFORT,
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
   * 优雅重启引擎会话（POST /api/engine/restart 的落地）：杀旧引擎子进程 → 按**当前**凭据重建会话 → 重新握手。
   * env 只在 spawn 时读一次，所以「保存 key / 切引擎立刻生效」必须走这里。回合进行中拒绝——杀进程等于把这一回合
   * 的推演连同落盘一起截断（客户端会停在「待重同步」态），宁可让玩家等这一回合结束。
   * 切引擎时旧会话的存档（.shell-session.json 里的 sessionId）会因 engine 标记不匹配被 boot 跳过（走 session/new）。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function restartAcp() {
    if (busy) return { ok: false, error: "正在演绎中，等这一回合结束再重启" };
    const old = acp;
    try {
      old.proc.kill();
    } catch {}
    // 等旧进程退出再拉新的：两个引擎进程同时持同一会话目录会互相踩 session 文件
    await new Promise((resolve) => {
      if (old.proc.exitCode !== null || old.proc.signalCode !== null) return resolve(undefined);
      const t = setTimeout(() => {
        try {
          old.proc.kill("SIGKILL");
        } catch {}
        resolve(undefined);
      }, 1500);
      old.proc.once("exit", () => {
        clearTimeout(t);
        resolve(undefined);
      });
    });
    acp = buildAcp();
    lastEffort = EFFORT; // 新会话的 boot() 会把档位设成 EFFORT，记账跟着复位（否则同档位不再下发）
    try {
      await acp.boot();
    } catch (e) {
      console.error("[acp] restart failed:", errText(e));
      return { ok: false, error: `重启后引擎握手失败：${errText(e)}` };
    }
    console.log(`[acp] engine restarted: ${acp.sessionId}`);
    return { ok: true };
  }

  /** @returns {object} 脱敏视图（永不回明文 key） */
  function credentialsView() {
    return publicView(readCredentials());
  }

  /**
   * GUI 的「登录」按钮（POST /api/engine/login）：把**玩家自己**的 CLI 登录流程拉起来（grok → `grok login`、
   * codex → 随包 codex 二进制的 `login`，都写在玩家自己的 home 里）。登录是长事务，这里只回执——
   * 客户端轮询 /api/auth 看玩家 home 里的登录产物出现没有（见 server/engine-auth.mjs）。
   * @returns {Promise<{ok: boolean, error?: string, hint?: string}>}
   */
  function startEngineLogin() {
    return startLogin({ engine: engineFor(readCredentials().engine), home: gameHome() });
  }

  /**
   * GUI 的「登出」按钮（POST /api/engine/logout）：执行 CLI 自己的登出（**全局动作**——终端里那份也会没，
   * GUI 已经先确认过），并把游戏侧的 codex 登录副本一并清掉。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  function logoutEngine() {
    return runLogout({ engine: engineFor(readCredentials().engine), home: gameHome() });
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
      writeCredentials(gameHome(), next);
      console.log(`[acp] credentials updated: llm=${next.llm.mode} image=${next.image.mode}`); // 只记模式，不记 key
      return { ok: true, view: publicView(next) };
    } catch (e) {
      return { ok: false, error: `写入凭据失败：${errText(e)}` };
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
   * 顺带做 stale-while-revalidate（ADR-0020 的「修订」段）：先**立即**回当前 `loadCatalog()` 的结果，
   * 再 fire-and-forget 触发一次后台刷新（`revalidateCatalog`——永不抛、非阻塞、进程内单飞、TTL/开关守卫照用）。
   * 效果：长开着的应用下次设置屏 GET 就会后台刷新，不必等重启（发布→可见的窗口第 ③ 项）。
   * @returns {{providers: object[], source: string, fetchedAt: string|null}} source = remote/cache/bundled
   */
  function providersView() {
    const view = loadCatalog({ root: gameHome() });
    void revalidateCatalog({ root: gameHome() });
    return view;
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
    for (const p of loadCatalog({ root: gameHome() }).providers) ids.add(p.id);
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
      const entry = assetRegistry.get(key) || {
        type,
        name,
        rawName,
        presetId: pid || "",
        file: "",
        srcRel,
        ready: false,
      };
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
    if (art) {
      persistAsset(art.type, art.name, art.srcRel, art.regen);
      return;
    }
    const expr = parseExpressionLine(line);
    if (expr) {
      broadcast({ type: "expression", character: expr.character, variant: expr.variant });
      return;
    }
    // 【树】= 剧情编辑回合的静默刷新信号（客户端收到即重取 /api/tree）：此前漏接线，只在单测里被直接调用过
    if (parseTreeLine(line)) {
      broadcast({ type: "treeEdited" });
      return;
    }
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
    // 这里的 `[...assetRegistry]` **不是**多余的 spread：persistAsset 会在迭代过程中 delete 注册表键（同名未就绪项），
    // 直接遍历活 Map 会踩「边遍历边删」——先取一份快照才是对的（oxlint 的 no-useless-spread 看不到这一层）。
    // oxlint-disable-next-line unicorn/no-useless-spread -- 见上：快照是语义的一部分
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
      try {
        stateTexts.push(fs.readFileSync(path.join(WORLDS_ROOT, e.worldId, "state.md"), "utf8"));
      } catch {}
    }
    /** @param {string} name */
    const inUse = (name) => stateTexts.some((t) => t.includes(name));
    const out = new Map();
    /** @param {string} key @param {string} type @param {string} rest @param {string} file @param {boolean} ready */
    const push = (key, type, rest, file, ready) => {
      const { name, variant } = splitAssetVariant(rest);
      // preset 必填：客户端画廊按它做防御性过滤（跨剧本条目一律丢弃并告警）
      out.set(key, {
        type,
        name,
        variant,
        file,
        ready,
        preset: presetId,
        inUse: inUse(name),
        mtime: mtimeOf(path.join(GAME_ROOT, file)),
      });
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
      if (preset && fs.existsSync(path.join(GAME_ROOT, file)))
        push(`封面|${preset.title}`, "封面", preset.title, file, true);
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
      type,
      name,
      rawName,
      presetId: finalPid,
      file,
      srcRel,
      ready: true,
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
      if (preset)
        console.warn(`[acp] 世界 ${worldId} 未在 index.json 里记到合法 preset，改用其 state.md 的 preset: ${preset}`);
    }
    if (!PRESET_ID_RE.test(preset) || preset === currentPresetId) {
      if (!PRESET_ID_RE.test(preset)) {
        console.warn(
          `[acp] 世界 ${worldId} 查不到合法 preset（索引与 state.md 都没有），保持当前剧本: ${currentPresetId || "（无）"}`,
        );
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
    // 下发形状按后端：grok 收 `{configId, value:{value}}`、codex 收 `{configId, value}`（docs/adr/0022 实证）
    const option = engine.effortOption(effort);
    if (!option) return;
    try {
      await acp.request("session/set_config_option", { sessionId: acp.sessionId, ...option });
      lastEffort = effort;
      console.log(`[acp] reasoning_effort -> ${effort}`);
    } catch {
      /* 引擎不支持档位：静默，不阻断回合 */
    }
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
  // v1.13 起条目带 prompt（可重演的玩家输入，docs/adr/0023）：与 files 同条目绑定，
  // 重演（回退到前一条 turn 条目 + 重发该输入）不再依赖内存账本，刷新/重启后照样成立。
  /**
   * 落本轮快照与回合日志。
   * @param {string} text 发给引擎的提示词原文
   * @returns {number|null} 本回合对应的**快照序号**（客户端拿它当「第 N 幕」的幕号，v1.13）：
   *   写了新快照 → 新 seq；三文件全等被去重 → 仍是**当前最新** seq（状态没变，幕号不该跳号）；
   *   非正戏回合 / 世界没定 / seq 溢出 → null（客户端回落到自己的回合计数）
   */
  function writeTurnSnapshot(text) {
    if (!isMainTurn(text)) return null;
    const worldId = currentWorldId;
    if (!worldId || !WORLD_ID_RE.test(worldId)) return null; // 还没定下世界（未开局）→ 无从落快照
    const files = readWorldFiles(path.join(WORLDS_ROOT, worldId));
    const res = writeSnapshot(WORLDS_ROOT, worldId, {
      kind: "turn",
      nodeId: parseTreePointer(files.tree),
      chapterNo: files.tree != null ? worldChapterNo(files.tree) : null,
      // 只记玩家叙事输入：客户端的开局/续玩指令是 generated 的指令、不是玩家的话，回填空串——
      // 重演入口对空输入给降级提示（既不回发「继续世界：」，也不假装有输入）；引擎侧原文仍在 logs 的 prompt
      prompt: isDirectivePrompt(text) ? "" : text,
      files,
    });
    if (res.ok) console.log(`[acp] snapshot written: ${worldId}/history/${String(res.seq).padStart(4, "0")}.json`);
    // 回合原文日志（v1.7）：与快照同一判定、同一时机，但是独立的 logs/NNNN.json 条目。
    // 快照去重（duplicate）时日志照写——日志记的是叙事原文，与三文件去重是两回事；seq 对齐取舍见 writeTurnLog。
    // text 用 turnText 全文：若本回合触发过质量守卫追问，追问补发的回合尾已在其中（追问不另立条目）。
    const log = writeTurnLog(WORLDS_ROOT, worldId, { seq: res.seq, prompt: text, text: turnText });
    if (log.ok) console.log(`[acp] turn log written: ${worldId}/logs/${String(log.seq).padStart(4, "0")}.json`);
    return res.seq ?? null;
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
      const s = await acp.request(
        "session/prompt",
        {
          sessionId: acp.sessionId,
          prompt: [{ type: "text", text: SUPPLEMENT_PROMPT }],
        },
        120_000,
      );
      if (s && s.error) throw new Error(`引擎补充回合失败：${s.error.message ?? JSON.stringify(s.error)}`);
    } catch (e) {
      console.warn(`[acp] 追问失败，放弃（回合日志里留痕）: ${errText(e)}`);
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
      const r = await acp.request(
        "session/prompt",
        {
          sessionId: acp.sessionId,
          prompt: [{ type: "text", text }],
        },
        600000,
      );
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
      const turnSeq = writeTurnSnapshot(text); // 逐轮快照 + 回合日志：flushArtLines 之后、busy=false 之前
      // 先复位再广播：客户端收到 turn_end 会立即发下一条（制作流水线自动推进），
      // 若广播后才复位会撞 409 窗口（v1.4 实测抓到的竞态）
      busy = false;
      // seq 随事件下发（v1.13）：幕号 = 快照序号，与存档点标注/回溯分割线同基底——
      // 此前客户端用自己的回合计数，续玩或回退一次两套数字就错开
      broadcast({ type: "turn_end", seq: turnSeq });
      return { ok: true };
    } catch (e) {
      flushArtLines();
      busy = false;
      broadcast({ type: "error", message: errText(e) });
      return { ok: false, error: errText(e) };
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

  // 服务目录更新（v1.10，docs/adr/0020）：非阻塞抓一次发布源（两源并行、取最新有效）→ 校验 → 落 `~/.bunkiten/providers.json`。
  // `void` 掉：启动不被网络拖住，失败静默（refreshCatalog 永不抛），抓不到就继续用缓存/内置兜底。
  // 会话期内的刷新不靠重启：`GET /api/providers`（闭包 providersView）会 stale-while-revalidate 再抓一次。
  // 两个开关：`BUNKITEN_DISABLE_UPDATE=1` 直接跳过（打包冒烟用，与 electron-updater 同款）；`BUNKITEN_PROVIDERS_URL` 覆盖源（测试/镜像）。
  void refreshCatalog({ root: gameHome() });

  // ---------- HTTP ----------
  const server = http.createServer(
    createRequestHandler({
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
      startEngineLogin,
      logoutEngine,
      providersView,
      get currentPresetId() {
        return currentPresetId;
      },
      get sessionId() {
        return acp.sessionId;
      },
    }),
  );

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
    try {
      await acp.boot();
    } catch (e) {
      console.error("[acp] boot failed:", errText(e));
    }
    return handle;
  });

  let stopped = false;
  stopServerFn = async () => {
    if (stopped) return;
    stopped = true;
    let handle = null;
    try {
      handle = await instance;
    } catch {
      /* 启动失败也要清理子进程 */
    }
    for (const res of clients) res.destroy(); // SSE 长连接会拖住 server.close 回调
    clients.clear();
    if (handle) await /** @type {Promise<void>} */ (new Promise((resolve) => handle.server.close(() => resolve())));
    // 杀**当前**的引擎进程：重启过就可能是新拉起的那个（旧 handle.proc 只是启动时的快照）
    try {
      acp.proc.kill();
    } catch {}
    setTimeout(() => {
      try {
        acp.proc.kill("SIGKILL");
      } catch {}
    }, 1500).unref(); // SIGTERM 不退则强杀
    // 在途的「登录」进程也一并收掉（登录是长事务：开浏览器等回调，可能挂着好几分钟）
    killPendingLogins();
  };

  /** @param {string} sig 信号名（SIGINT/SIGTERM） */
  const signalExit = (sig) => {
    console.log(`[acp] ${sig} received, shutting down`);
    // signalExit 只在 startServer 已赋值 stopServerFn 之后才可能被进程信号触发——cast 表达这个顺序不变式
    /** @type {() => Promise<void>} */ (stopServerFn)()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => signalExit("SIGINT"));
  process.on("SIGTERM", () => signalExit("SIGTERM"));
  return instance;
}

// 直接运行：node server/acp-server.mjs
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) startServer();
