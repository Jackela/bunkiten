// 回合流水线（v1.13 从入口 `startServer` 闭包拆出的第四个工厂模块，与 sse/assets-pipeline/settings-api 同款）：
// **一个回合从提示词到落定的全部记账**——推理档位、世界/剧本嗅探、流式协议行扫描、逐轮快照与回合日志、
// 质量守卫追问，以及「忙碌中」这道闸。
//
// 为什么拆它：这七份可变状态（seg/busy/turnText/artScanPos/currentPresetId/currentWorldId/lastEffort）
// 与十个函数此前和别的七件事挤在同一个 650+ 行的闭包里，而「这七个变量只在一个回合内有意义、生命周期
// 就是这个回合」这条纪律没有名字。搬进来之后，状态与操作它的函数终于是同一份闭包里的邻居：
// 谁改 `busy`、谁清 `turnText`、`artScanPos` 为什么必须与 `turnText` 同步推进，都在同一屏里。
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

// 正戏回合判定（纯逻辑，CONTRACTS §2）：规划/美术/剧情/装配/创作模式回合（前缀正则与 pickEffort 同一份
// 真源 shared/protocol.mjs 的 DIRECTIVE_PREFIX_RE，v1.7 统一两份手写副本）、以及带「待命：」的开局指令
// 都不推进剧情正文，不该产生逐轮快照（「待命：」是后缀判定，不属前缀集合，保持原地）。
// 函数体刻意保留显式块结构：契约 lint（tests/contract.test.ts ⑥）抓函数体的正则把边界锚在「两空格缩进的
// 收尾花括号」上（入口时代它是闭包里的嵌套函数），模块级函数需要自己的块来提供这个锚点——别把它压成单行。
/**
 * @param {string} text 发给引擎的提示词原文
 * @returns {boolean} 是否正戏回合
 */
function isMainTurn(text) {
  const s = String(text || "").trim();
  if (DIRECTIVE_PREFIX_RE.test(s)) {
    return false;
  }
  if (s.includes("待命：")) return false;
  return true;
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
 * @property {() => void} resetEffort 档位记账复位（新会话 boot 已设成 EFFORT）
 * @property {string} currentPresetId 嗅探出的当前剧本 id（getter，路由链每次读最新值）
 */

/**
 * 造一条回合流水线（本模块只有这一个入口；七份逐回合状态都在下面的闭包里，外部无法直接读改）。
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

  let currentPresetId = ""; // 当前剧本 id（sendPrompt 嗅探世界段得出；/img 的旧档直服与嗅探比对用它）
  /** @type {string|null} */ let currentWorldId = null; // 当前世界 id（sniffPreset 一并保存；逐轮快照按它落盘 history/NNNN.json）
  let lastEffort = EFFORT; // 上次已生效的推理档位（boot 已设 EFFORT；档位变化才再发 set_config_option）
  let turnText = ""; // 当前回合 chunk 文本累积，用于流式解析【图】标记行
  let artScanPos = 0; // turnText 里已扫描到的位置（只解析完整行，见 ingestChunkText）

  /**
   * agent_message_chunk 的文本增量接缝（acp.mjs 的回调）。
   * @param {string} text 文本增量
   */
  function onChunk(text) {
    ingestChunkText(text);
    broadcast({ type: "chunk", seg, text });
  }

  /**
   * tool_call/tool_call_update 的进度接缝（acp.mjs 的回调）：段号 +1 并广播。
   * 客户端按它重置新段的显示态（前移游标、按阶段换状态文案）。
   * @param {string} label 进度标题
   */
  function onSeg(label) {
    seg += 1;
    broadcast({ type: "seg", seg, label });
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
        retryPendingWithPreset(newId); // 装配期那批「还不知道剧本 id」的条目按新剧本重试（B1）
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
   * 发一个游戏回合给引擎（POST /prompt 的落地）。
   * @param {string} text 提示词原文
   * @returns {Promise<{ok: boolean, error?: string}>} error 在回合失败（busy/引擎未就绪/引擎回 error/超时）时给出
   */
  async function sendPrompt(text) {
    // 本回合全程用同一份会话：restartAcp 在 busy 期间拒绝（见入口），所以这一份不会中途被换掉；
    // 反过来「一次调用现取一次」也顺手堵住了「检查完 busy 还没置位时被重启插进来」的窗口。
    const session = getSession();
    if (busy || !session.sessionId) return { ok: false, error: busy ? "上一回合还在进行" : "引擎未就绪" };
    sniffPreset(text);
    busy = true;
    seg = 0;
    turnText = "";
    artScanPos = 0;
    broadcast({ type: "turn_start" });
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

  return {
    sendPrompt,
    onChunk,
    onSeg,
    isBusy,
    resetEffort,
    get currentPresetId() {
      return currentPresetId;
    },
  };
}
