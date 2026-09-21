// 测试环境垫片：react 19.3.0 的构建没有导出 React.act，而 @testing-library/react 16 在模块加载时
// 直接读它（缺失就回退到 react-dom/test-utils 的 act 存根，一调用就抛「React.act is not a function」）。
// 这里在 RTL 加载前（setupFiles 先于测试文件执行）给 react 的 CJS 导出对象补一个最小 act：
// 用 react-dom 的 flushSync 强制同步冲刷渲染；返回值保持 RTL 依赖的 thenable 契约（见 act-compat.js）。
// 只在有 DOM 的环境（jsdom 测试文件）生效；纯 node 测试不触达 react。
//
// 为什么 jsdom 钉在 30.0.x（package.json 的 "~30.0.1" + .github/dependabot.yml 的 ignore）——
//   现象：jsdom 30.1.0 让 tests/ui.test.tsx 6 例红（其余 144 例全绿），且无一例是本垫片能兜的：
//     · WorldsScreen「改名 / 导出 / 导入」5 例（都走 Radix ⋯ 菜单）：行内改名聚焦显示名输入框、
//       编辑器键盘 Enter/Esc、改名失败留在原地、导出下载链接、⋯ 菜单 ARIA/走位/关闭语义；
//     · AudioManager「音效槽位兜底超时」（断言槽位释放时刻，8 ≠ 4）。
//   二分（同一批四个升级）：
//     | 配置                                   | tests/ui.test.tsx |
//     |----------------------------------------|-------------------|
//     | 四个升级一起装                          | 6 failed | 144 passed |
//     | jsdom 回退 30.0.1（framer-motion 13.4 留） | 150 passed        |
//     | framer-motion 回退 13.3.0（jsdom 30.1.0 留） | 6 failed        |
//   结论：病根只在 jsdom 30.1.0；framer-motion@^13.4.0 / lucide-react@^1.47.0 / electron@^44.4.2 三项升级干净可用。
//   嫌疑（未证实机制）：30.1.0 的 PointerEvent/事件派发等行为变化与 Radix 菜单开合、定时器时序相互作用。
//   复访条件：jsdom 30.2+ 修了这 6 例，或我们把这些用例适配到新事件行为后——届时删掉 dependabot 的
//   ignore 段、把 package.json 放开回 "~30.0.1" 之上（或 ^30.x），并重跑 tests/ui.test.tsx 确认 150 passed。
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
