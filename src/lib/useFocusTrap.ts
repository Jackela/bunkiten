import { useEffect, type RefObject } from "react";
import { trapFocus } from "./focusTrap";

/**
 * 把焦点陷阱接到 React：`open` 为真且容器已挂载时开陷阱，关闭时拆掉并把焦点**归还**给开层前的那个元素。
 *
 * 为什么另开一个模块而不是塞进 focusTrap.ts：那个模块要能保持「不 import React」的纯 DOM 身份
 * （纯函数 + 事件监听，将来 node 侧脚本可直接 import）；React 适配只活在这里。
 *
 * 时机：拆陷阱走 effect 的 cleanup——`open` 由真转假那一拍（重新渲染的提交里同步跑），
 * 而不是等 AnimatePresence 的退场动画播完、节点真被卸载。那 250~350ms 里焦点已经不该留在正在消失的层里。
 * 代价写清楚：退场动画期间（层还在、陷阱已拆）Tab 能短暂走到层外，按现有动效时长可以接受。
 *
 * 归还的判据（不只是「无脑 focus 回去」）：
 * - 开层前焦点在 body/html = 本来就没聚焦谁（浏览器里 body 拿焦点是默认态）→ 不算「上一个元素」，不还；
 * - 触发器自己已经从 DOM 上消失（换屏、换世界线、列表重绘）→ 无处可还，不还；
 * - 玩家在层里时自己把焦点挪到了层外的另一个控件（少见的主动路径）→ 不抢回来；
 * - 其余（关层后焦点还在层里，或节点已卸载掉回 body）→ 还给开层前的那个元素。
 *
 * @param {boolean} open 层是否开着（传 store 里的开关：drawerOpen / charactersOpen / assetsPreview != null …）
 * @param {RefObject<T | null>} ref 层本体的 ref（模态面板/抽屉，不是遮罩层——遮罩不该收焦点）
 */
export function useFocusTrap<T extends HTMLElement>(open: boolean, ref: RefObject<T | null>): void {
  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return; // 容器还没挂上（渲染时机不同步）：这一拍不设陷阱，别把焦点扔到别人的头上
    const doc = container.ownerDocument;
    const previous = restoreTarget(doc.activeElement);
    const release = trapFocus(container);
    return () => {
      release();
      const active = doc.activeElement;
      if (!previous || !previous.isConnected) return;
      if (container.contains(previous)) return; // 「上一个元素」就在这层里：层一走它也没了
      if (active && active !== doc.body && active.isConnected && !container.contains(active)) return;
      previous.focus();
    };
  }, [open, ref]);
}

/** 值得归还焦点的「上一个元素」：body/html 不算（那是「哪都没聚焦」的默认态，还给它们等于没还） */
function restoreTarget(el: Element | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return null;
  return el;
}
