// 世界线展示层的兜底规则：识别旧版 server 自动写进 state/worlds/index.json 的分叉备注。
// 纯逻辑、不依赖 React/DOM，可直接被 node import 做单测（与 lib/genealogy 同款纪律）。

/** 旧版 server 给分叉世界自动写的备注：「分叉自 <worldId> @ <nodeId>」/「…（精确快照 #N）」。
    v1.7.1 起 server 不再写它，但老索引里还在——显示层必须把它当作「没有备注」，否则会把裸 id 端给玩家。 */
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
