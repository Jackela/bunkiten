// @vitest-environment jsdom
// 世界线屏（拆自 tests/ui.test.tsx）：列表与动作（继续/新建/删除）、家谱视图（SVG 森林/孤儿/方向键走位）、
// 家谱画布的缩放与渲染宽度上界。单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorldsScreen from "../../src/components/WorldsScreen";
import { useGameStore } from "../../src/store/game";
import { relativeTime } from "../../src/lib/worlds";
import { layoutGenealogy } from "../../src/lib/genealogy";
import { type WorldEntry } from "../../src/lib/acp";
import { PRESET, jsonResponse, openRowMenu, box, setupUi } from "./helpers";

setupUi();

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
    expect(screen.getByTestId("worlds-error").textContent).toContain(
      "世界线加载失败：Error: GET /api/worlds -> HTTP 500",
    );
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
      world({
        worldId: "w2",
        label: "二周目",
        forkedFrom: { worldId: "w1", nodeId: "2-2" },
        lastPlayed: NOW - 3_600_000,
      }),
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
      world({
        worldId: "w2",
        label: "二周目",
        forkedFrom: { worldId: "w1", nodeId: "2-2" },
        lastPlayed: NOW - 3_600_000,
      }),
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
    expect(
      hint.compareDocumentPosition(screen.getByTestId("genealogy-canvas-cap")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("↑ ↓ 选择 · Enter 继续")).toBeNull(); // 家谱视图没有页脚那一行

    // 对照：列表视图的页脚是另一处，且那里的提示与本提示各行其是
    fireEvent.click(screen.getByTestId("worlds-view-list"));
    await waitFor(() => expect(screen.getByText("↑ ↓ 选择 · Enter 继续")).toBeTruthy());
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
