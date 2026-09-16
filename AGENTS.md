# bunkiten 协作导航

LLM 互动 AVG（文字冒险 / 视觉小说）：Electron 壳 + React 前端 + `grok agent` stdio（ACP）做叙事引擎。引擎是 prompt（skill），剧本是数据，进度是文件。

## 项目地图

| 位置 | 是什么 |
|---|---|
| `.grok/skills/bunkiten/SKILL.md` | 引擎全部真相：每轮协议（含【立绘】表情切换行）、客户端开局指令、章节与剧情树、美术与预载、素材重绘、剧本创作（创作模式）、导演层、状态纪律 |
| `.grok/commands/` | 元命令定义：/new-game /recap /presets /help |
| `server/acp-server.mjs` | ACP 客户端 + HTTP/SSE + `/img` 图片服务 + 资产落盘（`presets/<剧本 id>/assets/`，剧本 id 由提示词世界段嗅探；`RULES` 常量在此） |
| `electron/main.js` | 主进程：GAME_ROOT 定位、PATH 补齐、启动 acp-server、开窗口 |
| `electron-builder.yml` | 打包布局（extraResources → `resources/game/` 与 `app-dist/`）、双平台目标 |
| `src/lib/parser.ts` | 文本协议纯函数：开局（含世界段）/美术/重绘/章节规划/创作模式/续玩/剧情编辑指令构造、**行动** 解析与截断、【图】【清单】【章】【立绘】【新剧本】【树】协议行扫描与差分名拆分、`parseStoryTree` 容错解析（契约字符串所在） |
| `src/store/game.ts` | 状态机：段过滤、标记→画面、表情切换（【立绘】→差分）、选项→按钮、章节制作流水线与【章】切章、画廊重绘挂起、创作模式装配、世界线（继续/新世界）/剧情图 overlay、`awaitCommand` 切屏 |
| `src/lib/acp.ts` | HTTP/SSE 客户端与 `AcpEvent` / `Preset` / `WorldEntry` 类型，`fetchWorlds`/`postWorld`/`fetchTree`（世界线与剧情图屏） |
| `src/lib/treeLayout.ts` | 剧情树布局纯函数：最长路径分层 + 抗环 + 确定性坐标（`layoutTree`/`LayoutNode`/`LayoutEdge`），StoryTreeScreen 的 SVG 树图数据源 |
| `src/theme.ts` | 剧本主题（accent/accent2/motif）逐键兜底与 `--accent`/`--accent2` CSS 变量注入 |
| `src/components/` | 屏幕流 boot→title→worlds→protagonist→(crafting)→game 各屏与游戏 HUD，外加 overlay 屏 AssetsScreen（画廊：分组/inUse/大图/单项重绘）、CreationScreen（创作模式：打磨对话→装配清单→新剧本入轮播）与 StoryTreeScreen（剧情图：SVG 树图+节点详情+`剧情：`自然语言编辑+在此分叉）；WorldsScreen 世界线屏（列表/继续/新世界线/两段确认删除/键盘导航）、TitleScreen 封面卡带轮播、CraftingScreen 制作中屏、PortraitLayer 差分两级回退交叉淡入、Atmosphere 颗粒/暗角 |
| `src/components/motifs/` | motif 氛围层：summer/rune/imperial/aurora 四款纯 CSS 动画图案（`MotifLayer` 分发） |
| `presets/<dir>/preset.md` | 剧本数据：加剧本只改这里，无需动代码；同级 `assets/` 放该剧本的立绘/背景，`cover.jpg` 放封面 |
| `state/worlds/<worldId>/` | 世界线运行时进度：state.md / summary.md / story-tree.md 三文件，父级 `state/worlds/index.json` 存元数据（worldId/preset/title/chapterNo/lastPlayed/note/forkedFrom），引擎的 SSOT；旧扁平 `state/*.md` 首次启动一次性迁入 worlds/main/ |
| `presets/<id>/assets/` | 美术资产随剧本走：`<类型>-<名字>.jpg`（差分 `立绘-<角色>-<变体>.jpg`），封面同级 `cover.jpg`；顶层全局 `assets/` 池自 v1.5.1 起不再存在，老存档里的 `assets/<文件>.jpg` 只在当前剧本目录内只读兼容直服（不跨剧本扫描） |
| `tests/` | `parser.test.ts` 契约快照、`crafting.test.ts` 章节制作流水线、`server.test.ts` 世界线/协议解析、`treeLayout.test.ts` 布局纯函数、`ui.test.tsx` 组件（jsdom）单测；`setup-react-act.mjs` 为 react 19.3 缺失 `React.act` 打测试垫片；`e2e/smoke.spec.ts` 真引擎冒烟；`helpers/stack.mjs` 进程编排 |
| `vitest.config.ts` | 单测配置：`setupFiles` 加载 react act 垫片、排除 `tests/e2e/**`（e2e 走 Playwright） |
| `docs/ARCHITECTURE.md` | 架构真相：ACP 契约、文本协议契约、世界线与状态文件布局、API/SSE 一览、资产管线、打包布局、修改指引 |
| `docs/adr/0001-0008` | 裁决记录（kebab-case，编号递增）：剧情树骨架、全分支预生成、差分分层、表情由引擎驱动、缓存权威、世界线与分叉、剧情图、资产随故事走 |
| `CONTEXT.md` | 领域词表（术语 → 定义 → _Avoid_ 反例），改术语先改这里 |
| `.github/workflows/ci.yml` | CI：push/PR 跑 `npm ci` + `npm test` + `npm run build`（e2e 不在 CI，需本机登录引擎） |

