// @vitest-environment jsdom
// 组件层测试（v1.4 起）：store 单例 + @testing-library/react 渲染，覆盖 UI 契约——
// TopBar 章号/耗时/世界线、CreationScreen 选项 chip 化与排队提示、AssetsScreen 分组/预览/跨剧本过滤；
// v1.5 新增 WorldsScreen（世界线列表/继续/新建/删除）与 StoryTreeScreen（树图/详情/编辑/分叉）；
// v1.6 新增 SettingsScreen（设置项/持久化/齿轮入口）与 AudioManager（索引/交叉淡入/静默降级）、
//      世界线屏改名/导出/导入（含 listbox 语义）与画廊选择模式/批量重绘队列/批量删除/预览模态；
// v1.6 第二段：剧情图快照标注/原地回退/分叉带 seq、>40 节点列表降级与缩放平移、节点 roving tabIndex、
//      游戏键盘（数字键选选项 / 空格补全 / 自动前进倒计时标记）与 App 的状态播报区（aria-live）。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TopBar from "../src/components/game/TopBar";
import DialogueBox from "../src/components/game/DialogueBox";
import OptionList from "../src/components/game/OptionList";
import CreationScreen from "../src/components/CreationScreen";
import AssetsScreen from "../src/components/AssetsScreen";
import WorldsScreen, { relativeTime, worldDisplayName } from "../src/components/WorldsScreen";
import StoryTreeScreen, { earliestSnapshotByNode, snapshotTurnNo } from "../src/components/StoryTreeScreen";
import SettingsScreen from "../src/components/SettingsScreen";
import App, { StatusAnnouncer } from "../src/App";
import { useGameStore } from "../src/store/game";
import { FADE_MS, MAX_SFX, SFX_TIMEOUT_MS, audioManager } from "../src/lib/audio";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings } from "../src/lib/settings";
import { TREE_ZOOM_MAX, clampZoom, fitView, panView, viewBoxOf, zoomViewAt } from "../src/lib/treeLayout";
import type { AssetEntry, AudioItem, Preset, WorldEntry, WorldSnapshotMeta } from "../src/lib/acp";

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useGameStore.getState().toTitle();
});

