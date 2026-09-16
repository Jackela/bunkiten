<!-- 中文模板；保持简洁，够写清楚即可。 -->

## 变更概述

<!-- 做了什么、为什么。若修的是 issue，写 "Fixes #123"。 -->

## 影响的契约面

<!-- 勾选涉及的契约面，并列出已同步的位置；文档口径见 AGENTS.md「契约同步（改协议前必读）」表。 -->

- [ ] 无契约面变更（纯内部重构 / 样式 / 文档）
- [ ] 文本协议行（开局指令、`美术：` 指令、**【行动】** 段、`【图】`/`【清单】`/`【章】`/`【立绘】`/`【新剧本】`/`【树】`、`世界：`/`继续世界：`、`剧情：`）
- [ ] RULES（`server/acp-server.mjs`）
- [ ] API / SSE（HTTP 路由、`AcpEvent` 类型、事件名）
- [ ] `state/` 布局（`state/worlds/<worldId>/…`、`index.json`、旧档兼容）
- [ ] 资产路径（`presets/<剧本 id>/assets/<类型>-<名字>.jpg`）

已同步的位置（按需删减）：

- [ ] `.grok/skills/bunkiten/SKILL.md`
- [ ] `src/lib/parser.ts` / `src/store/game.ts` / `src/lib/acp.ts`
- [ ] `tests/parser.test.ts`、`tests/crafting.test.ts`、`tests/server.test.ts` 等契约快照
- [ ] `docs/ARCHITECTURE.md`、`docs/adr/`、`CONTEXT.md`、`AGENTS.md`

## 测试与验证

<!-- 贴关键输出（用例数、构建结果）；e2e 需本机已登录 grok CLI。 -->

- [ ] `npm test`（vitest 单测全绿）
- [ ] `npm run build`（`tsc -b && vite build`）
- [ ] `npm run test:e2e`（改了前端流程/协议时必跑；约 6 分钟真引擎冒烟）
- [ ] 手工跑过：<!-- 例：npm run dev:electron → 新世界线 → 第一轮 → 剧情图 -->（未跑请说明）

## 截图或说明

<!-- 界面/画面类改动请附截图或短说明；纯后端改动可写「无」。 -->