历史遗留（`shell/` 网页原型、MVP 期 TUI 的 `play.bat` / `install.ps1` / `START-HERE.txt`）已全部删除：仓库只有 Electron 形态，导航不要再指向它们。

## 契约同步（改协议前必读）

文本协议是一组逐字字符串，散在多处，任何一处单独改动都会让引擎与客户端对不上。动它们之前先读 `docs/ARCHITECTURE.md` 的「文本协议契约」一节（开局指令四种变体、分项美术指令、章节协议、**行动** 格式、【图】标记规则、段过滤原理）。

| 你改的字符串 | 同步点 |
|---|---|
| 开局指令（`开局：《…》。主角卡：…` 等四种变体，含待命/跳过后缀） | `SKILL.md`「客户端开局指令」· `parser.ts` `buildCustomOpening`/`buildQuickOpening` · `tests/parser.test.ts` 字符串快照 |
| 分项美术指令（`美术：立绘 <名>` / `美术：背景 <名>` / `开演。` / 待命后缀） | `SKILL.md`「分项美术指令」· `parser.ts` `buildArtCommand`/`BUILD_START` · `tests/parser.test.ts` 字符串快照 |
| 章节协议（`规划：第 N 章。` / `【清单】立绘|<名>` / `【清单】背景|<名>` / `【章】第 N 章 完`） | `SKILL.md`【章节规划指令】【章节与剧情树】· `parser.ts` `parseManifest`/`parseChapterMark`/`buildPlanCommand` · `tests/parser.test.ts` 与 `tests/crafting.test.ts` 快照 |
| `**行动**` 选项段 | `SKILL.md`「每轮协议」+ `RULES` 第 1 句（`acp-server.mjs`）· `parser.ts` `parseOptions`/`stripOptionsBlock` |
| `【图】` 标记行 | `SKILL.md`「美术」「美术预载」+ `RULES` 第 3 句 · `parser.ts` `scanMarkers`/`finalMarkers` · `acp-server.mjs` `handleArtLine` 正则、`persistAsset` 落盘名与目标目录（`presets/<剧本 id>/assets/`，封面 `presets/<id>/cover.jpg`） |
| 差分与表情切换（`【清单】立绘\|<角色>-<变体>` / `美术：立绘 <角色>-<变体>` / `【立绘】<角色>\|<变体>`） | `SKILL.md`【章节与剧情树】【每轮协议】【美术】差分规则与导演层第 8 条 · `parser.ts` `splitAssetVariant` · `acp-server.mjs` `parseExpressionLine` → `expression` 事件 · `store/game.ts` `nextPortraitOnExpression` · `tests` 快照 |
| 重绘指令（`美术：重绘 <类型> <名>[-<变体>]` 与【图】第四段「重绘」） | `SKILL.md`【素材重绘】+ `RULES` 第 3 句 · `parser.ts` `buildRegenCommand` · `acp-server.mjs` `parseArtLine` regen 分支与 `persistAsset` 覆盖 · `tests` 快照 |
| 创作模式（`创作模式：进入剧本创作。` / `装配。` / `【新剧本】<id>`） | `SKILL.md`【剧本创作】+ `RULES` 第 3 句 · `parser.ts` `ENTER_CREATION`/`BUILD_ASSEMBLE`/`isProtocolLine` · `acp-server.mjs` `parsePresetAddedLine` → `presetAdded` 事件 · `tests` 快照 |
| 世界段与续玩指令（`世界：<worldId>。` / `继续世界：<worldId>。`） | `SKILL.md`【世界线】【启动流程】· `parser.ts` `buildCustomOpening`/`buildQuickOpening`（带 worldId 参数）/`buildResumeCommand` · `tests/parser.test.ts` 字符串快照 |
| 剧情编辑（`剧情：<指令>` / `【树】` 标记行） | `SKILL.md`【剧情编辑指令】· `parser.ts` `buildTreeEditCommand`/`isProtocolLine`（纳入【树】）· `acp-server.mjs` `parseTreeLine`/`handleArtLine` → `treeEdited` 事件 · `store/game.ts` 编辑回合不进历史 · `tests` 快照 |
| 世界路径（`state/worlds/<worldId>/…`） | `SKILL.md` 全文 state 路径 · `acp-server.mjs` `migrateLegacyState`/`listWorlds`/`forkWorld` 与索引 · `RULES`「世界纪律」句 |
| 资产路径（`presets/<剧本 id>/assets/<类型>-<名>.jpg`；旧档 `assets/<文件>.jpg` 兼容） | `SKILL.md`【美术】生成前缓存检查与「资产目录纪律」+ `RULES` 第 3/4 句 · `acp-server.mjs` `assetRelPath`/`presetAssetsDir`/`presetIdFromPath`/`legacyAssetCandidates`/`sniffPreset`、`/api/assets?preset=` 必填（否则 400）、`/img` 白名单与旧档直服 · `lib/acp.ts` `fetchAssets(preset)`/`assetFileUrl`/`presetQuery` · `tests/server.test.ts` 快照 |
| 段过滤（旁白兜底） | `acp-server.mjs`（seg 计数与事件）· `store/game.ts`（`seg`/`chunk`/`turn_end` 处理） |

## 门禁

- 交付前跑 `npm run build`（`tsc -b && vite build`）。
- `npm test`：parser 59 + crafting 31 + server 51 + treeLayout 7 + ui 23（共 171 例）——改契约字符串必须同步改快照。
- `npm run test:e2e`：真引擎冒烟（约 6 分钟，2 个回合），改前端流程/协议后跑。
- 打包验证：`npm run dist:win` / `npm run dist:mac`，产物在 `release/`。
- CI（`.github/workflows/ci.yml`）在 push/PR 上跑 `npm ci` + `npm test` + `npm run build`；e2e 需要本机登录 grok CLI，只在开发机跑。

## 深入材料

- 动 ACP 会话、`/img` 解析顺序、资产管线（资产随剧本走与旧档兼容）、世界线状态布局、打包布局 → `docs/ARCHITECTURE.md` 对应章节
- 动引擎叙事行为（导演层、状态纪律、尺度）→ `.grok/skills/bunkiten/SKILL.md`
- 想知道某个设计被否决的备选方案 → `docs/adr/0001-0008`；术语口径 → `CONTEXT.md`
- 给玩家的安装说明 → `QUICKSTART.md`
