// 存档点重演的「退到哪」纯函数（v1.13，docs/adr/0023）：重演第 K 幕 = 退到 K **之前**最近的一条 turn
// 快照（= K 那一幕开演前的结束态）、再重发 K 的输入；退到 K 自己会把同一幕演两遍、上下文还接错。
// backup 条目是回退前的自动备份、不是一幕；续玩条目（继续世界：）是正戏回合——两者都按 kind 判定。
// store 的重演解析内核与剧情图屏的按钮判据共用这一份规则，不写第二份（本仓最忌的两份规则）。
import type { WorldSnapshotMeta } from "./acp";

/**
 * 取 `seq` 之前最近的一条 turn 快照序号（纯函数）。
 * @param snapshots 快照列表（/api/history 的升序 meta 列表；函数不依赖顺序）
 * @param seq 重演对象的快照序号（第 K 幕）
 * @returns 目标（回退点）序号；没有更早的 turn 快照时 null（第一幕无处可退）
 */
export function prevTurnSnapshotSeq(snapshots: WorldSnapshotMeta[], seq: number): number | null {
  let prev: number | null = null;
  for (const s of snapshots) {
    if (s.kind !== "turn" || s.seq >= seq) continue;
    if (prev === null || s.seq > prev) prev = s.seq;
  }
  return prev;
}

/**
 * 重演入口的出现条件（纯函数）：该 seq 的条目本身是 turn 条目、且它之前还有 turn 条目。
 * prompt 是否存在不在这里判——列表形状刻意不带 prompt（单条才带，见 docs/adr/0023），
 * 点击时由 store 的解析内核取数、缺输入给一级降级提示（旧档与续玩同路）。
 * @param snapshots 快照列表（/api/history 的 meta 列表）
 * @param seq 该条快照的序号
 * @returns {boolean} 是否显示「回到这一幕并重演」
 */
export function canReplaySnapshot(snapshots: WorldSnapshotMeta[], seq: number): boolean {
  const act = snapshots.find((s) => s.seq === seq);
  return act?.kind === "turn" && prevTurnSnapshotSeq(snapshots, seq) !== null;
}
