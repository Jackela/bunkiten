# 路线图

v1.13 之后待办与**决策清单**（不是愿望清单）：每项写清「要改哪里（真实文件）」「为什么是现在」「开工前必须回答什么」。状态三种：**可开工**（有明确的第一个动作）/ **需决策**（卡在一个要回答的问题上）/ **需设计**（先出一版设计再估工作量）。协议契约、门禁与同步点见 [AGENTS.md](../AGENTS.md)，架构真相见 [ARCHITECTURE.md](ARCHITECTURE.md)。

口径：代码引用一律到文件级（函数名/组件名可 `grep` 定位）；写「**需要先确认**」的句子是尚未核实的推断，不要当结论用；文中的数字都是可复跑的（`npm test` / `npm run doctor` / `grep`），不写会随改动漂移的用例计数。

**进展（v1.13 时点）**：本文件 v1.8–v1.10 的待办**已全部落地或明确关闭**——§1 索引 schema 与启动迁移（v1.9，ADR-0018）、§2 同屏多立绘（上限 2）、§3 a11y 缺口（v1.9 手写收口：背景 `inert` + 滚动锁；原语迁移维持「不为一致性而迁」）、§4 e2e 补面（v1.9–v1.12，含跨平台打包态）、§5 行缩略图与导出包（v1.9 升 v2、v1.13 升 v3；「当前场景背景」那一版缩略图**仍有意未做**，理由见该节）、§6 性能实测（2026-09：当前规模不需要虚拟化）、§7 引擎凭据（v1.10）。

v1.11–v1.13 三批一次交付（tag **v1.13.0**）的内容不在上面的编号里，见文末「已交付（v1.11–v1.13）」一节。**下一轮方向待定**——本文件不写没有决定的愿望清单。

## 7. 引擎凭据（GUI 自备 key）—— **已落地（v1.10）**

- **已定（不再重开讨论）**：默认广泛兼容（OpenAI 兼容协议 = 事实标准，只填 base_url/api_key/model 或从服务目录选一个）；**不引 provider SDK / AI 框架**（协议差异已被 `shared/providers.mjs` 吸收，流式与 tool-call 编排由 grok CLI 承担，server 树零依赖是既有纪律）；**不做 `.env`**（玩家不该为填 key 去改文件或设环境变量；GUI 即时保存 + 一键重启比环境文件准确、也不污染 shell）；**不改写 `~/.grok/config.toml`**（合写玩家全局配置、要 TOML 读写、失败会污染他所有 CLI 会话）；**不加密 key**（本机 0600 + 磁盘加密是刻意取舍——加密要引依赖并处理恢复路径，而本机端点本身也只挡跨站浏览器请求、不防本机进程）；**不做多 profile 并行**（一次只激活一套，切换走「立刻重启引擎」）。理由与被否决的备选都写在 `docs/adr/0019`。
- **落地形态**（读代码可得）：对话侧走 CLI 的 BYOK 通道（`GROK_MODELS_BASE_URL` / `XAI_API_KEY` / `GROK_DEFAULT_MODEL`，`server/credentials.mjs` 的 `credentialsToEnv`）；图片侧自建零依赖 MCP server（`server/media-mcp.mjs` 的 `bunkiten-media__generate_image`，经 `search_tool`/`use_tool` 调用、自己落盘），SKILL【美术】新增「出图工具优先（硬规则）」；凭据落 `~/.bunkiten/credentials.json`（0700/0600 原子写），HTTP 出口一律脱敏；端点 `GET/POST /api/credentials`、`POST /api/credentials/test`、`POST /api/engine/restart`，`/api/auth` 扩展 `hasCredentials`。
- **落定（v1.10 收尾轮实测）**：出图尺寸做成两格（`size` 通用覆盖 + `sizeBackground` 背景专用，留空按类型默认）；图片探活的成本在 GUI/QUICKSTART/ARCHITECTURE 三处明写（对话侧只拉 `/models` 免费，图片侧真生成一张小图）；**Anthropic 原生协议已实证不可行**——CLI 的 `api_backend` 只能写在 `~/.grok/config.toml` 的 `[model.*]` 里，而 `GROK_CONFIG` 覆盖层的白名单会丢弃 `model.*`（实测：请求仍是 `chat/completions` + env 的模型）；要用 Anthropic 就走它的兼容网关，除非哪天愿意接受「改写玩家全局配置」——那正是 ADR-0019 拒绝的路径。会话标题那条杂音也已处理：`GROK_TITLE_REFRESH`/`features.title_refresh` 三种开关均无效，改由 `GROK_CONFIG` 把 `models.session_summary` 指到玩家配的模型（`/responses` 消失）。
- **已实现（v1.10，ADR-0020）**：服务目录随版本更新推给玩家——仓库 JSON 发布源 `docs/providers.json`（`npm run providers:export` 从 `shared/providers.mjs` 生成）+ 服务端启动抓取 / 本地缓存 / 内置兜底（`server/providers-catalog.mjs` → `GET /api/providers` 的 `source` 三态）。**这项原挂在「没做的」里，现已划掉**；「没做的」清空。

## 1. 数据版本化与迁移 —— **已接线（v1.9）**

