// @vitest-environment jsdom
// 组件层测试（v1.4 起）：store 单例 + @testing-library/react 渲染，覆盖 UI 契约——
// TopBar 章号/耗时/世界线、CreationScreen 选项 chip 化与排队提示、AssetsScreen 分组/预览/跨剧本过滤；
// v1.5 新增 WorldsScreen（世界线列表/继续/新建/删除）与 StoryTreeScreen（树图/详情/编辑/分叉）；
// v1.6 新增 SettingsScreen（设置项/持久化/齿轮入口）与 AudioManager（索引/交叉淡入/静默降级）、
//      世界线屏改名/导出/导入（含 listbox 语义）与画廊选择模式/批量重绘队列/批量删除/预览模态；
// v1.6 第二段：剧情图快照标注/原地回退/分叉带 seq、>40 节点列表降级与缩放平移、节点 roving tabIndex、
//      游戏键盘（数字键选选项 / 空格补全 / 自动前进倒计时标记）与 App 的状态播报区（aria-live）。
// v1.7 新增主题深化：preset 声明字体族（--font-preset 系统字体栈）与对话框质感（dialog-* 类映射）。
// v1.7 续：重掷本回合（reroll）——次新 turn 快照 restore、reason:"reroll" 分割线、重同步收尾后排队重发同一玩家输入。
// v1.8 续：捏人屏主角卡摘要与两处开演入口（制作美术 / 跳过美术）、制作中屏美术槽位与剧情图入口、
//      FreeInput 的发送与语音、世界线屏「继续上次」卡 / 键盘卡 / 加载失败重试 / 改名取消、ShellPage 页框与标题屏字标。
// v1.9 续：四处浮层的背景收口（ROADMAP §3 最后一面）——抽屉打开时 GameStage 的舞台层整体 inert、
//      画廊预览打开时整页框 inert + 壳层根滚动锁、创作返回确认打开时创作整列 inert + 对话流滚动锁
//      （断言都落在既有的 a11y 块里：inert 的边界、焦点仍在层内、关闭即摘干净）。
// v1.10 续：启动链三条读接口（/api/auth、/api/presets、/api/worlds）的显式超时与卸载取消——
//      上限覆盖到 body 解析（先回响应头、再挂 body 的代理不再「永远转圈」），卸载优先于超时归一
//      （传输层不理 signal 时也不再往已拆的屏写错误态），启动屏补上 AbortController。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TopBar from "../src/components/game/TopBar";
import ChapterCard, { CHAPTER_CARD_FADE_MS, CHAPTER_CARD_MS } from "../src/components/game/ChapterCard";
import CharactersDrawer from "../src/components/game/CharactersDrawer";
import DialogueBox from "../src/components/game/DialogueBox";
import FreeInput from "../src/components/game/FreeInput";
import GameStage from "../src/components/game/GameStage";
import HistoryDrawer from "../src/components/game/HistoryDrawer";
import OptionList from "../src/components/game/OptionList";
import BootScreen from "../src/components/BootScreen";
import TitleScreen from "../src/components/TitleScreen";
import CreationScreen from "../src/components/CreationScreen";
import AssetsScreen from "../src/components/AssetsScreen";
import WorldsScreen, { relativeTime, worldDisplayName } from "../src/components/WorldsScreen";
import StoryTreeScreen, { earliestSnapshotByNode, prevSnapshotSeq, snapshotTurnNo } from "../src/components/StoryTreeScreen";
import SettingsScreen from "../src/components/SettingsScreen";
import PresetCheckScreen from "../src/components/PresetCheckScreen";
import App, { StatusAnnouncer } from "../src/App";
import { useGameStore, type PreloadItem } from "../src/store/game";
import { FADE_MS, MAX_SFX, SFX_TIMEOUT_MS, audioManager } from "../src/lib/audio";
import { focusableElements } from "../src/lib/focusTrap";
import { AUTO_ADVANCE_OPTIONS, DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, TEXT_SPEED_MS, loadSettings } from "../src/lib/settings";
import { isLegacyForkNote } from "../src/lib/worlds";
import { playerStatus } from "../src/lib/status";
import { TREE_ZOOM_MAX, clampZoom, fitView, panView, viewBoxOf, zoomViewAt } from "../src/lib/treeLayout";
import { layoutGenealogy } from "../src/lib/genealogy";
import { FONT_STACKS, dialogClass, getTheme, themeVars } from "../src/theme";
import { BOOT_FETCH_TIMEOUT_MS, fetchPresets, type AssetEntry, type AudioItem, type Preset, type PresetCheckResult, type StateView, type WorldEntry, type WorldSnapshotMeta } from "../src/lib/acp";

/** ui 测试用的最小剧本 fixture（与世界线屏/顶栏的展示字段对齐） */
const PRESET: Preset = {
  id: "campus-summer",
  title: "盛夏偏差值",
  tagline: "补习学校的重考之年",
  genre: "现代校园 / 恋爱",
  rating: "全年龄",
  characters: [],
  protagonist_card: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/**
 * 打开世界线行的 ⋯ 菜单（v1.9 起是 Radix DropdownMenu 的触发器：**pointerdown** 就展开，
 * 与 WAI-ARIA 菜单按钮惯例一致——鼠标按下即开、随后那一下 click 不再切换）。
 * `fireEvent.click` 只派发 click，所以这里显式补 pointerdown；真实浏览器里点击天然带 pointerdown
 * （e2e 的 `page.click` 照旧），键盘路径走 Enter/Space/↓（触发器自己的 onKeyDown，见 e2e）。
 */
function openRowMenu(worldId: string): void {
  fireEvent.pointerDown(screen.getByTestId(`world-menu-${worldId}`), { button: 0 });
}

/**
 * 焦点归还用例的「触发器」探针：开层前拿着焦点的那个元素（现实里是命令轨上的「回想」/「角色」/「返回」按钮）。
 * 单独挂一个同形按钮而不是把整屏搬进用例——断言的是「焦点回到开层前的那个元素」，与它长什么样无关。
 * 用完自己 `remove()`：afterEach 的 cleanup 只管 RTL 容器，管不到这个手挂在 body 上的节点。
 */
function focusProbe(): HTMLButtonElement {
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
function pressTab(shift = false): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey: shift });
}

/**
 * 假的语音识别（jsdom 没有 SpeechRecognition/webkitSpeechRecognition）：真流程的替身——
 * 用例拿到实例后手动派发 onresult/onend，断言的仍是 FreeInput 自己的反应（不是替身的行为）。
 * 只做「照着接口把事件递出去」这一件事；实例的收集留给用例自己的子类。
 */
class FakeSpeechRecognition {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useGameStore.getState().toTitle();
});

describe("TopBar：章节指示与回合耗时", () => {
  beforeEach(() => {
    useGameStore.setState({ chapterNo: 3, status: "引擎演绎中…", turnStartAt: Date.now(), worldLabel: "" });
  });

  it("busy 时状态簇现身并拼已耗时秒数；章号已移出顶栏（只在章节卡与回想抽屉里）", () => {
    render(<TopBar />);
    // 状态走 playerStatus 的玩家口吻（store 里的原字符串一个字不动）
    expect(screen.getByTestId("status").textContent).toMatch(/^故事展开中… \d+s$/);
    expect(screen.queryByText("第 3 章")).toBeNull();
  });

  it("就绪时不拼耗时（turnStartAt=null）", () => {
    useGameStore.setState({ status: "就绪", turnStartAt: null });
    render(<TopBar />);
    expect(screen.getByTestId("status").textContent).toBe("就绪");
  });

  it("有玩家起的显示名时显示世界名；worldId 兜底、旧版分叉备注与空 label 都不渲染", () => {
    useGameStore.setState({ status: "就绪", turnStartAt: null, worldId: "campus-summer-1", worldLabel: "雨夜的岔口" });
    render(<TopBar />);
    expect(screen.getByTestId("world-label").textContent).toBe("雨夜的岔口");

    // 无显示名时 store 现在落空串（见 slices/world.ts），但显示层这一道仍要自己兜：手改的 store 状态、
    // 老会话残留都可能让 worldLabel 等于裸 worldId——一条 slug 对玩家零信息量，不渲染
    cleanup();
    useGameStore.setState({ worldLabel: "campus-summer-1" });
    render(<TopBar />);
    expect(screen.queryByTestId("world-label")).toBeNull();

    // 旧版 server 自动写的分叉备注同为裸 id 串（isLegacyForkNote）：顶栏只留玩家自己起的名字
    cleanup();
    useGameStore.setState({ worldLabel: "分叉自 campus-summer-1 @ 2-2" });
    render(<TopBar />);
    expect(screen.queryByTestId("world-label")).toBeNull();

    cleanup();
    useGameStore.setState({ worldLabel: "" });
    render(<TopBar />);
    expect(screen.queryByTestId("world-label")).toBeNull();
  });

  it("「剧情图」轨按钮打开剧情图 overlay（记住返回屏）", () => {
    useGameStore.setState({ screen: "game", screenReturn: null });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle("剧情图"));
    const s = useGameStore.getState();
    expect(s.screen).toBe("tree");
    expect(s.screenReturn).toBe("game");
  });
});

describe("ChapterCard：章节过场卡（v1.8）", () => {
  beforeEach(() => {
    useGameStore.setState({ screen: "game", worldId: "campus-summer-1", chapterNo: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    useGameStore.setState({ screen: "boot", worldId: null, chapterNo: 1 });
  });

  it("首次进 game 屏照亮，CHAPTER_CARD_MS 到点卸载；同世界同章从 overlay 返回不重亮", () => {
    vi.useFakeTimers();
    render(<ChapterCard />);
    expect(screen.getByTestId("chapter-card").textContent).toContain("第 1 章");

    // 两个定时器各管一段：先到 CHAPTER_CARD_MS-FADE 开始淡出（卡还挂着），到 CHAPTER_CARD_MS 才卸载
    act(() => vi.advanceTimersByTime(CHAPTER_CARD_MS - CHAPTER_CARD_FADE_MS));
    expect(screen.getByTestId("chapter-card")).toBeTruthy();
    act(() => vi.advanceTimersByTime(CHAPTER_CARD_FADE_MS));
    expect(screen.queryByTestId("chapter-card")).toBeNull();

    // 从 overlay 返回 game（世界线与章号都没变）：不重亮
    act(() => useGameStore.setState({ screen: "assets" }));
    act(() => useGameStore.setState({ screen: "game" }));
    expect(screen.queryByTestId("chapter-card")).toBeNull();
  });

  it("局内换章照亮；离屏（制作屏）期间的章号变化留到回到 game 屏才兑现", () => {
    vi.useFakeTimers();
    render(<ChapterCard />);
    act(() => vi.advanceTimersByTime(CHAPTER_CARD_MS));
    expect(screen.queryByTestId("chapter-card")).toBeNull();

    act(() => useGameStore.setState({ chapterNo: 2 })); // 局内换章
    expect(screen.getByTestId("chapter-card").textContent).toContain("第 2 章");
    act(() => vi.advanceTimersByTime(CHAPTER_CARD_MS));
    expect(screen.queryByTestId("chapter-card")).toBeNull();

    act(() => useGameStore.setState({ screen: "crafting", chapterNo: 3 })); // 制作屏上章号变了
    expect(screen.queryByTestId("chapter-card")).toBeNull(); // 卡只属于 game 屏
    act(() => useGameStore.setState({ screen: "game" })); // 回游戏屏才兑现
    expect(screen.getByTestId("chapter-card").textContent).toContain("第 3 章");
  });

  it("换世界线重新武装：章号相同也照亮；章号 < 1（还没进正戏）不照亮", () => {
    vi.useFakeTimers();
    render(<ChapterCard />);
    act(() => vi.advanceTimersByTime(CHAPTER_CARD_MS));

    act(() => useGameStore.setState({ worldId: "campus-summer-2" })); // 章号不变
    expect(screen.getByTestId("chapter-card").textContent).toContain("第 1 章");
    act(() => vi.advanceTimersByTime(CHAPTER_CARD_MS));

    act(() => useGameStore.setState({ chapterNo: 0 }));
    expect(screen.queryByTestId("chapter-card")).toBeNull();
  });
});

describe("lib/status：引擎状态文案的玩家化映射（v1.6）", () => {
  it("playerStatus 映射表：五个已知条目逐字翻译，表外状态原样透传", () => {
    expect(playerStatus("连接引擎…")).toBe("连接中…");
    expect(playerStatus("引擎演绎中…")).toBe("故事展开中…");
    expect(playerStatus("撰写章节大纲…")).toBe("章节筹备中…");
    expect(playerStatus("就绪")).toBe("就绪");
    expect(playerStatus("出错：HTTP 500")).toBe("出错了：HTTP 500");
    expect(playerStatus("出错：")).toBe("出错了："); // 前缀换成玩家口吻、尾巴原样保留

    // 表外状态原样透传：制作屏的引擎口吻与重掷失败的提示都不许被硬翻
    for (const s of ["清点既有美术…", "无法重掷：快照不足", "引擎演绎中"]) {
      expect(playerStatus(s)).toBe(s);
    }
  });
});

describe("lib/worlds：旧版分叉备注识别（v1.8）", () => {
  it("isLegacyForkNote 真值表：两种真实形态（含前后空白）为 true，空值与近似形态为 false", () => {
    // 旧版 server 自动写的两种真实形态
    expect(isLegacyForkNote("分叉自 campus-summer-1 @ 2-2")).toBe(true);
    expect(isLegacyForkNote("分叉自 campus-summer-1 @ 2-2（精确快照 #7）")).toBe(true);
    expect(isLegacyForkNote("  分叉自 w1 @ 1-1  ")).toBe(true); // 前后空白容忍
    expect(isLegacyForkNote("分叉自 w1 @1-1")).toBe(true);

    // 空值：本来就没有备注
    expect(isLegacyForkNote(null)).toBe(false);
    expect(isLegacyForkNote(undefined)).toBe(false);
    expect(isLegacyForkNote("")).toBe(false);
    expect(isLegacyForkNote("   ")).toBe(false);

    // 近似形态：玩家自己写的 / 带尾巴的都不许被当成旧版自动备注吞掉
    expect(isLegacyForkNote("分叉自 雨夜 @ 天台 之后")).toBe(false);
    expect(isLegacyForkNote("分叉自雨夜的岔口")).toBe(false); // 只以「分叉自」开头、没有 @
    expect(isLegacyForkNote("分叉自 w1 @ 1-1 的支线")).toBe(false);
    expect(isLegacyForkNote("来自 campus-summer-1 @ 2-2")).toBe(false);
    expect(isLegacyForkNote("分叉自 w1 @ 1-1（精确快照 #x）")).toBe(false);
    expect(isLegacyForkNote("分叉自 w1 @ 1-1（精确快照 #7）后面还有字")).toBe(false);
  });
});

describe("WorldsScreen：世界线列表与动作（v1.5）", () => {
  const NOW = Date.now();
  const WORLDS: WorldEntry[] = [
    {
      worldId: "campus-summer-2",
      preset: "campus-summer",
      title: "盛夏偏差值",
      chapterNo: 2,
      lastPlayed: NOW - 5 * 60_000,
      note: "分叉自 campus-summer-1 @ 2-2",
      forkedFrom: { worldId: "campus-summer-1", nodeId: "2-2" },
      exists: true,
    },
    {
      worldId: "campus-summer-1",
      preset: "campus-summer",
      title: "盛夏偏差值",
      chapterNo: 3,
      lastPlayed: NOW - 3 * 3_600_000,
      note: "",
      forkedFrom: null,
      exists: true,
    },
  ];
  /** POST /api/worlds 收到的动作 */
  let worldPosts: { action: string; worldId?: string; preset?: string }[] = [];
  /** GET /api/worlds 返回的清单（可被单个用例覆盖） */
  let worldsResp: WorldEntry[] = [];

  beforeEach(() => {
    worldPosts = [];
    worldsResp = WORLDS;
    useGameStore.setState({ selected: PRESET, screen: "worlds", screenReturn: null, engineBusy: false, worldId: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") return jsonResponse({ ok: true });
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          worldPosts.push(body);
          if (body.action === "create") return jsonResponse({ ok: true, worldId: "campus-summer-3" });
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("渲染世界行：显示名/章号/相对时间/分叉徽标；同屏按最近游玩排序", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-2")).toBeTruthy());
    const forkRow = within(screen.getByTestId("world-row-campus-summer-2"));
    expect(forkRow.getByText(/第 2 章 · 5 分钟前/)).toBeTruthy();
    // 旧版分叉备注是裸 id 串（isLegacyForkNote）= 没有备注：主行回退剧本名、次行不铺，来历交给徽标
    expect(forkRow.queryByText(/分叉自 campus-summer-1 @ 2-2/)).toBeNull();
    expect(forkRow.getByText("自《盛夏偏差值》延伸")).toBeTruthy();
    expect(forkRow.queryByTestId("world-note-campus-summer-2")).toBeNull();
    const plainRow = within(screen.getByTestId("world-row-campus-summer-1"));
    expect(plainRow.getByText("盛夏偏差值")).toBeTruthy(); // 无 label/备注：回退剧本名，绝不露裸 worldId
    expect(plainRow.queryByText("campus-summer-1")).toBeNull();
    expect(plainRow.getByText(/第 3 章 · 3 小时前/)).toBeTruthy();
    const rows = screen.getByTestId("worlds-screen").querySelectorAll('[data-testid^="world-row-"]');
    expect(rows[0].getAttribute("data-testid")).toBe("world-row-campus-summer-2"); // 最近游玩优先
  });

  it("继续：点击行内按钮调用 resumeWorld（进 game 并发「继续世界：」指令）", async () => {
    const prompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-continue-campus-summer-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("world-continue-campus-summer-1"));

    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.worldId).toBe("campus-summer-1");
    expect(s.chapterNo).toBe(3);
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-1。");

    // aside「继续上次」卡：最近游玩的那条 + 卡里的「继续」走行内那同一个 continueWorld
    const card = screen.getByTestId("worlds-resume-card");
    expect(within(card).getByText("盛夏偏差值")).toBeTruthy(); // 旧版分叉备注不算显示名 → 回退剧本名
    expect(within(card).getByText(/第 2 章 · 5 分钟前/)).toBeTruthy();
    const resume = screen.getByTestId("worlds-resume-continue") as HTMLButtonElement;
    expect(resume.getAttribute("aria-label")).toBe("继续上次的世界线 盛夏偏差值");
    expect(resume.disabled).toBe(false);
    fireEvent.click(resume);
    expect(useGameStore.getState().worldId).toBe("campus-summer-2");
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-2。");

    // 引擎忙：同一个按钮禁用并改口（点了不会发出指令）
    act(() => useGameStore.setState({ engineBusy: true }));
    const busyResume = screen.getByTestId("worlds-resume-continue") as HTMLButtonElement;
    expect(busyResume.disabled).toBe(true);
    expect(busyResume.textContent).toBe("忙碌中");
    expect(busyResume.getAttribute("title")).toBe("忙碌中，稍后再试");
  });

  it("新世界线：POST create 成功后带新 id 进捏人屏；失败留在本屏并报错", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-new")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worlds-new"));

    await waitFor(() => expect(useGameStore.getState().screen).toBe("protagonist"));
    expect(worldPosts).toEqual([{ action: "create", preset: "campus-summer" }]);
    expect(useGameStore.getState().worldId).toBe("campus-summer-3");
  });

  it("删除：两段式确认收在 ⋯ 菜单里，第二段才发 delete 并重取清单", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-2")).toBeTruthy());
    openRowMenu("campus-summer-2");
    fireEvent.click(screen.getByTestId("world-delete-campus-summer-2"));
    expect(worldPosts).toEqual([]); // 首点只进确认态

    fireEvent.click(screen.getByTestId("world-confirm-campus-summer-2"));
    await waitFor(() => expect(worldPosts).toEqual([{ action: "delete", worldId: "campus-summer-2" }]));
    // 删除成功提示去向（回收站可手工找回）
    await waitFor(() => expect(screen.getByText("已移入回收站，可从数据目录找回")).toBeTruthy());
  });

  it("空态与加载失败：没有世界线时提示并可开新线；清单拉不到时不冒充空态，而是错误条 +「重试」重打接口", async () => {
    worldsResp = [];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-empty")).toBeTruthy());
    expect(screen.getByText(/还没有世界线/)).toBeTruthy();
    expect(screen.getByTestId("worlds-new")).toBeTruthy();

    // 清单拉不到（服务端 500）：给一句人话 + 一个「重试」；重试就是再打一次接口，成功后行回来、错误条收起
    let broken = true;
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/worlds") {
          listCalls += 1;
          return broken ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ worlds: WORLDS });
        }
        return jsonResponse({}, 404);
      }),
    );
    cleanup();
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-error")).toBeTruthy());
    expect(screen.getByTestId("worlds-error").textContent).toContain("世界线加载失败：Error: GET /api/worlds -> HTTP 500");
    // 失败 ≠ 空态：说成「还没有世界线」玩家会去建重复的线
    expect(screen.queryByTestId("worlds-empty")).toBeNull();
    expect(listCalls).toBe(1);

    broken = false;
    fireEvent.click(screen.getByTestId("worlds-retry"));
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-1")).toBeTruthy());
    expect(listCalls).toBe(2); // 重试真的重打了接口，不是只把错误条收起来
    expect(screen.queryByTestId("worlds-error")).toBeNull();
  });

  it("relativeTime：刚刚 / 分钟 / 小时 / 天 / 更早，坏时间戳兜底", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
    expect(relativeTime(now - 40 * 86_400_000, now)).toBe("更早");
    expect(relativeTime(0, now)).toBe("更早");
    expect(relativeTime(now + 60_000, now)).toBe("刚刚"); // 时钟回拨不显示负数
  });
});

describe("CreationScreen：选项 chip 化与排队提示", () => {
  beforeEach(() => {
    useGameStore.setState({
      screen: "creation",
      screenReturn: "title",
      creationExitPrompt: false,
      pendingCreationMessage: null,
      creationResult: null,
      assembling: false,
      assemblyStalled: false,
      creationMessages: [
        {
          role: "engine",
          text: "先定题材和世界。\n**行动**\n1. 雨夜广播站\n2. 深海观测站",
        },
      ],
    });
  });

  it("引擎气泡：正文无「**行动**」，选项渲染为可点击 chip", () => {
    render(<CreationScreen />);
    expect(screen.getByText(/先定题材和世界/)).toBeTruthy();
    expect(screen.queryByText(/\*\*行动\*\*/)).toBeNull();
    expect(screen.getByRole("button", { name: "雨夜广播站" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "深海观测站" })).toBeTruthy();
  });

  it("chip 点击只填输入框不发送；排队消息显示提示行；返回确认层带模态语义与焦点陷阱", async () => {
    const prompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        prompts.push(JSON.parse(String(init?.body)).text);
        return jsonResponse({ ok: true });
      }),
    );
    render(<CreationScreen />);
    fireEvent.click(screen.getByRole("button", { name: "雨夜广播站" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("雨夜广播站");
    expect(prompts).toEqual([]); // 填入不发送

    useGameStore.setState({ pendingCreationMessage: "我的构想" });
    await waitFor(() => expect(screen.getByText("就绪后自动发送")).toBeTruthy());

    // —— v1.9 a11y：返回确认层（Esc 链第三环）的模态语义 + 焦点陷阱 + 关闭归还 ——
    const headerBack = screen.getByRole("button", { name: "返回" });
    headerBack.focus(); // 现实里点「返回」就会聚焦它，它也是开层前的「上一个元素」
    // 关着确认层时：创作整列没有 inert、对话流（本屏的滚动容器）没有滚动锁
    const content = screen.getByTestId("creation-content");
    const flow = screen.getByTestId("creation-flow");
    expect(content.hasAttribute("inert")).toBe(false);
    expect(flow.className).toContain("overflow-y-auto");
    expect(flow.className).not.toContain("scroll-locked");
    act(() => {
      useGameStore.getState().requestCreationExit(); // 有对话 → 开确认层（不是直接返回）
    });
    const exit = screen.getByTestId("creation-exit-prompt");
    expect(exit.getAttribute("role")).toBe("dialog");
    expect(exit.getAttribute("aria-modal")).toBe("true");
    expect(exit.getAttribute("aria-label")).toBe("返回确认"); // 名字与正文的可见问句分开，读屏不重复念
    // 背景压制（v1.9 a11y）：整列 inert，对话流就在这一列里（含表头的「返回」、输入框、选项 chip）；
    // 确认层是这一列的兄弟，所以不在这层里——两个按钮照常可聚焦
    expect(content.hasAttribute("inert")).toBe(true);
    expect(flow.closest("[inert]")).toBe(content);
    expect(headerBack.closest("[inert]")).toBe(content);
    expect(exit.closest("[inert]")).toBeNull();
    expect(flow.className).toContain("scroll-locked"); // 滚动锁：本屏唯一在滚的容器被停住（jsdom 不滚，断契约）
    const back = within(exit).getByRole("button", { name: "返回" });
    const cancel = within(exit).getByRole("button", { name: "取消" });
    // 开层把焦点从输入框送进层内第一个可聚焦元素：App 的 Esc 关闭链在「正在打字」时不拦键，
    // 焦点不在输入框里，确认层才能被 Esc 关掉（焦点陷阱顺手补上这条路径）
    expect(document.activeElement).toBe(back);
    expect(focusableElements(exit)).toEqual([back, cancel]);
    cancel.focus();
    pressTab(); // 末 → 首
    expect(document.activeElement).toBe(back);
    pressTab(true); // 首 → 末
    expect(document.activeElement).toBe(cancel);

    act(() => {
      useGameStore.getState().closeCreationExitPrompt();
    });
    // 关闭即解锁：inert 与滚动锁一起摘掉（否则表头的「返回」再也点不动、对话流也永远滚不了）
    expect(content.hasAttribute("inert")).toBe(false);
    expect(flow.className).not.toContain("scroll-locked");
    expect(document.activeElement).toBe(headerBack); // 关闭归还：回到开层前的「返回」按钮
  });
});

