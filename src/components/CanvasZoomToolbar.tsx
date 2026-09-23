import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";

/**
 * 画布工具条（v1.13）：三枚缩放控件（缩小 / 放大 / 适应）+ 百分比读数。
 *
 * 抽的是**控件本身**，不是整行——两块画布的行的排布不同（剧情图是「图例……缩放」并带独立的一行提示，
 * 家谱是「缩放……提示」），行的外层样式由各屏自己给；本组件只保证三枚按钮的 testid、aria-label 与
 * 读数格式一致（`<prefix>-zoom-out|-zoom-in|-zoom-fit`、`<prefix>-zoom-level`），这样两块画布的行为
 * 能一起被同一套用例钉住。
 *
 * @param {object} props testIdPrefix 剧情图 `tree` / 家谱 `genealogy`；
 *   zoomPct 百分比读数（`Math.round(view.zoom * 100)`，来自 `useCanvasPanZoom`）；
 *   onZoomIn/onZoomOut/onFit 三个动作（同样是 `useCanvasPanZoom` 的 `zoomBy`/`fit`）；
 *   iconSize 图标尺寸（剧情图 14 / 家谱 13）；
 *   levelClassName 读数的类（两块画布给不同的宽，避免百分比位数变化时行内抖动）
 */
export function CanvasZoomToolbar({
  testIdPrefix,
  zoomPct,
  onZoomIn,
  onZoomOut,
  onFit,
  iconSize = 14,
  levelClassName = "ml-1 w-12 text-right text-ink-hint",
  className = "",
}: {
  testIdPrefix: "tree" | "genealogy";
  zoomPct: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  iconSize?: number;
  levelClassName?: string;
  /** 外层 span 的附加类（两块画布的行的排布不同：剧情图靠右、家谱靠左） */
  className?: string;
}) {
  const btn = "rounded-md border border-white/10 p-1.5 text-ink-hint transition-colors hover:border-gold/40 hover:text-ink";
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      <button type="button" data-testid={`${testIdPrefix}-zoom-out`} aria-label="缩小" onClick={onZoomOut} className={btn}>
        <ZoomOut size={iconSize} />
      </button>
      <button type="button" data-testid={`${testIdPrefix}-zoom-in`} aria-label="放大" onClick={onZoomIn} className={btn}>
        <ZoomIn size={iconSize} />
      </button>
      <button
        type="button"
        data-testid={`${testIdPrefix}-zoom-fit`}
        onClick={onFit}
        className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1.5 text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
      >
        <Maximize2 size={iconSize} /> 适应
      </button>
      <span data-testid={`${testIdPrefix}-zoom-level`} className={levelClassName}>
        {zoomPct}%
      </span>
    </span>
  );
}
