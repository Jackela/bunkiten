// 剧情树布局纯函数：把 TreeChapter 的节点/出边算成二维坐标 + SVG 路径。
// 不依赖 React/DOM，可直接被 node import 做单测；输出确定（同输入必得同输出）。
// v1.6 追加画布视图（缩放/平移）纯函数：TreeView + fitView/zoomViewAt/panView/viewBoxOf，
// 图屏的滚轮缩放（指针锚点）、拖拽平移、放大/缩小/适应按钮与 +/-/0 快捷键都只调它们。
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

// —— 画布视图（缩放/平移，v1.6）：用「中心点 + 缩放倍数」表达 SVG viewBox ——
// 纯函数、不碰 DOM：缩放以指针为锚点、平移只挪中心、中心恒被夹在布局内（拖不出边界）。
// zoom=1 即「适应」：viewBox 恰好是 `0 0 width height`，与 v1.5 的默认输出逐字一致。

/** 画布视图：cx/cy 是**视图中心**在布局坐标系里的位置（不是左上角），zoom 相对「适应」的倍数 */
export interface TreeView {
  cx: number;
  cy: number;
  zoom: number;
}

/** 缩放下限（比适应再退一点，留出看全貌的余量） */
export const TREE_ZOOM_MIN = 0.5;
/** 缩放上限（再放大只是把像素拉成马赛克，没有新信息） */
export const TREE_ZOOM_MAX = 4;

/** 缩放收敛进 [MIN, MAX]；非有限数（NaN/Infinity）回适应 */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(TREE_ZOOM_MAX, Math.max(TREE_ZOOM_MIN, z));
}

/** 「适应」视图：整张布局正好铺满画布 */
export function fitView(width: number, height: number): TreeView {
  return { cx: width / 2, cy: height / 2, zoom: 1 };
}

/** 单轴夹取：视图比布局窄就夹在 [half, size-half]；视图比布局宽（缩得比适应还小）只能居中 */
function clampAxis(c: number, size: number, half: number): number {
  if (!(half > 0) || size <= half * 2) return size / 2;
  return Math.min(size - half, Math.max(half, c));
}

/** 收敛一个视图：zoom 合法 + 中心不出画布 */
function clampView(v: TreeView, width: number, height: number): TreeView {
  const zoom = clampZoom(v.zoom);
  const halfW = width / (2 * zoom);
  const halfH = height / (2 * zoom);
  const cx = Number.isFinite(v.cx) ? clampAxis(v.cx, width, halfW) : width / 2;
  const cy = Number.isFinite(v.cy) ? clampAxis(v.cy, height, halfH) : height / 2;
  return { cx, cy, zoom };
}

/**
 * 以视图内归一化锚点缩放：锚点下的那一点布局坐标保持不动（滚轮缩放跟手的关键）。
 * @param {TreeView} v 当前视图
 * @param {number} factor 缩放倍数（>1 放大、<1 缩小；会被 clampZoom 收敛）
 * @param {number} fx 锚点横坐标比例（0=视图左缘，1=右缘；越界收敛到 [0,1]——指针落在边距上时）
 * @param {number} fy 锚点纵坐标比例（同上）
 * @param {number} width 布局宽（= 适应时的画布宽）
 * @param {number} height 布局高
 * @returns {TreeView} 新视图（中心已夹进布局）
 */
export function zoomViewAt(
  v: TreeView,
  factor: number,
  fx: number,
  fy: number,
  width: number,
  height: number,
): TreeView {
  const zoom = clampZoom(v.zoom * factor);
  const ax = Math.min(1, Math.max(0, fx));
  const ay = Math.min(1, Math.max(0, fy));
  // 锚点下的布局坐标：视图中心 ± 半个视图宽（高）
  const px = v.cx + (ax - 0.5) * (width / v.zoom);
  const py = v.cy + (ay - 0.5) * (height / v.zoom);
  // 反解新中心：同一个布局坐标仍落在同一个比例位置上
  return clampView(
    { cx: px - (ax - 0.5) * (width / zoom), cy: py - (ay - 0.5) * (height / zoom), zoom },
    width,
    height,
  );
}

/**
 * 平移视图：dx/dy 是**视图内布局坐标**的位移（拖拽方向即内容移动方向，与手指一致）。
 * @returns {TreeView} 新视图（中心已夹进布局）
 */
export function panView(v: TreeView, dx: number, dy: number, width: number, height: number): TreeView {
  return clampView({ ...v, cx: v.cx - dx, cy: v.cy - dy }, width, height);
}

/**
 * 视图 → SVG viewBox 字符串（缩放平移的唯一出口，组件不再自己拼）。
 * @returns {string} 形如 `x y w h`；适应态即 `0 0 width height`
 */
export function viewBoxOf(v: TreeView, width: number, height: number): string {
  const w = width / v.zoom;
  const h = height / v.zoom;
  return `${round1(v.cx - w / 2)} ${round1(v.cy - h / 2)} ${round1(w)} ${round1(h)}`;
}
