import { defineConfig } from "@playwright/test";

// 真引擎冒烟：进程由 tests/helpers/stack.mjs 自管（acp-server + vite），不用 webServer 字段。
// 回合耗时视模型与网络（经代理时明显更慢）：全局 300s/expect 120s 只是下限，
// spec 内用 test.setTimeout(900s) 与「就绪」600s 等待兜住慢回合。
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 300_000,
  expect: { timeout: 120_000 },
  retries: 1,
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  // 复用本机 Chrome，避免下载 chromium
  use: { channel: "chrome" },
});
