import { defineConfig } from "vitest/config";

// 单测配置：parser/crafting（node 环境）与组件测试（tests/ui.test.tsx 顶部 `@vitest-environment jsdom` pragma）共用。
// setupFiles 为 react 19.3 缺失的 React.act 打垫片——RTL 16 依赖它，见 tests/setup-react-act.mjs 注释。
// e2e（真引擎，Playwright）走 `npm run test:e2e`，由 CLI --exclude 与这里的 exclude 双重排除。
export default defineConfig({
  test: {
    setupFiles: ["tests/setup-react-act.mjs"],
    exclude: ["node_modules/**", "tests/e2e/**"],
    // 显式钉 NODE_ENV=test：本机 shell 若导出 NODE_ENV=production，React 会解析生产构建，
    // 组件测试（@testing-library + act 垫片）行为随之漂移；测试环境必须自洽、不依赖外部 shell。
    env: { NODE_ENV: "test" },
  },
});