describe("StoryTreeScreen：树图、详情与编辑（v1.5）", () => {
  const TREE_MD = [
    "# 剧情树",
    "## 归档",
    "- 第 1 章：教室相遇；已走：1-1 → 1-2",
    "",
    "## 第 2 章：雨夜来客",
    "- 目标: 建立信任或敌意",
    "- 当前进度: 节点 2-2（已走 3 轮）",
    "",
    "### 节点 2-1（来客敲门）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿、来客",
    "- 梗概: 深夜有人敲门",
    "- 出边: 开门 → 2-2；装作没听见 → 2-3",
    "- 状态: 已走过",
    "",
    "### 节点 2-2（门外的雨声）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿、来客",
    "- 梗概: 来客淋着雨递上一封信",
    "- 出边: 接过信 → finale",
    "- 状态: 已走过",
    "",
    "### 节点 2-3（假装睡着）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿",
    "- 梗概: 走廊里传来拖拽声",
    "- 状态: 已剪枝",
  ].join("\n");

  /** GET /api/tree 返回的原文（可被单个用例覆盖）；treeStatus 控制 HTTP 状态 */
  let treeMarkdown = TREE_MD;
  let treeStatus = 200;
  /** POST /prompt 收到的指令 */
  let prompts: string[] = [];

  beforeEach(() => {
    treeMarkdown = TREE_MD;
    treeStatus = 200;
    prompts = [];
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "tree",
      screenReturn: "game",
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/tree") {
          if (treeStatus !== 200) return jsonResponse({ error: "剧情树不存在" }, treeStatus);
          return jsonResponse({ worldId: "campus-summer-1", markdown: treeMarkdown });
        }
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 404);
      }),
    );
  });

  it("画出当前章：节点按 id 可见、归档成链、当前进度节点带环（aria 标注状态）", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    expect(screen.getByTestId("tree-node-2-1")).toBeTruthy();
    expect(screen.getByTestId("tree-node-2-3")).toBeTruthy();
    expect(screen.getByTestId("tree-archive").textContent).toContain("第 1 章");
    expect(screen.getByLabelText("节点 2-1 · 已走过")).toBeTruthy();
    expect(screen.getByLabelText("节点 2-3 · 已剪枝")).toBeTruthy();
  });

  it("点节点看详情：地点/在场/出边；已走过节点可「在此分叉」，已剪枝节点不行", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-node-2-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tree-node-2-1"));
    const detail = within(screen.getByTestId("tree-detail"));
    expect(detail.getByText("灰雀镇旅店")).toBeTruthy();
    expect(detail.getByText("沈屿、来客")).toBeTruthy();
    expect(detail.getByText("2-2")).toBeTruthy(); // 出边目标
    expect(screen.getByTestId("tree-fork-2-1")).toBeTruthy();

    // 换点已剪枝节点：详情跟随，且不提供分叉入口
    fireEvent.click(screen.getByTestId("tree-node-2-3"));
    expect(within(screen.getByTestId("tree-detail")).getByText("已剪枝")).toBeTruthy();
    expect(screen.queryByTestId("tree-fork-2-3")).toBeNull();
  });

  it("一句话改树：Enter 发「剧情：」指令并清空输入", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const input = within(screen.getByTestId("tree-input")).getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "删掉节点 2-3" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(prompts.at(-1)).toBe("剧情：删掉节点 2-3");
    expect(input.value).toBe("");
  });

  it("引擎忙：发送按钮禁用并提示排队", async () => {
    useGameStore.setState({ engineBusy: true });
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    expect((screen.getByTestId("tree-send") as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByTestId("tree-input")).getByText("忙碌中，就绪后自动发送")).toBeTruthy();
  });

  it("404（本章未规划）：给玩家一句人话；解析失败回退显示原文", async () => {
    treeStatus = 404;
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-error").textContent).toContain("本章还没有剧情树"));
    expect(screen.queryByTestId("tree-canvas")).toBeNull();

    cleanup();
    treeStatus = 200;
    treeMarkdown = "（引擎没按格式写树）";
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-raw")).toBeTruthy());
    expect(screen.getByTestId("tree-raw").textContent).toContain("引擎没按格式写树");
  });

  it("无世界线：不开图，给引导文案", () => {
    useGameStore.setState({ worldId: null, worldLabel: "" });
    render(<StoryTreeScreen />);
    expect(screen.getByText("先开始或继续一条世界线，再来看剧情图")).toBeTruthy();
    expect(screen.queryByTestId("tree-canvas")).toBeNull();
  });

  it("分叉结果横幅：显示新世界线并可切换（switchToFork → 关图屏续玩）", async () => {
    useGameStore.setState({
      forkResult: { worldId: "campus-summer-2", nodeId: "2-2" },
      treeNotice: "已创建世界线 campus-summer-2（分叉自 campus-summer-1 @ 2-2）· 分叉不推演，切换后从该节点续演",
    });
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-fork-result")).toBeTruthy());
    expect(screen.getByTestId("tree-notice").textContent).toContain("campus-summer-2");

    fireEvent.click(screen.getByTestId("tree-switch"));
    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.worldId).toBe("campus-summer-2");
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-2。");
  });
});

describe("AssetsScreen：分组、未使用徽标与预览", () => {
  // v1.5.1：资产随剧本走，清单只含目录 presets/<preset>/assets/ 下的文件（封面 presets/<preset>/cover.jpg）；
  // 每条都带 preset，画廊按它做防御性过滤（跨剧本条目见下一条用例）
  const ASSETS: AssetEntry[] = [
    {
      type: "立绘",
      name: "薇拉",
      variant: "",
      preset: "campus-summer",
      file: "presets/campus-summer/assets/立绘-薇拉.jpg",
      ready: true,
      inUse: true,
      mtime: 1,
    },
    {
      type: "立绘",
      name: "薇拉",
      variant: "微笑",
      preset: "campus-summer",
      file: "presets/campus-summer/assets/立绘-薇拉-微笑.jpg",
      ready: true,
      inUse: false,
      mtime: 2,
    },
    {
      type: "背景",
      name: "灰雀镇廉价旅店",
      variant: "",
      preset: "campus-summer",
      file: "presets/campus-summer/assets/背景-灰雀镇廉价旅店.jpg",
      ready: true,
      inUse: false,
      mtime: 3,
    },
    {
      type: "封面",
      name: "盛夏偏差值",
      variant: "",
      preset: "campus-summer",
      file: "presets/campus-summer/cover.jpg",
      ready: true,
      inUse: false,
      mtime: 4,
    },
  ];
  /** GET /api/assets 的 mock（断言请求带 preset） */
  let fetchMock: ReturnType<typeof vi.fn>;
  /** GET /api/assets 返回的清单（单个用例可覆盖，用于混入跨剧本项） */
  let assetsResp: AssetEntry[];

  beforeEach(() => {
    assetsResp = ASSETS;
    useGameStore.setState({
      selected: PRESET,
      screen: "assets",
      screenReturn: "game",
      assetsPreview: null,
      regenPending: null,
      engineBusy: false,
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      // v1.5.1：清单必须带 preset，服务端缺省/非法即 400
      if (url.pathname === "/api/assets") {
        return url.searchParams.get("preset") === "campus-summer"
          ? jsonResponse(assetsResp)
          : jsonResponse({ error: "preset required" }, 400);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("立绘按角色分组（差分显示为 名 · 变体），背景/封面各自成组，未使用徽标只标未被引用的项", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByText("立 绘")).toBeTruthy());
    expect(screen.getByText("薇拉 · 微笑")).toBeTruthy();
    expect(screen.getByText("背 景")).toBeTruthy();
    expect(screen.getByText("封 面")).toBeTruthy();
    // inUse 是多数态（标了等于没标）：角标只标异常——4 项里只有基础薇拉 inUse
    expect(screen.queryByText("在用")).toBeNull();
    expect(screen.getAllByText("未使用")).toHaveLength(3);
    // 清单请求按当前剧本过滤
    expect(fetchMock).toHaveBeenCalledWith("/api/assets?preset=campus-summer", expect.objectContaining({ signal: expect.anything() }));
  });

  it("点击卡片打开大图预览（store 状态），Esc 关闭链入口可用", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByText("薇拉 · 微笑")).toBeTruthy());
    fireEvent.click(screen.getByTestId("asset-card-薇拉-微笑"));
    expect(useGameStore.getState().assetsPreview?.file).toBe("presets/campus-summer/assets/立绘-薇拉-微笑.jpg");
    useGameStore.getState().setAssetsPreview(null);
    expect(useGameStore.getState().assetsPreview).toBeNull();
  });

  it("未选剧本（从标题屏直接进画廊）：不请求清单，提示先选剧本", async () => {
    useGameStore.setState({ selected: null });
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-nopreset")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled(); // 没有可查的资产目录，不白打一次 400
  });

  it("跨剧本串味兜底：清单混入别的剧本的条目 → 不渲染并告警（服务端理论上不该返回）", async () => {
    assetsResp = [
      ...ASSETS,
      {
        type: "立绘",
        name: "守夜人",
        variant: "",
        preset: "twilight-throne", // 旧档串味 / 装配期写错目录的回归样本
        file: "presets/twilight-throne/assets/立绘-守夜人.jpg",
        ready: true,
        inUse: false,
        mtime: 5,
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(<AssetsScreen />);
      await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());

      expect(screen.queryByTestId("asset-card-守夜人")).toBeNull(); // 别家剧本的立绘不进画廊
      expect(screen.queryByText("守夜人")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("campus-summer"); // 告警点明当前剧本
      expect(warn.mock.calls[0][1]).toEqual(["presets/twilight-throne/assets/立绘-守夜人.jpg"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SettingsScreen：设置项、持久化与入口（v1.6）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useGameStore.setState({
      screen: "settings",
      screenReturn: "game",
      settings: { ...DEFAULT_SETTINGS }, // 单例跨用例共享，先回默认再断言「渲染当前值」
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    useGameStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  });

  it("渲染当前值：主音量/三通道滑杆读数、静音态、文本速度与自动前进的选中档", () => {
    render(<SettingsScreen />);
    expect(screen.getByTestId("settings-screen")).toBeTruthy();
    // ShellPage 页框（v1.8）：眉标 + 标题 + 右侧动作簇 + 页脚与正文同在一个 84rem 宽栏里（各屏不再自写窄栏）
    const page = screen.getByTestId("shell-page");
    expect(within(page).getByText("本机偏好")).toBeTruthy();
    expect(within(page).getByText("设 置")).toBeTruthy();
    expect(page.contains(screen.getByTestId("settings-back"))).toBe(true);
    expect(page.contains(screen.getByTestId("settings-screen"))).toBe(true);
    expect(within(page).getByText("改动即时生效并保存在本机")).toBeTruthy();
    expect((screen.getByTestId("settings-master") as HTMLInputElement).value).toBe("1");
    expect(screen.getByTestId("settings-master-value").textContent).toBe("100");
    expect((screen.getByTestId("settings-bgm") as HTMLInputElement).value).toBe("0.8");
    expect(screen.getByTestId("settings-bgm-value").textContent).toBe("80");
    expect(screen.getByTestId("settings-ambient-value").textContent).toBe("60");
    expect(screen.getByTestId("settings-sfx-value").textContent).toBe("90");
    // 静音是真开关语义（role=switch + aria-checked），不再是「看着像标签的按钮」
    const mutedSwitch = screen.getByTestId("settings-muted");
    expect(mutedSwitch.getAttribute("role")).toBe("switch");
    expect(mutedSwitch.getAttribute("aria-checked")).toBe("false");
    expect(mutedSwitch.getAttribute("aria-pressed")).toBeNull();
    expect(screen.getByTestId("settings-textspeed-standard").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("settings-auto-0").getAttribute("aria-pressed")).toBe("true");
    // 四档文本速度与三档自动前进都在（缺档 = 玩家改不了）
    for (const s of ["slow", "standard", "fast", "instant"]) expect(screen.getByTestId(`settings-textspeed-${s}`)).toBeTruthy();
    for (const ms of [0, 3000, 5000]) expect(screen.getByTestId(`settings-auto-${ms}`)).toBeTruthy();
  });

  it("滑杆改动即时写回 store 与 localStorage（无保存按钮，读数同步）", () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId("settings-master"), { target: { value: "0.3" } });
    expect(useGameStore.getState().settings.master).toBeCloseTo(0.3);
    expect(screen.getByTestId("settings-master-value").textContent).toBe("30");

    fireEvent.change(screen.getByTestId("settings-sfx"), { target: { value: "0.5" } });
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY)!) as Record<string, unknown>;
    expect(saved).toMatchObject({ master: 0.3, sfx: 0.5, textSpeed: "standard", autoAdvance: 0 });
    // 落盘形状能被 loadSettings 原样读回（逐键校验不改合法值）
    expect(loadSettings()).toEqual(useGameStore.getState().settings);
  });

  it("静音开关与档位按钮：点击即落 store + 存档，可来回切", () => {
    render(<SettingsScreen />);
    const muted = screen.getByTestId("settings-muted");
    fireEvent.click(muted);
    expect(useGameStore.getState().settings.muted).toBe(true);
    expect(screen.getByTestId("settings-muted").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("settings-muted"));
    expect(screen.getByTestId("settings-muted").getAttribute("aria-checked")).toBe("false");
    expect(useGameStore.getState().settings.muted).toBe(false);

    fireEvent.click(screen.getByTestId("settings-textspeed-instant"));
    fireEvent.click(screen.getByTestId("settings-auto-5000"));
    expect(useGameStore.getState().settings).toMatchObject({ textSpeed: "instant", autoAdvance: 5000 });
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY)!) as Record<string, unknown>;
    expect(saved).toMatchObject({ textSpeed: "instant", autoAdvance: 5000 });
  });

  it("返回按钮走 closeOverlay 回到进入前的屏（Esc 链同一条路）", () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByTestId("settings-back"));
    expect(useGameStore.getState().screen).toBe("game");
    expect(useGameStore.getState().screenReturn).toBeNull();
  });

  it("TopBar 齿轮（aria-label「设置」）打开设置 overlay 并记住返回屏", () => {
    useGameStore.setState({ screen: "game", screenReturn: null });
    render(<TopBar />);
    fireEvent.click(screen.getByLabelText("设置"));
    const s = useGameStore.getState();
    expect(s.screen).toBe("settings");
    expect(s.screenReturn).toBe("game");
  });

  it("存档读取：JSON 损坏整份回默认，单键非法只兜该键（好键保留）", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "{ 这不是 JSON");
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS });

    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ master: 7, bgm: -1, muted: true, textSpeed: "ludicrous", autoAdvance: 1000 }),
    );
    // master 7 被收敛到 1（=默认值）、bgm -1 → 0、非法档位回默认；只有合法的 muted 被保留
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, bgm: 0, muted: true });
  });
});

describe("AudioManager：索引、交叉淡入与静默降级（v1.6）", () => {
  /** GET /api/audio 返回的索引（单个用例可覆盖）；曲的两条故意不给 url，逼前端按 preset+file 兜底拼 */
  let items: AudioItem[];
  /** play() 收到的元素 src（按调用顺序）——prototype 打桩，避免 jsdom 打 "not implemented" */
  let played: string[];
  /** pause() 收到的元素（淡出结束 / stopAll 时才会出现） */
  let paused: HTMLAudioElement[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  /** jsdom 会把相对 src 解析成绝对 URL，断言前先解码（中文路径全被 encodeURIComponent 过） */
  const decode = (s: string) => decodeURIComponent(s);

  /** 清空 play/pause 计数：setPreset 的 stopAll 会 pause 上一轮残留的元素，那是复位噪声不是行为 */
  const resetCounters = () => {
    played = [];
    paused = [];
  };

  beforeEach(async () => {
    items = [
      { kind: "曲", name: "雨夜", file: "presets/demo/audio/曲-雨夜.mp3", url: "" },
      { kind: "曲", name: "晴日", file: "presets/demo/audio/曲-晴日.mp3", url: "" },
      { kind: "环境", name: "旅店大堂", file: "presets/demo/audio/环境-旅店大堂.mp3", url: "/audio?p=env-旅店大堂" },
      { kind: "音效", name: "门响", file: "presets/demo/audio/音效-门响.wav", url: "/audio?p=sfx-门响" },
    ];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/audio") return jsonResponse({ items });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      played.push(this.src);
      return Promise.resolve();
    });
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      paused.push(this);
    });
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // 单例跨用例共享：先清空索引/通道并回默认音量，避免上一用例的曲与设置串味。
    // 注意顺序——这步 stopAll 会 pause 上一用例残留的元素，所以计数数组必须在其后再清空。
    await audioManager.setPreset("");
    audioManager.applySettings({ ...DEFAULT_SETTINGS });
    resetCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("setPreset 建索引：【曲】走 preset+file 兜底 URL，服务端给了 url 就照用", async () => {
    await audioManager.setPreset("demo");
    expect(fetchMock).toHaveBeenCalledWith("/api/audio?preset=demo", expect.anything());

    audioManager.handle({ kind: "曲", name: "雨夜" });
    expect(played).toHaveLength(1);
    expect(decode(played[0])).toBe("http://localhost:3000/audio?p=presets/demo/audio/曲-雨夜.mp3");

    audioManager.handle({ kind: "环境", name: "旅店大堂" });
    expect(decode(played.at(-1) ?? "").endsWith("/audio?p=env-旅店大堂")).toBe(true);
  });

  it("索引未就绪：【曲】/【环境】各挂起最近一次，就绪后补播；【音效】不挂起", async () => {
    const loading = audioManager.setPreset("demo"); // 索引请求在途
    audioManager.handle({ kind: "曲", name: "不存在的旧曲" });
    audioManager.handle({ kind: "曲", name: "雨夜" }); // 后到的覆盖先到的
    audioManager.handle({ kind: "环境", name: "旅店大堂" });
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toEqual([]); // 未就绪：一条都不播

    await loading;
    expect(played.filter((s) => decode(s).includes("曲-雨夜"))).toHaveLength(1);
    expect(played.filter((s) => decode(s).endsWith("/audio?p=env-旅店大堂"))).toHaveLength(1);
    expect(played.some((s) => decode(s).includes("不存在的旧曲"))).toBe(false);
    expect(played.some((s) => s.includes("sfx"))).toBe(false); // 音效一次性：错过就错过
  });

  it("交叉淡入：换曲走另一个元素，旧曲在 FADE_MS 后暂停；同一首重复请求不重启；「停」淡出后暂停", async () => {
    vi.useFakeTimers();
    await audioManager.setPreset("demo");
    resetCounters(); // 上面的建索引会先 stopAll（复位噪声），从这里开始只数本用例的播放

    // 第一首：另一侧是还没播过的空元素（音量 0 → 收尾即停，无 600ms 斜坡），先让它淡入到位
    audioManager.handle({ kind: "曲", name: "雨夜" });
    vi.advanceTimersByTime(FADE_MS + 100);
    const first = played.at(-1)!;
    paused.length = 0;

    audioManager.handle({ kind: "曲", name: "晴日" });
    expect(played.at(-1)).not.toBe(first); // 双元素：换到另一侧淡入
    expect(paused).toEqual([]); // 旧曲还在淡出，先不打断
    vi.advanceTimersByTime(FADE_MS + 100);
    expect(paused.map((el) => el.src)).toEqual([first]); // 淡出结束才 pause

    const before = played.length;
    audioManager.handle({ kind: "曲", name: "晴日" });
    expect(played).toHaveLength(before); // 同一首在播：不从头重来

    paused.length = 0;
    audioManager.handle({ kind: "曲", name: "停" });
    expect(played).toHaveLength(before); // 「停」不播任何新音频
    expect(paused).toEqual([]);
    vi.advanceTimersByTime(FADE_MS + 100);
    expect(paused).toHaveLength(1); // 淡出到 0 才停
  });

  it("音效一次性：并发上限 4，超出丢弃；文件缺失静默 no-op（只留 console.debug 线索）", async () => {
    await audioManager.setPreset("demo");
    for (let i = 0; i < 6; i++) audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX);
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("并发"))).toBe(true);

    const n = played.length;
    audioManager.handle({ kind: "音效", name: "没放的文件" });
    expect(played).toHaveLength(n); // 解析不到文件就不播，也不抛
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("没放的文件"))).toBe(true);
  });

  it("音效槽位兜底超时：ended/error/play 全被挂起时到点释放（4 个槽占满后本会话仍有音效）", async () => {
    vi.useFakeTimers();
    // 抓住管理器内部新建的播放元素：本用例要手动派发 ended，验证「事件先到就撤定时器」
    const created: HTMLAudioElement[] = [];
    const RealAudio = window.Audio;
    vi.stubGlobal("Audio", function AudioStub() {
      const el = new RealAudio();
      created.push(el);
      return el;
    });
    await audioManager.setPreset("demo");
    resetCounters();

    for (let i = 0; i < MAX_SFX; i++) audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX);
    expect(vi.getTimerCount()).toBe(MAX_SFX); // 每条音效各挂一条兜底超时
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX); // 槽满：第 5 条丢弃（ended/error/play 都没来）
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("并发"))).toBe(true);

    vi.advanceTimersByTime(SFX_TIMEOUT_MS); // 兜底到点：槽位照样释放（否则本会话再无音效）
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX + 1); // 超时释放后放得下新的音效

    // ended 先到：立刻释放且撤掉兜底定时器（不会出现第二次释放），槽位随即可再用
    created.at(-1)!.dispatchEvent(new Event("ended"));
    expect(vi.getTimerCount()).toBe(0);
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX + 2);
  });

  it("索引失败：同一个本再选不重复请求、也不再多停一次通道（每个本只写一行告警）", async () => {
    /** /api/audio 被问了几次某个本（mock fetch 计数） */
    const calls = (id: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(`preset=${id}`)).length;

    // 基线：索引就绪的本——重复选本本来就不重拉、也不该打断在播的曲（元素还挂在通道上）
    await audioManager.setPreset("demo");
    audioManager.handle({ kind: "曲", name: "雨夜" });
    expect(played).toHaveLength(1);
    expect(calls("demo")).toBe(1);
    paused.length = 0; // 建索引那一次的 stopAll 是换本的正常代价，不计入「被打断」
    await audioManager.setPreset("demo");
    expect(calls("demo")).toBe(1);
    expect(paused).toEqual([]); // 在播的曲没被 stopAll 掐掉

    // 索引失败的本（服务端 500）：只拉一次，之后同一个本再选不再打扰服务端
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      return String(input).includes("preset=broken")
        ? jsonResponse({ error: "boom" }, 500)
        : jsonResponse({ items: [] });
    });
    await audioManager.setPreset("broken");
    expect(calls("broken")).toBe(1);
    const before = played.length;
    audioManager.handle({ kind: "曲", name: "雨夜" }); // 索引空 = 这个本静默不播（也不抛）
    expect(played).toHaveLength(before);
    paused.length = 0;

    await audioManager.setPreset("broken"); // ← 修正前的 bug 点：每次选本都 stopAll + 重拉
    expect(calls("broken")).toBe(1);
    expect(paused).toEqual([]); // stopAll 会对 4 个通道元素各 pause 一次：这里必须一次都没有
    expect(debugSpy.mock.calls.filter((c) => String(c[0]).includes("broken"))).toHaveLength(1); // 告警只留一行
  });

  it("索引在途：同一个本连发两次只打一次接口（在途早退，不再 stopAll）", async () => {
    /** 在途请求的释放钩子（此刻先占位，等模拟「索引还没回来」时替换成真的 resolve） */
    let release = () => {};
    let calls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (!String(input).includes("preset=inflight")) return jsonResponse({}, 404);
      calls += 1;
      await new Promise<void>((r) => {
        release = r;
      });
      return jsonResponse({ items: [] });
    });

    const first = audioManager.setPreset("inflight"); // 在途（换本那一次的 stopAll 是正常代价）
    expect(calls).toBe(1);
    const paused0 = paused.length;
    await audioManager.setPreset("inflight"); // 在途再选：直接早退
    expect(calls).toBe(1);
    expect(paused).toHaveLength(paused0); // 没有第二次 stopAll

    release();
    await first;
    audioManager.handle({ kind: "曲", name: "雨夜" }); // items 空：索引里没有它 → 静默不播
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("没有【曲】"))).toBe(true);
    expect(played).toEqual([]);
  });

  it("剧本没有 audio 目录（items 空）与无剧本上下文：全部静默 no-op，不抛", async () => {
    items = [];
    await audioManager.setPreset("demo");
    expect(() => {
      audioManager.handle({ kind: "曲", name: "雨夜" });
      audioManager.handle({ kind: "环境", name: "停" });
      audioManager.handle({ kind: "音效", name: "门响" });
    }).not.toThrow();
    expect(played).toEqual([]);

    await audioManager.setPreset(""); // 无剧本上下文：索引清空，请求直接丢
    expect(() => audioManager.handle({ kind: "曲", name: "雨夜" })).not.toThrow();
    expect(played).toEqual([]);
  });

  it("store 接线：selectPreset 换本先换索引；audio 事件转发到管理器且不碰画面/回合状态", async () => {
    useGameStore.getState().selectPreset(PRESET);
    expect(fetchMock).toHaveBeenCalledWith("/api/audio?preset=campus-summer", expect.anything());
    useGameStore.getState().selectPreset({ ...PRESET, id: "twilight-throne" });
    expect(fetchMock).toHaveBeenCalledWith("/api/audio?preset=twilight-throne", expect.anything());

    // 索引是 store 里 void 出去的异步：让出一个宏任务把 fetch/JSON 的微任务队列跑完（定长等待，无轮询）
    await new Promise((r) => setTimeout(r, 0));
    useGameStore.getState().handleEvent({ type: "audio", kind: "曲", name: "雨夜" });
    useGameStore.getState().handleEvent({ type: "audio", kind: "音效", name: "门响" });
    expect(decode(played.find((s) => s.includes("audio?p=")) ?? "")).toContain("曲-雨夜.mp3"); // 索引按新本的条目播
    expect(played.some((s) => decode(s).endsWith("/audio?p=sfx-门响"))).toBe(true);
    // 音频是完全的旁路：不写任何画面/回合字段
    expect(useGameStore.getState().received).toBe("");
    expect(useGameStore.getState().bgUrl).toBeNull();
  });
});

