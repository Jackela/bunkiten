import { defineConfig } from "@playwright/test";

// 界面截图管线（**作者侧，不进 CI**）：用 tests/helpers/fake-stack.mjs 那套假引擎栈（假 ACP 引擎 +
// 真 acp-server + vite dev）把 README / QUICKSTART 要用的界面截图重出一遍，落 docs/images/*.jpg。
// 素材与剧本取自仓库真货（presets/rift-mark 与 twilight-throne 的 preset.md、立绘、背景、封面），
// 所以截出来是真实观感；零 token、确定性，不需要登录任何引擎。
//
// 为什么单独一份 config（而不并进 playwright.ui.config.ts）：那套是 CI 门禁（21 spec / 49 条，
// 秒级断言），这份是「产出资产」而非「守门」——失败没人该被拦住，产物也不该在 CI 里被重写。
// 目录名刻意取 e2e-shots：vitest.config.ts 的 exclude `tests/e2e*/**` 一条通配就把它挡在单测之外，
// 也不会被 test:e2e:ui 的 testDir 收走（e2e-ui 的 spec 数因此不变）。
// 用法：npm run shots（跑完自己看一眼 docs/images/ 里那六张）。
export default defineConfig({
  testDir: "./tests/e2e-shots",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  outputDir: "./test-results-shots",
});