- **现状（读代码得到的事实）**：`state/worlds/<worldId>/` 的三份 md（state / summary / story-tree）**没有任何版本头**——`SKILL.md`「状态文件格式」只规定形状，文件由引擎每轮整份重写；`state/worlds/index.json` 是**裸数组**（`worlds.mjs` 的 `readWorldsIndex` 直接 `JSON.parse` 后按数组消费，坏 JSON / 非数组回空数组）；`history/NNNN.json` 与 `logs/NNNN.json` 的条目形状只由 `snapshots.mjs` 的 `normalizeSnapshot` 在读写两侧隐式定义，条目里没有版本键。
- **前提更正（别照抄旧结论）**：`.world.json` / `.preset.json` **已经有** `format` + `version: 1`（`worlds.mjs` `exportWorld`、`presets.mjs` `buildPresetBundle`）。缺的不是这两个标记，缺的是**两侧的策略**：当时的导入侧都是硬等值（`importWorld` 要求 `version === 1`、`importPresetBundle` 要求 `=== PRESET_BUNDLE_VERSION`），于是未来的 v2 包在新代码里没有升级通道、在老代码里只能整包 400，而玩家侧只看到一句「bundle 校验失败」。（**现状**：世界线包已改成区间闸 `1..WORLD_BUNDLE_VERSION`，v1.13 起上限是 3；剧本包仍是等值 `PRESET_BUNDLE_VERSION`。）
- **版本字段落在哪（要定）**：① 三份 md 加 YAML 头——解析可复用 `presets.mjs` 的 `parseFrontmatter`，但代价是这三份文件由**引擎**写，等于改 SKILL 的状态文件格式，且每轮重写都要保留头；② `index.json` 从裸数组升成 `{ schema, worlds }`——一次性、可控（保留 `Array.isArray(data)` 的分支即兼容旧档），而且**天然就是迁移钩子的判据**；③ `history/`、`logs/` 条目加 `v` 键——`normalizeSnapshot` 已是唯一形状入口，加键最便宜、收益也最小（快照只在同版本世界内自洽）。
- **为什么是现在**：仓库里已经躺着三处「为了兼容旧形态而存在的特判」——`importWorld`/`importPresetBundle` 的 `version === 1`、`src/lib/worlds.ts` 的 `isLegacyForkNote`、`worlds.mjs` 的 `migrateLegacyState`。它们各自都只活在一次性路径上；下一次结构改动若再靠特判兜，就是第四处，而且这次没有版本判据可依。
- **迁移钩子的形态（有先例可抄）**：`worlds.mjs` 的 `migrateLegacyState(stateDir, worldsRoot)` 在 `acp-server.mjs` 的 `startServer` 里启动期同步跑一次（幂等、无旧数据返回 false、失败不动），证明「启动期一次性迁移」这个形态在本仓成立；**但它不是版本门**——它的判据是「index.json 是否存在」。schema 迁移要的是「读 `schema` 值 → 比大小 → 升上去 → 写回」，同形新函数（如 `migrateWorldsSchema(root)`）排在 `migrateLegacyState` 之后调用。
- **旧包怎么处理（要定）**：倾向 **accept + upgrade**（v1 包照收、落地即写成当前 schema，必要时在索引条目里留 `migratedFrom`）；导出包是唯一的跨机通道（世界线包落 `state/worlds/`、剧本包落 `presets/`），拒收等于把老玩家挡在门外。**拒绝**只留给结构上无法升级的形态（如 `files.state` 为空——现有校验已经这么判）；同时要给拒绝换一句玩家能懂的话。
- **谁来钉（测试面）**：状态形状现在**没有**契约门禁——`tests/contract.test.ts` 钉的是协议常量、指令字符串与用例数，不覆盖 state 与索引形状；现有守面只有 `tests/server.test.ts`（索引/迁移/导出导入组）与 `tests/integration/audio-history.test.ts`（导出导入往返）。新增 schema 契约要另开一组断言，并**同批看 `scripts/doctor.mjs`**——它的「孤儿素材」组直接读全库 `state.md` 全文做引用判定，state 形状一变它跟着变。（**这条已被证伪，v1.9 起不成立**：用例数改成了**下限口径**——加用例不必改任何文档，文档里反而**不许**写逐分组数字；分组数字的唯一维护点是 `tests/contract.test.ts` 的 `CASE_GROUPS`。）
- **第一个具体动作（可开工）**：先写 `migrateWorldsSchema` 的骨架 + 三条断言（空目录 no-op / 旧裸数组升成带 schema / 已升过的幂等），**先不接启动路径**；接启动路径与改 `readWorldsIndex` 必须同一批做，否则会出现「读到一半的世界」。

## 2. 多角色同屏立绘 —— **已实现（上限 2）**

