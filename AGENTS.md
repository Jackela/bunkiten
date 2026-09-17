# bunkiten 协作导航

LLM 互动 AVG（文字冒险 / 视觉小说）：Electron 壳 + React 前端 + `grok agent` stdio（ACP）做叙事引擎。引擎是 prompt（skill），剧本是数据，进度是文件。

## 项目地图

| 位置 | 是什么 |
|---|---|
| `.grok/skills/bunkiten/SKILL.md` | 引擎全部真相：每轮协议（含【立绘】表情切换行与音频三行）、客户端开局指令、章节与剧情树、美术与预载、素材重绘、剧本创作（创作模式）、音频（曲/环境/音效）、导演层、状态纪律 |
| `.grok/commands/` | 元命令定义：/new-game /recap /presets /help |
| `server/acp-server.mjs` | ACP 客户端 + HTTP/SSE + `/img` 图片与 `/audio` 音频直服 + 资产落盘（`presets/<剧本 id>/assets/`，剧本 id 由提示词世界段嗅探）+ 世界线索引/逐轮快照/导出导入（`state/worlds/<id>/history/`）；`RULES` 常量与推理分档（`pickEffort`/`EFFORT_PLANNING`）在此 |
| `electron/main.js` | 主进程：GAME_ROOT 定位、PATH 补齐、启动 acp-server、开窗口、打包态查更新（electron-updater，开发态与无 `app-update.yml` 的产物静默跳过） |
| `electron-builder.yml` | 打包布局（extraResources → `resources/game/` 与 `app-dist/`）、双平台目标、`publish: github`（更新通道前提）、`afterSign: electron/notarize.cjs` 公证钩子与 mac 签名/entitlements（`build/entitlements.mac.plist`） |
| `src/lib/parser.ts` | 文本协议纯函数：开局（含世界段）/美术/重绘/章节规划/创作模式/续玩/剧情编辑指令构造、**行动** 解析与截断、【图】【清单】【章】【立绘】【新剧本】【树】【曲】【环境】【音效】协议行扫描（`PROTOCOL_HEADS` 是唯一真源、`isProtocolLine` 由它构造）与差分名拆分、`parseStoryTree` 容错解析（契约字符串所在） |
| `src/store/` | 状态机（v1.6 拆成切片）：`game.ts` 只是组装点（初始 state、`isTypingTarget`、按序 `{...slice(ctx)}` 拼 store、公共 API 再导出），功能块在 `slices/{nav,world,tree,assets,creation,crafting,gameplay,characters}.ts`，跨片共享闭包与 watchdog/autoAdvance 定时器单例在 `context.ts`，字段类型在 `types.ts`、立绘纯函数在 `portrait.ts`。职责不变：段过滤、标记→画面、表情切换（【立绘】→差分）、选项→按钮、章节制作流水线与【章】切章、画廊重绘/批量挂起、创作模式装配、世界线（继续/新世界）/剧情图/设置 overlay、`awaitCommand` 切屏、重掷本回合（`rerollTurn`：restore 次新 turn 快照 + 重同步收尾后重发同一玩家输入，`lastTurnPrompt`/`pendingTurnPrompt`/`pendingRerollPrompt` 三字段记账）、角色面板抽屉（`characters.ts`：开合 + `/api/state` 取数，turn_end 面板开着重拉、`resetRunState` 清空）；组件与测试一律从 `store/game` import（公共 API 逐字未变） |
| `src/lib/acp.ts` | HTTP/SSE 客户端与 `AcpEvent` / `Preset` / `WorldEntry` / `WorldSnapshot` / `WorldBundle` / `AudioItem` / `StateView` 类型，`fetchWorlds`/`postWorld`/`fetchTree`（世界线与剧情图屏）、`fetchHistory`/`fetchSnapshot`/`worldExportUrl`/`postWorldImport`/`postWorldUpdate`（快照索引与单条全文、导出导入、改名）、`fetchAudio`/`audioFileUrl`（音频索引与直服 URL）、`fetchState`（角色面板的 state.md 解析视图） |
| `src/lib/audio.ts` | `AudioManager` 单例（v1.6，挂在 React 之外）：`setPreset`/`handle`/`stopAll`/`applySettings`；BGM 与环境各一对音频元素交叉淡入 ≈600ms（`FADE_MS`）、音效一次性（并发 ≤4、8s 兜底超时）、按 preset 记账（在途/就绪/已判定失败都不重拉）、索引里查不到「类型\|名」即静默 `console.debug` |
| `src/lib/settings.ts` | 设置模型与持久化（v1.6）：localStorage 键 `bunkiten.settings.v1`；`GameSettings`（master/bgm/ambient/sfx/muted/textSpeed/autoAdvance）、`DEFAULT_SETTINGS`、`normalizeSettings`（非法值逐键回默认，不迁移）、`loadSettings`/`saveSettings`、`TEXT_SPEED_MS`；设置是本机偏好，**不进世界线** |
| `src/lib/treeLayout.ts` | 剧情树布局纯函数：最长路径分层 + 抗环 + 确定性坐标（`layoutTree`/`LayoutNode`/`LayoutEdge`）+ 视图函数（`fitView`/`zoomViewAt`/`panView`/`viewBoxOf`），StoryTreeScreen 的 SVG 树图数据源 |
| `src/lib/genealogy.ts` | 世界线家谱布局纯函数（v1.7）：forkedFrom 森林分层 + 孤儿（父线已删，`missingParent`）与 fork 环容错 + 确定性整数坐标（`layoutGenealogy`/`GenealogyLayout`，层内 lastPlayed 降序）、圆角拐弯边路径，`genealogyStep` 给家谱键盘走位的确定性规则，WorldsScreen 家谱视图的 SVG 数据源 |
| `src/lib/diff.ts` | 快照对比纯函数（v1.7）：行级 LCS `diffLines(a, b)`（O(n·m) DP，add=b 新增、remove=a 独有，替换块 remove 在 add 前；空串/undefined 容错 0 行、尾部换行不算行）与 `diffStats`（+N −M 摘要），StoryTreeScreen 快照对比面板的数据源 |
| `src/theme.ts` | 剧本主题（accent/accent2/motif + v1.7 font 字体族/dialog 对话框质感）逐键兜底与 `--accent`/`--accent2`/`--font-preset` CSS 变量注入；`FONT_STACKS` 系统字体栈（mac/win + Linux Noto 兜底，离线无 webfont）、`dialogClass` 映射对话框质感类 |
| `src/components/` | 屏幕流 boot→title→worlds→protagonist→(crafting)→game 各屏与游戏 HUD，外加 overlay 屏 AssetsScreen（画廊：分组/inUse/大图/单项重绘 + 选择模式批量重绘（顺序队列）与批量删除）、CreationScreen（创作模式：打磨对话→装配清单→新剧本入轮播）、StoryTreeScreen（剧情图：SVG 树图+节点详情+`剧情：`自然语言编辑+在此分叉带快照 seq+快照标注与原地回退+与上一快照对比（`prevSnapshotSeq` 基线含 backup，三 tab diff、equal 折叠 ±2 行上下文）；>40 节点降级列表；滚轮锚点缩放/拖拽平移）与 SettingsScreen（设置屏：主音量/静音/BGM·环境·音效三滑杆/文本速度/自动前进，TopBar 齿轮进入）；WorldsScreen 世界线屏（列表/继续/新世界线/两段确认删除/行内改名 label·note/导出 `.world.json`/导入/键盘导航，v1.7 家谱视图：列表↔家谱切换、forkedFrom 森林 SVG、孤儿 ⌫ 徽章、方向键走节点 + Enter 选中、快捷条「继续」复用 `resumeWorld`）、TitleScreen 封面卡带轮播、CraftingScreen 制作中屏、CharactersDrawer 角色面板抽屉（游戏屏侧栏：好感度/表情徽章/秘密剧透折叠/导演手记/Flags·伏笔）、PortraitLayer 差分两级回退交叉淡入、Atmosphere 颗粒/暗角 |
| `src/components/motifs/` | motif 氛围层：summer/rune/imperial/aurora 四款纯 CSS 动画图案（`MotifLayer` 分发） |
| `presets/<dir>/preset.md` | 剧本数据：加剧本只改这里，无需动代码；同级 `assets/` 放该剧本的立绘/背景、`cover.jpg` 放封面、`audio/`（可选，作者手放）放该剧本音频 |
| `state/worlds/<worldId>/` | 世界线运行时进度：state.md / summary.md / story-tree.md 三文件 + `history/NNNN.json` 逐轮快照（4 位递增、append-only，存正戏回合的三文件全文），父级 `state/worlds/index.json` 存元数据（worldId/preset/title/chapterNo/lastPlayed/label/note/forkedFrom），引擎的 SSOT；旧扁平 `state/*.md` 首次启动一次性迁入 worlds/main/ |
| `presets/<id>/assets/` | 美术资产随剧本走：`<类型>-<名字>.jpg`（差分 `立绘-<角色>-<变体>.jpg`），封面同级 `cover.jpg`；顶层全局 `assets/` 池自 v1.5.1 起不再存在，老存档里的 `assets/<文件>.jpg` 只在当前剧本目录内只读兼容直服（不跨剧本扫描）。音频是**另一条管线**：同级 `presets/<id>/audio/`，不进 `assetRegistry`、`/api/assets` 不列 |
| `presets/<id>/audio/` | 剧本自带音频素材（v1.6，作者手放；rift-mark 自带三个合成示例 wav：`曲-夜灯谣`/`环境-雨夜檐滴`/`音效-翻页`，其余三个 preset 没有此目录 = 静默不播）：`<类型>-<名>.<ext>`，类型 ∈ 曲/环境/音效，ext ∈ mp3/ogg/m4a/wav/flac；server 只扫描（`scanPresetAudio`）与直服，不生成、不落盘、不进 assetRegistry |
| `tests/` | 单测：`parser.test.ts` 契约快照与协议头断言、`crafting.test.ts` 章节制作流水线与 store 公共 API、`server.test.ts` 世界线/协议解析/快照子系统/音频扫描/角色面板解析、`treeLayout.test.ts` 布局与视图纯函数、`genealogy.test.ts` 家谱布局与键盘步进纯函数、`diff.test.ts` 快照对比行级 LCS 纯函数、`ui.test.tsx` 组件（jsdom）、`contract.test.ts` 契约 lint（v1.6 防漂移门禁：协议头唯一真源/RULES 逐字副本/指令字符串双处/用例数与文档比对/设置键与音频扩展名，自身不计入 354 口径）；`setup-react-act.mjs` 为 react 19.3 缺失 `React.act` 打测试垫片；`e2e/smoke.spec.ts` 真引擎冒烟；`helpers/stack.mjs` 进程编排；`tests/e2e-ui/`（11 个 spec：`opening`/`settings`/`keyboard`/`gallery`/`story-tree`/`worlds`/`restore`/`reroll`/`reduced-motion`/`focus`/`characters` + `flow.ts` 屏幕流 helper，`playwright.ui.config.ts` 默认 chromium）假引擎确定性 UI e2e，进程由 `helpers/fake-stack.mjs` 编排（复用 `tests/integration/harness.mjs` 起假引擎+真 acp-server，再起 vite dev 代理过去；harness 的 seed 项 assets/audioFiles/trees/stateFiles/worlds/snapshots 在此消费） |
| `tests/integration/` | 进程级集成层（v1.6）：假 ACP 引擎（`fake-engine.mjs`，脚本化 `session/update`）+ 临时 PATH 垫片 `grok` + 真 `acp-server.mjs` 子进程（`harness.mjs` 注入 `GROK_GAME_ROOT`/`HOME`/`PORT`，SIGTERM 收尾），秒级、**随 `npm test` 跑**；`pipeline.test.ts`（【图】落盘/路径穿越/【立绘】/【新剧本】/【树】/sniffPreset/API 冒烟）、`audio-history.test.ts`（音频三行与 `/api/audio`·`/audio`、逐轮快照、精确 fork/restore、导出导入、label/note、素材删除）、`http-guard.test.ts`（跨站 403、body 413、history seq） |
| `vitest.config.ts` | 单测配置：`setupFiles` 加载 react act 垫片、排除 `tests/e2e/**`（e2e 走 Playwright）、钉 `NODE_ENV=test` |
| `docs/ARCHITECTURE.md` | 架构真相：ACP 契约、文本协议契约（含【曲】【环境】【音效】三行）、世界线与状态文件布局、逐轮状态快照与精确回退、世界线导出包、API/SSE 一览、资产与音频管线、打包布局与已知限制、修改指引 |
| `docs/adr/0001-0011` | 裁决记录（kebab-case，编号递增）：剧情树骨架、全分支预生成、差分分层、表情由引擎驱动、缓存权威、世界线与分叉、剧情图、资产随故事走、逐轮快照与精确分叉、音频协议、打 tag 即发版 |
| `CONTEXT.md` | 领域词表（术语 → 定义 → _Avoid_ 反例），改术语先改这里 |
| `.github/workflows/ci.yml` | CI：push/PR 跑 `npm ci` + `npm test`（含集成层）+ `npm run build` + `npx playwright install chromium` + `npm run test:e2e:ui`（假引擎确定性 UI e2e，随 CI 跑；真引擎 e2e 仍不在 CI，需本机登录引擎） |
| `.github/workflows/release.yml` | 发版（v1.6）：push `v*` tag（或手动 dispatch）→ guard 校验 tag == `v<package.json version>` 且 `npm test` 绿 → mac/win 矩阵打包（都 `--publish never`）→ 合并纯 LF `SHA256SUMS.txt` → 建/更新 GitHub Release |
| `docs/releases/` | 每版一篇发布说明 `docs/releases/<tag>.md`；release job 优先拿它当 Release body（其次是 gh api 自动 notes、最后兜底文案） |