describe("App：Esc 关闭链里的设置屏（v1.6）", () => {
  beforeEach(() => {
    // App 挂载时订阅 SSE：jsdom 没有 EventSource，垫一个空壳（本组用例只关心 Esc 链）
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        close() {}
      },
    );
    useGameStore.setState({
      screen: "settings",
      screenReturn: "game",
      assetsPreview: null,
      drawerOpen: false,
      settings: { ...DEFAULT_SETTINGS },
    });
  });

  it("Esc 关设置 overlay 回进入前的屏（滑杆聚焦时同样生效——它不是「正在打字」的输入框）；捏人屏 Esc /「返回」都回世界线屏且不清牌面；捏人屏主角卡与两处开演入口、制作中屏的美术槽位与剧情图入口也都在 App 里落地", () => {
    render(<App />);
    const slider = screen.getByTestId("settings-master") as HTMLInputElement;
    slider.focus();
    expect(document.activeElement).toBe(slider);

    fireEvent.keyDown(document, { key: "Escape" });

    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.screenReturn).toBeNull();

    // 捏人屏（世界线屏 →「新世界线」）原是死路：Esc 必须回世界线屏，且把选卡/答题/世界 id 原样留着。
    // 重挂一次 App 让捏人屏是首屏（AnimatePresence mode="wait" 下换屏要等离场动画跑完，重挂免等）
    cleanup();
    useGameStore.setState({
      screen: "protagonist",
      screenReturn: null,
      selected: PRESET,
      cardAnswers: { 姓名: ["顾迟"] },
      worldId: "campus-summer-3",
      worldLabel: "campus-summer-3",
    });
    render(<App />);
    expect(screen.getByTestId("protagonist-screen")).toBeTruthy();
    expect(screen.getByTestId("protagonist-back").getAttribute("aria-label")).toBe("返回世界线");

    fireEvent.keyDown(document, { key: "Escape" });

    const p = useGameStore.getState();
    expect(p.screen).toBe("worlds");
    expect(p.screenReturn).toBeNull();
    expect(p.selected).toBe(PRESET);
    expect(p.cardAnswers).toEqual({ 姓名: ["顾迟"] });
    expect(p.worldId).toBe("campus-summer-3");

    // 头部「返回」是同一条出口（不重置运行态）
    cleanup();
    useGameStore.setState({ screen: "protagonist" });
    render(<App />);
    fireEvent.click(screen.getByTestId("protagonist-back"));
    expect(useGameStore.getState().screen).toBe("worlds");
    expect(useGameStore.getState().worldId).toBe("campus-summer-3");

    // 捏人屏的主角卡（v1.8）：右栏活体摘要 + 正文逐问 chip 两列各自成立，两处开演入口按「卡填完了吗」解锁
    cleanup();
    const cardPreset: Preset = { ...PRESET, protagonist_card: ["- 姓名: 顾迟 / 沈屿", "- 身份: 自由调查员 / 学生"] };
    const openingPrompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          openingPrompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 404);
      }),
    );
    useGameStore.setState({
      screen: "protagonist",
      screenReturn: null,
      selected: cardPreset,
      cardAnswers: {},
      worldId: "campus-summer-3",
      engineBusy: false,
    });
    render(<App />);

    // 未答的问题在右栏摘要里留「待定」占位（行位稳定，填卡时摘要不整块跳）
    expect(within(screen.getByTestId("protagonist-question-姓名")).getByRole("button", { name: "顾迟" })).toBeTruthy();
    expect(within(screen.getByTestId("protagonist-summary-姓名")).getByText("待定")).toBeTruthy();
    expect(screen.getByTestId("protagonist-card-summary").textContent).toContain("已填 0 / 2");
    // 卡没填完：两处开演入口都禁用（不许半截开演）
    expect((screen.getByTestId("protagonist-start") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("skip-preload") as HTMLButtonElement).disabled).toBe(true);

    // 快速开局：正文列的逐问区让位给提示条，入口随之解锁（用剧本预设主角，不必逐问作答）
    fireEvent.click(screen.getByTestId("quick-start"));
    expect(screen.getByTestId("quick-start-notice").textContent).toContain("将直接采用剧本预设的主角开始");
    expect(screen.queryByTestId("protagonist-question-姓名")).toBeNull();
    expect((screen.getByTestId("protagonist-start") as HTMLButtonElement).disabled).toBe(false);

    // 「重新捏人」退回填卡态：提示条收起、问题区回来、入口重新禁用
    fireEvent.click(screen.getByTestId("protagonist-regenerate"));
    expect(screen.queryByTestId("quick-start-notice")).toBeNull();
    expect(screen.getByTestId("protagonist-question-姓名")).toBeTruthy();
    expect((screen.getByTestId("protagonist-start") as HTMLButtonElement).disabled).toBe(true);

    // 逐问选满：摘要 chip 跟着变、入口解锁；「制作美术并开演」进制作屏，指令待命结尾（美术随后逐项发）
    fireEvent.click(within(screen.getByTestId("protagonist-question-姓名")).getByRole("button", { name: "顾迟" }));
    fireEvent.click(within(screen.getByTestId("protagonist-question-身份")).getByRole("button", { name: "自由调查员" }));
    expect(within(screen.getByTestId("protagonist-summary-姓名")).getByText("顾迟")).toBeTruthy();
    expect(screen.getByTestId("protagonist-card-summary").textContent).toContain("已填 2 / 2");
    fireEvent.click(screen.getByTestId("protagonist-start"));
    expect(useGameStore.getState().screen).toBe("crafting");
    expect(openingPrompts.at(-1)).toContain("主角卡：姓名=顾迟；身份=自由调查员");
    expect(openingPrompts.at(-1)).toContain("待命：只初始化，不开始剧情");

    // 另一个入口：快速开局 + 跳过美术 → 直接进游戏屏（指令换成跳过预载的结尾）
    cleanup();
    useGameStore.setState({ screen: "protagonist", selected: cardPreset, cardAnswers: {}, worldId: "campus-summer-3", engineBusy: false });
    render(<App />);
    fireEvent.click(screen.getByTestId("quick-start"));
    fireEvent.click(screen.getByTestId("skip-preload"));
    expect(useGameStore.getState().screen).toBe("game");
    expect(openingPrompts.at(-1)).toContain("快速开局：用剧本 quick_start 预设主角");
    expect(openingPrompts.at(-1)).toContain("跳过美术预载，直接开演。");

    // 制作中屏（App 按状态渲屏）：一个槽位一张卡（testid = 种类-名字），就绪的出图、进行中/失败项给状态
    cleanup();
    const preload: PreloadItem[] = [
      { kind: "portrait", name: "薇拉", variant: "", label: "薇拉", command: "美术：立绘 薇拉", state: "done", url: null },
      { kind: "background", name: "灰雀镇廉价旅店", variant: "", label: "灰雀镇廉价旅店", command: "美术：背景 灰雀镇廉价旅店", state: "running", url: null },
      { kind: "portrait", name: "沈屿", variant: "", label: "沈屿", command: "美术：立绘 沈屿", state: "failed", url: null },
    ];
    useGameStore.setState({
      screen: "crafting",
      screenReturn: null,
      chapterNo: 1,
      status: "美术进行中…",
      preloadPhase: "queue",
      preload,
      artReady: { 薇拉: "presets/campus-summer/assets/立绘-薇拉.jpg", 沈屿: "presets/campus-summer/assets/立绘-沈屿.jpg" },
      worldLabel: "",
    });
    render(<App />);

    const doneSlot = within(screen.getByTestId("crafting-slot-portrait-薇拉"));
    expect(doneSlot.getByRole("img").getAttribute("src")).toContain("立绘-薇拉.jpg");
    expect(doneSlot.getByText("就绪")).toBeTruthy();
    const runningSlot = within(screen.getByTestId("crafting-slot-background-灰雀镇廉价旅店"));
    expect(runningSlot.getAllByText("生成中")).toHaveLength(2); // 角标 + 状态行
    expect(runningSlot.getByText("灰雀镇廉价旅店")).toBeTruthy();
    const failedSlot = within(screen.getByTestId("crafting-slot-portrait-沈屿"));
    expect(failedSlot.getByText("失败")).toBeTruthy();
    expect(failedSlot.queryByRole("img")).toBeNull(); // artReady 里有图也不显示：失败项不许混进成品

    // 「查看剧情图」：开剧情图 overlay 并记住返回屏（制作中也能看图，回得来）
    fireEvent.click(screen.getByTestId("crafting-tree-link"));
    expect(useGameStore.getState().screen).toBe("tree");
    expect(useGameStore.getState().screenReturn).toBe("crafting");

    // 本文件的 afterEach 只 toTitle，牌面与运行态字段别漏给下一个用例
    useGameStore.setState({
      selected: null,
      cardAnswers: {},
      worldId: null,
      worldLabel: "",
      screen: "title",
      preload: [],
      artReady: {},
      preloadPhase: "init",
      status: "就绪",
      engineBusy: false,
      pendingTurnPrompt: null,
      lastTurnPrompt: null,
    });
  });
});

describe("WorldsScreen：改名 / 导出 / 导入（v1.6）", () => {
  const NOW = Date.now();
  /** 世界线条目构造器（只写用例关心的字段） */
  function world(over: Partial<WorldEntry> & { worldId: string }): WorldEntry {
    return {
      preset: "campus-summer",
      title: "盛夏偏差值",
      chapterNo: 1,
      lastPlayed: NOW - 60_000,
      note: "",
      forkedFrom: null,
      exists: true,
      ...over,
    };
  }
  /** GET /api/worlds 的清单（可被单个用例覆盖；update 成功后就地改它，模拟服务端回带新值） */
  let worldsResp: WorldEntry[];
  /** POST /api/worlds 收到的动作 */
  let worldPosts: Record<string, unknown>[];
  /** POST import 的返回（可被单个用例覆盖成失败） */
  let importResp: Record<string, unknown>;

  beforeEach(() => {
    worldsResp = [
      world({
        worldId: "campus-summer-2",
        label: "雨夜的岔口",
        note: "分叉自 campus-summer-1 @ 2-2",
        chapterNo: 2,
        lastPlayed: NOW - 5 * 60_000,
        forkedFrom: { worldId: "campus-summer-1", nodeId: "2-2" },
      }),
      world({ worldId: "campus-summer-1" }),
    ];
    worldPosts = [];
    importResp = { ok: true, worldId: "campus-summer-9" };
    useGameStore.setState({
      selected: PRESET,
      screen: "worlds",
      screenReturn: null,
      engineBusy: false,
      worldId: null,
      worldBusy: false,
      worldNotice: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string; worldId?: string; label?: string; note?: string };
          worldPosts.push(body);
          if (body.action === "update") {
            // 服务端落定后 listWorlds 应回带新值（空串=清除），屏内靠重取清单回显
            worldsResp = worldsResp.map((w) =>
              w.worldId === body.worldId ? { ...w, label: body.label ?? "", note: body.note ?? "" } : w,
            );
            return jsonResponse({ ok: true });
          }
          if (body.action === "import") return jsonResponse(importResp, importResp.ok ? 200 : 400);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("显示名用 label；label 与真实备注都在时备注降为次行；无 label 回退剧本名（旧版分叉备注不算备注）", async () => {
    worldsResp = [
      worldsResp[0], // label 雨夜的岔口 + 旧版分叉备注：次行不铺
      { ...worldsResp[1], label: "二周目", note: "第一次玩到这里" },
    ];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-2")).toBeTruthy());

    const labeled = within(screen.getByTestId("world-row-campus-summer-2"));
    expect(labeled.getByText("雨夜的岔口")).toBeTruthy();
    expect(labeled.queryByTestId("world-note-campus-summer-2")).toBeNull(); // 旧版分叉备注不上屏
    const both = within(screen.getByTestId("world-row-campus-summer-1"));
    expect(both.getByText("二周目")).toBeTruthy();
    expect(both.getByTestId("world-note-campus-summer-1").textContent).toBe("第一次玩到这里");

    // 纯函数：label 空白串视为未设置；回退链 label → note → 剧本名 → 未命名世界线（裸 id 永不上屏）
    expect(worldDisplayName(world({ worldId: "w", label: "  ", note: " 旧备注 " }))).toBe("旧备注");
    expect(worldDisplayName(world({ worldId: "w" }), "盛夏偏差值")).toBe("盛夏偏差值");
    expect(worldDisplayName(world({ worldId: "w" }))).toBe("未命名世界线");
    expect(worldDisplayName(world({ worldId: "w", note: "分叉自 w1 @ 2-2" }), "盛夏偏差值")).toBe("盛夏偏差值");
  });

  it("行内改名：编辑打开即聚焦显示名输入框；保存把 label/note 提交给 update 并重取清单回显", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-1")).toBeTruthy());
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));

    const label = screen.getByTestId("world-edit-label-campus-summer-1") as HTMLInputElement;
    expect(screen.getByTestId("world-editor-campus-summer-1")).toBeTruthy();
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull(); // 进编辑器顺手收菜单
    expect(label.value).toBe(""); // 初值取服务端现值（未设置=空串）
    expect(document.activeElement).toBe(label);
    expect(label.getAttribute("maxlength")).toBe("60");
    expect(screen.getByTestId("world-edit-note-campus-summer-1").getAttribute("maxlength")).toBe("200");
    expect(screen.getByLabelText("显示名（盛夏偏差值）")).toBe(label); // aria-label 用显示名，不露裸 id

    fireEvent.change(label, { target: { value: " 天台上的雨 " } });
    fireEvent.change(screen.getByTestId("world-edit-note-campus-summer-1"), { target: { value: "第一周目" } });
    fireEvent.click(screen.getByTestId("world-edit-save-campus-summer-1"));

    // 提交体只带 label/note（前后空白收敛掉），worldId 指认目标
    await waitFor(() =>
      expect(worldPosts).toEqual([
        { action: "update", worldId: "campus-summer-1", label: "天台上的雨", note: "第一周目" },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId("world-editor-campus-summer-1")).toBeNull());
    await waitFor(() =>
      expect(within(screen.getByTestId("world-row-campus-summer-1")).getByText("天台上的雨")).toBeTruthy(),
    );
    expect(screen.getByTestId("worlds-notice").textContent).toContain("已保存");
  });

  it("编辑器键盘：Enter 保存（组字中的 Enter 不算）、Esc 取消不发请求；清空显示名=清除并回退备注", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-2")).toBeTruthy());
    openRowMenu("campus-summer-2");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-2"));
    const label = screen.getByTestId("world-edit-label-campus-summer-2") as HTMLInputElement;
    expect(label.value).toBe("雨夜的岔口");

    fireEvent.change(label, { target: { value: "" } }); // 空串 = 清除显示名
    fireEvent.keyDown(label, { key: "Enter" });
    await waitFor(() =>
      expect(worldPosts.at(-1)).toEqual({
        action: "update",
        worldId: "campus-summer-2",
        label: "",
        note: "分叉自 campus-summer-1 @ 2-2",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("world-editor-campus-summer-2")).toBeNull());
    // 显示名清掉后：主行回退剧本名（旧版分叉备注不算备注）、次行仍不铺，分叉徽标还在
    await waitFor(() => expect(within(screen.getByTestId("world-row-campus-summer-2")).getByText("盛夏偏差值")).toBeTruthy());
    expect(within(screen.getByTestId("world-row-campus-summer-2")).queryByTestId("world-note-campus-summer-2")).toBeNull();
    expect(within(screen.getByTestId("world-row-campus-summer-2")).getByText("自《盛夏偏差值》延伸")).toBeTruthy();

    // Esc 取消：不发请求、编辑器收起（从 ⋯ 菜单进）
    const before = worldPosts.length;
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    fireEvent.keyDown(screen.getByTestId("world-edit-note-campus-summer-1"), { key: "Escape" });
    expect(screen.queryByTestId("world-editor-campus-summer-1")).toBeNull();
    expect(worldPosts).toHaveLength(before);

    // 中文输入法组字中的 Enter 不算保存
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    fireEvent.keyDown(screen.getByTestId("world-edit-label-campus-summer-1"), { key: "Enter", isComposing: true });
    expect(screen.getByTestId("world-editor-campus-summer-1")).toBeTruthy();
    expect(worldPosts).toHaveLength(before);

    // 「取消」按钮与 Esc 是同一条出口：编辑器收起、不发请求、半截改动丢掉（重开仍是服务端现值）
    fireEvent.change(screen.getByTestId("world-edit-label-campus-summer-1"), { target: { value: "半截改的名字" } });
    fireEvent.click(screen.getByTestId("world-edit-cancel-campus-summer-1"));
    expect(screen.queryByTestId("world-editor-campus-summer-1")).toBeNull();
    expect(worldPosts).toHaveLength(before);
    expect(within(screen.getByTestId("world-row-campus-summer-1")).getByText("盛夏偏差值")).toBeTruthy(); // 行内显示名原样
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    expect((screen.getByTestId("world-edit-label-campus-summer-1") as HTMLInputElement).value).toBe("");
  });

  it("改名失败：编辑器留在原地（玩家改的内容不丢），失败落在提示位", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          worldPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({ ok: false, error: "label 太长" }, 400);
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-2")).toBeTruthy());
    openRowMenu("campus-summer-2");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-2"));
    fireEvent.change(screen.getByTestId("world-edit-label-campus-summer-2"), { target: { value: "太长的名字" } });
    fireEvent.click(screen.getByTestId("world-edit-save-campus-summer-2"));

    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("保存失败：label 太长"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("error");
    expect(screen.getByTestId("world-editor-campus-summer-2")).toBeTruthy();
    expect((screen.getByTestId("world-edit-label-campus-summer-2") as HTMLInputElement).value).toBe("太长的名字");
  });

  it("导出：⋯ 菜单里的下载链接指向 /api/worlds/export 并带 <worldId>.world.json 文件名", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-1")).toBeTruthy());

    openRowMenu("campus-summer-1");
    const link = screen.getByTestId("world-export-campus-summer-1") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/worlds/export?worldId=campus-summer-1");
    expect(link.getAttribute("download")).toBe("campus-summer-1.world.json");
    // aria-label 用显示名（label 优先，绝不露裸 id）
    expect(link.getAttribute("aria-label")).toBe("导出世界线 盛夏偏差值");

    // 换另一行的菜单：链接随行，无障碍名跟着换（同屏只开一个菜单）
    openRowMenu("campus-summer-2");
    expect(screen.getByTestId("world-export-campus-summer-2").getAttribute("aria-label")).toBe("导出世界线 雨夜的岔口");
    expect(screen.queryByTestId("world-export-campus-summer-1")).toBeNull();
  });

  it("列表语义：listbox + option + roving tabIndex，↑↓ 只让光标行可 Tab；行内按钮 aria-label 含世界名", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "世界线" })).toBeTruthy());

    // 清单一到就会重挂键盘监听，但 jsdom 的 act 垫片（flushSync 版）会把这一轮 useEffect 推迟到下次 flush，
    // 不先冲刷就会打到「清单还是空」的旧监听上（浏览器里不存在这个窗口期）
    await act(async () => {});
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1"]);

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]),
    );
    expect(screen.getAllByRole("option").map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0"]);
    // roving tabIndex 的焦点也真的搬过去了（不能只是换个描边）
    expect(document.activeElement).toBe(screen.getByTestId("world-row-campus-summer-1"));

    expect(screen.getByLabelText("继续世界线 雨夜的岔口")).toBeTruthy();
    // 行内动作收在 ⋯ 菜单里：触发器与菜单项的无障碍名都用显示名（不露裸 worldId）
    fireEvent.pointerDown(screen.getByLabelText("世界线 盛夏偏差值 的更多操作"), { button: 0 });
    expect(screen.getByLabelText("改名世界线 盛夏偏差值")).toBeTruthy();
    expect(screen.getByLabelText("导出世界线 盛夏偏差值")).toBeTruthy();
    expect(screen.getByLabelText("删除世界线 盛夏偏差值")).toBeTruthy();
  });

  it("⋯ 菜单语义（v1.9 Radix）：菜单 ARIA、↑↓/Home/End 走位与 typeahead、Tab 走项、Esc 就地关闭（不冒到 Esc 关闭链）、点外面关闭、删除确认随关闭作废", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-1")).toBeTruthy());

    const trigger = screen.getByTestId("world-menu-campus-summer-1");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    openRowMenu("campus-summer-1");
    const popup = screen.getByTestId("world-menu-popup-campus-summer-1");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(popup).getByTestId("world-edit-campus-summer-1")).toBeTruthy();
    expect(within(popup).getByTestId("world-export-campus-summer-1")).toBeTruthy();
    expect(within(popup).getByTestId("world-delete-campus-summer-1")).toBeTruthy();
    // 菜单语义由原语给：role=menu 挂在弹层上、三项是 role=menuitem、弹层的无障碍名来自触发器
    expect(popup.getAttribute("role")).toBe("menu");
    expect(popup.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.getAttribute("aria-controls")).toBe(popup.id);
    const items = within(popup).getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual(["改名", "导出", "删除"]);
    // 默认向下展开（贴到视口底边时的翻面由 Radix 的 flip 负责，jsdom 量不出布局 → 浏览器级断言在 menu.spec.ts）
    expect(popup.getAttribute("data-side")).toBe("bottom");
    expect(popup.className).toContain("shell-panel");
    const edit = screen.getByTestId("world-edit-campus-summer-1");
    const exp = screen.getByTestId("world-export-campus-summer-1");
    const del = screen.getByTestId("world-delete-campus-summer-1");
    // 打开即把焦点送进第一项（鼠标路径也一样：Radix 默认只聚焦弹层，本屏把自己收齐）
    await waitFor(() => expect(document.activeElement).toBe(edit));
    // 屏级键盘监听带着「菜单开着就让位」的新守卫重挂是 effect 的事，jsdom 的 act 垫片会把它推迟到下次 flush
    //（浏览器里不存在这个窗口期）；不先冲刷，下面的方向键会打到「还不知道菜单开着」的旧监听上
    await act(async () => {});

    // ↑↓ / Home / End：roving 走位（v1.9 之前只有 Tab 能用）
    fireEvent.keyDown(edit, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(exp));
    fireEvent.keyDown(exp, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(del));
    fireEvent.keyDown(del, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(exp));
    fireEvent.keyDown(exp, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    fireEvent.keyDown(edit, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(del));

    // 走位归菜单：Home 回首项后，在首项上按 ↑ 是「菜单内的空步」（loop=false，不绕回去），
    // 屏级 handler 不许抢去做行导航（抢了的话焦点会跳到行上、列表光标也会挪走）。
    // 光标停在开着菜单的那一行是行自己的 onFocus 干的（菜单项是行的后代）
    fireEvent.keyDown(del, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    fireEvent.keyDown(edit, { key: "ArrowUp" });
    await act(async () => {});
    expect(document.activeElement).toBe(edit);
    expect(screen.getAllByRole("option").map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);

    // typeahead：按菜单项文案前缀跳项（「导」→ 导出）。Radix 的搜索串是「1s 内的连续按键拼接」，
    // 所以这里只按一次、不拼第二个字（拼了反而无匹配——那是它的约定，不是缺陷）
    fireEvent.keyDown(edit, { key: "导" });
    await waitFor(() => expect(document.activeElement).toBe(exp));

    // Tab 走项（本仓既有约定，e2e 也钉着）：Home 回首项后 Tab 依次走 改名 → 导出 → 删除；
    // 走到末项就把 Tab 交还页面，菜单随之收掉
    fireEvent.keyDown(exp, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    fireEvent.keyDown(edit, { key: "Tab" });
    expect(document.activeElement).toBe(exp);
    fireEvent.keyDown(exp, { key: "Tab" });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(del, { key: "Tab" });
    await waitFor(() => expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull());
    // 弹层是这一行 DOM 里最后的可聚焦块，文档序的下一站是右栏「继续上次」的按钮
    expect(document.activeElement).toBe(screen.getByTestId("worlds-resume-continue"));

    // Esc：就地关菜单并 stopPropagation——那一下不许冒到 App 的 Esc 关闭链（外面听不到）
    openRowMenu("campus-summer-1");
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(screen.getByTestId("world-menu-popup-campus-summer-1"), { key: "a" }); // 探针：没人拦的按键能冒到 document（证明下面不是空转）
    expect(outer).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId("world-menu-popup-campus-summer-1"), { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).toHaveBeenCalledTimes(1); // Esc 那一下被就地吃掉：App 的关闭链听不到
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    // 关菜单把焦点归还触发器（Radix 的 onCloseAutoFocus；卸载后一拍才做，故等一等）
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    // 删除 → 确认态；点菜单外面关闭：半截确认一起作废（重开回到第一屏），没发过请求
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-delete-campus-summer-1"));
    expect(screen.getByTestId("world-confirm-campus-summer-1")).toBeTruthy();
    expect(screen.getByTestId("world-cancel-campus-summer-1")).toBeTruthy();
    // 「删除」被换掉这一拍，焦点跟着挪到确认按钮上（否则掉回 body，键盘用户断线）
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("world-confirm-campus-summer-1")));
    // 点外面关：Radix 听的是 pointerdown（在事件派发一拍之后才挂上监听，先让那一拍跑完）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.pointerDown(document.body, { button: 0 });
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    expect(worldPosts).toEqual([]);
    openRowMenu("campus-summer-1");
    expect(screen.getByTestId("world-delete-campus-summer-1")).toBeTruthy();
    expect(screen.queryByTestId("world-confirm-campus-summer-1")).toBeNull();

    // 焦点 Tab 走出这一行 → 菜单立刻收掉（Radix 的 focusOutside）：不留「开着却没人管」的孤儿菜单
    expect(trigger.getAttribute("aria-expanded")).toBe("true"); // 上面刚重开的菜单还开着
    act(() => (screen.getByTestId("worlds-new") as HTMLElement).focus());
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // 焦点已不在菜单里时按 Esc：Radix 的 document 捕获监听兜住，且不许冒到 window ——
    // 那正是 App 的 Esc 关闭链（会把整屏关回标题屏）
    openRowMenu("campus-summer-1");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const outer2 = vi.fn();
    window.addEventListener("keydown", outer2);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", outer2);
    expect(outer2).not.toHaveBeenCalled();
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("导入：选中文件 → 校验通过后 POST import，成功刷新清单并出成功提示", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-import-input")).toBeTruthy());
    const bundle = {
      format: "bunkiten-world",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      world: {
        worldId: "campus-summer-9",
        preset: "campus-summer",
        title: "盛夏偏差值",
        label: "导进来的",
        note: "",
        chapterNo: 2,
        files: { state: null, summary: null, tree: null },
        snapshots: [],
      },
    };
    worldsResp = [...worldsResp, world({ worldId: "campus-summer-9", label: "导进来的" })];
    const file = new File([JSON.stringify(bundle)], "campus-summer-9.world.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("worlds-import-input"), { target: { files: [file] } });

    await waitFor(() => expect(worldPosts).toEqual([{ action: "import", bundle }]));
    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("已导入世界线 campus-summer-9"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("ok");
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-9")).toBeTruthy()); // 重取清单可见
  });

  it("导入失败：不是导出包本地挡下（不打服务端）；服务端拒绝走错误提示位", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-import-input")).toBeTruthy());

    const junk = new File(["这只是一段普通文本"], "note.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("worlds-import-input"), { target: { files: [junk] } });
    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("不是有效的世界线导出包"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("error");
    expect(worldPosts).toEqual([]);

    importResp = { ok: false, error: "bundle 校验失败" };
    const file = new File([JSON.stringify({ format: "bunkiten-world", version: 1, world: { worldId: "x" } })], "x.world.json");
    fireEvent.change(screen.getByTestId("worlds-import-input"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("导入失败：bundle 校验失败"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("error");
  });
});

describe("WorldsScreen：家谱视图（v1.7）", () => {
  const NOW = Date.now();
  /** 世界线条目构造器（只写用例关心的字段） */
  function world(over: Partial<WorldEntry> & { worldId: string }): WorldEntry {
    return {
      preset: "campus-summer",
      title: "盛夏偏差值",
      chapterNo: 1,
      lastPlayed: NOW - 60_000,
      note: "",
      forkedFrom: null,
      exists: true,
      ...over,
    };
  }
  /** GET /api/worlds 的清单（可被单个用例覆盖） */
  let worldsResp: WorldEntry[];

  beforeEach(() => {
    worldsResp = [
      world({ worldId: "w3", label: "三周目", forkedFrom: { worldId: "w2", nodeId: "3-1" }, lastPlayed: NOW - 60_000 }),
      world({ worldId: "w2", label: "二周目", forkedFrom: { worldId: "w1", nodeId: "2-2" }, lastPlayed: NOW - 3_600_000 }),
      world({ worldId: "w1", label: "一周目", lastPlayed: NOW - 2 * 86_400_000 }),
    ];
    useGameStore.setState({
      selected: PRESET,
      screen: "worlds",
      screenReturn: null,
      engineBusy: false,
      worldId: null,
      worldBusy: false,
      worldNotice: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("视图切换：家谱渲染 SVG 森林（节点+父子连线）并卸载列表行，切回列表恢复", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-row-w1")).toBeTruthy());
    expect(screen.getByTestId("worlds-view-list").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("worlds-view-genealogy").getAttribute("aria-pressed")).toBe("false");

    // aside「键盘」卡：屏级快捷键速查，键位随视图换一套（列表 = 行/菜单，家谱 = 走血缘节点）
    const keys = () => within(screen.getByTestId("worlds-keys-card"));
    expect(keys().getByText("选择世界线")).toBeTruthy();
    expect(keys().getByText("关菜单 / 返回标题")).toBeTruthy();

    fireEvent.click(screen.getByTestId("worlds-view-genealogy"));
    expect(keys().getByText("走血缘节点")).toBeTruthy();
    expect(keys().queryByText("选择世界线")).toBeNull();
    expect(screen.getByTestId("worlds-view-genealogy").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("worlds-view-list").getAttribute("aria-pressed")).toBe("false");
    const canvas = screen.getByTestId("genealogy-canvas");
    expect(canvas.tagName.toLowerCase()).toBe("svg");
    expect(screen.getByTestId("genealogy-node-w1")).toBeTruthy();
    expect(screen.getByTestId("genealogy-node-w2")).toBeTruthy();
    expect(screen.getByTestId("genealogy-node-w3")).toBeTruthy();
    expect(canvas.querySelectorAll(".genealogy-edge")).toHaveLength(2); // w1→w2、w2→w3
    // 列表行整块卸载：视图状态以行的存在与否为准
    expect(screen.queryByTestId("world-row-w1")).toBeNull();

    fireEvent.click(screen.getByTestId("worlds-view-list"));
    await waitFor(() => expect(screen.getByTestId("world-row-w1")).toBeTruthy());
    expect(screen.queryByTestId("genealogy-canvas")).toBeNull();
  });

  it("点节点出快捷条：方向键沿血缘走位（↑到父），「继续」复用 resumeWorld 发续档指令", async () => {
    const prompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-view-genealogy")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worlds-view-genealogy"));
    expect(screen.queryByTestId("genealogy-detail")).toBeNull(); // 未选中不出快捷条

    fireEvent.click(screen.getByTestId("genealogy-node-w3"));
    const detail = screen.getByTestId("genealogy-detail");
    expect(within(detail).getByText("三周目")).toBeTruthy();
    expect(within(detail).getByText(/第 1 章/)).toBeTruthy();

    // ↑ 沿 forkedFrom 走到父线：选中与 DOM 焦点都搬到 w2（roving tabIndex 不是只换描边）
    fireEvent.keyDown(screen.getByTestId("genealogy-node-w3"), { key: "ArrowUp" });
    await waitFor(() => expect(within(screen.getByTestId("genealogy-detail")).getByText("二周目")).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByTestId("genealogy-node-w2"));

    // 「继续」走的是列表行同一条路（resumeWorld → 继续世界：<id>。）
    fireEvent.click(screen.getByTestId("genealogy-continue-w2"));
    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.worldId).toBe("w2");
    expect(prompts.at(-1)).toBe("继续世界：w2。");
  });

  it("孤儿：forkedFrom 指向已删父线 → 节点标 ⌫ 徽章、按根落位、不画边；详情说明父线已删", async () => {
    worldsResp = [world({ worldId: "w1" }), world({ worldId: "w9", forkedFrom: { worldId: "ghost", nodeId: "9-9" } })];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-view-genealogy")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worlds-view-genealogy"));

    const badge = screen.getByTestId("genealogy-orphan-w9");
    expect(badge.textContent).toContain("⌫");
    expect(badge.textContent).toContain("⑂");
    expect(badge.textContent).not.toContain("9-9"); // 节点 id 不上屏：孤儿信号只留 ⌫ ⑂
    expect(screen.getByTestId("genealogy-canvas").querySelectorAll(".genealogy-edge")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("genealogy-node-w9"));
    expect(within(screen.getByTestId("genealogy-detail")).getByText("⌫ 父线已删")).toBeTruthy();
    // 「查看」跳回列表视图并聚焦对应行
    fireEvent.click(screen.getByTestId("genealogy-view-w9"));
    await waitFor(() => expect(screen.getByTestId("world-row-w9")).toBeTruthy());
    expect(screen.queryByTestId("genealogy-canvas")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("world-row-w9"));
  });

  it("空世界：家谱视图下同样显示空态文案，不出画布", async () => {
    worldsResp = [];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worlds-view-genealogy"));
    expect(screen.getByTestId("worlds-empty")).toBeTruthy();
    expect(screen.getByText(/还没有世界线/)).toBeTruthy();
    expect(screen.queryByTestId("genealogy-canvas")).toBeNull();
  });
});

describe("AssetsScreen：选择模式、批量重绘与批量删除（v1.6）", () => {
  // v1.5.1 资产随剧本走（presets/<preset>/assets/，封面是 presets/<preset>/cover.jpg）
  const asset = (over: Partial<AssetEntry> & Pick<AssetEntry, "type" | "name" | "file">): AssetEntry => ({
    variant: "",
    preset: "campus-summer",
    ready: true,
    inUse: false,
    mtime: 1,
    ...over,
  });
  const FILE_PORTRAIT = "presets/campus-summer/assets/立绘-薇拉.jpg";
  const FILE_VARIANT = "presets/campus-summer/assets/立绘-薇拉-微笑.jpg";
  const FILE_BG = "presets/campus-summer/assets/背景-灰雀镇廉价旅店.jpg";
  const FILE_COVER = "presets/campus-summer/cover.jpg";
  let assetsResp: AssetEntry[];
  /** POST /api/assets 收到的删除请求（按顺序） */
  let assetPosts: { action: string; preset?: string; file?: string }[];
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  /** 模拟引擎跑完一个重绘回合（marker 给 【图…|重绘 标记时该条视为已换图） */
  async function engineTurn(marker?: string) {
    await act(async () => {
      const s = useGameStore.getState();
      s.handleEvent({ type: "turn_start" });
      if (marker) s.handleEvent({ type: "chunk", seg: 0, text: marker });
      s.handleEvent({ type: "turn_end" });
    });
  }

  beforeEach(() => {
    assetsResp = [
      asset({ type: "立绘", name: "薇拉", file: FILE_PORTRAIT, inUse: true }),
      asset({ type: "立绘", name: "薇拉", variant: "微笑", file: FILE_VARIANT, mtime: 2 }),
      asset({ type: "背景", name: "灰雀镇廉价旅店", file: FILE_BG, mtime: 3 }),
      asset({ type: "封面", name: "盛夏偏差值", file: FILE_COVER, mtime: 4 }),
    ];
    assetPosts = [];
    prompts = [];
    useGameStore.setState({
      selected: PRESET,
      screen: "assets",
      screenReturn: "game",
      assetsPreview: null,
      assetsStamp: 0,
      regenPending: null,
      regenQueue: [],
      regenTotal: 0,
      regenDone: 0,
      regenFailed: [],
      regenNotice: null,
      assetsNotice: null,
      assetsBusy: false,
      engineBusy: false,
      // 排队指令位也是单例上的脏状态（创作屏用例会写它）：不清掉会让重绘队列「等排队指令先发」
      pendingCreationMessage: null,
      pendingTreeMessage: null,
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/assets" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { file: string };
        assetPosts.push(body);
        // 请求体已收敛为单层文件名（postAssetDelete），清单条目是完整相对路径：按 basename 命中移除
        assetsResp = assetsResp.filter((a) => a.file !== body.file && !a.file.endsWith("/" + body.file));
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/assets") {
        return url.searchParams.get("preset") === "campus-summer"
          ? jsonResponse(assetsResp)
          : jsonResponse({ error: "preset required" }, 400);
      }
      if (url.pathname === "/prompt") {
        prompts.push(JSON.parse(String(init?.body)).text);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("选择模式：卡片带 checkbox，全选/清空实时显示可重绘与可删除数量（封面不进删除）", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉")).toBeTruthy());
    expect(screen.queryByTestId("assets-toolbar")).toBeNull(); // 浏览模式没有批量工具

    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    expect(screen.getByTestId("assets-toolbar")).toBeTruthy();
    expect(screen.getByLabelText("选择 立绘-薇拉")).toBeTruthy();
    expect(screen.getByLabelText("选择 立绘-薇拉 · 微笑")).toBeTruthy();
    expect(screen.getByLabelText("选择 背景-灰雀镇廉价旅店")).toBeTruthy();

    fireEvent.click(screen.getByTestId("assets-select-all"));
    for (const label of ["选择 立绘-薇拉", "选择 立绘-薇拉 · 微笑", "选择 背景-灰雀镇廉价旅店", "选择 封面-盛夏偏差值"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(true);
    }
    expect(screen.getByTestId("assets-regen-selected").textContent).toContain("重绘选中(4)");
    // 封面可重绘但不可删（服务端只受理 assets 目录下的 *.jpg）
    expect(screen.getByTestId("assets-delete-selected").textContent).toContain("删除选中(3)");
    expect(screen.getByText(/封面不参与批量删除/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("assets-select-none"));
    expect((screen.getByLabelText("选择 立绘-薇拉") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("assets-regen-selected") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("assets-delete-selected") as HTMLButtonElement).disabled).toBe(true);

    // 单点勾选即可起跑；退出选择把工具栏与 checkbox 一起收掉
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));
    expect((screen.getByTestId("assets-regen-selected") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("assets-exit-select"));
    expect(screen.queryByTestId("assets-toolbar")).toBeNull();
    expect(screen.queryByLabelText("选择 立绘-薇拉")).toBeNull();
  });

  it("选择模式下点卡片不误开预览（带下标的卡片 testid 仍在）", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByTestId("asset-card-薇拉-微笑"));
    expect(useGameStore.getState().assetsPreview).toBeNull();
  });

  it("批量删除：两段确认，第二段按勾选顺序逐条 POST delete，完成后刷新清单并落成功提示", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByLabelText("选择 背景-灰雀镇廉价旅店"));
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));

    fireEvent.click(screen.getByTestId("assets-delete-selected"));
    expect(assetPosts).toEqual([]); // 首点只进确认态
    expect(screen.getByTestId("assets-delete-confirm").textContent).toContain("确认删除(2)");

    fireEvent.click(screen.getByTestId("assets-delete-confirm"));
    // 删除在途：忙碌条在（逐条删完才收）——玩家知道这一下点住了
    expect(screen.getByTestId("assets-busy").textContent).toBe("删除中…");
    await waitFor(() => expect(assetPosts).toHaveLength(2));
    expect(screen.queryByTestId("assets-busy")).toBeNull(); // 收尾即撤（提示位换成结果）
    // 顺序=勾选顺序；file 是 postAssetDelete 收敛后的单层文件名（服务端 ASSET_DELETE_FILE_RE 契约）
    expect(assetPosts.map((p) => p.file)).toEqual(["背景-灰雀镇廉价旅店.jpg", "立绘-薇拉.jpg"]);
    expect(assetPosts.every((p) => p.action === "delete" && p.preset === "campus-summer")).toBe(true);

    await waitFor(() => expect(screen.getByTestId("assets-notice").textContent).toContain("已删除 2 项素材"));
    expect(screen.getByTestId("assets-notice").getAttribute("data-kind")).toBe("ok");
    // 收尾重取清单：删掉的卡片从画廊消失（薇拉的差分还在，组不会整块消失）
    await waitFor(() => expect(screen.queryByTestId("asset-card-薇拉")).toBeNull());
    expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy();
    expect(screen.queryByTestId("asset-card-灰雀镇廉价旅店")).toBeNull();
  });

  it("批量删除：取消不发请求；失败走错误提示位", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));

    fireEvent.click(screen.getByTestId("assets-delete-selected"));
    fireEvent.click(screen.getByTestId("assets-delete-cancel"));
    expect(assetPosts).toEqual([]);
    expect(screen.getByTestId("assets-delete-selected")).toBeTruthy(); // 回到未确认态

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/assets" && init?.method === "POST") {
        assetPosts.push(JSON.parse(String(init.body)));
        return jsonResponse({ error: "文件不存在" }, 404);
      }
      if (url.pathname === "/api/assets") return jsonResponse(assetsResp);
      return jsonResponse({}, 404);
    });
    fireEvent.click(screen.getByTestId("assets-delete-selected"));
    fireEvent.click(screen.getByTestId("assets-delete-confirm"));
    await waitFor(() => expect(screen.getByTestId("assets-notice").getAttribute("data-kind")).toBe("error"));
    expect(screen.getByTestId("assets-notice").textContent).toContain("已删除 0/1 项");
    expect(screen.getByTestId("assets-notice").textContent).toContain("文件不存在");
  });

  it("批量重绘：顺序队列逐条发指令、显示「重绘中 i/N」，收尾出完成提示", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));
    fireEvent.click(screen.getByLabelText("选择 背景-灰雀镇廉价旅店"));
    fireEvent.click(screen.getByTestId("assets-regen-selected"));

    // 只发第一条（顺序队列：一条收尾才发下一条，都挤在一起必然 409）
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉"]);
    expect(screen.getByTestId("assets-regen-progress").textContent).toContain("重绘中 1/2");

    await engineTurn("【图】立绘|薇拉|presets/campus-summer/assets/立绘-薇拉.jpg|重绘\n");
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉", "美术：重绘 背景 灰雀镇廉价旅店"]);
    expect(screen.getByTestId("assets-regen-progress").textContent).toContain("重绘中 2/2");

    await engineTurn("【图】背景|灰雀镇廉价旅店|presets/campus-summer/assets/背景-灰雀镇廉价旅店.jpg|重绘\n");
    expect(screen.queryByTestId("assets-regen-progress")).toBeNull();
    expect(screen.getByTestId("assets-regen-notice").textContent).toContain("重绘完成：2 项已换图");
  });

  it("预览模态：role=dialog + aria-modal + 关闭按钮聚焦；单项重绘仍是同一条流水线（N=1）", async () => {
    const { container } = render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());
    // 壳层根（ScreenShell）就是本屏的滚动容器：关着预览时既没有滚动锁、背景也没被压住
    const scrollRoot = container.firstElementChild as HTMLElement;
    expect(scrollRoot.className).toContain("shell-backdrop");
    expect(scrollRoot.className).not.toContain("scroll-locked");
    expect(screen.getByTestId("shell-page").hasAttribute("inert")).toBe(false);
    const card = screen.getByTestId("asset-card-薇拉-微笑");
    card.focus(); // 真实浏览器里点按钮就会聚焦它；jsdom 的 click 不搬焦点，这里显式落一次（关闭归还的断言要用）
    fireEvent.click(card);

    // —— v1.9 a11y：预览打开 → 背景整页框 inert + 壳层根滚动锁；模态自己不在 inert 子树里 ——
    const page = screen.getByTestId("shell-page");
    expect(page.hasAttribute("inert")).toBe(true);
    expect(card.closest("[inert]")).toBe(page); // 打开预览的那张卡片确实被压住（本来 Tab 一转身就回到它）
    expect(scrollRoot.className).toContain("scroll-locked"); // 滚动锁的契约就是这一个类（jsdom 不滚，断类名）
    const dialog = screen.getByRole("dialog");
    expect(dialog.closest("[inert]")).toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("素材预览：薇拉 · 微笑");
    const close = screen.getByTestId("assets-preview-close");
    expect(close.getAttribute("aria-label")).toBe("关闭预览");
    // 焦点进模态（而不是被背景的 inert 挡住）：inert 子树里的元素连程序化 focus 都是 no-op，
    // 所以「焦点陷阱能把焦点送进来」与「背景已 inert」这两条必须同时成立——顺序错了这条会红
    await waitFor(() => expect(document.activeElement).toBe(close));

    // 焦点陷阱（v1.9）：面板里可 Tab 到的是「关闭 + 重新生成」两枚；两端回绕，Tab 走不到画廊
    const regen = screen.getByTestId("assets-preview-regen");
    expect(focusableElements(dialog)).toEqual([close, regen]);
    regen.focus();
    pressTab(); // 末 → 首
    expect(document.activeElement).toBe(close);
    pressTab(true); // 首 → 末（Shift+Tab 同一条回绕规则，方向相反）
    expect(document.activeElement).toBe(regen);

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉-微笑"]);
    expect(screen.getByTestId("assets-regen-progress").textContent).toContain("重绘中 1/1");

    await engineTurn("【图】立绘|薇拉-微笑|presets/campus-summer/assets/立绘-薇拉-微笑.jpg|重绘\n");
    await waitFor(() => expect(screen.getByTestId("assets-regen-notice").textContent).toContain("重绘完成：1 项已换图"));

    // 关闭走 store（App 的 Esc 链与点遮罩同一条路）；退场动画期间节点还在，只断言状态
    fireEvent.click(close);
    expect(useGameStore.getState().assetsPreview).toBeNull();
    // 关闭即解锁：背景摘掉 inert、壳层根摘掉滚动锁（inert 的摘除在提交的变更阶段，
    // 早于焦点陷阱的清理——所以下一次快照能真的把焦点还给卡片而不是被 inert 顶掉）
    expect(screen.getByTestId("shell-page").hasAttribute("inert")).toBe(false);
    expect(scrollRoot.className).not.toContain("scroll-locked");
    // 关闭归还焦点：回到开启预览前拿焦点的那张卡片（层没了，焦点不该掉回 body）
    expect(document.activeElement).toBe(card);
  });

  it("引擎忙：批量重绘按钮禁用且不起跑（不抢发指令）", async () => {
    useGameStore.setState({ engineBusy: true });
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByTestId("assets-select-all"));

    expect((screen.getByTestId("assets-regen-selected") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("assets-regen-selected"));
    expect(prompts).toEqual([]);
    expect(useGameStore.getState().regenQueue).toEqual([]);
  });
});

