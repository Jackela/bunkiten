// 回合流水线（v1.13 从入口 `startServer` 闭包拆出的第四个工厂模块，与 sse/assets-pipeline/settings-api 同款）：
// **一个回合从提示词到落定的全部记账**——推理档位、世界/剧本嗅探、流式协议行扫描、回合序号与迟到隔离、
// 停止本回合、逐轮快照与回合日志、质量守卫追问，以及「忙碌中」这道闸。
//
// 为什么拆它：这些可变状态（seg/busy/turn/currentTurn/turnText/artScanPos/currentPresetId/currentWorldId/
// lastEffort）与十来个函数此前和别的七件事挤在同一个 650+ 行的闭包里，而「这些变量只在一个回合内有意义、
// 生命周期就是这个回合」这条纪律没有名字。搬进来之后，状态与操作它的函数终于是同一份闭包里的邻居：
// 谁改 `busy`、谁清 `turnText`、`artScanPos` 为什么必须与 `turnText` 同步推进，都在同一屏里。
//
// 回合序号（v1.14，docs/adr/0026）：每个 `sendPrompt` 启动的回合拿一个单调递增的 `turn`，事件全带它；
// `cancel()` 把在途回合就地作废（`currentTurn` 归零）——引擎**此后到达**的 chunk 与响应都按序号丢弃，
// 所以「停止」之后既不会补一个 turn_end，也不会把迟到的正文混进下一回合。
//
// 与 assets-pipeline.mjs 的分工（这条边界是本次拆分的主线）：
//   · 本模块认识「回合」——它读 turnText、管 busy、按回合末尾落快照与日志；
//   · assets-pipeline 不认识回合——它只回答「给我一条【图】/一次 /img 命中，该落到哪、落没落成」。
// 所以 `persistAsset` 一族是**注入**进来的，而不是本模块 import 来的。
//
// 注入面（本模块**不 import 入口**，否则成环）：broadcast（SSE）、persistAsset 一族（资产落盘），
// 以及两个**惰性箭头** getSession/getEngine——acp 会话与引擎描述符在本工厂之后才建，重启（restartAcp）
// 时整个换掉，所以只能每次现取。不注入、直接 import 的是「纯函数的地基」：snapshots/worlds/
// protocol-lines/assets 的判定、shared 的协议真源、config 的档位常量、errors 的 errText。
import path from "path";
// 协议常量唯一真源（v1.7，docs/adr/0012）：指令前缀正则与章标记正则都在 shared/protocol.mjs——
// 前者 `pickEffort` 与 `isMainTurn` 共用同一份值、后者质量守卫豁免（本模块）与 `parseChapterMark`（客户端）
// 共用同一份值；本模块不再自持副本（契约 lint ⑤⑥组断言这一点）。
import { CHAPTER_MARK_RE, DIRECTIVE_PREFIX_RE } from "../shared/protocol.mjs";
// 档位常量（EFFORT/EFFORT_PLANNING）住在 config.mjs（零依赖叶子，与其余进程全局同处）：本模块不能
// import 入口（成环），所以它们从入口搬到 config——入口再 re-export，外部 import 面逐字不变。
import { EFFORT, EFFORT_PLANNING, WORLDS_ROOT } from "./config.mjs";
import { PRESET_ID_RE } from "./assets.mjs";
import {
  SUPPLEMENT_PROMPT,
  parseArtLine,
  parseExpressionLine,
  parsePresetAddedLine,
  parseTreeLine,
  parseAudioLine,
} from "./protocol-lines.mjs";
import { WORLD_ID_RE, parseTreePointer, readWorldFiles, writeSnapshot, writeTurnLog } from "./snapshots.mjs";
import { presetFromStateFile, readWorldsIndex, worldChapterNo } from "./worlds.mjs";
import { errText } from "./errors.mjs";

// ---------- 模块级纯函数（无状态、可单独 import 单测；入口逐名 re-export 保持外部 import 面不变） ----------

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