历史遗留（`shell/` 网页原型、MVP 期 TUI 的 `play.bat` / `install.ps1` / `START-HERE.txt`）已全部删除：仓库只有 Electron 形态，导航不要再指向它们。

## 契约同步（改协议前必读）

文本协议是一组逐字字符串，散在多处，任何一处单独改动都会让引擎与客户端对不上。动它们之前先读 `docs/ARCHITECTURE.md` 的「文本协议契约」一节（开局指令四种变体、分项美术指令、章节协议、**行动** 格式、【图】标记规则、音频三行、段过滤原理），以及「逐轮状态快照与精确回退」「音频管线」两节。

| 你改的字符串 | 同步点 |
|---|---|
| 开局指令（`开局：《…》。主角卡：…` 等四种变体，含待命/跳过后缀） | `SKILL.md`「客户端开局指令」· `parser.ts` `buildCustomOpening`/`buildQuickOpening` · `tests/parser.test.ts` 字符串快照 |
| 分项美术指令（`美术：立绘 <名>` / `美术：背景 <名>` / `开演。` / 待命后缀） | `SKILL.md`「分项美术指令」· `parser.ts` `buildArtCommand`/`BUILD_START` · `tests/parser.test.ts` 字符串快照 |
| 章节协议（`规划：第 N 章。` / `【清单】立绘\|<名>` / `【清单】背景\|<名>` / `【章】第 N 章 完`） | `SKILL.md`【章节规划指令】【章节与剧情树】· `parser.ts` `parseManifest`/`parseChapterMark`/`buildPlanCommand` · `tests/parser.test.ts` 与 `tests/crafting.test.ts` 快照 |
| `**行动**` 选项段 | `SKILL.md`「每轮协议」+ `RULES` 第 1 句（`acp-server.mjs`）· `parser.ts` `parseOptions`/`stripOptionsBlock` |
| `【图】` 标记行 | `SKILL.md`「美术」「美术预载」+ `RULES` 第 3 句 · `parser.ts` `scanMarkers`/`finalMarkers` · `acp-server.mjs` `handleArtLine` 正则、`persistAsset` 落盘名与目标目录（`presets/<剧本 id>/assets/`，封面 `presets/<id>/cover.jpg`） |
| 差分与表情切换（`【清单】立绘\|<角色>-<变体>` / `美术：立绘 <角色>-<变体>` / `【立绘】<角色>\|<变体>`） | `SKILL.md`【章节与剧情树】【每轮协议】【美术】差分规则与导演层第 8 条 · `parser.ts` `splitAssetVariant` · `acp-server.mjs` `parseExpressionLine` → `expression` 事件 · `store/portrait.ts` `nextPortraitOnExpression` · `tests` 快照 |
| 音频三行（`【曲】<名>` / `【环境】<名>` / `【音效】<名>`，停止 `【曲】停`/`【环境】停`；文件名 `<类型>-<名>.<ext>`） | `SKILL.md`【音频】+ 导演层第 9 条 + 每轮协议第 2 条 + `RULES` 第 6 句（`acp-server.mjs` 逐字同一份）· `parser.ts` `PROTOCOL_HEADS`（9 项）/`AUDIO_KINDS`/`isProtocolLine` · `acp-server.mjs` `parseAudioLine`/`scanPresetAudio`/`GET /api/audio?preset=`/`GET /audio?p=`（白名单 + `path.resolve` 前缀 + MIME + 长缓存）、`handleArtLine` 的 audio 分支 → `audio` 事件 · `lib/audio.ts` `AudioManager`、`lib/acp.ts` `fetchAudio`/`audioFileUrl`、`store/slices/gameplay.ts` 的 `audio` 分支 · `tests/parser.test.ts`（协议头断言）、`tests/server.test.ts`、`tests/integration/audio-history.test.ts` |
| 重绘指令（`美术：重绘 <类型> <名>[-<变体>]` 与【图】第四段「重绘」） | `SKILL.md`【素材重绘】+ `RULES` 第 3 句 · `parser.ts` `buildRegenCommand` · `acp-server.mjs` `parseArtLine` regen 分支与 `persistAsset` 覆盖 · `tests` 快照 |
| 创作模式（`创作模式：进入剧本创作。` / `装配。` / `【新剧本】<id>`） | `SKILL.md`【剧本创作】+ `RULES` 第 3 句 · `parser.ts` `ENTER_CREATION`/`BUILD_ASSEMBLE`/`isProtocolLine` · `acp-server.mjs` `parsePresetAddedLine` → `presetAdded` 事件 · `tests` 快照 |
| 世界段与续玩指令（`世界：<worldId>。` / `继续世界：<worldId>。`） | `SKILL.md`【世界线】【启动流程】· `parser.ts` `buildCustomOpening`/`buildQuickOpening`（带 worldId 参数）/`buildResumeCommand` · `tests/parser.test.ts` 字符串快照 |
| 剧情编辑（`剧情：<指令>` / `【树】` 标记行） | `SKILL.md`【剧情编辑指令】· `parser.ts` `buildTreeEditCommand`/`isProtocolLine`（纳入【树】）· `acp-server.mjs` `parseTreeLine`/`handleArtLine` → `treeEdited` 事件 · `store/slices/gameplay.ts` 编辑回合不进历史 · `tests` 快照 |
| 世界路径（`state/worlds/<worldId>/…`） | `SKILL.md` 全文 state 路径 · `acp-server.mjs` `migrateLegacyState`/`listWorlds`/`forkWorld` 与索引 · `RULES`「世界纪律」句 |
| 逐轮快照与精确回退（`state/worlds/<worldId>/history/NNNN.json`，条目 `{seq,at,kind:"turn"\|"backup",nodeId,chapterNo,files}`） | 落盘与语义：`acp-server.mjs` `writeSnapshot`/`readSnapshot`/`readSnapshots`/`selectSnapshotForNode`/`forkWorld`/`restoreWorld`/`writeWorldFiles` + 正戏回合判定（`sendPrompt` 内 `flushArtLines()` 之后、`busy=false` 之前；引擎回 JSON-RPC error response 时按失败回合传播——error 事件 + 409 + 不写快照）· 端点 `GET /api/history?worldId=[&seq=]`、`POST /api/worlds {action:"fork"\|"restore"}` · `docs/ARCHITECTURE.md`「逐轮状态快照与精确回退」· 客户端 `lib/acp.ts` `fetchHistory`/`fetchSnapshot`/`WorldSnapshot`、`store/slices/tree.ts` `restoreSnapshot`（回退成功后补发 `继续世界：` 让引擎重读档）、`StoryTreeScreen` 的快照标注/原地回退/分叉带 seq、快照对比（v1.7：`prevSnapshotSeq` 基线含 backup + `lib/diff.ts` 行级 LCS + 三 tab 面板） · 回退后的客户端语义：history 非破坏式分割线（`types.ts` `HistoryRollbackMark` + `HistoryDrawer` 旧幕置灰）、`pendingResync`/`resyncFailed`（`gameplay.ts` turn_end 清除与 error 标记、`tree.ts` `retryResync`）、TopBar 徽章与「再同步」按钮、`WorldsScreen` 行内小标、treeNotice 三态 · `tests/server.test.ts`、`tests/integration/audio-history.test.ts`、`tests/diff.test.ts`、`tests/ui.test.tsx`、`tests/integration/pipeline.test.ts`（error response） |
| 世界线 label/note 与导出导入（`<worldId>.world.json`、`format:"bunkiten-world"` v1、label ≤60 / note ≤200） | `acp-server.mjs` `updateWorld`/`exportWorld`/`importWorld`（重名加 `-2`/`-3` 后缀、`files.state` 必须非空）· 端点 `POST /api/worlds {action:"update"\|"import"}`、`GET /api/worlds/export?worldId=` · `index.json` 的 `label`/`note` 与 `listWorlds` 回填 · `lib/acp.ts` `WorldBundle`/`worldExportUrl`/`postWorldImport`/`postWorldUpdate`、`store/slices/world.ts` `parseWorldBundle`、`WorldsScreen` 行内改名/导出/导入 · `tests/server.test.ts`、`tests/ui.test.tsx`、`tests/integration/audio-history.test.ts` |
| 设置键（localStorage `bunkiten.settings.v1`：master/bgm/ambient/sfx/muted/textSpeed/autoAdvance） | `lib/settings.ts`（`DEFAULT_SETTINGS`/`normalizeSettings`/`loadSettings`/`saveSettings`/`TEXT_SPEED_MS`）· `SettingsScreen.tsx` 与 TopBar 齿轮入口、`App.tsx` 启动时 `applySettings` 同步给音频管理器 · `lib/audio.ts` `applySettings`（主音量 × 通道、静音归 0）· `store/context.ts` 的自动前进倒计时 · `tests/ui.test.tsx` |
| 本地端点纪律（跨站 403 / body 5MB→413） | `acp-server.mjs` `LOCAL_ORIGIN_RE`/跨站判定 + `MAX_BODY_BYTES`/读 body 的统一入口（`/prompt`、`/api/worlds`、`/api/assets` 共用；先回 413 再断连）· `tests/integration/http-guard.test.ts` |
| 资产路径（`presets/<剧本 id>/assets/<类型>-<名>.jpg`；旧档 `assets/<文件>.jpg` 兼容） | `SKILL.md`【美术】生成前缓存检查与「资产目录纪律」+ `RULES` 第 3/4 句 · `acp-server.mjs` `assetRelPath`/`presetAssetsDir`/`presetIdFromPath`/`legacyAssetCandidates`/`sniffPreset`、`/api/assets?preset=` 必填（否则 400）、`/img` 白名单与旧档直服 · `lib/acp.ts` `fetchAssets(preset)`/`assetFileUrl`/`presetQuery` · `tests/server.test.ts` 快照 |
| 段过滤（旁白兜底） | `acp-server.mjs`（seg 计数与事件）· `store/slices/gameplay.ts`（`seg`/`chunk`/`turn_end` 处理） |

