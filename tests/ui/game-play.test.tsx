// @vitest-environment jsdom
// 游戏屏交互（拆自 tests/ui.test.tsx）：键盘（数字键选选项/空格补全/自动前进倒计时）、DialogueBox 动效降级
// 与自动/快进控件、同屏多立绘的让位档与发言者高亮、角色面板抽屉（渲染/秘密折叠/turn_end 重拉/空态）。
// 单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CharactersDrawer from "../../src/components/game/CharactersDrawer";
import DialogueBox from "../../src/components/game/DialogueBox";
import FreeInput from "../../src/components/game/FreeInput";
import GameStage from "../../src/components/game/GameStage";
import OptionList from "../../src/components/game/OptionList";
import { useGameStore } from "../../src/store/game";
import { focusableElements } from "../../src/lib/focusTrap";
import { AUTO_ADVANCE_OPTIONS, DEFAULT_SETTINGS, TEXT_SPEED_MS } from "../../src/lib/settings";
import { type StateView } from "../../src/lib/acp";
import { PRESET, jsonResponse, openRailGroup, focusProbe, pressTab, FakeSpeechRecognition, setupUi } from "./helpers";

setupUi();

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
    expect(prompts.at(-1)).toBe("推门进去"); // 收敛空白后原样发出（输入本身随服务端的快照条目落盘，客户端不再记账）
    expect(field.value).toBe("");
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
    useGameStore.setState({
      received: "",
      finalText: "",
      turnKey: 43,
      options: null,
      typingDone: true,
      status: "就绪",
    });
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

// ————————————————————— 动效降级（prefers-reduced-motion，v1.7） —————————————————————

describe("DialogueBox：动效降级（prefers-reduced-motion，v1.7）", () => {
  /** jsdom 没有 matchMedia 实现：手工挂一个（matches 固定、change 永不触发），测完删掉还原 */
  const stubMatchMedia = (matches: boolean) => {
    window.matchMedia = (() => ({
      matches,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
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
    // 抽屉自己**不在** inert 子树里：它是这一层的兄弟，所以焦点陷阱还能把焦点送进去
    // （inert 子树里的元素连程序化 focus 都是 no-op——真被套进去，下面这条断言会红）
    const panel = screen.getByTestId("history-panel");
    expect(panel.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "关闭回想" }));

    // 命令轨（TopBar）也在这一层里：这就是原先「Tab 逛出抽屉去点顶栏」的那个缺口。
    // v1.12 补：叶子项（历史）成了「回顾」菜单里的二级项，**菜单非 portal** → 展开的弹层同样落在这一层
    // （改成 portal 它就会逃出 inert，下面两条会红）。放在焦点断言之后——开菜单会抢焦点（Radix 默认聚焦弹层）。
    openRailGroup("回顾");
    expect(screen.getByTestId("rail-review").closest("[inert]")).toBe(stage);
    expect(screen.getByTestId("rail-review-menu").closest("[inert]")).toBe(stage);
    expect(screen.getByTestId("history").closest("[inert]")).toBe(stage);
    fireEvent.keyDown(screen.getByTestId("rail-review-menu"), { key: "Escape" }); // 收掉，不带进下面的断言

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
        portraits: [{ ...figure("薇拉"), url: "/img?p=x%2F%5Fvera-smile.jpg&n=薇拉", variant: "微笑" }, figure("沈屿")],
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
      {
        name: "沈屿",
        role: "谜之少年",
        traits: "",
        catchphrase: "",
        favor: null,
        artFile: "",
        expression: "",
        secret: "无",
        recentInteraction: "",
      },
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
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
