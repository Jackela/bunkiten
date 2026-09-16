// 剧情图屏（tree overlay）：读世界线的 story-tree.md → 布局成 SVG 节点图，支持选点看详情、
// 在此分叉、一句话自然语言改树（引擎改完静默写回，屏内重取）。解析不出结构时回退显示原文。
// v1.6：逐轮快照索引（GET /api/history）驱动「快照 #seq · 第 N 轮」标注与原地精确回退（POST restore，
//       两步确认；覆盖三文件后由 store 补发「继续世界：」让引擎重新读档同步）；有快照的节点「在此分叉」
//       自动携带 seq（无快照保持旧载荷）；当前章节点 > 40 默认降级为
//       列表模式（可切回图形）；图形模式支持滚轮缩放（指针锚点）/拖拽平移/放大·缩小·适应/双击与 +/-/0；
//       节点 roving tabIndex + 方向键移动 + Enter 开详情。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { motion } from "framer-motion";
import { Maximize2, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { fetchHistory, fetchTree, type WorldSnapshotMeta } from "../lib/acp";
import {
  parseStoryTree,
  type StoryTree,
  type TreeChapter,
  type TreeNode,
  type TreeNodeStatus,
} from "../lib/parser";
import { fitView, layoutTree, panView, viewBoxOf, zoomViewAt, type LayoutNode, type TreeLayout, type TreeView } from "../lib/treeLayout";
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

/** 节点上挂的快照引用：最早匹配快照的序号与「第几轮」 */
interface SnapshotRef {
  seq: number;
  turn: number;
}

/** beat/梗概太长时截断（SVG 文字与列表行都不会自动省略） */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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

  /** 节点 aria-label：状态 +（有快照时）快照轮次——读屏用户也能听出「这个点能不能精确回退」 */
  const nodeLabel = (id: string, status: TreeNodeStatus): string => {
    const snap = snapshotOf.get(id);
    return `节点 ${id} · ${status}${snap ? ` · 快照 #${snap.seq} · 第 ${snap.turn} 轮` : ""}`;
  };

  return (
    <div ref={wrapRef} data-testid="tree-canvas-wrap" onKeyDown={onCanvasKeyDown} className="mt-3">
      {/* 工具条：图例 + 缩放 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] tracking-[.1em] text-ink/45">
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
            className="rounded-md border border-white/10 p-1.5 text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
          >
            <ZoomOut size={12} />
          </button>
          <button
            type="button"
            data-testid="tree-zoom-in"
            aria-label="放大"
            onClick={() => zoomBy(ZOOM_STEP)}
            className="rounded-md border border-white/10 p-1.5 text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
          >
            <ZoomIn size={12} />
          </button>
          <button
            type="button"
            data-testid="tree-zoom-fit"
            onClick={fit}
            className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
          >
            <Maximize2 size={12} /> 适应
          </button>
          <span data-testid="tree-zoom-level" className="ml-1 w-10 text-right text-ink/40">
            {Math.round(view.zoom * 100)}%
          </span>
        </span>
      </div>

      <p className="mb-1.5 text-[11px] tracking-[.05em] text-ink/30">滚轮缩放 · 拖拽平移 · 双击复位 · 方向键走节点</p>

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
              className="cursor-pointer outline-none"
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
              <text x={ln.x + 12} y={ln.y + 24} style={{ fill: "var(--ink)" }} fontSize={13} fontWeight={600} letterSpacing="0.06em">
                节点 {ln.id}
              </text>
              <text x={ln.x + 12} y={ln.y + 46} style={{ fill: "var(--ink)", opacity: 0.62 }} fontSize={11.5}>
                {truncate(ln.node.beat || ln.node.synopsis || "（无拍点）", 16)}
              </text>
              <text x={ln.x + 12} y={ln.y + 63} style={{ fill: "var(--ink)", opacity: 0.4 }} fontSize={10}>
                {ln.node.status}
                {ln.node.location ? ` · ${truncate(ln.node.location, 8)}` : ""}
                {snapshotOf.has(ln.id) ? ` · #${snapshotOf.get(ln.id)!.seq}` : ""}
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
          <p className="text-[11px] tracking-[.2em] text-ink/45">
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
                  aria-label={`节点 ${ln.id} · ${ln.node.status}${snap ? ` · 快照 #${snap.seq} · 第 ${snap.turn} 轮` : ""}`}
                  onClick={() => onFocus(ln.id)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors ${
                    isCurrent ? "border-[color:var(--accent2)]/60 bg-white/[.05]" : "border-white/[.08] hover:border-gold/40"
                  }`}
                >
                  <span className="w-12 flex-none tracking-wide text-gold">{ln.id}</span>
                  <span className="w-28 flex-none truncate text-ink/55">{ln.node.location || "（无地点）"}</span>
                  <span className="min-w-0 flex-1 truncate text-ink/80">
                    {truncate(ln.node.synopsis || ln.node.beat || "（无梗概）", 44)}
                  </span>
                  {snap && <span className="flex-none text-[11px] text-ink/40">快照 #{snap.seq}</span>}
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
      <dt className="flex-none text-[11px] tracking-[.2em] text-ink/45">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13.5px] text-ink/85">{value || "（暂无）"}</dd>
    </div>
  );
}

/**
 * 选中节点的详情侧栏：地点/在场/梗概/出边/状态 + 快照标注 + 在此分叉 / 回退到此节点。
 * 回退是破坏性动作（覆盖世界线三份文件）：两段确认，第一段只进确认态。
 */
function TreeDetail({
  node,
  engineBusy,
  snapshot,
  onFork,
  onRestore,
  onClose,
}: {
  node: TreeNode;
  engineBusy: boolean;
  snapshot: SnapshotRef | null;
  onFork: (id: string, seq?: number) => void;
  onRestore: (seq: number) => void;
  onClose: () => void;
}) {
  const canFork = node.status === "已走过";
  const [confirming, setConfirming] = useState(false);

  // 换节点就把确认态收掉：不该带着上一个节点的「确认回退」去点下一个
  useEffect(() => {
    setConfirming(false);
  }, [node.id]);

  return (
    <div data-testid="tree-detail" className="mt-4 rounded-xl border border-white/10 bg-[rgba(12,14,20,.72)] p-4">
      <div className="flex items-center gap-3">
        <h3 className="text-[15px] tracking-[.1em] text-ink">节点 {node.id}</h3>
        <span className="rounded-sm border border-white/15 px-1.5 py-0.5 text-[11px] text-ink/60">{node.status}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md border border-white/10 px-3 py-1 text-[12px] tracking-[.15em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
        >
          关闭
        </button>
      </div>

      {snapshot && (
        <p data-testid={`tree-snapshot-${node.id}`} className="mt-2 text-[12px] tracking-[.08em] text-gold/85">
          快照 #{snapshot.seq} · 第 {snapshot.turn} 轮
        </p>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DetailRow label="地点" value={node.location} />
        <DetailRow label="在场" value={node.present} />
      </dl>

      <div className="mt-3">
        <p className="text-[11px] tracking-[.2em] text-ink/45">梗概</p>
        <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink/85">{node.synopsis || "（暂无）"}</p>
      </div>

      <div className="mt-3">
        <p className="text-[11px] tracking-[.2em] text-ink/45">出边</p>
        {node.edges.length === 0 ? (
          <p className="mt-1 text-[13px] text-ink/50">（无出边，本章末端）</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {node.edges.map((e, i) => (
              <li key={i} className="text-[13px] text-ink/75">
                <span className="text-ink/50">{e.label || "（未命名）"}</span>
                <span className="mx-1.5 text-ink/30">→</span>
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
            className={`rounded-lg border px-4 py-2 text-[13px] tracking-[.1em] transition-colors ${
              engineBusy
                ? "cursor-not-allowed border-white/10 text-ink/35"
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
                className={`rounded-lg border px-4 py-2 text-[13px] tracking-[.1em] transition-colors ${
                  engineBusy
                    ? "cursor-not-allowed border-white/10 text-ink/35"
                    : "border-red-400/50 bg-red-400/15 text-red-300 hover:bg-red-400/25"
                }`}
              >
                确认回退（先备份当前）
              </button>
              <button
                type="button"
                data-testid={`tree-restore-cancel-${node.id}`}
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-white/10 px-3 py-2 text-[12.5px] tracking-[.1em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
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
              className={`rounded-lg border px-4 py-2 text-[13px] tracking-[.1em] transition-colors ${
                engineBusy
                  ? "cursor-not-allowed border-white/10 text-ink/35"
                  : "border-white/15 text-ink/70 hover:border-gold/40 hover:text-ink"
              }`}
            >
              回退到此节点（原地）
            </button>
          ))}

        <span className="text-[11px] tracking-[.05em] text-ink/40">
          {snapshot ? "回退会覆盖世界线三份文件（先自动备份当前），并让引擎重新读档续演" : "分叉不推演，切换后从该节点续演"}
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

  // 当前章：优先带「当前进度」指针的章，否则取最后一章
  const chapter: TreeChapter | null = useMemo(() => {
    if (!tree || tree.chapters.length === 0) return null;
    const withCurrent = [...tree.chapters].reverse().find((c) => c.current);
    return withCurrent ?? tree.chapters[tree.chapters.length - 1];
  }, [tree]);

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
      <ScreenShell className="bg-bg/70">
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="text-sm tracking-[.1em] text-ink/50">先开始或继续一条世界线，再来看剧情图</p>
        </div>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell className="bg-bg/70">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="absolute inset-0 flex flex-col"
      >
        {/* 头部：标题 + 刷新/返回 */}
        <header className="flex items-center px-6 pt-7">
          <h2 className="text-xl tracking-[.4em] [text-indent:.4em]">剧情图 · {worldLabel || worldId}</h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={refreshTree}
              className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
            >
              <RefreshCw size={12} /> 刷新
            </button>
            <button
              type="button"
              onClick={closeOverlay}
              className="rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
            >
              返回
            </button>
          </div>
        </header>

        {/* 提示条：编辑摘要 / 分叉结果 / 回退结果 / 排队 */}
        {treeNotice && (
          <p
            data-testid="tree-notice"
            className="mx-6 mt-3 rounded-md border border-gold/25 bg-gold/10 px-3 py-1.5 text-[12px] tracking-[.05em] text-gold/90"
          >
            {treeNotice}
          </p>
        )}

        {/* 归档区：每章一行，横向滚动的紧凑药丸链 */}
        {tree && tree.archive.length > 0 && (
          <div data-testid="tree-archive" className="mx-6 mt-3 flex gap-2 overflow-x-auto pb-1">
            {tree.archive.map((line, i) => (
              <span
                key={i}
                className="whitespace-nowrap rounded-full border border-white/10 bg-white/[.03] px-3 py-1 text-[11.5px] text-ink/60"
              >
                {line}
              </span>
            ))}
          </div>
        )}

        {/* 分叉结果：可切到新世界线 */}
        {forkResult && (
          <div
            data-testid="tree-fork-result"
            className="mx-6 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2.5"
          >
            <p className="text-[13px] text-gold">
              已创建世界线 <span className="tracking-wide">{forkResult.worldId}</span>
            </p>
            <button
              type="button"
              data-testid="tree-switch"
              onClick={switchToFork}
              className="rounded-md border border-gold/35 bg-gold/15 px-3 py-1 text-[12.5px] text-gold transition-colors hover:bg-gold/30"
            >
              切到此世界线
            </button>
            <span className="text-[11px] tracking-[.08em] text-ink/45">分叉不推演，切换后从该节点续演</span>
          </div>
        )}

        {/* 主体：模式切换 → 画布/列表 → 详情 */}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          {loading && <p className="mt-6 animate-pulse text-sm text-ink/50">载入剧情树…</p>}

          {!loading && error && (
            <p data-testid="tree-error" className="mt-6 text-sm text-red-400">
              {error}
            </p>
          )}

          {/* 解析失败：回退显示原文 */}
          {!loading && !error && markdown !== null && tree === null && (
            <pre
              data-testid="tree-raw"
              className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-[rgba(12,14,20,.6)] p-4 text-[12.5px] leading-relaxed text-ink/70"
            >
              {markdown}
            </pre>
          )}

          {!loading && !error && tree && tree.chapters.length === 0 && (
            <p className="mt-6 text-sm text-ink/50">当前世界还没有可绘制的章节节点</p>
          )}

          {/* 大图（> 40 节点）：默认列表，并给出显式切换 */}
          {!loading && !error && tree && chapter && bigGraph && (
            <div data-testid="tree-view-toggle" className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-ink/50">
              <span>本章 {layout.nodes.length} 个节点，已切到列表模式</span>
              <button
                type="button"
                data-testid="tree-view-list"
                aria-pressed={mode === "list"}
                onClick={() => setModePref("list")}
                className={`rounded-md border px-3 py-1 tracking-[.15em] transition-colors ${
                  mode === "list" ? "border-gold/45 bg-gold/15 text-gold" : "border-white/10 text-ink/55 hover:border-gold/40"
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
                  mode === "graph" ? "border-gold/45 bg-gold/15 text-gold" : "border-white/10 text-ink/55 hover:border-gold/40"
                }`}
              >
                图形
              </button>
            </div>
          )}

          {!loading && !error && tree && chapter && mode === "graph" && (
            <TreeCanvas
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

          {focusNode && (
            <TreeDetail
              node={focusNode}
              engineBusy={engineBusy}
              snapshot={snapshotOf.get(focusNode.id) ?? null}
              onFork={forkAt}
              onRestore={(seq) => void restoreSnapshot(seq)}
              onClose={() => setTreeFocus(null)}
            />
          )}
        </div>

        {/* 底部输入行：一句话改树（引擎忙时排队） */}
        <div data-testid="tree-input" className="border-t border-white/[.06] px-6 py-4">
          {inputBlocked && (
            <p className="mb-2 text-right text-[11.5px] tracking-[.15em] text-ink/40">引擎忙，已排队，就绪后自动发送</p>
          )}
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="用一句话改这棵树…（例：在节点 3-1 后加一个雨夜遇袭的节点）"
              autoComplete="off"
              className="flex-1 rounded-lg border border-white/10 bg-[rgba(12,14,20,.8)] px-3.5 py-2.5 text-[15px] tracking-[.02em] outline-none transition-colors focus:border-gold/35"
            />
            <button
              type="button"
              data-testid="tree-send"
              disabled={inputBlocked}
              onClick={submit}
              className="rounded-lg border border-gold/35 bg-gold/15 px-5 text-[14px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink/30"
            >
              发送
            </button>
          </div>
        </div>
      </motion.div>
    </ScreenShell>
  );
}
