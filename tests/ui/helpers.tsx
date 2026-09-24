// UI 组件测试的共享基底（拆自 tests/ui.test.tsx）。拆文件之前，每个 describe 各写一份 store 复位，
// 谁漏了字段就跨组串味（原文件头部自己也警告过这件事）。这里把三样东西收成一处：
//
//   1. setupUi()：每个 UI 测试文件在顶层调一次，注册收尾钩子——cleanup() + useRealTimers() +
//      unstubAllGlobals() + resetStore()。它把单例 store 复位到「一份全新的 create() 初始态」，
//      于是任何一组都不必再手抄那一大串 setState；哪一组要额外的初始值，就在自己的 beforeEach 里
//      **显式叠加**（不要反过来再撒一遍完整复位）。resetStore() 顺带走 store 的显式收尾出口
//      disposeStore()——旧实例的看门狗/自动前进倒计时不收掉会替下一条用例做决定。
//   2. 组间共享的 fixture 与 DOM 小工具（PRESET / jsonResponse / 菜单触发器 / 焦点探针 / viewBox 解析…）。
//   3. 基线里方言的字段集合 = 原先所有 beforeEach/afterEach 复位字段的**并集**：并集之外必然有人在靠泄漏
//      （拆出来那一轮就是靠它把「某组复位得比它依赖的少」照出来的）。
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/lib/settings";
import { disposeStore, useGameStore } from "../../src/store/game";
import type { GameStore } from "../../src/store/types";
import type { Preset } from "../../src/lib/acp";

/** ui 测试用的最小剧本 fixture（与世界线屏/顶栏的展示字段对齐） */
export const PRESET: Preset = {
  id: "campus-summer",
  title: "盛夏偏差值",
  tagline: "补习学校的重考之年",
  genre: "现代校园 / 恋爱",
  rating: "全年龄",
  characters: [],
  protagonist_card: [],
};

/** 造一个「只有 ok/status/json」的最小 Response（component 测试只需要这三样） */
export function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/**
 * 打开世界线行的 ⋯ 菜单（v1.9 起是 Radix DropdownMenu 的触发器：**pointerdown** 就展开，
 * 与 WAI-ARIA 菜单按钮惯例一致——鼠标按下即开、随后那一下 click 不再切换）。
 * `fireEvent.click` 只派发 click，所以这里显式补 pointerdown；真实浏览器里点击天然带 pointerdown
 * （e2e 的 `page.click` 照旧），键盘路径走 Enter/Space/↓（触发器自己的 onKeyDown，见 e2e）。
 */
export function openRowMenu(worldId: string): void {
  fireEvent.pointerDown(screen.getByTestId(`world-menu-${worldId}`), { button: 0 });
}

/** 命令轨三个分组触发器的 testid（v1.12 菜单信息架构：游戏屏顶层只有 设置|回顾|图鉴|进度|帮助） */
export const RAIL_GROUPS = { 回顾: "rail-review", 图鉴: "rail-collection", 进度: "rail-progress" } as const;

/**
 * 打开命令轨的一个分组菜单（v1.12）：历史/前情/角色/画廊/剧情图/重演这一幕 这些叶子项默认**不在 DOM 里**
 * ——它们现在是二级菜单项，与行 ⋯ 菜单同款「打开才渲染」。与 openRowMenu 同一手法（Radix 触发器
 * **pointerdown** 就展开；键盘路径走 Enter/Space/↓，e2e 里另有用例）。
 * @param {"回顾"|"图鉴"|"进度"} group 分组名（RAIL_GROUPS 的键）
 * @returns {HTMLElement} 菜单内容节点（断言「菜单真的开了」用）
 */
export function openRailGroup(group: keyof typeof RAIL_GROUPS): HTMLElement {
  fireEvent.pointerDown(screen.getByTestId(RAIL_GROUPS[group]), { button: 0 });
  return screen.getByTestId(`${RAIL_GROUPS[group]}-menu`);
}

/**
 * 打开标题屏角落簇的「更多」菜单（v1.12）：导出当前卡 / 导入剧本 / 剧本体检 三项都在里面，
 * 默认不在 DOM；导入用的隐藏 file input 仍留在角落簇（不在菜单内），所以它照旧随时可查。
 */
export function openTitleMore(): HTMLElement {
  fireEvent.pointerDown(screen.getByTestId("title-more"), { button: 0 });
  return screen.getByTestId("title-more-menu");
}

/** 展开设置屏的「细分音量」披露（v1.12：曲/环境/音效三条滑杆默认不渲染，滑杆 testid 一个字没改） */
export function expandChannels(): void {
  fireEvent.click(screen.getByTestId("settings-channels-toggle"));
}

/**
 * 焦点归还用例的「触发器」探针：开层前拿着焦点的那个元素（现实里是命令轨上的「回想」/「角色」/「返回」按钮）。
 * 单独挂一个同形按钮而不是把整屏搬进用例——断言的是「焦点回到开层前的那个元素」，与它长什么样无关。
 * 用完自己 `remove()`：afterEach 的 cleanup 只管 RTL 容器，管不到这个手挂在 body 上的节点。
 */
