// galgame ACP server —— 入口与装配（v1.7 拆模块，零依赖 Node）：
// spawn grok agent stdio (ACP)、SSE 推流、资产落盘流水线、回合流水线、逐轮快照、进程生命周期都在这里的 startServer 闭包装配。
// 用法：node server/acp-server.mjs  →  http://localhost:7800 ；或 import { startServer }
//
// 模块地图（同目录 server/ 共 24 个文件 = 本入口 + 23 个模块；v1.13 与目录逐一对齐过——
// 这份地图此前停在 v1.7 的 10 个模块，而 AGENTS.md 又让读者来这里找地图，结果是「文档指着地图、地图缺一半」）：
//   config.mjs 路径/端口（GAME_ROOT/SESSION_FILE/WORLDS_ROOT/gameHome 等公共依赖，零依赖叶子）
//   errors.mjs 未知错误的读取口（errText/errName：catch 变量在 strict 下是 unknown）
//   fs-guard.mjs 路径越界守卫 withinRoot（/app、/audio、/img 三条直服与 media-mcp 落盘共用这一份）
//   protocol-lines.mjs 注入 agent 的 RULES 原文 + 五种协议行 parse* + 质量守卫追问指令 SUPPLEMENT_PROMPT
//   assets.mjs 美术资产路径契约纯函数（sanitize/白名单/落盘判定/差分拆分）
//   assets-pipeline.mjs 资产注册表与落盘（persistAsset/persistAssetFromFile/listAssets/未就绪项重试）
//   presets.mjs preset.md 解析 + assetTargetFile + 剧本导出包（buildPresetBundle/importPresetBundle）
//   snapshots.mjs 世界三文件与逐轮快照的地基（WORLD_FILES/WORLD_ID_RE/读写/选择/fork 纯函数）
//   worlds.mjs 世界线索引/CRUD/导出导入/migrateLegacyState/migrateWorldsSchema
//   state-view.mjs state.md 容错解析与 GET /api/state 的判定（角色面板数据源）
//   audio.mjs presets/<id>/audio/ 扫描（AUDIO_KINDS/AUDIO_EXTS/AUDIO_FILE_RE re-export 给 doctor）
//   http-util.mjs 本地端点防护（跨站 403/body 413）+ 出网小工具（withTimeoutSignal/joinEndpoint）+ /app 的 MIME 与目录解析
//   sse.mjs SSE 广播（/events 连接集合的生命周期 + 帧格式）
//   acp.mjs ACP 子进程封装（spawn/JSON-RPC request/sessionId 存取/boot/会话图片定位）
//   engines.mjs 引擎描述符表（spawn 三件套/规则注入/档位形状/登录探测/CODEX_HOME 准备，v1.11）
//   engine-auth.mjs 登录/登出编排（GUI 按钮 → 玩家自己 CLI 的单例在途登录 + 收尾，v1.11）
//   credentials.mjs 引擎凭据（~/.bunkiten/credentials.json 的 normalize/读写/校验/env/脱敏，v1.10）
//   credentials-probe.mjs 「测试连接」探活（LLM 先 /models 再退化最小 completion；图片走最小生成，v1.10）
//   providers-catalog.mjs 服务目录在线更新（抓取/校验/缓存/三级回落/单飞刷新，v1.10，ADR-0020）
//   settings-api.mjs 设置面（凭据增删查测 + 引擎登录登出 + 服务目录读取：每次调用现读凭据）
//   turn-pipeline.mjs 回合流水线（v1.13：逐回合七件状态 + 十个函数——档位分档、世界/剧本嗅探、
//                      流式协议行扫描、逐轮快照与回合日志、质量守卫追问、busy 闸）
//   media-mcp.mjs 自建出图 MCP server（bunkiten-media__generate_image，零依赖 stdio，v1.10）
//   routes.mjs HTTP 路由链（createRequestHandler(ctx)，闭包能力由本文件注入）
//
// 本文件继续逐名 re-export 拆出的全部符号——外部 import 面（electron/main.js、tests/、scripts/doctor.mjs）
// 逐字不变。其中三个纯函数（pickEffort/isDirectivePrompt/parseWorldRef）与档位常量（EFFORT/EFFORT_PLANNING）
// 的**真源已搬走**：前者去 server/turn-pipeline.mjs、后者去零依赖叶子 server/config.mjs（回合流水线不能
// 反向 import 本入口，成环）——这里只 re-export。契约 lint（tests/contract.test.ts ⑥）改从 turn-pipeline.mjs
// 的源码抓 pickEffort/isMainTurn 的函数体（必须引用 shared 真源的 DIRECTIVE_PREFIX_RE）。
// 主题取值（FONT_PRESETS/DIALOG_TEXTURES/MOTIFS/FALLBACK_THEME）v1.13 起**真源在 shared/theme.mjs**，
// 本文件只 re-export——此前它钉在这里、presets.mjs 反向 import，acp-server ↔ presets 因此成环。
// 现在 server/ + shared/ 的模块图无环（拆环的收益：谁在模块顶层用一次真源也不再是静默 undefined）。
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
// 档位常量（EFFORT/EFFORT_PLANNING）与路径/端口同处 config.mjs：见下方 re-export 处的说明
import { EFFORT, GAME_ROOT, BASE_PORT, PORT_MAX_RETRY, SESSION_FILE, WORLDS_ROOT, gameHome } from "./config.mjs";
// 规则原文（注入 agent 的 RULES）；五种协议行的解析与质量守卫的 SUPPLEMENT_PROMPT 已随回合流水线
// 一并住进 server/turn-pipeline.mjs——那边 import（本入口不再用它们，只 re-export 给外部）
import { RULES } from "./protocol-lines.mjs";
import { migrateLegacyState, migrateWorldsSchema } from "./worlds.mjs";
export { parseStateFile, stateViewFor } from "./state-view.mjs"; // v1.13 拆出（角色面板解析）
import { createAcpSession } from "./acp.mjs";
import { engineFor, prepareSpawn } from "./engines.mjs";
import { killPendingLogins } from "./engine-auth.mjs";
import { readCredentials } from "./credentials.mjs";
import { refreshCatalog } from "./providers-catalog.mjs";
import { mediaMcpServers } from "./media-mcp.mjs";
import { createRequestHandler } from "./routes.mjs";
import { createBroadcaster } from "./sse.mjs";
import { createAssetPipeline } from "./assets-pipeline.mjs";
import { createSettingsApi } from "./settings-api.mjs";
import { createTurnPipeline } from "./turn-pipeline.mjs";
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