// ————————————————————— v1.6 第二段：剧情图快照 / 大图降级 / 游戏键盘 / 状态播报 —————————————————————

/** viewBox 解析成 [x, y, w, h]（断言缩放比例用） */
function box(attr: string | null): number[] {
  return (attr ?? "").split(" ").map(Number);
}

describe("StoryTreeScreen：快照标注、原地回退与分叉带 seq（v1.6）", () => {
  // 四个节点覆盖三种状态：2-1/2-2/2-4 已走过（前两个有快照、2-4 没有），2-3 已剪枝
  const TREE_MD = [
    "# 剧情树",
    "## 归档",
    "- 第 1 章：教室相遇；已走：1-1 → 1-2",
    "",
    "## 第 2 章：雨夜来客",
    "- 目标: 建立信任或敌意",
    "- 当前进度: 节点 2-2（已走 3 轮）",
    "",
    "### 节点 2-1（来客敲门）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿、来客",
    "- 梗概: 深夜有人敲门",
    "- 出边: 开门 → 2-2",
    "- 状态: 已走过",
    "",
    "### 节点 2-2（门外的雨声）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿、来客",
    "- 梗概: 来客淋着雨递上一封信",
    "- 出边: 接过信 → 2-4",
    "- 状态: 已走过",
    "",
    "### 节点 2-3（假装睡着）",
    "- 地点: 灰雀镇旅店",
    "- 梗概: 走廊里传来拖拽声",
    "- 状态: 已剪枝",
    "",
    "### 节点 2-4（信里的名字）",
    "- 地点: 灰雀镇旅店",
    "- 梗概: 信上的名字是她自己",
    "- 状态: 已走过",
  ].join("\n");

  /** 快照索引：2-1 最早是 #3；2-2 有 #7（turn）与 #9（backup，回退前备份，最早匹配仍是 #7）；#11 不挂节点 */
  const SNAPSHOTS: WorldSnapshotMeta[] = [
    { seq: 3, at: "2026-01-01T00:00:00.000Z", kind: "turn", nodeId: "2-1", chapterNo: 2 },
    { seq: 7, at: "2026-01-01T01:00:00.000Z", kind: "turn", nodeId: "2-2", chapterNo: 2 },
    { seq: 9, at: "2026-01-01T02:00:00.000Z", kind: "backup", nodeId: "2-2", chapterNo: 2 },
    { seq: 11, at: "2026-01-01T03:00:00.000Z", kind: "turn", nodeId: null, chapterNo: 2 },
  ];

  let snapshots: WorldSnapshotMeta[] = [];
  /** GET /api/history 被调了几次（回退后应重取：节点标注与「最早快照」映射都变了） */
  let historyCalls = 0;
  /** POST /api/worlds 收到的动作（按顺序） */
  let worldPosts: Record<string, unknown>[] = [];
  /** restore 的返回（单个用例可覆盖成失败） */
  let restoreResp: Record<string, unknown> = { ok: true, backupSeq: 12 };

  beforeEach(() => {
    snapshots = SNAPSHOTS;
    historyCalls = 0;
    worldPosts = [];
    restoreResp = { ok: true, backupSeq: 12 };
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "tree",
      screenReturn: "game",
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/tree") return jsonResponse({ worldId: "campus-summer-1", markdown: TREE_MD });
        if (url.pathname === "/api/history") {
          historyCalls += 1;
          return jsonResponse({ worldId: "campus-summer-1", snapshots });
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          if (body.action === "fork") return jsonResponse({ ok: true, worldId: "campus-summer-3" });
          if (body.action === "restore") return jsonResponse(restoreResp, restoreResp.ok ? 200 : 400);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/prompt") return jsonResponse({ ok: true });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("详情显示最早匹配快照（#7 · 第 2 轮，不是更晚的 backup #9）；节点 aria-label 同步带轮次", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    expect(screen.getByLabelText("节点 2-2 · 已走过 · 存档点 · 第 7 幕")).toBeTruthy();
    expect(screen.getByLabelText("节点 2-1 · 已走过 · 存档点 · 第 3 幕")).toBeTruthy();
    expect(screen.getByLabelText("节点 2-4 · 已走过")).toBeTruthy(); // 没有快照：标签保持旧口径

    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    expect(screen.getByTestId("tree-snapshot-2-2").textContent).toBe("存档点 · 第 7 幕");
    expect(screen.getByTestId("tree-restore-2-2")).toBeTruthy();

    // 换到没有快照的节点：新按钮与标注一起消失（旧世界零打扰）
    fireEvent.click(screen.getByTestId("tree-node-2-4"));
    expect(screen.queryByTestId("tree-snapshot-2-4")).toBeNull();
    expect(screen.queryByTestId("tree-restore-2-4")).toBeNull();
    expect(screen.getByTestId("tree-fork-2-4")).toBeTruthy();
  });

  it("原地回退：两步确认（首点只进确认态），确认后 POST restore 并刷新树与快照索引", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const stamp0 = useGameStore.getState().treeStamp;
    const calls0 = historyCalls;

    fireEvent.click(screen.getByTestId("tree-node-2-1"));
    fireEvent.click(screen.getByTestId("tree-restore-2-1"));
    expect(worldPosts).toEqual([]); // 破坏性动作：首点不落请求
    expect(screen.getByTestId("tree-restore-confirm-2-1")).toBeTruthy();

    // 取消也是两段确认的一半：不发请求、回到未确认态
    fireEvent.click(screen.getByTestId("tree-restore-cancel-2-1"));
    expect(worldPosts).toEqual([]);
    expect(screen.getByTestId("tree-restore-2-1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tree-restore-2-1"));
    fireEvent.click(screen.getByTestId("tree-restore-confirm-2-1"));

    await waitFor(() => expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 3 }]));
    await waitFor(() => expect(screen.getByTestId("tree-notice").textContent).toContain("已回到第 3 幕"));
    expect(screen.getByTestId("tree-notice").textContent).toContain("回退前的进度已备份");
    expect(useGameStore.getState().treeStamp).toBe(stamp0 + 1);
    await waitFor(() => expect(historyCalls).toBeGreaterThan(calls0)); // 回退后重取快照索引
  });

  it("回退失败：提示走 treeNotice，树不刷新（treeStamp 不动）", async () => {
    restoreResp = { ok: false, error: "快照已不存在" };
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const stamp0 = useGameStore.getState().treeStamp;

    fireEvent.click(screen.getByTestId("tree-node-2-1"));
    fireEvent.click(screen.getByTestId("tree-restore-2-1"));
    fireEvent.click(screen.getByTestId("tree-restore-confirm-2-1"));

    await waitFor(() => expect(screen.getByTestId("tree-notice").textContent).toContain("回退失败：快照已不存在"));
    expect(useGameStore.getState().treeStamp).toBe(stamp0);
  });

  it("在此分叉：有快照的节点带 seq（精确），无快照的节点载荷与 v1.5 逐字一致", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tree-node-2-1"));
    fireEvent.click(screen.getByTestId("tree-fork-2-1"));
    await waitFor(() =>
      expect(worldPosts).toStrictEqual([{ action: "fork", worldId: "campus-summer-1", nodeId: "2-1", seq: 3 }]),
    );

    fireEvent.click(screen.getByTestId("tree-node-2-4"));
    fireEvent.click(screen.getByTestId("tree-fork-2-4"));
    // toStrictEqual（不是 toEqual）：无快照时载荷里连 seq 键都不许出现
    await waitFor(() =>
      expect(worldPosts.at(-1)).toStrictEqual({ action: "fork", worldId: "campus-summer-1", nodeId: "2-4" }),
    );
  });

  it("无快照的旧世界：不显示回退按钮、分叉不带 seq，树照常画（一切按现状降级）", async () => {
    snapshots = [];
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    expect(screen.queryByTestId("tree-restore-2-2")).toBeNull();
    expect(screen.queryByTestId("tree-snapshot-2-2")).toBeNull();
    expect(screen.getByLabelText("节点 2-2 · 已走过")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tree-fork-2-2"));
    await waitFor(() =>
      expect(worldPosts.at(-1)).toStrictEqual({ action: "fork", worldId: "campus-summer-1", nodeId: "2-2" }),
    );
  });

  it("快照纯函数：轮次按正戏回合计（backup 不新开一轮），节点映射取最早那条且忽略 nodeId 为空的", () => {
    expect(snapshotTurnNo(SNAPSHOTS, 3)).toBe(1);
    expect(snapshotTurnNo(SNAPSHOTS, 7)).toBe(2);
    expect(snapshotTurnNo(SNAPSHOTS, 9)).toBe(2); // backup #9 仍属第 2 轮
    expect(snapshotTurnNo(SNAPSHOTS, 11)).toBe(3);

    const map = earliestSnapshotByNode(SNAPSHOTS);
    expect(map.get("2-1")).toEqual({ seq: 3, turn: 1 });
    expect(map.get("2-2")).toEqual({ seq: 7, turn: 2 });
    expect(map.has("2-4")).toBe(false);
    expect([...map.keys()]).toEqual(["2-1", "2-2"]); // nodeId=null 的快照不入表
    // 乱序输入也按 seq 取最早
    expect(earliestSnapshotByNode([SNAPSHOTS[1], SNAPSHOTS[0]]).get("2-1")).toEqual({ seq: 3, turn: 1 });
    expect(earliestSnapshotByNode([]).size).toBe(0);
  });
});