export function focusProbe(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "焦点探针";
  document.body.appendChild(btn);
  btn.focus();
  return btn;
}

/**
 * 派发一次 Tab / Shift+Tab。jsdom 不实现 Tab 的默认行为，「谁搬焦点」完全由 src/lib/focusTrap 的
 * keydown 决定——所以这里断言的正是陷阱自己的回绕判定（不依赖真实浏览器的 Tab 顺序）。
 */
export function pressTab(shift = false): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey: shift });
}

/**
 * 假的语音识别（jsdom 没有 SpeechRecognition/webkitSpeechRecognition）：真流程的替身——
 * 用例拿到实例后手动派发 onresult/onend，断言的仍是 FreeInput 自己的反应（不是替身的行为）。
 * 只做「照着接口把事件递出去」这一件事；实例的收集留给用例自己的子类。
 */
export class FakeSpeechRecognition {
  lang = "";
  interimResults = false;
  continuous = false;
  /** start()/stop() 各被调了几次（聆听开关的断言用） */
  started = 0;
  stopped = 0;
  onresult: ((event: { results: unknown }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
  /** 转写一句（onresult：FreeInput 按 Array.from(results) 逐条拼） */
  emit(transcript: string) {
    this.onresult?.({ results: { length: 1, 0: { 0: { transcript } } } });
  }
  /** 识别结束（说完 / 被 stop 之后）：FreeInput 正是在这一刻自动发送 */
  end() {
    this.onend?.();
  }
}

/** viewBox 解析成 [x, y, w, h]（断言缩放比例用） */
export function box(attr: string | null): number[] {
  return (attr ?? "").split(" ").map(Number);
}

/**
 * 读画布 viewBox 的「会自证」入口（缩放用例专用）。
 *
 * 缩放用例的红有两种成因，外观一模一样（viewBox 看起来被复位回「适应」），事后只有字符串断言分不出来：
 *   ① 视图真被写回了 fit（组件把状态复位了）；
 *   ② 用例抓住的那颗 DOM 节点已经不在这棵树上了（画布重挂 → 旧节点游离、永远停在旧 viewBox）。
 * 本函数每次都**按 testid 重新查当前树上的那颗**，取它的 viewBox；同时断言先前抓住的节点还在文档里、
 * 且仍是同一颗元素——一旦是「过期节点」，断言消息把旧节点的值、当前节点的值、是不是同一颗一起打出来，
 * 下次红灯当场就能分清是「视图被复位」还是「抓的是旧节点」。
 *
 * @param {string} testId 画布 testid（tree-canvas / genealogy-canvas）
 * @param {Element} captured 用例先前抓住的那个节点（用来做身份/连通性对比）
 * @returns {string} 当前树上那颗节点的 viewBox（调用方再喂给 {@link box} 断言比例）
 */
export function readViewBox(testId: string, captured: Element): string {
  const live = screen.getByTestId(testId);
  const capturedVb = captured.getAttribute("viewBox");
  const liveVb = live.getAttribute("viewBox");
  const same = live === captured;
  expect(
    captured.isConnected && same,
    `画布节点已过期（「视图被复位」与「抓的是旧节点」是两回事）：` +
      `captured viewBox=${capturedVb ?? "-"} isConnected=${captured.isConnected} · ` +
      `live viewBox=${liveVb ?? "-"} same=${same}`,
  ).toBe(true);
  return liveVb ?? "";
}

/**
 * 一份全新的 store 初始态（字段与 src/store/game.ts 的 create() 初始 state 逐字对齐；引用型字段每次新建，
 * 免得复用了同一个对象/Set 又被后续改动带脏）。settings 走 DEFAULT_SETTINGS，不读 localStorage——
 * 本机存档是「本机偏好」，不该进单测的跨用例基线；要测持久化的组自己写/读 localStorage。
 */
function baseline(): Partial<GameStore> {
  return {
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
    deferredArt: [],
    artAsk: false,
    pendingPlayerPrompt: null,
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
    settings: { ...DEFAULT_SETTINGS },
    autoAdvanceDeadline: null,
    autoAdvanceMuted: false,
    segs: { 0: "" },
    curSeg: 0,
    seenMarkerKeys: new Set<string>(),
    turnNo: 0,
    awaitCommand: null,
  };
}

/** 把单例 store 收回初始态，并走 store 的显式收尾出口（定时器归零） */
export function resetStore(): void {
  disposeStore();
  useGameStore.setState(baseline());
}

/**
 * 每个 UI 测试文件顶层调一次。注册收尾钩子：卸载 RTL 容器、复位真实定时器、清掉 stubGlobal、
 * 再把单例 store 收回初始态。分成 afterEach 而非 beforeEach，是为了让「一组用例自己的 beforeEach」
 * 永远叠在干净基线之上（叠加顺序：setupUi 的收尾 → 本文件 describe 的 beforeEach）。
 */
export function setupUi(): void {
  // beforeEach 也收一次：文件第一条用例启动时 store 可能还带着模块加载期或上一个文件末尾的残留，
  // 收一下保证每条用例都从同一份基线出发（幂等）。
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetStore();
  });
}
