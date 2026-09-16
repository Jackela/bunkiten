// 剧情树布局纯函数：把 TreeChapter 的节点/出边算成二维坐标 + SVG 路径。
// 不依赖 React/DOM，可直接被 node import 做单测；输出确定（同输入必得同输出）。
import type { TreeChapter, TreeNode } from "./parser";

/** 布局后的单个节点：保留原始 TreeNode，附层号与左上角坐标 */
export interface LayoutNode {
  id: string;
  node: TreeNode;
  /** 最长路径分层：无前驱为 0，否则 = max(前驱层号) + 1 */
  layer: number;
  /** 节点矩形左上角 x（画布坐标，含内边距） */
  x: number;
  /** 节点矩形左上角 y（画布坐标，含内边距） */
  y: number;
}

/** 布局后的单条边：from/to 为节点 id，d 为可直接喂给 <path> 的三次贝塞尔路径 */
export interface LayoutEdge {
  from: string;
  to: string;
  d: string;
}

/** 整章布局结果：节点、边与画布尺寸（含内边距） */
export interface TreeLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

/** 布局几何参数（均可选，缺省见 DEFAULTS） */
export interface LayoutOptions {
  /** 单个节点宽度 */
  nodeW?: number;
  /** 单个节点高度 */
  nodeH?: number;
  /** 相邻两列的水平间距 */
  colGap?: number;
  /** 同层相邻节点的垂直间距 */
  rowGap?: number;
}

/** 缺省几何：与 StoryTreeScreen 的节点绘制尺寸保持一致 */
const DEFAULT_NODE_W = 210;
const DEFAULT_NODE_H = 74;
const DEFAULT_COL_GAP = 80;
const DEFAULT_ROW_GAP = 24;
/** 画布四周内边距（给标题/描边/箭头留白） */
const PAD = 36;
/** 边的最小水平控制点偏移，避免背向边被压成直线 */
const MIN_BEND = 28;

/** 保留一位小数：抹平浮点噪声，让 SVG 输出稳定（便于快照/比对） */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 计算单章剧情树的二维布局（分列最长路径分层 + 同层垂直居中堆叠）。
 *
 * 分层：对「源节点 → 出边目标」建图，用最长路径分层（无前驱为 0，其余 = max(前驱层号) + 1）。
 * 抗环：先做 Kahn 拓扑排序，环内节点按原顺序追加到末尾，仅采纳「前驱排在前面」的边参与分层，
 * 从而忽略回边、绝不无限循环。同层节点按章节内出现顺序纵向堆叠，整列相对最高列垂直居中。
 * 画布尺寸含内边距；边为目标不在本章的出边一律跳过；输出顺序稳定（跟随章节节点/出边顺序）。
 *
 * @param {TreeChapter | null} chapter 待布局的章节（null 或空节点返回空布局）
 * @param {LayoutOptions} [opts] 几何参数覆盖
 * @returns {TreeLayout} 节点坐标、贝塞尔边路径与画布尺寸
 */
