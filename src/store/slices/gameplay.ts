// gameplay slice（v1.6 拆分）：游戏屏的回合与选项——发指令（含 409/异常的错误路径）、SSE 事件分发（handleEvent）、
// 抽屉/打字完成标记、自动前进的玩家侧动作（倒计时本体在 context.ts，与 fireAutoAdvance 同一闭包域）。
//
// handleEvent 是整条协议链路的汇聚点（段过滤/标记/选项/章标记/排队补发）：各事件的处理体在
// EVENT_HANDLERS 表里按键落位（键 = AcpEvent["type"] 全集，漏配新事件类型即编译错），表项函数体
// 逐字来自原 switch 分支；其中 turn_end 的内部时序（先 applyMarkers → finishRegen → 落 finalText
// → pumpRegenQueue → 创作/图屏补发 → 章标记）是行为契约的一部分，顺序逐字保留；引用的流水线函数全部来自 ctx。
// v1.14：回合校验（事件带 turn 与当前回合不符即丢弃）、非正戏回合（main:false）不进历史、
// 章待办（pendingChapter）、停止回合（cancelTurn/turn_cancelled）、数值差分刷新、打字机播种键。
import { audioManager } from "../../lib/audio";
import { cancelEngine, fetchEngineStatus, fetchPresets, postPrompt, type AcpEvent } from "../../lib/acp";
import {
  buildResumeCommand,
  cleanForHistory,
  finalMarkers,
  isProtocolLine,
  parseChapterMark,
  parseOptions,
  scanMarkers,
  segStatusLabel,
} from "../../lib/parser";
import { applyExpression, castMember, nextPortraitOnExpression } from "../portrait";
import type { SliceContext } from "../context";
import type { GameStore } from "../types";

/**
 * SSE 事件处理器表：键 = `AcpEvent["type"]` 全集（全键映射——`AcpEvent` 新增 type 而漏配表项，
 * 在表的对象字面量处即编译错），表项参数经 `Extract` 收窄到该键的事件载荷。
 */
type EventHandlers = {
  [K in AcpEvent["type"]]: (event: Extract<AcpEvent, { type: K }>) => void;
};

/**
 * 表分发：`handlers[event.type](event)`。泛型 K 让「事件类型 ↔ 表项参数类型」保持相关——
 * 在 handleEvent 里直接联合索引调用会被 TS 拒绝（相关性联合的已知限制），经泛型分发全类型检查、零断言。
 */
function dispatchEvent<K extends AcpEvent["type"]>(
  handlers: EventHandlers,
  event: Extract<AcpEvent, { type: K }>,
): void {
  handlers[event.type](event);
}

export function createGameplaySlice(
  ctx: SliceContext<
    | "set"
    | "get"
    | "applyMarkers"
    | "resetTurnState"
    | "resetRunState"
    | "armWatchdog"
    | "clearWatchdog"
    | "sendStart"
    | "runNextPending"
    | "beginPlanning"
    | "startChapter"
    | "consumePendingChapter"
    | "advancePreload"
    | "onEngineError"
    | "armAutoAdvance"
    | "resumeAutoAdvance"
    | "cancelAutoAdvance"
    | "clearAutoAdvanceTimer"
    | "finishRegen"
    | "pumpRegenQueue"
    | "pumpDeferredArt"
    | "refreshTurnSnapshots"
  >,
): Pick<
  GameStore,
  | "send"
  | "sendPlayerTurn"
  | "toggleDrawer"
  | "setTypingDone"
  | "markTypingDone"
  | "resumePendingChapter"
  | "cancelTurn"
  | "armAutoAdvance"
  | "resumeAutoAdvance"
  | "cancelAutoAdvance"
  | "reconcileAfterReconnect"
  | "setSseDown"
  | "handleEvent"
