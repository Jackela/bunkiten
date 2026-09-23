# 参与开发

面向要改代码、写剧本或接手维护的人。玩家侧说明见 [QUICKSTART.md](QUICKSTART.md)；
架构真相（ACP 契约、文本协议、状态布局、API 一览）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；
AI 协作者（人用工具或 agent）从 [AGENTS.md](AGENTS.md) 进来。

技术栈：Electron 桌面壳 + React 前端 + 本机 Node 服务（`server/`，零依赖），叙事引擎经 ACP 协议跑在你自己的机器上。

## 1. 先把项目跑起来

需要 Node ≥ 23.6（`package.json` 的 `engines`；CI 用 Node 24）。

```bash
git clone https://github.com/Jackela/bunkiten.git
cd bunkiten
npm install
npm run dev:electron     # vite + Electron 并行
```

只想调前端界面：`npm run dev` 起 vite（浏览器里开），另起一个终端跑 `node server/acp-server.mjs`；
vite 会把 `/api`、`/img`、`/audio`、`/events` 代理到它（默认 `localhost:7800`）。

引擎有**三条入场**，任选一条（设置屏「引擎与密钥」里可切）：

1. **登录 Codex** —— `codex-acp` 随包分发、玩家零安装；用的是你终端里那份 ChatGPT 登录态（游戏自己的 `CODEX_HOME` 与你的 `~/.codex` 隔离）。
2. **终端登录 grok** —— 本机装好 grok CLI 后跑一次 `grok login`。
3. **自备密钥**（仅 grok 后端）—— 在设置屏填服务地址、密钥、模型名；落本机 `~/.bunkiten/credentials.json`（0700/0600，明文），不进仓库、不进世界线、不进导出包。

## 2. 门禁（交付前必须全绿）

| 命令 | 什么时候必须跑 |
|---|---|
| `npm run build` | 任何改动（`tsc -b && vite build`） |
| `npm run typecheck:server` | 动 `server/**`、`shared/**`、`scripts/**`（`tsconfig.server.json` 对这批 `.mjs` 开 strict checkJs，类型全靠 JSDoc） |
| `npm test` | 任何改动 —— 单测 + 集成全量 560+ 例，秒级；含 **契约 lint**（防漂移门禁，见 §4） |
| `npm run test:e2e:ui` | 动前端流程、文本协议或测试 harness —— 假引擎确定性 UI e2e（`tests/e2e-ui/`，21 个 spec），约 5 分钟；CI 也会跑 |
| `npm run test:e2e:packaged` | 动 `electron-builder.yml` / 打包布局 / 主进程 —— 打包态冒烟（跨平台：mac 出 `.app`、Windows 出 `win-unpacked`，定位见 `tests/helpers/packaged-app.mjs`）；mac 侧本机 opt-in、arm64 only，Windows 侧由 CI 的 `packaged-win` job 真跑 |
| `npm run test:e2e` | 动前端流程或协议时的真引擎冒烟 —— **会花真 token**：3 条（Grok 快速开局 + Grok 章节制作 + Codex 1 回合），Grok 两条约 6–12 分钟、Codex 一条约 3 分钟，视模型与网络。前置缺一即 **skip 而非失败**（`~/.grok/auth.json` / `~/.codex/auth.json`），`retries: 0` 不做静默重试 |
| `npm run shots` | 改了界面（前端流程 / 版式 / 文案）—— 重出 README 与 QUICKSTART 里的界面截图（`tests/e2e-shots/`，假引擎栈 + 仓库真素材，约 10 秒、零 token；产出 `docs/images/*.jpg` 要一起提交）。作者侧工具，**不进 CI** |
| `npm run test:coverage` | 可选 —— 同一批测试 + 覆盖率仪表（CI 用它替代 `npm test` 步骤并上传报告；阈值是「防下滑线」，配置在 `vitest.config.ts`） |
| `npm run doctor` | 改了 preset 结构或新增了剧本 —— 剧本体检查（作者侧 CLI，退出码非 0 ⟺ 有 error；warning 不拦发布，**刻意不进 CI**） |
| `npm run providers:export` | 改了 `shared/providers.mjs`（服务目录真源）—— 必须同批重生成并提交 `docs/providers.json`，契约 lint 断言两者深等 |

打包预检（产物在 `release/`）：`npm run dist:mac` / `npm run dist:win`；只出目录态用 `npm run dist:mac:dir` / `npm run dist:win:dir`。
正式产物由发版 workflow 双平台矩阵出，本地只作预检（mac 只出 arm64）。

## 3. 用例数是「下限」口径

`tests/contract.test.ts` 的 `CASE_GROUPS` / `CASE_TOTAL` 是**唯一维护点**：

- **加用例不用改任何文档**（文档可以停在旧数字）；
- **删用例**会在契约 lint 里红，先在该文件里压低对应分组的 floor；
- 文档里只留一句「单测 + 集成全量 N 例」的粗口径（README / AGENTS / ARCHITECTURE 各一句，N 不低于 `CASE_TOTAL`、不高于实际），**不许**写逐分组的用例数字——那是会烂的税。