describe("StoryTreeScreen：快照对比 diff 面板（v1.7）", () => {
  /** 两节点小树：2-1 / 2-2 已走过且都有快照（v1.6 组同款形状，独立维护免得两组耦合） */
  const TREE_MD = [
    "# 剧情树",
    "## 第 2 章：雨夜来客",
    "- 当前进度: 节点 2-2（已走 2 轮）",
    "",
    "### 节点 2-1（来客敲门）",
    "- 地点: 旅店",
    "- 状态: 已走过",
    "",
    "### 节点 2-2（门外的雨声）",
    "- 地点: 旅店",
    "- 状态: 已走过",
  ].join("\n");

  /** 快照索引：#1 挂 2-1（全局最小，没有对比基线）、#3 挂 2-2（基线是 #1） */
  const SNAPSHOTS: WorldSnapshotMeta[] = [
    { seq: 1, at: "2026-01-01T00:00:00.000Z", kind: "turn", nodeId: "2-1", chapterNo: 2 },
    { seq: 3, at: "2026-01-01T01:00:00.000Z", kind: "turn", nodeId: "2-2", chapterNo: 2 },
  ];

  /** state.md 造 10 行 equal 前缀 + 改动行 + 10 行 equal 后缀（折叠视图需要足够长的未变段） */
  const STATE_PREFIX = ["# 剧情状态", "周目: 1", "时间: 深夜", "场景: 旅店大堂", "张力: 中", "在场: 沈屿、来客", "天气: 雨", "道具: 信", "线索: 缺页", "地点: 二楼"].join("\n");
  const STATE_SUFFIX = ["伏笔: 拖拽声", "目标: 拆穿", "好感: 中立", "信任: 低", "警觉: 高", "体力: 正常", "情绪: 平稳", "衣着: 湿透", "照明: 烛火", "门: 关"].join("\n");
  /** seq → 三文件全文（fetchSnapshot mock 数据；tree 两边全等 → 「无变化」tab） */
  const FILES: Record<number, { state: string; summary: string; tree: string }> = {
    1: { state: `${STATE_PREFIX}\n好感度: 42\n${STATE_SUFFIX}`, summary: "第 1 轮：门口初遇。", tree: TREE_MD },
    3: { state: `${STATE_PREFIX}\n好感度: 55\n${STATE_SUFFIX}`, summary: "第 2 轮：门外的雨声。", tree: TREE_MD },
  };

  /** 打开后让单条快照拉取 404（失败态用例打开） */
  let snapshotFail = false;

  beforeEach(() => {
    snapshotFail = false;
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "tree",
      screenReturn: "game",
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/tree") return jsonResponse({ worldId: "campus-summer-1", markdown: TREE_MD });
        if (url.pathname === "/api/history") {
          const seq = Number(url.searchParams.get("seq") ?? "");
          if (seq) {
            // fetchSnapshot 的单条全文（面板拉当前 + 基线各一次）
            const files = FILES[seq];
            if (!files || snapshotFail) return jsonResponse({ error: "not found" }, 404);
            const meta = SNAPSHOTS.find((s) => s.seq === seq)!;
            return jsonResponse({ worldId: "campus-summer-1", snapshots: [{ ...meta, files }] });
          }
          return jsonResponse({ worldId: "campus-summer-1", snapshots: SNAPSHOTS });
        }
        return jsonResponse({}, 404);
      }),
    );
  });

  it("按钮出现条件：全局最小快照（无基线）不显示，有更早快照才显示；基线取 seq 更小的最近一条（kind 不限）", async () => {
    // 纯函数：#1 没有基线；#3 的基线是 #1；backup 混在中间也算基线（回退后的第一个对比有得比）
    expect(prevSnapshotSeq(SNAPSHOTS, 1)).toBeNull();
    expect(prevSnapshotSeq(SNAPSHOTS, 3)).toBe(1);
    expect(
      prevSnapshotSeq([...SNAPSHOTS, { seq: 2, at: "2026-01-01T00:30:00.000Z", kind: "backup", nodeId: "2-1", chapterNo: 2 }], 3),
    ).toBe(2);

    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    // 2-1 的快照 #1 是全局最小：有快照标注但没有对比入口
    fireEvent.click(screen.getByTestId("tree-node-2-1"));
    expect(screen.getByTestId("tree-snapshot-2-1").textContent).toContain("存档点 · 第 1 幕");
    expect(screen.queryByTestId("snapshot-diff-open")).toBeNull();

    // 2-2 的快照 #3 有基线 #1：入口出现并写明区间
    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    expect(screen.getByTestId("snapshot-diff-open").textContent).toContain("第 1 幕 → 第 3 幕");
  });

  it("打开面板：三 tab（state/summary/tree）+ tab 头 +N −M / 无变化，remove/add 行按基线→当前着色", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    fireEvent.click(screen.getByTestId("snapshot-diff-open"));

    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toBeTruthy());
    // 默认 tab 是剧情状态：好感度一行被替换（remove 旧值在前、add 新值在后）
    expect(screen.getByTestId("diff-row-remove").textContent).toContain("好感度: 42");
    expect(screen.getByTestId("diff-row-add").textContent).toContain("好感度: 55");
    expect(screen.queryByTestId("snapshot-diff-loading")).toBeNull();

    // 三个 tab 都在；state 头 +1 −1，tree 两边全等显示「无变化」
    expect(screen.getByTestId("snapshot-diff-tab-state").textContent).toContain("+1 −1");
    expect(screen.getByTestId("snapshot-diff-tab-summary").textContent).toContain("+1 −1");
    expect(screen.getByTestId("snapshot-diff-tab-tree").textContent).toContain("无变化");

    // 切到前情摘要：换一组的改动行
    fireEvent.click(screen.getByTestId("snapshot-diff-tab-summary"));
    expect(screen.getByTestId("diff-row-remove").textContent).toContain("第 1 轮");
    expect(screen.getByTestId("diff-row-add").textContent).toContain("第 2 轮");

    // ARIA tabs 语义与键盘走位：三个 tab 是一组（roving tabIndex），←→ 循环、Home/End 跳首尾，
    // panel 用 aria-labelledby 指向当前 tab
    const tablist = screen.getByRole("tablist", { name: "存档点对比" });
    expect(screen.getByTestId("snapshot-diff-tab-summary").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("snapshot-diff-tab-summary").getAttribute("tabindex")).toBe("0");
    expect(screen.getByTestId("snapshot-diff-tab-state").getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("snapshot-diff-tab-summary");

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByTestId("snapshot-diff-tab-tree").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByTestId("snapshot-diff-tab-tree"));

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(screen.getByTestId("snapshot-diff-tab-state").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("snapshot-diff-tab-state");

    fireEvent.keyDown(tablist, { key: "End" });
    expect(screen.getByTestId("snapshot-diff-tab-tree").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "ArrowLeft" }); // 循环：末个 ← 回到中间
    expect(screen.getByTestId("snapshot-diff-tab-summary").getAttribute("aria-selected")).toBe("true");
  });

  it("equal 折叠：默认只留改动行上下 ±2 行 + 「…共 N 行未变」，点 gap 展开全部", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    fireEvent.click(screen.getByTestId("snapshot-diff-open"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toBeTruthy());

    // 21 行 state（10 equal + remove + add + 10 equal）：默认上下各 2 行 equal 保留，前后各 8 行折叠
    expect(screen.getAllByTestId("diff-row-equal").length).toBe(4);
    const gaps = screen.getAllByTestId("snapshot-diff-gap");
    expect(gaps.map((g) => g.textContent)).toEqual(["…共 8 行未变（点击展开）", "…共 8 行未变（点击展开）"]);

    fireEvent.click(gaps[0]!);
    // 展开后全部 20 行 equal 在场、gap 消失（切 tab 才回到折叠视图）
    expect(screen.getAllByTestId("diff-row-equal").length).toBe(20);
    expect(screen.queryByTestId("snapshot-diff-gap")).toBeNull();
  });

  it("失败态：单条快照 404 → 面板内明确提示；关闭回到详情（按钮回来、面板消失）", async () => {
    snapshotFail = true;
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    fireEvent.click(screen.getByTestId("snapshot-diff-open"));

    await waitFor(() => expect(screen.getByTestId("snapshot-diff-error").textContent).toContain("存档点对比加载失败"));
    expect(screen.getByTestId("snapshot-diff-error").textContent).toContain("HTTP 404");
    expect(screen.queryByTestId("diff-row-add")).toBeNull();

    fireEvent.click(screen.getByTestId("snapshot-diff-close"));
    expect(screen.queryByTestId("snapshot-diff")).toBeNull();
    expect(screen.getByTestId("tree-detail")).toBeTruthy(); // 详情本体还在，只是收起对比
    expect(screen.getByTestId("snapshot-diff-open")).toBeTruthy();
  });
});

