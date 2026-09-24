// 世界线家谱布局纯函数（v1.7）：把 index.json 的 forkedFrom 血缘画成森林——
// 节点 = 世界线、边 = 子→父，多根并列。不依赖 React/DOM，可直接被 node import 做单测；
// 输出确定（同输入必得同输出），坐标全整数。
//
// 语义三件套（与 treeLayout 同款纪律）：
//   · 孤儿：forkedFrom 指向不存在的世界（父线被删）→ 按根处理，节点标 missingParent: true
//     （UI 显示「⌫ 父线已删」），不产生边；
//   · 抗环：fork 环（A→B→A，含自指）先剥「父已定深」的节点，剥不动的环成员按输入序
//     逐个当根再继续剥——有限步内必然收敛，绝不无限递归；
//   · 分层：深度 = 沿 forkedFrom 到根的步数（根 0，子 = 父 + 1）；同层横向排布，
//     层内按 lastPlayed 降序（相同取 worldId 升序），行内从左到右紧排（森林宽度 =
//     最宽一行的自然宽度，不为缺失的父线留空位）。
import type { WorldEntry } from "./acp";

/** 家谱节点：保留原始 WorldEntry，附深度（层号）、左上角整数坐标与孤儿标记 */
export interface GenealogyNode {
  worldId: string;
  entry: WorldEntry;
  /** 深度：沿 forkedFrom 到根的步数（根 = 0；孤儿按根处理；环成员按断环后的结果） */
  depth: number;
  /** 节点矩形左上角 x（画布坐标，含内边距） */
  x: number;
  /** 节点矩形左上角 y（画布坐标，含内边距） */
  y: number;
  /** forkedFrom 指向不在清单里的世界（父线被删）→ true，UI 显示「⌫ 父线已删」 */
  missingParent: boolean;
}

/** 家谱边：from = 父 worldId → to = 子 worldId，d 为父底边中点 → 子顶边中点的圆角拐弯 path */
export interface GenealogyEdge {
  from: string;
  to: string;
  d: string;
  /** 断环边：fork 环被剥洋葱打断后出现「子在上层、父在下层」的上行边，渲染为虚线（数据语义正确，纯视觉区分） */
  dashed?: boolean;
}

/** 整片家谱森林：节点（输入序）、边与画布尺寸（含内边距，可直接喂 viewBox） */
export interface GenealogyLayout {
  nodes: GenealogyNode[];
  edges: GenealogyEdge[];
  width: number;
  height: number;
}

/** 布局几何参数（均可选，缺省见 DEFAULTS） */
export interface GenealogyOptions {
  /** 单个节点宽度 */
  nodeW?: number;
  /** 单个节点高度 */
  nodeH?: number;
  /** 相邻两层的垂直间距（也是边拐弯的走廊宽度） */
  rowGap?: number;
  /** 同层相邻节点的水平间距 */
  colGap?: number;
}

/** 缺省几何：与 WorldsScreen 家谱视图的节点绘制尺寸保持一致 */
const DEFAULT_NODE_W = 210;
const DEFAULT_NODE_H = 64;
const DEFAULT_ROW_GAP = 56;
const DEFAULT_COL_GAP = 28;
/** 画布四周内边距（给描边与拐弯留白） */
const PAD = 24;
/** 边拐弯的圆角半径（不超过半个层间距/半个水平错位，保证路径不越层） */
const BEND_R = 12;

/**
 * 计算世界线家谱森林的二维布局（深度分行 + 层内按 lastPlayed 降序横排）。
 *
 * 归一化：worldId 去重（保留首次出现）；forkedFrom 指向自身或不在清单里的世界不产生边
 * （后者记 missingParent，前者属环、按抗环规则处理）。深度用「剥洋葱」求：根（无有效父）
 * 先定 0，然后反复把「父已定深」的节点定为父 + 1 直到收敛；仍无深度的就是环成员及其
 * 下游——按输入序逐个当根（深度 0）再剥，环被就地剪断、必然终止。
 * 坐标全整数：y = 内边距 + 层号 × (nodeH + rowGap)，x = 内边距 + 层内位次 × (nodeW + colGap)；
 * 画布宽 = 最宽一行，高 = 层数（紧凑：不为缺失的父线/空层留位）。输出顺序稳定（节点随输入序）。
 *
 * @param {WorldEntry[]} worlds 世界线清单（fetchWorlds 全量；空数组返回空布局）
 * @param {GenealogyOptions} [opts] 几何参数覆盖
 * @returns {GenealogyLayout} 节点坐标、圆角拐弯边路径与画布尺寸
 */
