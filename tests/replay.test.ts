// 存档点重演的规划纯函数测试（v1.13，docs/adr/0023）：prevTurnSnapshotSeq（重演第 K 幕要退到哪一条）
// 与 canReplaySnapshot（剧情图屏入口的出现条件）。期望值来自 src/lib/replay.ts 的 JSDoc 契约。
import { describe, expect, it } from "vitest";
import type { WorldSnapshotMeta } from "../src/lib/acp";
import { canReplaySnapshot, prevTurnSnapshotSeq } from "../src/lib/replay";

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