export function layoutTree(chapter: TreeChapter | null, opts: LayoutOptions = {}): TreeLayout {
  const nodeW = opts.nodeW ?? DEFAULT_NODE_W;
  const nodeH = opts.nodeH ?? DEFAULT_NODE_H;
  const colGap = opts.colGap ?? DEFAULT_COL_GAP;
  const rowGap = opts.rowGap ?? DEFAULT_ROW_GAP;

  if (!chapter || chapter.nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  // —— 归一化：去重节点 id（保留首次出现的节点对象），按章节顺序记录 id ——
  const idSet = new Set<string>();
  const nodeById = new Map<string, TreeNode>();
  const order: string[] = [];
  for (const n of chapter.nodes) {
    if (idSet.has(n.id)) continue;
    idSet.add(n.id);
    nodeById.set(n.id, n);
    order.push(n.id);
  }

  // —— 出边归一化：目标不在本章的边直接丢弃；(from,to) 去重，稳定按章节顺序 ——
  const rawEdges: { from: string; to: string }[] = [];
  const seenEdge = new Set<string>();
  for (const n of chapter.nodes) {
    for (const e of n.edges) {
      if (!idSet.has(e.target)) continue;
      const key = `${n.id}|${e.target}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      rawEdges.push({ from: n.id, to: e.target });
    }
  }

  // —— 邻接表 + 入度（供 Kahn 拓扑排序；入度含重边去重后的计数）——
  const adj = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of order) {
    adj.set(id, []);
    preds.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of rawEdges) {
    adj.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  // —— Kahn：入度 0 入队。环内节点（未被消解）按原顺序补到末尾，避免死循环 ——
  const queue = order.filter((id) => (indeg.get(id) ?? 0) === 0);
  const topo: string[] = [];
  const work = new Map(indeg);
  while (queue.length > 0) {
    const id = queue.shift()!;
    topo.push(id);
    for (const to of adj.get(id)!) {
      const d = (work.get(to) ?? 0) - 1;
      work.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  const placed = new Set(topo);
  for (const id of order) {
    if (!placed.has(id)) {
      placed.add(id);
      topo.push(id);
    }
  }

  // —— 最长路径分层：仅采纳「前驱在拓扑序中靠前」的边（回边被忽略，故分层有界）——
  const pos = new Map<string, number>();
  topo.forEach((id, i) => pos.set(id, i));
  const layer = new Map<string, number>();
  for (const id of topo) layer.set(id, 0);
  for (const id of topo) {
    const p = pos.get(id) ?? 0;
    let best = 0;
    for (const u of preds.get(id)!) {
      const pu = pos.get(u);
      if (pu !== undefined && pu < p) best = Math.max(best, (layer.get(u) ?? 0) + 1);
    }
    layer.set(id, best);
  }

  // —— 按层归组（层内保持章节顺序），统计层数与最高列行数 ——
  const byLayer = new Map<number, string[]>();
  for (const id of order) {
    const L = layer.get(id) ?? 0;
    const arr = byLayer.get(L);
    if (arr) arr.push(id);
    else byLayer.set(L, [id]);
  }
  let maxLayer = 0;
  let maxRows = 1;
  for (const [L, arr] of byLayer) {
    if (L > maxLayer) maxLayer = L;
    if (arr.length > maxRows) maxRows = arr.length;
  }
  const numLayers = maxLayer + 1;
  const contentH = maxRows * nodeH + (maxRows - 1) * rowGap;
  const width = PAD * 2 + numLayers * nodeW + (numLayers - 1) * colGap;
  const height = PAD * 2 + contentH;

  // —— 落坐标：列 x 由层号决定，列内垂直居中（相对最高列）——
  const xyById = new Map<string, { x: number; y: number }>();
  for (const [L, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const colH = ids.length * nodeH + (ids.length - 1) * rowGap;
    const y0 = PAD + (contentH - colH) / 2;
    const x = PAD + L * (nodeW + colGap);
    ids.forEach((id, i) => {
      xyById.set(id, { x, y: y0 + i * (nodeH + rowGap) });
    });
  }

  // —— 输出节点：按章节顺序（稳定），坐标为四舍五入后值 ——
  const nodes: LayoutNode[] = order.map((id) => {
    const p = xyById.get(id)!;
    return { id, node: nodeById.get(id)!, layer: layer.get(id) ?? 0, x: round1(p.x), y: round1(p.y) };
  });

  // —— 输出边：源右侧中点 → 目标左侧中点的三次贝塞尔（控制点水平外推）——
  const edges: LayoutEdge[] = rawEdges.map((e) => {
    const a = xyById.get(e.from)!;
    const b = xyById.get(e.to)!;
    const sx = a.x + nodeW;
    const sy = a.y + nodeH / 2;
    const tx = b.x;
    const ty = b.y + nodeH / 2;
    const dx = Math.max(MIN_BEND, Math.abs(tx - sx) / 2);
    const d = `M ${round1(sx)} ${round1(sy)} C ${round1(sx + dx)} ${round1(sy)}, ${round1(tx - dx)} ${round1(ty)}, ${round1(tx)} ${round1(ty)}`;
    return { from: e.from, to: e.to, d };
  });

  return { nodes, edges, width, height };
}
