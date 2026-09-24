// @vitest-environment jsdom
// 剧情图屏（拆自 tests/ui.test.tsx）：树图/详情/节点级与全树编辑、大图降级与缩放平移、节点 roving tabIndex、
// 顶部章节切换器与归档药丸，附 treeLayout 视图纯函数。单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StoryTreeScreen from "../../src/components/StoryTreeScreen";
import { useGameStore } from "../../src/store/game";
import { TREE_ZOOM_MAX, clampZoom, fitView, panView, viewBoxOf, zoomViewAt } from "../../src/lib/treeLayout";
import { archiveKey, chapterItems, STATUS_SLUG } from "../../src/lib/tree-view";
import { type TreeChapter, type TreeNode } from "../../src/lib/parser";
import { jsonResponse, box, readViewBox, setupUi } from "./helpers";

setupUi();

/** 手动控制 resolve 的 promise：把取树的应答拿在手里，在 act 之外落地（驱动调度窗口用） */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 只排微任务，不给调度器 macrotask */
async function flushMicrotasks(n = 8) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * 逐拍给一个 macrotask，直到 testid 命中就**立刻**返回——只在画布出现的第一拍停手，不给后续的被动 effect
 * 冲刷机会。这是「驱动窗口」而不是「等它过去」：修复前，画布一提交（被动 refit 还在调度器队列里）就能抓到它。
 */