- **现状**：协议只按角色名**切一张**——`【立绘】<角色名>|<变体名>`（SKILL 每轮协议第 2 条，明确写「每轮至多切换 2 次」）；server `parseExpressionLine` 只广播 `expression{character, variant}`；客户端 `src/store/portrait.ts` 的 `nextPortraitOnExpression` 语义就是「当前立绘是该角色 → 只换 variant / url；否则**新建槽位**」= 全局单槽；store 里 `portrait: PortraitState | null`（`src/store/types.ts`），`src/components/game/PortraitLayer.tsx` 只渲染这一个。
- **状态形状改动面**：`portrait` → 按角色键控的 `portraits`（外加一份**顺序**——同屏排位必须确定，Map 或数组插入序）。连带要改：`src/store/slices/gameplay.ts` 的 `expression` 分支、`resetRunState` 的清理、`GameStage.tsx` 里挂 `.portrait-reserve` 的那个 `portrait ? … : ""` 判据、`PortraitLayer` 的渲染、以及纯函数 `nextPortraitOnExpression` 的签名——它被 `tests/crafting.test.ts` / `tests/ui.test.tsx` 直接调用（改签名会动一批用例，先 `grep` 再定）。
- **布局问题**：单立绘是 `fixed right-[max(2vw,8px)] bottom-[26vh] h-[58vh] max-w-[46vw]` 的固定浮层，让位靠 `GameStage` 满宽外层加 `.portrait-reserve`（`src/styles/global.css`：`@media (min-width:1024px) { padding-right: min(40vw,420px) }`，配额是按 1280×720 下单立绘 58vh×0.75≈313px 推出来的）。两个同屏要么横向并排（每槽 ≤30vw）、要么前后错位（后排更小更暗），两种都要重算配额。
- **硬耦合（改这个必须同批改 e2e）**：`tests/e2e-ui/opening.spec.ts` 已断言「对话面板宽 > 700px」与「对话区右缘 < 立绘左缘」。`min(40vw,420px)` 与对话区 `max-w-[800px]` 是**一对**：预留一旦超过 40vw，1440 宽下可用宽度就会把面板压到 800px 以下，这两条断言直接红。
- **退出 / 入场语义（要定）**：协议里**没有退场指令**。三个候选：① 缺省 TTL（某角色连续 N 回合没被点名就淡出）；② 协议层加语义（最贵——动 SKILL + `shared/protocol.mjs` 的 9 头 `PROTOCOL_HEADS` + 契约 lint + 一批快照）；③ 按**当前节点的 `在场` 字段**重建舞台：数据现成（`src/lib/parser.ts` 的 `parseStoryTree` 已解析出每节点 `present`），但树现在只在剧情图屏取（`fetchTree` 仅 `StoryTreeScreen` 调用，`src/lib/acp.ts`），游戏屏要新增取数。建议优先评估 ③——它把「谁在台上」交还给引擎已经在维护的那份真相，而不是让客户端猜。
- **当时的 OPEN QUESTION（已关闭，见本节末尾的「结论」）**：SKILL 导演层第 3 条「聚光灯轮换」与剧情树节点格式里的 `在场:` 字段都说明叙事里**多人同时在场**是常态，但协议与 SKILL **没有任何一处**写「两个角色同时可见」，第 2 条的「每轮至多切换 2 次」是按**换一张**的口径写的。所以先答：本作的叙事呈现是「一次一人」还是「允许两人同框」？若答案是前者，本项直接关闭，省掉全部改动。
- **结论（已实现，2026-09）**：按 VN 通行做法**允许同屏**——Ren'Py 的 sprite 系统本身就是「多立绘 + 位置/层级」，社区常态是「发言者高亮、其余压暗」（`focus=True/False` 的 dim 约定）。落地口径：**上限 2 人**（`src/store/portrait.ts` 的 `MAX_STAGE`），队尾 = 发言者（全亮 + 名牌），其余压暗（`opacity-55 saturate-[.7]`，挂在**内层**——framer 会写内联 opacity，压暗档落外层会被覆盖），第三人出场按队首淘汰（最近发言的两位留场，正好对上 SKILL 导演层的「聚光灯轮换」）。让位分两档：`.portrait-reserve`（1 人）与 `.portrait-reserve-duo`（2 人，配额 `min(44vw,520px)`）；1280×720 实测对话面板 732px（守住 >700 硬约束）、两人最左缘 765px > 面板右缘 746px，`tests/e2e-ui/duo.spec.ts` 把这两个数与亮/暗、名牌归属一起钉住。**退出语义**仍无协议信号（没有退场指令），当前靠「上限 + 队首淘汰」自管；路线图里评估过的候选 ③（按剧情树节点的 `在场` 重建舞台）**未采用**——游戏屏取树要新增取数路径，而 `在场` 可能落后于叙事，等#1 的 schema/迁移稳定后再回头看。
- **未做（有意）**：`src/store/types.ts` 的 `portraits` 是数组而非按角色键控的 Map（同屏上限 2，数组的插入序就是位序，够用）；三星以上同屏、立绘重叠排布、非发言者的名牌都不在本次范围。

## 3. 手写交互 → headless 原语 —— **a11y 缺口已收口（v1.9，手写）；原语迁移不再有缺口兜着，剩「要不要为一致性而迁」这一问**

