# 路线图

v1.8.0 之后待办与**决策清单**（不是愿望清单）：每项写清「要改哪里（真实文件）」「为什么是现在」「开工前必须回答什么」。状态三种：**可开工**（有明确的第一个动作）/ **需决策**（卡在一个要回答的问题上）/ **需设计**（先出一版设计再估工作量）。协议契约、门禁与同步点见 [AGENTS.md](../AGENTS.md)，架构真相见 [ARCHITECTURE.md](ARCHITECTURE.md)。

口径：代码引用一律到文件级（函数名/组件名可 `grep` 定位）；写「**需要先确认**」的句子是尚未核实的推断，不要当结论用；文中的数字都是可复跑的（`npm test` / `npm run doctor` / `grep`），不写会随改动漂移的用例计数。

## 1. 数据版本化与迁移 —— **最高优先 · 需设计**

- **现状（读代码得到的事实）**：`state/worlds/<worldId>/` 的三份 md（state / summary / story-tree）**没有任何版本头**——`SKILL.md`「状态文件格式」只规定形状，文件由引擎每轮整份重写；`state/worlds/index.json` 是**裸数组**（`worlds.mjs` 的 `readWorldsIndex` 直接 `JSON.parse` 后按数组消费，坏 JSON / 非数组回空数组）；`history/NNNN.json` 与 `logs/NNNN.json` 的条目形状只由 `snapshots.mjs` 的 `normalizeSnapshot` 在读写两侧隐式定义，条目里没有版本键。
- **前提更正（别照抄旧结论）**：`.world.json` / `.preset.json` **已经有** `format` + `version: 1`（`worlds.mjs` `exportWorld`、`presets.mjs` `buildPresetBundle`）。缺的不是这两个标记，缺的是**两侧的策略**：导入侧现在都是硬等值（`importWorld` 要求 `version === 1`、`importPresetBundle` 要求 `=== PRESET_BUNDLE_VERSION`），于是未来的 v2 包在新代码里没有升级通道、在老代码里只能整包 400，而玩家侧只看到一句「bundle 校验失败」。
- **版本字段落在哪（要定）**：① 三份 md 加 YAML 头——解析可复用 `presets.mjs` 的 `parseFrontmatter`，但代价是这三份文件由**引擎**写，等于改 SKILL 的状态文件格式，且每轮重写都要保留头；② `index.json` 从裸数组升成 `{ schema, worlds }`——一次性、可控（保留 `Array.isArray(data)` 的分支即兼容旧档），而且**天然就是迁移钩子的判据**；③ `history/`、`logs/` 条目加 `v` 键——`normalizeSnapshot` 已是唯一形状入口，加键最便宜、收益也最小（快照只在同版本世界内自洽）。
- **为什么是现在**：仓库里已经躺着三处「为了兼容旧形态而存在的特判」——`importWorld`/`importPresetBundle` 的 `version === 1`、`src/lib/worlds.ts` 的 `isLegacyForkNote`、`worlds.mjs` 的 `migrateLegacyState`。它们各自都只活在一次性路径上；下一次结构改动若再靠特判兜，就是第四处，而且这次没有版本判据可依。
- **迁移钩子的形态（有先例可抄）**：`worlds.mjs` 的 `migrateLegacyState(stateDir, worldsRoot)` 在 `acp-server.mjs` 的 `startServer` 里启动期同步跑一次（幂等、无旧数据返回 false、失败不动），证明「启动期一次性迁移」这个形态在本仓成立；**但它不是版本门**——它的判据是「index.json 是否存在」。schema 迁移要的是「读 `schema` 值 → 比大小 → 升上去 → 写回」，同形新函数（如 `migrateWorldsSchema(root)`）排在 `migrateLegacyState` 之后调用。
- **旧包怎么处理（要定）**：倾向 **accept + upgrade**（v1 包照收、落地即写成当前 schema，必要时在索引条目里留 `migratedFrom`）；导出包是唯一的跨机通道（世界线包落 `state/worlds/`、剧本包落 `presets/`），拒收等于把老玩家挡在门外。**拒绝**只留给结构上无法升级的形态（如 `files.state` 为空——现有校验已经这么判）；同时要给拒绝换一句玩家能懂的话。
- **谁来钉（测试面）**：状态形状现在**没有**契约门禁——`tests/contract.test.ts` 钉的是协议常量、指令字符串与用例数，不覆盖 state 与索引形状；现有守面只有 `tests/server.test.ts`（索引/迁移/导出导入组）与 `tests/integration/audio-history.test.ts`（导出导入往返）。新增 schema 契约要另开一组断言，并**同批看 `scripts/doctor.mjs`**——它的「孤儿素材」组直接读全库 `state.md` 全文做引用判定，state 形状一变它跟着变。注意加/改用例会动 `npm test` 的分组计数，README / AGENTS / ARCHITECTURE 三处声明与契约 lint ④ 组要同批更新。
- **第一个具体动作（可开工）**：先写 `migrateWorldsSchema` 的骨架 + 三条断言（空目录 no-op / 旧裸数组升成带 schema / 已升过的幂等），**先不接启动路径**；接启动路径与改 `readWorldsIndex` 必须同一批做，否则会出现「读到一半的世界」。

