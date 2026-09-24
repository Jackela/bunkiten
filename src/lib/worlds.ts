// 世界线展示层的兜底规则与展示名/分叉说明（v1.13 从 WorldsScreen 收编相对时间、显示名、分叉说明）。
// 纯逻辑、不依赖 React/DOM，可直接被 node import 做单测（与 lib/genealogy 同款纪律）。
import type { WorldEntry } from "./acp";

/** 旧版 server 给分叉世界自动写的备注：「分叉自 <worldId> @ <nodeId>」/「…（精确快照 #N）」。
    v1.8 起 server 不再写它，但老索引里还在——显示层必须把它当作「没有备注」，否则会把裸 id 端给玩家。 */
export const LEGACY_FORK_NOTE_RE = /^分叉自\s+\S+\s*@\s*\S+(（精确快照 #\d+）)?$/;

/**
 * 这条备注是不是旧版 server 自动写的裸 id 串（前后空白容忍）。
 * 分叉关系另有 `WorldEntry.forkedFrom`（与服务端的 fork.md）完整记录，显示层不需要靠这句话还原血缘。
 * @param {string | null | undefined} note 索引里的备注
 * @returns {boolean} true = 旧版分叉备注，按「没有备注」处理
 */
export function isLegacyForkNote(note: string | null | undefined): boolean {
  return !!note && LEGACY_FORK_NOTE_RE.test(note.trim());
}

/** 「更早」阈值（ms）：最近游玩超过 30 天不再报天数 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 相对时间中文文案（世界线行的「最近游玩」；时钟回拨/时间戳缺失都算「更早」兜底）。
 * @param {number} ms 最近游玩时间（ms）
 * @param {number} [now] 参照时刻（默认 Date.now()，测试可注入）
 * @returns {string} 「刚刚 / N 分钟前 / N 小时前 / N 天前 / 更早」
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "更早";
  const diff = now - ms;
  if (diff <= 0) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  if (diff < STALE_MS) return `${Math.floor(hours / 24)} 天前`;
  return "更早";
}

/**
 * 世界显示名（**显示层唯一入口**，v1.13 把此前散在 store 与 WorldsScreen 的回退链收敛到这里）。
 *
 * 回退链（自上而下，命中即返回）：
 *   1) `label`——玩家起的显示名（≤60 字）；
 *   2) `note`——备注（≤200 字）；**旧版 server 自动写的分叉备注不算备注**（见 {@link isLegacyForkNote}），
 *      跳过它让位给剧本名——血缘由 `forkedFrom`/家谱连线交代，不靠这句话；
 *   3) `presetTitle`——剧本标题；
 *   4) `"未命名世界线"`。
 *
 * **裸 worldId 永远不上玩家的屏**（它只活在目录名、导出文件名与日志里）。
 * {@link resolveWorldLabel} 是它面向 store 已解析串（label → note → ""）的薄封装：两条入口共用这一条链，
 * 不许各写一份（本仓最忌的两份规则）。
 * @param {Pick<WorldEntry, "label" | "note"> | { label?: string | null; note?: string | null }} w 世界线条目（只读 label/note 两栏）
 * @param {string} [presetTitle] 剧本标题（没显示名也没备注时的兜底）
 * @returns {string} 行主行/顶栏用的显示名
 */
export function worldDisplayName(w: { label?: string | null; note?: string | null }, presetTitle = ""): string {
  const note = isLegacyForkNote(w.note) ? "" : w.note;
  return w.label?.trim() || note?.trim() || presetTitle.trim() || "未命名世界线";
}

/**
 * 把 store 的 worldLabel（已由 store 合并成 label → note → ""）解析成可上屏的显示名。
 * 非空、不是裸 worldId、也不是旧版分叉备注时，返回**去空白**的显示名；否则返回 fallback
 * （「有名字才画」的顶栏/制作屏传空串，剧情图屏传「本世界线」）。
 *
 * 与 {@link worldDisplayName} 共用同一条回退链：这里只是再挡两类「不是名字」的值
 * （worldId 本身、旧版分叉备注），所以 store 的链与 WorldsScreen 的链不会各漂各的。
 * @param {string | null | undefined} worldLabel store 的世界显示名（label → note → ""，见 store/slices/world.ts）
 * @param {string | null | undefined} worldId 当前世界 id（只用来挡「显示名 == 裸 id」这一类旧状态/手改数据）
 * @param {string} [fallback] 没有可用显示名时的兜底文案
 * @returns {string} 显示名或 fallback
 */
export function resolveWorldLabel(
  worldLabel: string | null | undefined,
  worldId: string | null | undefined,
  fallback = "",
): string {
  const name = worldDisplayName({ label: worldLabel, note: "" }, "");
  return name === "未命名世界线" || name === worldId || isLegacyForkNote(name) ? fallback : name;
}

/**
 * 分叉说明（纯函数，供单测）：父线还在清单里 → 「自《父线显示名》延伸」；父线已删（不在清单里）
 * → 「自已删除的父线延伸」。两侧都不露裸 worldId/nodeId——玩家看的是血缘的名字，不是目录名。
 * @param {{worldId: string}} fork 分叉来源（WorldEntry.forkedFrom）
 * @param {WorldEntry[]} worlds 当前清单（把父线 id 还原成显示名的唯一来源）
 * @param {string} [presetTitle] 剧本标题兜底（父线自身也没 label/note 时用）
 * @returns {string} 徽标与无障碍文案里的分叉说明
 */
export function forkPhrase(fork: { worldId: string }, worlds: WorldEntry[], presetTitle = ""): string {
  const parent = worlds.find((w) => w.worldId === fork.worldId);
  return parent ? `自《${worldDisplayName(parent, presetTitle)}》延伸` : "自已删除的父线延伸";
}
