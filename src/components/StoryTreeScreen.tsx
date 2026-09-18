// 剧情图屏（tree overlay）：读世界线的 story-tree.md → 布局成 SVG 节点图，支持选点看详情、
// 在此分叉、一句话自然语言改树（引擎改完静默写回，屏内重取）。解析不出结构时回退显示原文。
// v1.6：逐轮快照索引（GET /api/history）驱动「存档点 · 第 N 幕」标注与原地精确回退（POST restore，
//       两步确认；覆盖三文件后由 store 补发「继续世界：」让引擎重新读档同步）；有快照的节点「在此分叉」
//       自动携带 seq（无快照保持旧载荷）；当前章节点 > 40 默认降级为
//       列表模式（可切回图形）；图形模式支持滚轮缩放（指针锚点）/拖拽平移/放大·缩小·适应/双击复位；
//       `+ - 0` 缩放键走同一条路——入口是节点的 roving tabIndex：焦点落在画布内任一节点上，
//       按键就冒泡到画布容器（画布根 <svg> 自己不可 Tab，所以只有「焦点在画布内」时才生效）；
//       节点 roving tabIndex + 方向键移动 + Enter 开详情。
// v1.7：快照对比——节点详情「与上一个存档点对比」拉当前 + 前一条快照（GET /api/history?seq=），
//       用 lib/diff 的 diffLines 逐行 diff 三个 tab（当前状态/前情提要/剧情图），equal 行默认折叠
//       成上下文 ±2 行 + 「…共 N 行未变」可展开。
// v1.8：章节可达——正文顶部章节切换器列出解析出的每一章（进度章标「当前」，点谁画谁：重排 + 重适应 +
//       收掉节点焦点）；`## 归档` 只有目录信息（节点数据不在文件里），点它给一句实话而不是静默。
//       ≥lg 时屏体分两栏（左画布/列表、右详情 380px sticky 自滚），<lg 保持上下堆叠；图例/缩放与操作
//       提示包进 .shell-panel 带（压在底图上也读得清）；文案去引擎口吻（快照 #N → 存档点/第 N 幕）、
//       字号一律走 global.css 的档位类。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { motion } from "framer-motion";
import { Maximize2, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { fetchHistory, fetchSnapshot, fetchTree, type WorldSnapshotMeta } from "../lib/acp";
import { diffLines, diffStats, type DiffRow } from "../lib/diff";
import {
  parseStoryTree,
  type StoryTree,
  type TreeChapter,
  type TreeNode,
  type TreeNodeStatus,
} from "../lib/parser";
import { truncate } from "../lib/text";
import { fitView, layoutTree, panView, viewBoxOf, zoomViewAt, type LayoutNode, type TreeLayout, type TreeView } from "../lib/treeLayout";
import { resolveWorldLabel } from "../lib/worlds";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 节点绘制尺寸：须与传给 layoutTree 的参数一致（布局定坐标、SVG 画矩形） */
const NODE_W = 210;
const NODE_H = 74;

/** 当前章节点超过这个数就默认列表模式（大图在小屏上连线糊成一团，先给可读的列表） */
const BIG_GRAPH_NODES = 40;

/** 每次缩放按钮/滚轮/快捷键的步进倍数 */
const ZOOM_STEP = 1.25;

/** 拖拽平移的死区（像素）：低于它视为点选，避免手抖把点击吃掉 */
const DRAG_SLOP = 4;

/** 节点上挂的快照引用：最早匹配快照的序号与「第几轮」。turn 仍由 {@link snapshotTurnNo} 算出（纯函数，
    单测在用），屏上只印「第 N 幕」（口径统一：幕号 = 快照序号，与历史抽屉的「已回溯到第 N 幕」同源）。 */
interface SnapshotRef {
  seq: number;
  turn: number;
}

/** 节点状态 → 配色：已走过=主题金、可达=中性水墨、已剪枝=暗+虚线、嫁接=紫 */
function nodePaint(status: TreeNodeStatus): { fill: string; stroke: string; dash?: string; dim: boolean } {
  switch (status) {
    case "已走过":
      return { fill: "color-mix(in oklab, var(--accent) 26%, transparent)", stroke: "var(--accent)", dim: false };
    case "已剪枝":
      return { fill: "rgba(236,231,219,.02)", stroke: "rgba(236,231,219,.22)", dash: "5 4", dim: true };
    case "嫁接":
      return { fill: "rgba(167,139,250,.18)", stroke: "#a78bfa", dim: false };
    case "可达":
    default:
      return { fill: "rgba(236,231,219,.05)", stroke: "rgba(236,231,219,.4)", dim: false };
  }
}

/** 图例顺序（与节点状态字面一致） */
const STATUS_ORDER: TreeNodeStatus[] = ["已走过", "可达", "已剪枝", "嫁接"];

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

/** 章节切换器的一项：解析出的章号 + 标签 + 章节本体（一次算好，默认章、选中章与画布 key 共用） */
interface ChapterItem {
  no: number;
  label: string;
  chapter: TreeChapter;
  /**
   * 章节键 `章号-下标`：**章号不唯一**（只有标题、没有节点的章会退化成 `index + 1`，撞上下一个真实章号），
   * 所以选中态、切换器的 key/testid 都以这个复合键为准——只按章号认会让第二个同号章永远点不开。
   */
  key: string;
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
    out.set(id, { seq: snap.seq, turn: snapshotTurnNo(snapshots, snap.seq) });
  }
  return out;
}

/**
 * 快照对比的基线（v1.7）：同世界 history 里 **seq 更小的最近一条**，kind 不限——backup
 * （回退前的自动备份）也是合法基线：它恰恰是「上一份不同的内容」，排除它会让回退后的
 * 第一个对比找不到基线。全局最小的快照没有基线，返回 null（UI 不显示对比按钮）。
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

/** diff 折叠视图里 add/remove 前后各保留几行 equal（上下文） */
const DIFF_CONTEXT = 2;

/** 折叠视图的一段：rows=保留的行；gap=被折叠的连续 equal（count 行） */
type DiffPart = { kind: "rows"; rows: DiffRow[] } | { kind: "gap"; count: number };

