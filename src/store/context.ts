// store 的共享上下文（v1.6 slice 拆分的核心设计点）。
//
// 为什么要有这个模块：原 game.ts 里有一批**闭包函数**（applyMarkers/advancePreload/resetRunState/
// resetTurnState/finishRegen/onEngineError/pumpRegenQueue/armAutoAdvance…）被多个屏、多个 slice 共用，
// 且彼此递归（finishRegen ↔ pumpRegenQueue、onEngineError → runNextPending → sendStart）。
// 直接把它们塞进某个 slice 会让别的 slice 反向依赖那个 slice（并形成运行时循环 import），
// 于是统一在这里按「工厂函数 + 显式暴露」落地：`createStoreContext(set, get)` 在 store 创建时**只调用一次**，
// 函数体逐字照搬原实现，调用顺序与时序完全不变（没有事件总线、没有延迟绑定、没有重设计）。
//
// 约定：
// - slice 只拿 ctx.set/ctx.get 与下面这些共享函数，不许自己复制一份流水线逻辑；
// - 定时器单例（watchdogTimer / autoAdvanceTimer）与清理函数留在模块级——store 是应用级单例，与原先一致；
// - 依赖 store 动作时一律 `get().动作()`（原实现就是这么写的），所以 ctx 不需要持有 send/startGame 等动作。

import type { StoreApi } from "zustand";
import {
  BUILD_START,
  assetNameMatches,
  buildArtCommand,
  buildPlanCommand,
  buildRegenCommand,
  parseManifest,
  splitAssetVariant,
  type ArtKind,
  type Marker,
} from "../lib/parser";
import { fetchAssets, fetchHistory, imageUrl, assetFileUrl, assetPath, type Preset } from "../lib/acp";
import { normName } from "./portrait";
import type { GameStore, PortraitState, Screen } from "./types";

/** store 的 setState 类型（slice 里与原来逐字一致地调用 `set({...})`） */
export type StoreSet = StoreApi<GameStore>["setState"];
/** store 的 getState 类型 */
export type StoreGet = StoreApi<GameStore>["getState"];

/** 清单项 → 分项美术指令的种类字面 */
const ART_KIND: Record<"portrait" | "background", ArtKind> = { portrait: "立绘", background: "背景" };

/** marker.kind → 协议字面（regen 匹配 key 用） */
const KIND_CN: Record<Marker["kind"], ArtKind> = { portrait: "立绘", background: "背景", cover: "封面" };

/** 单项美术生成的前端看门狗：需覆盖 server /prompt 的 600s 超时（SSE 断线丢事件时兜底） */
const WATCHDOG_MS = 610_000;

/**
 * 【图】标记 URL 的当前剧本 id（/img 的 &preset=：直服与流式落盘都据此定位目录）。
 * 创作屏里正在装配的新剧本 id 只由【新剧本】事件揭示，揭示前留空——
 * 宁可不落盘（服务端会 warn），也不能把新剧本的美术写进正在玩的剧本目录。
 *
 * 装配期 URL 语义（与服务端契约对齐，改这里前先看 server persistAsset 的剧本 id 来源）：
 * 【新剧本】到达前客户端不知道新剧本 id，所以标记 URL 不带 preset；
 * 到达后由**服务端**按【新剧本】id 补落盘（图片先以会话路径存着，谁先知道剧本 id 谁负责归档）。
 * 客户端**不重写已发出的历史 URL**——补落盘是服务端职责，别在这里「顺手把旧 URL 修一下」。
 */
function markerPresetId(screen: Screen, selected: Preset | null, creationResult: string | null): string {
  if (screen === "creation") return creationResult ?? "";
  return selected?.id ?? "";
}

// 看门狗定时器（store 为应用级单例，模块变量即可）
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

// 自动前进倒计时（同上：单例 store 用模块变量；每次重置/取消都必须清，否则旧回合的定时器会替新回合做决定）
let autoAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
// 本轮倒计时为「引擎忙」已经重试掉的毫秒数（见 fireAutoAdvance）：与 autoAdvanceTimer 同一生命周期，
// 一起被 clearAutoAdvanceTimer 归零（新回合/新倒计时都重新有整份预算）
let autoAdvanceRetryMs = 0;

/** 自动前进撞上「引擎忙」后的重试间隔（ms） */
const AUTO_ADVANCE_RETRY_MS = 250;
/** 重试总预算（ms）：累计到点仍忙才作废，避免引擎真的卡住时无限重试 */
const AUTO_ADVANCE_RETRY_BUDGET_MS = 2000;

