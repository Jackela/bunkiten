// 菜单内容区的 Tab 走位（v1.12）：Radix 的菜单项是 `tabIndex=-1`（焦点由 roving 组程序化驱动），
// 而菜单内容又会无条件 `preventDefault` 掉 Tab——不接手的话，Tab 在菜单里等于按了没反应。
// 本仓既有约定是「Tab 走项、Esc 收菜单」（见 tests/e2e-ui/worlds.spec.ts 的键盘用例，键位速查卡里也写着
// 「Tab 行内按钮与 ⋯ 菜单」）。走到两头就把 Tab 交还页面：把焦点搬到文档序里弹层之后（Tab）/ 之前
// （Shift+Tab）的第一个可聚焦元素上，菜单随之由 DismissableLayer 的 focusOutside 收掉——与手写版同形
// （那时菜单项是普通 button/a，Tab 天然走到行外并把菜单带走）。刻意**不**回绕：菜单不该是键盘陷阱（WCAG 2.1.2）。
//
// 为什么单独一个模块：世界线行的 ⋯ 菜单与命令轨的分组菜单（TopBar）共用这一份——两个菜单的键位只有一套，
// 各自手写一份迟早会漂。纯 DOM、不 import React（调用方把原生事件与菜单内容节点递进来），node 侧也能直测。
import { focusableElements } from "./focusTrap";

/**
 * 在菜单内容里走一次 Tab：焦点在菜单项之间前后移动，走到两端就把 Tab 交还页面。
 * 焦点不在任何菜单项上时（鼠标打开时 Radix 只聚焦弹层本身）：Tab 进首项、Shift+Tab 进末项。
 * @param {KeyboardEvent} event 已确认是 Tab 的按键事件（组字中的按键由调用方先挡掉）
 * @param {HTMLElement} content 菜单内容节点（Radix 的 DropdownMenu.Content 自己）
 */
export function tabThroughMenu(event: KeyboardEvent, content: HTMLElement): void {
  const doc = content.ownerDocument;
  const items = [...content.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
  const at = items.indexOf(doc.activeElement as HTMLElement);
  const next = items[at < 0 ? (event.shiftKey ? items.length - 1 : 0) : at + (event.shiftKey ? -1 : 1)];
  event.preventDefault(); // 焦点由下面两行决定；顺带让 Radix 的 Tab 处理让位（它只吞键、不搬焦点）
  if (next) {
    next.focus();
    return;
  }
  // 「之后/之前的第一个可聚焦元素」要排除弹层自己的后代：菜单项是 button，compareDocumentPosition
  // 对后代同样带 FOLLOWING 位，不过滤就会把自己再聚焦一遍
  const outside = focusableElements(doc.body).filter(
    (el) =>
      !content.contains(el) &&
      content.compareDocumentPosition(el) &
        (event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING),
  );
  (event.shiftKey ? outside[outside.length - 1] : outside[0])?.focus();
}
