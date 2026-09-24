// @vitest-environment jsdom
// 游戏 HUD 与制作/创作屏的屏上痕迹（拆自 tests/ui.test.tsx）：TopBar（章节指示/回合耗时/命令轨分组菜单）、
// ChapterCard 章节过场卡、CraftingScreen 可预期性读数与两段式补画徽章、CreationScreen 选项 chip 化与返回确认层。
// 单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责（详见该文件头）。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../src/components/game/TopBar";
import ChapterCard, { CHAPTER_CARD_FADE_MS, CHAPTER_CARD_MS } from "../../src/components/game/ChapterCard";
import OptionList from "../../src/components/game/OptionList";
import CreationScreen from "../../src/components/CreationScreen";
import CraftingScreen from "../../src/components/CraftingScreen";
import { useGameStore } from "../../src/store/game";
import { focusableElements } from "../../src/lib/focusTrap";
import { preloadEtaLabel } from "../../src/lib/preload";
import { jsonResponse, openRailGroup, pressTab, setupUi } from "./helpers";

setupUi();

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

  it("「剧情图」在「图鉴」菜单里：开菜单 → 点它打开剧情图 overlay（记住返回屏）", () => {
    useGameStore.setState({ screen: "game", screenReturn: null });
    render(<TopBar />);
    // v1.12：剧情图从轨上挪进二级菜单——先开分组，叶子项才在 DOM 里
    openRailGroup("图鉴");
    fireEvent.click(screen.getByTitle("剧情图"));
    const s = useGameStore.getState();
    expect(s.screen).toBe("tree");
    expect(s.screenReturn).toBe("game");
  });
});

