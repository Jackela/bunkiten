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
// v1.13：节点详情多一个「回到这一幕并重演」（该条是 turn 条目、且之前还有 turn 条目才出现）——
//       与回退同一纪律（两段确认、忙碌禁用），退到这一幕开演前并重发当时的输入；输入随快照条目
//       落盘（docs/adr/0023），旧档那几幕点击后由 store 给一句降级提示。
// v1.13：展示层纯函数（章号/章标签、快照 → 幕号、节点 → 最早快照、对比基线）收进 `lib/tree-view`；
//       节点详情面板拆到 `TreeDetail`；底部「一句话改树」输入行拆到 `TreeEditBar`——它的草稿 state 跟着
//       自己走，敲字不再让整块 SVG 画布跟着重渲染（此前每按一键 = 整图重画）。
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import { fetchHistory, fetchTree, postSnapshotLabel, type WorldSnapshotMeta } from "../lib/acp";
import { parseStoryTree, type StoryTree, type TreeChapter, type TreeNode, type TreeNodeStatus } from "../lib/parser";
import { canReplaySnapshot } from "../lib/replay";
import { truncate } from "../lib/text";
import { layoutTree, type LayoutNode, type TreeLayout } from "../lib/treeLayout";
import {
  archiveKey,
  chapterItems,
  earliestSnapshotByNode,
  prevSnapshotSeq,
  STATUS_SLUG,
  type ChapterItem,
  type SnapshotRef,
} from "../lib/tree-view";
import { useAsync } from "../lib/useAsync";
import { resolveWorldLabel } from "../lib/worlds";
import { useGameStore } from "../store/game";
import { CANVAS_ZOOM_STEP, useCanvasPanZoom } from "../lib/useCanvasPanZoom";
import { CanvasZoomToolbar } from "./CanvasZoomToolbar";
import { ScreenShell } from "./ScreenShell";
import { TreeDetail } from "./TreeDetail";

/** 节点绘制尺寸：须与传给 layoutTree 的参数一致（布局定坐标、SVG 画矩形） */
const NODE_W = 210;
const NODE_H = 74;