## 门禁

- 交付前跑 `npm run build`（`tsc -b && vite build`）。
- `npm test`（`vitest run --exclude "tests/e2e/**" --exclude "tests/e2e-ui/**"`）：parser 65 + server 89 + crafting 52 + treeLayout 7 + genealogy 8 + diff 8 + ui 106 + integration 19（pipeline 8 + audio-history 8 + http-guard 3），**共 354 例**，秒级——默认含集成层，改契约字符串必须同步改快照；另跑契约 lint `tests/contract.test.ts`（v1.6 防漂移门禁，**不计入这 354**——它断言的就是上面这些数字与协议真源）。
- `npm run test:e2e`：真引擎冒烟（约 6 分钟，2 个回合），改前端流程/协议后跑。
- `npm run test:e2e:ui`：假引擎确定性 UI e2e（`tests/e2e-ui/`，默认 chromium、不重试，秒级），改前端流程/协议/harness 后跑；CI 也会跑（先 `npx playwright install chromium --with-deps`）。
- 打包预检：`npm run dist:win` / `npm run dist:mac`，产物在 `release/`；`npm run dist:mac:dir` 只出 `.app` 目录（**不含 `app-update.yml`**，electron-updater 会静默降级）。
- 发版：打 `v<package.json version>` tag 即触发 `.github/workflows/release.yml`（guard 先校验 tag 与 `package.json` version 一致、并跑 `npm test`，两个平台 job 都 `needs: guard`）；本地 `dist:*` 只作预检，正式产物由 CI 双平台矩阵出。签名/公证条件化：`CSC_LINK` / `APPLE_*` 缺失时显式走未签名路径，构建照常成功。
- CI（`.github/workflows/ci.yml`）在 push/PR 上跑 `npm ci` + `npm test`（含集成层）+ `npm run build` + 假引擎 UI e2e（`test:e2e:ui`，CI 内自装 chromium）；真引擎 e2e 需要本机登录 grok CLI，只在开发机跑。

## 深入材料

- 动 ACP 会话、`/img` 与 `/audio` 解析顺序、资产/音频管线、世界线状态布局、逐轮快照与精确回退、世界线导出包、打包布局与已知限制 → `docs/ARCHITECTURE.md` 对应章节
- 动引擎叙事行为（导演层、音频纪律、状态纪律、尺度）→ `.grok/skills/bunkiten/SKILL.md`
- 想知道某个设计被否决的备选方案 → `docs/adr/0001-0011`；术语口径 → `CONTEXT.md`
- 给玩家的安装说明 → `QUICKSTART.md`
