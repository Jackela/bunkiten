// 存档点重演的规划纯函数测试（v1.13，docs/adr/0023）：prevTurnSnapshotSeq（重演第 K 幕要退到哪一条）
// 与 canReplaySnapshot（剧情图屏入口的出现条件）。期望值来自 src/lib/replay.ts 的 JSDoc 契约。
// v1.14 起同一个文件也覆盖「可编辑重演」（replayPrompt 纯函数 + rerollTurn/rerollAt 的 promptOverride
// 走同一条 restore + 重同步 + 排队重发的时序；store 动作部分在系统边界打桩 fetch）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldSnapshotMeta } from "../src/lib/acp";
import { canReplaySnapshot, prevTurnSnapshotSeq, replayPrompt } from "../src/lib/replay";
import { disposeStore, useGameStore } from "../src/store/game";

/** 造一条 meta（只填判定用得上的字段；其余给稳定默认值） */
const meta = (seq: number, kind: "turn" | "backup" = "turn"): WorldSnapshotMeta => ({
  seq,
  at: "2026-01-01T00:00:00.000Z",
  kind,
  nodeId: null,
  chapterNo: 1,
  label: "",
});

describe("prevTurnSnapshotSeq / canReplaySnapshot：重演的退档目标与入口条件", () => {
  it("取 seq 之前最近的一条 turn：backup 不计（它不是一幕）", () => {
    const snaps = [meta(1), meta(2, "backup"), meta(3), meta(4, "backup")];
    expect(prevTurnSnapshotSeq(snaps, 3)).toBe(1);
    expect(prevTurnSnapshotSeq(snaps, 4)).toBe(3); // 隔着一串 backup 也要跳过它们
  });

  it("没有更早的 turn → null（第一幕无处可退）；函数只按序号比较，act 是否存在由调用方判", () => {
    expect(prevTurnSnapshotSeq([meta(1), meta(3)], 1)).toBeNull();
    expect(prevTurnSnapshotSeq([], 5)).toBeNull();
    // 序号不在列表里也照算「比它小的最近一条」：canReplaySnapshot 与解析内核都先判 act 存在再取目标
    expect(prevTurnSnapshotSeq([meta(2)], 99)).toBe(2);
  });

  it("顺序不敏感：乱序列表取最大值；重复 seq 容错", () => {
    expect(prevTurnSnapshotSeq([meta(7), meta(2), meta(5)], 8)).toBe(7);
    expect(prevTurnSnapshotSeq([meta(2), meta(2)], 3)).toBe(2);
  });

  it("canReplaySnapshot：该条是 turn、且之前还有 turn 才为真（backup 条目永不作为重演对象）", () => {
    const snaps = [meta(1), meta(2, "backup"), meta(3)];
    expect(canReplaySnapshot(snaps, 3)).toBe(true); // 3 是 turn、之前有 1——prompt 有无由点击时判（不在这里）
    expect(canReplaySnapshot(snaps, 1)).toBe(false); // 第一幕
    expect(canReplaySnapshot(snaps, 2)).toBe(false); // backup 不是一幕
    expect(canReplaySnapshot(snaps, 9)).toBe(false); // 不在列表里
  });
});

// —— v1.14 可编辑重演（promptOverride）：纯函数 + store 动作 ——

describe("replayPrompt 纯函数：覆盖输入优先，缺省回落到快照里那句", () => {
  it("给了覆盖就用它（trim 两端）；快照里那句不再重要", () => {
    expect(replayPrompt("盘上的输入", "改写的输入")).toBe("改写的输入");
    expect(replayPrompt("盘上的输入", "  改写的输入  ")).toBe("改写的输入");
  });

  it("没给覆盖（或全空白）→ 沿用快照条目里那句（v1.13 行为逐字不变）", () => {
    expect(replayPrompt("盘上的输入")).toBe("盘上的输入");
    expect(replayPrompt("盘上的输入", undefined)).toBe("盘上的输入");
    expect(replayPrompt("盘上的输入", "   \n  ")).toBe("盘上的输入");
  });

  it("两者都空 → 空串（由调用方给 no-input 降级提示）", () => {
    expect(replayPrompt("", undefined)).toBe("");
    expect(replayPrompt("", "  ")).toBe("");
  });
});

