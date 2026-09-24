// 世界线家谱画布（v1.13 从 WorldsScreen 抽出）：forkedFrom 血缘的森林画成 SVG。
// 与剧情图的 TreeCanvas 共用 lib/useCanvasPanZoom 的视图/指针/滚轮/键盘缩放（不另写一套几何）。
import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WorldEntry } from "../lib/acp";
import { genealogyStep, type GenealogyLayout } from "../lib/genealogy";
import { truncate } from "../lib/text";
import { forkPhrase, worldDisplayName } from "../lib/worlds";
import { CANVAS_ZOOM_STEP, useCanvasPanZoom } from "../lib/useCanvasPanZoom";
import { CanvasZoomToolbar } from "./CanvasZoomToolbar";

/** 家谱节点绘制尺寸：须与 layoutGenealogy 的缺省几何一致（布局定坐标、SVG 画矩形） */
export const GEN_NODE_W = 210;
export const GEN_NODE_H = 64;

/** 单节点最大渲染宽度（px）：家谱只有两三张卡时，`<svg w-full>` 会把 viewBox 等比放大到
    ~490px/节点（屏幕大半空着、卡片像放大的缩略图）。画布渲染宽度据此封顶，落回 260–280px 档。
    只封**上界**：森林更宽时这个上界够不着，画布照旧铺满可用宽度。 */
const GEN_MAX_NODE_PX = 270;

/**
 * 家谱画布（v1.7 / v1.8 缩放平移）：把 forkedFrom 血缘的森林画成 SVG——节点 = 圆角矩形卡
 * （显示名/章数/分叉徽章），边 = 父底边中点 → 子顶边中点的圆角拐弯。整图一个可 Tab 的节点
 * （roving tabIndex），方向键走节点（`genealogyStep` 的确定性规则）、Enter/点击选中。
 * 视图能力（滚轮缩放锚点 / 拖拽平移 / 双击复位 / ± 与「适应」按钮 / `+ - 0`）复用
 * `lib/treeLayout` 的 TreeView 纯函数与剧情图 TreeCanvas 的交互约定，不另写一套几何。
 *
 * 两条非显而易见的不变量：
 * 1) 画布渲染宽度**只封上界**（GEN_MAX_NODE_PX）：家谱小的时候 `<svg w-full>` 会把 viewBox
 *    等比放大到 ~490px/节点，封顶后落回 260–280px；森林更宽时上界够不着 → 照旧铺满可用宽度。
 * 2) 画布容器的键盘只认 `+ - 0`（缩放）；节点自己的按键只认方向键/Enter/Space（走位/选中）——
 *    两套键位不相交，节点没消费的按键照旧冒泡到容器，故与 `genealogyStep` 不抢键。
 * 焦点环走全局 :focus-visible（同 TreeCanvas）。
 * SVG 里的 fontSize 是 viewBox 坐标系里的数值、随画布整体缩放，故不走文字阶梯类。
 */
