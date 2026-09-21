// 测试环境垫片（setupFiles，在测试文件与 @testing-library/react 之前执行）。两件事：
//   ① React.act —— react 19.3.0 的构建没有导出它，而 RTL 16 在模块加载时直接读
//      （缺失就回退到 react-dom/test-utils 的 act 存根，一调用就抛「React.act is not a function」）。
//      补一个最小 act：用 react-dom 的 flushSync 强制同步冲刷渲染；返回值保持 RTL 依赖的 thenable 契约。
//   ② jsdom 30.1.0 的焦点语义回补 —— 见文件下半段的《垫片 ②》，把 30.1.0 与真实浏览器的差异收敛回浏览器语义。
// 只在有 DOM 的环境（jsdom 测试文件）生效；纯 node 测试不触达 react，也不进 ②。
if (typeof globalThis.window !== "undefined") {
  const React = (await import("react")).default;
  const { flushSync } = await import("react-dom");
  if (typeof React.act !== "function") {
    React.act = (callback) => {
      let result;
      flushSync(() => {
        result = callback();
      });
      if (result && typeof result.then === "function") return Promise.resolve(result);
      return { then: (resolve) => resolve(undefined) };
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 垫片 ②：jsdom 30.1.0 的「视口占位」焦点语义回补（v1.10.x 回归的根因）
//
// 现象（原状：jsdom 30.1.0 下 tests/ui.test.tsx 5 例 WorldScreen 菜单用例红，30.0.1 全绿）：
//   ⋯ 菜单一旦「关掉 → 再打开」，第二次的 pointerdown 里菜单会被当场自己关掉
//   （aria-expanded 立刻回 false、弹层不在 DOM 里）。
//
// 根因链（三跳，全部有源码/实测出处）：
//   1. jsdom 30.1.0 改了「移除持有焦点的节点」后的收尾：Node-impl 的 `_removingSteps()` 把
//      `ownerDocument._lastFocusedElement` 置成 **Document 本身**（注释写着「用 Document 代表视口，
//      这样 activeElement 回落到 body、hasFocus() 保持 true」），30.0.1 的同一个位置（`_detach()`）
//      置的是 null（30.0.1 另在 Document 的 `_runPreRemovingSteps` 里把视口记到 body）。
//   2. 于是紧接着的 `element.focus()` 走 HTMLOrSVGElement-impl 的 focus()：`previous` = Document，
//      发的这发 blur/focusout 经 focusing.fireFocusEventWithTargetAdjustment 的
//      「Document → defaultView」目标调整（HTML 规范的 focus update steps 那条），
//      **事件的 target 直接变成 window，且 blur 不冒泡、就在 window 上走 at-target 相位**。
//   3. @radix-ui/react-menu 的菜单根有一句
//      `React.useEffect(() => { if (!open) return; const handleBlur = () => handleOpenChange(false);
//       window.addEventListener("blur", handleBlur); … }, [open])`（dist/index.mjs 的 Menu 组件）
//      —— Radix 把「window 收到 blur」当「窗口失焦 ⇒ 关掉菜单」。位移一次焦点就把菜单关了。
//
// 真实浏览器怎么走（Playwright + Chromium 实测，probe：焦点从视口移到元素 / 移走后再聚焦另一元素）：
//   两种情形都**一个 blur/focusout 都不发**（只发 focus/focusin）；只有「上一个焦点是活着的元素」时
//   才发 blur@那个元素。即：视口不是可聚焦元素，没有 blur 目标。jsdom 30.0.1 在这条路径上发的是
//   blur@body（不冒泡 ⇒ window 上非捕获的监听收不到），同样不影响 Radix；30.1.0 的 blur@window 是唯一
//   会把真实浏览器里不存在的「窗口失焦」信号喂给 window 监听的版本。
//
// 垫片做法（收敛到浏览器语义，不动 src）：在 focus() 入口把「Document 视口占位」当作「没有旧焦点」
// 走完这一拍，于是不发那发 blur/focusout；focus 结束时按 30.1 的原语义把焦点落到新元素
// （元素不可聚焦、focus() 白跑时，视口占位原样留着）。activeElement / hasFocus() / 其余事件一概不变，
// 只去掉浏览器里根本不存在的那发窗口级 blur。
// 出处：node_modules/jsdom/lib/jsdom/living/nodes/Node-impl.js 的 `_removingSteps()`、
//       …/nodes/HTMLOrSVGElement-impl.js 的 `focus()`、…/helpers/focusing.js 的
//       `fireFocusEventWithTargetAdjustment()`、node_modules/@radix-ui/react-menu/dist/index.mjs 的 Menu。
// 复访条件：jsdom 改了这处（不再用 Document 代表视口，或不再把 Document 目标调整成 window）就删掉本垫片，
// 重跑 tests/ui.test.tsx 确认仍然 150 passed。钉版已解除：package.json 为 ^30.1.0、dependabot ignore 已删。
// 二分表与回归记录见 docs/releases/v1.10.1.md（该版「依赖与钉版」注记）；本头部不再自带二分表，两边指涉对应。
if (typeof globalThis.window !== "undefined") {
  // 失败要响亮：setupFiles 每个测试文件都跑一次，垫片一旦静默失效（或只包上一部分），tests/ui.test.tsx 就
  // 会冒出 5 条与「拿不到 jsdom 内部实现」毫不相干的菜单红灯（Unable to find … world-menu-popup-…），排查
  // 成本高。判定口径：三个 focus 原型**都得**被本垫片包过 —— 含进来时已带标记的（第二次进来时三个都带标记，
  // 不能误判为失败，见下方 wrapped += 1）；少任何一层都抛。宁可一条自解释红灯，不要五条迷惑红灯。失败原因
  // 攒进 reasons，判定放在循环之后、任何 try 之外，避免被 catch 再吞掉。
  let wrapped = 0;
  const reasons = [];
  // jsdom 是 vitest 的 jsdom 环境自己在用的那份依赖（node_modules 外部化 → 共用同一个 require 缓存），
  // 所以这些子路径 import 拿到的就是当前窗口背后的实现类，不是另一份拷贝。
  // focus() 挂在 mixin 上，而 jsdom 用 mixin() **按值复制**描述符到 HTMLElement/SVGElement 的原型
  // （node_modules/jsdom/lib/jsdom/utils.js 的 mixin），所以两个消费方各要包一层，只包 mixin 不生效。
  const focusOwners = [
    "jsdom/lib/jsdom/living/nodes/HTMLOrSVGElement-impl.js",
    "jsdom/lib/jsdom/living/nodes/HTMLElement-impl.js",
    "jsdom/lib/jsdom/living/nodes/SVGElement-impl.js",
  ];
  for (const id of focusOwners) {
    let implementation;
    try {
      ({ implementation } = await import(id));
    } catch (error) {
      // 深路径 import 失败（jsdom 加了 exports 字段或挪走了这些文件）只记「未成功」，不中断其余两个
      reasons.push(`import ${id} 失败：${error?.message ?? error}`);
      continue;
    }
    const originalFocus = implementation?.prototype?.focus;
    if (originalFocus?.__browserFocusSemantics) {
      // 已是本垫片包过的（setupFiles 每个测试文件都跑一次，第二次进来时三个原型都带标记）→ 算成功，不能抛
      wrapped += 1;
      continue;
    }
    if (typeof originalFocus !== "function") {
      reasons.push(`${id} 的 implementation.prototype.focus 不是函数`);
      continue;
    }
    const focus = function focus(...args) {
      const ownerDocument = this._ownerDocument;
      // 「视口持有焦点」在 30.1.0 里就长这样：_lastFocusedElement 指着 Document 自己
      const viewportHoldsFocus = ownerDocument != null && ownerDocument._lastFocusedElement === ownerDocument;
      if (viewportHoldsFocus) ownerDocument._lastFocusedElement = null;
      try {
        return originalFocus.apply(this, args);
      } finally {
        // focus() 因为元素不可聚焦而早退时它没动过 _lastFocusedElement，视口继续代表焦点
        if (viewportHoldsFocus && ownerDocument._lastFocusedElement === null) {
          ownerDocument._lastFocusedElement = ownerDocument;
        }
      }
    };
    focus.__browserFocusSemantics = true; // 幂等标记：同一个原型被两条路径摸到时别包两层
    implementation.prototype.focus = focus;
    wrapped += 1;
  }
  if (wrapped < focusOwners.length) {
    // 只要有原型没包上就响亮报错：少任何一层都不是「无害降级」——例如少了 HTMLElement 那层，HTML 元素的
    // focus 会退回 30.1 旧语义，又变回 5 条迷惑红灯。判定放在循环之后、任何 try 之外，不会被 catch 吞掉。
    throw new Error(
      `jsdom 焦点语义垫片未生效（${wrapped}/${focusOwners.length}）：${reasons.join("；") || "有原型未能包装"}（jsdom 的 lib/jsdom/living/nodes/*-impl.js 路径/结构可能已变，见本文件顶部《垫片 ②》）`,
    );
  }
}
