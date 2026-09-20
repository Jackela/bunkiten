import { defineConfig } from "@playwright/test";

// 打包态 e2e（**opt-in，不进 CI**）：用 Playwright 的 _electron 直接启动 `npm run dist:mac:dir`
// 产出的 .app，断言窗口开、标题屏渲染、/app 静态托管与 resources/game 布局可读。
// 这是唯一覆盖「打包布局 + asar + 主进程 + 资源路径」的路径（dev 态走 vite、UI e2e 走假栈都绕开了它）。
//
// 为什么单独一份 config：它会真起一个 Electron 应用（要窗口会话、平台相关、还要先有产物），
// 与秒级的假引擎 UI e2e 完全不同的成本与前置，混在一起会拖慢 CI 的默认门禁。
// 用法：npm run test:e2e:packaged（前置：npm run dist:mac:dir，产物在 release/mac-<arch>/Bunkiten.app）
export default defineConfig({
  testDir: "./tests/e2e-packaged",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  outputDir: "./test-results-packaged",
});