## 2. 多角色同屏立绘 —— **需决策（产品）**

- **现状**：协议只按角色名**切一张**——`【立绘】<角色名>|<变体名>`（SKILL 每轮协议第 2 条，明确写「每轮至多切换 2 次」）；server `parseExpressionLine` 只广播 `expression{character, variant}`；客户端 `src/store/portrait.ts` 的 `nextPortraitOnExpression` 语义就是「当前立绘是该角色 → 只换 variant / url；否则**新建槽位**」= 全局单槽；store 里 `portrait: PortraitState | null`（`src/store/types.ts`），`src/components/game/PortraitLayer.tsx` 只渲染这一个。
- **状态形状改动面**：`portrait` → 按角色键控的 `portraits`（外加一份**顺序**——同屏排位必须确定，Map 或数组插入序）。连带要改：`src/store/slices/gameplay.ts` 的 `expression` 分支、`resetRunState` 的清理、`GameStage.tsx` 里挂 `.portrait-reserve` 的那个 `portrait ? … : ""` 判据、`PortraitLayer` 的渲染、以及纯函数 `nextPortraitOnExpression` 的签名——它被 `tests/crafting.test.ts` / `tests/ui.test.tsx` 直接调用（改签名会动一批用例，先 `grep` 再定）。
- **布局问题**：单立绘是 `fixed right-[max(2vw,8px)] bottom-[26vh] h-[58vh] max-w-[46vw]` 的固定浮层，让位靠 `GameStage` 满宽外层加 `.portrait-reserve`（`src/styles/global.css`：`@media (min-width:1024px) { padding-right: min(40vw,420px) }`，配额是按 1280×720 下单立绘 58vh×0.75≈313px 推出来的）。两个同屏要么横向并排（每槽 ≤30vw）、要么前后错位（后排更小更暗），两种都要重算配额。
- **硬耦合（改这个必须同批改 e2e）**：`tests/e2e-ui/opening.spec.ts` 已断言「对话面板宽 > 700px」与「对话区右缘 < 立绘左缘」。`min(40vw,420px)` 与对话区 `max-w-[800px]` 是**一对**：预留一旦超过 40vw，1440 宽下可用宽度就会把面板压到 800px 以下，这两条断言直接红。
- **退出 / 入场语义（要定）**：协议里**没有退场指令**。三个候选：① 缺省 TTL（某角色连续 N 回合没被点名就淡出）；② 协议层加语义（最贵——动 SKILL + `shared/protocol.mjs` 的 9 头 `PROTOCOL_HEADS` + 契约 lint + 一批快照）；③ 按**当前节点的 `在场` 字段**重建舞台：数据现成（`src/lib/parser.ts` 的 `parseStoryTree` 已解析出每节点 `present`），但树现在只在剧情图屏取（`fetchTree` 仅 `StoryTreeScreen` 调用，`src/lib/acp.ts`），游戏屏要新增取数。建议优先评估 ③——它把「谁在台上」交还给引擎已经在维护的那份真相，而不是让客户端猜。
- **OPEN QUESTION（要产品/引擎回答，先别动代码）**：SKILL 导演层第 3 条「聚光灯轮换」与剧情树节点格式里的 `在场:` 字段都说明叙事里**多人同时在场**是常态，但协议与 SKILL **没有任何一处**写「两个角色同时可见」，第 2 条的「每轮至多切换 2 次」是按**换一张**的口径写的。所以先答：本作的叙事呈现是「一次一人」还是「允许两人同框」？若答案是前者，本项直接关闭，省掉全部改动。
- **结论**：**需决策**。决策前不要动 `src/store/types.ts` 的 `portrait` 字段——那是所有世界线渲染路径的地基。