export function layoutGenealogy(worlds: WorldEntry[], opts: GenealogyOptions = {}): GenealogyLayout {
  const nodeW = opts.nodeW ?? DEFAULT_NODE_W;
  const nodeH = opts.nodeH ?? DEFAULT_NODE_H;
  const rowGap = opts.rowGap ?? DEFAULT_ROW_GAP;
  const colGap = opts.colGap ?? DEFAULT_COL_GAP;

  // —— 归一化：去重 worldId（保留首次出现），按输入顺序记录 ——
  const idSet = new Set<string>();
  const entryById = new Map<string, WorldEntry>();
  const order: string[] = [];
  for (const w of worlds) {
    if (idSet.has(w.worldId)) continue;
    idSet.add(w.worldId);
    entryById.set(w.worldId, w);
    order.push(w.worldId);
  }
  if (order.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  // —— 有效父：forkedFrom 指向清单内且不是自己；指向清单外 = 孤儿（missingParent）——
  const parentId = new Map<string, string>();
  const missing = new Set<string>();
  for (const id of order) {
    const p = entryById.get(id)!.forkedFrom?.worldId ?? "";
    const valid = p !== "" && p !== id && idSet.has(p);
    if (valid) parentId.set(id, p);
    else if (p !== "" && p !== id) missing.add(id);
    // p === id（自指 fork）不记孤儿也不记边：它是一元环，交给下面的抗环规则
  }

  // —— 深度（剥洋葱）：根先定 0，反复定「父已定深」者；剥不动的环按输入序逐个当根 ——
  const depth = new Map<string, number>();
  const peel = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of order) {
        if (depth.has(id)) continue;
        const pd = depth.get(parentId.get(id)!);
        if (pd !== undefined) {
          depth.set(id, pd + 1);
          changed = true;
        }
      }
    }
  };
  for (const id of order) {
    if (!parentId.has(id)) depth.set(id, 0); // 根与孤儿都是 0
  }
  peel();
  for (const id of order) {
    if (depth.has(id)) continue;
    depth.set(id, 0); // 环成员：按输入序当根，再剥一轮（环被剪断，必然收敛）
    peel();
  }

  // —— 分层：层内按 lastPlayed 降序（相同取 worldId 升序），从左到右紧排 ——
  const byDepth = new Map<number, string[]>();
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    const arr = byDepth.get(d);
    if (arr) arr.push(id);
    else byDepth.set(d, [id]);
  }
  const lastOf = (id: string): number => {
    const t = entryById.get(id)!.lastPlayed;
    return Number.isFinite(t) ? t : 0;
  };
  const rows = [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, ids]) => ({
      depth: d,
      ids: ids.sort((a, b) => lastOf(b) - lastOf(a) || (a < b ? -1 : 1)),
    }));

  let maxRow = 1;
  for (const r of rows) if (r.ids.length > maxRow) maxRow = r.ids.length;
  const width = PAD * 2 + maxRow * nodeW + (maxRow - 1) * colGap;
  const height = PAD * 2 + rows.length * nodeH + (rows.length - 1) * rowGap;

  // —— 落坐标（全整数）：y 由层号决定，x 由层内位次决定 ——
  const xyById = new Map<string, { x: number; y: number }>();
  rows.forEach((row, ri) => {
    const y = PAD + ri * (nodeH + rowGap);
    row.ids.forEach((id, ci) => xyById.set(id, { x: PAD + ci * (nodeW + colGap), y }));
  });

  const nodes: GenealogyNode[] = order.map((id) => ({
    worldId: id,
    entry: entryById.get(id)!,
    depth: depth.get(id) ?? 0,
    x: xyById.get(id)!.x,
    y: xyById.get(id)!.y,
    missingParent: missing.has(id),
  }));

  // —— 边：父底边中点 → 子顶边中点，层间走廊里圆角拐弯（同列直落，不画贝塞尔）——
  const edges: GenealogyEdge[] = [];
  for (const id of order) {
    const p = parentId.get(id);
    if (p === undefined) continue;
    const a = xyById.get(p)!;
    const b = xyById.get(id)!;
    const pcx = a.x + nodeW / 2;
    const pb = a.y + nodeH;
    const ccx = b.x + nodeW / 2;
    const ct = b.y;
    const mid = pb + Math.floor(rowGap / 2);
    let d: string;
    if (pcx === ccx) {
      d = `M ${pcx} ${pb} L ${ccx} ${ct}`;
    } else {
      const dir = ccx > pcx ? 1 : -1;
      const r = Math.min(BEND_R, Math.floor(Math.abs(ccx - pcx) / 2));
      d =
        `M ${pcx} ${pb} L ${pcx} ${mid - r} Q ${pcx} ${mid} ${pcx + dir * r} ${mid} ` +
        `L ${ccx - dir * r} ${mid} Q ${ccx} ${mid} ${ccx} ${mid + r} L ${ccx} ${ct}`;
    }
    edges.push({ from: p, to: id, d, dashed: (depth.get(id) ?? 0) <= (depth.get(p) ?? 0) });
  }

  return { nodes, edges, width, height };
}

/**
 * 家谱键盘步进（方向键在节点间走的确定性规则，WorldsScreen 家谱视图用）：
 * ←/→ = 同层按 x 左右移动一位（出层返回 null）；↑/↓ = 跨层取**水平中心最近**的节点
 * （相同距离取 x 较小者；目标层没有节点返回 null）。孤儿/环节点没有特殊分支——
 * 它们本来就被排进了普通层，规则对整片森林一致。
 *
 * @param {GenealogyLayout} layout 布局结果（含坐标与深度）
 * @param {string} worldId 当前节点
 * @param {"up"|"down"|"left"|"right"} dir 步进方向
 * @returns {string | null} 目标节点 worldId；走出森林/找不到当前节点返回 null
 */
export function genealogyStep(
  layout: GenealogyLayout,
  worldId: string,
  dir: "up" | "down" | "left" | "right",
): string | null {
  const cur = layout.nodes.find((n) => n.worldId === worldId);
  if (!cur) return null;
  if (dir === "left" || dir === "right") {
    const row = layout.nodes
      .filter((n) => n.depth === cur.depth)
      .sort((a, b) => a.x - b.x || (a.worldId < b.worldId ? -1 : 1));
    const i = row.findIndex((n) => n.worldId === worldId);
    return row[i + (dir === "left" ? -1 : 1)]?.worldId ?? null;
  }
  const targetDepth = cur.depth + (dir === "up" ? -1 : 1);
  const next = layout.nodes
    .filter((n) => n.depth === targetDepth)
    .sort((a, b) => Math.abs(a.x - cur.x) - Math.abs(b.x - cur.x) || a.x - b.x);
  return next[0]?.worldId ?? null;
}