> {
  const { set, get } = ctx;

  /**
   * 回合校验（v1.14）：事件带 `turn`、且客户端**已知**当前回合、且两者不符 → 这条事件属于
   * 迟到/串台的旧回合，整条丢弃（重量级副作用一个都不许发生）。
   * 三处刻意放宽：事件不带 `turn`（更老的 server）、`currentTurn` 未知（turn_start 没带 turn、
   * 或客户端刚重连还没对上账）都放行——宁可照旧处理，也不要因为一条对不上号的字段就把回合卡住。
   */
  const staleEvent = (turn?: number): boolean => {
    const cur = get().currentTurn;
    return turn !== undefined && cur !== null && turn !== cur;
  };

  /**
   * 重同步指令没发出去（409/网络异常）或重同步回合在引擎侧失败（SSE error 事件）：保留徽章、亮「再同步」入口。
   * 仅当本轮发送的正是重同步指令（resyncing）才把失败记到重同步头上——玩家自己指令的失败走
   * send / onEngineError 的普通出错文案（status「出错：…」），不冒充「重同步失败」；两条收尾路径都复位 resyncing。
   */
  const markResyncFailed = (message: string) => {
    if (!get().resyncing) return;
    set({ resyncFailed: true, resyncing: false, treeNotice: `重同步失败：${message}；点「再同步」重试` });
  };

  /**
   * 回合被停下的客户端语义（v1.14，cancelTurn 与 `turn_cancelled` 事件共用，幂等）：
   * 复位忙态、状态写「已停止」、置待重同步——引擎侧可能停在半完成的位置，下一句输入先发
   * `继续世界：` 让它重读档，叙事才不会接在残缺的上下文上。
   * 回合产物（选项/补画标记）只在**确实打断了一个在跑的回合**（进去时 engineBusy 为真）时清掉：
   * 重复的 turn_cancelled（回合已正常收尾）不该把玩家手上这份选项抹掉。
   */
  const applyTurnCancelled = () => {
    const s = get();
    const interrupted = s.engineBusy;
    set({
      engineBusy: false,
      turnStartAt: null,
      currentTurn: null,
      status: "已停止",
      // 没有世界线就没有可重同步的对象：此时只停止，不置徽章
      pendingResync: s.worldId ? { worldId: s.worldId, seq: null } : null,
      resyncFailed: false,
      resyncing: false,
      ...(interrupted ? { options: null, typingDone: false, artAsk: false } : {}),
    });
  };

  // SSE 事件 → 处理器表（表项体逐字来自原 handleEvent 的 switch 分支；原先在 switch 入口取一次的
  // `s = get()` 快照移到各表项首行——分发前没有任何状态写入，两次取值之间不可能有人插手，语义等价）。
  const EVENT_HANDLERS: EventHandlers = {
    /** SSE `turn_start`（回合开始）：清段表、置忙、重置回合显示态；记住服务端回合序号供后续校验 */
    turn_start(event) {
      if (staleEvent(event.turn)) return; // 迟到的旧回合不许把新回合的段表与显示态清掉
      const s = get();
      set({ segs: { 0: "" }, curSeg: 0, engineBusy: true, turnStartAt: Date.now(), currentTurn: event.turn ?? null });
      ctx.resetTurnState(s.turnKey + 1);
    },

    /** SSE `seg`（段切换）：游标前移 + 按阶段选择状态文案，并重置新段的显示态 */
    seg(event) {
      if (staleEvent(event.turn)) return;
      const s = get();
      if (event.seg > s.curSeg) {
        set({
          curSeg: event.seg,
          // 规划中引擎的写树工具调用会触发段切换，文案保持「撰写章节大纲…」不被通用状态覆盖
          status: s.preloadPhase === "planning" ? "撰写章节大纲…" : segStatusLabel(event.label),
        });
        ctx.resetTurnState(s.turnKey + 1);
      }
    },

    /** SSE `chunk`（增量正文）：追加进段表驱动打字机，并即时扫描【图】标记（流式按整行 key 去重） */
    chunk(event) {
      if (staleEvent(event.turn)) return;
      const s = get();
      const segs = { ...s.segs, [event.seg]: (s.segs[event.seg] ?? "") + event.text };
      set({ segs, received: segs[event.seg] });
      ctx.applyMarkers(scanMarkers(segs[event.seg]), true);
    },

    /**
     * SSE `expression`（【立绘】行）：差分表情切换；差分素材未生成（404）时由 PortraitLayer 回退基础图。
     * 同屏多立绘：同一角色在场上就复用她的槽位（保住 baseUrl）并移到队尾成为发言者，
     * 新角色追加、超上限从队首淘汰（见 portrait.applyExpression）。
     */
    expression(event) {
      const s = get();
      set({
        portraits: applyExpression(
          s.portraits,
          nextPortraitOnExpression(
            castMember(s.portraits, event.character),
            event.character,
            event.variant,
            s.selected?.id ?? "",
          ),
        ),
      });
    },

    /** SSE `presetAdded`（【新剧本】行）：新剧本入轮播（TitleScreen 读 store.presets），创作屏转成功态 */
    presetAdded(event) {
      set({ creationResult: event.id, assembling: false, assemblyStalled: false });
      fetchPresets()
        .then((r) => set({ presets: r.presets }))
        .catch(() => {
          // 刷新失败不打断成功态；回 title 时 TitleScreen 挂载会重新拉取
        });
    },

    /** SSE `treeEdited`（【树】协议行）：引擎已静默写回剧情树——图屏据此重取（编辑回合的可见摘要随 turn_end 落 treeNotice） */
    treeEdited(event) {
      const s = get();
      set({ treeStamp: s.treeStamp + 1, ...(event.note ? { treeNotice: event.note } : {}) });
    },

    /**
     * SSE `audio`（【曲】/【环境】/【音效】演出指令，v1.6）：交给 AudioManager 单例；文件缺失静默，
     * 与画面/回合状态完全解耦（音频永远不该影响剧情推进，所以这里不写任何 store 字段）
     */
    audio(event) {
      audioManager.handle({ kind: event.kind, name: event.name });
    },

    /** SSE `turn_end`（回合收尾）：全量重放标记 → 重绘收尾 → 历史/选项定格 → 队列补发 → 章标记切屏 */
    turn_end(event) {
      if (staleEvent(event.turn)) return; // 迟到/串台的收尾：不进历史、不推进流水线
      const s = get();
      // 幕号取事件带来的**快照序号**（v1.13 修）：存档点标注（「存档点 · 第 N 幕」）、回溯分割线
      // （「已回溯到第 N 幕」）与重演目标全用快照 seq，只有幕标题此前用客户端回合计数 turnNo+1——
      // 续玩（落一条空输入快照但不加幕）或回退之后，同一个抽屉里两套数字就错开。
      // 事件没带 seq（更老的 server）时回落旧口径，功能不消失。
      const actNo = typeof event.seq === "number" && event.seq > 0 ? event.seq : s.turnNo + 1;
      const finalText = s.segs[s.curSeg] ?? "";
      ctx.applyMarkers(finalMarkers(finalText), false);
      // 重绘回合结束：标记若未命中也解除挂起（文件落盘可能晚于标记，统一刷一次清单）。
      // 没收到 `|重绘` 标记 = 未确认（引擎漏标记/文件没落盘），记进 regenFailed 供收尾提示点名
      ctx.finishRegen(false);
      // 制作中阶段引擎只回确认/清单/标记，不进历史；「开演。」后的开场正文正常记录
      const craftingNoise =
        s.screen === "crafting" &&
        (s.preloadPhase === "init" || s.preloadPhase === "planning" || s.preloadPhase === "queue");
      // v1.14 非正戏回合（`main:false`，服务端同时给 `seq:null`：重同步等客户端指令触发的内部回合）：
      // 不进历史、不占幕号、不 bump 回合计数——它的正文只是引擎在回一句「读到了」。
      // 缺省（更老的 server 不带 main）按正戏回合处理，行为与 v1.13 逐字一致。
      const isMain = event.main !== false && event.seq !== null;
      // 后台补画回合（v1.13 两段式）与 treeAsk 同款：确认句不进正文/历史
      const clean =
        !isMain || craftingNoise || s.screen === "creation" || s.treeAsk || s.artAsk ? "" : cleanForHistory(finalText);
      set({
        finalText,
        options: parseOptions(finalText),
        status: "就绪",
        engineBusy: false,
        turnStartAt: null,
        currentTurn: null, // 本回合到此为止：之后的 chunk/turn_end 都不该再认它
        artAsk: false, // 补画回合到此为止（下面的泵会给下一项置位）
        history: clean ? [...s.history, { kind: "act", n: `第 ${actNo} 幕`, t: clean }] : s.history,
        turnNo: clean ? s.turnNo + 1 : s.turnNo,
        // 回退后的第一个回合收尾 = 重同步成功：清徽章，提示条改写为「完成重同步」态。
        // 只有本轮发送的正是重同步指令（resyncing，restoreSnapshot/retryResync 置位）才认领这次收尾——
        // resume 投递失败后玩家自己发的普通指令成功时引擎并没有重读档，pendingResync 已在 send
        // 入口静默清掉，这里不许假称完成；非 resyncing 的回合一律不碰 pendingResync（零行为变化）。
        ...(s.resyncing
          ? {
              // 重同步回合不携带玩家输入；重演入口的显隐与降级由快照数 + 点击时解析负责（v1.13 删内存
              // 账本：普通回退后玩家点重演，解析到的是最新那条 turn 条目自己的输入——输入与它产生的
              // 状态同条目绑定，不存在「回退前的旧输入叠在回退点之后」那条路，见 docs/adr/0023）
              resyncing: false,
              ...(s.pendingResync
                ? {
                    pendingResync: null,
                    resyncFailed: false,
                    // 停止回合并置的 pendingResync 没有「第 N 幕」（seq:null）：只说同步完成，不编一个幕号
                    treeNotice:
                      s.pendingResync.seq === null ? "进度已同步" : `已回到第 ${s.pendingResync.seq} 幕，进度已同步`,
                  }
                : {}),
            }
          : {}),
      });
      // 批量重绘：本轮已结束、引擎空闲，派发队列里的下一条（上面若有排队指令，pump 会让它们先发）
      ctx.pumpRegenQueue();
      // v1.14：回合收尾**恒**重拉 state.md 视图（不再只在角色面板开着时刷新）——数值差分
      // （lastTurnDeltas）是每一回合都要看的因果反馈；面板开着的既有刷新由同一条路带给它。
      get().refreshTurnState();
      if (s.screen === "creation") {
        // 创作屏：引擎整轮回复（跨段全文）过滤协议行后进对话流；协议行只驱动画面/事件
        const engineText = Object.values(s.segs)
          .join("\n")
          .split("\n")
          .filter((l) => !isProtocolLine(l))
          .join("\n")
          .trim();
        const c = get();
        set({
          ...(engineText
            ? { creationMessages: [...c.creationMessages, { role: "engine" as const, text: engineText }] }
            : {}),
          // 装配回合结束仍没有【新剧本】：置为可重试
          ...(c.assembling ? { assembling: false, assemblyStalled: true } : {}),
        });
      }
      if (s.treeAsk) {
        // 剧情图编辑回合：可见摘要进图屏提示条（不进历史），并让图屏重取树
        const visible = Object.values(s.segs)
          .join("\n")
          .split("\n")
          .filter((l) => !isProtocolLine(l))
          .join("\n")
          .trim();
        set({ treeAsk: false, treeStamp: get().treeStamp + 1, ...(visible ? { treeNotice: visible } : {}) });
      }
      // 创作屏排队消息补发（不筛屏：覆盖排队后 Esc 离屏的滞留场景；server busy 已在本事件前复位）
      const pendingMsg = get().pendingCreationMessage;
      if (pendingMsg) {
        set({ pendingCreationMessage: null });
        get().send(pendingMsg);
      }
      // 图屏排队编辑指令补发（同排队模式；treeAsk 提前置位，保证该回合不进历史）
      const pendingTree = get().pendingTreeMessage;
      if (pendingTree) {
        set({ pendingTreeMessage: null, treeAsk: true, treeNotice: null });
        get().send(pendingTree);
      }
      // 重演的排队跟进：重同步回合成功收尾（上面的 resyncing 分支已清 pendingResync）后立即重发
      // 那一刻解析出的玩家输入（点击时已从快照条目取好），走正常玩家回合路径（连掷同理可用）。
      // 认领条件用进入本事件时的 s.resyncing：普通回合即使残留 pendingRerollPrompt 也不跟进
      // （resync 失败后的排队输入保留到玩家点「再同步」成功后的下一次收尾）。
      // 先清后发，事件重入也不会二次发送。
      const rerollPrompt = get().pendingRerollPrompt;
      if (rerollPrompt && s.resyncing) {
        set({ pendingRerollPrompt: null });
        get().sendPlayerTurn(rerollPrompt);
      }
      // 两段式（v1.13）：玩家在补画期间的操作**优先**补发；没有才继续补下一张。两条都「先清后发」。
      const queuedPrompt = get().pendingPlayerPrompt;
      if (queuedPrompt) {
        set({ pendingPlayerPrompt: null });
        get().sendPlayerTurn(queuedPrompt);
      } else {
        ctx.pumpDeferredArt();
      }
      // 重演入口的可见性：按钮要「有前序快照」才出现（spec P3-T1），而快照数只有服务端知道——
      // 只在还没数够（未知或 < 2）时补拉一次 /api/history（有列表缓存，代价小；数够即停，不再逐回合拉）
      const snaps = get().turnSnapshots;
      if (snaps === null || snaps < 2) ctx.refreshTurnSnapshots();
      ctx.clearWatchdog();
      void ctx.advancePreload();
      // 章标记（终章回合，全文可能跨段）：**始终**记待办（语义 = 待规划章号，口径同 beginPlanning(next)）。
      // 正在 game 屏：即刻切制作中屏并规划（既有语义逐字保持，startChapter 里清掉待办）。
      // 在别的屏（画廊/设置/剧情图 overlay 等）：只记待办，等回到 game 屏且引擎空闲时由
      // context.consumePendingChapter 消费（四个回屏点），UI 另有「第 N 章待规划 · 继续」兜底按钮。
      const mark = parseChapterMark(Object.values(s.segs).join("\n"));
      if (mark !== null) {
        const next = mark + 1;
        if (get().screen === "game") ctx.startChapter(next);
        else set({ pendingChapter: next });
      }
    },

    /**
     * SSE `error`（引擎侧回合失败）：制作中屏按阶段降级（onEngineError），并给重同步回合记账。
     * v1.14 的 `stale:true`（迟到/失焦的失败）：它说的是一个已经不在跑的回合——不改忙态、
     * 不推进制作流水线，空闲时给一句提示（在跑的回合的状态位归它自己）。
     */
    error(event) {
      if (staleEvent(event.turn)) return;
      if (event.stale) {
        if (!get().engineBusy) set({ status: `出错：${event.message}` });
        return;
      }
      ctx.onEngineError(event.message);
      // 重同步回合在引擎侧失败（error response → SSE error）：徽章保留、亮「再同步」入口，
      // 提示条与 status 同说失败——不再出现「已回退成功」与「出错」互相矛盾的两张嘴
      markResyncFailed(event.message);
    },

    /**
     * SSE `turn_cancelled`（v1.14 停止本回合）：与 cancelTurn 的那条路同源（幂等）——
     * 复位忙态、状态「已停止」、置待重同步。服务端也可能不广播（投递失败），所以两条路都要能自己站住。
     */
    turn_cancelled(event) {
      if (staleEvent(event.turn)) return;
      applyTurnCancelled();
    },
  };

  return {
    send(text) {
      const t = text.trim();
      if (!t) return;
      // v1.14：重同步还挂着（补发投递失败过、徽章在）时玩家发了普通指令——**不再静默作废**。
      // 直接放行这句会让叙事接在引擎没重读过的旧上下文上（回退等于白做）；先强推一次重同步
      // （发「继续世界：」），并把玩家这句话排进「重同步收尾后补发」位（与重演跟进同一条路，
      // 见 turn_end 的 pendingRerollPrompt 分支）——玩家的话不会丢，档也会真的退回去。
      const pending = get().pendingResync;
      if (pending && t !== buildResumeCommand(pending.worldId)) {
        set({
          pendingRerollPrompt: t,
          resyncFailed: false,
          resyncing: true,
          treeNotice: "正在同步进度…",
        });
        get().send(buildResumeCommand(pending.worldId));
        return;
      }
      // 手选/自由输入即接管：倒计时作废（否则刚发出去的回合结束前倒计时会再补一条 409）
      ctx.clearAutoAdvanceTimer();
      set({ options: null, typingDone: false, autoAdvanceDeadline: null, status: "引擎演绎中…" });
      postPrompt(t)
        .then((r) => {
          // 回合没发出去（409 等）就不会有 turn 事件，engineBusy 需复位供制作中屏推进
          if (!r.ok) {
            set({ status: `出错：${r.error}`, engineBusy: false, turnStartAt: null });
            // 挂起中的画廊重绘没有对应回合了：记为未确认，解除挂起让按钮恢复并接队列下一条
            ctx.finishRegen(false);
            markResyncFailed(r.error);
          }
        })
        .catch((e: unknown) => {
          set({ status: `出错：${String(e)}`, engineBusy: false, turnStartAt: null });
          ctx.finishRegen(false);
          markResyncFailed(String(e));
        });
    },

    sendPlayerTurn(text) {
      const t = text.trim();
      if (!t) return;
      // 输入随快照条目在服务端落盘（重演的数据源）——这里只剩 trim 守卫，不再有客户端账本（v1.13，见 docs/adr/0023）
      // 例外：引擎正忙着「后台补画」（artAsk）时玩家的操作先排队，别去撞 409——回合收尾会优先补发它。
      // 只拦 artAsk（不看 engineBusy）：补画指令发出到 turn_start 抵达之间还有一段网络窗口，
      // 那一刻 engineBusy 仍是 false，只看它就会漏拦；artAsk 恰好覆盖整段（置位=已发、清除=该回合收尾）。
      // 普通回合的抢发行为与 v1.12 逐字一致（服务端 409 + 既有出错路径）——这里不是给所有忙碌兜底。
      if (get().artAsk) {
        set({ pendingPlayerPrompt: t });
        return;
      }
      get().send(t);
    },

    toggleDrawer() {
      set({ drawerOpen: !get().drawerOpen });
    },

    setTypingDone(done) {
      if (get().typingDone !== done) set({ typingDone: done });
    },

    markTypingDone(key) {
      // 幂等：同一幕重复上报不制造无谓的状态更新（订阅者不该被同值的写入唤醒）
      if (get().typingDoneKey !== key) set({ typingDoneKey: key });
    },

    resumePendingChapter() {
      const s = get();
      if (s.pendingChapter === null) return;
      if (s.screen !== "game") return;
      if (s.engineBusy) {
        // 抢发必 409：不硬来，把原因说出来（提示条会在回合收尾后照常可用）
        set({ status: "忙碌中，等这一幕结束就开始下一章" });
        return;
      }
      ctx.consumePendingChapter();
    },

    async cancelTurn() {
      const s = get();
      if (!s.engineBusy && s.currentTurn === null) {
        // 没有在跑的回合：不发请求（服务端也会回 cancelled:false），只把话说清
        set({ status: "没有正在进行的回合" });
        return;
      }
      try {
        const r = await cancelEngine();
        if (!r.ok) {
          set({ status: `停止失败：${r.error ?? "未知错误"}` });
          return;
        }
        if (!r.cancelled) {
          // 服务端说没有可停的回合（它那边已经收尾）：只把忙态与服务端对齐，不置待重同步
          set({ engineBusy: false, turnStartAt: null, currentTurn: null });
          return;
        }
        // cancelled:true：与 SSE turn_cancelled 走同一条路（哪条先到都幂等）
        applyTurnCancelled();
      } catch (e) {
        set({ status: `停止失败：${String(e)}` });
      }
    },

    armAutoAdvance() {
      ctx.armAutoAdvance();
    },

    resumeAutoAdvance() {
      ctx.resumeAutoAdvance();
    },

    cancelAutoAdvance() {
      ctx.cancelAutoAdvance();
    },

    /**
     * SSE 重连对账（v1.14 受控例外，App 的 onConn("open") 调用；首连与重连一视同仁、幂等）：
     * 断线期间错过的 `turn_start`/`turn_end` 会让客户端忙态与回合号与真值错开，只能靠服务端这一份准。
     * 拉一次 `GET /api/engine/status` 对齐 `engineBusy`/`currentTurn`，并顺手补拉一次
     * turnSnapshots（重演入口的可见性判据，走 ctx.refreshTurnSnapshots）。
     * 取数失败静默保持现态——重连本身已经成功，不因为对账失败打扰玩家；**不伪造任何回合收尾**
     * （错过的正文/选项由玩家后续指令自然推进，这里只把「在不在跑」这一格对齐）。
     */
    reconcileAfterReconnect() {
      if (get().sseDown) set({ sseDown: false }); // 连上了：先撤掉断线提示（撤提示是「已连上」的直接语义）
      fetchEngineStatus()
        .then((st) => {
          if (st.busy) {
            // 服务端在跑：对齐忙态与当前回合（turn>0 才认，0 表示「没有正在跑的回合」）。turnStartAt 只在
            // 客户端此前不是忙态时才落——重连前已在跑的回合不该被这次对账重置耗时。
            set({
              engineBusy: true,
              currentTurn: st.turn > 0 ? st.turn : get().currentTurn,
              turnStartAt: get().turnStartAt ?? Date.now(),
            });
          } else if (get().engineBusy || get().currentTurn !== null) {
            // 服务端说没在跑而客户端还挂着忙态：错过收尾的最直接症状，复位为准（不伪造 turn_end）
            set({ engineBusy: false, currentTurn: null, turnStartAt: null });
          }
        })
        .catch(() => {
          /* 取不到状态就保持现态：对账是尽力而为，失败不打扰玩家 */
        });
      ctx.refreshTurnSnapshots(); // 快照数一并补拉（断线期间的新回合会让它落后）
    },

    setSseDown(down) {
      // 幂等：同值不制造无谓的状态更新（订阅者不该被同值写入唤醒）
      if (get().sseDown !== down) set({ sseDown: down });
    },

    handleEvent(event) {
      // 类型层：表是 AcpEvent["type"] 的全键映射（漏配即编译错）；运行时兜底防的是服务端比
      // 客户端新的未知事件类型——warn 一声后忽略（等价于旧 switch 对未知 case 的静默跳过，只多一条可见线索）
      if (!EVENT_HANDLERS[event.type]) {
        console.warn(`[gameplay] 未知 SSE 事件类型：${event.type}`);
        return;
      }
      dispatchEvent(EVENT_HANDLERS, event);
    },
  };
}