## 3. 手写交互 → headless 原语 —— **需设计（首面可开工）**

- **四处手写面（现状都读过）**：
  - ① 抽屉 `src/components/game/{HistoryDrawer,CharactersDrawer}.tsx`——`motion.aside` + `fixed inset-y-0 right-0 z-50`，**没有** `role="dialog"` / `aria-modal`，开时不抢焦、不锁滚动，Esc 靠 App 的关闭链兜；
  - ② 设置屏滑杆 `SettingsScreen.tsx` 的 `input type="range"` + `appearance-none`；
  - ③ 弹层 `AssetsScreen.tsx` 大图预览（**手写**了 `role="dialog"` + `aria-modal` + 初始焦点到关闭按钮）与 `CreationScreen.tsx` 的返回确认层（**连 role 都没有**，只有 backdrop 点击关闭）；
  - ④ 世界线行的 `⋯` 菜单 `WorldsScreen.tsx`（`role="menu"`/`menuitem`、`aria-haspopup`/`aria-expanded`、开时焦点进第一项、Esc 关闭并把焦点送回触发器、focusin 出走即关——**这些已经手写齐了**）。
- **各自能拿到什么**：抽屉 → 焦点陷阱 + 滚动锁 + `aria-modal` + 背景 `inert`（现在 Tab 能走出抽屉逛到 TopBar 与命令轨）；弹层 → 同一套语义 + 初始焦点/焦点归还的标准化；`⋯` 菜单 → ↑↓/Home/End roving 与 typeahead（**缺的就是这两样**：组件注释写的「↓ 走位」并不存在，实际只有 Tab 可用）；滑杆 → 结构上**没有缺口**（原生 range 自带键盘与值语义），唯一实质工作是统一读数到 `aria-valuetext`。
- **顺手要确认的一件事（需要先确认）**：滑杆用了 `appearance-none`，而 `src/styles/global.css` 里**没有任何** `::-webkit-slider-thumb` / `::-moz-range-thumb` 规则——Chromium 下拇指可能根本不显示，而 jsdom 与 Playwright 的设值路径（`tests/e2e-ui/settings.spec.ts` 用原型 setter 派发 `input`）都看不见渲染。先在浏览器里肉眼看一次，或补一条 computed style 断言。
- **成本**：新依赖二选一（Radix = 逐原语包、DOM 与样式全交给 Tailwind；react-aria = hooks 家族、无 DOM 输出但学习面更大），**先定哪个**——它决定后面三处怎么改；每迁移一面还要一次 jsdom 用例改动（行为断言在 `tests/ui.test.tsx`）+ 一次 e2e（焦点环在 `tests/e2e-ui/focus.spec.ts`）。三种交互的既有约定别打破：`.shell-panel` / `bg-panel*` token、unlayered 的统一焦点环（组件里**不允许**再写 `outline-none`）、以及 `data-testid` 一族（e2e 与 jsdom 都按它定位）。
- **一个必须提前想清的冲突**：滚动的常见实现是给 `body` 上 `overflow: hidden`，而本仓的屏是 `fixed inset-0` 满幅布局（`ScreenShell`）——锁 `body` 不一定有效，锁要落在真正在滚的容器上。
- **另一个约束（主题变量）**：主题 CSS 变量注入在 `App` 根容器（`src/theme.ts` 的 `themeVars`），而 headless 原语通常把浮层 portal 到 `document.body`——那样浮层会掉回 `global.css` 的初始 `--accent`。用 Radix 就必须显式指定 portal 容器为根容器内节点。
- **建议的第一面（可开工）**：**世界线行的 `⋯` 菜单**——最小、缺口明确（roving + typeahead）、已有 e2e（`tests/e2e-ui/worlds.spec.ts`）与 jsdom 断言（`tests/ui.test.tsx` 菜单组），且它是三个 `⋯` 式菜单里的第一个（选它等于把模式钉下来）。抽屉放最后（焦点陷阱 + 背景 inert，风险最大）。typeahead 对中文名按什么匹配（名字前缀 / 拼音首字母）**需决策**。

