import { defineConfig } from "vitest/config";

// 单测配置：parser/crafting（node 环境）与组件测试（tests/ui.test.tsx 顶部 `@vitest-environment jsdom` pragma）共用。
// setupFiles 为 react 19.3 缺失的 React.act 打垫片——RTL 16 依赖它，见 tests/setup-react-act.mjs 注释。
// e2e 三套都由 CLI --exclude 与这里的 exclude 双重排除：
//   真引擎冒烟 `tests/e2e/`（npm run test:e2e）· 假引擎 UI e2e `tests/e2e-ui/`（npm run test:e2e:ui）·
//   打包态 `tests/e2e-packaged/`（npm run test:e2e:packaged）。用 `tests/e2e*/**` 一条兜住全部，
//   免得新起一个 e2e-* 目录时 vitest 先把 Playwright 的 spec 收进来（上次就红在这里）。
export default defineConfig({
  test: {
    setupFiles: ["tests/setup-react-act.mjs"],
    // 排除：① 依赖树——`node_modules/**` 只盖根下那棵，`**/node_modules/**` 再兜住嵌套的（build/codex-acp
    // 是 scripts/stage-codex-acp.mjs 铺出来的**第二棵 node_modules**：codex-acp 与 zod 的源码里带 *.test.ts，
    // v1.11 实测被 vitest 收进来 11 个文件、全红——那是依赖自己的测试，不该算我们的口径）；
    // ② build/**——打包铺场目录整体不入测试发现；③ e2e 三套（见下）。
    exclude: ["node_modules/**", "**/node_modules/**", "build/**", "tests/e2e*/**"],
    // 显式钉 NODE_ENV=test：本机 shell 若导出 NODE_ENV=production，React 会解析生产构建，
    // 组件测试（@testing-library + act 垫片）行为随之漂移；测试环境必须自洽、不依赖外部 shell。
    env: { NODE_ENV: "test" },
    // 覆盖率（npm run test:coverage；provider 已装 @vitest/coverage-v8）：
    // - include 只圈仓库自有源码四棵树（src/server/shared/scripts）——tests/electron/dist 不在圈内，天然不进统计；
    // - exclude 是**覆盖率文件过滤**，与上面 test.exclude（测试发现）语义不同，别混用；
    //   *.d.ts/*.d.mts 是类型镜像、*.css 无可执行行，都不进统计；
    // - 阈值是「防下滑线」（2026-09 基线四舍五入 - 2pp，见 AGENTS.md 门禁），不是要硬拉高的指标：
    //   覆盖率下滑超过 2pp 才红，防止悄悄滑坡；主动提升覆盖率时记得同步上调。
    coverage: {
      provider: "v8",
      include: ["src/**", "server/**", "shared/**", "scripts/**"],
      exclude: ["**/*.d.ts", "**/*.d.mts", "**/*.css"],
      reporter: ["text", "html"],
      thresholds: { lines: 74, branches: 64, functions: 77, statements: 72 },
    },
  },
});
