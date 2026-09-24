// @vitest-environment jsdom
// App 外壳与纯函数（拆自 tests/ui.test.tsx）：Esc 关闭链里的设置屏、状态播报区（aria-live）、lib/status、lib/worlds
// 旧版分叉备注、theme 字体与对话框质感、store handleEvent 未知事件兜底、PresetCheckScreen 剧本体检。
// 单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DialogueBox from "../../src/components/game/DialogueBox";
import PresetCheckScreen from "../../src/components/PresetCheckScreen";
import App, { StatusAnnouncer } from "../../src/App";
import { useGameStore, type PreloadItem } from "../../src/store/game";
import { DEFAULT_SETTINGS } from "../../src/lib/settings";
import { isLegacyForkNote } from "../../src/lib/worlds";
import { playerStatus } from "../../src/lib/status";
import { FONT_STACKS, dialogClass, getTheme, themeVars } from "../../src/theme";
import { type Preset, type PresetCheckResult } from "../../src/lib/acp";
import { PRESET, jsonResponse, setupUi } from "./helpers";

setupUi();

describe("lib/status：引擎状态文案的玩家化映射（v1.6）", () => {
  it("playerStatus 映射表：五个已知条目逐字翻译，表外状态原样透传", () => {
    expect(playerStatus("连接引擎…")).toBe("连接中…");
    expect(playerStatus("引擎演绎中…")).toBe("故事展开中…");
    expect(playerStatus("撰写章节大纲…")).toBe("章节筹备中…");
    expect(playerStatus("就绪")).toBe("就绪");
    expect(playerStatus("出错：HTTP 500")).toBe("出错了：HTTP 500");
    expect(playerStatus("出错：")).toBe("出错了："); // 前缀换成玩家口吻、尾巴原样保留

    // 表外状态原样透传：制作屏的引擎口吻与重演失败的提示都不许被硬翻
    for (const s of ["清点既有美术…", "无法重演：快照不足", "引擎演绎中"]) {
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
    fireEvent.click(
      within(screen.getByTestId("protagonist-question-身份")).getByRole("button", { name: "自由调查员" }),
    );
    expect(within(screen.getByTestId("protagonist-summary-姓名")).getByText("顾迟")).toBeTruthy();
    expect(screen.getByTestId("protagonist-card-summary").textContent).toContain("已填 2 / 2");
    fireEvent.click(screen.getByTestId("protagonist-start"));
    expect(useGameStore.getState().screen).toBe("crafting");
    expect(openingPrompts.at(-1)).toContain("主角卡：姓名=顾迟；身份=自由调查员");
    expect(openingPrompts.at(-1)).toContain("待命：只初始化，不开始剧情");

    // 另一个入口：快速开局 + 跳过美术 → 直接进游戏屏（指令换成跳过预载的结尾）
    cleanup();
    useGameStore.setState({
      screen: "protagonist",
      selected: cardPreset,
      cardAnswers: {},
      worldId: "campus-summer-3",
      engineBusy: false,
    });
    render(<App />);
    fireEvent.click(screen.getByTestId("quick-start"));
    fireEvent.click(screen.getByTestId("skip-preload"));
    expect(useGameStore.getState().screen).toBe("game");
    expect(openingPrompts.at(-1)).toContain("快速开局：用剧本 quick_start 预设主角");
    expect(openingPrompts.at(-1)).toContain("跳过美术预载，直接开演。");

    // 制作中屏（App 按状态渲屏）：一个槽位一张卡（testid = 种类-名字），就绪的出图、进行中/失败项给状态
    cleanup();
    const preload: PreloadItem[] = [
      {
        kind: "portrait",
        name: "薇拉",
        variant: "",
        label: "薇拉",
        command: "美术：立绘 薇拉",
        state: "done",
        url: null,
      },
      {
        kind: "background",
        name: "灰雀镇廉价旅店",
        variant: "",
        label: "灰雀镇廉价旅店",
        command: "美术：背景 灰雀镇廉价旅店",
        state: "running",
        url: null,
      },
      {
        kind: "portrait",
        name: "沈屿",
        variant: "",
        label: "沈屿",
        command: "美术：立绘 沈屿",
        state: "failed",
        url: null,
      },
    ];
    useGameStore.setState({
      screen: "crafting",
      screenReturn: null,
      chapterNo: 1,
      status: "美术进行中…",
      preloadPhase: "queue",
      preload,
      artReady: {
        薇拉: "presets/campus-summer/assets/立绘-薇拉.jpg",
        沈屿: "presets/campus-summer/assets/立绘-沈屿.jpg",
      },
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
    });
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

// ————————————————————— 主题深化：字体族与对话框质感（v1.7） —————————————————————

describe("theme：字体族与对话框质感（v1.7）", () => {
  /** 带 theme 的剧本 fixture（font/dialog 两键是本组的主角） */
  const themed = (theme: Partial<NonNullable<Preset["theme"]>>): Preset => ({
    ...PRESET,
    theme: { accent: "#f0b95a", accent2: "#f7e3b0", motif: "summer", ...theme },
  });

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
    for (const dialog of ["plain", "silk", "paper", "glass"] as const)
      expect(getTheme(themed({ dialog })).dialog).toBe(dialog);
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
      // 两跳：GameStore 没有索引签名，直接 `as Record<string, unknown>` 会被 TS 判为「两类型不重叠」
      const after = useGameStore.getState() as unknown as Record<string, unknown>;
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
      {
        level: "ok",
        group: "theme",
        label: "theme：accent/accent2/motif/font/dialog 全部合法（server 与客户端两层判定都通过）",
      },
      {
        level: "warn",
        group: "正文小节",
        label: "正文缺 `# protagonist_card` 小节——捏人屏没有问题可问（快速开局路径不受影响）",
      },
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