describe("StoryTreeScreen：大图降级、缩放平移与节点 roving（v1.6）", () => {
  /** 造一张 n 个节点的单章树（状态分布：前 5 个已走过、每 3 个一个已剪枝、其余可达） */
  function bigTreeMd(n: number): string {
    const lines = ["# 剧情树", "", "## 第 1 章：大图", "- 当前进度: 节点 1-1（已走 1 轮）", ""];
    for (let i = 1; i <= n; i++) {
      const status = i <= 5 ? "已走过" : i % 3 === 0 ? "已剪枝" : "可达";
      lines.push(`### 节点 1-${i}（第 ${i} 拍）`);
      lines.push("- 地点: 大厅");
      lines.push(`- 梗概: 第 ${i} 个拍点的梗概`);
      lines.push("- 状态: " + status);
      lines.push("");
    }
    return lines.join("\n");
  }

  const SMALL_MD = [
    "# 剧情树",
    "",
    "## 第 2 章：雨夜来客",
    "- 当前进度: 节点 2-2（已走 3 轮）",
    "",
    "### 节点 2-1（来客敲门）",
    "- 地点: 灰雀镇旅店",
    "- 梗概: 深夜有人敲门",
    "- 出边: 开门 → 2-2",
    "- 状态: 已走过",
    "",
    "### 节点 2-2（门外的雨声）",
    "- 地点: 灰雀镇旅店",
    "- 梗概: 来客淋着雨递上一封信",
    "- 出边: 接过信 → 2-3",
    "- 状态: 已走过",
    "",
    "### 节点 2-3（假装睡着）",
    "- 地点: 灰雀镇旅店",
    "- 梗概: 走廊里传来拖拽声",
    "- 状态: 已剪枝",
  ].join("\n");

  let treeMarkdown = SMALL_MD;

  beforeEach(() => {
    treeMarkdown = SMALL_MD;
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "tree",
      screenReturn: "game",
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/tree") return jsonResponse({ worldId: "campus-summer-1", markdown: treeMarkdown });
        if (url.pathname === "/api/history") return jsonResponse({ worldId: "campus-summer-1", snapshots: [] });
        return jsonResponse({}, 404);
      }),
    );
  });

  it(">40 节点：默认列表模式，按状态分组、行是原生 button、点行进详情；可手动切回图形", async () => {
    treeMarkdown = bigTreeMd(41);
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-list")).toBeTruthy());

    expect(screen.queryByTestId("tree-canvas")).toBeNull(); // 大图不再默认铺连线
    expect(screen.getByTestId("tree-view-list").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tree-list-group-已走过")).toBeTruthy();
    expect(screen.getByTestId("tree-list-group-已剪枝")).toBeTruthy();
    expect(screen.getByTestId("tree-list-group-可达")).toBeTruthy();
    expect(screen.queryByTestId("tree-list-group-嫁接")).toBeNull(); // 空组不铺标题

    const row = screen.getByTestId("tree-row-1-1");
    expect(row.tagName).toBe("BUTTON"); // 原生 button 语义
    expect(within(row).getByText("大厅")).toBeTruthy();
    expect(within(row).getByText(/第 1 个拍点/)).toBeTruthy();
    expect(row.getAttribute("aria-current")).toBe("step"); // 当前进度行

    fireEvent.click(row);
    expect(within(screen.getByTestId("tree-detail")).getByText("节点 1-1")).toBeTruthy();

    // 手动切图形：画布回来、列表收起
    fireEvent.click(screen.getByTestId("tree-view-graph"));
    expect(screen.queryByTestId("tree-list")).toBeNull();
    expect(screen.getByTestId("tree-canvas")).toBeTruthy();
    expect(screen.getByTestId("tree-view-graph").getAttribute("aria-pressed")).toBe("true");

    // 再切回列表：切换状态留在屏内（不是靠重新挂载回到自动判定）
    fireEvent.click(screen.getByTestId("tree-view-list"));
    expect(screen.getByTestId("tree-list")).toBeTruthy();
    expect(screen.queryByTestId("tree-canvas")).toBeNull();
  });

  it("小图不显示切换（≤40 节点照旧只看图形）", async () => {
    treeMarkdown = bigTreeMd(40);
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    expect(screen.queryByTestId("tree-view-toggle")).toBeNull();
    expect(screen.queryByTestId("tree-list")).toBeNull();
  });

  it("缩放：按钮改变 viewBox、适应/双击复位、+/-/0 快捷键同一条路", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const canvas = screen.getByTestId("tree-canvas");
    const fit = canvas.getAttribute("viewBox");
    expect(box(fit)[0]).toBe(0);
    expect(box(fit)[1]).toBe(0);

    // 画布包体：图例、缩放工具条与画布同处一个 wrap（`+/-/0` 的键盘监听就挂在它上面，画布内未消费的键冒泡到这儿）
    const wrap = screen.getByTestId("tree-canvas-wrap");
    expect(wrap.contains(canvas)).toBe(true);
    expect(wrap.contains(screen.getByTestId("tree-zoom-in"))).toBe(true);
    expect(within(wrap).getByText("已走过")).toBeTruthy(); // 图例与画布同处一个包体

    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    const zoomed = canvas.getAttribute("viewBox");
    expect(zoomed).not.toBe(fit);
    expect(box(zoomed)[2]).toBeLessThan(box(fit)[2]); // 放大 = 视野变小
    expect(screen.getByTestId("tree-zoom-level").textContent).toBe("125%");

    fireEvent.click(screen.getByTestId("tree-zoom-out"));
    expect(canvas.getAttribute("viewBox")).toBe(fit);
    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    fireEvent.click(screen.getByTestId("tree-zoom-fit"));
    expect(canvas.getAttribute("viewBox")).toBe(fit);
    expect(screen.getByTestId("tree-zoom-level").textContent).toBe("100%");

    // 双击画布复位
    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    expect(canvas.getAttribute("viewBox")).not.toBe(fit);
    fireEvent.doubleClick(canvas);
    expect(canvas.getAttribute("viewBox")).toBe(fit);

    // 键盘 +/-/0：事件冒泡到画布容器
    fireEvent.keyDown(canvas, { key: "+" });
    expect(canvas.getAttribute("viewBox")).not.toBe(fit);
    fireEvent.keyDown(canvas, { key: "-" });
    expect(canvas.getAttribute("viewBox")).toBe(fit);
    fireEvent.keyDown(canvas, { key: "+" });
    fireEvent.keyDown(canvas, { key: "0" });
    expect(canvas.getAttribute("viewBox")).toBe(fit);
  });

  it("节点 roving tabIndex：只有选中节点可 Tab；方向键移动并搬焦点；当前进度带 aria-current", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const node = (id: string) => screen.getByTestId(`tree-node-${id}`);

    // 没有选中时，Tab 入口落在「当前进度」节点
    expect(node("2-2").getAttribute("tabindex")).toBe("0");
    expect(node("2-1").getAttribute("tabindex")).toBe("-1");
    expect(node("2-3").getAttribute("tabindex")).toBe("-1");
    expect(node("2-2").getAttribute("aria-current")).toBe("step");
    expect(node("2-1").getAttribute("aria-current")).toBeNull();

    fireEvent.keyDown(node("2-2"), { key: "ArrowRight" });
    expect(useGameStore.getState().treeFocus).toBe("2-3"); // 顺序=章节顺序
    expect(node("2-3").getAttribute("tabindex")).toBe("0");
    expect(node("2-2").getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(node("2-3")); // roving 也把焦点真的搬过去

    fireEvent.keyDown(node("2-3"), { key: "ArrowLeft" });
    expect(useGameStore.getState().treeFocus).toBe("2-2");

    // Enter 打开详情（节点自身语义），箭头键不会误开
    fireEvent.keyDown(node("2-2"), { key: "Enter" });
    expect(screen.getByTestId("tree-detail")).toBeTruthy();
  });

  it("滚轮以指针为锚点缩放（画布内滚一下即变 viewBox，且不滚页面）", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const canvas = screen.getByTestId("tree-canvas");
    const fit = canvas.getAttribute("viewBox");

    const ev = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    // 缩放走原生非 passive 监听（React 的 onWheel 是根上的被动监听，preventDefault 无效）；
    // 原生事件在 act 之外不会自动冲刷，故这里显式 act 包一层
    act(() => {
      canvas.dispatchEvent(ev);
    });
    expect(canvas.getAttribute("viewBox")).not.toBe(fit);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("treeLayout 视图纯函数：适应 / 指针锚点缩放 / 平移夹取（v1.6）", () => {
  const W = 1000;
  const H = 400;

  it("适应态 viewBox 与 v1.5 的默认输出逐字一致（0 0 W H）", () => {
    expect(viewBoxOf(fitView(W, H), W, H)).toBe("0 0 1000 400");
  });

  it("以指针为锚点缩放：锚点下那一点布局坐标保持不动", () => {
    const v = fitView(W, H);
    const fx = 0.8;
    const fy = 0.2;
    const before = { x: v.cx + (fx - 0.5) * (W / v.zoom), y: v.cy + (fy - 0.5) * (H / v.zoom) };
    const z = zoomViewAt(v, 2, fx, fy, W, H);
    const after = { x: z.cx + (fx - 0.5) * (W / z.zoom), y: z.cy + (fy - 0.5) * (H / z.zoom) };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(z.zoom).toBe(2);
  });

  it("缩放收敛进 [0.5, 4]、非法值回适应；平移夹在布局内（拖不出边界）", () => {
    expect(clampZoom(99)).toBe(TREE_ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(0.5);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomViewAt(fitView(W, H), 1000, 0.5, 0.5, W, H).zoom).toBe(TREE_ZOOM_MAX);

    // 适应态本来就没得拖：怎么拖都是同一张全貌
    expect(viewBoxOf(panView(fitView(W, H), 900, 900, W, H), W, H)).toBe("0 0 1000 400");

    const panned = panView(zoomViewAt(fitView(W, H), 2, 0.5, 0.5, W, H), 9999, 9999, W, H);
    const [x, y, w, h] = box(viewBoxOf(panned, W, H));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(W);
    expect(y + h).toBeLessThanOrEqual(H);
  });
});

describe("游戏键盘：数字键选选项、空格补全、自动前进倒计时（v1.6）", () => {
  /** POST /prompt 收到的指令 */
  let prompts: string[];

  beforeEach(() => {
    prompts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 404);
      }),
    );
    useGameStore.setState({
      screen: "game",
      screenReturn: null,
      engineBusy: false,
      typingDone: true,
      options: [
        { n: "1", t: "溜进座位" },
        { n: "2", t: "转身去天台" },
        { n: "3", t: "留在后门听完这通电话" },
      ],
      settings: { ...DEFAULT_SETTINGS, textSpeed: "slow", autoAdvance: 0 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
  });

  afterEach(() => {
    useGameStore.getState().cancelAutoAdvance();
    useGameStore.setState({ settings: { ...DEFAULT_SETTINGS }, options: null, typingDone: false });
  });

  it("数字键 1-9 与 Numpad1-9 选对应选项（送引擎）；越界数字什么都不做", async () => {
    render(<OptionList />);
    expect(screen.getByTestId("option-hints").textContent).toBe("1-9 选择 · 空格补全");

    fireEvent.keyDown(window, { key: "2" });
    expect(prompts).toEqual(["转身去天台"]);

    // 选项数变了：监听按新选项重挂（act 冲刷，否则打到的是上一轮的闭包）。
    // send 会把 typingDone 打回 false（选项由下一次 turn_end 重新给出），这里连它一起放回「选项可见」
    act(() =>
      useGameStore.setState({
        typingDone: true,
        options: [
          { n: "1", t: "溜进座位" },
          { n: "2", t: "转身去天台" },
        ],
      }),
    );
    fireEvent.keyDown(window, { key: "9", code: "Numpad9" }); // 越界：不吞按键也不发指令
    expect(prompts).toEqual(["转身去天台"]);
    fireEvent.keyDown(window, { key: "1", code: "Numpad1" });
    expect(prompts).toEqual(["转身去天台", "溜进座位"]);
  });

  it("焦点在自由输入框（真组件 FreeInput）里时数字键让路：不打服务端；发送与语音入口各自兑现承诺（空白不发 / 回车与按钮同路 / 说完自动发送）", async () => {
    render(
      <>
        <OptionList />
        <FreeInput />
      </>,
    );
    const input = screen.getByTestId("free-input-field");
    input.focus();
    fireEvent.keyDown(input, { key: "1" }); // 冒泡到 window，但目标是输入框
    expect(prompts).toEqual([]);

    fireEvent.keyDown(window, { key: "1", isComposing: true });
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(prompts).toEqual([]);

    fireEvent.keyDown(window, { key: "1", code: "Numpad1" });
    expect(prompts).toEqual(["溜进座位"]);

    // 发送入口：空白不发（也不清掉玩家正在写的字），回车与按钮同一条路（收敛空白 + 清空 + 记在途输入）
    const field = screen.getByTestId("free-input-field") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("free-input-send"));
    expect(prompts).toHaveLength(1);
    fireEvent.change(field, { target: { value: " 推门进去 " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(prompts.at(-1)).toBe("推门进去");
    expect(field.value).toBe("");
    expect(useGameStore.getState().pendingTurnPrompt).toBe("推门进去"); // 重掷「重发同一输入」的数据源
    fireEvent.change(field, { target: { value: "半夜有人敲门" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true }); // 中文输入法选词的 Enter 不算发送
    expect(prompts).toHaveLength(2);
    expect(field.value).toBe("半夜有人敲门");
    fireEvent.click(screen.getByTestId("free-input-send"));
    expect(prompts.at(-1)).toBe("半夜有人敲门");

    // 语音入口：浏览器没有实现就不摆这个按钮（不摆一个点了没反应的按钮）
    expect(screen.queryByTestId("free-input-mic")).toBeNull();

    // 有实现：点了进聆听（按钮与占位都改口），再点收工，转写实时回填，说完自动发送一次
    cleanup();
    const recs: FakeSpeechRecognition[] = [];
    class SR extends FakeSpeechRecognition {
      constructor() {
        super();
        recs.push(this);
      }
    }
    vi.stubGlobal("SpeechRecognition", SR);
    render(<FreeInput />);
    const mic = screen.getByTestId("free-input-mic");
    expect(mic.getAttribute("title")).toBe("语音输入");
    fireEvent.click(mic);
    const rec = recs[0];
    expect(rec.lang).toBe("zh-CN"); // 中文转写
    expect(rec.started).toBe(1);
    const listeningField = screen.getByTestId("free-input-field") as HTMLInputElement;
    expect(listeningField.placeholder).toBe("聆听中…说完自动发送");
    expect(screen.getByTestId("free-input-mic").className).toContain("animate-pulse"); // 在听：按钮自己也说
    fireEvent.click(screen.getByTestId("free-input-mic")); // 再点一次 = 收工（不会又开一个识别器）
    expect(rec.stopped).toBe(1);
    expect(recs).toHaveLength(1);
    act(() => rec.emit("半夜有人敲门"));
    expect(listeningField.value).toBe("半夜有人敲门");
    act(() => rec.end());
    expect(prompts.at(-1)).toBe("半夜有人敲门"); // 说完自动发送
    expect(listeningField.value).toBe("");
    expect(listeningField.placeholder).toBe("想说什么就写在这里（也可输入数字）");
  });

  it("空格立即补全打字机（打字中才有提示；组字里/输入框里的空格不算）", async () => {
    const full = "蝉鸣把旧教学楼叫成一锅白粥，她抱着书包站在教室后门。";
    useGameStore.setState({
      received: full,
      finalText: full,
      turnKey: 42,
      options: null,
      typingDone: false,
      status: "引擎演绎中…",
    });
    render(
      <>
        <DialogueBox />
        <input data-testid="free-input" />
      </>,
    );
    const text = () => screen.getByTestId("dialogue-text").textContent ?? "";
    expect(screen.getByTestId("dialogue-hint").textContent).toBe("空格补全");
    expect(text()).not.toContain(full); // 打字机才起了个头

    fireEvent.keyDown(window, { key: " ", isComposing: true }); // 中文输入法里的空格
    expect(useGameStore.getState().typingDone).toBe(false);

    const input = screen.getByTestId("free-input");
    input.focus();
    fireEvent.keyDown(input, { key: " " }); // 焦点在输入框：那个空格是玩家的正文
    expect(useGameStore.getState().typingDone).toBe(false);

    fireEvent.keyDown(window, { key: " " });
    expect(text()).toContain(full);
    await waitFor(() => expect(useGameStore.getState().typingDone).toBe(true)); // 补全即「打完」
    expect(screen.queryByTestId("dialogue-hint")).toBeNull(); // 打完了就没有「补全」可说
  });

  it("打字已完成时空格不吞按键（聚焦按钮的激活语义照旧）", () => {
    useGameStore.setState({ received: "", finalText: "", turnKey: 43, options: null, typingDone: true, status: "就绪" });
    render(<DialogueBox />);

    const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // 没有可补的文本：这一下空格该归它自己的语义
    expect(screen.queryByTestId("dialogue-hint")).toBeNull();
  });

  it("自动前进：设置开启且选项上屏 → 倒计时标记（到点由 store 的定时器接管）", () => {
    useGameStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 5000 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
    render(<OptionList />);

    expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull(); // 选项一上屏就起计时
    expect(screen.getByTestId("auto-advance").textContent).toBe("自动前进 · 5s");

    // 关掉设置（或引擎忙、有排队指令）时不起计时：倒计时不该在引擎还在写的时候就跑
    act(() => useGameStore.getState().cancelAutoAdvance());
    useGameStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 5000 },
      options: null,
      typingDone: false,
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
    useGameStore.getState().armAutoAdvance();
    expect(useGameStore.getState().autoAdvanceDeadline).toBeNull();
  });
});

describe("App：状态播报区（aria-live，v1.6）", () => {
  beforeEach(() => {
    useGameStore.setState({ status: "连接引擎…" });
  });

  it("aria-live=polite 播报玩家口吻的状态（playerStatus 映射）；同一句重复写入不再动 DOM（不重复播报）", async () => {
    render(<StatusAnnouncer />);
    const live = screen.getByTestId("sr-status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(live.textContent).toBe("连接中…");

    act(() => useGameStore.setState({ status: "引擎演绎中…" }));
    await waitFor(() => expect(screen.getByTestId("sr-status").textContent).toBe("故事展开中…"));

    // 同一句话再写一次：文本节点原样不动——屏幕阅读器不会把同一段重念一遍
    const node = screen.getByTestId("sr-status").firstChild;
    act(() => useGameStore.setState({ status: "引擎演绎中…" }));
    expect(screen.getByTestId("sr-status").firstChild).toBe(node);

    act(() => useGameStore.setState({ status: "就绪" }));
    await waitFor(() => expect(screen.getByTestId("sr-status").textContent).toBe("就绪"));
  });

  it("App 根节点里常驻播报区（任何屏都在，读屏用户随时能听到状态）", () => {
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        close() {}
      },
    );
    render(<App />);
    expect(screen.getByTestId("sr-status").getAttribute("aria-live")).toBe("polite");
  });

  it("玩家一动手就取消本回合的自动前进（App 层捕获点击/按键/输入）", async () => {
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        close() {}
      },
    );
    useGameStore.setState({
      screen: "game",
      screenReturn: null,
      status: "引擎演绎中…",
      engineBusy: false,
      typingDone: true,
      options: [
        { n: "1", t: "溜进座位" },
        { n: "2", t: "转身去天台" },
      ],
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 5000 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
    render(<App />);

    // 选项上屏（GameStage 里的 OptionList 挂载）即起计时
    await waitFor(() => expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull());
    expect(screen.getByTestId("auto-advance")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowDown" }); // 任何一次交互都算「玩家接管了」
    expect(useGameStore.getState().autoAdvanceDeadline).toBeNull();
    expect(useGameStore.getState().autoAdvanceMuted).toBe(true);
    expect(screen.queryByTestId("auto-advance")).toBeNull();
  });
});

// ————————————————————— 回退语义收尾：history 分割线 / 待重同步徽章 / treeNotice 三态 —————————————————————

describe("回退后的客户端语义：非破坏式分割线、待重同步与再同步（v1.7）", () => {
  /** POST /prompt 的返回（用例内切换失败→成功） */
  let promptResp: { ok: boolean; error?: string };
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  /** POST /api/worlds 收到的动作 */
  let worldPosts: Record<string, unknown>[];

  const WORLDS_BODY: { worlds: WorldEntry[] } = {
    worlds: [
      {
        worldId: "campus-summer-1",
        preset: PRESET.id,
        title: PRESET.title,
        chapterNo: 2,
        lastPlayed: Date.now(),
        note: "",
        forkedFrom: null,
        exists: true,
      },
      {
        worldId: "campus-summer-2",
        preset: PRESET.id,
        title: PRESET.title,
        chapterNo: 1,
        lastPlayed: Date.now(),
        note: "",
        forkedFrom: null,
        exists: true,
      },
    ],
  };

  beforeEach(() => {
    promptResp = { ok: true };
    prompts = [];
    worldPosts = [];
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "game",
      screenReturn: null,
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
      history: [],
      turnNo: 0,
      segs: { 0: "" },
      curSeg: 0,
      pendingResync: null,
      resyncFailed: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse(promptResp.ok ? promptResp : { ok: false, error: promptResp.error ?? "HTTP 409" }, promptResp.ok ? 200 : 409);
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          if (body.action === "restore") return jsonResponse({ ok: true, backupSeq: 12 });
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse(WORLDS_BODY);
        return jsonResponse({}, 404);
      }),
    );
  });

  it("回退成功：history 追加 rollback 分割线（旧幕一条不删），抽屉里旧幕置灰、分割线之后的新幕正常", async () => {
    useGameStore.setState({
      history: [
        { n: "第 1 幕", t: "旧幕一：门口初遇" },
        { n: "第 2 幕", t: "旧幕二：中殿对话" },
      ],
      turnNo: 2,
    });
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(3);
    });
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 3 }]);
    expect(useGameStore.getState().history[2]).toMatchObject({ kind: "rollback", seq: 3 }); // 追加，不删除

    // 重同步回合收尾：新一幕叠在分割线之后
    act(() => {
      useGameStore.setState({ segs: { 0: "重同步后的正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().history).toHaveLength(4);

    const trigger = focusProbe(); // 命令轨「回想」按钮的替身：它拿着焦点时开抽屉（焦点归还的断言要用）
    useGameStore.setState({ drawerOpen: true, chapterNo: 2 });
    render(<HistoryDrawer />);
    // 非破坏式分割线：只插一行、旧幕一条不删；标题带当前章号（顶栏已不再显示章号）
    expect(screen.getByText("回 想 · 第 2 章")).toBeTruthy();
    expect(screen.getByTestId("history-rollback").textContent).toBe("—— 已回溯到第 3 幕 ——");
    const acts = screen.getAllByTestId("history-act");
    expect(acts).toHaveLength(3); // 两幕旧 + 一幕新，一条没删
    // 抽屉倒序渲染：新幕在分割线之后（正常），两幕旧幕在分割线之前（置灰）
    expect(acts[0].textContent).toContain("重同步后的正文");
    expect(acts[0].className).not.toContain("opacity-50");
    expect(acts[1].className).toContain("opacity-50");
    expect(acts[2].className).toContain("opacity-50");

    // —— v1.9 a11y：抽屉语义 + 焦点陷阱 + 关闭归还 ——
    const panel = screen.getByTestId("history-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    // 名字是读得出来的形态（屏上标题靠空格撑字距，读屏不该逐个念空格）
    expect(panel.getAttribute("aria-label")).toBe("回想 · 第 2 章");
    const close = within(panel).getByRole("button", { name: "关闭回想" });
    expect(document.activeElement).toBe(close); // 开抽屉把焦点送进来（它是抽屉里唯一可聚焦的元素）
    pressTab(); // 单元素容器上的回绕形态：Tab 原地不动，不跑到抽屉外面（TopBar / 命令轨）去
    expect(document.activeElement).toBe(close);
    pressTab(true);
    expect(document.activeElement).toBe(close);

    // 关闭归还焦点：回到开抽屉前拿着焦点的那个元素
    act(() => {
      useGameStore.getState().toggleDrawer();
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("重同步失败：TopBar 亮徽章与「再同步」，点击重发续玩指令；成功回合后徽章消失，世界线屏行内也有小标", async () => {
    // 回退成功、但补发的续玩指令没发出去（409）：立即进入失败态
    promptResp = { ok: false, error: "上一回合还在进行" };
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingResync).toEqual({ worldId: "campus-summer-1", seq: 7 }); // 保留：还有救
    expect(useGameStore.getState().treeNotice).toContain("重同步失败");
    expect(useGameStore.getState().status).toContain("出错"); // 状态行与提示条同说失败，不再各说各话

    render(<TopBar />);
    expect(screen.getByTestId("resync-badge").textContent).toBe("待重同步");
    const retry = screen.getByTestId("resync-retry");
    expect(retry.textContent).toBe("再同步");

    // 世界线屏：该世界行内亮「待重同步」小标（别的世界不亮）
    cleanup();
    useGameStore.setState({ selected: PRESET, screen: "worlds" });
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-continue-campus-summer-1")).toBeTruthy());
    expect(screen.getByTestId("world-resync-campus-summer-1").textContent).toBe("待重同步");
    expect(screen.queryByTestId("world-resync-campus-summer-2")).toBeNull();

    // 点「再同步」：重发同一条续玩指令（走正常 send 流程）
    cleanup();
    useGameStore.setState({ screen: "game" });
    render(<TopBar />);
    promptResp = { ok: true };
    await act(async () => {
      fireEvent.click(screen.getByTestId("resync-retry"));
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().resyncFailed).toBe(false);
    expect(screen.queryByTestId("resync-retry")).toBeNull(); // 失败入口收起，徽章留到回合收尾

    // 这次回合成功收尾：徽章消失
    act(() => {
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().pendingResync).toBeNull();
    expect(screen.queryByTestId("resync-badge")).toBeNull();
  });

  it("treeNotice 三态：回退成功→「正在同步进度」；回合收尾→「进度已同步」；引擎 error→「失败可重试」", async () => {
    // 态一：回退成功、续玩指令已发出（等回合）
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(5);
    });
    const pending = useGameStore.getState().treeNotice ?? "";
    expect(pending).toContain("已回到第 5 幕");
    expect(pending).toContain("正在同步进度");

    // 态二：重同步回合 turn_end → 完成重同步（徽章同回合清除）
    act(() => {
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().treeNotice).toBe("已回到第 5 幕，进度已同步");
    expect(useGameStore.getState().pendingResync).toBeNull();

    // 态三：再次回退，这次引擎在回合里回 error（SSE error 事件路径）
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(5);
    });
    act(() => {
      useGameStore.getState().handleEvent({ type: "error", message: "引擎回合失败：引擎坏了" });
    });
    const s = useGameStore.getState();
    expect(s.pendingResync).toEqual({ worldId: "campus-summer-1", seq: 5 }); // 保留：徽章与「再同步」还挂着
    expect(s.resyncFailed).toBe(true);
    expect(s.treeNotice).toContain("重同步失败：引擎回合失败：引擎坏了");
    expect(s.treeNotice).toContain("再同步");
    expect(s.status).toContain("出错");
  });
});

// ————————————————————— 动效降级（prefers-reduced-motion，v1.7） —————————————————————

describe("DialogueBox：动效降级（prefers-reduced-motion，v1.7）", () => {
  /** jsdom 没有 matchMedia 实现：手工挂一个（matches 固定、change 永不触发），测完删掉还原 */
  const stubMatchMedia = (matches: boolean) => {
    window.matchMedia = (() => ({ matches, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  };
  const dropMatchMedia = () => {
    delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
  };
  afterEach(dropMatchMedia);

  it("系统开了「减少动态效果」：打字机整段显示（无补全提示、光标即隐），用户设置档位不动", async () => {
    stubMatchMedia(true);
    const full = "蝉鸣把旧教学楼叫成一锅白粥，她抱着书包站在教室后门，听见里面有人压低嗓子念她的名字。";
    useGameStore.setState({
      received: full,
      finalText: full,
      turnKey: 51,
      options: null,
      typingDone: false,
      status: "引擎演绎中…",
      settings: { ...DEFAULT_SETTINGS, textSpeed: "slow" }, // 慢档也照样整段：呈现降级 ≠ 改档位
    });
    render(<DialogueBox />);
    // 无打字过程：一次读取即全文（打字机路径下此刻只会有开头几个字）
    expect(screen.getByTestId("dialogue-text").textContent).toContain(full);
    await waitFor(() => expect(useGameStore.getState().typingDone).toBe(true));
    expect(screen.queryByTestId("dialogue-hint")).toBeNull(); // 打完了就没有「补全」可提示
    expect(useGameStore.getState().settings.textSpeed).toBe("slow"); // 设置原样，不替用户改档
  });

  it("matchMedia 不存在（无实现环境）：不降级——照常逐字打字，防御分支不抛错", () => {
    dropMatchMedia(); // jsdom 本来就没有这个实现
    const full = "雨声漫过教堂的尖顶，薇拉抱着账册站在门口，没有看你。";
    useGameStore.setState({
      received: full,
      finalText: full,
      turnKey: 52,
      options: null,
      typingDone: false,
      status: "引擎演绎中…",
      settings: { ...DEFAULT_SETTINGS, textSpeed: "slow" },
    });
    render(<DialogueBox />);
    expect(screen.getByTestId("dialogue-text").textContent).not.toContain(full); // 才起了个头：降级没发生
    expect(screen.getByTestId("dialogue-hint").textContent).toBe("空格补全");
  });
});

// ————————————————————— 同屏多立绘（v1.9）：队列渲染与对话区让位档 —————————————————————

describe("同屏多立绘：发言者高亮带名牌、非发言者压暗，让位档随人数切换（v1.9）", () => {
  /** 一个立绘槽位（jsdom 不加载图片，这里只关心结构与类名） */
  const figure = (name: string, variant = "") => ({
    name,
    variant,
    url: `/img?p=x%2F${name}.jpg&n=${name}`,
    baseUrl: `/img?p=x%2F${name}.jpg&n=${name}`,
  });

  beforeEach(() => {
    useGameStore.setState({ portraits: [] });
  });

  it("0/1/2 人：让位档依次是「无 / portrait-reserve / portrait-reserve-duo」，队列左到右 = 出场到发言；抽屉打开时舞台背景 inert（抽屉不在那一层里）", () => {
    render(<GameStage />);
    // 无人：没有立绘层内容，也没有让位（对话面板吃满宽度）
    expect(screen.queryAllByTestId("portrait-figure")).toHaveLength(0);
    expect(screen.queryByTestId("portrait-nameplate")).toBeNull();
    expect(screen.getByTestId("dialogue-dock").className).not.toContain("portrait-reserve");

    // 单人：沿用 v1.8 的单人档 + 名牌
    act(() => useGameStore.setState({ portraits: [figure("薇拉")] }));
    expect(screen.getAllByTestId("portrait-figure")).toHaveLength(1);
    expect(screen.getByTestId("portrait-figure").getAttribute("data-speaker")).toBe("true");
    expect(screen.getByTestId("portrait-nameplate").textContent).toBe("薇拉");
    const dock = screen.getByTestId("dialogue-dock");
    expect(dock.className).toContain("portrait-reserve");
    expect(dock.className).not.toContain("portrait-reserve-duo");

    // 同屏 2 人：两个人形都在，末位（沈屿）是发言者 → 带名牌；队首（薇拉）压暗且**没有**名牌
    act(() => useGameStore.setState({ portraits: [figure("薇拉"), figure("沈屿", "微笑")] }));
    const figs = screen.getAllByTestId("portrait-figure");
    expect(figs).toHaveLength(2);
    expect(figs.map((f) => f.getAttribute("data-speaker"))).toEqual(["false", "true"]);
    expect(screen.getAllByTestId("portrait-nameplate")).toHaveLength(1);
    expect(screen.getByTestId("portrait-nameplate").textContent).toBe("沈屿");
    // 压暗档必须落在内层（framer 会把内联 opacity 写在外层，类挂外层等于没挂）
    expect(figs[0].innerHTML).toContain("opacity-55");
    expect(figs[1].innerHTML).not.toContain("opacity-55");
    // 两张图各挂各的（各自的差分/基础 URL，不互相顶掉）
    expect(screen.getByAltText("薇拉")).toBeTruthy();
    expect(screen.getByAltText("沈屿")).toBeTruthy();
    expect(screen.getByTestId("dialogue-dock").className).toContain("portrait-reserve-duo");

    // —— v1.9 a11y：抽屉打开时舞台背景（立绘 + HUD + 对话区）整体 inert ——
    // 关着的时候一个属性都不写（默认零成本）
    const stage = screen.getByTestId("stage-background");
    expect(stage.hasAttribute("inert")).toBe(false);
    expect(stage.contains(screen.getByTestId("dialogue-dock"))).toBe(true); // 对话区确实在这一层里

    act(() => useGameStore.getState().toggleDrawer());
    expect(stage.hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("dialogue-dock").closest("[inert]")).toBe(stage);
    // 命令轨（TopBar）也在这一层里：这就是原先「Tab 逛出抽屉去点顶栏」的那个缺口
    expect(screen.getByTestId("history").closest("[inert]")).toBe(stage);
    // 抽屉自己**不在** inert 子树里：它是这一层的兄弟，所以焦点陷阱还能把焦点送进去
    // （inert 子树里的元素连程序化 focus 都是 no-op——真被套进去，下面这条断言会红）
    const panel = screen.getByTestId("history-panel");
    expect(panel.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "关闭回想" }));

    // 关闭即摘掉（inert 跟着开关走，不留残值——留着的话命令轨就再也点不动了）
    act(() => useGameStore.getState().toggleDrawer());
    expect(stage.hasAttribute("inert")).toBe(false);

    // 角色面板同一条规矩：两个抽屉共用「舞台背景」这一层，任一开着都压住，各自都不在里层
    act(() => useGameStore.setState({ charactersOpen: true }));
    expect(stage.hasAttribute("inert")).toBe(true);
    const cards = screen.getByTestId("characters-panel");
    expect(cards.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(within(cards).getByRole("button", { name: "关闭角色面板" }));
    act(() => useGameStore.setState({ charactersOpen: false }));
    expect(stage.hasAttribute("inert")).toBe(false);
  });

  it("发言者切换（队列重排）：名牌跟着末位走，压暗随之易主——同一套元素不新增人形", () => {
    act(() =>
      useGameStore.setState({
        portraits: [
          { ...figure("薇拉"), url: "/img?p=x%2F%5Fvera-smile.jpg&n=薇拉", variant: "微笑" },
          figure("沈屿"),
        ],
      }),
    );
    render(<GameStage />);
    expect(screen.getByTestId("portrait-nameplate").textContent).toBe("沈屿");

    // 薇拉切差分：store 侧（applyExpression）把她移到队尾，渲染层只是跟着队列画
    act(() => useGameStore.setState({ portraits: [figure("沈屿"), { ...figure("薇拉"), variant: "微笑" }] }));
    const figs = screen.getAllByTestId("portrait-figure");
    expect(figs).toHaveLength(2); // 仍是两个人形（不重复占位）
    expect(figs.map((f) => f.getAttribute("data-speaker"))).toEqual(["false", "true"]);
    expect(screen.getByTestId("portrait-nameplate").textContent).toBe("薇拉");
    expect(figs[0].innerHTML).toContain("opacity-55"); // 队首（沈屿）转为暗角
  });
});

// ————————————————————— 回退后玩家继续走：普通回合不冒充重同步（v1.7） —————————————————————

describe("回退后玩家继续走：普通指令不冒充重同步（v1.7）", () => {
  /** POST /prompt 的逐条返回（按序消费：先失败制造 resume 投递失败，再按用例切换） */
  let promptResps: { ok: boolean; error?: string }[];
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  /** 可选闸门：让下一条 /prompt 响应挂起不落定（「重同步仍在途」用例用），release 后才返回 */
  let promptGate: Promise<void> | null;

  beforeEach(() => {
    promptResps = [];
    prompts = [];
    promptGate = null;
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "game",
      screenReturn: null,
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
      history: [],
      turnNo: 0,
      segs: { 0: "" },
      curSeg: 0,
      pendingResync: null,
      resyncFailed: false,
      resyncing: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          const resp = promptResps.shift() ?? { ok: true };
          if (promptGate) { const g = promptGate; promptGate = null; await g; } // 先记本次开关，响应挂到闸门放行
          return jsonResponse(resp.ok ? resp : { ok: false, error: resp.error ?? "HTTP 409" }, resp.ok ? 200 : 409);
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          if (body.action === "restore") return jsonResponse({ ok: true, backupSeq: 12 });
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: [] });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("resume 投递失败后玩家发普通指令并成功：徽章静默消失，不宣告「完成重同步」", async () => {
    promptResps = [
      { ok: false, error: "上一回合还在进行" }, // restore 后补发的 resume：投递失败
      { ok: true }, // 玩家的普通指令：成功
    ];
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(useGameStore.getState().pendingResync).toEqual({ worldId: "campus-summer-1", seq: 7 });

    render(<TopBar />);
    expect(screen.getByTestId("resync-badge").textContent).toBe("待重同步"); // 前置：徽章在

    // 玩家不理会徽章，直接发普通指令且成功：send 入口静默清 pendingResync，回合照常收尾
    await act(async () => {
      useGameStore.getState().send("推门进去");
    });
    useGameStore.setState({ segs: { 0: "门后的走廊空无一人。\n\n**行动**\n1. 往前走" }, curSeg: 0 });
    act(() => {
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });

    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    const s = useGameStore.getState();
    expect(s.pendingResync).toBeNull(); // send 入口静默清，不是回合收尾认领的
    expect(s.resyncFailed).toBe(false);
    expect(s.treeNotice).toBeNull(); // 失败文案的残影一并撤下（按钮已随徽章消失，留着会指向不存在的入口）
    expect(screen.queryByTestId("resync-badge")).toBeNull(); // 徽章消失
    expect(s.status).toBe("就绪"); // 普通回合收尾一切照旧
  });

  it("resume 投递失败后玩家自己的指令也失败：不再冒充「重同步失败」", async () => {
    promptResps = [
      { ok: false, error: "上一回合还在进行" }, // resume 投递失败
      { ok: false, error: "HTTP 500" }, // 玩家的普通指令：也失败
    ];
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));

    await act(async () => {
      useGameStore.getState().send("推门进去");
    });
    await waitFor(() => expect(useGameStore.getState().status).toContain("HTTP 500"));
    const s = useGameStore.getState();
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    expect(s.pendingResync).toBeNull(); // send 入口已静默清
    expect(s.resyncFailed).toBe(false); // 玩家指令的失败不再记账到重同步头上
    expect(s.treeNotice).toBeNull(); // 残影一并撤（按钮已随徽章消失）；玩家指令的失败也不再被写成「重同步失败」
    expect(s.status).toBe("出错：HTTP 500"); // 普通出错文案照常
  });

  it("重同步仍在途时玩家发普通指令：迟到的 resume 失败不写「重同步失败」残影", async () => {
    promptResps = [{ ok: false, error: "上一回合还在进行" }]; // resume 的失败结果迟到一步
    let releaseResume!: () => void;
    promptGate = new Promise<void>((r) => { releaseResume = r; }); // 挂起 resume 的响应
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    expect(useGameStore.getState().resyncing).toBe(true); // 前置：resume 投递还没落定

    await act(async () => {
      useGameStore.getState().send("推门进去"); // 不等结果，先放弃重同步
    });
    await act(async () => {
      releaseResume(); // 放行迟到的 resume 失败
      await new Promise((r) => setTimeout(r, 0));
    });

    const s = useGameStore.getState();
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    expect(s.pendingResync).toBeNull();
    expect(s.resyncing).toBe(false);
    expect(s.resyncFailed).toBe(false); // 已放弃的重同步不许把这次失败记进来
    expect(s.treeNotice).toBeNull(); // 也不许写「点再同步重试」的残影
  });
});

// ————————————————————— 重掷本回合（v1.7） —————————————————————

describe("重掷本回合：次新 turn 快照 restore + 重同步收尾后重发同一玩家输入（v1.7）", () => {
  /** POST /prompt 的返回开关（用例内切 false 制造 409 投递失败） */
  let promptOk: boolean;
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  /** POST /api/worlds 收到的动作 */
  let worldPosts: Record<string, unknown>[];
  /** GET /api/history 返回的快照索引（用例内改写，模拟重掷后的新账本） */
  let historySnapshots: WorldSnapshotMeta[];
  /** GET /api/history 是否整体失败（快照数补拉失败的回落路径用） */
  let historyFails: boolean;

  /** 一条快照元信息（nodeId/chapterNo 对重掷无意义，占位） */
  const snap = (seq: number, kind: "turn" | "backup"): WorldSnapshotMeta => ({ seq, at: "2026-09-17T00:00:00.000Z", kind, nodeId: null, chapterNo: 1 });

  beforeEach(() => {
    promptOk = true;
    prompts = [];
    worldPosts = [];
    historyFails = false;
    // 升序三条：turn 2 / backup 3 / turn 5——重掷只认 kind:"turn"，最新 5 = 刚结束的本回合，次新 = 2
    historySnapshots = [snap(2, "turn"), snap(3, "backup"), snap(5, "turn")];
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "game",
      screenReturn: null,
      status: "就绪",
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
      pendingResync: null,
      resyncFailed: false,
      resyncing: false,
      lastTurnPrompt: "推门进去",
      pendingTurnPrompt: null,
      pendingRerollPrompt: null,
      turnSnapshots: null,
      history: [{ n: "第 3 幕", t: "回合甲：门轴一声闷响。" }],
      turnNo: 3,
      segs: { 0: "" },
      curSeg: 0,
      typingDone: true,
      options: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse(promptOk ? { ok: true } : { ok: false, error: "上一回合还在进行" }, promptOk ? 200 : 409);
        }
        if (url.pathname === "/api/history") {
          if (historyFails) return jsonResponse({ error: "boom" }, 500);
          return jsonResponse({ worldId: "campus-summer-1", snapshots: historySnapshots });
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          if (body.action === "restore") return jsonResponse({ ok: true, backupSeq: 12 });
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 404);
      }),
    );
  });

  it("重掷全链：restore 取次新 turn 快照（backup 不算）、分割线标 reroll、重同步回合收尾后自动重发同一输入", async () => {
    render(<TopBar />);
    const btn = screen.getByTestId("reroll");
    expect(btn.getAttribute("aria-label")).toBe("重演这一幕");

    await act(async () => {
      fireEvent.click(btn);
    });
    // 次新 turn = seq 2（最新 turn 5 是刚结束的本回合；backup 3 不参与计数）
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 2 }]);
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    const s1 = useGameStore.getState();
    expect(s1.pendingResync).toEqual({ worldId: "campus-summer-1", seq: 2 });
    expect(s1.pendingRerollPrompt).toBe("推门进去");
    expect(s1.history[1]).toMatchObject({ kind: "rollback", seq: 2, reason: "reroll" });
    expect(screen.queryByTestId("reroll")).toBeNull(); // 待重同步期间不显示重掷

    // 重同步回合成功收尾 → 清徽章 + 排队跟进立即重发玩家输入（走玩家回合路径）
    act(() => {
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    expect(useGameStore.getState().pendingResync).toBeNull();
    expect(useGameStore.getState().pendingRerollPrompt).toBeNull();

    // 重掷出的新回合（回合乙）收尾：lastTurnPrompt 定格为重发的输入——连掷的弹药还在
    act(() => {
      useGameStore.setState({ segs: { 0: "回合乙：这次门后传来脚步声。" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    const s2 = useGameStore.getState();
    expect(s2.lastTurnPrompt).toBe("推门进去");
    expect(s2.status).toBe("就绪");

    // 分割线文案走 reroll 措辞；旧幕（回合甲）在分割线之前置灰、新幕正常
    useGameStore.setState({ drawerOpen: true });
    render(<HistoryDrawer />);
    expect(screen.getByTestId("history-rollback").textContent).toBe("—— 第 2 幕已重演 ——");
    const acts = screen.getAllByTestId("history-act");
    expect(acts[0].textContent).toContain("回合乙"); // 抽屉倒序：最新在上
    expect(acts[0].className).not.toContain("opacity-50");
    expect(acts[acts.length - 1].textContent).toContain("回合甲");
    expect(acts[acts.length - 1].className).toContain("opacity-50");
  });

  it("快照数未知（尚未补拉到）：仍展示入口，点击后 status 反馈不可重掷", async () => {
    historySnapshots = [snap(1, "turn"), snap(2, "backup")]; // turn 只有一条：没有「上一回合结束态」可回
    useGameStore.setState({ turnSnapshots: null }); // 未知：不藏功能，点击时再判定
    render(<TopBar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    expect(worldPosts).toEqual([]);
    expect(prompts).toEqual([]);
    const s = useGameStore.getState();
    expect(s.pendingResync).toBeNull();
    expect(s.pendingRerollPrompt).toBeNull();
    expect(s.history).toHaveLength(1); // 没有插分割线
    expect(s.status).toContain("无法重掷");
    expect(screen.queryByTestId("reroll")).toBeNull(); // 状态行已离开「就绪」：入口收起
  });

  it("已知快照不足（turnSnapshots < 2）：重掷入口不渲染（spec：首个回合禁用按钮）", async () => {
    useGameStore.setState({ turnSnapshots: 1 }); // 已知只有一条 turn 快照：没有「上一回合结束态」可回
    render(<TopBar />);
    expect(screen.queryByTestId("reroll")).toBeNull();
    act(() => useGameStore.setState({ turnSnapshots: 2 })); // 攒够两条：入口出现
    expect(screen.getByTestId("reroll")).toBeTruthy();
  });

  it("回合收尾按需补拉快照数：未知 → 拉到两条后重掷入口仍在（不误藏）", async () => {
    useGameStore.setState({ turnSnapshots: null, lastTurnPrompt: "推门进去", status: "就绪" });
    render(<TopBar />);
    expect(screen.getByTestId("reroll")).toBeTruthy(); // 未知态：先展示
    act(() => {
      useGameStore.setState({ segs: { 0: "回合正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    await waitFor(() => expect(useGameStore.getState().turnSnapshots).toBe(2)); // 补拉成功（mock 两条 turn）
    expect(screen.getByTestId("reroll")).toBeTruthy();
  });

  it("补拉失败：已知计数回落未知（不藏功能），后续回合会再试", async () => {
    historyFails = true; // GET /api/history 整体失败
    useGameStore.setState({ turnSnapshots: 0, lastTurnPrompt: "推门进去", status: "就绪" });
    render(<TopBar />);
    expect(screen.queryByTestId("reroll")).toBeNull(); // 前置：已知 0 → 入口不渲染
    await act(async () => {
      useGameStore.setState({ segs: { 0: "回合正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
      await new Promise((r) => setTimeout(r, 0)); // 放行失败的补拉（catch 分支）
    });
    expect(useGameStore.getState().turnSnapshots).toBeNull(); // 回落未知：宁可展示 + 点击判定，不藏功能
    expect(screen.getByTestId("reroll")).toBeTruthy();
  });

  it("连掷：第一次重掷完整走完后，再点重掷取此刻账本的次新 turn 快照", async () => {
    render(<TopBar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    act(() => {
      // 重同步回合收尾 → 自动重发
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    act(() => {
      // 重掷出的回合乙收尾 → 就绪，重掷入口回来
      useGameStore.setState({ segs: { 0: "回合乙正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    // 服务器侧的新账本：旧两条 turn + 第一次重掷的 backup(12) + 回合乙的 turn(14)
    historySnapshots = [snap(2, "turn"), snap(3, "backup"), snap(5, "turn"), snap(12, "backup"), snap(14, "turn")];
    const btn = screen.getByTestId("reroll");
    await act(async () => {
      fireEvent.click(btn);
    });
    // turn 序列 [2,5,14]：最新 14 = 回合乙，次新 5 = 原回合甲——第二次重掷按新账本退到 5
    expect(worldPosts).toStrictEqual([
      { action: "restore", worldId: "campus-summer-1", seq: 2 },
      { action: "restore", worldId: "campus-summer-1", seq: 5 },
    ]);
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去", "继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 又排了一次重发
  });

  it("重同步投递失败后玩家改发普通指令：排队重发作废，重发的玩家文本不出现第二次", async () => {
    promptOk = false; // restore 后补发的续档指令 409：进入「待重同步 + 已排队重发」态
    render(<TopBar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 前置：排队重发还挂着

    promptOk = true;
    await act(async () => {
      useGameStore.getState().sendPlayerTurn("原地等待");
    });
    act(() => {
      useGameStore.setState({ segs: { 0: "门在雨里纹丝不动。" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    // 普通指令回合的收尾不认领排队重发（认领条件是 resyncing 收尾）：玩家文本只出现一次，
    // 排队的「推门进去」已随 pendingResync 在 send 入口静默作废
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "原地等待"]);
    expect(prompts.filter((p) => p === "推门进去")).toHaveLength(0);
    const s = useGameStore.getState();
    expect(s.pendingRerollPrompt).toBeNull();
    expect(s.lastTurnPrompt).toBe("原地等待"); // 新的玩家输入照常定格
  });

  it("重同步投递失败后点「再同步」：成功收尾后玩家文本恰好重发一次", async () => {
    promptOk = false; // 续档指令 409：徽章 + 「再同步」入口
    render(<TopBar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 排队重发保留：还有救

    promptOk = true;
    await act(async () => {
      fireEvent.click(screen.getByTestId("resync-retry"));
    });
    // 再同步回合成功收尾：清徽章 + 排队跟进立即重发玩家文本（且只有这一次）
    act(() => {
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。", "推门进去"]);
    expect(prompts.filter((p) => p === "推门进去")).toHaveLength(1); // 恰好一次
    const s = useGameStore.getState();
    expect(s.pendingRerollPrompt).toBeNull();
    expect(s.pendingResync).toBeNull();
    expect(s.lastTurnPrompt).toBeNull(); // 重同步回合不携带玩家输入（resyncing 分支清空）；重发回合收尾时会重新定格
  });

  it("玩家入口记账：sendPlayerTurn 定格 lastTurnPrompt、指令回合不覆盖、投递失败即在途作废；无输入不渲染入口", async () => {
    useGameStore.setState({ lastTurnPrompt: null });
    await act(async () => {
      useGameStore.getState().sendPlayerTurn("推门进去");
    });
    expect(useGameStore.getState().pendingTurnPrompt).toBe("推门进去");
    act(() => {
      useGameStore.setState({ segs: { 0: "回合甲正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().lastTurnPrompt).toBe("推门进去");
    expect(useGameStore.getState().pendingTurnPrompt).toBeNull();

    // 指令回合（画廊重绘类）收尾：lastTurnPrompt 保持上一个玩家回合的值
    await act(async () => {
      useGameStore.getState().send("美术：重绘 背景 中殿");
    });
    act(() => {
      useGameStore.setState({ segs: { 0: "已重绘" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().lastTurnPrompt).toBe("推门进去");
    expect(useGameStore.getState().pendingTurnPrompt).toBeNull();

    // 投递失败（409）：回合没有开始，在途输入作废，不许污染 lastTurnPrompt
    promptOk = false;
    await act(async () => {
      useGameStore.getState().sendPlayerTurn("往前走");
    });
    await waitFor(() => expect(useGameStore.getState().status).toContain("出错"));
    expect(useGameStore.getState().pendingTurnPrompt).toBeNull();
    expect(useGameStore.getState().lastTurnPrompt).toBe("推门进去");

    // TopBar：有上一回合输入才渲染重掷入口
    promptOk = true;
    cleanup();
    useGameStore.setState({ status: "就绪" });
    render(<TopBar />);
    expect(screen.getByTestId("reroll")).toBeTruthy();
    act(() => useGameStore.setState({ lastTurnPrompt: null }));
    expect(screen.queryByTestId("reroll")).toBeNull();
  });
});

// ————————————————————— 主题深化：字体族与对话框质感（v1.7） —————————————————————

describe("theme：字体族与对话框质感（v1.7）", () => {
  /** 带 theme 的剧本 fixture（font/dialog 两键是本组的主角） */
  const themed = (theme: Partial<NonNullable<Preset["theme"]>>): Preset => ({ ...PRESET, theme: { accent: "#f0b95a", accent2: "#f7e3b0", motif: "summer", ...theme } });

  it("themeVars 产出 --font-preset：缺省走 serif 栈，font 档位切换对应系统字体栈", () => {
    const base = themeVars(getTheme(null)) as Record<string, string>;
    expect(base["--font-preset"]).toBe(FONT_STACKS.serif);
    const hei = themeVars(getTheme(themed({ font: "hei" }))) as Record<string, string>;
    expect(hei["--font-preset"]).toBe(FONT_STACKS.hei);
    // 颜色键照旧（扩展键不挤掉旧契约）
    expect(base["--accent"]).toBe("#c9a86a");
    expect(hei["--accent"]).toBe("#f0b95a");
  });

  it("getTheme：非法 font/dialog 回退 serif/plain，合法四档透传（accent 等旧键互不影响）", () => {
    expect(getTheme(themed({ font: "comic-sans", dialog: "neon" }))).toMatchObject({ font: "serif", dialog: "plain" });
    expect(getTheme(themed({ font: "song" }))).toMatchObject({ font: "song", dialog: "plain" }); // 只配 font：dialog 缺省
    expect(getTheme(themed({ dialog: "paper" }))).toMatchObject({ font: "serif", dialog: "paper" }); // 只配 dialog：font 缺省
    for (const font of ["serif", "song", "kai", "hei"] as const) expect(getTheme(themed({ font })).font).toBe(font);
    for (const dialog of ["plain", "silk", "paper", "glass"] as const) expect(getTheme(themed({ dialog })).dialog).toBe(dialog);
  });

  it("dialogClass：四档映射 dialog-*，非法/缺省一律 dialog-plain（CSS 里 plain 无规则=现状）", () => {
    expect(dialogClass("silk")).toBe("dialog-silk");
    expect(dialogClass("paper")).toBe("dialog-paper");
    expect(dialogClass("glass")).toBe("dialog-glass");
    expect(dialogClass("plain")).toBe("dialog-plain");
    expect(dialogClass("neon")).toBe("dialog-plain");
    expect(dialogClass(undefined)).toBe("dialog-plain");
  });

  it("DialogueBox：容器质感类跟随当前剧本 theme.dialog（未配 theme 的剧本=现状 dialog-plain）", () => {
    useGameStore.setState({ selected: PRESET }); // 无 theme → plain
    const { unmount } = render(<DialogueBox />);
    const plainBox = screen.getByTestId("dialogue-text").parentElement as HTMLElement;
    expect(plainBox.className).toContain("dialog-plain");
    unmount();

    useGameStore.setState({ selected: themed({ dialog: "silk" }) });
    render(<DialogueBox />);
    const silkBox = screen.getByTestId("dialogue-text").parentElement as HTMLElement;
    expect(silkBox.className).toContain("dialog-silk");
  });

  it("App 根节点消费 --font-preset：fontFamily 挂 var、不再写死 font-serif 工具类", () => {
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        close() {}
      },
    );
    useGameStore.setState({ selected: themed({ font: "hei", dialog: "glass" }), screen: "title" });
    render(<App />);
    const root = screen.getByTestId("sr-status").parentElement as HTMLElement; // 根 div 是播报区的父节点
    expect(root.className).not.toContain("font-serif"); // 字体唯一真源是 --font-preset
    expect(root.style.fontFamily).toBe("var(--font-preset)");
    expect(root.style.getPropertyValue("--font-preset")).toBe(FONT_STACKS.hei);
  });
});

// ————————————————————— 角色面板（CharactersDrawer，v1.7） —————————————————————

describe("角色面板：渲染 / 秘密折叠 / turn_end 重拉 / 空态（v1.7）", () => {
  /** GET /api/state 的返回（用例内可切换为 404 空态） */
  let stateResp: { ok: boolean; body: StateView | null };
  /** GET /api/state?worldId= 收到的 worldId 序列（重拉时机断言用） */
  let stateQueries: string[];

  const VIEW: StateView = {
    worldId: "campus-summer-1",
    status: { preset: "campus-summer", playthrough: 2, time: "第三夜 · 雨停后", scene: "灰雀镇廉价旅店 202 房" },
    protagonist: { 姓名: "顾迟", 身份: "自由调查员" },
    director: { 张力: "7", 下一节拍: "旅店停电" },
    characters: [
      {
        name: "薇拉",
        role: "沉默的书记官",
        traits: "克制 · 观察型",
        catchphrase: "「……先记账。」",
        favor: 62,
        artFile: "presets/campus-summer/assets/立绘-薇拉.jpg",
        expression: "微笑",
        secret: "缺页是她自己撕的",
        recentInteraction: "把账册推过来半寸",
      },
      { name: "沈屿", role: "谜之少年", traits: "", catchphrase: "", favor: null, artFile: "", expression: "", secret: "无", recentInteraction: "" },
    ],
    flags: [{ name: "已读旧信", value: "true" }],
    foreshadowing: [
      { text: "教堂地窖的旧信", turn: 3 },
      { text: "码头工人提到的白船", turn: null },
    ],
  };

  beforeEach(() => {
    stateResp = { ok: true, body: VIEW };
    stateQueries = [];
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "game",
      charactersOpen: false,
      stateView: null,
      engineBusy: false,
      segs: { 0: "" },
      curSeg: 0,
      turnNo: 0,
      history: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") return jsonResponse({ ok: true });
        if (url.pathname === "/api/state") {
          stateQueries.push(url.searchParams.get("worldId") || "");
          return stateResp.ok && stateResp.body
            ? jsonResponse(stateResp.body)
            : jsonResponse({ error: "状态文件不存在" }, 404);
        }
        return jsonResponse({}, 404);
      }),
    );
  });

  it("打开面板：拉一次 /api/state 并分块渲染（状态/主角/角色卡/导演手记/Flags·伏笔）", async () => {
    render(<CharactersDrawer />);
    expect(screen.queryByTestId("characters-panel")).toBeNull(); // 关着不渲染

    const trigger = focusProbe(); // 命令轨「角色」按钮的替身：它拿着焦点时开面板（焦点归还的断言要用）
    await act(async () => {
      useGameStore.getState().toggleCharacters();
    });
    expect(stateQueries).toEqual(["campus-summer-1"]); // 开面板拉一次
    await waitFor(() => expect(useGameStore.getState().stateView).toEqual(VIEW));

    expect(screen.getByTestId("characters-panel")).toBeTruthy();
    expect(screen.getByTestId("characters-status").textContent).toContain("第三夜 · 雨停后");
    expect(screen.getByTestId("characters-status").textContent).toContain("灰雀镇廉价旅店 202 房");
    expect(screen.getByTestId("characters-protagonist").textContent).toContain("顾迟");
    const card = within(screen.getByTestId("character-card-薇拉"));
    expect(card.getByText("薇拉")).toBeTruthy();
    expect(card.getByText("62")).toBeTruthy(); // 好感度数字
    expect(card.getByTestId("character-expression-薇拉").textContent).toBe("微笑");
    expect(screen.getByTestId("characters-director").textContent).toContain("旅店停电");
    expect(screen.getByTestId("characters-notes").textContent).toContain("已读旧信");
    expect(screen.getByTestId("characters-notes").textContent).toContain("码头工人提到的白船");

    // —— v1.9 a11y：抽屉语义 + 焦点陷阱 + 关闭归还 ——
    const panel = screen.getByTestId("characters-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe("角色面板");
    const close = within(panel).getByRole("button", { name: "关闭角色面板" });
    expect(document.activeElement).toBe(close); // 开面板把焦点送进抽屉（第一个可聚焦元素）
    // 陷阱认到的那份清单：关闭按钮 + 薇拉那张卡的「秘密」折叠（沈屿的秘密是「无」，没有折叠位）
    const secret = screen.getByTestId("character-secret-薇拉");
    expect(focusableElements(panel)).toEqual([close, secret]);
    secret.focus();
    pressTab(); // 末 → 首：不跑出抽屉去逛 TopBar / 命令轨
    expect(document.activeElement).toBe(close);
    pressTab(true); // 首 → 末（Shift+Tab 反向回绕到同一个末项）
    expect(document.activeElement).toBe(secret);

    // 关闭归还焦点：回到开面板前拿着焦点的那个元素
    act(() => {
      useGameStore.getState().toggleCharacters();
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("秘密折叠：默认收起（aria-expanded=false），点击展开可见原文；「无」与空串不留折叠位", async () => {
    render(<CharactersDrawer />);
    await act(async () => {
      useGameStore.getState().toggleCharacters();
    });
    await waitFor(() => expect(useGameStore.getState().stateView).toEqual(VIEW));

    const toggleBtn = screen.getByTestId("character-secret-薇拉");
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("character-secret-text-薇拉")).toBeNull(); // 剧透默认不可见
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("character-secret-text-薇拉").textContent).toBe("缺页是她自己撕的");
    // 沈屿的秘密是模板占位「无」：不渲染折叠入口
    expect(screen.queryByTestId("character-secret-沈屿")).toBeNull();
  });

  it("刷新时机：turn_end 后面板开着自动重拉、关着不拉；世界切换清空", async () => {
    await act(async () => {
      useGameStore.getState().toggleCharacters();
    });
    await waitFor(() => expect(stateQueries).toHaveLength(1));

    act(() => {
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(stateQueries).toHaveLength(2); // 面板开着：回合收尾重拉

    act(() => {
      useGameStore.getState().toggleCharacters(); // 关掉
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(stateQueries).toHaveLength(2); // 关着不拉

    // 世界切换（resetRunState 路径）：面板收起、视图清空
    act(() => {
      useGameStore.getState().selectPreset(PRESET);
    });
    const s = useGameStore.getState();
    expect(s.charactersOpen).toBe(false);
    expect(s.stateView).toBeNull();
  });

  it("空态：还没有 state.md（404）时显示占位说明，不渲染任何分块", async () => {
    stateResp = { ok: false, body: null };
    render(<CharactersDrawer />);
    await act(async () => {
      useGameStore.getState().toggleCharacters();
    });
    await waitFor(() => expect(stateQueries).toHaveLength(1));
    await act(async () => {}); // 404 的 rejection 落定
    expect(useGameStore.getState().stateView).toBeNull();
    expect(screen.getByTestId("characters-empty").textContent).toContain("还没有可展示的角色状态");
    expect(screen.queryByTestId("characters-list")).toBeNull();
  });
});

describe("TitleScreen：剧本导出/导入（v1.7）", () => {
  const RIFT: Preset = { ...PRESET, id: "rift-mark", title: "裂痕纹章" };
  let presetsResp: Preset[];
  let importResp: { ok: boolean; id?: string; error?: string };
  let presetPosts: { action: string; bundle: unknown }[];
  let presetGets: number;

  beforeEach(() => {
    presetsResp = [PRESET, RIFT];
    importResp = { ok: true, id: "campus-summer-9" };
    presetPosts = [];
    presetGets = 0;
    useGameStore.setState({ presets: [], titleNotice: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/presets" && init?.method === "POST") {
          presetPosts.push(JSON.parse(String(init.body)));
          return jsonResponse(importResp);
        }
        if (url.pathname === "/api/presets") {
          presetGets += 1;
          return jsonResponse({ presets: presetsResp, errors: [] });
        }
        return jsonResponse({}, 404);
      }),
    );
  });

  it("导出：当前卡带「导出」小按钮指向 /api/presets/export?id= 并带 <id>.preset.json 下载名", async () => {
    render(<TitleScreen />);
    await waitFor(() => expect(screen.getByTestId("title-card-center")).toBeTruthy());

    // 字标区：h1 就是页面的名字（读屏与结构化定位靠它），与卡带舞台是两件事
    const wordmark = screen.getByTestId("title-wordmark");
    expect(wordmark.tagName).toBe("H1");
    expect(wordmark.textContent).toBe("bunkiten");

    const link = screen.getByTestId("preset-export-campus-summer") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/presets/export?id=campus-summer");
    expect(link.getAttribute("download")).toBe("campus-summer.preset.json");
    expect(link.getAttribute("aria-label")).toBe("导出剧本 盛夏偏差值");
    // 只有当前卡带导出按钮（← → 切卡后目标跟着换）
    expect(screen.queryByTestId("preset-export-rift-mark")).toBeNull();
  });

  it("导入：选中文件 → POST import → 重取轮播出新卡并提示「已导入为 <id>」", async () => {
    render(<TitleScreen />);
    await waitFor(() => expect(screen.getByTestId("preset-import-input")).toBeTruthy());
    expect(presetGets).toBe(1); // 挂载拉过一次

    // 导入成功后服务端的轮播会多出新卡：第二次 GET 返回带新卡的列表
    const IMPORTED: Preset = { ...PRESET, id: "campus-summer-9", title: "导入的副本" };
    presetsResp = [...presetsResp, IMPORTED];
    const bundle = {
      format: "bunkiten-preset",
      version: 1,
      id: "campus-summer-9",
      title: "导入的副本",
      exportedAt: "2026-09-17T00:00:00.000Z",
      presetMd: "---\nid: campus-summer-9\ntitle: 导入的副本\n---\n",
      assets: { "cover.jpg": "/9j/" },
      audio: {},
    };
    const file = new File([JSON.stringify(bundle)], "campus-summer-9.preset.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("preset-import-input"), { target: { files: [file] } });

    await waitFor(() => expect(presetPosts).toEqual([{ action: "import", bundle }]));
    await waitFor(() => expect(screen.getByTestId("title-notice").textContent).toContain("已导入为 campus-summer-9"));
    expect(screen.getByTestId("title-notice").getAttribute("data-kind")).toBe("ok");
    await waitFor(() => expect(presetGets).toBe(2)); // 成功后重取轮播

    // 轮播真的刷新了：新卡排在末尾，切到它（→ →）后导出按钮换成新 id
    await act(async () => {});
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByTestId("preset-export-campus-summer-9")).toBeTruthy());
  });

  it("导入失败：不是导出包本地挡下（不打服务端）；服务端拒绝走错误提示位", async () => {
    render(<TitleScreen />);
    await waitFor(() => expect(screen.getByTestId("preset-import-input")).toBeTruthy());

    // 本地校验：普通 JSON 不是导出包 → 不 POST
    const junk = new File(["这只是一段普通文本"], "note.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("preset-import-input"), { target: { files: [junk] } });
    await waitFor(() => expect(screen.getByTestId("title-notice").textContent).toContain("不是有效的剧本导出包"));
    expect(screen.getByTestId("title-notice").getAttribute("data-kind")).toBe("error");
    expect(presetPosts).toEqual([]);

    // 服务端拒绝（文件名安全等裁决在 server）：错误信息透传到提示位
    importResp = { ok: false, error: "非法的素材文件名: ../x.jpg" };
    const file = new File(
      [JSON.stringify({ format: "bunkiten-preset", version: 1, id: "x", presetMd: "# y\n", assets: {}, audio: {} })],
      "x.preset.json",
    );
    fireEvent.change(screen.getByTestId("preset-import-input"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("title-notice").textContent).toContain("导入失败：非法的素材文件名: ../x.jpg"));
    expect(screen.getByTestId("title-notice").getAttribute("data-kind")).toBe("error");
    expect(presetGets).toBe(1); // 失败不重取轮播
  });
});

describe("store handleEvent：未知事件类型兜底（v1.7 表驱动分发的运行时护栏）", () => {
  it("未知 type 只 console.warn 一条、不污染任何 state 字段（服务端比客户端新时不崩不脏）", () => {
    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    try {
      const before = useGameStore.getState();
      const snap = { ...before } as Record<string, unknown>;
      // @ts-expect-error 故意投一个 AcpEvent 联合之外的类型：SSE JSON.parse 是盲转，这条路径真实可达
      useGameStore.getState().handleEvent({ type: "bogus-probe" });
      const after = useGameStore.getState() as Record<string, unknown>;
      expect(warns.length).toBe(1);
      expect(String(warns[0][0])).toContain("bogus-probe");
      // 除监听器/函数引用外，任何数据字段都不被未知事件改写
      for (const key of Object.keys(snap)) {
        if (typeof snap[key] === "function") continue;
        expect(after[key], `未知事件不该改写 ${key}`).toEqual(snap[key]);
      }
    } finally {
      console.warn = orig;
    }
  });
});

// ————————————— v1.8：对话面板自动/快进 · 标题屏「继续上次」 · 章节切换器 · 家谱缩放 —————————————

describe("DialogueBox：面板上的自动 / 快进控件（v1.8）", () => {
  /** 已显示的正文（去掉打字中的金色光标 ▌）：断言「显示到哪儿」用 */
  const shownText = () => (screen.getByTestId("dialogue-text").textContent ?? "").replace("▌", "");
  /** 「自动」开启时落到哪个档：与组件的 AUTO_ON 同源——档位表里第一个非零项 */
  const AUTO_ON = AUTO_ADVANCE_OPTIONS.filter((v) => v > 0)[0];

  afterEach(() => {
    vi.useRealTimers();
    useGameStore.getState().cancelAutoAdvance(); // 倒计时是模块级定时器单例：先撤掉再回默认
    useGameStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      options: null,
      typingDone: false,
      received: "",
      finalText: "",
      turnKey: 0,
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
      engineBusy: false,
      pendingCreationMessage: null,
      pendingTreeMessage: null,
    });
    window.localStorage.clear();
  });

  it("点「自动」：落到首个非零档并武装倒计时（选项上屏即出倒计时标记），再点一次关掉并撤掉倒计时", () => {
    vi.useFakeTimers();
    // 武装的前置一次给全：游戏屏 / 引擎空闲 / 打字完成 / 选项非空 / 无排队指令
    useGameStore.setState({
      screen: "game",
      engineBusy: false,
      typingDone: true,
      options: [
        { n: "1", t: "溜进座位" },
        { n: "2", t: "转身去天台" },
      ],
      pendingCreationMessage: null,
      pendingTreeMessage: null,
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 0 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
    render(
      <>
        <DialogueBox />
        <OptionList />
      </>,
    );
    expect(screen.getByTestId("dialogue-auto").getAttribute("aria-pressed")).toBe("false");
    expect(useGameStore.getState().autoAdvanceDeadline).toBeNull(); // 设置关着：选项上屏也不起计时
    expect(screen.queryByTestId("auto-advance")).toBeNull();

    fireEvent.click(screen.getByTestId("dialogue-auto"));
    const on = useGameStore.getState();
    expect(on.settings.autoAdvance).toBe(AUTO_ON); // 首个非零档
    expect(on.settings.autoAdvance).toBe(3000); // 就是 3 秒档
    expect(screen.getByTestId("dialogue-auto").getAttribute("aria-pressed")).toBe("true");
    expect(on.autoAdvanceDeadline).not.toBeNull(); // 前置齐了：立刻武装，不必等下一回合
    expect(screen.getByTestId("auto-advance").textContent).toBe("自动前进 · 3s");

    fireEvent.click(screen.getByTestId("dialogue-auto"));
    const off = useGameStore.getState();
    expect(off.settings.autoAdvance).toBe(0);
    expect(off.autoAdvanceDeadline).toBeNull(); // 关掉必须连已排好的定时器一起撤，否则到点照样替玩家选
    expect(screen.getByTestId("dialogue-auto").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("auto-advance")).toBeNull();

    // 前置不满足（引擎忙）：只落设置、不武装——「点了自动」不等于「现在就会自动前进」
    useGameStore.setState({ engineBusy: true });
    fireEvent.click(screen.getByTestId("dialogue-auto"));
    const busy = useGameStore.getState();
    expect(busy.settings.autoAdvance).toBe(AUTO_ON);
    expect(busy.autoAdvanceDeadline).toBeNull();
    expect(screen.queryByTestId("auto-advance")).toBeNull();
  });

  it("点「自动」不补全正文（stopPropagation）：打字机停在原处；对照点面板本体才到全文", () => {
    vi.useFakeTimers();
    const full = "蝉鸣把旧教学楼叫成一锅白粥，她抱着书包站在教室后门，听见里面有人压低嗓子念她的名字。";
    useGameStore.setState({
      screen: "game",
      engineBusy: false,
      received: full,
      finalText: full,
      turnKey: 61,
      options: null,
      typingDone: false,
      status: "引擎演绎中…",
      settings: { ...DEFAULT_SETTINGS, textSpeed: "standard", autoAdvance: 0 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
    render(<DialogueBox />);
    expect(screen.getByTestId("dialogue-hint").textContent).toBe("空格补全");
    act(() => vi.advanceTimersByTime(TEXT_SPEED_MS.standard)); // 打字机才追了一个字
    expect(shownText()).toBe(full.slice(0, 1));
    expect(useGameStore.getState().typingDone).toBe(false);

    fireEvent.click(screen.getByTestId("dialogue-auto"));
    expect(shownText()).toBe(full.slice(0, 1)); // 这一下没走「补全全文」那条路
    expect(useGameStore.getState().typingDone).toBe(false);
    expect(useGameStore.getState().settings.autoAdvance).toBe(AUTO_ON); // 开关语义本身照旧生效

    // 对照：点面板本体才是补全路径——上面的「没补全」不是补全坏了，而是自动那一下被拦在了控件里
    fireEvent.click(screen.getByTestId("dialogue-box"));
    expect(shownText()).toBe(full);
    expect(useGameStore.getState().typingDone).toBe(true);
    expect(screen.queryByTestId("dialogue-hint")).toBeNull();
  });

  it("点「快进」与空格/点面板同一条路：正文一次到全文，打字完成后按钮禁用（不谎称点了有用）", () => {
    vi.useFakeTimers();
    const full = "雨声漫过教堂的尖顶，薇拉抱着账册站在门口，没有看你。";
    useGameStore.setState({
      screen: "game",
      engineBusy: false,
      received: full,
      finalText: full,
      turnKey: 62,
      options: null,
      typingDone: false,
      status: "引擎演绎中…",
      settings: { ...DEFAULT_SETTINGS, textSpeed: "standard", autoAdvance: 0 },
    });
    render(<DialogueBox />);
    act(() => vi.advanceTimersByTime(TEXT_SPEED_MS.standard));
    expect(shownText()).toBe(full.slice(0, 1));

    const skip = screen.getByTestId("dialogue-skip") as HTMLButtonElement;
    expect(skip.disabled).toBe(false);
    expect(skip.getAttribute("aria-label")).toBe("立即显示全文");
    fireEvent.click(skip);
    expect(shownText()).toBe(full); // 一次到全文
    expect(useGameStore.getState().typingDone).toBe(true);
    expect((screen.getByTestId("dialogue-skip") as HTMLButtonElement).disabled).toBe(true); // 打完了：没有可补的

    fireEvent.click(screen.getByTestId("dialogue-skip")); // 再点不会改变已定稿的正文
    expect(shownText()).toBe(full);
    expect(useGameStore.getState().typingDone).toBe(true);

    // 空格与「聚焦的按钮」的边界（v1.8 修复）：打字中焦点落在按钮上时空格是**按钮的激活键**，
    // 面板不许 preventDefault 把它按灭（那一下之后浏览器会派发 click，补全归按钮自己的 onClick）。
    // 旧行为：completeNow 成功即 preventDefault → 聚焦的自动/快进按空格毫无反应。
    act(() => useGameStore.setState({ received: full, finalText: full, turnKey: 63, typingDone: false }));
    act(() => vi.advanceTimersByTime(TEXT_SPEED_MS.standard));
    const skipAgain = screen.getByTestId("dialogue-skip") as HTMLButtonElement;
    expect(skipAgain.disabled).toBe(false);
    act(() => skipAgain.focus());
    expect(fireEvent.keyDown(skipAgain, { key: " " })).toBe(true); // 没被 preventDefault：按键留给按钮
    expect(shownText()).toBe(full.slice(0, 1)); // 也没「顺手替按钮补全」：面板没动过正文

    // 对照组：焦点不在按钮上（body）时空格照旧补全全文——这一段语义没被上面那道让路挪走
    act(() => skipAgain.blur());
    expect(fireEvent.keyDown(document.body, { key: " " })).toBe(false); // 被 preventDefault（不滚页）
    expect(shownText()).toBe(full);
    expect(useGameStore.getState().typingDone).toBe(true);
  });
});

describe("TitleScreen：继续上次（v1.8）", () => {
  const NOW = Date.now();
  const RIFT: Preset = { ...PRESET, id: "rift-mark", title: "裂痕纹章" };

  /** 世界线条目构造器（只写用例关心的字段） */
  function world(over: Partial<WorldEntry> & { worldId: string }): WorldEntry {
    return {
      preset: "campus-summer",
      title: "盛夏偏差值",
      chapterNo: 1,
      lastPlayed: NOW - 60_000,
      note: "",
      forkedFrom: null,
      exists: true,
      ...over,
    };
  }

  /** GET /api/worlds 的清单（可被单个用例覆盖） */
  let worldsResp: WorldEntry[];
  /** POST /prompt 收到的指令 */
  let prompts: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    worldsResp = [];
    prompts = [];
    useGameStore.setState({
      presets: [],
      titleNotice: null,
      screen: "title",
      screenReturn: null,
      selected: null,
      worldId: null,
      worldLabel: "",
      engineBusy: false,
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/presets") return jsonResponse({ presets: [PRESET, RIFT], errors: [] });
      if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
      if (url.pathname === "/prompt") {
        prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("没有世界线：不给「继续上次」入口（清单已拉到才断言，避免把「还没加载」当成没有）", async () => {
    render(<TitleScreen />);
    await waitFor(() => expect(screen.getByTestId("title-card-center")).toBeTruthy());
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/worlds")).toBe(true));
    expect(screen.queryByTestId("title-continue")).toBeNull();
  });

  it("有世界线：按钮写最近游玩的那条（显示名 + 第 N 章），点击选它所属剧本、落 worldId 并发续玩指令", async () => {
    worldsResp = [
      world({
        worldId: "rift-mark-2",
        preset: "rift-mark",
        title: "裂痕纹章",
        label: "雨夜的岔口",
        chapterNo: 5,
        lastPlayed: NOW - 60_000,
      }),
      world({ worldId: "campus-summer-1", label: "一周目", chapterNo: 2, lastPlayed: NOW - 3 * 3_600_000 }),
    ];
    render(<TitleScreen />);
    const btn = await screen.findByTestId("title-continue");
    expect(btn.textContent).toContain("雨夜的岔口"); // 最近游玩的那条（不是清单里的第一条）
    expect(btn.textContent).toContain("第 5 章");
    expect(btn.textContent).not.toContain("一周目");
    expect(btn.getAttribute("aria-label")).toBe("继续上次的世界线 雨夜的岔口");
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(btn);
    const s = useGameStore.getState();
    expect(s.selected?.id).toBe("rift-mark"); // 选的是该世界所属剧本，不是轮播中央的第一张卡
    expect(s.worldId).toBe("rift-mark-2");
    expect(s.chapterNo).toBe(5);
    expect(s.screen).toBe("game"); // 直通游戏屏（免去 title → worlds → 继续 三跳）
    await waitFor(() => expect(prompts).toEqual(["继续世界：rift-mark-2。"]));
  });

  it("旧版分叉备注不上屏：回退剧本名；剧本已移除时回退「未命名世界线」（裸 id 永不出现）", async () => {
    worldsResp = [world({ worldId: "campus-summer-2", chapterNo: 2, note: "分叉自 campus-summer-1 @ 1-1" })];
    render(<TitleScreen />);
    const btn = await screen.findByTestId("title-continue");
    expect(btn.textContent).toContain("盛夏偏差值"); // 备注是裸 id 串（isLegacyForkNote）= 没有备注，回退剧本名
    expect(btn.textContent).not.toContain("分叉自");
    expect(btn.textContent).not.toContain("campus-summer-2");
    expect(btn.getAttribute("aria-label")).toBe("继续上次的世界线 盛夏偏差值");

    // 该世界的剧本已从数据目录移除：显示名一路回退到「未命名世界线」，按钮禁用并说明原因
    cleanup();
    worldsResp = [world({ worldId: "ghost-1", preset: "ghost", title: "", note: "" })];
    render(<TitleScreen />);
    const gone = await screen.findByTestId("title-continue");
    expect(gone.textContent).toContain("未命名世界线");
    expect(gone.textContent).not.toContain("ghost-1");
    expect((gone as HTMLButtonElement).disabled).toBe(true);
    expect(gone.getAttribute("title")).toBe("剧本已移除");
  });
});

describe("StoryTreeScreen：章节切换器与归档药丸（v1.8）", () => {
  /** 两章 + 一页归档：第 2 章带进度指针（默认章），第 3 章只有末节一个节点 */
  const TREE_MD = [
    "# 剧情树",
    "## 归档",
    "- 第 1 章：教室相遇；已走：1-1 → 1-2",
    "",
    "## 第 2 章：雨夜来客",
    "- 当前进度: 节点 2-2（已走 3 轮）",
    "",
    "### 节点 2-1（来客敲门）",
    "- 地点: 灰雀镇旅店",
    "- 状态: 已走过",
    "",
    "### 节点 2-2（门外的雨声）",
    "- 地点: 灰雀镇旅店",
    "- 梗概: 来客淋着雨递上一封信",
    "- 状态: 已走过",
    "",
    "## 第 3 章：雨夜之后",
    "",
    "### 节点 3-1（天亮了）",
    "- 地点: 旅店门口",
    "- 梗概: 雨停了，街上没人",
    "- 状态: 可达",
  ].join("\n");

  /** 会让**章号重号**的树：`## 第 四 章` 的标题是中文数字（chapterNoOf 读不出数字），
      章号只能取自节点 id 前缀 3-9 → 与前面的「第 3 章」同号。没有复合键时两颗药丸会撞成
      同一个 tree-chapter-3，第二颗永远点不开 */
  const DUP_MD = [
    TREE_MD,
    "",
    "## 第 四 章：末尾的灯",
    "",
    "### 节点 3-9（末尾的灯）",
    "- 地点: 旅店走廊",
    "- 状态: 可达",
  ].join("\n");

  /** 屏内重取（刷新/编辑完成）时返回的树文；用例可换成重号树 */
  let treeMd = "";

  beforeEach(() => {
    treeMd = TREE_MD;
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "tree",
      screenReturn: "game",
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/tree") return jsonResponse({ worldId: "campus-summer-1", markdown: treeMd });
        if (url.pathname === "/api/history") return jsonResponse({ worldId: "campus-summer-1", snapshots: [] });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("每个解析出的章一颗药丸（归档不算章）；进度章标「当前」；点另一章重绘那一章、旧章节点卸载", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    // 标题里的世界名：worldLabel 就是裸 worldId 时不上屏（显示层兜底），有真名字才写出来
    expect(screen.getByText("剧情图 · 本世界线")).toBeTruthy();
    act(() => useGameStore.setState({ worldLabel: "雨夜的岔口" }));
    expect(screen.getByText("剧情图 · 雨夜的岔口")).toBeTruthy();
    act(() => useGameStore.setState({ worldLabel: "campus-summer-1" }));

    const switcher = screen.getByTestId("tree-chapters");
    expect(within(switcher).getAllByRole("button")).toHaveLength(2); // 归档不是章：不进切换器
    // testid 用「章号-下标」复合键（章号会重号，见下面那段）：第 2 章在 0 位、第 3 章在 1 位
    const ch2 = screen.getByTestId("tree-chapter-2-0");
    const ch3 = screen.getByTestId("tree-chapter-3-1");
    expect(ch2.textContent).toContain("第 2 章 · 雨夜来客");
    expect(ch3.textContent).toContain("第 3 章 · 雨夜之后");
    expect(ch2.getAttribute("aria-pressed")).toBe("true"); // 默认画进度指针所在的那一章
    expect(within(ch2).getByText("当前")).toBeTruthy();
    expect(ch3.getAttribute("aria-pressed")).toBe("false");
    expect(within(ch3).queryByText("当前")).toBeNull();

    expect(screen.getByTestId("tree-node-2-1")).toBeTruthy();
    expect(screen.queryByTestId("tree-node-3-1")).toBeNull();

    fireEvent.click(ch3);
    expect(screen.getByTestId("tree-node-3-1")).toBeTruthy(); // 换章真的重绘了
    expect(screen.queryByTestId("tree-node-2-1")).toBeNull(); // 旧章节点整块卸载
    expect(screen.getByTestId("tree-chapter-3-1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tree-chapter-2-0").getAttribute("aria-pressed")).toBe("false");
    expect(within(screen.getByTestId("tree-chapter-2-0")).getByText("当前")).toBeTruthy(); // 进度指针仍在第 2 章

    // 章号重号（番外章的首个节点 id 前缀同为 3）：复合键保证 testid 与选中态逐项唯一——
    // 只按章号认的话这棵树会给两颗同名药丸，点第二颗会落回第一颗（选不中，画布也不换）
    treeMd = DUP_MD;
    act(() => useGameStore.getState().refreshTree());
    await waitFor(() => expect(screen.getByTestId("tree-chapter-3-2")).toBeTruthy());
    const pills = within(screen.getByTestId("tree-chapters"));
    expect(pills.getAllByRole("button")).toHaveLength(3);
    expect(pills.getByTestId("tree-chapter-3-1").textContent).toContain("第 3 章 · 雨夜之后");
    expect(pills.getByTestId("tree-chapter-3-2").textContent).toContain("第 3 章 · 末尾的灯");
    expect(pills.getByTestId("tree-chapter-3-1").getAttribute("aria-pressed")).toBe("true"); // 键还在：选中不漂

    fireEvent.click(pills.getByTestId("tree-chapter-3-2"));
    expect(screen.getByTestId("tree-chapter-3-2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tree-chapter-3-1").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("tree-node-3-9")).toBeTruthy(); // 画的是后一颗药丸那一章
    expect(screen.queryByTestId("tree-node-3-1")).toBeNull();
  });

  it("归档药丸不是死链：点它明说「只剩目录信息」并就地高亮，再点收起；不冒充能开那一章", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    const pill = screen.getByTestId("tree-archive-0");
    expect(pill.textContent).toContain("第 1 章");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("tree-archive-notice")).toBeNull();

    fireEvent.click(pill);
    expect(screen.getByTestId("tree-archive-notice").textContent).toBe("这一章已归档，只保留了目录信息");
    expect(screen.getByTestId("tree-archive-0").getAttribute("aria-pressed")).toBe("true");
    // 归档只有目录信息（节点数据不在文件里）：画布照旧停在当前进度章，不会切到一个空章
    expect(screen.getByTestId("tree-chapter-2-0").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tree-node-2-1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tree-archive-0"));
    expect(screen.queryByTestId("tree-archive-notice")).toBeNull(); // 再点收起
  });
});

describe("WorldsScreen：家谱画布缩放与渲染宽度上界（v1.8）", () => {
  const NOW = Date.now();
  /** 与 WorldsScreen 传给 layoutGenealogy 的节点几何同值（上界按节点宽换算） */
  const GEN_NODE_W = 210;
  const GEN_NODE_H = 64;
  const GEN_MAX_NODE_PX = 270;
  /** 家谱画布的鼠标/键盘提示（挂在画布工具条那一行） */
  const HINT = "滚轮缩放 · 拖拽平移 · 双击复位 · 方向键走节点";

  /** 世界线条目构造器（只写用例关心的字段） */
  function world(over: Partial<WorldEntry> & { worldId: string }): WorldEntry {
    return {
      preset: "campus-summer",
      title: "盛夏偏差值",
      chapterNo: 1,
      lastPlayed: NOW - 60_000,
      note: "",
      forkedFrom: null,
      exists: true,
      ...over,
    };
  }

  /** GET /api/worlds 的清单（可被单个用例覆盖） */
  let worldsResp: WorldEntry[];

  beforeEach(() => {
    worldsResp = [];
    useGameStore.setState({
      selected: PRESET,
      screen: "worlds",
      screenReturn: null,
      engineBusy: false,
      worldId: null,
      worldBusy: false,
      worldNotice: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("单节点森林：放大 125%（viewBox 缩小）、适应与双击回 100%；渲染宽度按 layout.width×(270/210) 封上界", async () => {
    worldsResp = [world({ worldId: "w1", label: "一周目" })];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-view-genealogy")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worlds-view-genealogy"));

    const canvas = screen.getByTestId("genealogy-canvas");
    const fit = canvas.getAttribute("viewBox");
    expect(screen.getByTestId("genealogy-node-w1")).toBeTruthy();
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("100%");

    // 渲染宽度上界 = Math.round(layout.width × 270/210)：单节点布局宽 258 → 332（小森林不再被撑到 ~490px/节点）
    const layout = layoutGenealogy(worldsResp, { nodeW: GEN_NODE_W, nodeH: GEN_NODE_H });
    expect(layout.nodes).toHaveLength(1);
    expect(layout.width).toBe(258);
    const expectedCap = Math.round(layout.width * (GEN_MAX_NODE_PX / GEN_NODE_W));
    expect(expectedCap).toBe(332);
    expect(screen.getByTestId("genealogy-canvas-cap").style.maxWidth).toBe(`${expectedCap}px`);

    fireEvent.click(screen.getByTestId("genealogy-zoom-in"));
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("125%");
    expect(canvas.getAttribute("viewBox")).not.toBe(fit);
    expect(box(canvas.getAttribute("viewBox"))[2]).toBeLessThan(box(fit)[2]); // 放大 = 视野变小

    fireEvent.click(screen.getByTestId("genealogy-zoom-fit"));
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("100%");
    expect(canvas.getAttribute("viewBox")).toBe(fit); // 适应态 viewBox 逐字回到初始

    // 缩小按钮：与键盘「−」同一条路——从适应态点一下低于 100%（视野变大），再放大逐字回到适应态
    fireEvent.click(screen.getByTestId("genealogy-zoom-out"));
    const out = canvas.getAttribute("viewBox");
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("80%");
    expect(box(out)[2]).toBeGreaterThan(box(fit)[2]); // 缩小 = 视野变大
    fireEvent.click(screen.getByTestId("genealogy-zoom-in"));
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("100%");
    expect(canvas.getAttribute("viewBox")).toBe(fit);

    fireEvent.click(screen.getByTestId("genealogy-zoom-in"));
    expect(canvas.getAttribute("viewBox")).not.toBe(fit);
    fireEvent.doubleClick(canvas);
    expect(canvas.getAttribute("viewBox")).toBe(fit); // 双击画布复位
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("100%");
  });

  it("键盘 + / 0 与按钮同一条路：缩放不打扰节点焦点与选中；操作提示挂在画布工具条（家谱视图无页脚）", async () => {
    worldsResp = [
      world({ worldId: "w3", label: "三周目", forkedFrom: { worldId: "w2", nodeId: "3-1" }, lastPlayed: NOW - 60_000 }),
      world({ worldId: "w2", label: "二周目", forkedFrom: { worldId: "w1", nodeId: "2-2" }, lastPlayed: NOW - 3_600_000 }),
      world({ worldId: "w1", label: "一周目", lastPlayed: NOW - 2 * 86_400_000 }),
    ];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-view-genealogy")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worlds-view-genealogy"));

    const canvas = screen.getByTestId("genealogy-canvas");
    const fit = canvas.getAttribute("viewBox");

    // 选中一个节点（走位键的既有路径）：详情条出现、DOM 焦点也在该节点上
    fireEvent.keyDown(screen.getByTestId("genealogy-node-w3"), { key: "ArrowUp" });
    await waitFor(() => expect(within(screen.getByTestId("genealogy-detail")).getByText("二周目")).toBeTruthy());
    const focused = screen.getByTestId("genealogy-node-w2");
    expect(document.activeElement).toBe(focused);

    fireEvent.keyDown(focused, { key: "+" }); // 节点没消费的键冒泡到画布容器
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("125%");
    expect(canvas.getAttribute("viewBox")).not.toBe(fit);
    expect(document.activeElement).toBe(focused); // 缩放没有把焦点搬走
    expect(within(screen.getByTestId("genealogy-detail")).getByText("二周目")).toBeTruthy(); // 选中也没被清掉

    fireEvent.keyDown(focused, { key: "0" });
    expect(screen.getByTestId("genealogy-zoom-level").textContent).toBe("100%");
    expect(canvas.getAttribute("viewBox")).toBe(fit);

    // 提示行住在画布工具条里（画布之上）：家谱视图整屏不铺页脚，所以它不可能挂在页脚
    const hint = screen.getByText(HINT);
    expect(screen.getByTestId("genealogy-canvas-wrap").contains(hint)).toBe(true);
    expect(hint.compareDocumentPosition(screen.getByTestId("genealogy-canvas-cap")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("↑ ↓ 选择 · Enter 继续")).toBeNull(); // 家谱视图没有页脚那一行

    // 对照：列表视图的页脚是另一处，且那里的提示与本提示各行其是
    fireEvent.click(screen.getByTestId("worlds-view-list"));
    await waitFor(() => expect(screen.getByText("↑ ↓ 选择 · Enter 继续")).toBeTruthy());
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

describe("PresetCheckScreen：剧本体检（v1.9）", () => {
  /**
   * 一份「三过一警一错」的响应（行原文照抄 doctor 的真实产出）：覆盖摘要计数、组块切分、
   * error 行与 ok 行的区分——frontmatter 组里同一条 error 与一条 ok 并存（组内不得整块染红/染绿）。
   */
  const CHECK: PresetCheckResult = {
    ok: false,
    id: "campus-summer",
    title: "盛夏偏差值",
    items: [
      {
        level: "ok",
        group: "frontmatter",
        label: "frontmatter：必填键齐全（id/title/tagline/genre/rating），id 合法且与目录名一致",
      },
      {
        level: "error",
        group: "frontmatter",
        label:
          "frontmatter id「campus-summer」≠ 目录名「campus_summer」——轮播按 id 认剧本、素材按目录名落盘，两边会互相找不到",
      },
      { level: "ok", group: "theme", label: "theme：accent/accent2/motif/font/dialog 全部合法（server 与客户端两层判定都通过）" },
      { level: "warn", group: "正文小节", label: "正文缺 `# protagonist_card` 小节——捏人屏没有问题可问（快速开局路径不受影响）" },
      { level: "ok", group: "封面", label: "封面：cover.jpg 存在" },
    ],
  };

  let fetchMock: ReturnType<typeof vi.fn>;
  /** 每次请求的 URL（重新检查要多打一次） */
  let calls: string[];

  beforeEach(() => {
    calls = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(CHECK);
    });
    vi.stubGlobal("fetch", fetchMock);
    useGameStore.setState({
      selected: PRESET,
      screen: "check",
      screenReturn: "title",
      engineBusy: false,
    });
  });

  it("摘要计数 + 分组块：error 行按 error 渲染（不是 ok），行原文逐字照抄 doctor；返回回进入前的屏", async () => {
    render(<PresetCheckScreen />);
    expect(screen.getByTestId("preset-check-screen")).toBeTruthy();

    // 眉标是当前剧本的标题，标题是屏名（ShellPage 页框）
    const page = screen.getByTestId("shell-page");
    expect(within(page).getByText("盛夏偏差值")).toBeTruthy();
    expect(within(page).getByText("剧 本 体 检")).toBeTruthy();

    const summary = await screen.findByTestId("preset-check-summary");
    expect(summary.textContent).toBe("3 项通过 · 1 警告 · 1 错误"); // 与 doctor 的小结同口径
    expect(screen.getByTestId("preset-check-verdict").textContent).toContain("必须修");
    expect(calls).toEqual(["/api/presets/check?id=campus-summer"]); // 按当前剧本查，不查全局

    // 组块顺序 = doctor 的报告顺序（按首现切块）；一条 group 一个块
    expect(screen.getAllByTestId(/^preset-check-group-\d$/)).toHaveLength(4);
    const g0 = screen.getByTestId("preset-check-group-0");
    expect(within(g0).getByText("frontmatter")).toBeTruthy();
    const rows = within(g0).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // 同一组里 ok 行与 error 行各按自己的级别渲染（不是整块一个色）
    expect(rows[0].getAttribute("data-level")).toBe("ok");
    expect(within(rows[0] as HTMLElement).getByText("通过")).toBeTruthy();
    expect(rows[1].getAttribute("data-level")).toBe("error");
    expect(within(rows[1] as HTMLElement).getByText("错误")).toBeTruthy();
    expect(rows[1].textContent).toContain(CHECK.items[1].label); // 行原文一个字不改
    expect(rows[1].textContent).toContain("≠ 目录名");
    expect(within(screen.getByTestId("preset-check-group-2")).getByText("警告")).toBeTruthy();

    // 「返回」走 closeOverlay：回到进入前的屏（这里 title）
    fireEvent.click(screen.getByTestId("preset-check-back"));
    expect(useGameStore.getState().screen).toBe("title");
    expect(useGameStore.getState().screenReturn).toBeNull();
  });

  it("加载失败 → 错误态；点「重新检查」重取成功后摘要上屏（错误态与动作簇不共用 testid）", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) throw new Error("HTTP 500");
      return jsonResponse(CHECK);
    });
    render(<PresetCheckScreen />);

    const err = await screen.findByTestId("preset-check-error");
    expect(err.textContent).toContain("体检失败");
    expect(err.textContent).toContain("HTTP 500");
    expect(screen.queryByTestId("preset-check-summary")).toBeNull();
    expect(screen.getAllByTestId("preset-check-retry")).toHaveLength(1); // 只有动作簇那一处重试

    fireEvent.click(screen.getByTestId("preset-check-retry"));
    const summary = await screen.findByTestId("preset-check-summary");
    expect(summary.textContent).toBe("3 项通过 · 1 警告 · 1 错误");
    expect(screen.queryByTestId("preset-check-error")).toBeNull();
    expect(calls).toHaveLength(2); // 重新检查真的又查了一次
  });

  it("没有选中的剧本：不白打请求，提示先选剧本且「重新检查」禁用（不是点了没反应的死按钮）", async () => {
    useGameStore.setState({ selected: null });
    render(<PresetCheckScreen />);
    expect(screen.getByTestId("preset-check-nopreset")).toBeTruthy();
    expect(calls).toEqual([]);
    expect((screen.getByTestId("preset-check-retry") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("preset-check-summary")).toBeNull();
  });
});

describe("TitleScreen：剧本体检入口（v1.9）", () => {
  let presetResp: Preset[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    presetResp = [PRESET];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/presets") return jsonResponse({ presets: presetResp, errors: [] });
      if (url.pathname === "/api/worlds") return jsonResponse({ worlds: [] });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    useGameStore.setState({
      presets: [],
      screen: "title",
      screenReturn: null,
      selected: null,
      // 上一局的运行态：体检进屏不得碰它们（不借道 selectPreset）
      worldId: "campus-summer-9",
      worldLabel: "雨夜的岔口",
      cardAnswers: { 性别: ["女"] },
      engineBusy: false,
    });
  });

  it("点「剧本体检」把当前中央卡带进体检屏（只落 selected），运行态原样；没有卡时禁用", async () => {
    render(<TitleScreen />);
    const btn = await screen.findByTestId("preset-check");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);

    const s = useGameStore.getState();
    expect(s.screen).toBe("check"); // overlay：进体检屏
    expect(s.screenReturn).toBe("title"); // 返回目标交给 closeOverlay
    expect(s.selected?.id).toBe("campus-summer"); // 体检对象 = 当前中央卡（不是 null、也不是上一局的本）
    expect(s.worldId).toBe("campus-summer-9"); // 运行态原样：不进世界线屏、不重置
    expect(s.cardAnswers).toEqual({ 性别: ["女"] });

    // 同一角落簇的「素材」同理（v1.9 修）：标题屏还没插卡时 selected 可能是空或上一局的本，
    // 直接 openAssets() 会打开一个空画廊——所以它必须和体检一样把当前中央卡带进去，
    // 且同样只落 selected、不碰运行态
    fireEvent.click(screen.getByRole("button", { name: "素材" }));
    const g = useGameStore.getState();
    expect(g.screen).toBe("assets");
    expect(g.selected?.id).toBe("campus-summer");
    expect(g.worldId).toBe("campus-summer-9");
    expect(g.cardAnswers).toEqual({ 性别: ["女"] });

    // 没有剧本时（轮播空）：按钮禁用并说明原因，点了也不会切屏
    cleanup();
    presetResp = [];
    useGameStore.setState({ presets: [], screen: "title", screenReturn: null, selected: null, worldId: null });
    render(<TitleScreen />);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/presets")).toBe(true));
    const off = screen.getByTestId("preset-check") as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.getAttribute("title")).toBe("还没有可体检的剧本");
    fireEvent.click(off);
    expect(useGameStore.getState().screen).toBe("title");
  });
});

// ————————————————— 启动链超时：boot → title 的读接口（v1.10） —————————————————
// 三条启动链请求（/api/auth、/api/presets、/api/worlds）过去没有等待上限：本地代理/服务卡住时，
// 启动屏永远停在「正在确认登录状态…」、标题屏永远停在「加载中…」——没有反馈也没有出口。
// 现在它们共用一个显式超时（BOOT_FETCH_TIMEOUT_MS），且**fetch 与 body 解析在同一个有界作用域里**
// （只包 fetch 的话 `await r.json()` 既没有 deadline 也没有 signal：先回响应头再挂 body 的代理照样转圈），
// 到点落到**两屏既有的**错误态：启动屏的 RetryCard（「重试」）、标题屏的 setError（「剧本加载失败：…」）。
// 这组用例钉住五件事：
//   1. 超时**不提前**（差 1ms 仍是 checking 态），到点才落地；
//   2. 上限覆盖到解析——响应头先回来、body 挂住，也在同一个上限上落地（否则等于只兜了前半段）；
//   3. 超时错误不是 AbortError——标题屏的 catch 只对 AbortError 静默（那是卸载路径），
//      一旦超时也被静默，玩家就又回到「永远转圈」了，所以这条必须断言到错误文案；
//   4. 交给 fetch 的是**组合 signal（新对象）**：把自己的 signal 原样递下去，超时那一路就取消不了底层请求；
//   5. 卸载优先——外部 signal abort 后立刻以 AbortError 落地（即便传输层不理 signal），
//      不再等到上限把卸载报成 TimeoutError、往已拆掉的屏里写错误态。
describe("启动链超时：读接口挂住时落地到两屏既有的错误态（v1.10）", () => {
  /** 永不 settle 的 fetch：模拟「代理卡住」——既不响应也不失败，**且故意不理 signal**
   *（只让 signal 负责「真取消」是不够的：这条替身证明的是超时靠赛跑落地，不是靠传输层守规矩） */
  function hangingFetch(): ReturnType<typeof vi.fn> {
    const mock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  beforeEach(() => {
    vi.useFakeTimers(); // 超时是 setTimeout 驱动的（不是 AbortSignal.timeout 的内部计时器，那个假计时器推不动）
    useGameStore.setState({ presets: [], screen: "boot", screenReturn: null, selected: null, worldId: null, engineBusy: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("BootScreen：/api/auth 挂到超时 → 出错误重试卡（不再永远停在「正在确认登录状态…」）", async () => {
    const fetchMock = hangingFetch();
    render(<BootScreen />);
    expect(screen.getByText("正在确认登录状态…")).toBeTruthy();

    // 差 1ms：还在自检，不提前报错（超时只兜底真卡住，不该把慢当成坏）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_FETCH_TIMEOUT_MS - 1);
    });
    expect(screen.getByText("正在确认登录状态…")).toBeTruthy();
    expect(screen.queryByText("连不上叙事服务。")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // 既有落点：error 态的 RetryCard（不新增 UI 形态、不改文案），按钮点了就重跑一次自检
    expect(screen.getByText("连不上叙事服务。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    // 超时不只让调用方收场：底层请求真的被取消（signal 已 abort），不把连接留在后台
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("TitleScreen：/api/presets 挂到超时 → 既有 setError 错误态（超时不是 AbortError，不许被静默）", async () => {
    hangingFetch();
    render(<TitleScreen />);
    expect(screen.getByText("加载中…")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_FETCH_TIMEOUT_MS);
    });
    expect(screen.getByText(/剧本加载失败：/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`超时（${BOOT_FETCH_TIMEOUT_MS}ms）`))).toBeTruthy();
    // 轮播没起来：没有可插的卡，错误态是唯一出口（不是「空轮播 + 继续等待」）
    expect(screen.queryByTestId("title-card-center")).toBeNull();
  });

  it("TitleScreen：响应头先回来、body 挂住 → 同样在上限落地（超时覆盖到解析，不只盖响应头）", async () => {
    // 与 hangingFetch 的差别只在「卡在哪一步」：这里 fetch 立刻 resolve（响应头到手），卡的是解析那一步。
    // 上限只包 fetch 的话，这条就会永远停在「加载中…」（r.json() 既没有 deadline 也没有 signal）
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise<never>(() => {}) }) as unknown as Response),
    );
    render(<TitleScreen />);
    expect(screen.getByText("加载中…")).toBeTruthy();

    // 差 1ms：body 还没来也不许提前报错（只是慢的话不该被判死）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_FETCH_TIMEOUT_MS - 1);
    });
    expect(screen.getByText("加载中…")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText(/剧本加载失败：/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`超时（${BOOT_FETCH_TIMEOUT_MS}ms）`))).toBeTruthy();
  });

  it("卸载 abort 仍被静默：组合 signal 透到 fetch，abort 后不再发新请求，超时计时器也不残留", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      // 与真 fetch 同形：signal 一 abort，请求就以 AbortError 拒绝（组合 signal 得把它透进来）
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted.");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<TitleScreen />);
    // 两条启动链请求（presets + worlds）都带着组合 signal（外部 signal ∪ 超时 signal），卸载前都没 abort
    expect(signals.length).toBe(2);
    expect(signals.every((s) => !s.aborted)).toBe(true);

    unmount(); // 切屏/关页面：TitleScreen 的 AbortController abort → 经组合 signal 透到 fetch
    expect(signals.every((s) => s.aborted)).toBe(true);

    // 收尾：请求以 AbortError 结束（标题屏照旧静默吞掉），超时那条路不该再补一枪，计时器也不许残留
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.getTimerCount()).toBe(0);

    // 越过上限再看一眼：卸载之后不该再有任何新的请求（卸载的屏不许还有后续动作）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_FETCH_TIMEOUT_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("组合 signal 是新对象（超时那一路才取消得到底层请求）；卸载优先：传输层不理 signal 也立刻以 AbortError 落地", async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) seen.push(init.signal);
        return new Promise<Response>(() => {}); // 故意不理 signal：这条替身只让赛跑负责落地
      }),
    );

    const external = new AbortController();
    const settled: string[] = [];
    void fetchPresets(external.signal).then(
      () => settled.push("resolved"),
      (e: Error) => settled.push(e.name),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(seen.length).toBe(1);
    // 组合 signal 必须是**新对象**：把外部 signal 原样递下去的话，超时那一路就取消不了底层请求
    //（上限只剩「调用方不等了」这一半，连接与 body 全留在后台）——这条只在组合成立时才会绿
    expect(seen[0]).not.toBe(external.signal);
    expect(seen[0].aborted).toBe(false);
    expect(settled).toEqual([]); // 还没 abort：仍挂着，不提前落地

    external.abort();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 卸载优先：立刻落地，且名字是 AbortError。等 15s 由超时那条路赢下的话，卸载会被报成 TimeoutError
    //（标题屏的 catch 只静默 AbortError），错误态就写进已拆掉的屏里了
    expect(settled).toEqual(["AbortError"]);
    expect(seen[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // 计时器随请求一起收掉，不留 15s 的残余
  });
});
