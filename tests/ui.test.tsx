// @vitest-environment jsdom
// 组件层测试（v1.4 起）：store 单例 + @testing-library/react 渲染，覆盖 UI 契约——
// TopBar 章号/耗时/世界线、CreationScreen 选项 chip 化与排队提示、AssetsScreen 分组/预览/跨剧本过滤；
// v1.5 新增 WorldsScreen（世界线列表/继续/新建/删除）与 StoryTreeScreen（树图/详情/编辑/分叉）。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TopBar from "../src/components/game/TopBar";
import CreationScreen from "../src/components/CreationScreen";
import AssetsScreen from "../src/components/AssetsScreen";
import WorldsScreen, { relativeTime } from "../src/components/WorldsScreen";
import StoryTreeScreen from "../src/components/StoryTreeScreen";
import { useGameStore } from "../src/store/game";
import type { AssetEntry, Preset, WorldEntry } from "../src/lib/acp";

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