describe("TopBar：章节指示与回合耗时", () => {
  beforeEach(() => {
    useGameStore.setState({ chapterNo: 3, status: "引擎演绎中…", turnStartAt: Date.now(), worldLabel: "" });
  });

  it("显示章号与状态；busy 时拼已耗时秒数", () => {
    render(<TopBar />);
    expect(screen.getByTestId("status").textContent).toMatch(/^引擎演绎中… \d+s$/);
    expect(screen.getByText("第 3 章")).toBeTruthy();
  });

  it("就绪时不拼耗时（turnStartAt=null）", () => {
    useGameStore.setState({ status: "就绪", turnStartAt: null });
    render(<TopBar />);
    expect(screen.getByTestId("status").textContent).toBe("就绪");
  });

  it("有当前世界线时章号后显示世界名；无世界（main 之外的空 label）不渲染", () => {
    useGameStore.setState({ status: "就绪", turnStartAt: null, worldLabel: "分叉自 campus-summer-1 @ 2-2" });
    render(<TopBar />);
    expect(screen.getByTestId("world-label").textContent).toBe("分叉自 campus-summer-1 @ 2-2");

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

  it("渲染世界行：备注名/章号/相对时间/分叉徽标；同屏按最近游玩排序", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-2")).toBeTruthy());
    const forkRow = within(screen.getByTestId("world-row-campus-summer-2"));
    expect(forkRow.getByText(/第 2 章 · 5 分钟前/)).toBeTruthy();
    // 备注名与分叉徽标都含同一句分叉说明（行内两处）
    expect(forkRow.getAllByText(/分叉自 campus-summer-1 @ 2-2/).length).toBe(2);
    const plainRow = within(screen.getByTestId("world-row-campus-summer-1"));
    expect(plainRow.getByText("campus-summer-1")).toBeTruthy(); // 无备注回退 id
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
  });

  it("新世界线：POST create 成功后带新 id 进捏人屏；失败留在本屏并报错", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-new")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worlds-new"));

    await waitFor(() => expect(useGameStore.getState().screen).toBe("protagonist"));
    expect(worldPosts).toEqual([{ action: "create", preset: "campus-summer" }]);
    expect(useGameStore.getState().worldId).toBe("campus-summer-3");
  });

  it("删除：两段式确认，第二段才发 delete 并重取清单", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-delete-campus-summer-2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("world-delete-campus-summer-2"));
    expect(worldPosts).toEqual([]); // 首点只进确认态

    fireEvent.click(screen.getByTestId("world-confirm-campus-summer-2"));
    await waitFor(() => expect(worldPosts).toEqual([{ action: "delete", worldId: "campus-summer-2" }]));
  });

  it("空态：没有世界线时提示并可开新线", async () => {
    worldsResp = [];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-empty")).toBeTruthy());
    expect(screen.getByText(/还没有世界线/)).toBeTruthy();
    expect(screen.getByTestId("worlds-new")).toBeTruthy();
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

  it("chip 点击只填输入框不发送；排队消息显示提示行", async () => {
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
    await waitFor(() => expect(screen.getByText("引擎就绪后自动发送")).toBeTruthy());
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
    expect(within(screen.getByTestId("tree-input")).getByText("引擎忙，已排队，就绪后自动发送")).toBeTruthy();
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

describe("AssetsScreen：分组、在用徽标与预览", () => {
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

  it("立绘按角色分组（差分显示为 名 · 变体），背景/封面各自成组，在用徽标只标当前项", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByText("立 绘")).toBeTruthy());
    expect(screen.getByText("薇拉 · 微笑")).toBeTruthy();
    expect(screen.getByText("背 景")).toBeTruthy();
    expect(screen.getByText("封 面")).toBeTruthy();
    expect(screen.getByText("在用")).toBeTruthy(); // 仅 基础薇拉 inUse
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
    expect((screen.getByTestId("settings-master") as HTMLInputElement).value).toBe("1");
    expect(screen.getByTestId("settings-master-value").textContent).toBe("100");
    expect((screen.getByTestId("settings-bgm") as HTMLInputElement).value).toBe("0.8");
    expect(screen.getByTestId("settings-bgm-value").textContent).toBe("80");
    expect(screen.getByTestId("settings-ambient-value").textContent).toBe("60");
    expect(screen.getByTestId("settings-sfx-value").textContent).toBe("90");
    expect(screen.getByTestId("settings-muted").getAttribute("aria-pressed")).toBe("false");
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
    expect(screen.getByTestId("settings-muted").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("settings-muted"));
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

  it("Esc 关设置 overlay 回进入前的屏（滑杆聚焦时同样生效——它不是「正在打字」的输入框）", () => {
    render(<App />);
    const slider = screen.getByTestId("settings-master") as HTMLInputElement;
    slider.focus();
    expect(document.activeElement).toBe(slider);

    fireEvent.keyDown(document, { key: "Escape" });

    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.screenReturn).toBeNull();
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

  it("显示名用 label；label 与 note 都在时备注降为次行；无 label 回退备注/id", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-2")).toBeTruthy());

    const labeled = within(screen.getByTestId("world-row-campus-summer-2"));
    expect(labeled.getByText("雨夜的岔口")).toBeTruthy();
    expect(labeled.getByTestId("world-note-campus-summer-2").textContent).toBe("分叉自 campus-summer-1 @ 2-2");
    const plain = within(screen.getByTestId("world-row-campus-summer-1"));
    expect(plain.getByText("campus-summer-1")).toBeTruthy();
    expect(plain.queryByTestId("world-note-campus-summer-1")).toBeNull(); // 没有 label 就不铺备注次行

    // 纯函数：label 空白串视为未设置；回退链 label → note → worldId
    expect(worldDisplayName(world({ worldId: "w", label: "  ", note: " 旧备注 " }))).toBe("旧备注");
    expect(worldDisplayName(world({ worldId: "w" }))).toBe("w");
  });

  it("行内改名：编辑打开即聚焦显示名输入框；保存把 label/note 提交给 update 并重取清单回显", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-edit-campus-summer-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));

    const label = screen.getByTestId("world-edit-label-campus-summer-1") as HTMLInputElement;
    expect(screen.getByTestId("world-editor-campus-summer-1")).toBeTruthy();
    expect(label.value).toBe(""); // 初值取服务端现值（未设置=空串）
    expect(document.activeElement).toBe(label);
    expect(label.getAttribute("maxlength")).toBe("60");
    expect(screen.getByTestId("world-edit-note-campus-summer-1").getAttribute("maxlength")).toBe("200");
    expect(screen.getByLabelText("显示名（campus-summer-1）")).toBe(label); // 输入框有 aria-label

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
    await waitFor(() => expect(screen.getByTestId("world-edit-campus-summer-2")).toBeTruthy());
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
    // 显示名清掉后备注顶上主行，次行随之收起；分叉徽标仍在（两处都含那句说明，故按次行断言）
    await waitFor(() => expect(within(screen.getByTestId("world-row-campus-summer-2")).queryByTestId("world-note-campus-summer-2")).toBeNull());
    expect(within(screen.getByTestId("world-row-campus-summer-2")).getAllByText(/分叉自 campus-summer-1 @ 2-2/).length).toBe(2);

    // Esc 取消：不发请求、编辑器收起
    const before = worldPosts.length;
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    fireEvent.keyDown(screen.getByTestId("world-edit-note-campus-summer-1"), { key: "Escape" });
    expect(screen.queryByTestId("world-editor-campus-summer-1")).toBeNull();
    expect(worldPosts).toHaveLength(before);

    // 中文输入法组字中的 Enter 不算保存
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    fireEvent.keyDown(screen.getByTestId("world-edit-label-campus-summer-1"), { key: "Enter", isComposing: true });
    expect(screen.getByTestId("world-editor-campus-summer-1")).toBeTruthy();
    expect(worldPosts).toHaveLength(before);
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
    await waitFor(() => expect(screen.getByTestId("world-edit-campus-summer-2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-2"));
    fireEvent.change(screen.getByTestId("world-edit-label-campus-summer-2"), { target: { value: "太长的名字" } });
    fireEvent.click(screen.getByTestId("world-edit-save-campus-summer-2"));

    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("保存失败：label 太长"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("error");
    expect(screen.getByTestId("world-editor-campus-summer-2")).toBeTruthy();
    expect((screen.getByTestId("world-edit-label-campus-summer-2") as HTMLInputElement).value).toBe("太长的名字");
  });

  it("导出：每行一个下载链接，指向 /api/worlds/export 并带 <worldId>.world.json 文件名", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-export-campus-summer-1")).toBeTruthy());

    const link = screen.getByTestId("world-export-campus-summer-1") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/worlds/export?worldId=campus-summer-1");
    expect(link.getAttribute("download")).toBe("campus-summer-1.world.json");
    // aria-label 用显示名（label 优先），行内按钮不至于同名叫「导出」
    expect(link.getAttribute("aria-label")).toBe("导出世界线 campus-summer-1");
    expect(screen.getByTestId("world-export-campus-summer-2").getAttribute("aria-label")).toBe("导出世界线 雨夜的岔口");
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
    expect(screen.getByLabelText("编辑世界线 campus-summer-1")).toBeTruthy();
    expect(screen.getByLabelText("删除世界线 campus-summer-1")).toBeTruthy();
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
        assetsResp = assetsResp.filter((a) => a.file !== body.file); // 删除后清单确实少一条
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
    expect(screen.getByText(/封面不参与删除/)).toBeTruthy();

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
    await waitFor(() => expect(assetPosts).toHaveLength(2));
    expect(assetPosts.map((p) => p.file)).toEqual([FILE_BG, FILE_PORTRAIT]); // 顺序=勾选顺序
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
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());
    fireEvent.click(screen.getByTestId("asset-card-薇拉-微笑"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("素材预览：薇拉 · 微笑");
    const close = screen.getByTestId("assets-preview-close");
    expect(close.getAttribute("aria-label")).toBe("关闭预览");
    await waitFor(() => expect(document.activeElement).toBe(close));

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉-微笑"]);
    expect(screen.getByTestId("assets-regen-progress").textContent).toContain("重绘中 1/1");

    await engineTurn("【图】立绘|薇拉-微笑|presets/campus-summer/assets/立绘-薇拉-微笑.jpg|重绘\n");
    await waitFor(() => expect(screen.getByTestId("assets-regen-notice").textContent).toContain("重绘完成：1 项已换图"));

    // 关闭走 store（App 的 Esc 链与点遮罩同一条路）；退场动画期间节点还在，只断言状态
    fireEvent.click(close);
    expect(useGameStore.getState().assetsPreview).toBeNull();
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

    expect(screen.getByLabelText("节点 2-2 · 已走过 · 快照 #7 · 第 2 轮")).toBeTruthy();
    expect(screen.getByLabelText("节点 2-1 · 已走过 · 快照 #3 · 第 1 轮")).toBeTruthy();
    expect(screen.getByLabelText("节点 2-4 · 已走过")).toBeTruthy(); // 没有快照：标签保持旧口径

    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    expect(screen.getByTestId("tree-snapshot-2-2").textContent).toBe("快照 #7 · 第 2 轮");
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
    await waitFor(() => expect(screen.getByTestId("tree-notice").textContent).toContain("已回退到快照 #3"));
    expect(screen.getByTestId("tree-notice").textContent).toContain("备份为快照 #12");
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

  it("焦点在输入框（或 IME 组字、带修饰键）时数字键让路：不打服务端", () => {
    render(
      <>
        <OptionList />
        <input data-testid="free-input" />
      </>,
    );
    const input = screen.getByTestId("free-input");
    input.focus();
    fireEvent.keyDown(input, { key: "1" }); // 冒泡到 window，但目标是输入框
    expect(prompts).toEqual([]);

    fireEvent.keyDown(window, { key: "1", isComposing: true });
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(prompts).toEqual([]);

    fireEvent.keyDown(window, { key: "1", code: "Numpad1" });
    expect(prompts).toEqual(["溜进座位"]);
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

  it("aria-live=polite 播报 store.status 变化；同一句重复写入不再动 DOM（不重复播报）", async () => {
    render(<StatusAnnouncer />);
    const live = screen.getByTestId("sr-status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(live.textContent).toBe("连接引擎…");

    act(() => useGameStore.setState({ status: "引擎演绎中…" }));
    await waitFor(() => expect(screen.getByTestId("sr-status").textContent).toBe("引擎演绎中…"));

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