/** 当前章节点超过这个数就默认列表模式（大图在小屏上连线糊成一团，先给可读的列表） */
const BIG_GRAPH_NODES = 40;

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
  // 视图 + 指针/滚轮/键盘缩放全在共享 hook 里（与家谱画布同一份实现，见 lib/useCanvasPanZoom.ts）
  const canvas = useCanvasPanZoom(layout);

  const ids = useMemo(() => layout.nodes.map((n) => n.id), [layout.nodes]);
  // roving tabIndex：整图只有一个可 Tab 的节点（选中节点；没选中时落在当前进度/首个节点）
  const tabbableId =
    treeFocus && ids.includes(treeFocus)
      ? treeFocus
      : chapter.current && ids.includes(chapter.current)
        ? chapter.current
        : ids[0];

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
    if (canvas.onZoomKeyDown(e)) return; // + = - _ 0 归画布（含 preventDefault）
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

        <CanvasZoomToolbar
          className="ml-auto"
          testIdPrefix="tree"
          zoomPct={canvas.zoomPct}
          onZoomIn={() => canvas.zoomBy(CANVAS_ZOOM_STEP)}
          onZoomOut={() => canvas.zoomBy(1 / CANVAS_ZOOM_STEP)}
          onFit={canvas.fit}
        />
      </div>

      {/* 操作提示：同样吃面板带（这行小字从前是屏上对比度最低的一处） */}
      <p className="shell-panel mb-2 rounded-xl px-3 py-1.5 text-meta tracking-[.05em] text-ink-hint">
        滚轮缩放 · 拖拽平移 · 双击复位 · 方向键走节点
      </p>

      <svg
        ref={canvas.svgRef}
        data-testid="tree-canvas"
        viewBox={canvas.viewBox}
        preserveAspectRatio="xMidYMid meet"
        className="w-full cursor-grab touch-none rounded-xl border border-white/[.06] bg-panel-soft active:cursor-grabbing"
        style={{ height: "auto", aspectRatio: `${layout.width} / ${layout.height}` }}
        onPointerDown={canvas.onPointerDown}
        onPointerMove={canvas.onPointerMove}
        onPointerUp={canvas.onPointerUp}
        onPointerCancel={canvas.onPointerUp}
        onDoubleClick={canvas.onDoubleClick}
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
                if (canvas.consumeDragged()) return;
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
              <text
                x={ln.x + 12}
                y={ln.y + 24}
                className="text-ui font-semibold tracking-[.06em]"
                style={{ fill: "var(--ink)" }}
              >
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
  const groups = STATUS_ORDER.map((status) => ({
    status,
    nodes: nodes.filter((n) => n.node.status === status),
  })).filter((g) => g.nodes.length > 0);

  return (
    <div data-testid="tree-list" className="mt-3 space-y-3">
      {groups.map((g) => (
        <div key={g.status} data-testid={`tree-list-group-${STATUS_SLUG[g.status]}`}>
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
                    isCurrent
                      ? "border-[color:var(--accent2)]/60 bg-white/[.05]"
                      : "border-white/[.08] hover:border-gold/40"
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

/**
 * 底部「一句话改树」输入行（v1.13 从主组件拆出）：草稿 state 住在自己这里，敲字只重渲染这一行——
 * 从前它和主组件共用 `value`，每按一键都会让主组件重渲染、连带整块 SVG 画布重画一遍（大树上明显卡顿）。
 * 发送走 store 的 sendTreeEdit（稳定引用），阻塞态由父层给。
 */
function TreeEditBar({ blocked, onSend }: { blocked: boolean; onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    setValue("");
    onSend(v);
  };
  return (
    <div data-testid="tree-input" className="border-t border-white/[.06] px-6 py-4">
      {blocked && <p className="mb-2 text-right text-meta tracking-[.15em] text-ink-hint">忙碌中，就绪后自动发送</p>}
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法选词的 Enter 不算发送
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          }}
          placeholder="用一句话改这棵树…（例：加一个雨夜遇袭的场景）"
          autoComplete="off"
          className="flex-1 rounded-lg border border-white/10 bg-panel-sunken px-3.5 py-2.5 text-body tracking-[.02em] transition-colors focus:border-gold/35"
        />
        <button
          type="button"
          data-testid="tree-send"
          disabled={blocked}
          onClick={submit}
          className="rounded-lg border border-gold/35 bg-gold/15 px-5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
        >
          发送
        </button>
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
  const rerollAt = useGameStore((s) => s.rerollAt);
  const switchToFork = useGameStore((s) => s.switchToFork);

  // 列表/图形：null=按图大小自动（>BIG_GRAPH_NODES 降级列表），点过切换就由玩家说了算（状态留在本屏）
  const [modePref, setModePref] = useState<"graph" | "list" | null>(null);
  // 选中的章节键（lib/tree-view 的 chapterItems 算出；null = 默认章：带进度指针的那一章，否则最后一章）
  const [chapterSel, setChapterSel] = useState<string | null>(null);
  // 被点过的归档药丸下标（归档只有目录信息，点它给一句实话——不装作能打开）
  const [archiveHint, setArchiveHint] = useState<number | null>(null);

  // 树与快照索引同一时机重取（世界切换 / 编辑完成（treeStamp 自增）/ 回退完成 / 手动刷新）。
  // 两个 key 都含 worldId 与 treeStamp；key=null（无世界线）时不取数（屏内直接给引导文案）。
  // 快照索引拉不到就是「没有快照」：老世界没有 history 目录（404）属正常降级，不占树的错误位、不打扰玩家
  const treeReq = useAsync(
    (signal) => fetchTree(worldId ?? "", signal),
    worldId ? `tree:${worldId}:${treeStamp}` : null,
    {
      // 重取（编辑完成 / 回退完成 / 手动刷新 / SSE treeEdited）**不清旧树**：画布留在原地，视图（缩放/平移）
      // 与 DOM 身份都不丢——从前的 resetOnKey 让旧树一清、画布随渲染守卫卸载，回来时视图被重新「适应」一遍，
      // 抓住旧节点的调用方（含测试）还会拿着一个已经摘下的 DOM。换世界线仍旧立刻清屏，见下面 treeData 的闸。
      mapError: (e) => {
        const msg = (e as Error).message || String(e);
        // 404 = 本章尚未规划出树：给玩家一句人话
        return msg.includes("404") ? "本章还没有剧情树（开演前规划后出现）" : `剧情树加载失败：${msg}`;
      },
    },
  );
  const historyReq = useAsync(
    (signal) => fetchHistory(worldId ?? "", signal),
    worldId ? `history:${worldId}:${treeStamp}` : null,
  );
  // 只采用「属于当前世界线」的那一份树：换世界线的那一刻 data 还是上一世界的（不清旧数据是为了重取不拆画布），
  // 用响应自带的 worldId 把它挡在门外——换世界线照旧立刻清屏（载入态），不会闪一下上一条世界线的节点。
  const treeData = treeReq.data && treeReq.data.worldId === worldId ? treeReq.data : null;
  const markdown = treeData?.markdown ?? null;
  const loading = treeReq.loading;
  const error = treeReq.error;
  // 屏上此刻有没有可画的东西（树本身，或解析失败时的原文回退）。加载占位只在「什么都没得画」时出现；
  // 重取时画布不拆，只在顶上补一行轻提示。
  const hasContent = markdown !== null;
  // 快照索引（逐轮回退用）；旧世界没有 history 目录 → 空数组，一切按现状降级。
  // useMemo 稳住空数组的引用：`?? []` 每次渲染都是新数组，会让下游 useMemo 每次都重算（exhaustive-deps 警告）
  const snapshots: WorldSnapshotMeta[] = useMemo(() => historyReq.data?.snapshots ?? [], [historyReq.data]);

  // 解析失败（返回 null）时屏内回退显示原文
  const tree: StoryTree | null = useMemo(() => (markdown ? parseStoryTree(markdown) : null), [markdown]);

  // 章节条目（章号 + 标签 + 本体 + 稳定键）：切换器、默认章、选中章与画布 key 共用一次解析。
  // 键规则在 lib/tree-view 的 chapterItems：章号唯一时用章号，重号时退回 `章号-下标`（保证 testid 逐项唯一、都点得开）
  const chapters: ChapterItem[] = useMemo(() => chapterItems(tree?.chapters ?? []), [tree]);

  // 默认章：带「当前进度」指针的那一章（进度可能在更早的章上），否则最后一章
  const defaultChapterIdx = useMemo(() => {
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (chapters[i]!.chapter.current) return i;
    }
    return chapters.length - 1;
  }, [chapters]);

  // 选中的章：按章节键认（重取树后仍指向同一章）；键消失就退回默认章。
  // 一处例外：`chapterItems` 的键在「章号由唯一变重号」时会长出下标后缀（`"3"` → `"3-1"`），旧键因此消失——
  // 此时按章号认回第一颗同号药丸，别让玩家的选中白白漂回默认章（与旧复合键在编辑下的表现对齐）。
  const chapterIdx = useMemo(() => {
    if (chapterSel === null) return defaultChapterIdx;
    const exact = chapters.findIndex((c) => c.key === chapterSel);
    if (exact !== -1) return exact;
    const no = Number(chapterSel);
    const byNo = Number.isFinite(no) ? chapters.findIndex((c) => c.no === no) : -1;
    return byNo === -1 ? defaultChapterIdx : byNo;
  }, [chapterSel, chapters, defaultChapterIdx]);

  const chapter: TreeChapter | null = chapters[chapterIdx]?.chapter ?? null;

  /** 画布 key：换章必回「适应」——两章画布尺寸恰好相同时 layout 依赖不会变，靠 key 强制重挂重置视图。
      用章节键（章号唯一即章号，重号才是章号-下标）而不是裸下标：画布 key 跟着内容走，重取树时不会错位 */
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
  // 重演入口的出现条件（v1.13）：这条是 turn 条目、且它之前还有 turn 条目（退到目标幕开演前才有意义）；
  // prompt 有无不在这里判——列表形状刻意不带（单条才带，见 docs/adr/0023），点击后由 store 降级提示
  const focusCanReplay = focusSnapshot !== null && canReplaySnapshot(snapshots, focusSnapshot.seq);

  /**
   * 切章：按章节键选中并收掉节点焦点（详情里的节点已经不在这一章里了），
   * 模式回到自动判定——否则在手选过列表的大章上切到小章，会卡在列表态而切换器（只在降级时出现）看不见。
   */
  const selectChapter = (key: string) => {
    setChapterSel(key);
    setTreeFocus(null);
    setModePref(null);
  };

  /**
   * 给存档点起名（v1.12）：写进世界索引后重取快照索引（刷新树屏的显示）。
   * @param {number} seq 快照序号
   * @param {string} label 名字（空串 = 清除）
   * @returns {Promise<string | null>} 错误文案；成功 null
   */
  const labelSnapshotFor = async (seq: number, label: string): Promise<string | null> => {
    if (!worldId) return "还没有世界线，命名无处可存";
    const r = await postSnapshotLabel({ worldId, seq, label });
    if (!r.ok) return r.error ?? "命名失败（服务端拒绝了这次改动）";
    refreshTree(); // 与「编辑完成」同一条刷新路径（treeStamp 自增 → 重取树与快照索引）
    return null;
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
            role="status"
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
                  data-testid={`tree-archive-${archiveKey(line, i)}`}
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
          {loading && !hasContent && <p className="mt-6 animate-pulse text-ui text-ink-hint">载入剧情树…</p>}

          {/* 重取（刷新/编辑完成/回退）时画布不拆：顶上补一行轻提示，不当成「还没加载」占掉屏体 */}
          {loading && hasContent && (
            <p data-testid="tree-refreshing" className="mt-6 animate-pulse text-meta tracking-[.1em] text-ink-hint">
              正在刷新剧情树…
            </p>
          )}

          {/* 错误照常上屏：重取失败时保留屏上旧树（画布不拆），只把错误条摆出来，不整块清空 */}
          {error && (
            <p data-testid="tree-error" className="mt-6 text-ui text-red-400">
              {error}
            </p>
          )}

          {/* 解析失败：回退显示原文 */}
          {markdown !== null && tree === null && (
            <pre
              data-testid="tree-raw"
              className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-panel-soft p-4 text-ui leading-relaxed text-ink-body"
            >
              {markdown}
            </pre>
          )}

          {tree && tree.chapters.length === 0 && (
            <p className="mt-6 text-ui text-ink-hint">当前世界还没有可绘制的章节节点</p>
          )}

          {/* 章节切换器：每一章都到得了（从前只画进度指针那一章）；进度章标「当前」 */}
          {chapters.length > 0 && (
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
                      active
                        ? "border-gold/45 bg-gold/15 text-gold"
                        : "border-white/10 text-ink-hint hover:border-gold/40 hover:text-ink"
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
              {tree && chapter && bigGraph && (
                <div
                  data-testid="tree-view-toggle"
                  className="mt-3 flex flex-wrap items-center gap-2 text-ui text-ink-hint"
                >
                  <span>本章 {layout.nodes.length} 个节点，已切到列表模式</span>
                  <button
                    type="button"
                    data-testid="tree-view-list"
                    aria-pressed={mode === "list"}
                    onClick={() => setModePref("list")}
                    className={`rounded-md border px-3 py-1 tracking-[.15em] transition-colors ${
                      mode === "list"
                        ? "border-gold/45 bg-gold/15 text-gold"
                        : "border-white/10 text-ink-hint hover:border-gold/40"
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
                      mode === "graph"
                        ? "border-gold/45 bg-gold/15 text-gold"
                        : "border-white/10 text-ink-hint hover:border-gold/40"
                    }`}
                  >
                    图形
                  </button>
                </div>
              )}

              {tree && chapter && mode === "graph" && (
                // key 跟章走：换章必回「适应」（见 chapterKey 注释）。重取（treeStamp 变）不换 key，
                // 画布不重挂——视图与 DOM 身份都留着。
                <TreeCanvas
                  key={chapterKey}
                  chapter={chapter}
                  layout={layout}
                  treeFocus={treeFocus}
                  snapshotOf={snapshotOf}
                  onFocus={setTreeFocus}
                />
              )}

              {tree && chapter && mode === "list" && (
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
                  canReplay={focusCanReplay}
                  onFork={forkAt}
                  onRestore={(seq) => void restoreSnapshot(seq)}
                  onReplay={(seq) => void rerollAt(seq)}
                  onEdit={(text) => sendTreeEdit(text, focusNode?.id)}
                  onLabel={labelSnapshotFor}
                  onClose={() => setTreeFocus(null)}
                />
              </aside>
            )}
          </div>
        </div>

        {/* 底部输入行：一句话改树（忙碌中排队）。草稿 state 在 TreeEditBar 内，敲字不重画画布 */}
        <TreeEditBar blocked={inputBlocked} onSend={sendTreeEdit} />
      </motion.div>
    </ScreenShell>
  );
}