// 重同步回合判定（纯逻辑，v1.14）：客户端补发的续玩指令 `继续世界：<worldId>。`——从世界线屏继续一局，
// 或回退/重演之后让引擎重读档。它**产出正文却不推进状态**：不写逐轮快照（不进 history、不占幕号，
// 客户端据此不把重读档的复述算成一幕），但正文是玩家真看到的当前场景、选项段也照要（质量守卫照跑），
// 所以回合日志仍写。开局指令 `开局：` 不在此列——那才是真开一幕。
/**
 * @param {string} text 发给引擎的提示词原文
 * @returns {boolean} 是否重同步（续玩/重读档）回合
 */
function isResyncTurn(text) {
  return /^\s*继续世界：/.test(String(text || ""));
}

// 正戏回合判定（纯逻辑，CONTRACTS §2）：规划/美术/剧情/装配/创作模式回合（前缀正则与 pickEffort 同一份
// 真源 shared/protocol.mjs 的 DIRECTIVE_PREFIX_RE，v1.7 统一两份手写副本）、重同步回合（v1.14）、
// 以及带「待命：」的开局指令都不推进剧情状态，不该产生逐轮快照（「待命：」是后缀判定，不属前缀集合，保持原地）。
// 函数体刻意保留显式块结构：契约 lint（tests/contract.test.ts ⑥）抓函数体的正则把边界锚在「两空格缩进的
// 收尾花括号」上（入口时代它是闭包里的嵌套函数），模块级函数需要自己的块来提供这个锚点——别把它压成单行。
/**
 * @param {string} text 发给引擎的提示词原文
 * @returns {boolean} 是否正戏回合（产生逐轮快照的那一类）
 */
function isMainTurn(text) {
  const s = String(text || "").trim();
  if (DIRECTIVE_PREFIX_RE.test(s)) {
    return false;
  }
  if (isResyncTurn(s)) return false;
  if (s.includes("待命：")) return false;
  return true;
}

// 叙事回合判定（v1.14）：产出正文、按「每轮协议」以选项段收尾的那两类（正戏 + 重同步）。**回合日志与
// 质量守卫用它**——重同步回合不写快照，但它的正文一样要进回溯面（`GET /api/logs` 与回想面板），缺
// `**行动**` 时玩家一样需要选项；纯指令回合（美术：/规划：/剧情：/装配/创作模式/带待命后缀）既不写
// 日志也不追问，这条不变量与改动前一致。
/**
 * @param {string} text 发给引擎的提示词原文
 * @returns {boolean} 是否产出叙事正文的回合
 */
function isNarrativeTurn(text) {
  return isMainTurn(text) || isResyncTurn(text);
}

// ---------- 工厂 ----------

/**
 * ACP 会话的最小面（实现是 server/acp.mjs 的 `createAcpSession` 返回值；只声明本模块用到的两个成员——
 * 这里**不 import acp.mjs**：注入面就够用，免得两个模块互相认识）。
 * @typedef {object} TurnSession
 * @property {(method: string, params?: object|null, timeoutMs?: number) => Promise<any>} request JSON-RPC 请求（resolve 整个响应 msg，result/error 都在里面）
 * @property {string|null} sessionId 当前 ACP 会话 id（getter；boot 完成前为 null）
 */

/**
 * 引擎描述符的最小面（server/engines.mjs 的 EngineDescriptor；只声明下发档位形状那一项）。
 * @typedef {object} TurnEngine
 * @property {(effort: string) => {configId: string, value: unknown} | null} effortOption 推理档位的下发形状（两引擎不同：见 docs/adr/0022）
 */