## 4. e2e 覆盖补面 —— **可开工**

- **前提更正**：清单里的**背景交叉淡入已经有浏览器级覆盖**——`tests/e2e-ui/opening.spec.ts` 在页面里挂 MutationObserver 抓「两层并存」帧、断言淡入时长等于 `BG_FADE_MS`、并断言过渡后收敛成一层（随 v1.8 功能同批落地）。真正的缺口是**reduce 下的背景换图**：`global.css` 在 `prefers-reduced-motion: reduce` 把 `.stage-bg-fade` 设为 `animation: none` = 瞬时硬切，而 `tests/e2e-ui/reduced-motion.spec.ts` 只断言了正文整段立现与屏切换，**没断言换背景不出现两层并存**。夹具够用：`tests/e2e-ui/stack.ts` 的 `turns` / `trees` / `worlds` / `snapshots` / `stateFiles` seed 项覆盖下面多数新用例，不必先扩 `tests/integration/harness.mjs`。
- **对话面板 自动 / 快进**（今天只有 `tests/ui.test.tsx` 的 DialogueBox 组）→ 归 **`tests/e2e-ui/keyboard.spec.ts`**（对话交互的家：数字键与空格都在那）：断言点「自动」后倒计时标记出现且**正文没有被补全**（`stopPropagation` 的浏览器级证据）、点「快进」正文一次到全文且按钮随即禁用。
- **剧情图章节切换器**（`ui.test.tsx` StoryTreeScreen 组）→ 归 **`tests/e2e-ui/story-tree.spec.ts`**：断言切到非进度章后画布节点集合确实变了、进度章仍标「当前」、点 `归档` 章只给一句实话而不改画布。
- **家谱缩放 / 平移**（`ui.test.tsx` 家谱画布组）→ 归 **`tests/e2e-ui/worlds.spec.ts`**（该 spec 已有「家谱视图」用例）：与剧情图同款口径——滚轮后 `viewBox` 变化、拖拽平移、`+ - 0` 与工具条按钮等价，且单选节点时缩放不抢节点焦点。
- **`⋯` 菜单键盘路径**（`ui.test.tsx` 菜单组已覆盖 Esc / 点外 / 半截确认）→ 归 **`worlds.spec.ts`（行为）+ `focus.spec.ts`（焦点环）**：断言 ⋯ 上 Enter 后焦点落在第一项（`:focus-visible` 环可见）、Esc 后焦点回触发器、菜单关闭后 `aria-expanded=false`。
- **剧本体检屏**（`ui.test.tsx` PresetCheckScreen 与 TitleScreen 入口组）→ 倾向并进 **`tests/e2e-ui/presets.spec.ts`**（同屏族：标题屏当前卡带的出入出口），避免再添第 13 个 spec；断言入口进屏、摘要计数与 doctor 行原文逐字一致、点「重新检查」确实重发请求、错误态与「没有可展示」态各一条。**新建 spec 还是并进是个小决定**。
- **立绘差分预载**（今天只有 node 环境的 `tests/preload.test.ts`）→ 浏览器级只能断言可观测面：同一会话内第二次显示同一角色时**没有第二次 `/api/assets` 请求**。收益与稳定性一般，标**可开工但优先级最低**。
- **真引擎冒烟（`tests/e2e/smoke.spec.ts`）的 nightly / 手动触发需要什么**（只列清单，不实现）：① 有引擎凭据的 runner（`~/.grok` 的登录态必须以 secret 注入，不能进仓库）；② 出网到 x.ai 的能力（CI 直连或自托管 runner + 代理；被墙时表现为回合 600s 超时）；③ 预算护栏（两个 test 合计约 5 个真回合、本机 6–12 分钟，spec 内已设 900s/test）；④ 失败可诊断（除 Playwright trace 外，把 `state/worlds/*/logs/NNNN.json` 也 artifact 化——日志刻意不进导出包，但它在仓库根，CI 里必须显式收）；⑤ 沙箱隔离（该 spec 会直接改仓库根的 `state/worlds/index.json` 与 `.shell-session.json`，CI 必须跑在 checkout 的副本上）。