function clearAutoAdvanceTimer() {
  autoAdvanceRetryMs = 0;
  if (autoAdvanceTimer) {
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }
}

/** slice 可用的共享上下文：set/get + 跨片流水线函数 + 两个定时器的清理入口 */
export interface StoreContext {
  set: StoreSet;
  get: StoreGet;
  /** 清看门狗（切屏/进屏/回合收尾都要求「无在途超时」） */
  clearWatchdog(): void;
  /** 起看门狗（发指令前；超时走 onEngineError） */
  armWatchdog(): void;
  /** 清自动前进倒计时（换本/发指令/取消时） */
  clearAutoAdvanceTimer(): void;
  finishRegen(ok?: boolean): void;
  pumpRegenQueue(): void;
  applyMarkers(markers: Marker[], dedupe: boolean): void;
  resetTurnState(turnKey: number): void;
  resetRunState(patch: Partial<GameStore>): void;
  /** 补齐「当前世界已有多少条 turn 快照」的已知值（重掷按钮的可见性判据）：拉一次 /api/history，
   *  仅在 worldId 未变时落库；失败静默（保持 null=未知，按钮退回「展示 + 点击时判定」的兜底路径） */
  refreshTurnSnapshots(): void;
  /** 发「开演。」（跳过剩余项/无清单回退都用它；幂等） */
  sendStart(): void;
  /** 取下一个 pending 项开跑；没有则收尾发「开演。」 */
  runNextPending(): void;
  /** 发某一章的规划指令并进入 planning（章标记切屏后由 handleEvent 调） */
  beginPlanning(n: number): void;
  advancePreload(): Promise<void>;
  onEngineError(message: string): void;
  armAutoAdvance(): void;
  resumeAutoAdvance(): void;
  cancelAutoAdvance(): void;
}

/**
 * 建一次上下文（在 useGameStore 的 create 回调里调用）。
 * 内部的函数声明彼此引用（含相互递归），所以放在工厂作用域内、以函数声明形式定义。
 */
