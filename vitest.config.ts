import { defineConfig } from "vitest/config";

// 单测配置：parser/crafting（node 环境）与组件测试（tests/ui.test.tsx 顶部 `@vitest-environment jsdom` pragma）共用。
// setupFiles 为 react 19.3 缺失的 React.act 打垫片——RTL 16 依赖它，见 tests/setup-react-act.mjs 注释。
// e2e（真引擎，Playwright）走 `npm run test:e2e`，假引擎 UI e2e 走 `npm run test:e2e:ui`：
// 两套都由 CLI --exclude 与这里的 exclude 双重排除。
export default defineConfig({
  test: {
    setupFiles: ["tests/setup-react-act.mjs"],
    exclude: ["node_modules/**", "tests/e2e/**", "tests/e2e-ui/**"],
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