## 5. 世界线体验 —— **需决策（id）· 可开工（缩略图 / 导出包 v2）**

- **友好世界 id（需决策）**：今天是 `createWorld` 分配 `<preset>-N`（`worlds.mjs`：base 取 preset 过非白名单字符替换后递增 N）。要动它先答一个问题：id 是**机器面**（目录名 / 导出文件名 / `继续世界：<worldId>。` 指令 / `WORLD_ID_RE` 白名单 `/^[A-Za-z0-9_-]+$/`——`grep -rn WORLD_ID_RE` 共 17 处 `.test()` 判定，分布在 routes 6 / worlds 5 / snapshots 5 / acp-server 1），而玩家面**已经有**回退链 `label → note → 剧本标题 →「未命名世界线」`（`WorldsScreen.tsx` 的 `worldDisplayName`）。所以：要「友好」的是 **id 本身**（那要放宽白名单，并回答中文/空格 id 对路径安全与引擎指令解析的影响），还是只要**默认 label**（`createWorld` 顺手写一条「盛夏偏差值 · 第一条」）与**下载文件名**（现在是 `Content-Disposition: attachment; filename="<worldId>.world.json"`，`server/routes.mjs`；中文名要走 RFC 5987 的 `filename*`）？后者的改动面小一个数量级。
- **若真要改 id 形态，blast radius 先数清（都是硬断言）**：`tests/parser.test.ts` 5 处 `campus-summer-1`、`tests/crafting.test.ts` 约 20 处（含 `继续世界：campus-summer-1。` 的逐字断言）、`tests/server.test.ts` 的 `createWorld` 组（断言「`<preset>-N` 递增 id」）、e2e 夹具用 `w1`/`w2`（`tests/integration/harness.mjs` 的 `seedWorld`，`worlds.spec.ts` 还断言重名副本 `w2-2`）。另需先定：**旧世界线 id 是否原样保留**（id 是目录名，没有重命名通道，保留是唯一省事的选择）。
- **行缩略图（可开工）**：`/api/worlds` 的 `WorldEntry` 不带任何图（无 cover 字段），而世界线屏本来就按剧本过滤（`fetchWorlds(preset)`）——所以最小实现是复用 `coverUrl(entry.preset)`（`src/lib/acp.ts`，走 `/img` 白名单直服 `presets/<id>/cover.jpg`），**零服务端改动**。进阶版是「该世界当前场景背景」，那要新字段 + 从 `state.md` 的「场景美术」清单反查路径（**需要先确认**该清单是否总能查到路径）。行数多时每行一张图，`AssetsScreen.tsx` 已有 `loading="lazy"` 的先例，照抄即可。
- **导出包 v2 带 `forkedFrom` + `fork.md`（可开工，也是第 1 项的第一个真实用例）**：`exportWorld` 只写 `worldId/preset/title/label/note/chapterNo/files/snapshots`，**既不带索引里的 `forkedFrom`，也不收 `fork.md`**；`importWorld` 反向固定写 `forkedFrom: null` 且不落 `fork.md`——结果是**导入回来的分叉线在家谱里变成根**（家谱只认 `forkedFrom`），正好抵消 v1.8 把血缘从 `note` 挪到 `forkedFrom` 的那次收拾。
- **v2 的做法**：`version: 2` + `world.forkedFrom`（老包缺失即 null）+ `world.forkMd`（可选字符串，落地时原样写 `fork.md`）；导入侧把现在的 `version === 1` 硬等值改成「接受 1 或 2，老包按当前形状补齐」——这就是第 1 项「旧包 accept + upgrade」策略的落地样板，建议**它先于通用迁移钩子做**（改动局部、收益立刻可见）。
- **测试面**：`tests/integration/audio-history.test.ts` 的导出导入往返、`tests/server.test.ts` 的 `importWorld` 校验组、`tests/e2e-ui/worlds.spec.ts` 的家谱断言；`v1 包仍能被导入` 要单独一条用例钉住（否则「接受旧版本」很容易在下一次重构里被顺手收紧回去）。