/**
 * diff 行数组 → 「保留段 + 折叠段」分区（快照对比面板的默认视图）：add/remove 行与其
 * 前后 {@link DIFF_CONTEXT} 行 equal 保留，其余连续 equal 折成 gap（「…共 N 行未变」，可展开）。
 * 纯函数：面板测试与渲染共用同一规则。
 * @param {DiffRow[]} rows diffLines 的输出
 * @returns {DiffPart[]} 交替的保留段与折叠段（首尾可为 gap；无改动时整段一个 gap）
 */
function partitionDiff(rows: DiffRow[]): DiffPart[] {
  // 先标记：每个 add/remove 位置把 [p-ctx, p+ctx] 的 equal 也点亮
  const keep = rows.map((r) => r.type !== "equal");
  rows.forEach((r, p) => {
    if (r.type === "equal") return;
    for (let k = Math.max(0, p - DIFF_CONTEXT); k <= Math.min(rows.length - 1, p + DIFF_CONTEXT); k++) keep[k] = true;
  });
  // 再把连续 keep 段收集成 parts，被裁掉的连续 equal 合并成 gap
  const parts: DiffPart[] = [];
  let gap = 0;
  rows.forEach((r, i) => {
    if (!keep[i]) {
      gap += 1;
      return;
    }
    if (gap > 0) {
      parts.push({ kind: "gap", count: gap });
      gap = 0;
    }
    const last = parts[parts.length - 1];
    if (last?.kind === "rows") last.rows.push(r);
    else parts.push({ kind: "rows", rows: [r] });
  });
  if (gap > 0) parts.push({ kind: "gap", count: gap });
  return parts;
}

/**
 * SVG 画布：按 viewBox 自适应宽度，渲染边与节点；v1.6 加缩放平移与 roving tabIndex。
 * 节点用 <g role="button" tabIndex> 语义：整图只有选中节点可 Tab 进入，方向键在节点间走，Enter/Space 选中。
 */
