// 全局状态机：boot → title → protagonist → crafting → game；overlay 屏 assets（画廊）/creation（创作）从 game/title 进入、返回原屏。
// SSE 事件 → handleEvent（段过滤/标记/选项的处理迁移自 shell/index.html，行为对齐旧版）。
// crafting 屏由章节制作流水线驱动（v1.2）：开局指令（待命版）→ 规划（制作清单）→ 逐项美术指令 → 「开演。」；
// game 屏收到【章】标记后切回 crafting，规划下一章。
// v1.3：【立绘】表情切换事件驱动差分立绘、【新剧本】事件刷新轮播、画廊重绘回合与游戏态共用引擎。
// v1.5：世界线（title→worlds→protagonist/crafting→game，开局/续玩指令携带 worldId）、剧情图屏（tree overlay，剧情：编辑）、
//       清单缓存过滤抽成 parser 纯函数（assetNameMatches）。
// v1.5.1：美术资产随故事走——预载直服与表情切换 URL 走 presets/<剧本 id>/assets/，清单与 /img 请求都带 preset。
// v1.6：音频演出（【曲】/【环境】/【音效】协议行 → AudioManager 单例）与设置屏（settings overlay，localStorage 持久化）、
//       逐轮快照的精确回退（restoreSnapshot：覆盖三文件后发续档指令，让引擎重新读档同步）与自动前进
//       （armAutoAdvance 倒计时 → 自动选第一项）。
//
// v1.6 工程债清理：本文件从单 `create()` 全闭包拆成 slice 组合，这里只做四件事（其余都在子模块）：
//   1. 初始 state（字段与顺序与拆分前逐字一致；动作由各 slice 追加，见下面的组装顺序）；
//   2. `isTypingTarget`（App/对话组件的键盘准入判定，无状态，就近留着，不为 6 行新开模块）；
//   3. 组装：`createStoreContext` 建一次共享上下文，再 `{...slice(ctx)}` 拼出整个 store；
//   4. 再导出：类型（./types）、立绘纯函数（./portrait）、世界线包校验（./slices/world）——
//      组件与测试的 `from "../store/game"` import 一行都不用改，公共 API 逐字不变。
// 拆分边界按原 v1.x 注释里的功能块走：nav/world/tree/assets/creation/crafting/gameplay（slices/*.ts）；
// 跨片共享的闭包与定时器单例集中在 context.ts（那里的文件头注释解释了为什么必须共享、时序为何不变）。
// 唯一可观测的差别：动作名在 Object.keys(state) 里的先后随 slice 组装顺序变化（字段集合与值完全相同，语义无关）。
import { create } from "zustand";
import { loadSettings } from "../lib/settings";
import { createStoreContext } from "./context";
import { createAssetsSlice } from "./slices/assets";
import { createCharactersSlice } from "./slices/characters";
import { createCraftingSlice } from "./slices/crafting";
import { createCreationSlice } from "./slices/creation";
import { createGameplaySlice } from "./slices/gameplay";
import { createNavSlice } from "./slices/nav";
import { createTreeSlice } from "./slices/tree";
import { createWorldSlice } from "./slices/world";
import type { GameStore } from "./types";

export type {
  Screen,
  PreloadItemState,
  PreloadItem,
  PortraitState,
  PreloadPhase,
  HistoryEntry,
  HistoryRollbackMark,
  HistoryItem,
  CreationMessage,
  Notice,
  RegenJob,
} from "./types";
export { fallbackPortraitUrl, nextPortraitOnExpression } from "./portrait";
export { MAX_STAGE, applyExpression, castMember, speakerOf } from "./portrait";
export { parseWorldBundle } from "./slices/world";
export { parsePresetBundle } from "./slices/nav";

/**
 * 键盘快捷键的准入条件之一：事件目标是否落在「正在打字」的输入控件里（数字键选选项 / 空格补全用）。
 * 与 App 的 Esc 链同一套判定：**滑杆（type=range）不算打字**——设置屏聚焦滑杆时快捷键照旧可用。
 * 纯函数（store 里已有其它为单测导出的纯逻辑，就近放这里，避免为 6 行判定新开一个模块）。
 * @param {EventTarget | null} el 事件目标
 * @returns {boolean} 是 input/textarea/contentEditable 时为 true
 */
export function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  if (node.isContentEditable) return true;
  if (node.tagName === "TEXTAREA") return true;
  return node.tagName === "INPUT" && (node as HTMLInputElement).type !== "range";
}

export const useGameStore = create<GameStore>()((set, get) => {
  // 共享上下文（跨片流水线 + 定时器单例）：只建一次，slice 只通过它调用——
  // 拆分前这些函数就是同一个闭包域里的内部函数，换到这里后调用顺序与时序逐字不变。
  const ctx = createStoreContext(set, get);

  return {
    // —— 初始 state（拆分前是同一个对象字面量；切片动作在下面按 slice 组装追加）——
    screen: "boot",
    screenReturn: null,
    selected: null,
    presets: [],
    titleNotice: null,
    cardAnswers: {},
    status: "连接引擎…",
    turnKey: 0,
    received: "",
    finalText: "",
    options: null,
    typingDone: false,
    bgUrl: null,
    portraits: [],
    artReady: {},
    preload: [],
    preloadPhase: "finished",
    preloadBatchStartedAt: null,
    chapterNo: 1,
    skipRequested: false,
    engineBusy: false,
    history: [],
    drawerOpen: false,
    charactersOpen: false,
    stateView: null,
    creationMessages: [],
    assembling: false,
    assemblyStalled: false,
    creationCover: false,
    creationPortraits: [],
    creationResult: null,
    regenPending: null,
    assetsStamp: 0,
    assetsPreview: null,
    regenQueue: [],
    regenTotal: 0,
    regenDone: 0,
    regenFailed: [],
    regenNotice: null,
    assetsBusy: false,
    assetsNotice: null,
    pendingCreationMessage: null,
    creationExitPrompt: false,
    turnStartAt: null,
    worldId: null,
    worldLabel: "",
    worldBusy: false,
    worldNotice: null,
    treeStamp: 0,
    treeNotice: null,
    treeAsk: false,
    pendingTreeMessage: null,
    treeFocus: null,
    forkResult: null,
    pendingResync: null,
    resyncFailed: false,
    resyncing: false,
    pendingRerollPrompt: null,
    turnSnapshots: null,
    settings: loadSettings(),
    autoAdvanceDeadline: null,
    autoAdvanceMuted: false,
    segs: { 0: "" },
    curSeg: 0,
    seenMarkerKeys: new Set<string>(),
    turnNo: 0,
    awaitCommand: null,

    // —— 动作：按功能块分片（每片一个文件，接口文档见 types.ts 的 GameStore）——
    ...createNavSlice(ctx),
    ...createWorldSlice(ctx),
    ...createTreeSlice(ctx),
    ...createAssetsSlice(ctx),
    ...createCharactersSlice(ctx),
    ...createCreationSlice(ctx),
    ...createCraftingSlice(ctx),
    ...createGameplaySlice(ctx),
  };
});
