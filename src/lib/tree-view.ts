// 剧情图屏的展示层纯函数（v1.13 从 StoryTreeScreen 收编）：章号/章标签、快照 → 幕号、节点 → 最早快照、
// 快照对比基线。纯逻辑、不 import React/DOM，可直测（与 lib/treeLayout 同款纪律）。
//
// ⚠️ 本文件的 prevSnapshotSeq 与 lib/replay.ts 的 prevTurnSnapshotSeq **不是同一个函数，别「帮忙」合并**：
//   · prevSnapshotSeq（本文件）——**快照对比的基线**：seq 更小的最近一条，**kind 不限**（backup 也算）。
//     回退前的自动备份恰恰是「上一份不同的内容」，排除它会让回退后的第一次对比找不到基线。
//   · prevTurnSnapshotSeq（lib/replay.ts）——**存档点重演的回退点**：seq 之前最近的 **turn** 条目，
//     因为重演要退到「该幕开演前」的状态；backup 不是一幕，退到它上下文会接错。
//   两者名字都叫「prev…Seq」，但一个是「上一份不同的内容」、一个是「上一幕开演前」——合并必错一边。
import type { WorldSnapshotMeta } from "./acp";
import type { TreeChapter } from "./parser";

/**
 * 节点上挂的快照引用：最早匹配快照的序号与「第几轮」。turn 仍由 {@link snapshotTurnNo} 算出（纯函数，
 * 单测在用），屏上只印「第 N 幕」（口径统一：幕号 = 快照序号，与历史抽屉的「已回溯到第 N 幕」同源）。
 */
export interface SnapshotRef {
  seq: number;
  turn: number;
  /** 玩家给这个存档点起的名字（v1.12；没起名是空串） */
  label: string;
}

/** 节点 id 前缀 `N-M` 里的章号 */
const NODE_ID_PREFIX_RE = /^(\d+)-/;

/**
 * 章节的章号（纯函数，供单测）：**节点 id 的 `N-M` 前缀**是唯一可靠来源——`parseStoryTree` 的
 * TreeChapter 不保留 `## 第 N 章` 的数字（标题多是「雨夜来客」这类真标题），而节点 id 与屏幕上
 * 印的节点号同源。无节点时退回进度指针的数字、再退回标题里的数字，最后退回章节在文件里的次序。
 * @param {TreeChapter} chapter 章节
 * @param {number} index 章节在树文件里的下标（0 起）
 * @returns {number} 章号（切换器的 testid 与「第 N 章」文案都用它）
 */
export function chapterNoOf(chapter: TreeChapter, index: number): number {
  for (const n of chapter.nodes) {
    const m = NODE_ID_PREFIX_RE.exec(n.id);
    if (m) return Number(m[1]);
  }
  const fromCurrent = NODE_ID_PREFIX_RE.exec(chapter.current ?? "");
  if (fromCurrent) return Number(fromCurrent[1]);
  const fromTitle = /^第\s*(\d+)\s*章/.exec(chapter.title.trim());
  return fromTitle ? Number(fromTitle[1]) : index + 1;
}

/**
 * 章节的短标签（纯函数，供单测）：`第 N 章`，有真标题就补在后面；
 * 标题本身就是解析器兜底出来的 `第 N 章` 时不重复（否则会印成「第 2 章 · 第 2 章」）。
 * @param {TreeChapter} chapter 章节
 * @param {number} index 章节下标（透传给 {@link chapterNoOf}）
 * @returns {string} 切换器药丸上的文案
 */
export function chapterLabel(chapter: TreeChapter, index: number): string {
  const no = chapterNoOf(chapter, index);
  const title = chapter.title.trim();
  return title && title !== `第 ${no} 章` ? `第 ${no} 章 · ${title}` : `第 ${no} 章`;
}

/**
 * 快照 → 「第 N 轮」：该快照之前（含自己）累积了几条正戏回合快照。
 * backup（回退前的自动备份）不算新的一轮，于是它落在「回退时所在的那一轮」上。
 * @param {WorldSnapshotMeta[]} snapshots 快照索引（升序）
 * @param {number} seq 目标快照序号
 * @returns {number} 轮次（没有正戏快照时为 0）
 */
export function snapshotTurnNo(snapshots: WorldSnapshotMeta[], seq: number): number {
  return snapshots.filter((s) => s.kind === "turn" && s.seq <= seq).length;
}

/**
 * 节点 id → **最早**匹配的快照（seq 最小）。与 server 的 fork 语义同源：不带 seq 时它也是按最早匹配取，
 * 所以「在此分叉」带上这里的 seq 与 server 自己找的那条必然是同一条。
 * @param {WorldSnapshotMeta[]} snapshots 快照索引（顺序不敏感，内部按 seq 升序）
 * @returns {Map<string, SnapshotRef>} 只有 nodeId 非空的快照才入表；同一 nodeId 保留 seq 最小的
 */
export function earliestSnapshotByNode(snapshots: WorldSnapshotMeta[]): Map<string, SnapshotRef> {
  const out = new Map<string, SnapshotRef>();
  for (const snap of [...snapshots].sort((a, b) => a.seq - b.seq)) {
    const id = snap.nodeId;
    if (!id || out.has(id)) continue;
    out.set(id, { seq: snap.seq, turn: snapshotTurnNo(snapshots, snap.seq), label: snap.label ?? "" });
  }
  return out;
}

/**
 * 快照对比的基线（v1.7）：同世界 history 里 **seq 更小的最近一条**，kind 不限——backup
 * （回退前的自动备份）也是合法基线：它恰恰是「上一份不同的内容」，排除它会让回退后的
 * 第一个对比找不到基线。全局最小的快照没有基线，返回 null（UI 不显示对比按钮）。
 *
 * ⚠️ 与 lib/replay.ts 的 `prevTurnSnapshotSeq` 语义不同（那条只认 turn、是重演的回退点）——
 * 见本文件头，**别合并**。
 * @param {WorldSnapshotMeta[]} snapshots 快照索引（顺序不敏感）
 * @param {number} seq 目标快照序号
 * @returns {number | null} 基线快照的 seq；没有更早的快照时 null
 */
export function prevSnapshotSeq(snapshots: WorldSnapshotMeta[], seq: number): number | null {
  let prev: number | null = null;
  for (const s of snapshots) {
    if (s.seq < seq && (prev === null || s.seq > prev)) prev = s.seq;
  }
  return prev;
}