/**
 * 注入面（入口 startServer → 本工厂）。两个 getter 必须是**惰性箭头**：acp 会话与引擎描述符在本工厂
 * 之后才建，重启时整个换掉，所以每次用都得现取（不能把值抓进闭包）。
 * @typedef {object} TurnPipelineDeps
 * @property {(obj: object) => void} broadcast SSE 广播（server/sse.mjs 的广播器；帧格式与连接生命周期都在那边）
 * @property {(type: string, rawName: string, srcRel: string, regen?: boolean, presetId?: string) => boolean} persistAsset
 *   【图】标记的落盘（拿不到剧本时留占位条目并返回 false；判定全在 assets-pipeline.mjs）
 * @property {(presetId: string) => number} retryPendingWithPreset 【新剧本】<id> 的补落盘重试（装配期那批先到的【图】）
 * @property {() => number} retryPendingWithOwnPreset 未就绪条目按各自记着的剧本重试（回合末补扫）
 * @property {() => TurnSession} getSession 当前 ACP 会话
 * @property {() => TurnEngine} getEngine 当前引擎描述符
 */

/**
 * 回合流水线的对外面（入口拿到它之后转手给路由链与 ACP 会话；members 只留真正被外部读的那些）。
 * @typedef {object} TurnPipeline
 * @property {(text: string) => Promise<{ok: boolean, error?: string}>} sendPrompt 发一个游戏回合（POST /prompt 的落地）
 * @property {(text: string) => void} onChunk agent_message_chunk 的文本增量（累积 + 逐行扫协议行 + 广播 chunk）
 * @property {(label: string) => void} onSeg tool_call/tool_call_update 的进度标题（seg +1 + 广播 seg）
 * @property {() => boolean} isBusy 是否有回合在进行（重启引擎前的闸）
 * @property {() => boolean} cancel 停止当前回合（POST /api/engine/cancel 的记账面）：作废在途回合、busy 复位、
 *   广播 turn_cancelled、留一条 cancelled 日志；**不写快照**。返回是否真的停了一个在途回合
 * @property {() => void} resetEffort 档位记账复位（新会话 boot 已设成 EFFORT）
 * @property {number} turn 最近开始过的回合号（0 = 还没跑过回合；GET /api/engine/status 的对账面）
 * @property {string} currentPresetId 嗅探出的当前剧本 id（getter，路由链每次读最新值）
 */

/**
 * 造一条回合流水线（本模块只有这一个入口；逐回合状态都在下面的闭包里，外部无法直接读改）。
 * @param {TurnPipelineDeps} deps 注入面（成员语义见 typedef）
 * @returns {TurnPipeline} 各方法的语义见 typedef 与各自文档
 */