- **已收口（v1.9，四处浮层的「背景可达」缺口一次补完）**——两件事，四个面：
  - **背景 `inert`**（Tab / 点击 / 程序化 `focus()` 全进不去）：
    - **游戏屏** `src/components/game/GameStage.tsx`：立绘 + `TopBar` + 对话区收进 `data-testid="stage-background"` 一层，
      `inert={drawerOpen || charactersOpen}`（两个抽屉各有开关、可同时开，共用这一层）；两个抽屉**刻意留在层外**。
    - **画廊预览** `src/components/AssetsScreen.tsx`：`ShellPage` 新增 `inert` prop，预览打开时压住整个页框
      （含表头的「返回 / 管理素材」），预览面板是页框的**兄弟**、不在这层里。
    - **创作返回确认** `src/components/CreationScreen.tsx`：创作整列（表头 + 对话流 + 输入区，
      `data-testid="creation-content"`）`inert={creationExitPrompt}`，确认层是这一列的兄弟。
  - **滚动锁** `.scroll-locked`（`src/styles/global.css`，unlayered：级联层外优先于 `overflow-y-auto` 工具类），
    挂在屏内**真正在滚的那个容器**上——画廊是壳层根（`ScreenShell` 的 `overflow-y-auto`），创作屏是对话流；
    抽屉那两处没有滚动容器可锁（`GameStage` 自身不滚）。**不锁 `body`**：App 根是 `fixed inset-0` 满幅布局，
    body 没有可滚的高度（原「必须提前想清的冲突」一条即此，已按该结论落地）。
  - **三条实现约束（回归时最先踩，别反向「优化」掉）**：① inert 的边界永远是「除当前浮层之外的全部」，
    浮层必须留在 inert 子树之外——inert 子树里的元素**连程序化 `focus()` 都是 no-op**（Chromium 实测），
    套进去焦点陷阱就再也送不进焦点；② inert 由 React 按属性写在提交的**变更阶段**落地，早于焦点陷阱的
    被动 effect / 清理：开启那一拍先压背景（此时焦点还在命令轨按钮上，Chromium 不会因元素变 inert 掉焦点）、
    随后陷阱把焦点搬进抽屉；关闭那一拍先摘属性、后归还焦点，归还目标才重新可聚焦；
    ③ 两个 store selector 分开调，`useGameStore(a) || useGameStore(b)` 会短路掉右边那次 hook 调用。
  - **浏览器级证据**（jsdom 断不出，一次性探针在真 Chromium 跑过即弃）：抽屉开着时连按 8 次 Tab 焦点不出抽屉、
    对命令轨与输入框 `focus()` 均无效；`Esc` 关层后命令轨立刻点得开画廊；画廊预览锁住时滚轮 500ms 内
    `scrollTop` 恒为 0、解锁后同一位置一滚即动；确认层开着时 Tab 只在层内打转、关层后表头「返回」可点。
    jsdom 侧把契约钉在既有的三个用例里（`tests/ui.test.tsx`：同屏多立绘组、画廊预览组、创作确认层组）。
- **四处手写面（现状都读过；①③ 的缺口已在 v1.8/v1.9 手写补齐，④ 已迁 Radix）**：
  - ① 抽屉 `src/components/game/{HistoryDrawer,CharactersDrawer}.tsx`——`motion.aside` + `fixed inset-y-0 right-0 z-50`，
    v1.8 起有 `role="dialog"` + `aria-modal` + `useFocusTrap`（焦点进抽屉、Tab 层内回绕、关层归还），
    Esc 仍由 App 的关闭链兜；v1.9 补上背景 `inert`（见上）。**仍未做的只有滚动锁**——抽屉里没有滚动容器。
  - ② 设置屏滑杆 `SettingsScreen.tsx` 的 `input type="range"` + `appearance-none`；
  - ③ 弹层 `AssetsScreen.tsx` 大图预览（`role="dialog"` + `aria-modal` + 初始焦点到关闭按钮）与
    `CreationScreen.tsx` 的返回确认层（v1.8 起同样有 `role="dialog"` + `aria-modal`）；
    v1.9 两处都补上背景 `inert` + 滚动容器 `scroll-locked`。
  - ④ 世界线行的 `⋯` 菜单 `WorldsScreen.tsx`——**已迁 Radix DropdownMenu**（上一轮），↑↓/Home/End 走位与
    typeahead 随原语到手，这是全仓第一处「手写 → 原语」的样板。
- **刻意不迁（已定）**：
  - **滑杆**：`input type="range"` 是**平台自带的可用控件**（键盘语义、值语义、`aria-valuenow` 全由 UA 给），
    换成原语只会把结构、样式与 `tests/e2e-ui/settings.spec.ts` 的设值路径（原型 setter 派发 `input`）
    一起搅一遍，换不来任何无障碍增益——**维持原生**。真要动只动读数统一到 `aria-valuetext` 这一件小事。
  - **抽屉 / 弹层**：继续用自写 `focusTrap` + `useFocusTrap`（`src/lib/`）与上面的 inert / 滚动锁，
    不为了「统一」而迁原语——v1.9 之后这三处的语义（`role=dialog` / `aria-modal` / 初始焦点 / 层内回绕 /
    关层归还 / 背景 inert / 滚动锁）已经齐了，迁移的净收益只剩「与 ④ 用同一套原语」这一条形式理由，
    而代价是重做四处焦点与关闭时序（`tests/e2e-ui/focus.spec.ts`、`.spec.ts` 一族与 jsdom 的 a11y 断言全部要动）。
