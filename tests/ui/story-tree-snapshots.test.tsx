// @vitest-environment jsdom
// 剧情图屏的存档点（拆自 tests/ui.test.tsx）：快照标注（最早匹配快照/命名）、原地回退与「回到这一幕并重演」、
// 分叉带 seq、快照对比 diff 面板（三 tab / equal 折叠 / 失败态）。基线复位由 ./helpers 的 setupUi() 统一负责。

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StoryTreeScreen from "../../src/components/StoryTreeScreen";
import { useGameStore } from "../../src/store/game";
import { earliestSnapshotByNode, prevSnapshotSeq, snapshotTurnNo } from "../../src/lib/tree-view";
import { type WorldSnapshotMeta } from "../../src/lib/acp";
import { jsonResponse, setupUi } from "./helpers";

setupUi();

// ————————————————————— v1.6 第二段：剧情图快照 / 大图降级 / 游戏键盘 / 状态播报 —————————————————————

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
    { seq: 3, at: "2026-01-01T00:00:00.000Z", kind: "turn", nodeId: "2-1", chapterNo: 2, label: "" },
    { seq: 7, at: "2026-01-01T01:00:00.000Z", kind: "turn", nodeId: "2-2", chapterNo: 2, label: "" },
    { seq: 9, at: "2026-01-01T02:00:00.000Z", kind: "backup", nodeId: "2-2", chapterNo: 2, label: "" },
    { seq: 11, at: "2026-01-01T03:00:00.000Z", kind: "turn", nodeId: null, chapterNo: 2, label: "" },
  ];

  let snapshots: WorldSnapshotMeta[] = [];
  /** GET /api/history 被调了几次（回退后应重取：节点标注与「最早快照」映射都变了） */
  let historyCalls = 0;
  /** POST /api/worlds 收到的动作（按顺序） */
  let worldPosts: Record<string, unknown>[] = [];
  /** restore 的返回（单个用例可覆盖成失败） */
  let restoreResp: Record<string, unknown> = { ok: true, backupSeq: 12 };
  /** seq → 单条查询带回的玩家输入（重演的数据源；默认空 = 旧档/续玩） */
  let promptsBySeq: Record<number, string> = {};
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[] = [];

  beforeEach(() => {
    snapshots = SNAPSHOTS;
    historyCalls = 0;
    worldPosts = [];
    restoreResp = { ok: true, backupSeq: 12 };
    promptsBySeq = {};
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
        if (url.pathname === "/api/tree") return jsonResponse({ worldId: "campus-summer-1", markdown: TREE_MD });
        if (url.pathname === "/api/history") {
          historyCalls += 1;
          const seqParam = url.searchParams.get("seq");
          if (seqParam !== null) {
            // 单条才带 files 与 prompt（重演的解析内核在这里取输入；列表形状刻意不带，见 ADR-0023）
            const seq = Number(seqParam);
            const meta = snapshots.find((s) => s.seq === seq);
            if (!meta) return jsonResponse({ worldId: "campus-summer-1", snapshots: [] });
            return jsonResponse({
              worldId: "campus-summer-1",
              snapshots: [
                {
                  ...meta,
                  files: { state: "# 状态\n", summary: null, tree: TREE_MD },
                  prompt: promptsBySeq[seq] ?? "",
                },
              ],
            });
          }
          return jsonResponse({ worldId: "campus-summer-1", snapshots });
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          if (body.action === "fork") return jsonResponse({ ok: true, worldId: "campus-summer-3" });
          if (body.action === "restore") return jsonResponse(restoreResp, restoreResp.ok ? 200 : 400);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 404);
      }),
    );
  });

  it("存档点命名（v1.12）：名字上屏、就地改名 → POST labelSnapshot（写索引，不碰快照文件）", async () => {
    // 已有名字的存档点：显示在「存档点 · 第 N 幕」后面，输入框预填它
    snapshots = [{ ...SNAPSHOTS[0], label: "雨夜遇袭前" }]; // SNAPSHOTS[0] = seq 3 / 节点 2-1
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());
    fireEvent.click(screen.getByTestId(/^tree-node-2-1$/));

    await waitFor(() => expect(screen.getByTestId("tree-snapshot-2-1").textContent).toContain("雨夜遇袭前"));
    const input = screen.getByTestId("snapshot-label-input") as HTMLInputElement;
    expect(input.value).toBe("雨夜遇袭前");
    expect((screen.getByTestId("snapshot-label-save") as HTMLButtonElement).disabled).toBe(true); // 没改就没什么可存

    fireEvent.change(input, { target: { value: "改成进教堂之前" } });
    fireEvent.click(screen.getByTestId("snapshot-label-save"));
    // 名字落在**索引层**（labelSnapshot 动作），不是写进 append-only 的快照文件
    await waitFor(() =>
      expect(worldPosts).toContainEqual({
        action: "labelSnapshot",
        worldId: "campus-summer-1",
        seq: 3,
        label: "改成进教堂之前",
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

  it("回到这一幕并重演（v1.13）：turn 条目且之前还有 turn 才出现；两段确认后 restore 回退点、排队重发该条 prompt", async () => {
    promptsBySeq = { 7: "接过信。" };
    render(<StoryTreeScreen />);
    await waitFor(() => expect(screen.getByTestId("tree-canvas")).toBeTruthy());

    // 2-1 的 #3 是第一条 turn：无处可退 → 不给重演入口（回退入口照旧在）
    fireEvent.click(screen.getByTestId("tree-node-2-1"));
    expect(screen.queryByTestId("tree-replay-2-1")).toBeNull();
    expect(screen.getByTestId("tree-restore-2-1")).toBeTruthy();

    // 2-2 的 #7 之前有 #3 → 入口出现；两段确认：首点只进确认态、不发请求
    fireEvent.click(screen.getByTestId("tree-node-2-2"));
    fireEvent.click(screen.getByTestId("tree-replay-2-2"));
    expect(worldPosts).toEqual([]); // 破坏性动作：首点不落请求
    expect(screen.getByTestId("tree-replay-confirm-2-2")).toBeTruthy();

    // 取消回到未确认态；与回退的两组确认互斥（开一组即收另一组）
    fireEvent.click(screen.getByTestId("tree-replay-cancel-2-2"));
    expect(worldPosts).toEqual([]);
    expect(screen.getByTestId("tree-replay-2-2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tree-restore-2-2"));
    expect(screen.queryByTestId("tree-replay-confirm-2-2")).toBeNull();
    fireEvent.click(screen.getByTestId("tree-restore-cancel-2-2"));

    fireEvent.click(screen.getByTestId("tree-replay-2-2"));
    fireEvent.click(screen.getByTestId("tree-replay-confirm-2-2"));

    // 回退点 = #3（#7 之前最近的 turn；#9 backup 在 #7 之后、不参与）；输入 = #7 的 prompt（单条取，列表不带）
    await waitFor(() => expect(worldPosts[0]).toMatchObject({ action: "restore", worldId: "campus-summer-1", seq: 3 }));
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]); // 重同步指令已补发
    const s = useGameStore.getState();
    expect(s.pendingRerollPrompt).toBe("接过信。"); // 排队重发：重同步收尾后送出（与顶栏重演同一条时序）
    expect(s.treeNotice).toContain("已回到第 3 幕");
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
    // label（v1.12 存档点命名）一并带出：没起名是空串，图屏据此显示「第 N 幕 · <名字>」
    expect(map.get("2-1")).toEqual({ seq: 3, turn: 1, label: "" });
    expect(map.get("2-2")).toEqual({ seq: 7, turn: 2, label: "" });
    expect(map.has("2-4")).toBe(false);
    expect([...map.keys()]).toEqual(["2-1", "2-2"]); // nodeId=null 的快照不入表
    // 乱序输入也按 seq 取最早
    expect(earliestSnapshotByNode([SNAPSHOTS[1], SNAPSHOTS[0]]).get("2-1")).toEqual({ seq: 3, turn: 1, label: "" });
    // 起了名就带出来
    expect(earliestSnapshotByNode([{ ...SNAPSHOTS[0], label: "雨夜遇袭前" }]).get("2-1")?.label).toBe("雨夜遇袭前");
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
    { seq: 1, at: "2026-01-01T00:00:00.000Z", kind: "turn", nodeId: "2-1", chapterNo: 2, label: "" },
    { seq: 3, at: "2026-01-01T01:00:00.000Z", kind: "turn", nodeId: "2-2", chapterNo: 2, label: "" },
  ];

  /** state.md 造 10 行 equal 前缀 + 改动行 + 10 行 equal 后缀（折叠视图需要足够长的未变段） */
  const STATE_PREFIX = [
    "# 剧情状态",
    "周目: 1",
    "时间: 深夜",
    "场景: 旅店大堂",
    "张力: 中",
    "在场: 沈屿、来客",
    "天气: 雨",
    "道具: 信",
    "线索: 缺页",
    "地点: 二楼",
  ].join("\n");
  const STATE_SUFFIX = [
    "伏笔: 拖拽声",
    "目标: 拆穿",
    "好感: 中立",
    "信任: 低",
    "警觉: 高",
    "体力: 正常",
    "情绪: 平稳",
    "衣着: 湿透",
    "照明: 烛火",
    "门: 关",
  ].join("\n");
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
            return jsonResponse({ worldId: "campus-summer-1", snapshots: [{ ...meta, files, prompt: "" }] });
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
      prevSnapshotSeq(
        [
          ...SNAPSHOTS,
          { seq: 2, at: "2026-01-01T00:30:00.000Z", kind: "backup", nodeId: "2-1", chapterNo: 2, label: "" },
        ],
        3,
      ),
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