export function createTurnPipeline({
  broadcast,
  persistAsset,
  retryPendingWithPreset,
  retryPendingWithOwnPreset,
  getSession,
  getEngine,
}) {
  let seg = 0; // 当前回合的段号（tool_call 每来一次 +1；随 chunk/seg 事件下发）
  let busy = false; // 回合进行中（sendPrompt 的入口闸 + 重启引擎的闸）
  let turn = 0; // 单调回合号：每个 sendPrompt 启动的回合 +1（事件全带它；0 = 还没跑过回合）
  let currentTurn = 0; // 在途回合号（0 = 空闲）；迟到的 chunk/响应按它判定丢弃（见 onChunk 与 sendPrompt 的守卫）
  let acceptChunks = false; // 是否还接收到达的 chunk/seg（回合开始开、收尾/取消关——取消后引擎仍可能吐一点）
  let turnPrompt = ""; // 本回合的输入原文（取消/失败写日志时要用它；sendPrompt 每次赋值）

  let currentPresetId = ""; // 当前剧本 id（sendPrompt 嗅探世界段得出；/img 的旧档直服与嗅探比对用它）
  /** @type {string|null} */ let currentWorldId = null; // 当前世界 id（sniffPreset 一并保存；逐轮快照按它落盘 history/NNNN.json）
  let lastEffort = EFFORT; // 上次已生效的推理档位（boot 已设 EFFORT；档位变化才再发 set_config_option）
  let turnText = ""; // 当前回合 chunk 文本累积，用于流式解析【图】标记行
  let artScanPos = 0; // turnText 里已扫描到的位置（只解析完整行，见 ingestChunkText）

  /**
   * agent_message_chunk 的文本增量接缝（acp.mjs 的回调）。
   * 守卫（v1.14）：**只接在途回合的 chunk**——取消之后引擎可能还会吐最后一点（甚至已经开跑的下一回合
   * 都还没拿到序号），那些一律丢弃：不累加 turnText（否则会混进日志/下一回合的快照）、不上屏。
   * @param {string} text 文本增量
   */
  function onChunk(text) {
    if (!acceptChunks) return;
    ingestChunkText(text);
    broadcast({ type: "chunk", turn: currentTurn, seg, text });
  }

  /**
   * tool_call/tool_call_update 的进度接缝（acp.mjs 的回调）：段号 +1 并广播。
   * 客户端按它重置新段的显示态（前移游标、按阶段换状态文案）。守卫同 onChunk（取消后不再推进段号）。
   * @param {string} label 进度标题
   */
  function onSeg(label) {
    if (!acceptChunks) return;
    seg += 1;
    broadcast({ type: "seg", turn: currentTurn, seg, label });
  }

  /** @returns {boolean} 是否有回合在进行（重启引擎前拒绝的判定点） */
  function isBusy() {
    return busy;
  }

  /**
   * 档位记账复位：新会话的 boot() 会把档位设成 EFFORT，记账必须跟着复位——否则「重启后第一个正戏回合」
   * 会以为自己已经是 EFFORT 而不下发 set_config_option（引擎侧却还是旧值）。
   */
  function resetEffort() {
    lastEffort = EFFORT;
  }

  /**
   * 一条已到达完整行的协议行候选 → 协议事件 / 落盘 / 当前剧本变更。
   * 分支顺序即契约（CONTRACTS §1）：【图】→【立绘/表情】→【树】→【新剧本】→ audio。
   * @param {string} line 已到达完整行的协议行候选
   */
  function handleArtLine(line) {
    const art = parseArtLine(line);
    if (art) {
      persistAsset(art.type, art.name, art.srcRel, art.regen);
      return;
    }
    const expr = parseExpressionLine(line);
    if (expr) {
      broadcast({ type: "expression", turn: currentTurn, character: expr.character, variant: expr.variant });
      return;
    }
    // 【树】= 剧情编辑回合的静默刷新信号（客户端收到即重取 /api/tree）：此前漏接线，只在单测里被直接调用过
    if (parseTreeLine(line)) {
      broadcast({ type: "treeEdited", turn: currentTurn });
      return;
    }
    const added = parsePresetAddedLine(line);
    if (added) {
      const newId = String(added.id || "").trim();
      if (PRESET_ID_RE.test(newId)) {
        // 【新剧本】<id> = 装配期的补落盘信号（B1）：装配时【图】标记先到（那时还没人知道新剧本 id，
        // 这批条目的 presetId 是空串），标记后到就把它们全部按新剧本 id 重试一次——这批就是新剧本的美术。
        currentPresetId = newId;
        retryPendingWithPreset(newId); // 装配期那批「还不知道剧本 id」的条目按新剧本重试（B1）
      } else {
        console.warn(`[acp] 【新剧本】id 非法，已忽略（不改当前剧本）: ${added.id}`);
      }
      broadcast({ type: "presetAdded", turn: currentTurn, id: added.id });
    }
    // 分支顺序末位的 audio（CONTRACTS §1）：演出指令，只转发事件，不落盘、不生成、不进 registry
    const audio = parseAudioLine(line);
    if (audio) broadcast({ type: "audio", turn: currentTurn, kind: audio.kind, name: audio.name });
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

  /** 回合末补扫：把 turnText 尾部的残行（没有换行收尾的最后一行）也过一遍，并补一次未就绪资产的落盘 */
  function flushArtLines() {
    if (artScanPos < turnText.length) handleArtLine(turnText.slice(artScanPos));
    artScanPos = turnText.length;
    // 图片文件可能晚于标记落盘，回合结束补一次（迭代纪律见 assets-pipeline 的 retryPendingWithOwnPreset）
    retryPendingWithOwnPreset();
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
    const option = getEngine().effortOption(effort);
    if (!option) return;
    const session = getSession();
    try {
      await session.request("session/set_config_option", { sessionId: session.sessionId, ...option });
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

  // 逐轮快照（CONTRACTS §2）：正戏回合结束后把当前世界三文件全文存一份 history/NNNN.json。
  // 调用点固定在 flushArtLines() 之后、busy=false 之前——此刻本轮所有落盘都已定型，内容不会再多变。
  // v1.13 起条目带 prompt（可重演的玩家输入，docs/adr/0023）：与 files 同条目绑定，
  // 重演（回退到前一条 turn 条目 + 重发该输入）不再依赖内存账本，刷新/重启后照样成立。
  // v1.14 起本函数**只写快照**：回合日志拆去 writeTurnLogEntry（判定不再全等——重同步回合只写日志）。
  /**
   * 落本轮快照。
   * @param {string} text 发给引擎的提示词原文
   * @returns {number|null} 本回合对应的**快照序号**（客户端拿它当「第 N 幕」的幕号，v1.13）：
   *   写了新快照 → 新 seq；三文件全等被去重 → 仍是**当前最新** seq（状态没变，幕号不该跳号）；
   *   非正戏回合 / 世界没定 / seq 溢出 → null（客户端据此不把重读档的一轮算成一幕）
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
    return res.seq ?? null;
  }

  // 回合原文日志（v1.7）：与快照**分家**（v1.14）——单独一个函数、判定比快照宽一档（正戏 + 重同步）。
  // 为什么宽一档：重同步回合不推进状态（不写快照）但它产出的是玩家真看到的当前场景，回溯面（/api/logs、
  // 回想面板）不该缺这一条；缺 **行动** 时它也照样要追问。seq 取舍见 snapshots.writeTurnLog。
  /**
   * 落本轮回合日志。
   * @param {string} text 发给引擎的提示词原文（日志的 prompt = 引擎侧原文，与快照的 prompt 口径不同）
   * @param {{seq?: number|null, cancelled?: boolean, error?: string}} [extra] seq = 同回合快照序号（对齐提示）；
   *   cancelled/error 是 v1.14 的两个留痕字段（停止的回合与被判失败的回合各留一条）
   */
  function writeTurnLogEntry(text, extra = {}) {
    if (!isNarrativeTurn(text)) return;
    const worldId = currentWorldId;
    if (!worldId || !WORLD_ID_RE.test(worldId)) return;
    // text 用 turnText 全文：若本回合触发过质量守卫追问，追问补发的回合尾已在其中（追问不另立条目）。
    // 取消/失败两个分支没有快照序号（本就不写快照）→ seq 传 null，由 writeTurnLog 按 logs 自己递增
    //（append-only 永不让步：宁可两边步进错位，也不覆盖既有文件）。
    /** @type {any} */
    const entry = { seq: extra.seq ?? null, prompt: text, text: turnText };
    if (extra.cancelled) entry.cancelled = true;
    if (extra.error) entry.error = extra.error;
    const log = writeTurnLog(WORLDS_ROOT, worldId, entry);
    if (log.ok) console.log(`[acp] turn log written: ${worldId}/logs/${String(log.seq).padStart(4, "0")}.json`);
  }

  // 质量守卫（v1.7，每轮协议要求每回合带 **行动** 选项段）：叙事回合（正戏 + 重同步，v1.14 起后者也纳入）
  // 缺 `**行动**` 时，在同一 busy 窗口内自动补发一次内部追问（SUPPLEMENT_PROMPT，只要求补发回合尾）。
  // 追问属于同一回合：chunks 流进同一 turnText（客户端看到的是同一回合的补全，省一次 turn_end）、
  // 不另写快照与 log 条目（log 的 text 自然含补全后的全文）。只此一次——这里是单次 if、无重试循环，
  // 追问失败（引擎 error/超时）或补全后仍缺 `**行动**` 都放弃：log 里留痕，玩家仍可自由输入。
  // 客户端语义不变：SSE chunk 照常流，无需任何 client 改动。
  /** @param {string} text 发给引擎的提示词原文 */
  async function supplementMissingOptions(text) {
    if (!isNarrativeTurn(text) || !currentWorldId) return;
    if (turnText.includes("**行动**")) return;
    // 章末回合豁免：输出【章】第 N 章 完 的回合是每轮协议「以选项结束」的唯一合法例外
    //（SKILL「章节与剧情树」明文该轮不再出选项；RULES 第 3 句的协议行枚举也声明了这条章标记），
    // 缺 **行动** 不是引擎忘写——正则真源 CHAPTER_MARK_RE（shared/protocol.mjs），不追问。
    if (CHAPTER_MARK_RE.test(turnText)) return;
    console.log("[acp] 回合缺 **行动** 选项段，自动追问一次");
    const session = getSession();
    try {
      // 追问只要回合尾，走低档（SUPPLEMENT_PROMPT 不在 DIRECTIVE_PREFIX_RE 前缀集，pickEffort 会给正戏档，
      // 所以直接指定）；档位已由 lastEffort 记账，下个正戏回合的 applyEffort 会自动拉回。
      await applyEffortValue(EFFORT_PLANNING);
      // 追问只要回合尾，120s 足够（主回合 600s 是整轮叙事+美术的预算，追问不该占满）；
      // 超时与引擎 error 同路：catch 里 warn 后放弃，不转 409、不影响回合成功收尾
      const s = await session.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
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
   * 停止当前回合（POST /api/engine/cancel 的记账面，v1.14 P0；docs/adr/0026）。
   * 与「等引擎自己收尾」不同，这里的一切都是**本地判定**：`session/cancel` 那条 notification 只是礼貌地
   * 让引擎别再产出了（发不发得出去都不影响下面）。三步：
   *   ① 关掉 chunk 闸（迟到的正文不累加、不上屏——否则会混进下一回合的 turnText 与快照）；
   *   ② 把已产出的协议行照常扫完落定（美术标记先到先落盘，取消不该吞掉已经拿到的素材）；
   *   ③ busy 复位 → 广播 `turn_cancelled` → 留一条 `cancelled:true` 的日志（**不写快照**：这一轮没推进状态）。
   * 在途的 `session/prompt` 请求从此与本流水线无关：它的响应稍后到达，被 sendPrompt 里的回合序号守卫丢弃。
   * @returns {boolean} 是否真的停了一个在途回合（空闲时是 no-op）
   */
  function cancel() {
    if (!busy || currentTurn === 0) return false;
    const t = currentTurn;
    acceptChunks = false; // ①
    flushArtLines(); // ②
    busy = false; // ③
    currentTurn = 0;
    broadcast({ type: "turn_cancelled", turn: t });
    writeTurnLogEntry(turnPrompt, { cancelled: true });
    console.log(`[acp] turn cancelled: ${t}`);
    return true;
  }

  /**
   * 发一个游戏回合给引擎（POST /prompt 的落地）。
   * @param {string} text 提示词原文
   * @returns {Promise<{ok: boolean, error?: string}>} error 在回合失败（busy/引擎未就绪/引擎回 error/超时）时给出。
   *   **被取消的回合一律回 ok**（玩家自己要停的，不是失败）：它的收尾已经由 cancel() 走完，
   *   这里（迟到的响应到达时）只负责不复位已复位的 busy、不广播已广播过的东西。
   */
  async function sendPrompt(text) {
    // 本回合全程用同一份会话：restartAcp 在 busy 期间拒绝（见入口），所以这一份不会中途被换掉；
    // 反过来「一次调用现取一次」也顺手堵住了「检查完 busy 还没置位时被重启插进来」的窗口。
    const session = getSession();
    if (busy || !session.sessionId) return { ok: false, error: busy ? "上一回合还在进行" : "引擎未就绪" };
    sniffPreset(text);
    busy = true;
    const myTurn = ++turn; // 本回合的单调序号（事件全带它；迟到判定也按它）
    currentTurn = myTurn;
    acceptChunks = true;
    turnPrompt = text;
    seg = 0;
    turnText = "";
    artScanPos = 0;
    broadcast({ type: "turn_start", turn: myTurn });
    try {
      await applyEffort(text); // 档位变化才 set_config_option（在 session/prompt 之前）
      const r = await session.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text }],
        },
        600000,
      );
      // 取消/被取代后的迟到响应（v1.14）：这一回合的收尾已经由 cancel() 做过，直接归位——
      // 不写快照、不广播 turn_end（否则客户端会在一轮作废的回合上多收一个收尾）。
      if (currentTurn !== myTurn) return { ok: true };
      // acp.request 会 resolve 整个响应 msg：引擎按 JSON-RPC 回 error response（而不是断流/超时）时
      // 以前被当成功回合处理（照写快照、广播 turn_end、HTTP 200）——这里显式抛错，落进下方 catch
      //（error 事件 + busy 复位 + 不写快照 + POST /prompt 409），与超时/进程崩掉同一错误路径。
      if (r && r.error) {
        throw new Error(`引擎回合失败：${r.error.message ?? JSON.stringify(r.error)}`);
      }
      flushArtLines();
      // 质量守卫：flushArtLines 之后、writeTurnSnapshot 之前——追问补的回合尾也要进本轮快照与日志的定稿
      await supplementMissingOptions(text);
      if (currentTurn !== myTurn) return { ok: true }; // 追问期间被取消：同上，收尾已由 cancel() 走完
      flushArtLines(); // 追问回合的输出里可能还有协议行（【立绘】/音频三行），补扫一次
      const turnSeq = writeTurnSnapshot(text); // 逐轮快照：非正戏回合（含重同步）在此返回 null
      writeTurnLogEntry(text, { seq: turnSeq }); // 回合日志：判定比快照宽一档（重同步回合也留痕）
      // 先复位再广播：客户端收到 turn_end 会立即发下一条（制作流水线自动推进），
      // 若广播后才复位会撞 409 窗口（v1.4 实测抓到的竞态）
      busy = false;
      acceptChunks = false;
      currentTurn = 0;
      // seq 随事件下发（v1.13）：幕号 = 快照序号，与存档点标注/回溯分割线同基底——
      // 此前客户端用自己的回合计数，续玩或回退一次两套数字就错开。
      // main（v1.14）：重同步回合 seq:null + main:false，客户端据此**不占幕号、不进 history**。
      broadcast({ type: "turn_end", turn: myTurn, main: isMainTurn(text), seq: turnSeq });
      return { ok: true };
    } catch (e) {
      // 取消之后到达的失败（超时/引擎退出）不算失败回合：本地收尾已经做过，别再报一次错。
      if (currentTurn !== myTurn) return { ok: true };
      const msg = errText(e);
      flushArtLines();
      busy = false;
      acceptChunks = false;
      currentTurn = 0;
      // 失败留痕（v1.14）：log 条目带 error 字段——「这一轮发了什么、引擎回了什么/为什么没回」可回溯
      writeTurnLogEntry(text, { error: msg });
      // stale（v1.14，docs/adr/0026）：引擎可能已经写了一半盘（超时/中断都在半途），
      // 客户端的对账动作是**先重同步**（补发「继续世界：」让引擎重读档）再继续。
      // `error` 与 `message` 两个键都给同一份原文：后者是既有字段（客户端 AcpEvent 在用），前者是冻结的
      // 事件面（§2 的 `{type:"error", turn?, error, stale?}`）——等客户端统一到 error 后再删 message。
      broadcast({ type: "error", turn: myTurn, error: msg, message: msg, stale: true });
      return { ok: false, error: msg };
    }
  }

  return {
    sendPrompt,
    onChunk,
    onSeg,
    isBusy,
    cancel,
    resetEffort,
    get turn() {
      return turn;
    },
    get currentPresetId() {
      return currentPresetId;
    },
  };
}