function TreeCanvas({
  chapter,
  layout,
  treeFocus,
  snapshotOf,
  onFocus,
}: {
  chapter: TreeChapter;
  layout: TreeLayout;
  treeFocus: string | null;
  snapshotOf: Map<string, SnapshotRef>;
  onFocus: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<TreeView>(() => fitView(layout.width, layout.height));
  /** 拖拽态：按下点 + 是否已越过死区；`draggedRef` 活到 click 之后（拖完那一下不该顺便开详情） */
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);

  // 布局换了（切章/切世界/改树）：回到「适应」，别让上一个图的缩放平移漂到新图上
  useEffect(() => {
    setView(fitView(layout.width, layout.height));
  }, [layout.width, layout.height]);

  const fit = useCallback(() => setView(fitView(layout.width, layout.height)), [layout.width, layout.height]);
  const zoomBy = useCallback(
    (factor: number, fx = 0.5, fy = 0.5) =>
      setView((v) => zoomViewAt(v, factor, fx, fy, layout.width, layout.height)),
    [layout.width, layout.height],
  );

  // 滚轮缩放：以指针为锚点。必须自己挂非 passive 监听（React 的 onWheel 在根上是被动的，preventDefault 无效）
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // 图内滚轮 = 缩放，不滚页面
      const rect = el.getBoundingClientRect();
      // 指针在画布里的归一化落点；jsdom（rect 全 0）与旧浏览器退化为中心缩放
      const fx = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      const fy = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
      setView((v) => zoomViewAt(v, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, fx, fy, layout.width, layout.height));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [layout.width, layout.height]);

  /** 屏幕像素位移 → 布局坐标位移（viewBox 等比铺满，横竖同一个比例） */
  const layoutDelta = (px: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0; // 量不到宽度就不平移，宁可不响应也不乱跳
    return (px * layout.width) / view.zoom / rect.width;
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    draggedRef.current = false;
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return; // 死区内：还是点选
      d.moved = true;
      // 指针捕获让手滑出画布也能继续拖（老环境不支持就退化为画布内拖）
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 指针已失效（pointerId 不存在）：这轮拖拽按画布内拖继续
      }
    }
    setView((v) => panView(v, layoutDelta(dx), layoutDelta(dy), layout.width, layout.height));
    d.x = e.clientX;
    d.y = e.clientY;
  };

  const onPointerUp = () => {
    draggedRef.current = dragRef.current?.moved ?? false;
    dragRef.current = null;
  };

  const ids = useMemo(() => layout.nodes.map((n) => n.id), [layout.nodes]);
  // roving tabIndex：整图只有一个可 Tab 的节点（选中节点；没选中时落在当前进度/首个节点）
  const tabbableId = treeFocus && ids.includes(treeFocus) ? treeFocus : chapter.current && ids.includes(chapter.current) ? chapter.current : ids[0];

  /** 方向键在节点间走（顺序=章节顺序），焦点跟着 roving 走，接着按 Enter 就在新节点上 */
  const moveFocus = (step: number) => {
    if (ids.length === 0) return;
    const from = tabbableId ? Math.max(0, ids.indexOf(tabbableId)) : 0;
    const next = ids[(from + step + ids.length) % ids.length];
    if (!next) return;
    onFocus(next);
    wrapRef.current?.querySelector<SVGGElement>(`[data-testid="tree-node-${next}"]`)?.focus?.();
  };

  const onCanvasKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        return;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        return;
      // 「+」在不同键盘布局/主键盘区可能是 =，一起收
      case "+":
      case "=":
        e.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      case "-":
      case "_":
        e.preventDefault();
        zoomBy(1 / ZOOM_STEP);
        return;
      case "0":
        e.preventDefault();
        fit();
        return;
      default:
        return;
    }
  };

  const activate = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onFocus(id);
    }
  };

  /** 节点 aria-label：状态 +（有存档点时）幕号——读屏用户也能听出「这个点能不能精确回退」 */
  const nodeLabel = (id: string, status: TreeNodeStatus): string => {
    const snap = snapshotOf.get(id);
    return `节点 ${id} · ${status}${snap ? ` · 存档点 · 第 ${snap.seq} 幕` : ""}`;
  };

  return (
    <div ref={wrapRef} data-testid="tree-canvas-wrap" onKeyDown={onCanvasKeyDown} className="mt-3">
      {/* 工具条（图例 + 缩放）：包一层 .shell-panel 带——这行字从前直接压在底图/立绘上，暗底图就糊了 */}
      <div className="shell-panel mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl px-3 py-2 text-meta tracking-[.1em] text-ink-hint">
        {STATUS_ORDER.map((st) => {
          const paint = nodePaint(st);
          return (
            <span key={st} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-[3px] border"
                style={{
                  background: paint.fill,
                  borderColor: paint.stroke,
                  borderStyle: paint.dash ? "dashed" : "solid",
                }}
              />
              {st}
            </span>
          );
        })}

        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="tree-zoom-out"
            aria-label="缩小"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            className="rounded-md border border-white/10 p-1.5 text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            data-testid="tree-zoom-in"
            aria-label="放大"
            onClick={() => zoomBy(ZOOM_STEP)}
            className="rounded-md border border-white/10 p-1.5 text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            data-testid="tree-zoom-fit"
            onClick={fit}
            className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1.5 text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            <Maximize2 size={14} /> 适应
          </button>
          <span data-testid="tree-zoom-level" className="ml-1 w-12 text-right text-ink-hint">
            {Math.round(view.zoom * 100)}%
          </span>
        </span>
      </div>

      {/* 操作提示：同样吃面板带（这行小字从前是屏上对比度最低的一处） */}
      <p className="shell-panel mb-2 rounded-xl px-3 py-1.5 text-meta tracking-[.05em] text-ink-hint">
        滚轮缩放 · 拖拽平移 · 双击复位 · 方向键走节点
      </p>

      <svg
        ref={svgRef}
        data-testid="tree-canvas"
        viewBox={viewBoxOf(view, layout.width, layout.height)}
        preserveAspectRatio="xMidYMid meet"
        className="w-full cursor-grab touch-none rounded-xl border border-white/[.06] bg-[rgba(12,14,20,.5)] active:cursor-grabbing"
        style={{ height: "auto", aspectRatio: `${layout.width} / ${layout.height}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={fit}
      >
        <defs>
          <marker
            id="tree-arrow"
            viewBox="0 0 8 8"
            refX="7.5"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" fill="rgba(236,231,219,.35)" />
          </marker>
        </defs>

        {layout.edges.map((e, i) => (
          <path
            key={`${e.from}->${e.to}-${i}`}
            d={e.d}
            fill="none"
            style={{ stroke: "rgba(236,231,219,.25)" }}
            strokeWidth={1.4}
            markerEnd="url(#tree-arrow)"
          />
        ))}

        {layout.nodes.map((ln) => {
          const paint = nodePaint(ln.node.status);
          const focused = treeFocus === ln.id;
          const isCurrent = chapter.current === ln.id;
          const stroke = focused ? "var(--accent2)" : paint.stroke;
          const strokeWidth = focused ? 2.6 : isCurrent ? 2 : 1.5;
          return (
            <g
              key={ln.id}
              data-testid={`tree-node-${ln.id}`}
              role="button"
              tabIndex={ln.id === tabbableId ? 0 : -1}
              aria-label={nodeLabel(ln.id, ln.node.status)}
              aria-current={isCurrent ? "step" : undefined}
              onClick={() => {
                // 拖完手抬起那一下不算点选（否则平移顺手就把详情打开了）
                if (draggedRef.current) {
                  draggedRef.current = false;
                  return;
                }
                onFocus(ln.id);
              }}
              onKeyDown={activate(ln.id)}
              className="cursor-pointer"
              opacity={paint.dim ? 0.55 : 1}
            >
              {/* 当前进度节点：外圈亮环（accent2） */}
              {isCurrent && (
                <rect
                  x={ln.x - 4}
                  y={ln.y - 4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  rx={12}
                  fill="none"
                  style={{ stroke: "var(--accent2)" }}
                  strokeWidth={2}
                />
              )}
              <rect
                x={ln.x}
                y={ln.y}
                width={NODE_W}
                height={NODE_H}
                rx={10}
                style={{
                  fill: paint.fill,
                  stroke,
                  ...(paint.dash && !focused ? { strokeDasharray: paint.dash } : {}),
                }}
                strokeWidth={strokeWidth}
              />
              <text x={ln.x + 12} y={ln.y + 24} className="text-ui font-semibold tracking-[.06em]" style={{ fill: "var(--ink)" }}>
                节点 {ln.id}
              </text>
              <text x={ln.x + 12} y={ln.y + 46} className="text-meta" style={{ fill: "var(--ink)", opacity: 0.62 }}>
                {truncate(ln.node.beat || ln.node.synopsis || "（无拍点）", 16)}
              </text>
              {/* 状态行是卡上最窄的一行：地点截到 6 字，给「存档点 · 第 N 幕」留位（SVG 文字不会自动省略） */}
              <text x={ln.x + 12} y={ln.y + 63} className="text-micro" style={{ fill: "var(--ink)", opacity: 0.6 }}>
                {ln.node.status}
                {ln.node.location ? ` · ${truncate(ln.node.location, 6)}` : ""}
                {snapshotOf.has(ln.id) ? ` · 存档点 · 第 ${snapshotOf.get(ln.id)!.seq} 幕` : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * 列表模式（大图降级用）：按状态分组，每行 = 节点 id + 地点 + 梗概片段。
 * 行是原生 button（Tab/Enter/Space 的语义与焦点环都由浏览器给），点行进详情。
 */
function TreeList({
  nodes,
  currentId,
  snapshotOf,
  onFocus,
}: {
  nodes: LayoutNode[];
  currentId: string | null;
  snapshotOf: Map<string, SnapshotRef>;
  onFocus: (id: string) => void;
}) {
  const groups = STATUS_ORDER.map((status) => ({ status, nodes: nodes.filter((n) => n.node.status === status) })).filter(
    (g) => g.nodes.length > 0,
  );

  return (
    <div data-testid="tree-list" className="mt-3 space-y-3">
      {groups.map((g) => (
        <div key={g.status} data-testid={`tree-list-group-${g.status}`}>
          <p className="text-meta tracking-[.2em] text-ink-hint">
            {g.status} · {g.nodes.length}
          </p>
          <div className="mt-1.5 space-y-1">
            {g.nodes.map((ln) => {
              const snap = snapshotOf.get(ln.id);
              const isCurrent = currentId === ln.id;
              return (
                <button
                  key={ln.id}
                  type="button"
                  data-testid={`tree-row-${ln.id}`}
                  aria-current={isCurrent ? "step" : undefined}
                  aria-label={`节点 ${ln.id} · ${ln.node.status}${snap ? ` · 存档点 · 第 ${snap.seq} 幕` : ""}`}
                  onClick={() => onFocus(ln.id)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-ui transition-colors ${
                    isCurrent ? "border-[color:var(--accent2)]/60 bg-white/[.05]" : "border-white/[.08] hover:border-gold/40"
                  }`}
                >
                  <span className="w-12 flex-none tracking-wide text-gold">{ln.id}</span>
                  <span className="w-28 flex-none truncate text-ink-hint">{ln.node.location || "（无地点）"}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-body">
                    {truncate(ln.node.synopsis || ln.node.beat || "（无梗概）", 44)}
                  </span>
                  {snap && <span className="flex-none text-micro text-ink-hint">存档点 · 第 {snap.seq} 幕</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 详情冒号行：地点/在场 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="flex-none text-meta tracking-[.2em] text-ink-hint">{label}</dt>
      <dd className="min-w-0 flex-1 text-ui text-ink-body">{value || "（暂无）"}</dd>
    </div>
  );
}

/** diff 面板的三个 tab（与快照三文件一一对应；顺序即渲染顺序） */
const DIFF_TABS: { key: DiffTabKey; label: string }[] = [
  { key: "state", label: "当前状态" },
  { key: "summary", label: "前情提要" },
  { key: "tree", label: "剧情图" },
];

/** diff 的 tab 键（state/summary/tree ↔ 快照三文件） */
type DiffTabKey = "state" | "summary" | "tree";

/** 一行 diff：remove=红（a 独有）、add=绿（b 新增）、equal=ink-hint——颜色只用 tailwind 内置档，不引新 token；
    equal 行是玩家要读的上下文正文，按对比度阶梯用 hint 档（faint 只留给禁用/装饰），remove/add 用 <del>/<ins> 让屏幕阅读器可辨 */
function DiffLine({ row }: { row: DiffRow }) {
  const tone =
    row.type === "remove"
      ? "bg-rose-400/10 text-rose-300"
      : row.type === "add"
        ? "bg-emerald-400/10 text-emerald-300"
        : "text-ink-hint";
  const sign = row.type === "remove" ? "−" : row.type === "add" ? "+" : " ";
  const body = (
    <>
      <span aria-hidden className="mr-1.5 inline-block w-2.5 select-none text-center">{sign}</span>
      {row.text || "\u00a0"}
    </>
  );
  return (
    <div data-testid={`diff-row-${row.type}`} className={`whitespace-pre-wrap px-1.5 font-mono text-meta leading-relaxed ${tone}`}>
      {row.type === "remove" ? <del className="no-underline">{body}</del> : row.type === "add" ? <ins className="no-underline">{body}</ins> : body}
    </div>
  );
}

/**
 * 选中节点的详情面板：地点/在场/梗概/出边/状态 + 存档点标注 + 在此分叉 / 回退到此节点。
 * 回退是破坏性动作（覆盖世界线三份文件）：两段确认，第一段只进确认态。
 * ≥lg 时它住在屏体右栏（StickyRail 包着，自滚），<lg 时回到画布下方的一条卡。
 * v1.7 快照对比是**详情区内嵌展开**（不是浮层）：剧情图 overlay 本身已是一层浮层、App 的
 * Esc 链只管关 overlay——再叠一层浮层要另接 Esc 与遮罩层级；内嵌面板换节点自动收起，链路更短。
 */
function TreeDetail({
  node,
  engineBusy,
  snapshot,
  worldId,
  prevSeq,
  onFork,
  onRestore,
  onClose,
}: {
  node: TreeNode;
  engineBusy: boolean;
  snapshot: SnapshotRef | null;
  /** 快照对比拉取用的世界 id（fetchSnapshot 直连 /api/history?seq=） */
  worldId: string;
  /** 对比基线的 seq（seq 更小的最近一条，kind 不限）；没有更早快照时 null（不显示按钮） */
  prevSeq: number | null;
  onFork: (id: string, seq?: number) => void;
  onRestore: (seq: number) => void;
  onClose: () => void;
}) {
  const canFork = node.status === "已走过";
  const [confirming, setConfirming] = useState(false);

  // 快照对比面板的状态：rows 按 tab 键分桶；diffReqRef 让换节点/重开后的过期应答作废
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffTab, setDiffTab] = useState<DiffTabKey>("state");
  const [diffRows, setDiffRows] = useState<Record<DiffTabKey, DiffRow[]> | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffShowAll, setDiffShowAll] = useState(false);
  const diffReqRef = useRef(0);

  /**
   * 三个 diff tab 的方向键走位（ARIA tabs 惯例，自动激活）：←→ 循环、Home/End 跳首尾。
   * 焦点靠 DOM 顺序取（tablist 里只有这三个 role="tab"），激活与点击走同一条路（切 tab 回到折叠视图）。
   */
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = DIFF_TABS.map((t) => t.key);
    const i = keys.indexOf(diffTab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % keys.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + keys.length) % keys.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = keys.length - 1;
    if (next < 0 || next === i) return;
    e.preventDefault();
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    setDiffTab(keys[next]);
    setDiffShowAll(false);
  };

  // 换节点就把确认态与对比面板一起收掉：不该带着上一个节点的状态去点下一个
  useEffect(() => {
    setConfirming(false);
    diffReqRef.current += 1; // 在途的对比请求作废（应答回来也不许写进新节点的面板）
    setDiffOpen(false);
    setDiffTab("state");
    setDiffRows(null);
    setDiffLoading(false);
    setDiffError("");
    setDiffShowAll(false);
  }, [node.id]);

  /** 拉当前 + 基线两条快照全文并 diff 三文件（失败落在面板内的错误位，不打扰树本体） */
  const openDiff = () => {
    if (!snapshot || prevSeq === null) return;
    const req = diffReqRef.current + 1;
    diffReqRef.current = req;
    setDiffOpen(true);
    setDiffLoading(true);
    setDiffError("");
    setDiffRows(null);
    setDiffTab("state");
    setDiffShowAll(false);
    Promise.all([fetchSnapshot(worldId, snapshot.seq), fetchSnapshot(worldId, prevSeq)])
      .then(([cur, prev]) => {
        if (diffReqRef.current !== req) return;
        setDiffRows({
          state: diffLines(prev.files.state ?? "", cur.files.state ?? ""),
          summary: diffLines(prev.files.summary ?? "", cur.files.summary ?? ""),
          tree: diffLines(prev.files.tree ?? "", cur.files.tree ?? ""),
        });
      })
      .catch((e: unknown) => {
        if (diffReqRef.current !== req) return;
        setDiffError((e as Error).message || String(e));
      })
      .finally(() => {
        if (diffReqRef.current !== req) return;
        setDiffLoading(false);
      });
  };

  return (
    <div data-testid="tree-detail" className="shell-panel mt-4 rounded-xl p-4 lg:mt-0">
      <div className="flex items-center gap-3">
        <h3 className="text-body tracking-[.1em] text-ink">节点 {node.id}</h3>
        <span className="rounded-sm border border-white/15 px-1.5 py-0.5 text-micro text-ink-hint">{node.status}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md border border-white/10 px-3 py-1 text-ui tracking-[.15em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
        >
          关闭
        </button>
      </div>

      {snapshot && (
        <p data-testid={`tree-snapshot-${node.id}`} className="mt-2 text-ui tracking-[.08em] text-gold/85">
          存档点 · 第 {snapshot.seq} 幕
        </p>
      )}

      {/* 有基线（seq 更小的最近一条）才给对比入口；全局最小的快照没有可比的对象 */}
      {snapshot && prevSeq !== null && !diffOpen && (
        <button
          type="button"
          data-testid="snapshot-diff-open"
          onClick={openDiff}
          className="mt-2 rounded-lg border border-white/15 px-3 py-1.5 text-ui tracking-[.1em] text-ink-body transition-colors hover:border-gold/40 hover:text-ink"
        >
          与上一个存档点对比（第 {prevSeq} 幕 → 第 {snapshot.seq} 幕）
        </button>
      )}

      {diffOpen && snapshot && prevSeq !== null && (
        <div data-testid="snapshot-diff" className="mt-3 rounded-lg border border-white/10 bg-[rgba(8,10,16,.55)] p-3">
          {/* 标题行允许换行：右栏只有 380px，一行放不下「第 N 幕 → 第 M 幕（…）+ 关闭对比」 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-meta tracking-[.08em] text-ink-body">
              第 {prevSeq} 幕 → 第 {snapshot.seq} 幕（红=旧档独有，绿=新档新增）
            </p>
            <button
              type="button"
              data-testid="snapshot-diff-close"
              onClick={() => {
                diffReqRef.current += 1;
                setDiffOpen(false);
              }}
              className="ml-auto rounded-md border border-white/10 px-2.5 py-0.5 text-meta tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              关闭对比
            </button>
          </div>

          {diffLoading && (
            <p data-testid="snapshot-diff-loading" className="mt-2 animate-pulse text-ui text-ink-hint">
              载入存档点对比…
            </p>
          )}

          {diffError && (
            <p data-testid="snapshot-diff-error" className="mt-2 text-ui text-red-400">
              存档点对比加载失败：{diffError}
            </p>
          )}

          {diffRows && (
            <div className="mt-2">
              <div role="tablist" aria-label="存档点对比" onKeyDown={onTabKeyDown} className="flex flex-wrap gap-1.5">
                {DIFF_TABS.map((t) => {
                  const stats = diffStats(diffRows[t.key]);
                  const active = diffTab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      id={`snapshot-diff-tab-${t.key}`}
                      aria-selected={active}
                      aria-controls="snapshot-diff-panel"
                      tabIndex={active ? 0 : -1}
                      data-testid={`snapshot-diff-tab-${t.key}`}
                      onClick={() => {
                        setDiffTab(t.key);
                        setDiffShowAll(false); // 切 tab 回到折叠视图：每个 tab 独立展开
                      }}
                      className={`rounded-md border px-2.5 py-1 text-meta tracking-[.08em] transition-colors ${
                        active ? "border-gold/45 bg-gold/15 text-gold" : "border-white/10 text-ink-hint hover:border-gold/40"
                      }`}
                    >
                      {t.label}
                      <span className="ml-1.5 text-micro">
                        {stats.added === 0 && stats.removed === 0 ? "无变化" : `+${stats.added} −${stats.removed}`}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div
                id="snapshot-diff-panel"
                role="tabpanel"
                aria-labelledby={`snapshot-diff-tab-${diffTab}`}
                className="mt-2 max-h-72 overflow-y-auto rounded-md border border-white/[.06] bg-[rgba(12,14,20,.6)] p-2"
              >
                {((diffShowAll ? [{ kind: "rows", rows: diffRows[diffTab] }] : partitionDiff(diffRows[diffTab])) as DiffPart[]).map((part, i) =>
                  part.kind === "gap" ? (
                    <button
                      key={i}
                      type="button"
                      data-testid="snapshot-diff-gap"
                      onClick={() => setDiffShowAll(true)}
                      className="my-0.5 block w-full rounded-sm border border-dashed border-white/10 px-2 py-0.5 text-left text-meta tracking-[.05em] text-ink-hint transition-colors hover:border-gold/30 hover:text-ink"
                    >
                      …共 {part.count} 行未变（点击展开）
                    </button>
                  ) : (
                    <div key={i}>
                      {part.rows.map((r, ri) => (
                        <DiffLine key={ri} row={r} />
                      ))}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DetailRow label="地点" value={node.location} />
        <DetailRow label="在场" value={node.present} />
      </dl>

      <div className="mt-3">
        <p className="text-meta tracking-[.2em] text-ink-hint">梗概</p>
        <p className="mt-1 whitespace-pre-wrap text-ui leading-relaxed text-ink-body">{node.synopsis || "（暂无）"}</p>
      </div>

      <div className="mt-3">
        <p className="text-meta tracking-[.2em] text-ink-hint">出边</p>
        {node.edges.length === 0 ? (
          <p className="mt-1 text-ui text-ink-hint">（无出边，本章末端）</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {node.edges.map((e, i) => (
              <li key={i} className="text-ui text-ink-body">
                <span className="text-ink-hint">{e.label || "（未命名）"}</span>
                <span className="mx-1.5 text-ink-faint">→</span>
                <span className="text-gold">{e.target}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {canFork && (
          <button
            type="button"
            data-testid={`tree-fork-${node.id}`}
            disabled={engineBusy}
            // 有快照 = 精确分叉（以该快照建新世界）；无快照不带 seq，走 server 的兼容路径
            onClick={() => onFork(node.id, snapshot?.seq)}
            className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
              engineBusy
                ? "cursor-not-allowed border-white/10 text-ink-hint"
                : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
            }`}
          >
            在此分叉
          </button>
        )}

        {/* 无快照的旧世界：这里什么都不渲染（一切按现状降级，不报错、不显示新按钮） */}
        {snapshot &&
          (confirming ? (
            <>
              <button
                type="button"
                data-testid={`tree-restore-confirm-${node.id}`}
                disabled={engineBusy}
                onClick={() => {
                  setConfirming(false);
                  onRestore(snapshot.seq);
                }}
                className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                  engineBusy
                    ? "cursor-not-allowed border-white/10 text-ink-hint"
                    : "border-red-400/50 bg-red-400/15 text-red-300 hover:bg-red-400/25"
                }`}
              >
                确认回退（先备份当前）
              </button>
              <button
                type="button"
                data-testid={`tree-restore-cancel-${node.id}`}
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-white/10 px-3 py-2 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid={`tree-restore-${node.id}`}
              disabled={engineBusy}
              onClick={() => setConfirming(true)}
              className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                engineBusy
                  ? "cursor-not-allowed border-white/10 text-ink-hint"
                  : "border-white/15 text-ink-body hover:border-gold/40 hover:text-ink"
              }`}
            >
              回退到此节点（原地）
            </button>
          ))}

        <span className="text-meta tracking-[.05em] text-ink-hint">
          {snapshot ? "回退会先备份当前进度，再从这一刻重新开演" : "分叉会新建一条世界线，从这一幕继续"}
        </span>
      </div>
    </div>
  );
}