describe("TopBar：命令轨的分组菜单（v1.12 菜单信息架构）", () => {
  /** POST /prompt 收到的指令（叶子的行为断言：直达项与菜单项发的是同一条指令） */
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
      status: "就绪",
      engineBusy: false,
      worldId: "campus-summer-1",
      turnSnapshots: null,
      pendingResync: null,
    });
  });

  it("顶层只剩 5 项，DOM 顺序即 设置｜回顾｜图鉴｜进度｜帮助，且「设置」仍是 game 屏第一个可聚焦元素", () => {
    render(<TopBar />);
    const nav = screen.getByRole("navigation");
    expect([...nav.children].map((el) => el.getAttribute("data-testid"))).toEqual([
      "settings",
      "rail-review",
      "rail-collection",
      "rail-progress",
      "help",
    ]);
    // 分组触发器用 aria-label 说清自己管什么（可见文案只有两个字，读屏要能独立读懂）
    expect(screen.getByTestId("rail-review").getAttribute("aria-label")).toBe("回顾（历史与前情）");
    expect(screen.getByTestId("rail-collection").getAttribute("aria-label")).toBe("图鉴（角色、画廊与剧情图）");
    expect(screen.getByTestId("rail-progress").getAttribute("aria-label")).toBe("进度（重演、重开与换剧本）");
    // 「设置」排在第一位不是随手写的：它是 game 屏 DOM 里第一个可聚焦元素（Tab 首个落点，
    // tests/e2e-ui/focus.spec.ts 有一条用例盯着）。这条断言把它钉在 jsdom 这一侧，改顺序立刻红
    expect(focusableElements(document.body)[0]).toBe(screen.getByTestId("settings"));
  });

  it("分组菜单：默认收起（叶子项不在 DOM）→ 开「回顾」出历史/前情（菜单语义 + 焦点进首项）→ 点前情发指令并收菜单", async () => {
    render(<TopBar />);
    // 收起态：叶子项一个都不在 DOM（与行 ⋯ 菜单同款）——顺带钉住「没有把两个分组混进同一个弹层」
    for (const id of ["history", "recap", "characters", "assets", "tree", "reroll", "new-game", "presets"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    const trigger = screen.getByTestId("rail-review");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    const menu = openRailGroup("回顾");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-labelledby")).toBe(trigger.id);
    // 弹层朝左开（命令轨贴屏幕右缘）：布局在 jsdom 里量不出，但 side 的意图可以断言
    expect(menu.getAttribute("data-side")).toBe("left");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(["历史", "前情"]);
    // 开菜单把焦点送进弹层（鼠标路径：Radix 只聚焦弹层本身、不落到某一项，与行 ⋯ 菜单同款；
    // 键盘用户接着按 Tab/↓ 走项，走位由下一条用例钉住）
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    // 叶子项沿用原 testid/aria（测试契约逐个保留）：前情发的是原样那条指令
    await act(async () => {
      fireEvent.click(screen.getByTestId("recap"));
    });
    expect(prompts).toEqual(["/recap"]);
    expect(screen.queryByTestId("rail-review-menu")).toBeNull(); // 选中即关
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // 关菜单把焦点送回触发器（Radix 的 onCloseAutoFocus）：焦点不该丢回 body
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("「图鉴」菜单三项各按原契约打开对应 overlay；「帮助」「重开」「换剧本」发原样的指令", async () => {
    render(<TopBar />);

    openRailGroup("图鉴");
    fireEvent.click(screen.getByTestId("characters"));
    expect(useGameStore.getState().charactersOpen).toBe(true);
    act(() => useGameStore.setState({ charactersOpen: false }));

    openRailGroup("图鉴");
    fireEvent.click(screen.getByTestId("assets"));
    expect(useGameStore.getState().screen).toBe("assets");

    openRailGroup("图鉴");
    fireEvent.click(screen.getByTestId("tree"));
    expect(useGameStore.getState().screen).toBe("tree");

    // 直达项（设置/帮助）仍在轨上：帮助与菜单项走同一套 send
    useGameStore.setState({ screen: "game" });
    fireEvent.click(screen.getByTestId("help"));
    expect(prompts).toEqual(["/help"]);

    openRailGroup("进度");
    fireEvent.click(screen.getByTestId("new-game"));
    expect(prompts.at(-1)).toBe("/new-game");

    openRailGroup("进度");
    fireEvent.click(screen.getByTestId("presets"));
    expect(prompts.at(-1)).toBe("/presets");
  });

  it("分组菜单键盘：Esc 就地收菜单（不冒到 Esc 关闭链）、Tab 在项间走位、走到末项交还页面", async () => {
    render(
      <>
        <TopBar />
        {/* 命令轨之后的一个可聚焦元素：Tab 走到菜单末项时「交还页面」的落点（真实屏里是对话区那一簇） */}
        <button type="button" data-testid="after-rail">
          对话区
        </button>
      </>,
    );
    const trigger = screen.getByTestId("rail-review");
    openRailGroup("回顾");
    const recap = screen.getByTestId("recap");
    await waitFor(() => expect(screen.getByTestId("rail-review-menu").contains(document.activeElement)).toBe(true));

    // Esc：就地关菜单。Radix 在 document 捕获阶段处理 Esc，本屏在它那一拍 stopPropagation——
    // window 上的 Esc 关闭链（App）一声都听不到
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    fireEvent.keyDown(recap, { key: "a" }); // 探针：没人拦的按键能冒到 window（证明下面不是空转）
    expect(outer).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(recap, { key: "Escape" });
    window.removeEventListener("keydown", outer);
    expect(outer).toHaveBeenCalledTimes(1); // Esc 那一下被就地吃掉
    expect(screen.queryByTestId("rail-review-menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger)); // 关菜单把焦点送回触发器

    // Tab 走项（本仓既有约定，与行 ⋯ 菜单同一份实现 lib/menuTab）：菜单项 tabIndex=-1、
    // 菜单内容又无条件吞掉 Tab —— 不接手的话 Tab 在菜单里等于按了没反应
    // （上一段 Esc 已把弹层卸掉：这里起每一步都重新取节点，别拿旧的 history/recap 引用比）
    openRailGroup("回顾");
    const menu2 = screen.getByTestId("rail-review-menu");
    await waitFor(() => expect(menu2.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(menu2, { key: "Tab" }); // 从弹层起步（鼠标路径）→ 首项
    expect(document.activeElement).toBe(screen.getByTestId("history"));
    fireEvent.keyDown(screen.getByTestId("history"), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("recap"));
    // 走到末项：把 Tab 交还页面（焦点搬到文档序里弹层之后的第一个可聚焦元素），菜单随之被 focusOutside 收掉。
    // 命令轨的弹层是**非 portal、就地**渲染在 nav 里的（紧跟触发器之后），所以「之后」正是下一枚 rail 触发器
    // 「图鉴」——Tab 沿命令轨继续往下走，而不是飞出整个 nav（这正是我们要的行为）。
    fireEvent.keyDown(screen.getByTestId("recap"), { key: "Tab" });
    await waitFor(() => expect(screen.queryByTestId("rail-review-menu")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("rail-collection"));

    // 反方向：焦点不在任何菜单项上时（鼠标打开只聚焦弹层）Shift+Tab 进末项，再按一次回前一项
    openRailGroup("回顾");
    fireEvent.keyDown(screen.getByTestId("rail-review-menu"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("recap"));
    fireEvent.keyDown(screen.getByTestId("recap"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("history"));
  });

  it("「重演这一幕」只在可重演时出现在「进度」菜单里（v1.13：判据只剩快照数，输入在盘上）", () => {
    useGameStore.setState({ turnSnapshots: 2 });
    render(<TopBar />);
    openRailGroup("进度");
    expect(screen.getByTestId("reroll")).toBeTruthy(); // 攒够两条 turn 快照：入口出现（输入有无由点击时解析）

    act(() => useGameStore.setState({ turnSnapshots: 1 }));
    expect(screen.queryByTestId("reroll")).toBeNull(); // 已知快照不足（首个回合）：不给

    act(() => useGameStore.setState({ turnSnapshots: null }));
    expect(screen.getByTestId("reroll")).toBeTruthy(); // 未知不藏功能：点击后由解析内核判定

    act(() => useGameStore.setState({ pendingResync: { worldId: "campus-summer-1", seq: 2 } }));
    expect(screen.queryByTestId("reroll")).toBeNull(); // 待重同步期间不重演（要覆盖的正是那几份正在变的文件）

    act(() => useGameStore.setState({ pendingResync: null, status: "引擎演绎中…" }));
    expect(screen.queryByTestId("reroll")).toBeNull(); // 非就绪态不给
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

describe("制作中屏与创作屏的可预期性读数（v1.13）", () => {
  const PRESET = {
    id: "demo",
    title: "示例剧本",
    tagline: "",
    genre: "",
    rating: "",
    characters: [],
    protagonist_card: [],
  };

  it("preloadEtaLabel：样本不足不给数、按已完成张数算平均、画完即收口", () => {
    const base = { total: 10, startedAt: 1_000, now: 41_000 }; // 40s 内完成 2 张
    expect(preloadEtaLabel({ ...base, done: 0 }), "一张都没完成时没有样本").toBeNull();
    expect(preloadEtaLabel({ ...base, done: 1 }), "只有一张样本，估出来是噪声").toBeNull();
    expect(preloadEtaLabel({ ...base, done: 2 })).toBe("平均 ≈20s / 张 · 约还需 ~3 分钟");
    expect(preloadEtaLabel({ ...base, done: 10 }), "全画完了就没有「还需」").toBeNull();
    expect(preloadEtaLabel({ ...base, done: 3, startedAt: null }), "没有在跑的批次").toBeNull();
    // 剩余不足 90 秒时切到「秒」档
    expect(preloadEtaLabel({ done: 2, total: 4, startedAt: 0, now: 20_000 })).toBe("平均 ≈10s / 张 · 约还需 ~20 秒");
  });

  it("制作中屏：进度行给「平均每张 · 约还需」，样本不足 2 张时不显示这半截", () => {
    const items = [1, 2, 3, 4, 5].map((i) => ({
      kind: "portrait" as const,
      name: `角色${i}`,
      variant: "",
      label: `角色${i}`,
      command: `美术：立绘 角色${i}`,
      state: i <= 1 ? ("done" as const) : ("pending" as const), // 先只完成 1 张：样本不足，屏上不显示预估
      url: null,
    }));
    useGameStore.setState({
      screen: "crafting",
      selected: PRESET,
      preloadPhase: "queue",
      status: "作画中…",
      chapterNo: 1,
      preload: items,
      preloadBatchStartedAt: Date.now() - 40_000, // 40 秒画完 1 张
    });
    render(<CraftingScreen />);
    const line = screen.getByTestId("crafting-progress").textContent ?? "";
    expect(line).toContain("美术 1 / 5 就绪");
    expect(line, "样本不足 2 张时不该给预估").not.toContain("约还需");

    // 再完成两张（共 3 张）：样本够了 → 读数出现。setState 在 act 里跑，读的是重渲染后的 DOM
    act(() => {
      useGameStore.setState({
        preload: useGameStore
          .getState()
          .preload.map((i, idx) => (idx === 1 || idx === 2 ? { ...i, state: "done" as const } : i)),
      });
    });
    const line2 = screen.getByTestId("crafting-progress").textContent ?? "";
    expect(line2).toContain("美术 3 / 5 就绪");
    expect(line2).toMatch(/平均 ≈\d+s \/ 张 · 约还需 ~\d+ 秒/);
  });

  it("创作屏：状态行说出引擎在干什么（不再是只有 title 的灰点）", () => {
    useGameStore.setState({
      screen: "creation",
      screenReturn: "title",
      status: "引擎演绎中…",
      engineBusy: true,
      turnStartAt: Date.now() - 3000,
    });
    render(<CreationScreen />);
    const line = screen.getByTestId("creation-status").textContent ?? "";
    expect(line, "引擎口吻要转成玩家说法（lib/status 唯一映射）").toContain("故事展开中…");
    expect(line, "忙时带上已耗时秒数").toMatch(/\d+s/);
  });
});

describe("两段式制作的屏上痕迹（v1.13）", () => {
  const PRESET = {
    id: "demo",
    title: "示例剧本",
    tagline: "",
    genre: "",
    rating: "",
    characters: [],
    protagonist_card: [],
  };
  const item = (name: string, state: "pending" | "running" | "done") => ({
    kind: "portrait" as const,
    name,
    variant: "",
    label: name,
    command: `美术：立绘 ${name}`,
    state,
    url: null,
  });

  it("CraftingScreen：先没选剧本、随后才落定——hook 顺序不许被打乱（v1.13 真踩过）", () => {
    // 回归：deferredTotal 那个 useGameStore 曾写在 `if (!selected) return null` 之后，
    // 于是「先空后满」的挂载路径会让两次渲染的 hook 数不同（React 直接抛 Rendered fewer hooks）——
    // jsdom 本地常绿、CI 抓到。这条用例就钉这个顺序：先渲染空的，再把 selected 填上。
    useGameStore.setState({ screen: "crafting", selected: null, preloadPhase: "queue", preload: [], deferredArt: [] });
    const { rerender } = render(<CraftingScreen />);
    act(() => {
      useGameStore.setState({
        selected: PRESET,
        preload: [item("沈屿", "done")],
        deferredArt: [item("天台", "pending")],
      });
    });
    rerender(<CraftingScreen />);
    expect(screen.getByTestId("crafting-progress").textContent).toContain("其余 1 项开演后补画");
  });

  it("TopBar：补画进行中挂「补画 N/M」徽章，平时不挂", () => {
    useGameStore.setState({
      status: "作画中…",
      artAsk: true,
      deferredArt: [item("沈屿", "done"), item("天台", "running")],
    });
    const { rerender } = render(<TopBar />);
    expect(screen.getByTestId("art-pump").textContent).toContain("补画 1/2");

    act(() => useGameStore.setState({ artAsk: false }));
    rerender(<TopBar />);
    expect(screen.queryByTestId("art-pump"), "不在补画回合就不该有这枚徽章").toBeNull();
  });

  it("OptionList：补画期间已排队的输入给一句「已记下」", () => {
    useGameStore.setState({
      typingDone: true,
      options: [{ n: "1", t: "推开门" }],
      pendingPlayerPrompt: "推开门",
      autoAdvanceDeadline: null,
    });
    const { rerender } = render(<OptionList />);
    expect(screen.getByTestId("pending-prompt-hint").textContent).toContain("已记下你的选择");

    act(() => useGameStore.setState({ pendingPlayerPrompt: null }));
    rerender(<OptionList />);
    expect(screen.queryByTestId("pending-prompt-hint")).toBeNull();
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
