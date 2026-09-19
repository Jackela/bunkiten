// 焦点陷阱（v1.8 a11y）：手写浮层共用的「Tab 关在容器里」能力。
// 依赖为零、不 import React（要 React 的那一层在同目录的 useFocusTrap.ts，这样本模块能保持纯 DOM，
// 将来 node 侧的脚本/用例可以直接 import），循环判定是纯函数——jsdom 与 node 都不实现 Tab 的默认行为，
// 浏览器里则靠 preventDefault 压住原生 Tab：两边走的是同一条路径，行为一致。
// 刻意**不**在这里做的两件事（补了会与现有属主冲突）：
//   ① Esc：关闭链的唯一属主是 src/App.tsx 的 window keydown（回想 → 角色 → 创作确认 → …）——
//      多一处 Esc 处理就是双触发；
//   ② 背景 inert / 滚动锁：属于防「Tab 逛到 TopBar」的另一半，v1.9 已落地但不在这层——
//      inert 是**渲染层**的属性（GameStage 的舞台层、ShellPage 的背景压制），
//      滚动锁是滚动容器上的 .scroll-locked 类（src/styles/global.css），两者都不需要事件监听，
//      塞进本模块只会让「Tab 关在容器里」这个单一职责变形。

/**
 * 可聚焦元素的选择器（与「浏览器 Tab 能到哪」对齐的宽松集合）。
 * 刻意不进这个名单的：`tabindex="-1"`（只能程序化聚焦，不是 Tab 站）、`disabled`、`type=hidden`。
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * 是否该当作「隐藏」跳过（文档序 ≠ 可聚焦序：有 `hidden`/`aria-hidden`/`display:none` 的子树整片不算）。
 * 注意判据里**不能**用 `offsetParent`：jsdom 没有排版、`offsetParent` 恒为 null，用它会把所有元素筛空。
 * 判据宁可宽松：多留一个看不见的元素最坏只是 Tab 停在它上面；误杀则会让键盘用户在层里「无路可走」。
 */
function isHidden(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.closest('[hidden], [aria-hidden="true"]')) return true;
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  // 浏览器里 checkVisibility 更准（父级 display:none 也一并算进）；jsdom 没有它，上面的判据已够用
  return typeof el.checkVisibility === "function" && !el.checkVisibility();
}

/**
 * 容器内的可聚焦元素，按文档序（DOM 顺序 = Tab 顺序：本仓没有一处用正 tabindex 改过顺序）。
 * 每次调用现算——层里的内容是活的（角色卡秘密展开/收起、列表刷新、按钮 disabled 态都在变）。
 * @param {HTMLElement} container 陷阱容器
 * @returns {HTMLElement[]} 可聚焦元素（无可聚焦元素时是空数组，不是 null）
 */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  const list: HTMLElement[] = [];
  for (const el of container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (isHidden(el)) continue;
    list.push(el);
  }
  return list;
}

/**
 * 循环决策（纯函数，本模块唯一需要单测的分支）：Tab/Shift+Tab 把焦点送去哪个下标。
 *
 * 回绕规则（两端都绕）：
 * - `current` 落在列表内：+1 / −1，越界回绕（末项 → 首项、首项 → 末项）；
 * - `current` 不在列表内（焦点在容器自身、或已经跑到层外）：Tab → 首项、Shift+Tab → 末项（把焦点拉回层里）；
 * - 列表为空：null（无处可去，调用方放行原生 Tab——空层上的「拦截」只剩吞键这一种后果）。
 *
 * @param {number} count 容器内可聚焦元素个数
 * @param {number} current 当前焦点元素在列表里的下标（不在列表内传 -1）
 * @param {boolean} shift 是否 Shift+Tab（反向）
 * @returns {number | null} 目标下标；空列表为 null
 */
export function nextFocusIndex(count: number, current: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/** 每个容器一份记录：refs 是引用计数（同一容器重复 trap 不叠监听），teardown 才真正拆 */
interface TrapRecord {
  refs: number;
  teardown: () => void;
}

const traps = new WeakMap<HTMLElement, TrapRecord>();

/**
 * 开一个焦点陷阱：焦点进容器 + Tab/Shift+Tab 在容器内循环，返回拆陷阱的清理函数。
 *
 * 行为：
 * - 激活时把焦点送进容器：第一个可聚焦元素；没有可聚焦子节点则落到容器自己身上（临时补 `tabindex="-1"`，
 *   拆陷阱时撤回）；
 * - 焦点已经在容器内则不动（重复激活不该把玩家从当前位置拽走）；
 * - 没有可聚焦子节点时 Tab 一律放行（nextFocusIndex 回 null 就早退，不 preventDefault）——拦下来也无处可去；
 * - Tab 的判定每次按键现算元素表（层内容会变），按下时 preventDefault 后自己搬焦点；
 * - 幂等：同一容器再 trap 一次只加引用计数、不叠监听；清理函数重复调用安全（第二次是 no-op）。
 *
 * @param {HTMLElement} container 陷阱容器（模态面板本体，不是遮罩）
 * @returns {() => void} 清理函数（拆掉本次引用；引用归零才真正摘监听）
 */
export function trapFocus(container: HTMLElement): () => void {
  const existing = traps.get(container);
  if (existing) {
    existing.refs += 1;
    return () => releaseTrap(container);
  }

  const items = focusableElements(container);
  let addedTabIndex = false;
  if (items.length === 0 && !container.hasAttribute("tabindex")) {
    container.setAttribute("tabindex", "-1");
    addedTabIndex = true;
  }
  const doc = container.ownerDocument;
  if (!container.contains(doc.activeElement)) {
    (items[0] ?? container).focus();
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || e.isComposing) return;
    const list = focusableElements(container); // 每次现算：层里的内容会变（秘密展开、列表刷新、按钮转 disabled）
    const active = doc.activeElement;
    const next = nextFocusIndex(list.length, active ? list.indexOf(active as HTMLElement) : -1, e.shiftKey);
    if (next === null) return; // 没有可聚焦子节点：放行原生 Tab（拦下来也无处可去，只会吞掉键盘用户的 Tab）
    e.preventDefault(); // 焦点由下面这行决定，别让浏览器再搬一次
    list[next].focus();
  };
  container.addEventListener("keydown", onKeyDown);

  traps.set(container, {
    refs: 1,
    teardown: () => {
      container.removeEventListener("keydown", onKeyDown);
      if (addedTabIndex) container.removeAttribute("tabindex");
      traps.delete(container);
    },
  });

  return () => releaseTrap(container);
}

/** 引用计数 −1；归零才 teardown（重复调用、对已拆过的容器调用都是安全的 no-op） */
function releaseTrap(container: HTMLElement): void {
  const record = traps.get(container);
  if (!record) return;
  record.refs -= 1;
  if (record.refs > 0) return;
  record.teardown();
}
