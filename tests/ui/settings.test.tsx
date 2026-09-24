// @vitest-environment jsdom
// 设置相关（拆自 tests/ui.test.tsx）：SettingsScreen（滑杆/静音/披露区/存档读取）、fetchProviders 形状归一、
// EngineKeysSection 的在线服务目录候选、登录状态行与引擎选择。基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../src/components/game/TopBar";
import SettingsScreen from "../../src/components/SettingsScreen";
import EngineKeysSection from "../../src/components/EngineKeysSection";
import { useGameStore } from "../../src/store/game";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings } from "../../src/lib/settings";
import { fetchProviders } from "../../src/lib/acp";
import { jsonResponse, expandChannels, setupUi } from "./helpers";

setupUi();

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
    // 细分音量（v1.12）：三条通道滑杆默认不渲染——顶层只留主音量 + 静音这两个玩家最常动的
    const channels = screen.getByTestId("settings-channels-toggle");
    expect(channels.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("settings-bgm")).toBeNull();
    expect(screen.queryByTestId("settings-ambient")).toBeNull();
    expect(screen.queryByTestId("settings-sfx")).toBeNull();
    expandChannels();
    expect(screen.getByTestId("settings-channels-toggle").getAttribute("aria-expanded")).toBe("true");
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
    for (const s of ["slow", "standard", "fast", "instant"])
      expect(screen.getByTestId(`settings-textspeed-${s}`)).toBeTruthy();
    for (const ms of [0, 3000, 5000]) expect(screen.getByTestId(`settings-auto-${ms}`)).toBeTruthy();
  });

  it("滑杆改动即时写回 store 与 localStorage（无保存按钮，读数同步）", () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId("settings-master"), { target: { value: "0.3" } });
    expect(useGameStore.getState().settings.master).toBeCloseTo(0.3);
    expect(screen.getByTestId("settings-master-value").textContent).toBe("30");

    // 细分音量里的滑杆同样即时生效（v1.12：先展开披露，滑杆的 testid/行为一个字没改）
    expandChannels();
    fireEvent.change(screen.getByTestId("settings-sfx"), { target: { value: "0.5" } });
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY)!) as Record<string, unknown>;
    expect(saved).toMatchObject({ master: 0.3, sfx: 0.5, textSpeed: "standard", autoAdvance: 0 });
    // 落盘形状能被 loadSettings 原样读回（逐键校验不改合法值）
    expect(loadSettings()).toEqual(useGameStore.getState().settings);
  });

  it("「引擎与密钥」披露区：从 game/标题屏进来默认收起、从 boot 屏进来默认展开；手动切过之后听玩家的", () => {
    // 前置：从 game 屏进来（beforeEach 的 screenReturn="game"）——技术配置默认收起，玩家偏好先上屏
    render(<SettingsScreen />);
    const toggle = () => screen.getByTestId("settings-advanced-toggle");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe("settings-advanced-toggle-panel");
    expect(screen.queryByTestId("engine-keys")).toBeNull();
    // 披露头自己说清「这是什么、不配也能玩」（读屏把标题与副行一起念出来）
    expect(toggle().textContent).toContain("引擎与密钥");
    expect(toggle().textContent).toContain("不配置也能玩");

    // 手动展开 → 整节上屏；引擎与密钥在披露区里仍是一块独立面板（testid 原样）
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("engine-keys")).toBeTruthy();

    // 再收起 → 整节卸载（不是只藏起来：收起态不该留给 Tab 一串够不着的控件）
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("engine-keys")).toBeNull();

    // 从启动屏未登录态进来（boot 屏的「填自备密钥 / 打开设置」）：这一趟正是冲着它来的 → 默认展开
    cleanup();
    useGameStore.setState({ screen: "settings", screenReturn: "boot" });
    render(<SettingsScreen />);
    expect(screen.getByTestId("settings-advanced-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("engine-keys")).toBeTruthy();

    // 玩家手动收起后听玩家的（默认值只管「还没手动切过」的那一版）
    fireEvent.click(screen.getByTestId("settings-advanced-toggle"));
    expect(screen.getByTestId("settings-advanced-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("engine-keys")).toBeNull();
  });

  it("细分音量披露：展开后三条滑杆出现且能改值（读数与落盘同步）", () => {
    render(<SettingsScreen />);
    const toggle = screen.getByTestId("settings-channels-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("settings-channels-panel");
    expect(screen.queryByTestId("settings-channels-panel")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId("settings-channels-panel")).toBeTruthy();
    for (const [id, value, shown] of [
      ["settings-bgm", "0.2", "20"],
      ["settings-ambient", "0.4", "40"],
      ["settings-sfx", "0.6", "60"],
    ] as const) {
      fireEvent.change(screen.getByTestId(id), { target: { value } });
      expect(screen.getByTestId(`${id}-value`).textContent).toBe(shown);
    }
    expect(useGameStore.getState().settings).toMatchObject({ bgm: 0.2, ambient: 0.4, sfx: 0.6 });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject({
      bgm: 0.2,
      ambient: 0.4,
      sfx: 0.6,
    });

    // 主音量与静音**不在**披露里（顶层常驻）：收起细分音量后它们照旧在
    fireEvent.click(toggle);
    expect(screen.queryByTestId("settings-bgm")).toBeNull();
    expect(screen.getByTestId("settings-master")).toBeTruthy();
    expect(screen.getByTestId("settings-muted")).toBeTruthy();
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

describe("fetchProviders：GET /api/providers 的形状归一（v1.10）", () => {
  /** 把 global fetch 换成「固定回包」的桩（全局 afterEach 会 unstubAllGlobals 收尾） */
  const stubFetch = (body: unknown, status = 200) => {
    const mock = vi.fn(async () => jsonResponse(body, status));
    vi.stubGlobal("fetch", mock);
    return mock;
  };

  it("source 不是 remote/cache（服务端拼错或加了新来源）→ 一律归一到 bundled（不把意外值透到屏上）", async () => {
    stubFetch({ providers: [], source: "mirror", fetchedAt: "2026-01-02T03:04:05.000Z" });
    expect((await fetchProviders()).source).toBe("bundled");
  });

  it("fetchedAt 不是字符串 → null（屏上/下游只认字符串时刻或没有）", async () => {
    stubFetch({ providers: [], source: "remote", fetchedAt: 12345 });
    expect((await fetchProviders()).fetchedAt).toBe(null);
    stubFetch({ providers: [], source: "remote" });
    expect((await fetchProviders()).fetchedAt).toBe(null);
  });

  it("providers 不是数组 → 空数组（坏数据不透给下拉；空目录由调用方按组回落内置表）", async () => {
    stubFetch({ providers: { nope: true }, source: "remote", fetchedAt: null });
    expect((await fetchProviders()).providers).toEqual([]);
    stubFetch({ source: "remote" });
    expect((await fetchProviders()).providers).toEqual([]);
  });

  it("非 2xx 抛错（调用方静默回落内置表）；remote/cache 原样透出", async () => {
    stubFetch({ providers: [], source: "cache", fetchedAt: null });
    expect((await fetchProviders()).source).toBe("cache");
    stubFetch({ error: "boom" }, 500);
    await expect(fetchProviders()).rejects.toThrow("HTTP 500");
  });
});

describe("EngineKeysSection：服务目录候选（v1.10）", () => {
  /**
   * GET /api/credentials 的脱敏视图（两组都回默认：对话沿用终端登录、出图不用）。
   * POST 时把补丁并进这一份再回包——与真 server「局部更新后回整份视图」同形。
   */
  type View = {
    version: number;
    engine: string;
    llm: Record<string, string | boolean>;
    image: Record<string, string | boolean>;
  };
  function defaultView(): View {
    return {
      version: 1,
      engine: "grok",
      llm: { mode: "session", provider: "openai", baseUrl: "", model: "", hasKey: false, apiKeyMasked: "" },
      image: {
        mode: "off",
        provider: "openai",
        baseUrl: "",
        model: "",
        size: "",
        sizeBackground: "",
        hasKey: false,
        apiKeyMasked: "",
      },
    };
  }
  /** 服务端视图的本地态（POST 后更新） */
  let creds: View;
  /** GET /api/providers 的回包（null = 这条读不到：非 2xx） */
  let providersResp: unknown;
  /** /api/auth 的登录态（v1.11 收尾：单元里可改「未登录 / 已登录 / 登录入口不可用」三态） */
  let authState: { loggedIn: boolean; canLogin: boolean };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    creds = defaultView();
    providersResp = null;
    authState = { loggedIn: false, canLogin: true };
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/auth") {
        return jsonResponse({
          loggedIn: authState.loggedIn,
          hasCredentials: false,
          engine: creds.engine,
          canLogin: authState.canLogin,
        });
      }
      if (url.pathname === "/api/engine/login") return jsonResponse({ ok: true });
      if (url.pathname === "/api/engine/logout") {
        authState = { ...authState, loggedIn: false };
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/credentials") {
        if (init?.method === "POST") {
          const patch = JSON.parse(String(init.body)) as {
            engine?: string;
            llm?: Record<string, string>;
            image?: Record<string, string>;
          };
          // key 不出现在视图里：只把它折成 hasKey（与 server 的 publicView 同一口径）
          const merge = (prev: Record<string, string | boolean>, next?: Record<string, string>) => {
            const { apiKey, ...rest } = next ?? {};
            return { ...prev, ...rest, ...(apiKey === undefined ? {} : { hasKey: apiKey !== "" }) };
          };
          creds = {
            ...creds,
            engine: patch.engine ?? creds.engine,
            llm: merge(creds.llm, patch.llm),
            image: merge(creds.image, patch.image),
          };
        }
        return jsonResponse({ ok: true, ...creds });
      }
      if (url.pathname === "/api/providers") {
        return providersResp ? jsonResponse(providersResp) : jsonResponse({ error: "boom" }, 500);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  /** 展开一组表单（默认 mode 不是 byok 时下拉不渲染），返回该组的服务下拉 */
  async function openGroup(group: "llm" | "image"): Promise<HTMLSelectElement> {
    await waitFor(() => expect(screen.getByTestId(`engine-${group}-mode-byok`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`engine-${group}-mode-byok`));
    return screen.getByTestId(`engine-${group}-provider`) as HTMLSelectElement;
  }

  /** 下拉里的选项文案（顺序即渲染顺序） */
  const optionLabels = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);

  it("读到在线目录：两组下拉用远端候选（含改名的旧条目与新增条目）、地址按远端预填，并出现「在线目录」标注", async () => {
    providersResp = {
      version: 1,
      updatedAt: "2026-01-02T03:04:05.000Z",
      providers: [
        // 已有 id 改名 + 换地址：屏上必须显示远端这一份，而不是内置表那份
        {
          id: "deepseek",
          label: "深海探路者",
          kind: "llm",
          baseUrl: "https://api.deepseek.com/online",
          models: ["deepseek-chat"],
        },
        { id: "newcomer-llm", label: "新来的服务", kind: "llm", baseUrl: "https://newcomer.example/v1", models: [] },
        {
          id: "newcomer-image",
          label: "新来的出图服务",
          kind: "image",
          baseUrl: "https://newcomer.example/img",
          models: [],
          imageModels: ["new-image-1"],
        },
      ],
      source: "remote",
      fetchedAt: "2026-01-02T03:04:05.000Z",
    };
    render(<EngineKeysSection />);

    // 标注：来源不是内置表时才出现（玩家话，不带 env / 内部标识）
    await waitFor(() => expect(screen.getByTestId("engine-catalog-online")).toBeTruthy());

    const llm = await openGroup("llm");
    expect(optionLabels(llm)).toContain("深海探路者"); // 远端给的名字
    expect(optionLabels(llm)).not.toContain("DeepSeek"); // 内置表那份没顶替进来
    expect(optionLabels(llm)).toContain("新来的服务"); // 远端新增的条目也能挑

    // 选中远端条目：地址按远端目录预填（不是内置表的 https://api.deepseek.com）
    fireEvent.change(llm, { target: { value: "deepseek" } });
    expect((screen.getByTestId("engine-llm-baseurl") as HTMLInputElement).value).toBe(
      "https://api.deepseek.com/online",
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/credentials", expect.objectContaining({ method: "POST" })),
    );

    // 出图组同样吃远端候选
    const image = await openGroup("image");
    expect(optionLabels(image)).toContain("新来的出图服务");
  });

  it("读不到在线目录（非 2xx）：下拉回落内置表，且不出现「在线目录」标注", async () => {
    render(<EngineKeysSection />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/providers", expect.objectContaining({ signal: expect.anything() })),
    );
    await act(async () => {
      await Promise.resolve(); // 让失败那一跳落地：失败是静默的（不占错误态、不打日志）
    });

    const llm = await openGroup("llm");
    expect(optionLabels(llm)).toContain("DeepSeek"); // 内置真源里的名字
    expect(screen.queryByTestId("engine-catalog-online")).toBeNull();
    expect(screen.queryByTestId("engine-keys-retry")).toBeNull(); // 目录读不到不是「配置读不到」
  });

  it("在线目录是空的（HTTP 200 但一条候选都没有）：这一份不算目录，同样回落内置表", async () => {
    providersResp = { version: 1, providers: [], source: "remote", fetchedAt: "2026-01-02T03:04:05.000Z" };
    render(<EngineKeysSection />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/providers", expect.objectContaining({ signal: expect.anything() })),
    );
    await act(async () => {
      await Promise.resolve();
    });

    const llm = await openGroup("llm");
    expect(optionLabels(llm)).toContain("DeepSeek"); // 空目录不画空下拉
    expect(screen.queryByTestId("engine-catalog-online")).toBeNull(); // 也没换来一句「已是最新」
  });

  it("已存的服务不在在线目录里（缓存那版撤了这条）：仍留在下拉里，当前选择不会变成空白", async () => {
    // source=cache 也算「非内置」，标注同样要出现
    providersResp = {
      version: 1,
      providers: [
        { id: "newcomer-llm", label: "新来的服务", kind: "llm", baseUrl: "https://newcomer.example/v1", models: [] },
      ],
      source: "cache",
      fetchedAt: "2026-01-02T03:04:05.000Z",
    };
    render(<EngineKeysSection />);
    await waitFor(() => expect(screen.getByTestId("engine-catalog-online")).toBeTruthy());

    const llm = await openGroup("llm");
    expect(llm.value).toBe("openai"); // 已存的那家还在候选里（下拉不是空的）
    expect([...llm.options].map((o) => o.value)).toEqual(["openai", "newcomer-llm"]);
    // 补进候选只为了「看得见」，玩家已存的地址/模型照旧回显（这里都是空的，故不预填远端地址）
    expect((screen.getByTestId("engine-llm-baseurl") as HTMLInputElement).value).toBe("");
  });

  it("在线目录里这一组一条都不匹配（示例：远端只加了出图服务）→ 该组按组回落内置表，不画空下拉", async () => {
    providersResp = {
      version: 1,
      providers: [
        {
          id: "newcomer-image",
          label: "新来的出图服务",
          kind: "image",
          baseUrl: "https://newcomer.example/img",
          models: [],
          imageModels: ["new-image-1"],
        },
      ],
      source: "remote",
      fetchedAt: "2026-01-02T03:04:05.000Z",
    };
    render(<EngineKeysSection />);
    await waitFor(() => expect(screen.getByTestId("engine-catalog-online")).toBeTruthy());

    // 对话组：远端唯一的条目 kind=image，对对话侧不可用 → 这一组回落内置表（宁可留着旧候选，也不给空下拉）
    const llm = await openGroup("llm");
    expect(optionLabels(llm)).toContain("DeepSeek"); // 内置真源里的名字
    expect(optionLabels(llm)).not.toContain("新来的出图服务");

    // 出图组：远端这条可用 → 用它画候选
    const image = await openGroup("image");
    expect(optionLabels(image)).toContain("新来的出图服务");
  });

  it("登录状态行（v1.11 收尾）：未登录给「登录 <引擎>」，点了就拉起 CLI 登录流程", async () => {
    render(<EngineKeysSection />);
    await waitFor(() => expect(screen.getByTestId("engine-auth-status").textContent).toBe("未登录"));
    expect(screen.queryByTestId("engine-auth-logout")).toBeNull();
    fireEvent.click(screen.getByTestId("engine-auth-login"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/engine/login")).toBe(true),
    );
    // 拉起后给等待提示（玩家在浏览器里完成；完成后状态行自动刷新——轮询本身在 engine-login 的单测里钉）
    await waitFor(() => expect(screen.getByTestId("engine-auth-note").textContent).toContain("已打开浏览器"));
  });

  it("登录状态行：已登录给「退出登录」，两段确认（登出是全局动作：终端里那份也一起清）", async () => {
    authState = { loggedIn: true, canLogin: true };
    render(<EngineKeysSection />);
    await waitFor(() => expect(screen.getByTestId("engine-auth-status").textContent).toBe("已登录"));

    // 首点只是展开确认条（世界线删除同款的两段式），并明说会连带终端登录
    fireEvent.click(screen.getByTestId("engine-auth-logout"));
    expect(screen.getByText(/会同时退出你在终端里的登录/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/engine/logout")).toBe(false);
    // 取消 → 确认条收起，什么都没发生
    fireEvent.click(screen.getByTestId("engine-auth-logout-cancel"));
    expect(screen.queryByTestId("engine-auth-logout-confirm")).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/engine/logout")).toBe(false);

    // 二点确认 → 真发登出，状态行翻回未登录
    fireEvent.click(screen.getByTestId("engine-auth-logout"));
    fireEvent.click(screen.getByTestId("engine-auth-logout-confirm"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/engine/logout")).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("engine-auth-status").textContent).toBe("未登录"));
    expect(screen.getByTestId("engine-auth-note").textContent).toContain("已退出登录");
  });

  it("登录状态行：这台机器没有登录入口（canLogin=false）时不画按钮，改说一句人话", async () => {
    authState = { loggedIn: false, canLogin: false };
    render(<EngineKeysSection />);
    await waitFor(() => expect(screen.getByTestId("engine-auth-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("engine-auth-login")).toBeNull();
    expect(screen.getByTestId("engine-auth-unavailable").textContent).toContain("grok login");
    expect(screen.getByTestId("engine-auth-unavailable").textContent).toContain("先装好 grok"); // unavailableNote 来自真源
  });

  it("引擎选择（v1.11）：默认 grok；切到 Codex 立即保存、说明换掉、对话组的「自备密钥」被锁、出图组不受影响", async () => {
    render(<EngineKeysSection />);
    const grokBtn = await waitFor(() => screen.getByTestId("engine-backend-grok") as HTMLButtonElement);
    expect(grokBtn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("engine-backend-codex").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("engine-backend-note").textContent).toContain("Grok");

    // 切引擎：与下拉/开关同款「立即保存」——POST 只带 engine 一个键
    fireEvent.click(screen.getByTestId("engine-backend-codex"));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ engine: "codex" });
    });

    // 视图切过去：按钮态、说明换成 Codex 的、提示重启生效（会话 env 只在 spawn 时读一次）
    await waitFor(() => expect(screen.getByTestId("engine-backend-codex").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByTestId("engine-backend-note").textContent).toContain("Codex");
    expect(screen.getByTestId("engine-restart-note").textContent).toContain("重启");

    // 对话组：Codex 不支持自备密钥 → 按钮禁用 + 一句原因；同组的自备表单不再画（已存的值留在盘上，不删）
    expect((screen.getByTestId("engine-llm-mode-byok") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("engine-llm-byok-locked").textContent).toBeTruthy();
    expect(screen.queryByTestId("engine-llm-baseurl")).toBeNull();
    expect((screen.getByTestId("engine-llm-mode-session") as HTMLButtonElement).getAttribute("aria-pressed")).toBe(
      "true",
    );

    // 出图组两引擎通用：自备照常可开、表单照常画
    fireEvent.click(screen.getByTestId("engine-image-mode-byok"));
    expect(screen.getByTestId("engine-image-baseurl")).toBeTruthy();

    // 切回 grok：对话组恢复可点
    fireEvent.click(screen.getByTestId("engine-backend-grok"));
    await waitFor(() => expect((screen.getByTestId("engine-llm-mode-byok") as HTMLButtonElement).disabled).toBe(false));
  });
});