## 6. 性能与虚拟化 —— **可开工（先测量）**

- **先定「什么会先坏」，每一项都配一个现在就能跑的测点**，不要先引虚拟化库。首屏与请求级清单如下（都读过实现）：
- **`GET /api/assets?preset=`**：每次请求都 (a) 逐条 `mtimeOf` 一次 stat、(b) 为了 `inUse` 把该剧本**每个世界的整份 `state.md` 读进内存**做 `includes`、(c) 为了封面标题再调一次 `scanPresets()`（全 presets 目录重扫）——见 `server/acp-server.mjs` 的 `listAssets`。几百个素材 × 若干条世界线 = 一次请求几百次 stat + N 份 state 全文。测点：造 10 条世界线 + 500 个素材文件，量耗时与读盘字节（`tests/integration/harness.mjs` 的临时 root 加两个 seed 项即可）。
- **画廊首屏**：`AssetsScreen.tsx` 一次渲染全部分组（栅格 + `loading="lazy"`）。测点不是「有几张图」，而是 mount → 首帧可用时间与 DOM 节点数，判定口径取「滚动是否掉帧」。
- **剧情图**：`StoryTreeScreen.tsx` 已有降级闸——当前章节点 > `BIG_GRAPH_NODES = 40` 默认列表形态（组件内常量）。要量的是 `parseStoryTree` + `src/lib/treeLayout.ts` 的 `layoutTree` 在 200 / 1000 节点下的耗时（都是纯函数，node 里直调，不需要浏览器）。
- **快照与索引**：`readSnapshots` 已有逐文件 mtime 复用缓存、`GET /api/history` 列表只回元信息（都不必重做）。要量的是上千条快照下**首次**打开剧情图的冷启动（缓存建表那一次全量 parse）与内存驻留——缓存里每条都留着 `files` 三份全文（长世界 MB 级），`invalidateSnapshots` 只在删世界时释放。
- **世界线列表**：`listWorlds` 每条世界读一次 `story-tree.md` 全文 + 3 次 `mtimeOf`（`worlds.mjs`）；几条到几十条无感，上千条就是每次开屏上千次 IO。
- **顺序与纪律**：先补测量（都能用 `tests/integration/harness.mjs` 的临时 root 或 node 直调纯函数，零新依赖），拿到数字再决定要不要虚拟化。**虚拟化落地前先确认不破坏这四条已成立的契约**：`loading="lazy"` + `/img` 白名单直服的 URL 形态（`lib/acp.ts` 的 `assetFileUrl`）、世界线列表的 listbox/option + roving tabIndex 语义、`data-testid` 一族（jsdom 与 e2e 都按它定位）、剧情图节点 `<g tabindex>` 的键盘走位。
