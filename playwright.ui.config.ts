import { defineConfig } from "@playwright/test";

// 假引擎确定性 UI e2e（tests/e2e-ui/）：进程由 tests/helpers/fake-stack.mjs 自管
// （假 ACP 引擎 + 真 acp-server + vite dev，全链路见 tests/integration/harness.mjs），
// 不用 webServer 字段。无真实引擎回合、秒级耗时——与真引擎冒烟（playwright.config.ts）分开跑，可进 CI。
// 默认 chromium（不设 channel）：CI 与本地都不依赖本机 Chrome；确定性测试不重试。
export default defineConfig({
  testDir: "./tests/e2e-ui",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  outputDir: "./test-results-ui",
});