/** 最小 Response（只被 fetch 替身用到 ok/status/json 三样，与 tests/crafting.test.ts 同款） */
function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("可编辑重演（v1.14）：promptOverride 走同一条 restore + 重同步 + 排队重发", () => {
  /** 续档指令原文（与 parser.buildResumeCommand 同一条契约） */
  const RESUME = "继续世界：campus-summer-1。";
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  /** POST /api/worlds 收到的动作（按顺序） */
  let worldPosts: Record<string, unknown>[];
  /** 单条快照查询请求过的 seq（按顺序）——证明覆盖输入省掉了「哪一句」那一次回看 */
  let snapshotFetches: number[];
  /** 盘上那条快照记着的玩家输入 */
  let recordedPrompt: string;

  beforeEach(() => {
    prompts = [];
    worldPosts = [];
    snapshotFetches = [];
    recordedPrompt = "盘上的输入";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          worldPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ ok: true, backupSeq: 3 });
        }
        if (url.pathname === "/api/history") {
          const seq = url.searchParams.get("seq");
          // 升序两条 turn：目标幕 = 最新 5，回退点 = 2（列表刻意不带 prompt，单条才带）
          if (seq === null) return jsonResponse({ worldId: "campus-summer-1", snapshots: [meta(2), meta(5)] });
          snapshotFetches.push(Number(seq));
          return jsonResponse({
            worldId: "campus-summer-1",
            snapshots: [
              { ...meta(Number(seq)), files: { state: null, summary: null, tree: null }, prompt: recordedPrompt },
            ],
          });
        }
        return jsonResponse({}, 404);
      }),
    );
    useGameStore.setState({
      worldId: "campus-summer-1",
      screen: "game",
      engineBusy: false,
      pendingTreeMessage: null,
      history: [],
      status: "就绪",
      currentTurn: null,
      pendingResync: null,
      resyncing: false,
      pendingRerollPrompt: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    disposeStore();
  });

  it("rerollTurn('改写的输入')：目标幕 = 最近一幕（不回看取输入），重同步收尾后重发改写的那句", async () => {
    await useGameStore.getState().rerollTurn("  改写的输入  ");
    expect(worldPosts).toEqual([{ action: "restore", worldId: "campus-summer-1", seq: 2 }]);
    expect(snapshotFetches, "有覆盖输入就不必为「哪一句」发单条查询").toEqual([]);
    expect(prompts.at(-1)).toBe(RESUME);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("改写的输入");

    // 重同步回合（main:false 的内部回合）收尾 → 排队的那句自动补发
    useGameStore.getState().handleEvent({ type: "turn_start" });
    useGameStore.getState().handleEvent({ type: "turn_end", main: false, seq: null });
    await vi.waitUntil(() => prompts.at(-1) === "改写的输入");
    expect(useGameStore.getState().pendingRerollPrompt).toBeNull();
  });

  it("缺省不带覆盖：输入仍取自快照条目（行为与 v1.13 逐字一致）", async () => {
    await useGameStore.getState().rerollTurn();
    expect(snapshotFetches).toEqual([5]); // 为「哪一句」回看一条单条查询
    expect(worldPosts).toEqual([{ action: "restore", worldId: "campus-summer-1", seq: 2 }]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("盘上的输入");
  });

  it("全空白覆盖 = 没给（仍取快照里那句）", async () => {
    await useGameStore.getState().rerollTurn("   ");
    expect(snapshotFetches).toEqual([5]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("盘上的输入");
  });

  it("rerollAt(seq, override)：目标幕由参数给定，覆盖输入照发（也不为「哪一句」回看）", async () => {
    await useGameStore.getState().rerollAt(5, "换一条路");
    expect(worldPosts).toEqual([{ action: "restore", worldId: "campus-summer-1", seq: 2 }]);
    expect(snapshotFetches).toEqual([]);
    expect(useGameStore.getState().pendingRerollPrompt).toBe("换一条路");
  });
});