- **若哪天仍决定迁（保留的评估结论）**：新依赖二选一——**Radix**（逐原语包、DOM 与样式全交给 Tailwind，
  仓里已有 `@radix-ui/react-dropdown-menu`）比 **react-aria**（hooks 家族、无 DOM 输出但学习面更大）更顺手；
  两处已点过名的坑照旧：浮层若 portal 到 `document.body` 会掉回 `global.css` 的初始 `--accent`
  （主题变量注入在 `App` 根容器，`src/theme.ts`；用 Radix 必须显式指定 portal 容器为根容器内节点），
  以及既有约定不能打破：`.shell-panel` / `bg-panel*` token、unlayered 的统一焦点环（组件里**不允许**再写
  `outline-none`）、`data-testid` 一族（e2e 与 jsdom 都按它定位）。
- **顺手要确认的一件事（需要先确认，未核实）**：滑杆用了 `appearance-none`，而 `src/styles/global.css` 里
  **没有**任何 `::-webkit-slider-thumb` / `::-moz-range-thumb` 规则（`SettingsScreen.tsx` 也没有任意值变体）——
  Chromium 下拇指是否可见需要肉眼看一次；jsdom 与 Playwright 的设值路径都看不见渲染。
  **本次（v1.9）没碰**：它与 a11y 缺口无关，留给「滑杆读数统一」那一件小事同批看。

## 4. e2e 覆盖补面 —— **已补（`tests/e2e-ui/` 22 个 spec / 50 条用例；打包态冒烟跨平台、Windows 侧已进 CI）**

- **v1.9 收尾补的五块**（会话内落地，验收标准=「改坏哪一处它就会红」各自在 spec 文件头/提交信息里写明）：
  1. **章节循环** `tests/e2e-ui/crafting.spec.ts`——规划→`【清单】`→逐项美术→`开演。`→`【章】`→**第二次进制作中屏**→第二章回 game。中间态（init/planning/queue）在 store 里各只活一两个回合（假引擎一回合 2–6ms）+ 屏转场 450ms，所以把每一跳 `/prompt` 用 `page.route` **挂在浏览器侧**，断言窗口由测试控制（不是睡等、也不是抢时序）。
  2. **创作模式** `tests/e2e-ui/creation.spec.ts`——标题屏「创作新剧本」→ 打磨对话与选项 chip →「开始装配」→ 清单逐项点亮（封面/立绘/剧本文件）→`【新剧本】`进轮播可选中；另一条覆盖**装配失败→重试装配**。
  3. **首启失败态** `tests/e2e-ui/boot.spec.ts`——checking / 未登录 / 连不上服务三态，后两者都断言「点重试真能恢复」。前置是 harness 新增的 seed 开关 `auth: "ok"|"missing"`；错误态用 `page.route` 把 `/api/auth` 拦成 502。
  4. **音频可观测面** `tests/e2e-ui/audio.spec.ts`——三行协议各自触发一次 `/audio` 直服请求、`<audio>` 元素在播与音量（主音量 × 通道音量）、换曲交叉淡入旧元素被 pause、设置屏静音后音量归 0。**关键手法**：AudioManager 的元素是 `new Audio()` 的游离节点（不在 DOM 里），`addInitScript` 包一层 `window.Audio` 登记才能从页面侧观测。
  5. **耐久规模** `tests/e2e-ui/scale.spec.ts`——60 幕长历史抽屉（逐条渲染/最新在最上/滚动容器真的可滚）、600 节点大树（>40 列表降级、切图形后 200 节点可键盘选中、缩放读数）、200 条快照（存档点标注与「与上一档对比」的确定 diff）。
  6. **打包态** `tests/e2e-packaged/` + `playwright.electron.config.ts`——`_electron` 起产物（v1.12 起**跨平台**：macOS 跑 `dist:mac:dir` 的 `.app`、Windows 跑 `dist:win:dir` 的 `win-unpacked`，定位规则见 `tests/helpers/packaged-app.mjs`），断言窗口/标题屏/`/app` 静态托管/`resources/game` 可达；**Windows 侧已由 CI 的 `packaged-win` job 真跑**，mac 侧仍本机 opt-in（arm64 only）。**首跑就抓到真 bug**：`win.loadURL("…/app")` 少了尾斜杠，产物 `index.html` 的相对资源全部 404、窗口一片空白（修在 `electron/main.js` 的 `/app/` 与 `server/routes.mjs` 的 `/app` → `/app/` 302）。

- **打包态 + 真 CLI + 真图片服务的「真画一张图」——已实现（v1.10）**：opt-in 真链路 `tests/e2e-packaged/real-image.spec.ts`（真 grok CLI + 本机登录态 + 真图片服务凭据 + 出网；走画廊重绘——SKILL 里唯一绕过生成前缓存的路径，真花一次对话与一张图；缺凭据/登录/产物即干净跳过，不进 CI），外加**三层 mock 覆盖**：集成层 `tests/integration/media-mock.test.ts` 与 e2e-ui 层 `tests/e2e-ui/media-mock.spec.ts`（**进 CI**）、打包态 `tests/e2e-packaged/packaged.spec.ts` 的第二条（**opt-in**，假引擎真调 MCP + 本地假图片服务，不需要真凭据/真网络）。三层替身各测协议面/UI 面/打包面，真链路负责证明「真能画出来」。

