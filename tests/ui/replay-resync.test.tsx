// @vitest-environment jsdom
// 回退与重演（拆自 tests/ui.test.tsx）：非破坏式分割线/待重同步与再同步、玩家继续走时不冒充重同步、
// 重演这一幕（解析目标幕与回退点、重同步收尾后重发当时的玩家输入——输入取自快照，v1.13）。
// 单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../src/components/game/TopBar";
import HistoryDrawer from "../../src/components/game/HistoryDrawer";
import WorldsScreen from "../../src/components/WorldsScreen";
import { useGameStore } from "../../src/store/game";
import { type WorldEntry, type WorldSnapshotMeta } from "../../src/lib/acp";
import { PRESET, jsonResponse, openRailGroup, focusProbe, pressTab, setupUi } from "./helpers";

setupUi();

// ————————————————————— 回退语义收尾：history 分割线 / 待重同步徽章 / treeNotice 三态 —————————————————————

describe("回退后的客户端语义：非破坏式分割线、待重同步与再同步（v1.7）", () => {
  /** POST /prompt 的返回（用例内切换失败→成功） */
  let promptResp: { ok: boolean; error?: string };
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  /** POST /api/worlds 收到的动作 */
  let worldPosts: Record<string, unknown>[];

  const WORLDS_BODY: { worlds: WorldEntry[] } = {
    worlds: [
      {
        worldId: "campus-summer-1",
        preset: PRESET.id,
        title: PRESET.title,
        chapterNo: 2,
        lastPlayed: Date.now(),
        note: "",
        forkedFrom: null,
        exists: true,
      },
      {
        worldId: "campus-summer-2",
        preset: PRESET.id,
        title: PRESET.title,
        chapterNo: 1,
        lastPlayed: Date.now(),
        note: "",
        forkedFrom: null,
        exists: true,
      },
    ],
  };

  beforeEach(() => {
    promptResp = { ok: true };
    prompts = [];
    worldPosts = [];
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "game",
      screenReturn: null,
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
      history: [],
      turnNo: 0,
      segs: { 0: "" },
      curSeg: 0,
      pendingResync: null,
      resyncFailed: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse(
            promptResp.ok ? promptResp : { ok: false, error: promptResp.error ?? "HTTP 409" },
            promptResp.ok ? 200 : 409,
          );
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          if (body.action === "restore") return jsonResponse({ ok: true, backupSeq: 12 });
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse(WORLDS_BODY);
        return jsonResponse({}, 404);
      }),
    );
  });

  it("回退成功：history 追加 rollback 分割线（旧幕一条不删），抽屉里旧幕置灰、分割线之后的新幕正常", async () => {
    useGameStore.setState({
      history: [
        { kind: "act", n: "第 1 幕", t: "旧幕一：门口初遇" },
        { kind: "act", n: "第 2 幕", t: "旧幕二：中殿对话" },
      ],
      turnNo: 2,
    });
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(3);
    });
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 3 }]);
    expect(useGameStore.getState().history[2]).toMatchObject({ kind: "rollback", seq: 3 }); // 追加，不删除

    // 重同步回合收尾：新一幕叠在分割线之后
    act(() => {
      useGameStore.setState({ segs: { 0: "重同步后的正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().history).toHaveLength(4);

    const trigger = focusProbe(); // 命令轨「回想」按钮的替身：它拿着焦点时开抽屉（焦点归还的断言要用）
    useGameStore.setState({ drawerOpen: true, chapterNo: 2 });
    render(<HistoryDrawer />);
    // 非破坏式分割线：只插一行、旧幕一条不删；标题带当前章号（顶栏已不再显示章号）
    expect(screen.getByText("回 想 · 第 2 章")).toBeTruthy();
    expect(screen.getByTestId("history-rollback").textContent).toBe("—— 已回溯到第 3 幕 ——");
    const acts = screen.getAllByTestId("history-act");
    expect(acts).toHaveLength(3); // 两幕旧 + 一幕新，一条没删
    // 抽屉倒序渲染：新幕在分割线之后（正常），两幕旧幕在分割线之前（置灰）
    expect(acts[0].textContent).toContain("重同步后的正文");
    expect(acts[0].className).not.toContain("opacity-50");
    expect(acts[1].className).toContain("opacity-50");
    expect(acts[2].className).toContain("opacity-50");

    // —— v1.9 a11y：抽屉语义 + 焦点陷阱 + 关闭归还 ——
    const panel = screen.getByTestId("history-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    // 名字是读得出来的形态（屏上标题靠空格撑字距，读屏不该逐个念空格）
    expect(panel.getAttribute("aria-label")).toBe("回想 · 第 2 章");
    const close = within(panel).getByRole("button", { name: "关闭回想" });
    expect(document.activeElement).toBe(close); // 开抽屉把焦点送进来（它是抽屉里唯一可聚焦的元素）
    pressTab(); // 单元素容器上的回绕形态：Tab 原地不动，不跑到抽屉外面（TopBar / 命令轨）去
    expect(document.activeElement).toBe(close);
    pressTab(true);
    expect(document.activeElement).toBe(close);

    // 关闭归还焦点：回到开抽屉前拿着焦点的那个元素
    act(() => {
      useGameStore.getState().toggleDrawer();
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("重同步失败：TopBar 亮徽章与「再同步」，点击重发续玩指令；成功回合后徽章消失，世界线屏行内也有小标", async () => {
    // 回退成功、但补发的续玩指令没发出去（409）：立即进入失败态
    promptResp = { ok: false, error: "上一回合还在进行" };
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingResync).toEqual({ worldId: "campus-summer-1", seq: 7 }); // 保留：还有救
    expect(useGameStore.getState().treeNotice).toContain("重同步失败");
    expect(useGameStore.getState().status).toContain("出错"); // 状态行与提示条同说失败，不再各说各话

    render(<TopBar />);
    expect(screen.getByTestId("resync-badge").textContent).toBe("待重同步");
    const retry = screen.getByTestId("resync-retry");
    expect(retry.textContent).toBe("再同步");

    // 世界线屏：该世界行内亮「待重同步」小标（别的世界不亮）
    cleanup();
    useGameStore.setState({ selected: PRESET, screen: "worlds" });
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-continue-campus-summer-1")).toBeTruthy());
    expect(screen.getByTestId("world-resync-campus-summer-1").textContent).toBe("待重同步");
    expect(screen.queryByTestId("world-resync-campus-summer-2")).toBeNull();

    // 点「再同步」：重发同一条续玩指令（走正常 send 流程）
    cleanup();
    useGameStore.setState({ screen: "game" });
    render(<TopBar />);
    promptResp = { ok: true };
    await act(async () => {
      fireEvent.click(screen.getByTestId("resync-retry"));
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().resyncFailed).toBe(false);
    expect(screen.queryByTestId("resync-retry")).toBeNull(); // 失败入口收起，徽章留到回合收尾

    // 这次回合成功收尾：徽章消失
    act(() => {
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().pendingResync).toBeNull();
    expect(screen.queryByTestId("resync-badge")).toBeNull();
  });

  it("treeNotice 三态：回退成功→「正在同步进度」；回合收尾→「进度已同步」；引擎 error→「失败可重试」", async () => {
    // 态一：回退成功、续玩指令已发出（等回合）
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(5);
    });
    const pending = useGameStore.getState().treeNotice ?? "";
    expect(pending).toContain("已回到第 5 幕");
    expect(pending).toContain("正在同步进度");

    // 态二：重同步回合 turn_end → 完成重同步（徽章同回合清除）
    act(() => {
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().treeNotice).toBe("已回到第 5 幕，进度已同步");
    expect(useGameStore.getState().pendingResync).toBeNull();

    // 态三：再次回退，这次引擎在回合里回 error（SSE error 事件路径）
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(5);
    });
    act(() => {
      useGameStore.getState().handleEvent({ type: "error", message: "引擎回合失败：引擎坏了" });
    });
    const s = useGameStore.getState();
    expect(s.pendingResync).toEqual({ worldId: "campus-summer-1", seq: 5 }); // 保留：徽章与「再同步」还挂着
    expect(s.resyncFailed).toBe(true);
    expect(s.treeNotice).toContain("重同步失败：引擎回合失败：引擎坏了");
    expect(s.treeNotice).toContain("再同步");
    expect(s.status).toContain("出错");
  });
});

// ————————————————————— 回退后玩家继续走：普通回合不冒充重同步（v1.7） —————————————————————

describe("回退后玩家继续走：普通指令不冒充重同步（v1.7）", () => {
  /** POST /prompt 的逐条返回（按序消费：先失败制造 resume 投递失败，再按用例切换） */
  let promptResps: { ok: boolean; error?: string }[];
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  /** 可选闸门：让下一条 /prompt 响应挂起不落定（「重同步仍在途」用例用），release 后才返回 */
  let promptGate: Promise<void> | null;

  beforeEach(() => {
    promptResps = [];
    prompts = [];
    promptGate = null;
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "game",
      screenReturn: null,
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
      history: [],
      turnNo: 0,
      segs: { 0: "" },
      curSeg: 0,
      pendingResync: null,
      resyncFailed: false,
      resyncing: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          const resp = promptResps.shift() ?? { ok: true };
          if (promptGate) {
            const g = promptGate;
            promptGate = null;
            await g;
          } // 先记本次开关，响应挂到闸门放行
          return jsonResponse(resp.ok ? resp : { ok: false, error: resp.error ?? "HTTP 409" }, resp.ok ? 200 : 409);
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          if (body.action === "restore") return jsonResponse({ ok: true, backupSeq: 12 });
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: [] });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("resume 投递失败后玩家发普通指令并成功：徽章静默消失，不宣告「完成重同步」", async () => {
    promptResps = [
      { ok: false, error: "上一回合还在进行" }, // restore 后补发的 resume：投递失败
      { ok: true }, // 玩家的普通指令：成功
    ];
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(useGameStore.getState().pendingResync).toEqual({ worldId: "campus-summer-1", seq: 7 });

    render(<TopBar />);
    expect(screen.getByTestId("resync-badge").textContent).toBe("待重同步"); // 前置：徽章在

    // 玩家不理会徽章，直接发普通指令且成功：send 入口静默清 pendingResync，回合照常收尾
    await act(async () => {
      useGameStore.getState().send("推门进去");
    });
    useGameStore.setState({ segs: { 0: "门后的走廊空无一人。\n\n**行动**\n1. 往前走" }, curSeg: 0 });
    act(() => {
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });

    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    const s = useGameStore.getState();
    expect(s.pendingResync).toBeNull(); // send 入口静默清，不是回合收尾认领的
    expect(s.resyncFailed).toBe(false);
    expect(s.treeNotice).toBeNull(); // 失败文案的残影一并撤下（按钮已随徽章消失，留着会指向不存在的入口）
    expect(screen.queryByTestId("resync-badge")).toBeNull(); // 徽章消失
    expect(s.status).toBe("就绪"); // 普通回合收尾一切照旧
  });

  it("resume 投递失败后玩家自己的指令也失败：不再冒充「重同步失败」", async () => {
    promptResps = [
      { ok: false, error: "上一回合还在进行" }, // resume 投递失败
      { ok: false, error: "HTTP 500" }, // 玩家的普通指令：也失败
    ];
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));

    await act(async () => {
      useGameStore.getState().send("推门进去");
    });
    await waitFor(() => expect(useGameStore.getState().status).toContain("HTTP 500"));
    const s = useGameStore.getState();
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    expect(s.pendingResync).toBeNull(); // send 入口已静默清
    expect(s.resyncFailed).toBe(false); // 玩家指令的失败不再记账到重同步头上
    expect(s.treeNotice).toBeNull(); // 残影一并撤（按钮已随徽章消失）；玩家指令的失败也不再被写成「重同步失败」
    expect(s.status).toBe("出错：HTTP 500"); // 普通出错文案照常
  });

  it("重同步仍在途时玩家发普通指令：迟到的 resume 失败不写「重同步失败」残影", async () => {
    promptResps = [{ ok: false, error: "上一回合还在进行" }]; // resume 的失败结果迟到一步
    let releaseResume!: () => void;
    promptGate = new Promise<void>((r) => {
      releaseResume = r;
    }); // 挂起 resume 的响应
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    expect(useGameStore.getState().resyncing).toBe(true); // 前置：resume 投递还没落定

    await act(async () => {
      useGameStore.getState().send("推门进去"); // 不等结果，先放弃重同步
    });
    await act(async () => {
      releaseResume(); // 放行迟到的 resume 失败
      await new Promise((r) => setTimeout(r, 0));
    });

    const s = useGameStore.getState();
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    expect(s.pendingResync).toBeNull();
    expect(s.resyncing).toBe(false);
    expect(s.resyncFailed).toBe(false); // 已放弃的重同步不许把这次失败记进来
    expect(s.treeNotice).toBeNull(); // 也不许写「点再同步重试」的残影
  });
});

// ————————————————————— 重演（v1.7；v1.13 起输入随快照） —————————————————————

describe("重演这一幕：解析目标幕与回退点、重同步收尾后重发当时的玩家输入（v1.13，输入取自快照）", () => {
  /** POST /prompt 的返回开关（用例内切 false 制造 409 投递失败） */
  let promptOk: boolean;
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  /** POST /api/worlds 收到的动作 */
  let worldPosts: Record<string, unknown>[];
  /** GET /api/history 列表返回的快照索引（用例内改写，模拟重演后的新账本） */
  let historySnapshots: WorldSnapshotMeta[];
  /** seq → 该条快照的玩家输入（只有单条查询带 prompt；列表形状刻意不带——ADR-0023 的分层） */
  let promptsBySeq: Record<number, string>;
  /** 单条查询请求过的 seq（按顺序）——证明重演的输入真的来自盘上，不是内存账本 */
  let snapshotFetches: number[];
  /** GET /api/history 是否整体失败（快照数补拉失败的回落路径用） */
  let historyFails: boolean;

  /** 一条快照元信息（nodeId/chapterNo 对重演无意义，占位） */
  const snap = (seq: number, kind: "turn" | "backup"): WorldSnapshotMeta => ({
    seq,
    at: "2026-09-17T00:00:00.000Z",
    kind,
    nodeId: null,
    chapterNo: 1,
    label: "",
  });

  beforeEach(() => {
    promptOk = true;
    prompts = [];
    worldPosts = [];
    snapshotFetches = [];
    historyFails = false;
    // 升序三条：turn 2 / backup 3 / turn 5——重演只认 kind:"turn"：目标幕 = 最新 5（刚结束的本回合）、回退点 = 2
    historySnapshots = [snap(2, "turn"), snap(3, "backup"), snap(5, "turn")];
    promptsBySeq = { 2: "上一幕的输入", 5: "推门进去" };
    useGameStore.setState({
      worldId: "campus-summer-1",
      worldLabel: "campus-summer-1",
      screen: "game",
      screenReturn: null,
      status: "就绪",
      treeStamp: 0,
      treeNotice: null,
      treeFocus: null,
      forkResult: null,
      engineBusy: false,
      pendingTreeMessage: null,
      pendingResync: null,
      resyncFailed: false,
      resyncing: false,
      pendingRerollPrompt: null,
      turnSnapshots: null,
      history: [{ kind: "act", n: "第 3 幕", t: "回合甲：门轴一声闷响。" }],
      turnNo: 3,
      segs: { 0: "" },
      curSeg: 0,
      typingDone: true,
      options: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse(promptOk ? { ok: true } : { ok: false, error: "上一回合还在进行" }, promptOk ? 200 : 409);
        }
        if (url.pathname === "/api/history") {
          if (historyFails) return jsonResponse({ error: "boom" }, 500);
          const seqParam = url.searchParams.get("seq");
          if (seqParam === null) return jsonResponse({ worldId: "campus-summer-1", snapshots: historySnapshots });
          const seq = Number(seqParam);
          snapshotFetches.push(seq);
          const meta = historySnapshots.find((s) => s.seq === seq);
          if (!meta) return jsonResponse({ worldId: "campus-summer-1", snapshots: [] });
          return jsonResponse({
            worldId: "campus-summer-1",
            snapshots: [
              { ...meta, files: { state: "# 状态\n", summary: null, tree: null }, prompt: promptsBySeq[seq] ?? "" },
            ],
          });
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          if (body.action === "restore") return jsonResponse({ ok: true, backupSeq: 12 });
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 404);
      }),
    );
  });

  it("重演全链：目标幕 = 最新 turn（输入取自单条）、回退点 = 它之前最近的 turn（backup 不算）、分割线标 reroll", async () => {
    render(<TopBar />);
    // v1.12：入口搬进了「进度」菜单——先开菜单（可达路径变了，行为和 aria 一个字没改）
    openRailGroup("进度");
    const btn = screen.getByTestId("reroll");
    expect(btn.getAttribute("aria-label")).toBe("重演这一幕");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(snapshotFetches).toEqual([5]); // 输入来自目标幕那条的单条查询（列表刻意不带 prompt）
    // 目标幕 = 最新 turn 5（刚结束的本回合）；回退点 = 它之前最近的 turn 2（backup 3 不参与）
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 2 }]);
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    const s1 = useGameStore.getState();
    expect(s1.pendingResync).toEqual({ worldId: "campus-summer-1", seq: 2 });
    expect(s1.pendingRerollPrompt).toBe("推门进去");
    expect(s1.history[1]).toMatchObject({ kind: "rollback", seq: 2, reason: "reroll" });
    openRailGroup("进度");
    expect(screen.queryByTestId("reroll")).toBeNull(); // 待重同步期间不显示重演（重开菜单也不给）

    // 重同步回合成功收尾 → 清徽章 + 排队跟进立即重发那次输入（走玩家回合路径）
    act(() => {
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去"]);
    expect(useGameStore.getState().pendingResync).toBeNull();
    expect(useGameStore.getState().pendingRerollPrompt).toBeNull();

    // 重演出的新回合（回合乙）收尾：状态回就绪（下一次重演会重新解析盘上的最新一条）
    act(() => {
      useGameStore.setState({ segs: { 0: "回合乙：这次门后传来脚步声。" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(useGameStore.getState().status).toBe("就绪");

    // 分割线文案走 reroll 措辞；旧幕（回合甲）在分割线之前置灰、新幕正常
    useGameStore.setState({ drawerOpen: true });
    render(<HistoryDrawer />);
    expect(screen.getByTestId("history-rollback").textContent).toBe("—— 第 2 幕已重演 ——");
    const acts = screen.getAllByTestId("history-act");
    expect(acts[0].textContent).toContain("回合乙"); // 抽屉倒序：最新在上
    expect(acts[0].className).not.toContain("opacity-50");
    expect(acts[acts.length - 1].textContent).toContain("回合甲");
    expect(acts[acts.length - 1].className).toContain("opacity-50");
  });

  it("最新条目是空的续玩回合（刷新/重启后的「继续世界线」）：回看到最近一条带输入的幕，重演它", async () => {
    // 现实链：场景（#5，输入「推门进去」）→ 回退备份（#6）→ 读档续玩（#7，prompt 空）——刷新后正是这个样子
    historySnapshots = [snap(3, "turn"), snap(5, "turn"), snap(6, "backup"), snap(7, "turn")];
    promptsBySeq = { 3: "上一幕的输入", 5: "推门进去", 7: "" };
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    expect(snapshotFetches).toEqual([7, 5]); // 先探最新（空）→ 再探最近带输入的那一幕
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 3 }]); // 回退点 = #5 之前最近的 turn
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去");
  });

  it("旧档（整档都没有输入）：回看取完 → status 给降级提示，不发 restore、不静默", async () => {
    historySnapshots = [snap(2, "turn"), snap(5, "turn")];
    promptsBySeq = { 2: "", 5: "" }; // v1.13 之前的档：字段缺省收敛为空串，客户端分辨不了也不为此再加字段
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    expect(snapshotFetches).toEqual([5, 2]); // 回看取完（本地单条查询）；REPLAY_PROBE_MAX 只兜极端链
    expect(worldPosts).toEqual([]);
    expect(prompts).toEqual([]);
    expect(useGameStore.getState().status).toBe("无法重演：这一档没有留下当时的输入");
    expect(useGameStore.getState().pendingRerollPrompt).toBeNull();
  });

  it("唯一带输入的幕就是第一条 turn：无处可退 → status 说清「这是第一幕」", async () => {
    historySnapshots = [snap(1, "turn"), snap(2, "backup")]; // 有输入但没有更早的 turn 可退
    promptsBySeq = { 1: "开场白。" };
    useGameStore.setState({ turnSnapshots: null }); // 未知：不藏功能，点击时再判定
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    expect(worldPosts).toEqual([]);
    expect(prompts).toEqual([]);
    const s = useGameStore.getState();
    expect(s.pendingResync).toBeNull();
    expect(s.pendingRerollPrompt).toBeNull();
    expect(s.history).toHaveLength(1); // 没有插分割线
    expect(s.status).toBe("无法重演：这是第一幕，没有可回退的存档点");
    openRailGroup("进度");
    expect(screen.queryByTestId("reroll")).toBeNull(); // 状态行已离开「就绪」：入口收起
  });

  it("已知快照不足（turnSnapshots < 2）：重演入口不渲染（spec：首个回合禁用按钮）", async () => {
    useGameStore.setState({ turnSnapshots: 1 }); // 已知只有一条 turn 快照：没有「上一回合结束态」可回
    render(<TopBar />);
    openRailGroup("进度");
    expect(screen.queryByTestId("reroll")).toBeNull();
    act(() => useGameStore.setState({ turnSnapshots: 2 })); // 攒够两条：入口出现
    expect(screen.getByTestId("reroll")).toBeTruthy();
  });

  it("回合收尾按需补拉快照数：未知 → 拉到两条后重演入口仍在（不误藏）", async () => {
    useGameStore.setState({ turnSnapshots: null, status: "就绪" });
    render(<TopBar />);
    openRailGroup("进度");
    expect(screen.getByTestId("reroll")).toBeTruthy(); // 未知态：先展示
    act(() => {
      useGameStore.setState({ segs: { 0: "回合正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    await waitFor(() => expect(useGameStore.getState().turnSnapshots).toBe(2)); // 补拉成功（mock 两条 turn）
    expect(screen.getByTestId("reroll")).toBeTruthy();
  });

  it("补拉失败：已知计数回落未知（不藏功能），后续回合会再试", async () => {
    historyFails = true; // GET /api/history 整体失败
    useGameStore.setState({ turnSnapshots: 0, status: "就绪" });
    render(<TopBar />);
    openRailGroup("进度");
    expect(screen.queryByTestId("reroll")).toBeNull(); // 前置：已知 0 → 入口不渲染
    await act(async () => {
      useGameStore.setState({ segs: { 0: "回合正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
      await new Promise((r) => setTimeout(r, 0)); // 放行失败的补拉（catch 分支）
    });
    expect(useGameStore.getState().turnSnapshots).toBeNull(); // 回落未知：宁可展示 + 点击判定，不藏功能
    expect(screen.getByTestId("reroll")).toBeTruthy(); // 菜单开着：条目随 store 变化就地长回来
  });

  it("连掷：第一次重演走完后，再点按此刻盘上的最新一条重新解析（账本已删，输入仍在盘上）", async () => {
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    act(() => {
      // 重同步回合收尾 → 自动重发
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    act(() => {
      // 重演出的回合乙收尾 → 就绪，重演入口回来
      useGameStore.setState({ segs: { 0: "回合乙正文" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    // 服务器侧的新账本：旧两条 turn + 第一次重演的 backup(12) + 回合乙的 turn(14)（输入 = 重发的那句）
    historySnapshots = [snap(2, "turn"), snap(3, "backup"), snap(5, "turn"), snap(12, "backup"), snap(14, "turn")];
    promptsBySeq = { ...promptsBySeq, 14: "推门进去" };
    openRailGroup("进度");
    const btn = screen.getByTestId("reroll");
    await act(async () => {
      fireEvent.click(btn);
    });
    // turn 序列 [2,5,14]：目标幕 = 14（回合乙）、回退点 = 5——第二次重演按新账本退到 5
    expect(snapshotFetches).toEqual([5, 14]);
    expect(worldPosts).toStrictEqual([
      { action: "restore", worldId: "campus-summer-1", seq: 2 },
      { action: "restore", worldId: "campus-summer-1", seq: 5 },
    ]);
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去", "继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 又排了一次重发
  });

  it("重同步投递失败后玩家改发普通指令：排队重发作废，重发的玩家文本不出现第二次", async () => {
    promptOk = false; // restore 后补发的续档指令 409：进入「待重同步 + 已排队重发」态
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 前置：排队重发还挂着

    promptOk = true;
    await act(async () => {
      useGameStore.getState().sendPlayerTurn("原地等待");
    });
    act(() => {
      useGameStore.setState({ segs: { 0: "门在雨里纹丝不动。" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    // 普通指令回合的收尾不认领排队重发（认领条件是 resyncing 收尾）：玩家文本只出现一次，
    // 排队的「推门进去」已随 pendingResync 在 send 入口静默作废
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "原地等待"]);
    expect(prompts.filter((p) => p === "推门进去")).toHaveLength(0);
    const s = useGameStore.getState();
    expect(s.pendingRerollPrompt).toBeNull();
  });

  it("重同步投递失败后点「再同步」：成功收尾后玩家文本恰好重发一次", async () => {
    promptOk = false; // 续档指令 409：徽章 + 「再同步」入口
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 排队重发保留：还有救

    promptOk = true;
    await act(async () => {
      fireEvent.click(screen.getByTestId("resync-retry"));
    });
    // 再同步回合成功收尾：清徽章 + 排队跟进立即重发玩家文本（且只有这一次）
    act(() => {
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。", "推门进去"]);
    expect(prompts.filter((p) => p === "推门进去")).toHaveLength(1); // 恰好一次
    const s = useGameStore.getState();
    expect(s.pendingRerollPrompt).toBeNull();
    expect(s.pendingResync).toBeNull();
  });

  it("玩家入口只留 trim 守卫；重演入口的显隐只看快照数（v1.13 删内存账本后不再有「按钮点了没反应」）", async () => {
    await act(async () => {
      useGameStore.getState().sendPlayerTurn(" 推门进去 ");
    });
    expect(prompts).toEqual(["推门进去"]); // trim 守卫仍在：只发这一条

    // 投递失败（409）不写任何账本（账本已删）：只剩状态文案
    promptOk = false;
    await act(async () => {
      useGameStore.getState().sendPlayerTurn("往前走");
    });
    await waitFor(() => expect(useGameStore.getState().status).toContain("出错"));

    // TopBar：可见性只看快照数；输入有无由点击时解析（刷新/重启后照样可重演）
    promptOk = true;
    cleanup();
    useGameStore.setState({ status: "就绪", turnSnapshots: 2 });
    render(<TopBar />);
    openRailGroup("进度");
    expect(screen.getByTestId("reroll")).toBeTruthy();
    act(() => useGameStore.setState({ turnSnapshots: null }));
    expect(screen.getByTestId("reroll")).toBeTruthy(); // 未知不藏功能
    act(() => useGameStore.setState({ turnSnapshots: 1 }));
    expect(screen.queryByTestId("reroll")).toBeNull(); // 已知不足：收起（菜单开着也即时跟 store 走）
  });
});