// ---------- 档位常量与回合流水线的三个纯函数：**真源都搬走了，这里只 re-export**（v1.13） ----------
// EFFORT/EFFORT_PLANNING 此前钉在本文件（`export const`），但回合流水线不能反向 import 本入口（成环），
// 而它们是「进程全局配置」的一类（与端口/根目录同处零依赖叶子正好）——所以真源搬去 config.mjs。
// 本文件自己仍要用 EFFORT（buildAcp 的初始档位），故上面 import、这里 re-export（外部 import 面逐字不变）。
export { EFFORT, EFFORT_PLANNING } from "./config.mjs";
// parseWorldRef/isDirectivePrompt/pickEffort 与它们的使用者（sniffPreset/applyEffort）同住 turn-pipeline.mjs：
// 纯函数跟调用点一起搬，单测仍从入口 import 它们（本行就是那条通路）。
export { parseWorldRef, isDirectivePrompt, pickEffort } from "./turn-pipeline.mjs";

// ---------- 主题白名单与兜底：**真源在 shared/theme.mjs**（v1.13） ----------
// 此前这三个常量定义在本文件、presets.mjs 反向 import 本文件（acp-server ↔ presets 成环，
// 只靠「跨环引用都在函数体内」活着）。现在真源搬去 shared：环没有了，客户端也不再自己抄一份。
// 这里 re-export 是给「外部 import 面逐字不变」用的（`parseFrontmatter`/`normalizeTheme` 那一族同款纪律）。
export { FONT_PRESETS, DIALOG_TEXTURES, FALLBACK_THEME } from "../shared/theme.mjs";

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

  // SSE 广播（连接集合的生命周期与帧格式在 server/sse.mjs，v1.13 从本闭包拆出）
  const sse = createBroadcaster();
  const broadcast = sse.broadcast;

  // 设置面（凭据/登录/服务目录，v1.13 拆去 server/settings-api.mjs）
  const settings = createSettingsApi();

  // 资产注册表与落盘（v1.13 拆去 server/assets-pipeline.mjs）：本闭包只留「协议行从哪来」的扫描，
  // 「该落到哪、落没落成」全在那边的模块里。会话图片定位用惰性箭头注入——acp 在本行之后才建。
  const assets = createAssetPipeline({ resolveImage: (name) => acp.resolveImage(name) });

  // 回合流水线（v1.13 拆去 server/turn-pipeline.mjs）：七份逐回合状态（seg/busy/turnText/artScanPos/
  // currentPresetId/currentWorldId/lastEffort）与回合的十个函数全在那个模块的闭包里——本文件不再有
  // 逐回合状态。这里注入三样能力：广播、资产落盘、以及两个**惰性箭头**（acp 与 engine 都在本行之后才建，
  // 重启时整个换掉，所以只能每次现取——与上面 assets 的 resolveImage 同款）。
  const turns = createTurnPipeline({
    broadcast,
    persistAsset: assets.persistAsset,
    retryPendingWithPreset: assets.retryPendingWithPreset,
    retryPendingWithOwnPreset: assets.retryPendingWithOwnPreset,
    getSession: () => acp,
    getEngine: () => engine,
  });

  // ACP 会话（spawn/JSON-RPC/sessionId/boot 都封装在 acp.mjs）：流式 chunk 与进度 label 两个回调直通
  // 回合流水线（标记扫描、seg 计数与 broadcast 都在那边——它才是「一个回合」的账本）。
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
      onChunk: turns.onChunk,
      onSeg: turns.onSeg,
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
    if (turns.isBusy()) return { ok: false, error: "正在演绎中，等这一回合结束再重启" };
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
    turns.resetEffort(); // 新会话的 boot() 会把档位设成 EFFORT，记账跟着复位（否则同档位不再下发）
    try {
      await acp.boot();
    } catch (e) {
      console.error("[acp] restart failed:", errText(e));
      return { ok: false, error: `重启后引擎握手失败：${errText(e)}` };
    }
    console.log(`[acp] engine restarted: ${acp.sessionId}`);
    return { ok: true };
  }

  // 回合的十个函数（handleArtLine/ingestChunkText/flushArtLines/sniffPreset/applyEffortValue/applyEffort/
  // isMainTurn/writeTurnSnapshot/supplementMissingOptions/sendPrompt）与它们操作的七份逐回合状态，
  // v1.13 起整体住在 server/turn-pipeline.mjs——本文件只在上面 createTurnPipeline 处注入能力、
  // 在下面路由链处转手 sendPrompt/currentPresetId，不再碰任何逐回合状态。

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
      sse,
      sendPrompt: turns.sendPrompt,
      listAssets: assets.listAssets,
      persistAssetFromFile: assets.persistAssetFromFile,
      resolveImage: (name) => acp.resolveImage(name),
      warnLegacyPathOnce: assets.warnLegacyPathOnce,
      credentialsView: settings.credentialsView,
      updateCredentials: settings.updateCredentials,
      testCredentials: settings.testCredentials,
      restartEngine: restartAcp,
      startEngineLogin: settings.startEngineLogin,
      logoutEngine: settings.logoutEngine,
      providersView: settings.providersView,
      get currentPresetId() {
        return turns.currentPresetId;
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
    sse.closeAll(); // SSE 长连接会拖住 server.close 回调（见 sse.mjs 的 closeAll）
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