/** 剧情图：世界线剧情树的图形化查看 / 编辑 / 分叉 / 精确回退 */
export default function StoryTreeScreen() {
  const worldId = useGameStore((s) => s.worldId);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const treeStamp = useGameStore((s) => s.treeStamp);
  const treeNotice = useGameStore((s) => s.treeNotice);
  const treeFocus = useGameStore((s) => s.treeFocus);
  const forkResult = useGameStore((s) => s.forkResult);
  const engineBusy = useGameStore((s) => s.engineBusy);
  const pendingTreeMessage = useGameStore((s) => s.pendingTreeMessage);
  const closeOverlay = useGameStore((s) => s.closeOverlay);
  const refreshTree = useGameStore((s) => s.refreshTree);
  const setTreeFocus = useGameStore((s) => s.setTreeFocus);
  const sendTreeEdit = useGameStore((s) => s.sendTreeEdit);
  const forkAt = useGameStore((s) => s.forkAt);
  const restoreSnapshot = useGameStore((s) => s.restoreSnapshot);
  const switchToFork = useGameStore((s) => s.switchToFork);

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [value, setValue] = useState("");
  // 快照索引（逐轮回退用）；旧世界没有 history 目录 → 空数组，一切按现状降级
  const [snapshots, setSnapshots] = useState<WorldSnapshotMeta[]>([]);
  // 列表/图形：null=按图大小自动（>BIG_GRAPH_NODES 降级列表），点过切换就由玩家说了算（状态留在本屏）
  const [modePref, setModePref] = useState<"graph" | "list" | null>(null);
  // 选中的章节键（`章号-下标`；null = 默认章：带进度指针的那一章，否则最后一章）
  const [chapterSel, setChapterSel] = useState<string | null>(null);
  // 被点过的归档药丸下标（归档只有目录信息，点它给一句实话——不装作能打开）
  const [archiveHint, setArchiveHint] = useState<number | null>(null);

  // 世界切换 / 编辑完成（treeStamp 自增）/ 回退完成 / 手动刷新时重取树
  useEffect(() => {
    if (!worldId) {
      setMarkdown(null);
      setError("");
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setMarkdown(null);
    fetchTree(worldId, abort.signal)
      .then((r) => {
        if (!abort.signal.aborted) setMarkdown(r.markdown);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError" || abort.signal.aborted) return;
        const msg = (e as Error).message || String(e);
        // 404 = 本章尚未规划出树：给玩家一句人话
        setError(msg.includes("404") ? "本章还没有剧情树（开演前规划后出现）" : `剧情树加载失败：${msg}`);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [worldId, treeStamp]);

  // 快照索引与树同一时机重取（编辑完成 / 回退完成 / 手动刷新）。拉不到就是「没有快照」：
  // 老世界没有 history 目录（404）属正常降级，不占用树错误位、不打扰玩家
  useEffect(() => {
    if (!worldId) {
      setSnapshots([]);
      return;
    }
    const abort = new AbortController();
    fetchHistory(worldId, abort.signal)
      .then((r) => {
        if (!abort.signal.aborted) setSnapshots(r.snapshots ?? []);
      })
      .catch(() => {
        if (!abort.signal.aborted) setSnapshots([]);
      });
    return () => abort.abort();
  }, [worldId, treeStamp]);

  // 解析失败（返回 null）时屏内回退显示原文
  const tree: StoryTree | null = useMemo(() => (markdown ? parseStoryTree(markdown) : null), [markdown]);

  // 章节条目（章号 + 标签 + 本体 + 复合键）：切换器、默认章、选中章与画布 key 共用一次解析
  const chapters: ChapterItem[] = useMemo(
    () =>
      (tree?.chapters ?? []).map((ch, i) => {
        const no = chapterNoOf(ch, i);
        return { no, label: chapterLabel(ch, i), chapter: ch, key: `${no}-${i}` };
      }),
    [tree],
  );

  // 默认章：带「当前进度」指针的那一章（进度可能在更早的章上），否则最后一章
  const defaultChapterIdx = useMemo(() => {
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (chapters[i]!.chapter.current) return i;
    }
    return chapters.length - 1;
  }, [chapters]);

  // 选中的章：按复合键认（重取树后仍指向同一章）；键消失（编辑删了那一章/章序变了）就退回默认章
  const chapterIdx = useMemo(() => {
    if (chapterSel === null) return defaultChapterIdx;
    const found = chapters.findIndex((c) => c.key === chapterSel);
    return found === -1 ? defaultChapterIdx : found;
  }, [chapterSel, chapters, defaultChapterIdx]);

  const chapter: TreeChapter | null = chapters[chapterIdx]?.chapter ?? null;

  /** 画布 key：换章必回「适应」——两章画布尺寸恰好相同时 layout 依赖不会变，靠 key 强制重挂重置视图。
      用章节键（章号-下标）而不是章号：同号的两章不会共用一个 key */
  const chapterKey = chapter ? `ch-${chapters[chapterIdx]!.key}` : "ch-none";

  // 布局（纯净函数）：节点矩形尺寸与画布尺寸一并定下
  const layout = useMemo(() => layoutTree(chapter, { nodeW: NODE_W, nodeH: NODE_H }), [chapter]);

  // nodeId → 最早匹配快照（详情标注、分叉带 seq、节点 aria-label 都用它）
  const snapshotOf = useMemo(() => earliestSnapshotByNode(snapshots), [snapshots]);

  // 大图降级：当前章节点太多 → 默认列表（玩家可以手动切回图形，此时裁掉的数据量由缩放平移补齐）
  const bigGraph = layout.nodes.length > BIG_GRAPH_NODES;
  const mode = modePref ?? (bigGraph ? "list" : "graph");

  // 侧栏节点：treeFocus 命中当前章节点才显示
  const focusNode: TreeNode | null = useMemo(() => {
    if (!chapter || !treeFocus) return null;
    return chapter.nodes.find((n) => n.id === treeFocus) ?? null;
  }, [chapter, treeFocus]);

  // 选中节点的快照引用与对比基线（快照对比按钮的出现条件：有快照且有更早的快照）
  const focusSnapshot = focusNode ? (snapshotOf.get(focusNode.id) ?? null) : null;
  const focusPrevSeq = focusSnapshot ? prevSnapshotSeq(snapshots, focusSnapshot.seq) : null;

  /**
   * 切章：按章节键（章号-下标）选中并收掉节点焦点（详情里的节点已经不在这一章里了），
   * 模式回到自动判定——否则在手选过列表的大章上切到小章，会卡在列表态而切换器（只在降级时出现）看不见。
   */
  const selectChapter = (key: string) => {
    setChapterSel(key);
    setTreeFocus(null);
    setModePref(null);
  };

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    setValue("");
    sendTreeEdit(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法选词的 Enter 不算发送
    if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
  };

  // 引擎忙或已有排队编辑：发送按钮禁用并提示（排队指令由 store 在 turn_end 后补发）
  const inputBlocked = engineBusy || pendingTreeMessage !== null;

  // 无世界线：不开图，给一句引导
  if (!worldId) {
    return (
      <ScreenShell className="shell-backdrop">
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="text-ui tracking-[.1em] text-ink-hint">先开始或继续一条世界线，再来看剧情图</p>
        </div>
      </ScreenShell>
    );
  }

  // 标题上的世界名：真有名字才用（无显示名时 store 已退化为空串；`worldLabel === worldId` 只是防旧状态/
  // 手改数据，旧版 server 自动写的分叉备注同理不算名字——两条 slug 都由 lib/worlds 的显示层兜底滤掉），
  // 都没有就落回「本世界线」。裸 worldId 只活在目录名与日志里。
  const worldName = resolveWorldLabel(worldLabel, worldId, "本世界线");

  return (
    <ScreenShell className="shell-backdrop">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="absolute inset-0 flex flex-col"
      >
        {/* 头部：标题 + 刷新/返回 */}
        <header className="flex items-center px-6 pt-7">
          <h2 className="text-title tracking-[.4em] [text-indent:.4em]">剧情图 · {worldName}</h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={refreshTree}
              className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              <RefreshCw size={14} /> 刷新
            </button>
            <button
              type="button"
              data-testid="tree-back"
              onClick={closeOverlay}
              className="rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              返回
            </button>
          </div>
        </header>

        {/* 提示条：编辑摘要 / 分叉结果 / 回退结果 / 排队 */}
        {treeNotice && (
          <p
            data-testid="tree-notice"
            className="mx-6 mt-3 rounded-md border border-gold/25 bg-gold/10 px-3 py-1.5 text-ui tracking-[.05em] text-gold/90"
          >
            {treeNotice}
          </p>
        )}

        {/* 归档区：每章一行，横向滚动的紧凑药丸链。归档章只剩目录信息（节点数据不在文件里），
            所以点它给一句实话而不是静默；被点的药丸留 aria-pressed 高亮，再说一次收起 */}
        {tree && tree.archive.length > 0 && (
          <div data-testid="tree-archive" className="mx-6 mt-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {tree.archive.map((line, i) => (
                <button
                  key={i}
                  type="button"
                  data-testid={`tree-archive-${i}`}
                  aria-pressed={archiveHint === i}
                  onClick={() => setArchiveHint(archiveHint === i ? null : i)}
                  className={`whitespace-nowrap rounded-full border px-3 py-1 text-meta transition-colors ${
                    archiveHint === i
                      ? "border-gold/45 bg-gold/15 text-gold"
                      : "border-white/10 bg-white/[.03] text-ink-hint hover:border-gold/40 hover:text-ink"
                  }`}
                >
                  {line}
                </button>
              ))}
            </div>
            {archiveHint !== null && (
              <p data-testid="tree-archive-notice" className="mt-1.5 text-meta tracking-[.05em] text-ink-hint">
                这一章已归档，只保留了目录信息
              </p>
            )}
          </div>
        )}

        {/* 分叉结果：可切到新世界线（新世界的 id 不上屏，切过去自然就知道是谁） */}
        {forkResult && (
          <div
            data-testid="tree-fork-result"
            className="mx-6 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2.5"
          >
            <p className="text-ui text-gold">已创建新的世界线</p>
            <button
              type="button"
              data-testid="tree-switch"
              onClick={switchToFork}
              className="rounded-md border border-gold/35 bg-gold/15 px-3 py-1 text-ui text-gold transition-colors hover:bg-gold/30"
            >
              切到此世界线
            </button>
            <span className="text-meta tracking-[.08em] text-ink-hint">分叉会新建一条世界线，从这一幕继续</span>
          </div>
        )}

        {/* 主体：章节切换 →（左）画布/列表 ·（右 ≥lg）节点详情 */}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          {loading && <p className="mt-6 animate-pulse text-ui text-ink-hint">载入剧情树…</p>}

          {!loading && error && (
            <p data-testid="tree-error" className="mt-6 text-ui text-red-400">
              {error}
            </p>
          )}

          {/* 解析失败：回退显示原文 */}
          {!loading && !error && markdown !== null && tree === null && (
            <pre
              data-testid="tree-raw"
              className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-[rgba(12,14,20,.6)] p-4 text-ui leading-relaxed text-ink-body"
            >
              {markdown}
            </pre>
          )}

          {!loading && !error && tree && tree.chapters.length === 0 && (
            <p className="mt-6 text-ui text-ink-hint">当前世界还没有可绘制的章节节点</p>
          )}

          {/* 章节切换器：每一章都到得了（从前只画进度指针那一章）；进度章标「当前」 */}
          {!loading && !error && chapters.length > 0 && (
            <div
              data-testid="tree-chapters"
              role="group"
              aria-label="章节"
              className="shell-panel mb-3 flex flex-wrap items-center gap-1.5 rounded-xl px-2.5 py-2"
            >
              {chapters.map((it, i) => {
                const active = i === chapterIdx;
                return (
                  <button
                    key={it.key}
                    type="button"
                    data-testid={`tree-chapter-${it.key}`}
                    aria-pressed={active}
                    onClick={() => selectChapter(it.key)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1 text-ui tracking-[.12em] transition-colors ${
                      active ? "border-gold/45 bg-gold/15 text-gold" : "border-white/10 text-ink-hint hover:border-gold/40 hover:text-ink"
                    }`}
                  >
                    {it.label}
                    {it.chapter.current && (
                      <span className="rounded-sm border border-gold/35 px-1 text-micro text-gold/90">当前</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* 两栏只在有详情时铺开：没有选中节点就让画布独占整宽，不留一条 380px 的空栏 */}
          <div className={`grid min-h-0 gap-4 ${focusNode ? "lg:grid-cols-[minmax(0,1fr)_380px]" : ""}`}>
            <div className="min-w-0">
              {/* 大图（> 40 节点）：默认列表，并给出显式切换 */}
              {!loading && !error && tree && chapter && bigGraph && (
                <div data-testid="tree-view-toggle" className="mt-3 flex flex-wrap items-center gap-2 text-ui text-ink-hint">
                  <span>本章 {layout.nodes.length} 个节点，已切到列表模式</span>
                  <button
                    type="button"
                    data-testid="tree-view-list"
                    aria-pressed={mode === "list"}
                    onClick={() => setModePref("list")}
                    className={`rounded-md border px-3 py-1 tracking-[.15em] transition-colors ${
                      mode === "list" ? "border-gold/45 bg-gold/15 text-gold" : "border-white/10 text-ink-hint hover:border-gold/40"
                    }`}
                  >
                    列表
                  </button>
                  <button
                    type="button"
                    data-testid="tree-view-graph"
                    aria-pressed={mode === "graph"}
                    onClick={() => setModePref("graph")}
                    className={`rounded-md border px-3 py-1 tracking-[.15em] transition-colors ${
                      mode === "graph" ? "border-gold/45 bg-gold/15 text-gold" : "border-white/10 text-ink-hint hover:border-gold/40"
                    }`}
                  >
                    图形
                  </button>
                </div>
              )}

              {!loading && !error && tree && chapter && mode === "graph" && (
                // key 跟章走：换章必回「适应」（见 chapterKey 注释）
                <TreeCanvas
                  key={chapterKey}
                  chapter={chapter}
                  layout={layout}
                  treeFocus={treeFocus}
                  snapshotOf={snapshotOf}
                  onFocus={setTreeFocus}
                />
              )}

              {!loading && !error && tree && chapter && mode === "list" && (
                <TreeList
                  nodes={layout.nodes}
                  currentId={chapter.current}
                  snapshotOf={snapshotOf}
                  onFocus={setTreeFocus}
                />
              )}
            </div>

            {/* ≥lg 右栏：sticky 顶住 + 自滚（长梗概/长 diff 不让整屏跟着跑）；<lg 回到画布下方的卡 */}
            {focusNode && (
              <aside
                aria-label="节点详情"
                className="lg:sticky lg:top-0 lg:max-h-[calc(100dvh-16rem)] lg:overflow-y-auto"
              >
                <TreeDetail
                  node={focusNode}
                  engineBusy={engineBusy}
                  snapshot={focusSnapshot}
                  worldId={worldId}
                  prevSeq={focusPrevSeq}
                  onFork={forkAt}
                  onRestore={(seq) => void restoreSnapshot(seq)}
                  onClose={() => setTreeFocus(null)}
                />
              </aside>
            )}
          </div>
        </div>

        {/* 底部输入行：一句话改树（忙碌中排队） */}
        <div data-testid="tree-input" className="border-t border-white/[.06] px-6 py-4">
          {inputBlocked && (
            <p className="mb-2 text-right text-meta tracking-[.15em] text-ink-hint">忙碌中，就绪后自动发送</p>
          )}
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="用一句话改这棵树…（例：加一个雨夜遇袭的场景）"
              autoComplete="off"
              className="flex-1 rounded-lg border border-white/10 bg-[rgba(12,14,20,.8)] px-3.5 py-2.5 text-body tracking-[.02em] transition-colors focus:border-gold/35"
            />
            <button
              type="button"
              data-testid="tree-send"
              disabled={inputBlocked}
              onClick={submit}
              className="rounded-lg border border-gold/35 bg-gold/15 px-5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
            >
              发送
            </button>
          </div>
        </div>
      </motion.div>
    </ScreenShell>
  );
}
