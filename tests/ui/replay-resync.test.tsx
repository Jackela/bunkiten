// @vitest-environment jsdom
// 回退与重演（拆自 tests/ui.test.tsx）：非破坏性分割线/待重同步与再同步、玩家继续走时不冒充重同步、
// 重演这一幕（解析目标幕与回退点、重同步收尾后重发当时的玩家输入——输入取自快照，v1.13；
// v1.14 起点击先开「预填可编辑输入」的对话框，确认才走重演通路，另有取消/空文本回退两条路径）。
// 单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../src/components/game/TopBar";
import HistoryDrawer from "../../src/components/game/HistoryDrawer";
import WorldsScreen from "../../src/components/WorldsScreen";
import { useGameStore } from "../../src/store/game";
import { type LogEntry, type WorldEntry, type WorldSnapshotMeta } from "../../src/lib/acp";
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
        if (url.pathname === "/api/logs") return jsonResponse({ entries: [], nextBefore: null });
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
        if (url.pathname === "/api/logs") return jsonResponse({ entries: [], nextBefore: null });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("resume 投递失败后玩家发普通指令：先强推一次重同步，收尾后再补发这句话（v1.14 起不再静默作废）", async () => {
    promptResps = [
      { ok: false, error: "上一回合还在进行" }, // restore 后补发的 resume：投递失败
      { ok: true }, // 玩家指令触发的那次强推重同步：成功
    ];
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    await waitFor(() => expect(useGameStore.getState().resyncFailed).toBe(true));
    expect(useGameStore.getState().pendingResync).toEqual({ worldId: "campus-summer-1", seq: 7 });

    render(<TopBar />);
    expect(screen.getByTestId("resync-badge").textContent).toBe("待重同步"); // 前置：徽章在

    // 玩家不理会徽章直接发普通指令：send 入口不再静默作废——先强推一次 `继续世界：`、把这句话排队跟进
    await act(async () => {
      useGameStore.getState().send("推门进去");
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去");

    // 重同步回合成功收尾：清徽章 + 立即补发玩家那句话（恰好一次）
    useGameStore.setState({ segs: { 0: "门后的走廊空无一人。" }, curSeg: 0 });
    act(() => {
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。", "推门进去"]);
    const s = useGameStore.getState();
    expect(s.pendingResync).toBeNull(); // 重同步收尾认领并清除
    expect(s.resyncFailed).toBe(false);
    expect(s.pendingRerollPrompt).toBeNull(); // 已补发
    expect(s.treeNotice).toBe("已回到第 7 幕，进度已同步"); // 这次真的重读了档
    expect(screen.queryByTestId("resync-badge")).toBeNull(); // 徽章消失
  });

  it("resume 投递失败后玩家改发普通指令、强推的重同步也失败：失败仍记在重同步头上（徽章与再同步入口还在）", async () => {
    promptResps = [
      { ok: false, error: "上一回合还在进行" }, // restore 补发的 resume：失败
      { ok: false, error: "HTTP 500" }, // 玩家指令触发的那次强推重同步：也失败
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
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。"]);
    expect(s.pendingResync).toEqual({ worldId: "campus-summer-1", seq: 7 }); // 徽章保留：还有救
    expect(s.resyncFailed).toBe(true);
    expect(s.treeNotice).toContain("重同步失败");
    expect(s.pendingRerollPrompt).toBe("推门进去"); // 那句话还排着队，等再同步成功后补发
    expect(s.status).toBe("出错：HTTP 500"); // 普通出错文案照常
  });

  it("重同步仍在途时玩家发普通指令：强推的那次成功收尾、迟到的旧 resume 失败仍记到重同步头上", async () => {
    promptResps = [{ ok: false, error: "上一回合还在进行" }]; // 只有第一次 resume 有脚本响应（且失败）
    let releaseResume!: () => void;
    promptGate = new Promise<void>((r) => {
      releaseResume = r;
    }); // 挂起第一次 resume 的响应
    await act(async () => {
      await useGameStore.getState().restoreSnapshot(7);
    });
    expect(useGameStore.getState().resyncing).toBe(true); // 前置：第一次 resume 投递还没落定

    await act(async () => {
      useGameStore.getState().send("推门进去"); // 强推第二次 resume（脚本已空 → 默认成功）
    });
    await act(async () => {
      releaseResume(); // 放行迟到的第一次 resume 失败
      await new Promise((r) => setTimeout(r, 0));
    });

    const s = useGameStore.getState();
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。"]);
    // 现状：强推把 resyncing 重新置真，于是迟到的旧失败被 markResyncFailed 认领——徽章 +「再同步」入口亮起
    expect(s.resyncFailed).toBe(true);
    expect(s.resyncing).toBe(false);
    expect(s.pendingResync).toEqual({ worldId: "campus-summer-1", seq: 7 });
    expect(s.pendingRerollPrompt).toBe("推门进去"); // 排队的玩家输入仍在
  });
});

// ————————————————————— 重演（v1.7；v1.13 起输入随快照；v1.14 起先开可编辑对话框） —————————————————————

describe("重演这一幕：先开预填可编辑输入的对话框（v1.14），确认后解析目标幕与回退点、重同步收尾后重发那句（v1.13，输入取自快照）", () => {
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
        if (url.pathname === "/api/logs") return jsonResponse({ entries: [], nextBefore: null });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("重演全链：点入口先开对话框（预填目标幕那句）→ 改一种说法确认 → 目标幕 = 最新带输入的 turn、回退点 = 它之前的 turn、分割线标 reroll", async () => {
    render(<TopBar />);
    // v1.12：入口搬进了「进度」菜单——先开菜单（可达路径变了，行为和 aria 一个字没改）
    openRailGroup("进度");
    const btn = screen.getByTestId("reroll");
    expect(btn.getAttribute("aria-label")).toBe("重演这一幕");

    // v1.14 可编辑重演：点击只是**开框**——只解析目标幕（单条取回那条的输入当预填值），不落任何请求
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(snapshotFetches).toEqual([5]); // 输入来自目标幕那条的单条查询（列表刻意不带 prompt）
    expect(worldPosts).toEqual([]);
    const dialog = screen.getByTestId("reroll-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog"); // 照 overlay 范式：role=dialog + aria-modal + 焦点陷阱
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const input = screen.getByTestId("reroll-input") as HTMLTextAreaElement;
    expect(input.value).toBe("推门进去"); // 预填那一刻的输入
    // 焦点陷阱：焦点在框里循环（输入框 → 取消 → 确认重演 → 回绕回输入框），不许跑到框外。
    // 开框那一拍**不在这里**断言 activeElement：Radix 菜单关闭时「归还焦点给触发器」是一个 setTimeout(0)
    // （FocusScope 的 onUnmountAutoFocus），打桩的 fetch 比那一拍还快；真实链路里网络往返早把它让过去了
    // （真浏览器里开框后焦点就在多行输入上）。这里钉的是陷阱本身还在、且关得住。
    input.focus();
    pressTab();
    expect(document.activeElement).toBe(screen.getByTestId("reroll-cancel"));
    pressTab();
    expect(document.activeElement).toBe(screen.getByTestId("reroll-confirm"));
    pressTab();
    expect(document.activeElement).toBe(input); // 回绕：不跑出框

    // 改一种说法再确认：退到目标幕开演前（回退点 = 它之前最近的 turn 2；backup 3 不参与），重发改写的那句
    fireEvent.change(input, { target: { value: " 换个说法：先敲门。 " } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll-confirm"));
    });
    expect(screen.queryByTestId("reroll-dialog")).toBeNull(); // 确认即关框
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 2 }]);
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    const s1 = useGameStore.getState();
    expect(s1.pendingResync).toEqual({ worldId: "campus-summer-1", seq: 2 });
    expect(s1.pendingRerollPrompt).toBe("换个说法：先敲门。"); // 改写的输入两边 trim 后带过重同步窗口
    expect(s1.history[1]).toMatchObject({ kind: "rollback", seq: 2, reason: "reroll" });
    openRailGroup("进度");
    expect(screen.queryByTestId("reroll")).toBeNull(); // 待重同步期间不显示重演（重开菜单也不给）

    // 重同步回合成功收尾 → 清徽章 + 排队跟进立即重发**改写的那句**（走玩家回合路径）
    act(() => {
      useGameStore.setState({ segs: { 0: "重读档完成" }, curSeg: 0 });
      useGameStore.getState().handleEvent({ type: "turn_end" });
    });
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "换个说法：先敲门。"]);
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

  it("取消：写了一半又不想改——关框不落任何请求，重演入口照旧在；Esc 只关框、不穿透到别处", async () => {
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    fireEvent.change(screen.getByTestId("reroll-input"), { target: { value: "写到一半又不想改了" } });
    fireEvent.click(screen.getByTestId("reroll-cancel"));
    expect(screen.queryByTestId("reroll-dialog")).toBeNull(); // 草稿随框一起丢
    expect(worldPosts).toEqual([]); // 取消不落任何请求
    expect(prompts).toEqual([]);
    expect(useGameStore.getState().rerollDialog).toBeNull();
    expect(useGameStore.getState().pendingResync).toBeNull(); // 没进重演，也就没有待重同步

    // Esc 是同一条取消路径（就地吞掉：冒到 App 的关闭链会顺手关掉整屏）
    openRailGroup("进度");
    expect(screen.getByTestId("reroll")).toBeTruthy(); // 入口还在，可以再来一次
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    fireEvent.keyDown(screen.getByTestId("reroll-dialog"), { key: "Escape" });
    expect(screen.queryByTestId("reroll-dialog")).toBeNull();
    expect(worldPosts).toEqual([]);
  });

  it("空文本回退为原句：清空输入框再确认，重发的仍是快照里那句（与「没改写」同一口径）", async () => {
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    const input = screen.getByTestId("reroll-input") as HTMLTextAreaElement;
    expect(input.value).toBe("推门进去");
    fireEvent.change(input, { target: { value: "   " } }); // 全空白 = 没改写
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll-confirm"));
    });
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 2 }]);
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 回退为预填的那句
  });

  it("最新条目是空的续玩回合（刷新/重启后的「继续世界线」）：回看到最近一条带输入的幕、预填它，确认后重演的是那一幕", async () => {
    // 现实链：场景（#5，输入「推门进去」）→ 回退备份（#6）→ 读档续玩（#7，prompt 空）——刷新后正是这个样子
    historySnapshots = [snap(3, "turn"), snap(5, "turn"), snap(6, "backup"), snap(7, "turn")];
    promptsBySeq = { 3: "上一幕的输入", 5: "推门进去", 7: "" };
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    expect(snapshotFetches).toEqual([7, 5]); // 先探最新（空）→ 再探最近带输入的那一幕
    // 预填的是「最后玩过的那一幕」的输入，而不是那条空的续玩条目
    expect((screen.getByTestId("reroll-input") as HTMLTextAreaElement).value).toBe("推门进去");

    // 不改写法直接确认 = 原样重发那一句（与 v1.13 行为一致）：退到 #5 之前最近的 turn（#3）
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll-confirm"));
    });
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 3 }]); // 回退点 = #5 之前最近的 turn
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去");
  });

  it("旧档（整档都没有输入）：回看取完 → status 给降级提示，不发 restore、不静默，也不开空对话框", async () => {
    historySnapshots = [snap(2, "turn"), snap(5, "turn")];
    promptsBySeq = { 2: "", 5: "" }; // v1.13 之前的档：字段缺省收敛为空串，客户端分辨不了也不为此再加字段
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    expect(snapshotFetches).toEqual([5, 2]); // 回看取完（本地单条查询）；REPLAY_PROBE_MAX 只兜极端链
    expect(screen.queryByTestId("reroll-dialog")).toBeNull(); // 没有可预填的东西：不开空框
    expect(worldPosts).toEqual([]);
    expect(prompts).toEqual([]);
    expect(useGameStore.getState().status).toBe("无法重演：这一档没有留下当时的输入");
    expect(useGameStore.getState().pendingRerollPrompt).toBeNull();
  });

  it("唯一带输入的幕就是第一条 turn：无处可退 → status 说清「这是第一幕」，不开框", async () => {
    historySnapshots = [snap(1, "turn"), snap(2, "backup")]; // 有输入但没有更早的 turn 可退
    promptsBySeq = { 1: "开场白。" };
    useGameStore.setState({ turnSnapshots: null }); // 未知：不藏功能，点击时再判定
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    expect(screen.queryByTestId("reroll-dialog")).toBeNull();
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

  it("连掷：第一次重演走完后，再点按此刻盘上的最新一条重新解析并重开框（账本已删，输入仍在盘上）", async () => {
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    await act(async () => {
      // 框里就是目标幕那句：不改写直接确认 = 原样重发
      fireEvent.click(screen.getByTestId("reroll-confirm"));
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
    expect((screen.getByTestId("reroll-input") as HTMLTextAreaElement).value).toBe("推门进去"); // 预填新目标幕那句
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll-confirm"));
    });
    expect(worldPosts).toStrictEqual([
      { action: "restore", worldId: "campus-summer-1", seq: 2 },
      { action: "restore", worldId: "campus-summer-1", seq: 5 },
    ]);
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "推门进去", "继续世界：campus-summer-1。"]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("推门进去"); // 又排了一次重发
  });

  it("重同步投递失败后玩家改发普通指令：排队的那句被自己的输入顶掉，重发的玩家文本不出现第二次", async () => {
    promptOk = false; // restore 后补发的续档指令 409：进入「待重同步 + 已排队重发」态
    render(<TopBar />);
    openRailGroup("进度");
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll-confirm")); // 预填原句照发
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
    // send 入口先强推一次重同步（第二发 `继续世界：`）、把「原地等待」排进跟进位：旧的「推门进去」被顶掉，
    // 重同步回合收尾后补发的是「原地等待」——玩家文本只出现一次、且从不是旧那句
    expect(prompts).toEqual(["继续世界：campus-summer-1。", "继续世界：campus-summer-1。", "原地等待"]);
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
    await act(async () => {
      fireEvent.click(screen.getByTestId("reroll-confirm")); // 预填原句照发
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

// ————————————————————— 回想接磁盘（v1.14）：抽屉首翻 / 加载更多 / 去重 / 空态 —————————————————————

describe("回想接磁盘（v1.14）：抽屉打开首翻最近一页、底部「加载更多」往更早翻、按 seq 与内存幕去重", () => {
  /** GET /api/logs 的分页返回（参数 = before，null 表示最新一页） */
  let logsFor: (before: number | null) => { entries: LogEntry[]; nextBefore: number | null };
  /** GET /api/logs 是否整体失败 */
  let logsFail: boolean;
  /** GET /api/logs 请求过的 before 参数（证明分页真的按 nextBefore 走） */
  let logBefores: (number | null)[];

  /** 一条磁盘回合记录（prompt 对抽屉内容无意义，只留 text） */
  const log = (seq: number, text: string): LogEntry => ({
    seq,
    at: "2026-09-17T00:00:00.000Z",
    prompt: `输入 ${seq}`,
    text,
  });

  beforeEach(() => {
    logsFail = false;
    logBefores = [];
    // 最新一页：4/3/2（下一页的 nextBefore = 2）；更早一页：1（到底）
    logsFor = (before) =>
      before === null
        ? { entries: [log(4, "第 4 幕的正文。"), log(3, "第 3 幕的正文。"), log(2, "第 2 幕的正文。")], nextBefore: 2 }
        : { entries: [log(1, "第 1 幕的正文。")], nextBefore: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/logs") {
          if (logsFail) return jsonResponse({ error: "boom" }, 500);
          const raw = url.searchParams.get("before");
          const before = raw === null ? null : Number(raw);
          logBefores.push(before);
          return jsonResponse(logsFor(before));
        }
        return jsonResponse({}, 404);
      }),
    );
    useGameStore.setState({
      screen: "game",
      worldId: "campus-summer-1",
      chapterNo: 2,
      // 本会话刚演完第 3、4 幕（内存）——磁盘日志里同序号的记录要按 seq 去重、别重复渲染
      history: [
        { kind: "act", n: "第 3 幕", t: "本会话第三幕。" },
        { kind: "act", n: "第 4 幕", t: "本会话第四幕。" },
      ],
      drawerOpen: false,
      diskHistory: { entries: [], nextBefore: null, loading: false, error: null, loadedOnce: false },
    });
  });

  it("打开抽屉首翻最近一页：磁盘记录渲染在内存幕之下、与内存幕按 seq 去重后只剩更早的；「加载更多」往更早翻", async () => {
    useGameStore.setState({ drawerOpen: true });
    render(<HistoryDrawer />);

    await waitFor(() => expect(useGameStore.getState().diskHistory.loadedOnce).toBe(true));
    // 内存两幕照旧（倒序，最新在上、testid 与原契约一致）
    const acts = screen.getAllByTestId("history-act");
    expect(acts.map((a) => a.textContent)).toEqual(["第 4 幕本会话第四幕。", "第 3 幕本会话第三幕。"]);
    // 磁盘第 4/3 幕与内存幕同 seq → 去重；只剩第 2 幕，且渲染在分界之下
    const disk = screen.getAllByTestId("history-disk-act");
    expect(disk).toHaveLength(1);
    expect(disk[0].textContent).toContain("第 2 幕的正文。");
    expect(screen.getByTestId("history-disk-divider").textContent).toContain("更早的回合");
    expect(logBefores).toEqual([null]); // 首翻就是「最新一页」

    const more = screen.getByTestId("history-load-more");
    expect(more.textContent).toBe("加载更多");
    await act(async () => {
      fireEvent.click(more);
    });
    await waitFor(() => expect(useGameStore.getState().diskHistory.nextBefore).toBeNull());
    expect(logBefores).toEqual([null, 2]); // 第二次按 nextBefore=2 往更早翻
    expect(screen.getAllByTestId("history-disk-act").map((d) => d.textContent)).toEqual([
      "第 2 幕 · 硬盘记录第 2 幕的正文。",
      "第 1 幕 · 硬盘记录第 1 幕的正文。",
    ]);
    expect(screen.queryByTestId("history-load-more")).toBeNull(); // 翻到底：收起
  });

  it("空态区分：世界已知但本局与磁盘都空 → 「硬盘上也没有」；没有世界线 → 不白打请求，给「本局还没有内容」", async () => {
    logsFor = () => ({ entries: [], nextBefore: null });
    useGameStore.setState({ drawerOpen: true, history: [] });
    render(<HistoryDrawer />);
    await waitFor(() => expect(useGameStore.getState().diskHistory.loadedOnce).toBe(true));
    expect(screen.getByTestId("history-empty-disk")).toBeTruthy();
    expect(screen.queryByTestId("history-empty-memory")).toBeNull();
    expect(screen.queryByTestId("history-load-more")).toBeNull(); // 没内容也没有下一页

    // 没有世界线：不请求 /api/logs（也不卡在加载态），直接说本局还没有内容
    cleanup();
    logBefores = [];
    useGameStore.setState({
      drawerOpen: true,
      worldId: null,
      history: [],
      diskHistory: { entries: [], nextBefore: null, loading: false, error: null, loadedOnce: false },
    });
    render(<HistoryDrawer />);
    expect(screen.getByTestId("history-empty-memory")).toBeTruthy();
    expect(screen.queryByTestId("history-disk-loading")).toBeNull();
    expect(logBefores).toEqual([]);
    expect(useGameStore.getState().diskHistory.loadedOnce).toBe(false);
  });

  it("磁盘读取失败：给错误行与「重试」，点重试成功后记录上屏、错误行消失", async () => {
    logsFail = true;
    useGameStore.setState({ drawerOpen: true, history: [] });
    render(<HistoryDrawer />);

    await waitFor(() => expect(screen.getByTestId("history-disk-error")).toBeTruthy());
    expect(screen.queryByTestId("history-empty-disk")).toBeNull(); // 有错就不谎称「硬盘上没有」
    const retry = screen.getByTestId("history-load-more");
    expect(retry.textContent).toBe("重试");

    logsFail = false;
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(screen.getAllByTestId("history-disk-act")).toHaveLength(3));
    expect(screen.queryByTestId("history-disk-error")).toBeNull();
  });
});
