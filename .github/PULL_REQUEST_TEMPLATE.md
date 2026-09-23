<!-- 中文模板；保持简洁，够写清楚即可。 -->

## 变更概述

<!-- 做了什么、为什么。若修的是 issue，写 "Fixes #123"。 -->

## 影响的契约面

<!-- 勾选涉及的契约面，并列出已同步的位置；文档口径见 AGENTS.md「契约同步（改协议前必读）」表。 -->

- [ ] 无契约面变更（纯内部重构 / 样式 / 文档）
- [ ] 文本协议行（开局指令、`美术：` 指令、**【行动】** 段、`【图】`/`【清单】`/`【章】`/`【立绘】`/`【新剧本】`/`【树】`、`世界：`/`继续世界：`、`剧情：`）
- [ ] RULES（`server/protocol-lines.mjs`，入口 re-export）
- [ ] API / SSE（HTTP 路由、`AcpEvent` 类型、事件名）
- [ ] `state/` 布局（`state/worlds/<worldId>/…`、`index.json` 的 `snapshotLabels`、快照条目的 `prompt`、旧档兼容）
- [ ] 资产路径（`presets/<剧本 id>/assets/<类型>-<名字>.jpg`）

已同步的位置（按需删减）：

- [ ] `.grok/skills/bunkiten/SKILL.md`
- [ ] `src/lib/parser.ts` / `src/store/game.ts` / `src/lib/acp.ts`
- [ ] `tests/parser.test.ts`、`tests/crafting.test.ts`、`tests/server.test.ts` 等契约快照
- [ ] `docs/ARCHITECTURE.md`、`docs/adr/`、`CONTEXT.md`、`AGENTS.md`

## 测试与验证

<!-- 贴关键输出（用例数、构建结果）；真引擎 e2e 需本机已登录 grok CLI 或 Codex。 -->

- [ ] `npm test`（单测 + 集成 + 契约 lint 全绿）
- [ ] `npm run build`（`tsc -b && vite build`）
- [ ] `npm run typecheck:server`（动了 server / shared / scripts）
- [ ] `npm run test:e2e:ui`（改了前端流程 / 协议 / 测试 harness 时必跑；假引擎确定性，约 5 分钟）
- [ ] `npm run test:e2e`（3 条真引擎冒烟：Grok 快速开局 + Grok 章节制作 + Codex 1 回合，本机 6–12 分钟；**会花真 token**，缺登录态是 skip）
- [ ] 手工跑过：<!-- 例：npm run dev:electron → 新世界线 → 第一轮 → 剧情图 -->（未跑请说明）

## 截图或说明

<!-- 界面/画面类改动请附截图或短说明；纯后端改动可写「无」。 -->
