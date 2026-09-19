// gameplay slice（v1.6 拆分）：游戏屏的回合与选项——发指令（含 409/异常的错误路径）、SSE 事件分发（handleEvent）、
// 抽屉/打字完成标记、自动前进的玩家侧动作（倒计时本体在 context.ts，与 fireAutoAdvance 同一闭包域）。
//
// handleEvent 是整条协议链路的汇聚点（段过滤/标记/选项/章标记/排队补发）：各事件的处理体在
// EVENT_HANDLERS 表里按键落位（键 = AcpEvent["type"] 全集，漏配新事件类型即编译错），表项函数体
// 逐字来自原 switch 分支；其中 turn_end 的内部时序（先 applyMarkers → finishRegen → 落 finalText
// → pumpRegenQueue → 创作/图屏补发 → 章标记）是行为契约的一部分，顺序逐字保留；引用的流水线函数全部来自 ctx。
import { audioManager } from "../../lib/audio";
import { fetchPresets, postPrompt, type AcpEvent } from "../../lib/acp";
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
import type { StoreContext } from "../context";
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
  ctx: StoreContext,
): Pick<GameStore, "send" | "sendPlayerTurn" | "toggleDrawer" | "setTypingDone" | "armAutoAdvance" | "resumeAutoAdvance" | "cancelAutoAdvance" | "handleEvent"> {
  const { set, get } = ctx;

  /**
   * 重同步指令没发出去（409/网络异常）或重同步回合在引擎侧失败（SSE error 事件）：保留徽章、亮「再同步」入口。
   * 仅当本轮发送的正是重同步指令（resyncing）才把失败记到重同步头上——玩家自己指令的失败走
   * send / onEngineError 的普通出错文案（status「出错：…」），不冒充「重同步失败」；两条收尾路径都复位 resyncing。
   */
  const markResyncFailed = (message: string) => {
    if (!get().resyncing) return;
    set({ resyncFailed: true, resyncing: false, treeNotice: `重同步失败：${message}；点「再同步」重试` });
  };

  // SSE 事件 → 处理器表（表项体逐字来自原 handleEvent 的 switch 分支；原先在 switch 入口取一次的
  // `s = get()` 快照移到各表项首行——分发前没有任何状态写入，两次取值之间不可能有人插手，语义等价）。
  const EVENT_HANDLERS: EventHandlers = {
    /** SSE `turn_start`（回合开始）：清段表、置忙、重置回合显示态 */
    turn_start() {
      const s = get();
      set({ segs: { 0: "" }, curSeg: 0, engineBusy: true, turnStartAt: Date.now() });
      ctx.resetTurnState(s.turnKey + 1);
    },

    /** SSE `seg`（段切换）：游标前移 + 按阶段选择状态文案，并重置新段的显示态 */
    seg(event) {
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
          nextPortraitOnExpression(castMember(s.portraits, event.character), event.character, event.variant, s.selected?.id ?? ""),
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
    turn_end() {
      const s = get();
      const finalText = s.segs[s.curSeg] ?? "";
      ctx.applyMarkers(finalMarkers(finalText), false);
      // 重绘回合结束：标记若未命中也解除挂起（文件落盘可能晚于标记，统一刷一次清单）。
      // 没收到 `|重绘` 标记 = 未确认（引擎漏标记/文件没落盘），记进 regenFailed 供收尾提示点名
      ctx.finishRegen(false);
      // 制作中阶段引擎只回确认/清单/标记，不进历史；「开演。」后的开场正文正常记录
      const craftingNoise =
        s.screen === "crafting" &&
        (s.preloadPhase === "init" || s.preloadPhase === "planning" || s.preloadPhase === "queue");
      const clean = craftingNoise || s.screen === "creation" || s.treeAsk ? "" : cleanForHistory(finalText);
      set({
        finalText,
        options: parseOptions(finalText),
        status: "就绪",
        engineBusy: false,
        turnStartAt: null,
        history: clean ? [...s.history, { n: `第 ${s.turnNo + 1} 幕`, t: clean }] : s.history,
        turnNo: clean ? s.turnNo + 1 : s.turnNo,
        // 本回合若由玩家叙事输入发起（OptionList/FreeInput/自动前进，见 sendPlayerTurn）：定格为
        // lastTurnPrompt（重掷「重发同一输入」的数据源）并清在途标记；指令回合在途为空，
        // lastTurnPrompt 保持上一个玩家回合的值——重绘/续档之后仍能重掷上一个玩家回合。
        lastTurnPrompt: s.pendingTurnPrompt ?? s.lastTurnPrompt,
        pendingTurnPrompt: null,
        // 回退后的第一个回合收尾 = 重同步成功：清徽章，提示条改写为「完成重同步」态。
        // 只有本轮发送的正是重同步指令（resyncing，restoreSnapshot/retryResync 置位）才认领这次收尾——
        // resume 投递失败后玩家自己发的普通指令成功时引擎并没有重读档，pendingResync 已在 send
        // 入口静默清掉，这里不许假称完成；非 resyncing 的回合一律不碰 pendingResync（零行为变化）。
        ...(s.resyncing
          ? {
              resyncing: false,
              // 重同步回合不携带玩家输入（上面的 `?? s.lastTurnPrompt` 会保留回退前的旧输入 X）：
              // 图屏普通回退（reason:"restore"）完成后若不清空，玩家点重掷会 restore 到「已含 X 效果」
              // 的次新快照——等于撤销回退再把 X 叠一遍。置 null 让按钮正确收起；重掷路径不受影响：
              // 排队重发的回合会经 sendPlayerTurn 重新定格 lastTurnPrompt。
              lastTurnPrompt: null,
              ...(s.pendingResync
                ? {
                    pendingResync: null,
                    resyncFailed: false,
                    treeNotice: `已回到第 ${s.pendingResync.seq} 幕，进度已同步`,
                  }
                : {}),
            }
          : {}),
      });
      // 批量重绘：本轮已结束、引擎空闲，派发队列里的下一条（上面若有排队指令，pump 会让它们先发）
      ctx.pumpRegenQueue();
      // 角色面板开着：回合收尾即重拉 state.md 视图（好感度/导演手记/伏笔随回合变）；关着不拉
      if (s.charactersOpen) get().refreshCharacters();
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
          ...(engineText ? { creationMessages: [...c.creationMessages, { role: "engine" as const, text: engineText }] } : {}),
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
      // 重掷的排队跟进：重同步回合成功收尾（上面的 resyncing 分支已清 pendingResync）后立即重发
      // 玩家上一回合输入，走正常玩家回合路径（sendPlayerTurn 重新记录在途输入——连掷同理可用）。
      // 认领条件用进入本事件时的 s.resyncing：普通回合即使残留 pendingRerollPrompt 也不跟进
      // （resync 失败后玩家改发普通指令的场景，send 入口已把它随 pendingResync 静默作废）；
      // 先清后发，事件重入也不会二次发送。resync 失败不走这里——排队的重发保留到
      // 玩家点「再同步」成功后的下一次收尾照常跟进。
      const rerollPrompt = get().pendingRerollPrompt;
      if (rerollPrompt && s.resyncing) {
        set({ pendingRerollPrompt: null });
        get().sendPlayerTurn(rerollPrompt);
      }
      // 重掷入口的可见性：按钮要「有前序快照」才出现（spec P3-T1），而快照数只有服务端知道——
      // 只在还没数够（未知或 < 2）时补拉一次 /api/history（有列表缓存，代价小；数够即停，不再逐回合拉）
      const snaps = get().turnSnapshots;
      if (snaps === null || snaps < 2) ctx.refreshTurnSnapshots();
      ctx.clearWatchdog();
      void ctx.advancePreload();
      const g = get();
      if (g.awaitCommand === "/new-game" || g.awaitCommand === "/presets") {
        set({ screen: "title", awaitCommand: null });
        return;
      }
      // 章标记（终章回合，全文可能跨段）：切制作中屏并规划下一章
      const mark = parseChapterMark(Object.values(s.segs).join("\n"));
      if (mark !== null && get().screen === "game") {
        const next = mark + 1;
        set({
          screen: "crafting",
          chapterNo: next,
          preload: [],
          skipRequested: false,
          artReady: {},
          seenMarkerKeys: new Set(),
          options: null,
          typingDone: false,
        });
        ctx.beginPlanning(next);
      }
    },

    /**
     * SSE `error`（引擎侧回合失败）：制作中屏按阶段降级（onEngineError），并给重同步回合记账
     */
    error(event) {
      ctx.onEngineError(event.message);
      // 重同步回合在引擎侧失败（error response → SSE error）：徽章保留、亮「再同步」入口，
      // 提示条与 status 同说失败——不再出现「已回退成功」与「出错」互相矛盾的两张嘴
      markResyncFailed(event.message);
    },
  };

  return {
    send(text) {
      const t = text.trim();
      if (!t) return;
      // 回退后的重同步还挂着（补发投递失败过、徽章在），玩家却发了普通指令：静默放弃重同步——
      // 玩家选择继续走，不假称「完成重同步」（引擎并没有重读档）：徽章、失败入口与图屏提示一并撤下
      //（treeNotice 不撤会在图屏留下「点「再同步」重试」的残影，而按钮已随徽章消失）；
      // resyncing 同步落回 false，免得本次普通指令的失败被 markResyncFailed 记到已放弃的重同步头上；
      // 排队中的重掷跟进同理作废（档没退回去，重发就无从谈起）
      const pending = get().pendingResync;
      if (pending && t !== buildResumeCommand(pending.worldId)) {
        set({ pendingResync: null, resyncFailed: false, resyncing: false, pendingRerollPrompt: null, treeNotice: null });
      }
      // 手选/自由输入即接管：倒计时作废（否则刚发出去的回合结束前倒计时会再补一条 409）
      ctx.clearAutoAdvanceTimer();
      set({
        options: null,
        typingDone: false,
        autoAdvanceDeadline: null,
        status: "引擎演绎中…",
        awaitCommand: t === "/new-game" || t === "/presets" ? t : null,
      });
      postPrompt(t)
        .then((r) => {
          // 回合没发出去（409 等）就不会有 turn 事件，engineBusy 需复位供制作中屏推进
          if (!r.ok) {
            // 在途的玩家输入作废：这一回合没有开始，不许它在别的回合收尾时冒充「上一回合」
            set({ status: `出错：${r.error}`, engineBusy: false, turnStartAt: null, pendingTurnPrompt: null });
            // 挂起中的画廊重绘没有对应回合了：记为未确认，解除挂起让按钮恢复并接队列下一条
            ctx.finishRegen(false);
            markResyncFailed(r.error);
          }
        })
        .catch((e: unknown) => {
          set({ status: `出错：${String(e)}`, engineBusy: false, turnStartAt: null, pendingTurnPrompt: null });
          ctx.finishRegen(false);
          markResyncFailed(String(e));
        });
    },

    sendPlayerTurn(text) {
      const t = text.trim();
      if (!t) return;
      // 玩家叙事输入的唯一记录点：turn_end 成功时定格为 lastTurnPrompt（重掷的数据源）。
      // 指令类发送不经过这里——美术/规划/剧情/续档天然不进「上一回合输入」的账。
      set({ pendingTurnPrompt: t });
      get().send(t);
    },

    toggleDrawer() {
      set({ drawerOpen: !get().drawerOpen });
    },

    setTypingDone(done) {
      if (get().typingDone !== done) set({ typingDone: done });
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