- **仍没测（以及为什么 / 怎么才测得到）**：
  - ~~**打包态 Windows 产物**~~ —— **已覆盖（v1.12）**：CI 的 `packaged-win` job 在 windows runner 上跑 `dist:win:dir` + `npm run test:e2e:packaged`（本机 mac 交叉不出 win 产物，这是「Windows 上的包真能开」的唯一证据）。mac 那条覆盖「打包布局 + asar + 主进程 + 资源路径」这条主干。
  - **叙事纪律**（章节长度、选项数量、角色出场一致性）：假引擎回的是脚本化的 `session/update`，验不了叙事；只能真引擎。
  - **音频纯逻辑面**（同一首重复请求不重启、`【曲】停`/`【环境】停` 的淡出停止、音效并发上限 `MAX_SFX`、索引失败静默）：要在浏览器里造时序，性价比低；留在 node 单测。
  - **reduce 下换背景不出现两层并存**：`tests/e2e-ui/reduced-motion.spec.ts` 已断言换背景瞬时上屏（v1.9），此处仅留档。
- **真引擎冒烟（`tests/e2e/smoke.spec.ts`）的 nightly / 手动触发需要什么**（只列清单，不实现）：① 有引擎凭据的 runner（`~/.grok` 的登录态必须以 secret 注入，不能进仓库）；② 出网到 x.ai 的能力（CI 直连或自托管 runner + 代理；被墙时表现为回合 600s 超时）；③ 预算护栏（现在是 **3 个 test**：Grok 快速开局 2 回合 + Grok 章节制作 3 回合 + Codex 1 回合；Grok 两条约 6–12 分钟、Codex 一条约 3 分钟，spec 内已设 900s/test）；④ 失败可诊断（除 Playwright trace 外，把 `state/worlds/*/logs/NNNN.json` 也 artifact 化——日志刻意不进导出包，但它在仓库根，CI 里必须显式收）；⑤ 沙箱隔离（该 spec 会直接改仓库根的 `state/worlds/index.json` 与 `.shell-session.json`，CI 必须跑在 checkout 的副本上）。

## 5. 世界线体验 —— **id 维持现状（已定，维持决定 ✓）· 缩略图与导出包 v3 已落地**

- **友好世界 id（已定：不改）**：`<preset>-N` 是**机器面**（目录名、导出文件名、`继续世界：<worldId>。` 指令、`WORLD_ID_RE` 白名单——`grep -rn WORLD_ID_RE` 共 17 处判定），而玩家面已经有回退链 `label → note → 剧本标题 →「未命名世界线」`。**决定：id 保持 `<preset>-N`，也不给新世界线自动起 label**——理由是行上已经有「显示名 + 第 N 章 + 相对时间 + 血缘徽标」四件信息，自动 label 会变成第二个命名来源、还会跟行内改名编辑器打架（玩家改了名、系统又按规则覆写，是最糟的体验）。若将来仍嫌目录名难看，改**下载文件名**（RFC 5987 的 `filename*`）比动 id 便宜一个数量级。
- **若真要改 id 形态，blast radius 先数清（都是硬断言）**：`tests/parser.test.ts` 5 处 `campus-summer-1`、`tests/crafting.test.ts` 约 20 处（含 `继续世界：campus-summer-1。` 的逐字断言）、`tests/server.test.ts` 的 `createWorld` 组（断言「`<preset>-N` 递增 id」）、e2e 夹具用 `w1`/`w2`（`tests/integration/harness.mjs` 的 `seedWorld`，`worlds.spec.ts` 还断言重名副本 `w2-2`）。另需先定：**旧世界线 id 是否原样保留**（id 是目录名，没有重命名通道，保留是唯一省事的选择）。
- **行缩略图（已落地）**：按当初的最小实现做的——`/api/worlds` 的 `WorldEntry` 依旧不带任何图（无 cover 字段），世界线屏本来就按剧本过滤（`fetchWorlds(preset)`），所以行首那张 56×40 直接用 `coverUrl(entry.preset)`（`src/lib/acp.ts` → `/img` 白名单直服 `presets/<id>/cover.jpg`），**零服务端改动**。落地口径见 `src/components/WorldsScreen.tsx` 的 `RowCover`：盒子常驻（固定尺寸的 `span`）、图可缺席（`onError` 只摘掉 `<img>`，留中性占位块）——没有 cover.jpg 的剧本并不罕见（导入进来的剧本目录、e2e 假栈里的 preset 目录默认都没有那张图），404 不留破图、也不改行高；`alt=""`（装饰性，显示名就在同一行的文字块里）+ `pointer-events-none`（不抢行的点击/键盘/roving tabIndex）；`loading="lazy"` 照 `AssetsScreen.tsx` 的先例。e2e 用两个剧本把两态摆在一起（`tests/e2e-ui/worlds.spec.ts`：demo 手写真 jpg，`no-cover` 剧本目录里没有那张图）——断言图真的解码上屏（`naturalWidth > 0`）、`src` 是封面契约路径、图**挂上过又被 404 摘掉**（MutationObserver 记录）、占位块与有封面时逐像素同尺寸、两态行高相同。
- **未做（有意）：缩略图取「该世界当前场景背景」那一版**。它要 `WorldEntry` 新开一个字段（server 侧从 `state.md` 的「场景美术」清单反查路径），而当初记的「**需要先确认**该清单是否总能查到路径」仍未核实——查不到时的回退又会落回今天这套「剧本封面 / 占位块」，那就等于先加字段再加一半兜底。收益（同一剧本的几条世界线长得不一样）在大盘里排不上号，故这一轮只做零改动的那一版。
- **导出包 v2 带 `forkedFrom` + `fork.md`（已落地，v1.9）**：`exportWorld` 只写 `worldId/preset/title/label/note/chapterNo/files/snapshots`，**既不带索引里的 `forkedFrom`，也不收 `fork.md`**；`importWorld` 反向固定写 `forkedFrom: null` 且不落 `fork.md`——结果是**导入回来的分叉线在家谱里变成根**（家谱只认 `forkedFrom`），正好抵消 v1.8 把血缘从 `note` 挪到 `forkedFrom` 的那次收拾。
- **做法（已落地）**：`version: 2` + `world.forkedFrom`（老包缺失即 null）+ `world.forkMd`（可选字符串，落地时原样写 `fork.md`）；导入侧从「硬等值 1」改成**区间闸** `1..WORLD_BUNDLE_VERSION`（v1.13 起上限 3——v3 为快照条目加可重演的 `prompt`），老包按当前形状补齐。这就是第 1 项「旧包 accept + upgrade」策略的落地样板。
- **测试面**：`tests/integration/audio-history.test.ts` 的导出导入往返、`tests/server.test.ts` 的 `importWorld` 校验组、`tests/e2e-ui/worlds.spec.ts` 的家谱断言；`v1 包仍能被导入` 要单独一条用例钉住（否则「接受旧版本」很容易在下一次重构里被顺手收紧回去）。