async function firstFrameWith(testId: string): Promise<HTMLElement> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const el = screen.queryByTestId(testId);
    if (el) return el;
  }
  throw new Error(`等了 20 个 macrotask 也没等到 ${testId} 出现`);
}

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

  it("只改这个节点（v1.12）：节点详情里写的那句话**带节点作用域**发给引擎，换节点就清空", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    // 选中一个节点（侧栏详情出现）——先点图上的节点
    fireEvent.click(screen.getByTestId(/^tree-node-2-3$/));
    const note = await waitFor(() => screen.getByTestId("tree-node-note") as HTMLInputElement);
    expect(note.placeholder).toContain("2-3"); // 输入框自己说明作用对象

    fireEvent.change(note, { target: { value: "把这里写得更紧张" } });
    fireEvent.click(screen.getByTestId("tree-node-send"));
    expect(prompts.at(-1)).toBe("剧情：针对节点 2-3：把这里写得更紧张");
    expect(note.value).toBe(""); // 发完清空

    // 换节点：写了一半的话是针对上一个节点说的，不能跟过去
    fireEvent.change(note, { target: { value: "写了一半" } });
    fireEvent.click(screen.getByTestId(/^tree-node-2-2$/));
    await waitFor(() => expect(screen.getByTestId("tree-node-note").getAttribute("placeholder")).toContain("2-2"));
    expect((screen.getByTestId("tree-node-note") as HTMLInputElement).value).toBe("");
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
    expect(screen.getByTestId("tree-list-group-visited")).toBeTruthy();
    expect(screen.getByTestId("tree-list-group-pruned")).toBeTruthy();
    expect(screen.getByTestId("tree-list-group-reachable")).toBeTruthy();
    expect(screen.queryByTestId("tree-list-group-grafted")).toBeNull(); // 空组不铺标题（slug 键，非中文字面量）

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
    // 每次读 viewBox 都按 testid 重新查当前画布（readViewBox 会断言抓住的节点没被换掉）：
    // 这样「视图被复位」与「抓的是重挂后的旧节点」两种红灯在断言消息里就分得开
    const fit = readViewBox("tree-canvas", canvas);
    expect(box(fit)[0]).toBe(0);
    expect(box(fit)[1]).toBe(0);

    // 画布包体：图例、缩放工具条与画布同处一个 wrap（`+/-/0` 的键盘监听就挂在它上面，画布内未消费的键冒泡到这儿）
    const wrap = screen.getByTestId("tree-canvas-wrap");
    expect(wrap.contains(canvas)).toBe(true);
    expect(wrap.contains(screen.getByTestId("tree-zoom-in"))).toBe(true);
    expect(within(wrap).getByText("已走过")).toBeTruthy(); // 图例与画布同处一个包体

    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    const zoomed = readViewBox("tree-canvas", canvas);
    expect(zoomed).not.toBe(fit);
    expect(box(zoomed)[2]).toBeLessThan(box(fit)[2]); // 放大 = 视野变小
    expect(screen.getByTestId("tree-zoom-level").textContent).toBe("125%");

    fireEvent.click(screen.getByTestId("tree-zoom-out"));
    expect(readViewBox("tree-canvas", canvas)).toBe(fit);
    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    fireEvent.click(screen.getByTestId("tree-zoom-fit"));
    expect(readViewBox("tree-canvas", canvas)).toBe(fit);
    expect(screen.getByTestId("tree-zoom-level").textContent).toBe("100%");

    // 双击画布复位
    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    expect(readViewBox("tree-canvas", canvas)).not.toBe(fit);
    fireEvent.doubleClick(canvas);
    expect(readViewBox("tree-canvas", canvas)).toBe(fit);

    // 键盘 +/-/0：事件冒泡到画布容器
    fireEvent.keyDown(canvas, { key: "+" });
    expect(readViewBox("tree-canvas", canvas)).not.toBe(fit);
    fireEvent.keyDown(canvas, { key: "-" });
    expect(readViewBox("tree-canvas", canvas)).toBe(fit);
    fireEvent.keyDown(canvas, { key: "+" });
    fireEvent.keyDown(canvas, { key: "0" });
    expect(readViewBox("tree-canvas", canvas)).toBe(fit);
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
    // 画布一可见就是稳定态，交互不必先「排干队列」：refit 现在落在**渲染阶段**（lib/useCanvasPanZoom），
    // 提交之后不留排队写入。
    // 这里从前有一行 `await act(async () => {})` —— 那是在躲一个经探针证实过的窗口：树在 fetch 的 promise
    // 里落地（act 之外）后，被动 refit 仍挂在调度器队列里；这一拍派发滚轮，那一发 setView(zoom) 会被随后
    // 的 setView(fitView) 抹回「适应」（viewBox 原地不动，看着像滚轮没生效）。refit 改渲染阶段后窗口消失，
    // 这行等待也一并撤掉。**但它不是那个窗口的哨兵**：把被动 refit 临时放回去，本用例通常仍是绿的
    // （滚轮这条路径的时序偏保守）——哨兵是下面「refit 不留排队写入」那条确定性用例。
    // 本用例只负责滚轮本身的行为：指针锚点缩放 + preventDefault。
    const canvas = screen.getByTestId("tree-canvas");
    const fit = readViewBox("tree-canvas", canvas);

    const ev = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    // 缩放走原生非 passive 监听（React 的 onWheel 是根上的被动监听，preventDefault 无效）；
    // 原生事件在 act 之外不会自动冲刷，故这里显式 act 包一层。**状态更新仍可能是异步冲刷的**
    // （CI 的 Linux runner 慢一档时同步断言会闪红——本用例在 CI 上实测闪红过一次），
    // 所以 viewBox 的变化用 waitFor 等一拍，preventDefault 是同步的、照旧立即断言。
    act(() => {
      canvas.dispatchEvent(ev);
    });
    await waitFor(() => expect(readViewBox("tree-canvas", canvas)).not.toBe(fit));
    expect(ev.defaultPrevented).toBe(true);
  });

  it("refit 不留排队写入：画布落地那一拍就点缩放，viewBox 不会被拉回「适应」", async () => {
    // 「驱动窗口」而不是「等它过去」：取树的应答拿在手里，在 act 之外 resolve，只排微任务（不给调度器
    // macrotask），然后逐拍给 macrotask——画布一出现就**立刻**交互，不给后续 effect 冲刷的机会。
    // 修复前（refit 是 useEffect 的排队写入）这一拍：`setView(zoom)` 被随后那发 `setView(fitView)`
    // 抹回「适应」，viewBox 原地不动，断言红。修复后（refit 落到渲染阶段，见 lib/useCanvasPanZoom）没有
    // 排队写入，交互即时生效。把被动 refit 临时放回去，本用例即重新变红（mutation 面）。
    // 本条钉的是**「布局复位不留排队写入」这个形状**——不是声称「负载下那次红就是它」：机制只证到这里。
    const treeD = deferred<Response>();
    const histD = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/tree") return treeD.promise;
        if (url.pathname === "/api/history") return histD.promise;
        return Promise.resolve(jsonResponse({}, 404));
      }),
    );
    render(<StoryTreeScreen />);
    treeD.resolve(jsonResponse({ worldId: "campus-summer-1", markdown: SMALL_MD }));
    histD.resolve(jsonResponse({ worldId: "campus-summer-1", snapshots: [] }));
    await flushMicrotasks();

    const canvas = await firstFrameWith("tree-canvas");
    const fit = readViewBox("tree-canvas", canvas);
    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    expect(readViewBox("tree-canvas", canvas), "点缩放后 viewBox 没变——view 被排队中的 refit 抹回了 fit").not.toBe(fit);
  });

  it("重取（treeStamp 变）不拆画布：刷新后还是同一颗 DOM，视图不被重新「适应」", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const canvas = screen.getByTestId("tree-canvas");
    const fit = readViewBox("tree-canvas", canvas);
    // 先放大一档：重取若拆画布，视图会被重新「适应」回 100%
    fireEvent.click(screen.getByTestId("tree-zoom-in"));
    const zoomed = readViewBox("tree-canvas", canvas);
    expect(box(zoomed)[2]).toBeLessThan(box(fit)[2]);

    // 触发重取（编辑完成 / 回退完成 / 手动刷新 / SSE treeEdited 都走这条）：旧守卫 `!loading && !error`
    // 会让画布随 data 一起被清掉、回来时重挂（DOM 换新、视图回「适应」）；现在树跨重取保留，画布不拆。
    act(() => useGameStore.getState().refreshTree());
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    // readViewBox 先断言「抓的节点没被换掉」——重挂时它会带着「旧节点值 / 当前节点值 / 是否同一颗」把话说明白
    expect(readViewBox("tree-canvas", canvas)).toBe(zoomed);
    expect(screen.getByTestId("tree-canvas")).toBe(canvas);
    expect(screen.getByTestId("tree-zoom-level").textContent).toBe("125%");
  });

  it("重取失败保留旧树：画布不拆、只多一条错误提示（不白屏）", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    const canvas = screen.getByTestId("tree-canvas");

    // 下一次 /api/tree 直接失败：旧守卫（`!error && !loading`）会把整块内容连画布一起清掉、只剩错误条；
    // 现在旧树跨失败保留——错误提示照上屏，但玩家正在看的那张图不被抽走。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/tree") return jsonResponse({ error: "剧情树读取失败" }, 500);
        if (url.pathname === "/api/history") return jsonResponse({ worldId: "campus-summer-1", snapshots: [] });
        return jsonResponse({}, 404);
      }),
    );
    act(() => useGameStore.getState().refreshTree());
    await waitFor(() => expect(screen.getByTestId("tree-error")).toBeTruthy());

    expect(screen.getByTestId("tree-canvas")).toBe(canvas); // 同一颗 DOM：没被失败清屏带走
    expect(screen.getByTestId("tree-zoom-level").textContent).toBe("100%");
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