export function GenealogyCanvas({
  layout,
  worlds,
  presetTitle,
  focusId,
  onFocus,
}: {
  layout: GenealogyLayout;
  /** 当前清单：把 forkedFrom 的父线 id 换成分叉说明里的显示名 */
  worlds: WorldEntry[];
  presetTitle: string;
  focusId: string | null;
  onFocus: (id: string) => void;
}) {
  // 视图 + 指针/滚轮/键盘缩放全在共享 hook 里（与剧情图画布同一份实现，见 lib/useCanvasPanZoom.ts）
  const canvas = useCanvasPanZoom(layout);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const ids = useMemo(() => layout.nodes.map((n) => n.worldId), [layout.nodes]);
  // roving tabIndex：没选中时落在第一个节点
  const tabbableId = focusId && ids.includes(focusId) ? focusId : ids[0];

  /** 方向键步进：换选中并把 DOM 焦点一起搬过去（不是只换描边） */
  const step = (id: string, dir: "up" | "down" | "left" | "right") => {
    const next = genealogyStep(layout, id, dir);
    if (!next) return;
    onFocus(next);
    nodeRefs.current.get(next)?.focus();
  };

  const onNodeKey = (id: string) => (e: ReactKeyboardEvent<SVGGElement>) => {
    if (e.nativeEvent.isComposing) return; // 中文输入法组字中的按键不算导航
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        step(id, "up");
        return;
      case "ArrowDown":
        e.preventDefault();
        step(id, "down");
        return;
      case "ArrowLeft":
        e.preventDefault();
        step(id, "left");
        return;
      case "ArrowRight":
        e.preventDefault();
        step(id, "right");
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        onFocus(id);
        return;
      default:
        return;
    }
  };

  /**
   * 画布键盘：`+`/`=` 放大、`-`/`_` 缩小、`0` 适应（都在共享 hook 里）。
   * 与节点级按键（方向键/Enter/Space）不相交，节点未消费的按键冒泡到这里 —— 两套键位可以共存。
   */
  const onCanvasKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return; // 中文输入法组字中的按键不算快捷键
    canvas.onZoomKeyDown(e);
  };

  /** 渲染宽度上界：单节点 ≤ GEN_MAX_NODE_PX（`layout.width × (270 / 210)`；forest 更宽时上界不起作用） */
  const maxRenderW = Math.round(layout.width * (GEN_MAX_NODE_PX / GEN_NODE_W));

  return (
    <div data-testid="genealogy-canvas-wrap" onKeyDown={onCanvasKey} className="mt-1">
      {/* 工具条：缩放控件 + 鼠标/键盘提示。提示放这一行（画布之上）而不是屏脚：
          画布高时屏脚会被顶到折叠线以下，1440×900 不滚动就看不到 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-meta tracking-[.05em] text-ink-hint">
        <CanvasZoomToolbar
          testIdPrefix="genealogy"
          zoomPct={canvas.zoomPct}
          onZoomIn={() => canvas.zoomBy(CANVAS_ZOOM_STEP)}
          onZoomOut={() => canvas.zoomBy(1 / CANVAS_ZOOM_STEP)}
          onFit={canvas.fit}
          iconSize={13}
          levelClassName="ml-1 w-10 text-right"
        />
        <span className="ml-auto">滚轮缩放 · 拖拽平移 · 双击复位 · 方向键走节点</span>
      </div>

      {/* 上界盒子（只封渲染宽度，mx-auto 居中）：森林更大时上界够不着，照旧铺满可用宽度 */}
      <div data-testid="genealogy-canvas-cap" className="mx-auto w-full" style={{ maxWidth: `${maxRenderW}px` }}>
        <svg
          ref={canvas.svgRef}
          data-testid="genealogy-canvas"
          viewBox={canvas.viewBox}
          preserveAspectRatio="xMidYMid meet"
          className="block w-full cursor-grab touch-none rounded-xl border border-white/[.06] bg-panel active:cursor-grabbing"
          style={{ height: "auto", aspectRatio: `${layout.width} / ${layout.height}` }}
          onPointerDown={canvas.onPointerDown}
          onPointerMove={canvas.onPointerMove}
          onPointerUp={canvas.onPointerUp}
          onPointerCancel={canvas.onPointerUp}
          onDoubleClick={canvas.onDoubleClick}
        >
          {layout.edges.map((e, i) => (
            <path
              key={`${e.from}->${e.to}-${i}`}
              className="genealogy-edge"
              d={e.d}
              fill="none"
              style={{ stroke: "rgba(236,231,219,.25)" }}
              strokeWidth={1.4}
              strokeDasharray={e.dashed ? "4 4" : undefined}
            />
          ))}

          {layout.nodes.map((n) => {
            const focused = focusId === n.worldId;
            const missing = !n.entry.exists;
            const fork = n.entry.forkedFrom;
            const name = worldDisplayName(n.entry, presetTitle);
            const forkText = fork ? forkPhrase(fork, worlds, presetTitle) : "";
            // 徽章（⑂ / ⌫ ⑂）右对齐占掉约 3em：带徽章的卡显示名收窄到 10 字，
            // 否则 fontSize 14 的最宽字形（CJK ≈ 1em）会顶到徽章上
            const badged = Boolean(fork) || n.missingParent;
            return (
              <g
                key={n.worldId}
                data-testid={`genealogy-node-${n.worldId}`}
                role="button"
                tabIndex={n.worldId === tabbableId ? 0 : -1}
                aria-label={`世界线 ${name} · 第 ${n.entry.chapterNo} 章${forkText ? ` · ${forkText}` : ""}${
                  missing ? " · 目录缺失" : ""
                }`}
                onClick={() => {
                  // 拖完手抬起那一下不算点选（否则平移顺手就把节点选中了）
                  if (canvas.consumeDragged()) return;
                  onFocus(n.worldId);
                }}
                onKeyDown={onNodeKey(n.worldId)}
                ref={(el) => {
                  if (el) nodeRefs.current.set(n.worldId, el);
                  else nodeRefs.current.delete(n.worldId);
                }}
                className="cursor-pointer"
                opacity={missing ? 0.55 : 1}
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={GEN_NODE_W}
                  height={GEN_NODE_H}
                  rx={10}
                  style={{
                    fill: "rgba(236,231,219,.05)",
                    stroke: focused ? "var(--accent2)" : "rgba(236,231,219,.4)",
                    ...(missing && !focused ? { strokeDasharray: "5 4" } : {}),
                  }}
                  strokeWidth={focused ? 2.6 : 1.5}
                />
                {/* 显示名超长时截断（SVG text 不会自动省略）；n 按最宽字形（CJK ≈ 1em）估算 */}
                <text
                  x={n.x + 12}
                  y={n.y + 25}
                  style={{ fill: "var(--ink)" }}
                  fontSize={14}
                  fontWeight={600}
                  letterSpacing="0.06em"
                >
                  {truncate(name, badged ? 10 : 12)}
                </text>
                <text x={n.x + 12} y={n.y + 46} style={{ fill: "var(--ink)", opacity: 0.55 }} fontSize={12}>
                  第 {n.entry.chapterNo} 章
                </text>
                {/* 分叉徽章：只留「分叉了」这个信号（⑂），节点 id 不上屏；父线已删的孤儿前面加 ⌫ */}
                {badged && (
                  <text
                    data-testid={n.missingParent ? `genealogy-orphan-${n.worldId}` : undefined}
                    x={n.x + GEN_NODE_W - 12}
                    y={n.y + 25}
                    textAnchor="end"
                    style={{ fill: n.missingParent ? "rgba(248,113,113,.9)" : "var(--accent)", opacity: 0.9 }}
                    fontSize={12}
                    letterSpacing="0.08em"
                  >
                    {n.missingParent ? "⌫ ⑂" : "⑂"}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
