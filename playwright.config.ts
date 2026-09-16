import { defineConfig } from "@playwright/test";

// 真引擎冒烟：进程由 tests/helpers/stack.mjs 自管（acp-server + vite），不用 webServer 字段。
// 回合耗时 60–150s：全局 300s、expect 120s（config 默认），「就绪」等待处显式放宽到 240s。
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