describe("tree-view 展示层纯函数：章节键 / 状态 slug / 归档键（v1.13 data-testid 债）", () => {
  const node = (id: string): TreeNode => ({
    id,
    beat: "",
    location: "",
    present: "",
    synopsis: "",
    edges: [],
    status: "可达",
  });
  const chapter = (over: Partial<TreeChapter>): TreeChapter => ({
    title: "",
    goal: "",
    outline: "",
    current: null,
    nodes: [],
    ...over,
  });

  it("chapterItems：章号唯一时键就是章号，重号退回 `章号-下标`（逐项唯一），无节点章退回文件次序", () => {
    // 唯一章号：键 = 章号本身（testid tree-chapter-2 / tree-chapter-3）
    const unique = chapterItems([
      chapter({ title: "雨夜来客", nodes: [node("2-1")] }),
      chapter({ title: "雨夜之后", nodes: [node("3-1")] }),
    ]);
    expect(unique.map((c) => c.no)).toEqual([2, 3]);
    expect(unique.map((c) => c.key)).toEqual(["2", "3"]);
    expect(unique.map((c) => c.label)).toEqual(["第 2 章 · 雨夜来客", "第 3 章 · 雨夜之后"]);

    // 重号（中文数字标题读不出号 → 章号退化成节点 id 前缀 3）：两颗都退回 `章号-下标`，键仍逐项唯一
    const dup = chapterItems([
      chapter({ title: "第 3 章：雨夜之后", nodes: [node("3-1")] }),
      chapter({ title: "第 四 章：末尾的灯", nodes: [node("3-9")] }),
    ]);
    expect(dup.map((c) => c.no)).toEqual([3, 3]);
    expect(dup.map((c) => c.key)).toEqual(["3-0", "3-1"]);
    expect(new Set(dup.map((c) => c.key)).size).toBe(dup.length); // 两颗药丸都点得开

    // 混合：只有重号的那几项带下标，唯一章号照旧取章号
    const mixed = chapterItems([
      chapter({ title: "第 2 章", nodes: [node("2-1")] }),
      chapter({ title: "第 3 章", nodes: [node("3-1")] }),
      chapter({ title: "第 四 章", nodes: [node("3-9")] }),
    ]);
    expect(mixed.map((c) => c.key)).toEqual(["2", "3-1", "3-2"]);

    // 无节点、标题也读不出数字的章：章号退回文件次序 index+1
    const fallback = chapterItems([chapter({ title: "", nodes: [] })]);
    expect(fallback[0]!.no).toBe(1);
    expect(fallback[0]!.key).toBe("1");
    expect(chapterItems([])).toEqual([]);
  });

  it("STATUS_SLUG 覆盖全部四种节点状态（ASCII slug，与展示用词解耦）", () => {
    expect(STATUS_SLUG).toEqual({ 已走过: "visited", 可达: "reachable", 已剪枝: "pruned", 嫁接: "grafted" });
    // 四个键恰好是节点状态全集（新增状态忘了配 slug → testid 会变成 undefined）
    expect(Object.keys(STATUS_SLUG)).toHaveLength(4);
  });

  it("archiveKey：取行内 `第 N 章` 的章号；抽不出号时退回 `line-下标`", () => {
    expect(archiveKey("- 第 1 章：教室相遇；已走：1-1 → 1-2", 0)).toBe("1");
    expect(archiveKey("- 第 12 章：雨夜", 3)).toBe("12");
    expect(archiveKey("- 开头的话（没有章号）", 2)).toBe("line-2"); // 无号行的兜底键
    expect(archiveKey("", 0)).toBe("line-0");
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
      章号只能取自节点 id 前缀 3-9 → 与前面的「第 3 章」同号。重号的章用 `章号-下标` 当键
      （`tree-chapter-3-1` / `tree-chapter-3-2`），否则两颗药丸会撞成同一个 id、第二颗永远点不开 */
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
    // testid 用章节键（章号唯一时就是章号）：第 2 章在 0 位、第 3 章在 1 位，各只出现一次 → tree-chapter-2 / tree-chapter-3
    const ch2 = screen.getByTestId("tree-chapter-2");
    const ch3 = screen.getByTestId("tree-chapter-3");
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
    expect(screen.getByTestId("tree-chapter-3").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tree-chapter-2").getAttribute("aria-pressed")).toBe("false");
    expect(within(screen.getByTestId("tree-chapter-2")).getByText("当前")).toBeTruthy(); // 进度指针仍在第 2 章

    // 章号重号（番外章的首个节点 id 前缀同为 3）：重号的章退回 `章号-下标` 键，保证 testid 与选中态逐项唯一——
    // 只按章号认的话这棵树会给两颗同名药丸，点第二颗会落回第一颗（选不中，画布也不换）
    treeMd = DUP_MD;
    act(() => useGameStore.getState().refreshTree());
    await waitFor(() => expect(screen.getByTestId("tree-chapter-3-2")).toBeTruthy());
    const pills = within(screen.getByTestId("tree-chapters"));
    expect(pills.getAllByRole("button")).toHaveLength(3);
    expect(pills.getByTestId("tree-chapter-3-1").textContent).toContain("第 3 章 · 雨夜之后");
    expect(pills.getByTestId("tree-chapter-3-2").textContent).toContain("第 3 章 · 末尾的灯");
    // 旧选中键是 "3"（那时第 3 章唯一）；番外章一进来它重号了、键改叫 "3-1"/"3-2"，旧键落空 →
    // chapterIdx 按章号兜底：认回第一颗同号药丸，选中仍停在第 3 章、画布也不漂（见 StoryTreeScreen 的注释）
    expect(pills.getByTestId("tree-chapter-3-1").getAttribute("aria-pressed")).toBe("true");
    expect(pills.getByTestId("tree-chapter-2").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("tree-node-3-1")).toBeTruthy(); // 画布就停在这一章，没被重号挤回默认章

    fireEvent.click(pills.getByTestId("tree-chapter-3-2"));
    expect(screen.getByTestId("tree-chapter-3-2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tree-chapter-3-1").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("tree-node-3-9")).toBeTruthy(); // 画的是后一颗药丸那一章
    expect(screen.queryByTestId("tree-node-3-1")).toBeNull();
  });

  it("归档药丸不是死链：点它明说「只剩目录信息」并就地高亮，再点收起；不冒充能开那一章", async () => {
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    const pill = screen.getByTestId("tree-archive-1"); // 归档行「- 第 1 章：…」→ 键取章号 1
    expect(pill.textContent).toContain("第 1 章");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("tree-archive-notice")).toBeNull();

    fireEvent.click(pill);
    expect(screen.getByTestId("tree-archive-notice").textContent).toBe("这一章已归档，只保留了目录信息");
    expect(screen.getByTestId("tree-archive-1").getAttribute("aria-pressed")).toBe("true");
    // 归档只有目录信息（节点数据不在文件里）：画布照旧停在当前进度章，不会切到一个空章
    expect(screen.getByTestId("tree-chapter-2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tree-node-2-1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tree-archive-1"));
    expect(screen.queryByTestId("tree-archive-notice")).toBeNull(); // 再点收起
  });
});
