// @vitest-environment jsdom
// 标题屏与启动链（拆自 tests/ui.test.tsx）：TitleScreen 的剧本导出/导入、「继续上次」、角落簇吞键守卫、
// 剧本体检入口；BootScreen 一键登录；启动链读接口超时落地到两屏错误态。基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BootScreen from "../../src/components/BootScreen";
import TitleScreen from "../../src/components/TitleScreen";
import { useGameStore } from "../../src/store/game";
import { BOOT_FETCH_TIMEOUT_MS, fetchPresets, type Preset, type WorldEntry } from "../../src/lib/acp";
import { PRESET, jsonResponse, openTitleMore, setupUi } from "./helpers";

setupUi();

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

    openTitleMore(); // v1.12：导出入口收在角落簇的「更多 ▾」里
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
    // （导出项在「更多」菜单里；菜单在切卡期间是开着的——导入那次 openTitleMore 之后没关过）
    await act(async () => {});
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    openTitleMore();
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
    await waitFor(() =>
      expect(screen.getByTestId("title-notice").textContent).toContain("导入失败：非法的素材文件名: ../x.jpg"),
    );
    expect(screen.getByTestId("title-notice").getAttribute("data-kind")).toBe("error");
    expect(presetGets).toBe(1); // 失败不重取轮播
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

describe("TitleScreen：角落簇的键盘守卫（v1.12 吞键规则）", () => {
  const RIFT: Preset = { ...PRESET, id: "rift-mark", title: "裂痕纹章" };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/presets") return jsonResponse({ presets: [PRESET, RIFT], errors: [] });
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: [] });
        return jsonResponse({}, 404);
      }),
    );
    useGameStore.setState({ presets: [], screen: "title", screenReturn: null, engineBusy: false, titleNotice: null });
  });

  it("焦点停在角落簇按钮上时 ← → 照样切卡——按钮只对 Enter 让路", async () => {
    render(<TitleScreen />);
    const centerText = () => screen.getByTestId("title-card-center").textContent ?? "";
    await waitFor(() => expect(centerText()).toContain("盛夏偏差值"));

    // 焦点落在「素材」上（角落簇是 Tab 可达的一排）。按钮若**无条件**吞 keydown，焦点停在这里时
    // ← → 就到不了 window 上的切卡监听——v1.12 修掉的正是这条（触发器那条更宽：Radix 关菜单还会
    // 把焦点送回按钮，于是「用完一次菜单」之后键盘切卡整体失灵）
    const assets = screen.getByRole("button", { name: "素材" });
    assets.focus();
    fireEvent.keyDown(assets, { key: "ArrowRight" });
    await waitFor(() => expect(centerText()).toContain("裂痕纹章"));
    fireEvent.keyDown(assets, { key: "ArrowLeft" });
    await waitFor(() => expect(centerText()).toContain("盛夏偏差值"));
  });

  it("Enter 在角落簇按钮上只做按钮自己的事：不顺手把中心卡插了", async () => {
    vi.useFakeTimers();
    try {
      render(<TitleScreen />);
      await act(async () => {});
      const creation = screen.getByRole("button", { name: "创作新剧本" });
      creation.focus();
      // 浏览器在按钮上按 Enter 会做两件事：把 keydown 冒泡上去（本屏 window 拿它当「插卡」）+
      // 触发按钮自己的 click。jsdom 只发前者，所以 click 手动补一下，两条路一起验。
      fireEvent.keyDown(creation, { key: "Enter" });
      fireEvent.click(creation);
      expect(useGameStore.getState().screen).toBe("creation"); // 按钮自己的动作照常

      // 插卡走 selectPreset（1s 动画后切到世界线屏）。Enter 若没被按钮拦下，window 那一下会同时插卡——
      // 把时间推过 INSERT_MS 就露馅：这才是「只拦 Enter」规则里「拦」的那半边的回归钉。
      act(() => vi.advanceTimersByTime(2000));
      expect(useGameStore.getState().screen).toBe("creation");
    } finally {
      vi.useRealTimers();
    }
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

  it("点标题屏角落簇的「设置」进设置屏（v1.11 收尾）：返回目标是标题屏，运行态不动", async () => {
    render(<TitleScreen />);
    const btn = await screen.findByTestId("title-settings");
    fireEvent.click(btn);
    const s = useGameStore.getState();
    expect(s.screen).toBe("settings"); // overlay：进设置屏（引擎/登录/音量都在里面）
    expect(s.screenReturn).toBe("title"); // 关掉回到标题屏，不必先开一局
    expect(s.worldId).toBe("campus-summer-9"); // 运行态原样
  });

  it("点「剧本体检」把当前中央卡带进体检屏（只落 selected），运行态原样；没有卡时禁用", async () => {
    render(<TitleScreen />);
    await waitFor(() => expect(screen.getByTestId("title-card-center")).toBeTruthy());
    openTitleMore(); // v1.12：剧本体检收在角落簇的「更多 ▾」里
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
    openTitleMore();
    const off = screen.getByTestId("preset-check") as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.getAttribute("title")).toBe("还没有可体检的剧本");
    fireEvent.click(off);
    expect(useGameStore.getState().screen).toBe("title");
  });
});

// ————————————————— 启动链超时：boot → title 的读接口（v1.10） —————————————————

describe("BootScreen：一键登录（v1.11 收尾）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.setState({
      presets: [],
      screen: "boot",
      screenReturn: null,
      selected: null,
      worldId: null,
      engineBusy: false,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("未登录 → 点「登录 Codex」→ 拉起 CLI 登录 → 轮询到登录态 → 自动进标题屏（不必再点一次）", async () => {
    let loginStarted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/engine/login") {
        loginStarted = true;
        return jsonResponse({ ok: true });
      }
      // 登录流程拉起来之后，玩家在浏览器里完成的那一刻由 /api/auth 反映出来
      return jsonResponse({ loggedIn: loginStarted, hasCredentials: false, engine: "codex", canLogin: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BootScreen />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // 自检落地
    });
    expect(screen.getByTestId("boot-login")).toBeTruthy();
    expect(screen.getByText("codex login")).toBeTruthy(); // 引擎相关的终端指引
    expect(screen.getByTestId("boot-login-start").textContent).toContain("登录 Codex");

    fireEvent.click(screen.getByTestId("boot-login-start"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50); // POST 落地
    });
    expect(screen.getByTestId("boot-login-waiting")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // 第一次轮询：看到登录态
    });
    expect(useGameStore.getState().screen).toBe("title");
  });

  it("登录入口不可用（canLogin=false）时不画登录按钮，改说一句人话", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ loggedIn: false, hasCredentials: false, engine: "grok", canLogin: false })),
    );
    render(<BootScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("boot-login")).toBeTruthy();
    expect(screen.queryByTestId("boot-login-start")).toBeNull();
    expect(screen.getByText(/没找到 Grok 的登录入口/)).toBeTruthy();
  });
});

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
    useGameStore.setState({
      presets: [],
      screen: "boot",
      screenReturn: null,
      selected: null,
      worldId: null,
      engineBusy: false,
    });
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