## 已交付（v1.11–v1.13）—— 三批一次交付（tag v1.13.0）

- **v1.11 多引擎后端（ADR-0022）**：凭据顶层 `engine` 选 grok / Codex；`codex-acp` 随包分发（玩家零安装）、会话跑在游戏自己的 `CODEX_HOME`、登录态从玩家 `~/.codex/auth.json` 复用；GUI 引擎选择 + 一键登录/登出（行为真源是 `server/engines.mjs`，`server/acp.mjs` 不出现品牌字面量）。自备密钥仍只属 grok（GUI 锁住并说明原因）。
- **v1.12 渐进式披露与作者工具**：命令轨从十项平铺收成 5 个顶层、标题屏角落簇收成三枚可见 + 「更多 ▾」、菜单内 Tab 走位（`src/lib/menuTab.ts`）、存档点命名（名字存索引 `snapshotLabels`）、重绘带要求（≤200 字）、剧情编辑按节点作用域、设置屏两层披露；打包态 e2e 跨平台，Windows 侧进 CI（`packaged-win`）。
- **v1.13 存档点重演（ADR-0023）**：快照条目记玩家输入 `prompt`（去重语义随之改成「三文件全等**且**没有新输入才跳过」），游戏屏与剧情图两个重演入口共用 `src/lib/replay.ts` 的解析规则；刷新/重启/换机器导入回来都能重演，世界线导出包 v2 → v3。

交付说明与产物见 `docs/releases/v1.13.0.md` 与 GitHub Release；逐版沿革见 `CHANGELOG.md`。

## 6. 性能与虚拟化 —— **已测量（2026-09）：当前规模不需要虚拟化**

**已测（本机 macOS / Apple Silicon，真 Chromium 1440×900；假引擎 + 真 acp-server + vite dev，dev 模式；
脚本一次性、跑完即删）**。口径：`visibleMs` = 点击到首屏可交互（含假栈首次导航的地板 ~820ms，dev 模式
React 无产物优化；因此「无差异」只能证明边际代价低于该地板，不是精确值）。图片两种：1×1 JPEG（量 DOM/布局）
与真实素材 320KB（量解码）。

| 面 | 规模 | 结果 |
|---|---|---|
| 画廊首屏 | 60 / 300 / 1000 张（1×1） | visible 均 ~820ms；DOM 578 / 2738 / 9038 节点（≈9 节点/卡） |
| 画廊首屏 | 60 / 120 / 300 张（**真实 320KB/张**） | visible 819 / 822 / 820ms —— 解码在 `loading="lazy"` 下没有可测代价 |
| 剧情图 | 45 / 200 / 600 节点 | visible 816 / 819 / 822ms；DOM 235 / 855 / 2455 节点（**>40 自动走列表**，SVG 画布根本不渲染） |
| 纯函数 | `parseStoryTree` + `layoutTree`，2000 节点 | parse 1.3ms、layout 1.5ms（node 直调，非瓶颈） |
| `GET /api/assets?preset=` | 300 素材 + 10 世界 / 500 素材 + 30 世界 | 8.0ms / 8.1ms（响应 46KB / 77KB） |
| `GET /api/worlds?preset=` | 10 / 30 条世界线 | 3.2ms / 3.9ms |