export function createStoreContext(set: StoreSet, get: StoreGet): StoreContext {
  /**
   * 一条重绘收尾：解除挂起、刷新画廊清单，并推进顺序队列（批量重绘）。
   * @param {boolean} ok 是否在回合里收到了匹配的 `|重绘` 标记；false=未确认
   *   （引擎没回标记/回合报错/指令没发出去），记进 regenFailed，收尾提示里点名。
   */
  function finishRegen(ok = true) {
    const s = get();
    if (!s.regenPending) return; // 没有在跑的重绘（标记已解除或本来空闲）：幂等
    set({
      regenPending: null,
      assetsStamp: s.assetsStamp + 1,
      regenDone: s.regenDone + 1,
      regenFailed: ok ? s.regenFailed : [...s.regenFailed, s.regenPending],
    });
    pumpRegenQueue();
  }

  /**
   * 顺序重绘队列的派发器：空闲时取队首开跑；队列跑空则收尾本批并落提示。
   * 三个「等一等」的条件都有原因：引擎忙（抢发必 409）、已有在跑的重绘（流水线是单条）、
   * 创作/图屏还有排队指令（让它们先发，否则它们会撞上刚派出的重绘回合）。
   */
  function pumpRegenQueue() {
    const s = get();
    if (s.regenPending) return;
    if (s.engineBusy) return;
    if (s.pendingCreationMessage || s.pendingTreeMessage) return;
    const [next, ...rest] = s.regenQueue;
    if (!next) {
      // 队列空 = 本批收尾：把「换了几张 / 哪几项没确认」一次讲清（没有批次就什么都不做）
      if (s.regenTotal === 0) return;
      const unconfirmed = s.regenFailed.length;
      set({
        regenTotal: 0,
        regenDone: 0,
        regenFailed: [],
        regenNotice:
          unconfirmed > 0
            ? {
                kind: "error",
                text: `重绘结束：${s.regenDone - unconfirmed}/${s.regenTotal} 项换图，${unconfirmed} 项未确认（${s.regenFailed.join("、")}）`,
              }
            : { kind: "ok", text: `重绘完成：${s.regenDone} 项已换图` },
      });
      return;
    }
    set({ regenQueue: rest, regenPending: `${next.type}|${next.matchName}` });
    get().send(buildRegenCommand(next.type, next.key));
  }

  /**
   * 应用【图】标记到背景/立绘/预载槽位。
   * @param markers 标记列表
   * @param dedupe 流式期间按整行 key 去重（同一段 chunk 会重复扫描）；turn_end 全量重放（回到旧背景的场景）
   */
  function applyMarkers(markers: Marker[], dedupe: boolean) {
    const s = get();
    const seen = new Set(s.seenMarkerKeys);
    const artReady = { ...s.artReady };
    // 当前剧本：/img 的 &preset=（直服与流式落盘都要它定位 presets/<id>/assets/）
    const preset = markerPresetId(s.screen, s.selected, s.creationResult);
    // 槽位名（来自 preset，可能带「」）与引擎标记名（常不带）做归一化对齐
    const norm = normName;
    const slotByNorm = new Map(Object.keys(artReady).map((k) => [norm(k), k]));
    const patch: { bgUrl?: string; portrait?: PortraitState } = {};
    let changed = false;
    for (const m of markers) {
      // 重绘覆盖标记：命中挂起中的画廊重绘即解除（放在去重之前——重复出现的重绘标记也要触发刷新）
      if (m.regen && get().regenPending === `${KIND_CN[m.kind]}|${m.name}`) finishRegen();
      const key = `${m.kind}|${m.name}|${m.path}`;
      if (dedupe && seen.has(key)) continue;
      seen.add(key);
      changed = true;
      // 标记里的 p 可能是会话路径（新生成）或 presets/<id>/assets/…（缓存命中），原样透传给服务端解析
      const url = m.kind === "cover" ? assetFileUrl(m.path) : imageUrl(m.path, m.kind, m.name, preset);
      if (m.kind === "background") {
        patch.bgUrl = url;
        // 背景槽位名 = 清单地点名（旧开场场景槽已随 v1.2 清单化移除）
        const slotKey = m.name in artReady ? m.name : slotByNorm.get(norm(m.name));
        if (slotKey) artReady[slotKey] = url;
      } else if (m.kind === "cover") {
        // 封面不是演出画面：只点亮创作屏的装配清单（server 会把它落盘到 presets/<id>/cover.jpg）
        if (get().screen === "creation") set({ creationCover: true });
      } else {
        const slotKey = m.name in artReady ? m.name : slotByNorm.get(norm(m.name));
        if (slotKey) artReady[slotKey] = url;
        // 差分立绘（清单里的 薇拉-微笑 类槽位）只填槽位，不替换主立绘
        const isVariantSlot = s.preload.some(
          (i) => i.kind === "portrait" && i.variant && (i.name === m.name || norm(i.name) === norm(m.name)),
        );
        if (!isVariantSlot) patch.portrait = { name: m.name, variant: "", url, baseUrl: url };
        // 装配阶段的基础立绘标记：点亮创作屏清单（去重）
        if (get().screen === "creation" && !get().creationPortraits.includes(m.name)) {
          set({ creationPortraits: [...get().creationPortraits, m.name] });
        }
      }
    }
    if (!changed) return;
    set({ ...patch, artReady, seenMarkerKeys: seen });
  }

  /** 清空当前回合显示状态（turn_start 与段切换共用；旁白段被新段覆盖） */
  function resetTurnState(turnKey: number) {
    // 新回合 = 自动前进重新计时（上一回合的交互取消不跨回合）
    clearAutoAdvanceTimer();
    set({
      received: "",
      finalText: "",
      options: null,
      typingDone: false,
      turnKey,
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
  }

  /**
   * 倒计时到点：自动选第一项。
   * 已被取消 / 选项没了 / 已离屏 = 真作废（清 deadline）；**引擎忙不是作废**——
   * 到点那一刻引擎可能正在收尾（turn_end 还没落 engineBusy=false），此时抢发必 409，
   * 玩家看到的就是「偶发不自动前进」。所以忙起来短延迟重试（{@link AUTO_ADVANCE_RETRY_MS}），
   * 累计超过预算（{@link AUTO_ADVANCE_RETRY_BUDGET_MS}）仍忙才放弃。
   * 重试期间 deadline 保持非空（选项上的倒计时标记继续显示「自动前进 · 0s」），
   * 用户交互取消的语义不变：cancelAutoAdvance 一处清定时器 + deadline + 置 muted。
   */
  function fireAutoAdvance() {
    autoAdvanceTimer = null;
    const s = get();
    if (s.autoAdvanceDeadline === null) return; // 已被用户交互取消（cancelAutoAdvance 会清定时器，这里再兜一层）
    const first = s.options?.[0];
    if (!first || s.screen !== "game") {
      set({ autoAdvanceDeadline: null });
      return;
    }
    if (s.engineBusy) {
      if (autoAdvanceRetryMs >= AUTO_ADVANCE_RETRY_BUDGET_MS) {
        set({ autoAdvanceDeadline: null }); // 预算用尽：认了（引擎真卡住时不该无限等）
        return;
      }
      autoAdvanceRetryMs += AUTO_ADVANCE_RETRY_MS;
      autoAdvanceTimer = setTimeout(fireAutoAdvance, AUTO_ADVANCE_RETRY_MS);
      return;
    }
    set({ autoAdvanceDeadline: null });
    // 走玩家入口（同手点选项）：自动选中的这回合同样是「玩家叙事输入」，要进 lastTurnPrompt 的账
    get().sendPlayerTurn(first.t);
  }

  function armWatchdog() {
    clearWatchdog();
    watchdogTimer = setTimeout(() => onEngineError("等待引擎响应超时"), WATCHDOG_MS);
  }

  /** 发送「开演。」并进入 starting 阶段（幂等：已 starting 不重发；同时清掉待命/规划的跳过请求） */
  function sendStart() {
    if (get().preloadPhase === "starting") return;
    set({ preloadPhase: "starting", skipRequested: false });
    armWatchdog();
    get().send(BUILD_START);
  }

  /** 取下一个 pending 项开跑；没有则收尾发「开演。」 */
  function runNextPending() {
    const s = get();
    const next = s.preload.find((i) => i.state === "pending");
    if (!next) {
      sendStart();
      return;
    }
    set({
      preload: s.preload.map((i) =>
        i === next ? { ...i, state: "running" } : i.state === "running" ? { ...i, state: "done" } : i,
      ),
    });
    armWatchdog();
    get().send(next.command);
  }

  /** 发某一章的规划指令并进入 planning（send 会覆盖 status，故在其后再写文案） */
  function beginPlanning(n: number) {
    set({ preloadPhase: "planning" });
    armWatchdog();
    get().send(buildPlanCommand(n));
    set({ status: "撰写章节大纲…" });
  }

  /**
   * 回合结束（turn_end）后的流水线推进。init=待命已确认，发规划指令；
   * planning=规划回合已回，解析制作清单→过滤已就绪→进入逐项队列；
   * queue=当前项完成取下一项；starting=开场正文已回，切 game。
   */
  async function advancePreload() {
    const s = get();
    if (s.screen !== "crafting") return;
    if (s.preloadPhase === "init") {
      if (s.skipRequested) {
        sendStart();
        return;
      }
      beginPlanning(get().chapterNo);
    } else if (s.preloadPhase === "planning") {
      if (s.skipRequested) {
        sendStart();
        return;
      }
      // 该回合全文 = 各段拼接（规划回合先写树文件再输出清单行，清单可能在非当前段）
      const manifest = parseManifest(Object.values(s.segs).join("\n"));
      if (manifest.length === 0) {
        // 引擎异常没给清单：视作失败项，直接开演（引擎按旧语义回退 opening），不卡死
        sendStart();
        return;
      }
      // 同步落队列与槽位再异步清点（期间玩家可跳过，跳过后这里直接返回）
      set({
        preloadPhase: "queue",
        status: "清点既有美术…",
        preload: manifest.map((m) => {
          // 差分清单项（薇拉-微笑）拆出角色名与变体：指令/槽位用原名，槽位显示「薇拉 · 微笑」
          const { base, variant } = m.kind === "portrait" ? splitAssetVariant(m.name) : { base: m.name, variant: "" };
          return {
            kind: m.kind,
            name: m.name,
            variant,
            label: variant ? `${base} · ${variant}` : m.name,
            command: buildArtCommand(ART_KIND[m.kind], m.name),
            state: "pending" as const,
            url: null,
          };
        }),
        artReady: Object.fromEntries(manifest.map((m) => [m.name, ""])),
      });
      let assets: Awaited<ReturnType<typeof fetchAssets>> = [];
      // 只清点当前剧本的资产（v1.5.1 资产随故事走；服务端缺 preset 即 400）
      const presetId = s.selected?.id ?? "";
      try {
        assets = await fetchAssets(presetId);
      } catch {
        // 清点失败 = 全量重做，不阻塞流程
      }
      const st = get();
      if (st.screen !== "crafting" || st.preloadPhase !== "queue") return; // 期间已跳过/推进
      // 预过滤兜底（引擎侧规划已做缓存感知，正常应近空）：名字归一化匹配（trim / 互为包含，
      // 纯函数在 parser.assetNameMatches 并有单测），立绘与背景一视同仁——命中的按落盘文件直服跳过生成
      set({
        preload: st.preload.map((i) => {
          if (i.state !== "pending") return i;
          const typeCn = i.kind === "portrait" ? "立绘" : "背景";
          // 差分项先拆出基础名（清单项 薇拉-微笑 → 薇拉）；背景名可能含连字符，不拆
          const base = i.variant ? splitAssetVariant(i.name).base : i.name;
          const hit = assets.some((a) => {
            if (a.type !== typeCn || !a.ready) return false;
            return assetNameMatches({ name: a.name, variant: a.variant }, { name: base, variant: i.variant });
          });
          // 已就绪项按落盘文件直服（差分同契约：presets/<id>/assets/立绘-薇拉-微笑.jpg）。
          // 路径与 sanitize 都交给 acp.assetPath——落盘名由服务端 sanitize，前端只有这一处实现
          const path = assetPath(typeCn, i.name, presetId);
          return hit && path
            ? { ...i, state: "done" as const, url: assetFileUrl(path) }
            : i;
        }),
      });
      runNextPending();
    } else if (s.preloadPhase === "queue") {
      set({ preload: get().preload.map((i) => (i.state === "running" ? { ...i, state: "done" } : i)) });
      runNextPending();
    } else if (s.preloadPhase === "starting") {
      clearWatchdog();
      set({ preloadPhase: "finished", screen: "game" });
    }
  }

  /** 引擎报错/超时：制作中屏按阶段降级，不阻塞整体 */
  function onEngineError(message: string) {
    // 回合没跑完：在途的玩家输入作废（没成功的回合不许在之后的收尾里定格成「上一回合」）
    set({ status: `出错：${message}`, engineBusy: false, turnStartAt: null, pendingTurnPrompt: null });
    clearWatchdog();
    finishRegen(false); // 挂起中的重绘回合没了：未确认记账，解除挂起让按钮恢复并接队列下一条
    if (get().screen === "creation" && get().assembling) {
      // 装配回合超时/出错：可重试
      set({ assembling: false, assemblyStalled: true });
    }
    const s = get();
    if (s.screen !== "crafting") return;
    if (s.preloadPhase === "queue") {
      set({ preload: s.preload.map((i) => (i.state === "running" ? { ...i, state: "failed" } : i)) });
      runNextPending();
    } else if (s.preloadPhase === "planning") {
      // 规划回合失败：同无清单回退，直接「开演。」（引擎回退 opening）
      sendStart();
    } else if (s.preloadPhase === "init") {
      // 待命回合失败：留在本屏（队列未建）等玩家跳过
    } else if (s.preloadPhase === "starting") {
      // 「开演。」回合失败：退回 queue 态，重新暴露「跳过剩余，立即开演」按钮（点击即重发）
      set({ preloadPhase: "queue" });
    }
  }

  /**
   * 一次游玩的运行态清零（选剧本 / 新世界 / 续玩共用）：清显示与簿记字段，不动 selected/presets；
   * 调用方用 patch 覆盖本次要落定的字段（screen/worldId/chapterNo/engineBusy…）。
   */
  function resetRunState(patch: Partial<GameStore>) {
    clearAutoAdvanceTimer();
    set({
      cardAnswers: {},
      bgUrl: null,
      portrait: null,
      history: [],
      artReady: {},
      preload: [],
      preloadPhase: "finished",
      chapterNo: 1,
      skipRequested: false,
      segs: { 0: "" },
      curSeg: 0,
      received: "",
      finalText: "",
      options: null,
      typingDone: false,
      seenMarkerKeys: new Set<string>(),
      turnNo: 0,
      awaitCommand: null,
      engineBusy: false,
      turnStartAt: null,
      treeAsk: false,
      pendingTreeMessage: null,
      // 重同步是会话内状态：换世界/换本时旧世界的「待重同步」徽章没有意义，一并清掉
      pendingResync: null,
      resyncFailed: false,
      resyncing: false,
      // 重掷的三个记账同理会话内不跨玩法：换世界后「上一回合输入」与排队重发都属于旧世界
      lastTurnPrompt: null,
      pendingTurnPrompt: null,
      pendingRerollPrompt: null,
      // 快照数同理不跨玩法：新世界从「未知」开始（建新世界由调用方置 0，入场时按需补拉）
      turnSnapshots: null,
      // 自动前进不跨玩法：换本/开新局时把倒计时清掉
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
      // 批次类状态不跨玩法：换本/开新局时把队列与提示清空（提示条不该从上一部剧本飘过来）
      regenQueue: [],
      regenTotal: 0,
      regenDone: 0,
      regenFailed: [],
      regenNotice: null,
      assetsNotice: null,
      assetsBusy: false,
      worldNotice: null,
      worldBusy: false,
      // 角色面板视图属于当前世界：换世界/换本/新开局不把旧世界的角色卡带过来
      charactersOpen: false,
      stateView: null,
      turnKey: get().turnKey + 1,
      ...patch,
    });
  }

  /**
   * 刷新「当前世界有多少条 turn 快照」（重掷按钮的可见性判据）：只有服务端知道磁盘上的快照数，
   * 客户端按需补拉一次 /api/history（服务端有列表缓存，代价小）。await 期间换世界/重开就丢弃结果。
   * 补拉失败**回落为未知（null）**：已知 0/1 的世界若一直拉不到，按钮会永久藏住一个可能可用的功能——
   * 回落未知后按钮照常展示，点击时由 rerollTurn 的 fetch 再判定；后续回合收尾还会继续重试补拉。
   */
  function refreshTurnSnapshots() {
    const worldId = get().worldId;
    if (!worldId) return;
    fetchHistory(worldId)
      .then((h) => {
        if (get().worldId !== worldId) return; // 期间换世界：旧世界的账本不许写进新世界
        set({ turnSnapshots: h.snapshots.filter((s) => s.kind === "turn").length });
      })
      .catch(() => {
        if (get().worldId !== worldId) return;
        if (get().turnSnapshots !== null) set({ turnSnapshots: null }); // 已知 → 未知：不藏功能
      });
  }

  /** 启动自动前进倒计时（动作在 gameplay slice 暴露；此处与 fireAutoAdvance 同处一个闭包域便于管定时器） */
  function armAutoAdvance() {
    const s = get();
    if (s.autoAdvanceDeadline !== null) return; // 已在倒计时：幂等（选项组件重渲染不该重置计时）
    if (s.settings.autoAdvance <= 0) return; // 设置里关着
    if (s.autoAdvanceMuted) return; // 本回合已被用户交互取消
    if (s.screen !== "game" || s.engineBusy) return; // 只在游戏屏、且引擎空着
    if (s.pendingCreationMessage || s.pendingTreeMessage) return; // 有排队指令：先让它们走
    const options = s.options;
    if (!s.typingDone || !options || options.length === 0) return; // 打字未完/没有选项
    const ms = s.settings.autoAdvance;
    clearAutoAdvanceTimer();
    autoAdvanceTimer = setTimeout(fireAutoAdvance, ms);
    set({ autoAdvanceDeadline: Date.now() + ms });
  }

  /**
   * 玩家在面板上显式打开自动前进：先解掉本回合的「交互即取消」标记，再立刻尝试武装。
   * 与 armAutoAdvance 的分工：那个是引擎回合收尾时的自动尝试（必须尊重 muted），
   * 这个只由玩家的明确动作触发——点「自动」本身就是「请替我继续」，与 muted 的「别自作主张」不冲突。
   */
  function resumeAutoAdvance() {
    set({ autoAdvanceMuted: false });
    armAutoAdvance();
  }

  /** 取消本次自动前进（动作在 gameplay slice 暴露） */
  function cancelAutoAdvance() {
    const s = get();
    if (s.autoAdvanceDeadline === null && s.autoAdvanceMuted) return; // 已经取消过：不制造无谓的状态更新
    clearAutoAdvanceTimer();
    set({ autoAdvanceDeadline: null, autoAdvanceMuted: true });
  }

  return {
    set,
    get,
    clearWatchdog,
    armWatchdog,
    clearAutoAdvanceTimer,
    finishRegen,
    pumpRegenQueue,
    applyMarkers,
    resetTurnState,
    resetRunState,
    refreshTurnSnapshots,
    sendStart,
    runNextPending,
    beginPlanning,
    advancePreload,
    onEngineError,
    armAutoAdvance,
    resumeAutoAdvance,
    cancelAutoAdvance,
  };
}