## 4. 契约同步（改协议前必读）

文本协议是一组**逐字字符串**（开局指令、`美术：` 指令、`**行动**` 段、`【图】`/`【清单】`/`【章】`/`【立绘】`/`【新剧本】`/`【树】`/【曲】/【环境】/【音效】、`世界：`/`继续世界：`、`剧情：` 等），散在引擎 prompt、客户端解析器、服务端与测试快照里。任何一处单改都会让两侧对不上。

- **同步点总表在 [`AGENTS.md`](AGENTS.md) 的「契约同步（改协议前必读）」一节**（这里不复制，免得两份漂移）；
- 协议常量的唯一真源是 `shared/protocol.mjs`（改它即全链生效）；
- 引擎侧 prompt 是 `.grok/skills/bunkiten/SKILL.md` —— 它只读提示词、不 import 代码，所以 `RULES` 与 server 常量是**刻意的双份**，由契约 lint 逐字比对；
- `.grok/` 目录**只许放 `commands/` 与 `skills/`**：`--plugin-dir` 会把它当作 always trusted，往里加 hooks/MCP 等于对引擎无条件授予执行权。

## 5. 版本号与发版

**打 tag 即发版**：push 一个 `v<package.json version>` tag（或手动触发 `.github/workflows/release.yml`）→ `guard` 校验 tag 与版本号一致并跑 `npm test` → mac/win 各自打包（一律 `--publish never`）→ 合并校验和、建/更新 GitHub Release，并把 `docs/releases/<tag>.md` 当作发布说明。

打 tag 之前必须**同批**改这几处（`guard` 只兜得住第一项与版本号的一致性）：

| 位置 | 改什么 |
|---|---|
| `package.json` | `version`（惯用 `npm version --no-git-tag-version <版本>`，同时更新 `package-lock.json`） |
| `README.md` | 顶部 `> v<版本> —— …` 标语（本版 banner，整条换写） |
| `CHANGELOG.md` | 追加本版条目（只记史实；已发布版本的条目不回改） |
| `docs/releases/<tag>.md` | 新增本版发布说明（Release body 真源；缺失会回落到 gh 自动 notes） |
| git tag | 最后 `git tag v<版本> && git push --tags` |

签名与公证是**条件化**的（仓库配了 `CSC_LINK` / `APPLE_*` / `WIN_CSC_*` secrets 才走签名路径，否则显式未签名、构建照常成功）——怎么开、怎么验、为什么未签名包不能自动更新，见 [docs/RELEASING.md](docs/RELEASING.md)。

## 6. 提交与 PR

- 提交信息用 **Conventional Commits**（`feat:` / `fix:` / `docs:` / `chore:` / `test:` …），正文用中文写清「改了什么、为什么、验证结果」；一个提交/PR 一件事。
- PR 按 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) 勾「影响的契约面」与验证命令，附关键输出（用例数、构建结果）。
- 合并用 **squash**；提交信息里如实写测试结果，不写没跑过的命令。
- 提交信息**不挂任何工具/agent 的署名尾行**——本仓库不绑定具体的 CLI、harness 或 agent 工具。
- 不要提交：构建产物（`dist/`、`release/`、`test-results*/`）、运行时进度（`state/worlds/`）、本机凭据与 `.shell-session.json`，以及本机 agent 工具目录（`.commandcode/`、`.zcode/`，见 `.gitignore`）。
- 测试与文档里的**假密钥**写成短、不像真 key 的形状（`sk-no-plaintext-4f2a` 这类）：仓库开了 secret scanning 与 push protection，48 位随机串那种形状会在推送前被拦下——而哨兵本来就是给人看的假值，越不像真的越好。

## 7. 文档与裁决

| 路径 | 是什么 |
|---|---|
| `AGENTS.md` | AI 协作者导航：项目地图 + 契约同步表 + 门禁 |
| `docs/ARCHITECTURE.md` | 架构真相：ACP 契约、文本协议、状态布局、快照与回退、API 一览、打包布局 |
| `CONTEXT.md` | 领域词表（术语 → 定义 → _Avoid_ 反例）：改术语先改这里 |
| `docs/adr/` | 裁决记录：每个设计决定一篇 `<NNNN>-<kebab-case>.md`，编号递增 |
| `docs/ROADMAP.md` | 待办与决策清单（含「已落地」与「被否决」） |
| `docs/RELEASING.md` | 代码签名怎么开、怎么验（维护者向） |
| `CHANGELOG.md` | 逐版沿革（升序） |
| `QUICKSTART.md` | 玩家侧安装与上手指南 |
| `state/README.md` | 进度目录布局与回收站的手工恢复说明 |

新增 ADR 的惯例：`docs/adr/<NNNN>-<kebab-case>.md`，编号递增；**只记难以逆转、且「不写下来后人会问为什么」的裁决**，内容写清背景 / 裁决 / 代价 / 被否决的备选（篇幅自由，短到一段、长到几页都有）。

## 8. 安全与行为

- 漏洞请走 [SECURITY.md](SECURITY.md) 里的私密渠道（GitHub Security Advisories），**不要开公开 issue**。
- 参与讨论与提交请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