**结论**：三条候选路径里**没有一条现在需要虚拟化**——画廊 300 张真实素材与剧情图 600 节点都在同一时间地板上，
服务端两条列表端点在两位数世界线 + 500 素材下仍是毫秒级。真正的成本排序是
**图片解码/IO ≫ 布局与 DOM ≫ 纯函数**：画廊若真到千张量级，第一根杠杆是缩略图/更小的直服图，
而**不是**把 DOM 虚拟化；剧情图 >40 已自动降级为列表，画布的千节点场景在现有设计里不存在。

**何时回头看**：单剧本素材 **>1000 张**、或单章节点 **>2000** 且用户确实要图形画布、或世界线 **>100 条**
（`listWorlds` 每条读一次 `story-tree.md` + 3 次 `mtimeOf`）——到那时先补测 `readSnapshots` 冷启动（缓存里
每条留 `files` 三份全文）与 `listWorlds` 的 IO，再谈虚拟化。

**虚拟化落地前必须先确认不破坏的四条既有契约**（都在上面测过、且都有测试钉着）：
`loading="lazy"` + `/img` 白名单直服的 URL 形态（`lib/acp.ts` 的 `assetFileUrl`）、世界线列表的
listbox/option + roving tabIndex 语义、`data-testid` 一族（jsdom 与 e2e 都按它定位）、剧情图节点
`<g tabindex>` 的键盘走位。

**背景（上一轮列的候选测点，未测部分留作参考）**：`GET /api/assets` 每条素材 `mtimeOf` 一次 +
为 `inUse` 读该剧本**每个世界的整份 `state.md`** + 为封面标题再 `scanPresets()` 一次
（`server/acp-server.mjs` 的 `listAssets`）——10~30 条世界线时是毫秒级（上表实测），上百条世界线时值得再量。

## 已交付（v1.13 后的体验轮）

- **最小窗口 1024**（`electron/main.js`）：让 lg 档在任何合法窗口下恒真（此前最小窗口落在断点之下，立绘让位在最窄窗口里是关掉的）；
  1280 档的塌陷不保证并排，只有会挡路的动作用固定底栏兜住（捏人屏两个开局入口）。新增 `tests/e2e-ui/min-window.spec.ts` 钉住版面契约。
- **画布胶水抽 hook**：`lib/useCanvasPanZoom.ts` + `components/CanvasZoomToolbar.tsx`，两块 SVG 画布（剧情图 / 家谱）的
  视图/指针/滚轮/键盘缩放从两份手抄变一份共享。
- **可预期性**：制作中屏给「平均每张 / 约还需」，创作屏把状态摆上屏（此前只有一颗灰点的 `title`）。
- **两段式制作**：默认路径先画开场要用的那几张就开演，其余美术在玩的过程里自动补画（详见 ARCHITECTURE 的「两段式制作」）。

## 下一次候选（本轮明确不做，先记下以免反复讨论）

- **双语 README / `README.en.md`**：产品、剧本、UI 全中文，双语在没有英文产品前只是维护税。真要做就做「中文主 README + 精简英文镜像（简介/安装/截图）」，别把中文那份的内容翻一遍——契约 lint 钉住的句子只在中文那份。
- **分支保护（ruleset / required checks）**：现在是单人直接 push `main` 的效率选择，CI 已在每次 push/PR 上跑全量门禁；等有第二个人提交时再开。
- **secret scanning 的 push protection**：仓库里有多处**假密钥哨兵**（e2e 与集成层的「响应体不含明文 key」断言），开启前要先确认它们不会被拦；`gh repo edit --enable-secret-scanning` 本身可以先开（只报不拦）。
- **覆盖率徽章**：需要外部服务或在 CI 里生成 badge 提交回仓库；本项目覆盖率阈值刻意是「防下滑线」而非硬指标，挂一个会漂移的硬数字徽章与那个口径相冲。测试与 CI 状态两枚徽章已经有了。
- **`tests/contract.test.ts` 之外的文档门禁**：目前只有三份文档被钉（README / AGENTS / ARCHITECTURE）；QUICKSTART 与 CONTEXT 的漂移只能靠人工巡检（本轮就是这么发现的）。
- **§3 的手写浮层**：抽屉 / 滑杆 / 弹窗维持自写 `focusTrap`（理由见该节「刻意不迁」），不为一致性迁原语。
- ~~**已知 flake（负载敏感）**~~ —— **已修**：`tests/ui.test.tsx` 的「StoryTreeScreen 滚轮以指针为锚点缩放」在负载高时偶发（约 4 次 1 次），根因是用例在 `fetch` 落地（act 之外）的那一拍就派发滚轮，撞进「画布已可见、被动 effect/状态尚未就绪」的窗口。修法是交互前 `await act(async () => {})` 排干队列（测试侧一处等待，不动组件）；验收见 PR。**这条的教训留着**：组件里挂原生监听这类「提交阶段就该做完的事」，用 `useEffect` 会由调度器择机冲刷，`useLayoutEffect` 才是对的形状（本轮试过、因不是根因故未采纳，改别处时按这条走）。
