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
import type { TreeChapter, TreeNodeStatus } from "./parser";

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
 * 章节切换器的一项：解析出的章号 + 标签 + 章节本体 + **稳定键**（一次算好，默认章、选中章与画布 key 共用）。
 */
export interface ChapterItem {
  no: number;
  label: string;
  chapter: TreeChapter;
  /**
   * 章节键（切换器的 key/testid、选中态、画布 key 都用它）：
   * **章号在本章列表里唯一时就是章号本身**（`"2"` → testid `tree-chapter-2`）；
   * 章号重号（只有标题、没有节点的章会退化成 `index + 1`，撞上下一个真实章号）时退回 `` `${no}-${i}` ``（i = 数组下标），
   * 保证两颗药丸的 testid 仍逐项唯一、都点得开。用章号单独当键会让第二个同号章永远点不开，用下标单独当键又会在
   * 「编辑改动了章序」时错位——这正是要消掉的债（见 docs/ARCHITECTURE.md 的 data-testid 契约）。
   */
  key: string;
}

/**
 * 把解析出的章节列表算成切换器条目（章号 + 标签 + 稳定键，纯函数）。
 * 键规则见 {@link ChapterItem.key}：**章号唯一 → 章号当键**；**重号 → `` `${no}-${下标}` ``**。
 * @param {TreeChapter[]} chapters 解析出的章节列表
 * @returns {ChapterItem[]} 与入参同序的条目
 */
export function chapterItems(chapters: TreeChapter[]): ChapterItem[] {
  const base = chapters.map((ch, i) => {
    const no = chapterNoOf(ch, i);
    return { no, label: chapterLabel(ch, i), chapter: ch };
  });
  const count = new Map<number, number>();
  for (const it of base) count.set(it.no, (count.get(it.no) ?? 0) + 1);
  return base.map((it, i) => ({ ...it, key: count.get(it.no) === 1 ? String(it.no) : `${it.no}-${i}` }));
}

/**
 * 节点状态 → 稳定的 ASCII slug（列表分组的 testid 用）。中文状态是**展示用词**，进 testid 会把契约绑在文案上，
 * 哪天用词变了 testid 会静默变名；slug 与用词解耦（`tree-list-group-visited|-reachable|-pruned|-grafted`）。
 */
export const STATUS_SLUG: Record<TreeNodeStatus, string> = {
  已走过: "visited",
  可达: "reachable",
  已剪枝: "pruned",
  嫁接: "grafted",
};

/** 归档行里的 `第 N 章` 章号（与 {@link chapterNoOf} 同一族正则；不锚定行首——归档行形如 `- 第 1 章：…`） */
const ARCHIVE_CHAPTER_RE = /第\s*(\d+)\s*章/;

/**
 * 归档药丸的稳定键：取该行 `第 N 章` 的数字当键（`第 1 章…` → `"1"` → testid `tree-archive-1`）。
 * 抽不出章号时退回 `` `line-${index}` ``（index = 数组下标；归档行本就是逐项唯一的一行，无号时下标是唯一可用且不撞的兜底，
 * 比裸下标好——有号的行的键跟内容走，编辑加了无号行也不会让它整个错位）。
 * @param {string} line 归档区原文行
 * @param {number} index 该行在归档数组里的下标（0 起；仅作兜底键）
 * @returns {string} 归档药丸的 testid 键
 */
export function archiveKey(line: string, index: number): string {
  const m = ARCHIVE_CHAPTER_RE.exec(line);
  return m ? m[1]! : `line-${index}`;
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
