// 测试环境垫片：react 19.3.0 的构建没有导出 React.act，而 @testing-library/react 16 在模块加载时
// 直接读它（缺失就回退到 react-dom/test-utils 的 act 存根，一调用就抛「React.act is not a function」）。
// 这里在 RTL 加载前（setupFiles 先于测试文件执行）给 react 的 CJS 导出对象补一个最小 act：
// 用 react-dom 的 flushSync 强制同步冲刷渲染；返回值保持 RTL 依赖的 thenable 契约（见 act-compat.js）。
// 只在有 DOM 的环境（jsdom 测试文件）生效；纯 node 测试不触达 react。
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
