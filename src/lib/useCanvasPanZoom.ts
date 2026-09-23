import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { fitView, panView, viewBoxOf, zoomViewAt, type TreeView } from "./treeLayout";

/** 缩放步进倍数（两块画布共用同一份：此前各一份、靠注释人工保持同步） */
export const CANVAS_ZOOM_STEP = 1.25;
/** 拖拽死区（px）：位移小于它仍算点选，不算拖拽 */
export const CANVAS_DRAG_SLOP = 4;

/** 画布几何与交互的对外面（回调与状态都在这里，调用方只负责渲染自己的节点/边） */
export interface CanvasPanZoom {
  /** 挂在 `<svg>` 上：滚轮监听与指针拖拽都认这个元素 */
  svgRef: RefObject<SVGSVGElement | null>;
  view: TreeView;
  /** `viewBoxOf(view, width, height)`——`<svg viewBox>` 直接用它 */
  viewBox: string;
  /** 工具条上的百分比读数 */
  zoomPct: number;
  fit: () => void;
  zoomBy: (factor: number, fx?: number, fy?: number) => void;
  /** 屏幕像素位移 → 布局坐标位移（viewBox 等比铺满，横竖同一个比例） */
  layoutDelta: (px: number) => number;
  onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
  /** 同时挂 `onPointerUp` 与 `onPointerCancel` */
  onPointerUp: () => void;
  /** 双击复位（= `fit`） */
  onDoubleClick: () => void;
  /**
   * 画布级键盘：只认 `+` / `=` / `-` / `_` / `0`。
   * **消费了就返回 true**（调用方随即 return，别再处理自己的方向键）；没接管返回 false。
   */
  onZoomKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => boolean;
  /**
   * 节点 `onClick` 里问一句「这一下是不是拖拽的收尾」：true = 该吞掉这次点击（不然平移顺手就把详情打开了）。
   * 取用即复位。
   */
  consumeDragged: () => boolean;
}

/**
 * 画布的「视图 + 指针/滚轮/键盘缩放」胶水层（v1.13 抽自剧情图的 `TreeCanvas` 与家谱的 `GenealogyCanvas`）。
 *
 * 为什么会有这个文件：两块画布此前各自手抄了同一套 ~100 行——视图 state、布局变化回「适应」、
 * 滚轮以指针为锚点缩放（必须非 passive，React 的 `onWheel` 在根上是被动的、`preventDefault` 无效）、
 * 拖拽死区与指针捕获、`+ - 0` 快捷键、屏幕像素→布局坐标换算，连魔数（1.25 / 4）都靠注释人工同步。
 * 几何数学早已共用（`lib/treeLayout.ts` 的 `fitView`/`zoomViewAt`/`panView`/`viewBoxOf`），缺的只是它的
 * React 外壳——本文件补的正是这一层，分层形状与 `lib/focusTrap.ts` + `lib/useFocusTrap.ts` 那对一致。
 *
 * 刻意**不**收进来的（两块画布真正的差异面，留在各自组件里）：roving tabIndex 与方向键走位
 * （剧情图按章节顺序、家谱按血缘 `genealogyStep`）、节点级键盘、节点/边渲染、图例、节点 ref 数组、
 * 家谱的渲染宽度上界盒。
 *
 * @param layout 布局（只取 `width`/`height`；两块布局纯函数都产出这两个字段）
 */
export function useCanvasPanZoom(layout: { width: number; height: number }): CanvasPanZoom {
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = layout;
  const [view, setView] = useState<TreeView>(() => fitView(width, height));
  /** 拖拽态：按下点 + 是否已越过死区；`draggedRef` 活到 click 之后（拖完那一下不算点选） */
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);

  // 布局换了（切章/切世界/改树/增删世界线）：回到「适应」，别让上一张图的缩放平移漂到新图上
  useEffect(() => {
    setView(fitView(width, height));
  }, [width, height]);

  const fit = useCallback(() => setView(fitView(width, height)), [width, height]);
  const zoomBy = useCallback(
    (factor: number, fx = 0.5, fy = 0.5) => setView((v) => zoomViewAt(v, factor, fx, fy, width, height)),
    [width, height],
  );

  // 滚轮缩放：以指针为锚点。必须自己挂非 passive 监听（React 的 onWheel 在根上是被动的，preventDefault 无效）。
  // 用 useLayoutEffect 而不是 useEffect：挂 DOM 监听属于「提交阶段就该做完」的事——被动 effect 由调度器择机
  // 冲刷，中间存在「画布已可见、监听还没挂上」的窗口。（本条**不是**那次滚轮用例 flake 的成因，探针已排除；
  // 但既然那个窗口真实存在，就按正确的形状写。）
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // 画布内滚轮 = 缩放，不滚页面
      const rect = el.getBoundingClientRect();
      // 指针在画布里的归一化落点；jsdom（rect 全 0）与旧浏览器退化为中心缩放
      const fx = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      const fy = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
      setView((v) => zoomViewAt(v, e.deltaY < 0 ? CANVAS_ZOOM_STEP : 1 / CANVAS_ZOOM_STEP, fx, fy, width, height));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [width, height]);

  /** 屏幕像素位移 → 布局坐标位移（viewBox 等比铺满，横竖同一个比例） */
  const layoutDelta = useCallback(
    (px: number): number => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0; // 量不到宽度就不平移，宁可不响应也不乱跳
      return (px * width) / view.zoom / rect.width;
    },
    [width, view.zoom],
  );

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    draggedRef.current = false;
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < CANVAS_DRAG_SLOP) return; // 死区内：还是点选
      d.moved = true;
      // 指针捕获让手滑出画布也能继续拖（老环境不支持就退化为画布内拖）
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 指针已失效（pointerId 不存在）：这轮拖拽按画布内拖继续
      }
    }
    setView((v) => panView(v, layoutDelta(dx), layoutDelta(dy), width, height));
    d.x = e.clientX;
    d.y = e.clientY;
  };

  const onPointerUp = () => {
    draggedRef.current = dragRef.current?.moved ?? false;
    dragRef.current = null;
  };

  /** 只认缩放三键；消费了返回 true（调用方据此 return，把方向键留给自己） */
  const onZoomKeyDown = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    switch (e.key) {
      // 「+」在不同键盘布局/主键盘区可能是 =，一起收
      case "+":
      case "=":
        e.preventDefault();
        zoomBy(CANVAS_ZOOM_STEP);
        return true;
      case "-":
      case "_":
        e.preventDefault();
        zoomBy(1 / CANVAS_ZOOM_STEP);
        return true;
      case "0":
        e.preventDefault();
        fit();
        return true;
      default:
        return false;
    }
  };

  const consumeDragged = (): boolean => {
    if (!draggedRef.current) return false;
    draggedRef.current = false;
    return true;
  };

  return {
    svgRef,
    view,
    viewBox: viewBoxOf(view, width, height),
    zoomPct: Math.round(view.zoom * 100),
    fit,
    zoomBy,
    layoutDelta,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick: fit,
    onZoomKeyDown,
    consumeDragged,
  };
}
