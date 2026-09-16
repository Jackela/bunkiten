# 架构

面向开发者与 AI 协作者。玩家侧说明见 [QUICKSTART.md](../QUICKSTART.md)。

## 系统总览

```
                 ┌───────────────────────────────────────────────┐
                 │ Electron main (electron/main.js)              │
                 │ · 定 GAME_ROOT → 注入 GROK_GAME_ROOT          │
                 │ · 补 PATH（~/.grok/bin 等常见 CLI 位置）       │
                 │ · import 并启动 acp-server，退出时优雅关停     │
                 │ · 开 BrowserWindow 加载前端                    │
                 └───────────────┬───────────────────────────────┘
                                 │ startServer() / stopServer()
  stdio · JSON-RPC (ACP)         │
┌─────────────────┐    ┌─────────▼───────────────────────────────┐
│ grok agent      │    │ server/acp-server.mjs（零依赖 Node）     │
│ --always-       │◄──►│ · HTTP: /api/presets /api/auth          │
│ approve stdio   │    │  /api/assets?preset= /img /prompt       │
│                 │    │ · SSE:  /events（回合事件流）            │
│ 引擎 = .grok/   │    │ · 静态托管: /app（打包前端）              │
│  skills/bunkiten│    │ · 资产管线 → presets/<id>/assets/…      │
│ 剧本 = presets/ │    └─────────▲───────────────────────────────┘
│ 进度 = state/   │              │ HTTP + SSE（前端全部走相对路径）
└─────────────────┘    ┌─────────┴───────────────────────────────┐
                       │ Renderer：React + Zustand (src/)        │
                       │ 屏幕流 boot→title→worlds→protagonist→   │
                       │    crafting→game（主题化视觉）+ overlay │
                       │    assets（画廊）/ creation（创作）/    │
                       │    tree（剧情图）、worlds 世界线屏      │
                       │ dev = vite(5173, proxy→7800)            │
                       │ 打包 = http://127.0.0.1:<port>/app 同源  │
                       └─────────────────────────────────────────┘
```

职责一句话：

- **grok agent**（ACP 子进程）：叙事引擎。行为完全由 `.grok/skills/bunkiten/SKILL.md` 定义——每轮协议、导演层、美术、状态纪律、内容尺度。剧本（`presets/`）是数据，进度（`state/`）是文件，引擎是 prompt。
- **acp-server**：协议桥。把 ACP JSON-RPC 流翻译成 SSE 回合事件，把【图】标记翻译成持久化资产（落进该剧本的 `presets/<剧本 id>/assets/`，见「资产管线」），把【立绘】/【新剧本】协议行翻译成 `expression`/`presetAdded` 事件，把 `~/.grok/sessions/...` 里 per-session 的图片翻译成稳定的 `/img` URL。
- **Renderer**：游戏客户端。解析文本协议（选项/标记/段过滤），管理屏幕流与打字机。

## 两种运行形态

| | 开发模式 | 打包后 |
|---|---|---|
| 前端 | `npm run dev`（vite 5173，`/api` `/events` `/prompt` `/img` 代理到 `http://localhost:7800`，可用 `ACP_PROXY_TARGET` 覆盖） | Electron 窗口加载 `http://127.0.0.1:<port>/app`，acp-server 同源托管 `resources/app-dist` |
| 服务 | 需另起 `node server/acp-server.mjs`；或用 `npm run dev:electron` 同时拉起 vite + Electron | Electron main 自动启动（`electron/main.js` import `startServer`） |
| GAME_ROOT | 项目根（`acp-server.mjs` 自行解析） | `process.resourcesPath/game`，由 main 经 `GROK_GAME_ROOT` 注入 |
| 登录检查 | 浏览器访问 5173 时 boot 屏同样检查 `/api/auth` | 同左；未登录时 boot 屏给出 `grok login` 指引 |

端口：默认 7800，被占则自动 +1（最多重试 10 次，即 7800–7810）；vite 代理固定指向 7800。

环境变量：`GROK_GAME_ROOT`（游戏数据根）、`PORT`（起始端口）、`EFFORT`（推理档，默认 `medium`）、`ACP_PROXY_TARGET`（仅 dev 代理目标）。

## ACP 契约（acp-server ↔ grok agent）

传输：`spawn("grok", ["agent", "--always-approve", "stdio"])`，cwd = GAME_ROOT，逐行 JSON-RPC 2.0。

### 请求方法（server → agent）

| 方法 | 参数 | 时机与语义 |
|---|---|---|
| `initialize` | `{ protocolVersion: 1, clientCapabilities: {} }` | 启动后（延迟 800ms）握手 |
| `session/load` | `{ sessionId, cwd: GAME_ROOT, mcpServers: [], _meta }` | 断线续档：读取 `GAME_ROOT/.shell-session.json` 里保存的 sessionId 尝试复用（60s 超时） |
| `session/new` | `{ cwd: GAME_ROOT, mcpServers: [], _meta }` | `session/load` 失败或无存档时降级新建 |
| `session/set_config_option` | `{ sessionId, configId: "reasoning_effort", value: { value: "medium" } }` | 会话就绪后设置推理档。**为什么 medium**：游戏回合是叙事演绎而非难题求解，high 档徒增延迟；`EFFORT` 环境变量可调（设 `high` 换更慢更细）。设置失败静默忽略 |
| `session/prompt` | `{ sessionId, prompt: [{ type: "text", text }] }` | 玩家每条输入一回合（600s 超时；回合进行中再发返回 409） |

`_meta`（load/new 都带）：`{ yoloMode: true, rules: RULES }`。`yoloMode` 免工具审批；`rules` 原文（`server/acp-server.mjs` 顶部 `RULES` 常量，三句拼接）：

> 本会话运行在自定义游戏客户端下：ask_user_question 卡片工具不可用，选项一律用文本格式（正文后加粗「**行动**」+ 每行一个编号选项，多问场景每个问题单独从 1 编号）。你的每条回复只能是简体中文剧情正文和文本选项，绝不输出过程旁白、计划说明或英文。回复最末尾可以追加若干【图】标记行（由 image_gen 产物而来），格式：【图】立绘|角色名|images/N.jpg、【图】背景|地点名|images/N.jpg 或 【图】封面|剧本标题|images/N.jpg，重绘覆盖旧图时追加第四段|重绘；剧情演出中可穿插【立绘】角色|变体 行切换表情差分，新剧本入轮播后输出【新剧本】<id> 行；规划回合输出【清单】立绘|<名> / 【清单】背景|<地点> 清单行；终章回合输出【章】第 N 章 完。这些协议行独立成段，不进剧情正文。

`rules` 是客户端会话对 SKILL 协议的「补丁」：把卡片交互降级为文本协议（见下节）。agent → server 的请求一律回 `-32601`（客户端不支持）。

### 通知事件（agent → server）

`session/update`，按 `update.sessionUpdate` 分流：

| sessionUpdate | 载荷 | server 处理 → SSE 事件 |
|---|---|---|
| `agent_message_chunk` | `content.text` | 追加进当前段累积文本 → `{ type: "chunk", seg, text }`；同时对流式完整行跑 `handleArtLine`：【图】→ 持久化资产、【立绘】→ `expression` 事件、【新剧本】→ `presetAdded` 事件、【树】→ `treeEdited` 事件 |
| `tool_call` / `tool_call_update` | `title` | 段号 +1 → `{ type: "seg", seg, label }`（label 映射状态栏文字，含「图/imag/paint/draw」则显示「作画中…」） |
| 其余（如 `agent_thought_chunk`） | — | 直接丢弃（思考流不透传给前端） |

SSE 事件全集（`/events`）：`turn_start` / `seg{seg,label}` / `chunk{seg,text}` / `expression{character,variant}` / `presetAdded{id}` / `treeEdited` / `turn_end` / `error{message}`。`expression`/`presetAdded`/`treeEdited` 由【立绘】/【新剧本】/【树】协议行派发（只转发、不落盘）。`turn_end` 后 server 补跑一次未落盘资产的持久化（图片文件可能晚于标记到达）。

## 文本协议契约（最重要）

引擎输出的是纯文本，客户端靠字符串约定驱动 UI。**以下每一条字符串都是跨进程契约，改动必须五处同步**（见「修改指引」）。

### 开局指令（客户端 → 引擎，四种变体）

由 `src/lib/parser.ts` 的 `buildCustomOpening` / `buildQuickOpening` 构造（`preload` 参数决定后缀）：

```
开局：《<title>》。主角卡：<字段=值；字段=值>。待命：只初始化，不开始剧情，等待分项美术指令与「开演。」
开局：《<title>》。主角卡：<字段=值；字段=值>。跳过美术预载，直接开演。
开局：《<title>》。快速开局：用剧本 quick_start 预设主角。待命：只初始化，不开始剧情，等待分项美术指令与「开演。」
开局：《<title>》。快速开局：用剧本 quick_start 预设主角。跳过美术预载，直接开演。
```

规则：

- `<title>` 是 preset frontmatter 的 `title` 原文（书名号内）。
- 自定义主角卡：`<字段=值>` 的字段名是 protagonist_card 问题的 shortName（去掉尾部括注）；多选值（特质等）用 `+` 连接；字段之间用 `；` 连接。
- **注意主角卡与后缀指令之间的 `。`**——`主角卡：<...>` 整体后必须跟一个句号再接后缀，这是 parser 的模板字符串写死的。
- **世界段**（v1.5）：四种变体在「主角卡 / 快速开局段之后、美术结尾后缀之前」插入一次 `世界：<worldId>。`（由 `buildCustomOpening`/`buildQuickOpening` 的 `worldId` 参数写死），如 `开局：《…》。主角卡：…。世界：main。待命：…`；引擎据此把本次开局初始化与演出放进 `state/worlds/<worldId>/`，未带该段或缺省时用 `main`（SKILL.md【世界线】）。
- 后缀语义：`待命：…`（v1.1 起预载路径默认）= 引擎只初始化、等分项美术指令（见下节）；`跳过美术预载，直接开演。` = 立刻开场。旧后缀 `先执行美术预载。`（单回合全出全部美术）仍被引擎识别，作为旧客户端兼容路径保留在 SKILL.md「美术预载」小节，v1.1 客户端不再发送。
- 引擎侧匹配定义在 SKILL.md「客户端开局指令」小节：识别不了指令格式（如玩家在自由输入里只说「开始游戏」）才回退问答流程（自由输入回退路径，客户端 UI 正常不会走到）。
- 识别指令后引擎不再提问：主角姓名缺失时按剧本出身自动生成中文名。

### 续玩指令（客户端 → 引擎，v1.5）

世界线屏对已有世界的「继续」（读档续演，跳过初始化与开场卡），由 `src/lib/parser.ts` 的 `buildResumeCommand` 构造：

```
继续世界：<worldId>。
```

- 引擎读该世界 `state/worlds/<worldId>/` 的 state.md 与 summary.md，用一段 100 字以内的「再入场」场景（时间、地点、刚才停住的钩子）把玩家拉回来，直接走【每轮协议】——不重新初始化、不重放开场卡、不问「要继续吗」（SKILL.md【启动流程】第 1 条）。
- 若该世界目录有 `fork.md`，引擎先按【世界线】分叉回退规则静默校准 state/summary，删除 `fork.md` 后再续演（见「世界线与状态文件」）。
- 客户端侧：`store/game.ts` 的 `resumeWorld` 落定 `worldId` + 切 game 屏后 `send(buildResumeCommand(worldId))`；世界 id 由世界线屏 `POST /api/worlds {action:"create"}` 或索引既有条目给出。

### 分项美术指令（客户端 → 引擎，「制作中」屏队列）

开局指令以待命后缀结尾时，引擎只完成初始化（主角卡/state）并回一句 `已就位。`，等待客户端的章节规划与逐项美术指令。指令由 `src/lib/parser.ts` 的 `buildArtCommand` / `BUILD_START` 构造，一次只发一条，前一项回合结束（`turn_end`）才发下一条：

```
美术：立绘 <角色名>[-<变体>]
美术：背景 <地点名>
开演。
```

- **待命后缀**（逐字）：`待命：只初始化，不开始剧情，等待分项美术指令与「开演。」`——引擎收到后除一句 `已就位。` 外不输出任何内容。
- `<角色名>` / `<地点名>` 来自规划回合输出的制作清单（见下节）：立绘按清单角色行、背景按清单地点行逐项发送（v1.1 固定发 `美术：背景 开场场景` 的做法已随清单化移除）。
- `美术：立绘 <角色名>`：先走生成前缓存检查（当前剧本 `presets/<剧本 id>/assets/` 同名文件，见「资产管线」）；未命中时该角色 state 已有 `art_file` 则直接复用路径不重新生成，否则按【美术】规则生成并记入角色卡。`美术：背景 <地点名>` 同理。
- 带 `-<变体>` 后缀的是差分项（清单差分行原文，如 `美术：立绘 薇拉-微笑`）：按【美术】差分生成规则出图、不写角色卡 `art_file`；生成前缓存命中 `presets/<剧本 id>/assets/立绘-薇拉-微笑.jpg` 则直接复用路径出标记。
- **确认句格式**：每条美术指令引擎只回两样——一行 `【图】立绘|<角色名>[-<变体>]|<相对路径>`（背景同理）标记 + 一句不超过 12 字的确认（如 `薇拉 · 完成`、`薇拉-微笑 · 完成`、`旅店 · 完成`），本轮结束；不写剧情、不写旁白。
- `开演。`：队列全部完成后发送。已规划本章剧情树时从树的当前节点演出（每章首次即第一个节点）；没有任何树（异常回退路径）时按剧本 `opening` 演出第一幕，随后走【每轮协议】。
- 队列推进与容错在 `src/store/game.ts`（`init` → `planning` → `queue` → `starting` → `finished`）：init 确认待命后发章节规划指令；planning 解析制作清单并清点既有资产预过滤（见「资产管线」）；queue 逐项发指令，单项失败（error 事件 / 610s 看门狗超时 `WATCHDOG_MS`，需覆盖 server 600s 回合超时）标记 failed 不阻塞队列；规划回合失败或清单为空直接发 `开演。`（引擎按无树回退 opening）不卡死；「跳过剩余，立即开演」在 planning / queue 阶段可用，把 pending/running 全部置 skipped 后直接发 `开演。`。

### 素材重绘指令（客户端 → 引擎，画廊，v1.3）

画廊里对单个已有素材的重新生成（管理操作，不是剧情指令）。由 `src/lib/parser.ts` 的 `buildRegenCommand` 构造：

```
美术：重绘 立绘 <角色名>[-<变体>]
美术：重绘 背景 <地点名>
美术：重绘 封面 <剧本id>
```

- 重绘是**唯一允许绕过生成前缓存检查的路径**：引擎收到即重新调用 `image_gen`，绝不因文件已存在而跳过。prompt 同源（立绘 = `art_style` + 角色卡 `art_prompt`，差分再叠加同人物后缀；背景 = `art_style` + 地点英文描述；封面 = 剧本题材 + `art_style`），一律追加 `, fresh take, different composition, same canonical design`。
- 引擎只回一行带第四段的标记 `【图】<类型>|<名>|<路径>|重绘` + 一句不超过 12 字的确认（如 `薇拉 · 重绘完成`），不产生任何剧情文字。封面标记的名是剧本标题（如 `【图】封面|末代天子|presets/twilight-throne/cover.jpg|重绘`）。
- 客户端（`store/game.ts` `startRegen`/`finishRegen`）发指令时挂起 `regenPending = 类型|标记名`，收到对应重绘标记或回合结束即解除，`assetsStamp` 自增让画廊刷新并以 `v=` 破缓存换新图；引擎忙时按钮禁用（再挡一层 409）。

### 章节规划指令（客户端 → 引擎，v1.2 章间制作流程）

由 `src/lib/parser.ts` 的 `buildPlanCommand` 构造，章号 N 从 1 起：

```
规划：第 N 章。
```

- 引擎收到后生成本章完整剧情树写入 `state/worlds/<worldId>/story-tree.md`（见「章节与剧情树」），该回合的输出是且仅是制作清单（下节）。
- 发送时机（`src/store/game.ts`）：开局待命回合确认后发第 1 章；game 屏收到【章】标记后自动发 `规划：第 N+1 章。`。

### 创作模式指令与【新剧本】（客户端 ↔ 引擎，v1.3）

玩家用自然语言与引擎共创新剧本，与游戏会话同屏共存、同一会话内切换。两条指令由 `src/lib/parser.ts` 常量构造（逐字）：

```
创作模式：进入剧本创作。
装配。
```

- **进入**：TitleScreen 右下「创作新剧本」入口 → `openCreation` 首次进入即发 `ENTER_CREATION`。引擎暂停演出、不读写 `state/`，用 2–4 个问题打磨剧本（题材世界观 → 主要角色 2–4 个含 `art_prompt` → 尺度基调 → 主角卡与 quick_start → 章节锚点 → theme 配色与 motif），玩家口语回复均可。此阶段输出为普通对话，不写剧情。
- **装配**：玩家点「开始装配」→ `sendCreation(BUILD_ASSEMBLE)` 发 `装配。`。引擎一次性完成：写 `presets/<id>/preset.md`（小节标题前缀与现有剧本一字不差，server 解析器按标题抓取）、生成封面（`【图】封面|<剧本标题>|<路径>`）与 2–3 个主要角色基础立绘（走生成前缓存检查），逐项输出【图】标记点亮创作屏的装配清单；文件写入仅限 `presets/<新id>/`，绝不改现有剧本与 `state/`。
- **完成**：引擎输出 `【新剧本】<preset-id>` 后退出创作模式、回到待命。server `parsePresetAddedLine` 把该行转成 `presetAdded` 事件 → 前端刷新 `/api/presets`（新卡带即时入轮播）、创作屏转成功态（`creationResult`），玩家点「去选它」回标题屏。
- **容错**：装配回合结束仍没收到【新剧本】→ `assemblyStalled` 显示「重试装配」；错误/超时同样解除挂起。创作模式回合的正文不进游戏历史。

### 剧情编辑指令与【树】行（客户端 ↔ 引擎，v1.5）

剧情图屏（StoryTreeScreen）对已有剧情树的自然语言修改。指令由 `src/lib/parser.ts` 的 `buildTreeEditCommand` 构造：

```
剧情：<自然语言指令>
```

- 例：`剧情：把第 3 章通往教堂的分支改成通往酒馆`。引擎按【剧情编辑指令】改树并静默写回 `state/worlds/<worldId>/story-tree.md`；本轮不写剧情正文、不出选项，只回一句 ≤30 字修改摘要，随后单独成段输出一行 `【树】` 标记。
- **【树】是协议行**：server `parseTreeLine` 命中流式完整行 → 广播 SSE `{ type: "treeEdited" }`（只转发、不落盘）；前端图屏据此重取 `/api/tree` 刷新。`isProtocolLine` 整行过滤【树】，不进正文与历史；编辑回合的可见摘要随 `turn_end` 落到剧情图屏提示条（`treeNotice`），同样不进历史。
- 图屏解析用 `parseStoryTree`（容错）：解析不出结构时回退显示树文件原文；节点布局由 `src/lib/treeLayout.ts` 的 `layoutTree` 计算（纯函数，见「前端结构」）。

### 制作清单与章标记（引擎 → 客户端）

```
【清单】立绘|<角色名>
【清单】立绘|<角色名>-<变体名>
【清单】背景|<地点名>
【章】第 N 章 完
```

- `【清单】` 行只出现在规划回合：本章全部角色与全部地点各一行（含玩家可能走不到的分支专属项；已生成过的也照列，客户端过滤缓存），清单行各自单独成段，除此之外该回合不输出任何文字。客户端 `parseManifest` 整行匹配（行内前缀不误匹配）构建制作队列。
- **差分清单项**（v1.3）：`【清单】立绘|<角色名>-<变体名>`（如 `【清单】立绘|薇拉-微笑`）作为独立清单项输出——差分对象在规划回合确定（恋爱线/高好感候选 2–3 人，每人基础 + 表情差分三项：微笑/动容/伤感；最高好感线角色另加一个服装/姿势变体，如 `薇拉-礼服`），次要角色只列基础项。客户端 `splitAssetVariant` 按第一个连字符拆出角色名与变体：槽位显示「薇拉 · 微笑」、指令按清单原文发送；差分【图】标记只填制作槽位，不替换演出中的主立绘。
- `【章】` 标记出现在终章节点演出完毕的回合：正文收束本章后单独成段输出，该轮不出选项（引擎侧对「以选项结束」的唯一例外）。客户端 `parseChapterMark` 解出章号 N → 切 crafting 屏、`chapterNo = N+1`、自动发下一章规划指令。
- **解析注意：对该回合全文扫描，非仅末段**。规划回合引擎先调工具写剧情树（触发段切换）再输出清单行，清单可能不在最终段；终章回合的【章】行之后也可能还跟一段引擎的静默工具调用。两处解析都取 `Object.values(segs).join("\n")` 的全回合拼接文本——与【图】标记的「末段扫描」不同。
- `【清单】`/`【章】` 与 `【图】`/`【立绘】`/`【新剧本】`/`【树】` 同为协议行：`isProtocolLine` 整行过滤，不进对话正文与历史（含流式打字机与选项段）。

### **行动** 选项段（引擎 → 客户端）

正文之后空一行，加粗一行「**行动**」，随后每行一个编号选项：

```
<正文若干段>

**行动**
1. 推门进去
2. 在门外再听一会儿
```

客户端解析（`parser.ts` `parseOptions`）：正则 `/\*\*行动\*\*\s*\n([\s\S]+)$/` 定位选项段；每行 `/^(\d+)[.、]\s*(.+)$/` 同时接受 `1.` 与 `1、`，无编号行整行视为选项；【图】行被过滤。没有选项段则不渲染按钮（自由输入仍可用）。

多问场景（仅自由输入回退的文本降级路径）：每个问题单独从 1 编号、加粗小标题分隔——客户端 UI 不使用，但 RULES 与 SKILL 保留该约定。

### 【图】标记行（引擎 → 客户端 → server）

格式（逐字，三段 + 可选第四段「重绘」）：

```
【图】立绘|<角色名>[-<变体>]|<相对路径>
【图】背景|<地点名>|<相对路径>
【图】封面|<剧本标题>|<相对路径>
【图】<类型>|<名>|<相对路径>|重绘
```

`<相对路径>` 形如 `images/N.jpg`（image_gen 落在 per-session 目录里的相对路径），也可以直接是 `presets/<剧本 id>/assets/…` / `presets/<id>/cover.jpg`——生成前缓存命中时引擎直接复用永久层路径出标记。

- 立绘名为 `<角色名>-<变体>` 即差分标记（如 `【图】立绘|薇拉-微笑|images/7.jpg`），只填制作槽位、不替换主立绘；封面由创作模式装配与封面重绘产出，名为剧本标题。
- 第四段固定为「重绘」（如 `【图】立绘|薇拉-微笑|images/12.jpg|重绘`），仅由【素材重绘】输出，表示覆盖旧图的新版本——客户端据此解除重绘挂起并破缓存。
- **末尾追加规则**：标记行只出现在回复最末尾（正文与选项之后）。例外：美术预载（旧单回合路径）、分项美术指令阶段与创作模式装配期间——允许标记单独成段、出现在正文之前（SKILL.md「美术」「美术预载」「分项美术指令」「剧本创作」小节），客户端「制作中」屏与创作屏装配清单据此逐格点亮。
- **完整行才生效**：流式期间前端 `scanMarkers` 只匹配以 `\n` 结尾的完整行（防半截路径提前闪图），server `ingestChunkText` 同样只处理完整行；`turn_end` 用 `finalMarkers`（行尾锚定 `\s*$`）兜底「最后一行没有换行符」的情况。流式打字机目标 `visibleTarget` 会额外丢弃仍在增长的最后一行。
- **去重与重放**：流式期间按 `kind|name|path` 整行 key 去重（同段 chunk 会重复扫描）；`turn_end` 全量重放不去重——回到旧背景等场景需要重新显示历史标记。重绘标记的去重检查之前处理（重复出现的重绘标记也要触发画廊刷新）。
- **不进正文**：`isProtocolLine` 把整行以【图】/【清单】/【章】/【立绘】/【新剧本】/【树】开头的协议行过滤，不进对话正文与历史记录。
- **缓存**（引擎侧纪律，两层叠加）：① **生成前缓存检查（硬规则）**——任何 `image_gen` 调用前先确定当前剧本 id（见「资产管线」），再查 `presets/<剧本 id>/assets/` 下同名文件（`presets/rift-mark/assets/立绘-薇拉.jpg`、`presets/rift-mark/assets/立绘-薇拉-微笑.jpg`、`presets/rift-mark/assets/背景-灰雀镇教堂.jpg`…），命中直接用该路径出标记、绝不重新生成，覆盖所有路径（章节制作、无树开局、中途新角色、多周目），唯一例外是【素材重绘】的显式重绘指令；② state 缓存——角色卡已有 `art_file`、地点已在「场景美术」清单不再生成；续档会话第一轮按已记录路径重发标记行恢复画面（不重新生成）。另有一条**资产目录纪律**硬规则：素材一律写进当前剧本目录，绝不使用或新建全局 `assets/` 池。

### 【立绘】表情切换行（引擎 → server → 客户端，v1.3）

剧情演出中，角色台词或在场情绪显著变化、需要切换差分立绘时，引擎在正文段落之间插入一行（单独成行）：

```
【立绘】<角色名>|<变体名>
```

- 变体名为空（如 `【立绘】薇拉|`）回基础立绘；每轮至多切换 2 次，无变化不切换（避免闪烁）。表情怎么选由导演层第 8 条「情绪-差分联动」决定：按当前节点角色情绪选表情差分（微笑/动容/伤感），好感度调制默认表情（高好感偏微笑、低好感回基础/冷淡），服装变体只在对应剧情场景切换；切换发生时同步角色卡 `表情:` 字段。
- **它是画面切换指令，不是资产标记**：不携带路径、server 不持久化。server `parseExpressionLine` 把流式完整行转成 SSE `expression{character, variant}` 事件；与【图】按前缀区分，绝不混用。
- 前端处理（`store/game.ts` `nextPortraitOnExpression`）：当前立绘就是该角色则只换 variant/url（保留 `baseUrl`）；否则新建立绘槽位（当前剧本 assets 永久层兜底）。差分图 URL 按 `presets/<剧本 id>/assets/立绘-<角色>-<变体>.jpg` 直服；素材未生成（404）时 `PortraitLayer` 两级回退（差分 → 基础 → 只剩名牌）交叉淡入（0.4s），不打断演出。
- `isProtocolLine` 同样过滤该行，不进对话正文与历史。

### 段过滤原理（旁白兜底）

SKILL 要求引擎全程文本静默，但模型不一定完全遵守（如读存档前冒一句「先核对存档」）。兜底是架构性的：

1. server 给 chunk 标段号 `seg`，初始 0；每遇 `tool_call` / `tool_call_update` 段号 +1 并广播 `seg` 事件。
2. 前端收到比当前更大的 `seg` → 整体重置显示状态（清空正文/选项，`turnKey`+1 重置打字机）。
3. 因此「工具调用之间」产生的文本段最多一闪而过；`turn_end` 只取最终段 `segs[curSeg]` 作为 `finalText`，解析选项与标记、写历史。

即：**旁白只会出现在工具调用之间的段里，前端只渲染最终段**。RULES 第 2 句是第一道防线，段过滤是第二道。

## 世界线与状态文件（v1.5）

运行时进度以「世界」为单位：`state/worlds/<worldId>/` 下三份文件（state.md / summary.md / story-tree.md）；同一剧本可并行多条世界线（多周目、平行线），互相完全独立。`state/worlds/index.json` 是索引（server 侧 `readWorldsIndex`/`writeWorldsIndex`，根常量 `WORLDS_ROOT`，三文件常量 `WORLD_FILES`）。

- **index.json 字段**：每条形如 `{ worldId, preset, title, chapterNo, lastPlayed, note, forkedFrom }`；`worldId` 白名单 `[A-Za-z0-9_-]+`（`WORLD_ID_RE`，防路径穿越）；`forkedFrom` 为 `{ worldId, nodeId }` 或 `null`。
- **磁盘自愈**（`listWorlds`）：`/api/worlds` 以 index 为准但实时纠正磁盘真况——`chapterNo` 读该世界 story-tree.md 正文的最后一个 `## 第 N 章`（`worldChapterNo`）、`lastPlayed` 取三文件最新 mtime（与索引取大者），并补 `exists` 字段；列表按 `lastPlayed` 倒序（最近游玩优先）。
- **旧数据迁移**：server 首次启动跑 `migrateLegacyState`，把旧扁平 `state/*.md` 一次性移入 `state/worlds/main/` 并写索引（幂等：`index.json` 已存在即跳过；无旧数据返回 false 不动）。
- **分叉回退**：在剧情图屏对已走过节点「在此分叉」→ `POST /api/worlds {action:"fork", worldId, nodeId}`：server 复制三文件到新世界目录、按 `forkTreeMarkdown` 回退（`当前进度` 指针 → 分叉节点、轮次清零 `（已走 0 轮）`、`已剪枝` → `可达`）、写 `fork.md` 并在索引记 `forkedFrom`/`note`；**不推演任何内容**。
- **`fork.md` 生命周期**：分叉时由 server 写入（`forkNote`，含来源世界/分叉节点/时间与回退说明）；该世界首次收到 `继续世界：<worldId>。` 时，引擎按其中说明静默校准 state/summary（分叉点之后视为尚未发生）、随后**删除 `fork.md`**——一次性，之后不再处理。

## 章节与剧情树（v1.2）

游戏以章节推进：一局 3–5 章，每章「规划（剧情树）→ 按制作清单生成全部美术 → 开演」，正片期间零美术等待。拆章锚点是 preset 的 `# 章节` 小节（给出既定章数、各章目标与锚点事件；现有三剧本已配 3/4/4 章）；剧本没有该小节时，引擎按「主线与结局锚点」自行拆 3–5 章。

### 树格式（state/worlds/<worldId>/story-tree.md）

每章一棵树；全部节点都要列出（含未走的可达枝与已剪枝枝），归档区仅在新章规划时写入。模板（引擎侧真源：SKILL.md「状态文件格式」）：

```markdown
# 剧情树
## 归档
- 第 N-1 章：<大纲一行>；已走：<节点 id 链>

## 第 N 章：<章节标题>
- 目标: …
- 大纲: <300 字，含分支走向>
- 当前进度: 节点 <id>（已走 X 轮）

### 节点 <id>（<一句话拍点>）
- 地点: …
- 在场: …
- 梗概: …
- 出边: <意图描述> → <id>；<意图> → <id>
- 状态: 可达 | 已走过 | 已剪枝 | 嫁接
```

规划纪律：先写约 300 字本章完整大纲（各分支走向与差异、本章在全局结构中的位置、章末落点），再据此展开节点；12–20 个节点、每节点 2–3 条出边、至少 2 个汇合点、恰好 1 个终章节点（id 固定 `finale`）；第 1 章的第一个节点衔接 preset `opening` 的拍点。规划时同时确定本章差分对象：恋爱线/高好感候选 2–3 人写进大纲一行（如「差分对象：薇拉、沈屿、程野」），最高好感线角色额外指定一个服装/姿势变体场景（如「薇拉 · 礼服」）——差分作为独立清单项输出（见「制作清单与章标记」）。本章角色与地点全集从树的节点里枚举（含玩家可能永远走不到的分支专属项）：新角色写入 `state/worlds/<worldId>/state.md` 角色卡（含 `art_prompt`），全部地点登记进「场景美术」清单（规划阶段只记地点名，路径待生成后回填）——这就是制作清单的来源。

### 骨架语义（ADR-0001：骨架非铁轨）

树约束演出的方式是「骨架」，不是「铁轨」——预生成完整树，但自由输入不被掰回：

- **沿边行进**：每轮演出当前节点（正文推进其梗概），玩家选项是当前节点出边的第一人称化身；选边后静默更新当前指针与「已走过」标记。
- **剪枝**：走过一条边后，因此不再可达的枝标 `状态: 已剪枝`——标记而非删除，树保持完整可审计。
- **嫁接**：玩家自由输入实质偏离当前节点的出边时，先照常即兴演出这一轮，再把结果接入树——新增一个节点和一条指向它的边，状态标 `嫁接`，其出边指向偏离前仍可达的后继；嫁接节点复用本章已制作的地点与角色，不新增美术需求。
- **汇合**：走到汇合点自然合流，各前史以一句过渡吸收。
- **终章**：`finale` 节点演出完毕的回合输出【章】标记（协议见「文本协议契约」），本章结束，等待下一章规划指令。

### 上下文注入策略

每轮只在 thinking 里回忆「当前节点 + 其出边 + 本章大纲首段」，不整树复述（对抗上下文膨胀）；需要全貌时静默重读 `state/worlds/<worldId>/story-tree.md`。规划新章时，把旧章压缩为「大纲一行 + 已走过路径一行」移入文件头部归档区。

### 与节拍表 / 事件池 / 导演层的关系

- **第一节拍表**：被剧情树的节点取代——preset 里保留不删、仅供拆章参考，运行时一律以剧情树为准。
- **事件池**：保留，降级为节点内的节奏调剂。
- **导演层**：继续工作，唯一改动是「节拍消耗」一条改为「节点消耗 + 事件池调剂」。

## 资产管线（v1.5.1：资产随故事走）

问题：image_gen 的产物落在 `~/.grok/sessions/<encodeURIComponent(GAME_ROOT)>/<sessionId>/images/N.jpg`——per-session、文件名只有序号，跨会话不稳定。

解法：按「剧本 + 类型 + 名字」永久落盘到**当前剧本自己的目录**（每个 preset 自带 `art_style`，美术属于某个故事；故事 = 一个可分享/可删除的自包含文件夹，跨剧本不共享素材，见 ADR-0008）。

剧本 id 的来源（落盘决策收敛在纯函数 `resolvePersistPreset({queryPreset, srcRel, currentPresetId, validPreset})`）：显式传入 → 标记第三段路径自带 `presets/<id>/…`（缓存命中时引擎直接这么写）。**v1.5.1 起不再回退 `currentPresetId` 落盘**（阻断修复：否则创作模式装配新剧本时，新剧本的美术会被写进上一局的目录）。拿不到剧本 id → registry 记 `ready:false` + 去重告警，等两件事之一补落盘：① 同一回合稍后到达的 `【新剧本】<id>`（装配流程：server 用新 id 重试全部未就绪条目）；② 带 `&preset=` 的 `/img` 请求（画廊/画面显示时）。`sniffPreset` 只影响「当前剧本」提示与 `/img` 的旧档直服：仅对以 `开局：`/`继续世界：` 开头的指令嗅探（玩家自由输入不得改落盘目录），索引查不到时回退读 `state/worlds/<worldId>/state.md` 的 `- preset:` 并告警。

```
标记行 【图】立绘|薇拉|images/12.jpg
  → server parseArtLine → persistAsset("立绘", "薇拉", "images/12.jpg")
  → resolveImage("12.jpg")：当前会话目录 → 扫全部历史会话取 mtime 最新
  → 拷贝到 GAME_ROOT/presets/rift-mark/assets/立绘-薇拉.jpg
  → 前端 <img src="/img?p=images%2F12.jpg&t=立绘&n=薇拉&preset=rift-mark">

封面标记 【图】封面|末代天子|images/3.jpg
  → 标记名（剧本标题）反查 preset id → 拷贝到 presets/<id>/cover.jpg（随 preset 目录分发）
  → 前端 <img src="/img?p=presets%2F<id>%2Fcover.jpg">（白名单直服）

重绘标记 【图】立绘|薇拉-微笑|images/12.jpg|重绘
  → 第四段「重绘」= 覆盖同名文件（绕过「已存在就跳过」），落盘规则同上

旧档路径 assets/立绘-薇拉.jpg（v1.5 之前的老存档 / 老标记）
  → legacyAssetCandidates：只探测当前剧本目录（不再跨剧本扫描）；命中只读直服，未命中 404 + 去重告警
```

- 文件名 sanitize：名字里的 `\ / : * ? " < > | 「」『』` 与控制字符替换为 `_`。
- 落盘时机：标记行到达（完整行）即尝试；`turn_end` 对未就绪项补跑一次（图片文件可能晚于标记落盘）。
- **落盘目录纪律**（双侧硬规则）：引擎侧「素材一律写进当前剧本的 `presets/<剧本 id>/assets/`，绝不使用或新建全局 `assets/` 池」（SKILL.md【美术】「资产目录纪律」）；server 侧 `assetRelPath(type, name, presetId)` 是唯一路径构造入口，顶层 `assets/` 目录自 v1.5.1 起不再存在。
- 缓存规则（硬规则，引擎侧）：任何 `image_gen` 调用前先确定当前剧本 id，再查该剧本 `presets/<剧本 id>/assets/` 同名文件（含差分 `立绘-<角色>-<变体>.jpg`），命中直接复用该路径出标记（如 `【图】立绘|薇拉|presets/rift-mark/assets/立绘-薇拉.jpg`）绝不重新生成，覆盖所有开局路径；与 state 缓存（`art_file`/「场景美术」清单）叠加生效；**唯一例外是重绘指令**——收到 `美术：重绘 …` 即重新生成并覆盖。封面目标固定 `presets/<id>/cover.jpg`（server 由标记名=剧本标题反查 preset id，查不到回退已知的当前剧本 id，仍拿不到则不落盘），重绘标志要求覆盖同名文件。
- **旧档兼容**（v1.5.1，只读）：老存档与老标记里的 `assets/<类型>-<名>.jpg` 由 `legacyAssetCandidates(rel, 当前剧本)` **只在当前剧本目录**（`presets/<剧本 id>/assets/<文件>`）内探测一次——命中直服，**不跨剧本扫描、不迁落**（避免把别的故事的同名素材显示进本故事）；未命中 404 并去重告警。老存档 state 里的 `art_file` 路径无需改写。
- **跨剧本不共享素材**（刻意取舍）：`presets/<id>/assets/` 只服务该剧本，画廊 `GET /api/assets?preset=<id>` 只扫这个目录、`inUse` 只扫该剧本的世界，换剧本不再串味；同名角色在不同剧本各存一份（否决了全局池 + 前缀隔离与复制共享素材两种方案，见 ADR-0008）。
- **制作中屏预过滤**（`/api/assets?preset=<id>`，清单驱动）：规划回合解析出制作清单后，客户端清点该剧本既有资产——立绘与背景一视同仁：按名字归一化匹配（`assetNameMatches`：`trim` 后完全一致或互为包含，且**差分变体必须一致**——基础立绘不吸收差分项），命中且 `ready` 的项直接置为就绪、用 `assetFileUrl` 指向 `presets/<id>/assets/` 永久层直服，连生成指令都不发；清点失败等同全量重做，不阻塞流程。引擎侧规划已做缓存感知，这里只是第二道闸。

### `/img` 解析顺序（`?p=&t=&n=&preset=`）

1. 当前剧本判定：显式 `&preset=` 合法则用它；否则回退嗅探出的 `currentPresetId`（**只用于旧档只读探测**；落盘一律要求显式来源：`&preset=`、标记路径或【新剧本】）。
2. 带 `t`&`n` 且有当前剧本：`presets/<剧本 id>/assets/<t>-<sanitized(n)>.jpg` 存在 → 直接返回（该剧本永久命中优先）。
3. 否则 `p` 形如 `images/<N>.jpg` 且有 sessionId：`resolveImage`（当前会话 → 跨会话最新 mtime）；带 `t`&`n` 时顺手落盘到当前剧本的 `assets/` 再返回。
4. 旧档兼容（只读）：`p` 形如 `assets/<文件>.jpg` 时在**当前剧本目录**内探测一次——命中直服，未命中 404（不跨剧本扫描、不迁落）。
5. 已落盘资产直服白名单：`p` 匹配 `presets/<id>/assets/<文件>.jpg` 或 `presets/<id>/cover.jpg`（差分立绘、封面与画廊预览走这里，可带 `v=` 破缓存戳）——resolve 后必须仍在 GAME_ROOT 内。
6. 都不命中 → 404。

响应带 `cache-control: public, max-age=86400`。

## HTTP / SSE API 一览

| 端点 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 文本 banner（API 导览） |
| `/api/presets` | GET | 扫描 `presets/*/preset.md` → `{ presets: [{ id, title, tagline, genre, rating, characters, protagonist_card, theme }], errors }`（每次请求实时扫描；theme 逐键兜底，见「主题系统」） |
| `/api/auth` | GET | `{ loggedIn }`（`~/.grok/auth.json` 存在性） |
| `/api/assets?preset=<id>` | GET | **该剧本**的资产清单（画廊与制作中屏清点共用）：`preset` 必填且须匹配 `[A-Za-z0-9_-]+`，缺失或非法 → 400 `{ error }`（v1.5.1 起不再有全局池）；磁盘扫描 `presets/<id>/assets/` 与 `presets/<id>/cover.jpg`，registry 补充未落盘项；每条形如 `{ type, name, variant, file, ready, inUse, mtime }`——`variant` 从文件名拆差分、`inUse` **只扫该剧本的世界**（`index.json` 按 preset 过滤后，任一 `state.md` 文本含名字即「在用」）、`mtime` 供画廊破缓存 |
| `/api/worlds` | GET | 世界线列表（可选 `?preset=<id>` 过滤）→ `{ worlds: [{ worldId, preset, title, chapterNo, lastPlayed, note, forkedFrom, exists }] }`；`chapterNo` 读 story-tree.md、`lastPlayed` 取三文件最新 mtime（磁盘自愈），按最近游玩倒序 |
| `/api/worlds` | POST | 世界线管理 `{ action }`：`create`（分配 id、写索引）/ `fork`（`{action:"fork",worldId,nodeId}` 复制三文件+回退+写 fork.md，不推演）/ `delete`（`{action:"delete",worldId}` 删目录与索引）；失败 400 `{ ok:false, error }` |
| `/api/tree` | GET | 剧情树原文 `?worldId=`（缺省 `main`）→ `{ worldId, markdown }`；无树 404（剧情图屏 `parseStoryTree` 解析用） |
| `/img?p=&t=&n=&preset=` | GET | 图片服务（解析顺序见上：当前剧本永久命中 → 会话兜底 → 旧档 `assets/` 兼容 → 白名单直服） |
| `/events` | GET | SSE（`retry: 2000`），回合事件流 |
| `/prompt` | POST | `{ text }` → `{ ok, error }`；空文本 400；上一回合进行中 409 |
| `/app`、`/app/*` | GET | 打包前端静态托管；优先 `resources/app-dist`，兜底 `GAME_ROOT/dist`；SPA fallback 到 `index.html`；带路径穿越防护 |

## 前端结构（src/）

屏幕流（zustand `screen` 状态机）：`boot`（登录检查）→ `title`（卡带式剧本轮播：`← →` 切卡、Enter / 点中央卡「插卡」装载，卡底铺各自封面、无封面回退主题渐变；右下角「素材」「创作新剧本」入口）→ `worlds`（世界线屏：列出该剧本已有世界，继续/新世界线/两段确认删除；键盘导航）→ `protagonist`（捏人 chips / 快速开局）→ `crafting`（仅「制作美术并开演」路径：待命开局 → 章节规划 → 逐项美术指令 → `开演。`，见「分项美术指令」「章节与剧情树」）→ `game`。章间循环：game 屏收到【章】标记 → 切回 crafting（「第 N+1 章 · 制作中」）→ 自动规划下一章 → 制作 → 开演，往复直至终局。overlay 屏 `assets`（画廊）、`creation`（创作模式）与 `tree`（剧情图）从 title/game/世界线屏进入，`closeOverlay` 返回进入前的原屏（不动回合与画面状态，画廊重绘与游戏态共用引擎回合）；Esc 关闭链（`App.tsx`，输入框聚焦时不拦截）从里往外为「画廊大图预览 → 剧情图节点详情 → 历史抽屉 → 创作屏退出确认 → 剧情图屏 → 世界线屏（回到标题屏）」。

| 文件 | 职责 |
|---|---|
| `App.tsx` | 屏幕切换 + SSE 订阅；根容器按当前剧本注入主题 CSS 变量；背景层常驻（crafting→game 转场不重载） |
| `store/game.ts` | 全局状态机：段过滤、标记应用、表情切换（`expression` → `nextPortraitOnExpression`，差分 URL 拼在 `presets/<id>/assets/` 根上）、`presetAdded` 刷新轮播、选项解析的编排；开局指令构造入口与「制作中」章节制作流水线（init→planning→queue→starting→finished，【章】标记触发章间切章，610s 看门狗）、清单预过滤按 `selected.id` 调 `fetchAssets(presetId)` 只清点当前剧本；画廊重绘挂起（`startRegen`/`finishRegen`）与创作模式装配状态机；v1.5 世界线（`beginNewWorld`/`resumeWorld`，开局/续玩指令携带 `worldId`）与剧情图 overlay（`openTree`/`forkAt`/`treeEdited` 刷新、`剧情：` 编辑回合不进历史） |
| `lib/parser.ts` | 文本协议纯函数：标记/清单/章标记扫描、`stripOptionsBlock`（对话窗与历史从 `**行动**` 截断）、差分名拆分 `splitAssetVariant`、选项解析、开局/分项美术/重绘/章节规划/创作模式指令构造（契约字符串所在）；v1.5 世界段与续玩/剧情编辑指令构造（`build*Opening` 增 worldId 参数、`buildResumeCommand`、`buildTreeEditCommand`）、`parseStoryTree` 容错解析、`assetNameMatches`（trim/互为包含 + 变体须一致）、`isProtocolLine` 纳入【树】 |
| `lib/acp.ts` | HTTP/SSE 客户端与 `AcpEvent`/`Preset`/`AssetEntry`/`WorldEntry` 类型；`fetchAssets(preset)`/`assetUrl(kind,name,preset)` 支撑制作中屏与画廊清点（v1.5.1：`preset` 由 `presetQuery` 拼成 `&preset=`，空则不拼、服务端回退 `currentPresetId`），`assetFileUrl`/`coverUrl` 走 `/img` 白名单直服（差分、封面、画廊破缓存）；`fetchWorlds`/`postWorld`/`fetchTree` 供世界线屏与剧情图屏 |
| `lib/treeLayout.ts` | 剧情图纯函数布局：最长路径分层 + 抗环 + 确定性坐标（`layoutTree`/`LayoutNode`/`LayoutEdge`/`LayoutOptions`），StoryTreeScreen 的 SVG 数据源，可被 node 单测直引 |
| `theme.ts` | 剧本主题：`getTheme` 逐键校验兜底（默认 aurora）、`themeVars` 注入 `--accent`/`--accent2` |
| `components/` | 各屏与游戏 HUD：TitleScreen 封面卡带轮播与插卡动画（`CardCover` 404 回退渐变+motif）、CraftingScreen 制作中屏（planning「章节大纲」槽 → 清单美术网格两段进度，planning/queue 均可跳过；差分槽位显示「薇拉 · 微笑」）、AssetsScreen 画廊（按当前剧本取数 `GET /api/assets?preset=`，立绘按角色分组、背景/封面分组，inUse 角标、大图预览与单项重绘，引擎忙禁用）、CreationScreen 创作模式（打磨对话流 → 装配清单逐项点亮 → 新剧本成功态/重试）、Atmosphere 全局胶片颗粒/暗角、TopBar（左上状态点/状态文字/章号/世界名 chip；右侧竖排轨按钮 历史/素材/剧情图/重开/前情/换剧本/帮助）、DialogueBox（打字机，点击对话框立即补全全文）/FreeInput 等 |
| `components/WorldsScreen.tsx` | 世界线屏：`GET /api/worlds?preset=` 列表（继续 / 新世界线 / 两段确认删除 / 键盘导航）；`继续` 走 `resumeWorld`，`新世界线` 走 `POST /api/worlds {action:"create"}`，删除走 `{action:"delete"}` |
| `components/StoryTreeScreen.tsx` | 剧情图 overlay：`GET /api/tree` 取树原文 → `parseStoryTree` → `layoutTree` 出 SVG 节点图；节点详情、`剧情：` 自然语言编辑（`buildTreeEditCommand`，编辑回合不进历史）、「在此分叉」（`POST /api/worlds {action:"fork"}`）；`treeEdited` 事件触发重取 |
| `components/game/PortraitLayer.tsx` | 立绘层：右下竖排名牌；`expression` 事件换差分只做交叉淡入（0.4s），差分图 404 两级回退（差分 → 基础 → 名牌），不重放浮入动画 |
| `components/motifs/` | 氛围层：`MotifLayer` 按主题 motif 渲染 summer/rune/imperial/aurora 四款纯 CSS/transform 动画图案 |

元命令：TopBar 按钮 → `/new-game` `/recap` `/presets` `/help`；`/new-game`、`/presets` 回合结束后切回标题屏（`awaitCommand`）。自由输入框里打选项编号与点该选项等价（都走 `/prompt`，编号语义由引擎按【行动】编号理解）。

## 主题系统

每个剧本可在 frontmatter 声明 `theme` 块（缩进子键），配色与氛围图案随剧本切换、贯穿标题屏到对话框：

```yaml
theme:
  accent: "#5f8f6e"   # 主色（#hex）
  accent2: "#d9e8dc"  # 辅色（#hex）
  motif: summer       # 氛围图案：summer | rune | imperial | aurora
```

- **server 侧**（`acp-server.mjs`）：`THEME_KEYS` 只认块形式（内联 `theme: x` 视为坏格式）；`normalizeTheme` 逐键兜底——accent/accent2 须 `#hex` 色值、motif 须非空，坏值用默认主题（aurora）的对应键替换，不抛错；解析结果随 `/api/presets` 下发。
- **前端**（`src/theme.ts`）：`getTheme` 对下发字段再校验（hex 色值、motif 须属四枚举），非法或缺省一律回退兜底主题（aurora）；`themeVars` 把 accent/accent2 转成 `--accent`/`--accent2` CSS 变量。
- **注入与消费**：`App` 根容器按当前剧本注入变量；`global.css` 的 `@theme inline` 把 tailwind 的 `gold`/`accent`/`accent2` 色类映射到变量，全站元素（选项 ◇ 子弹与悬停描边、打字机光标、卡面渐变、插卡泛光）随之主题化；标题屏每张卡带按各自 theme 在子树覆盖变量。
- **motif 氛围层**：`components/motifs/` 的四款图案（summer/rune/imperial/aurora）是低透明度纯 CSS/transform/opacity 动画，不干扰阅读；常驻 App 背景与标题屏卡面（`dense` 提高密度）。
- **全局美术**（`components/Atmosphere.tsx`，与主题正交）：胶片颗粒（内联 SVG feTurbulence 噪点 + transform 抖动）与暗角 radial-gradient，常驻 App 顶层、pointer-events-none。

## 打包布局（electron-builder.yml）

```
<安装目录>/
├─ resources/
│  ├─ app.asar            # electron/ + server/ + package.json（+ dist 冗余备份）
│  ├─ app-dist/           # extraResources：dist 副本，acp-server /app 的托管目录
│  └─ game/               # extraResources：GROK_GAME_ROOT（可写数据必须在 asar 外）
│     ├─ .grok/           # skills + commands（引擎）
│     ├─ presets/         # 剧本 + 素材（presets/<id>/assets/ 与 cover.jpg；顶层 assets/ 已不存在）
│     └─ state/           # 只带 README.md（绝不打包本地进度）
```

- productName `Bunkiten`（ASCII，规避 NSIS/非 UTF-8 终端对中文的兼容风险）。
- **`presets/` 随包分发的不只是剧本文件**：立绘/背景（`presets/<id>/assets/`）与封面（`presets/<id>/cover.jpg`）都在里面——打包会把当前仓库的美术一起装进去；顶层 `assets/` 目录在 v1.5.1 已删除，打包配置里不再有它。
- Windows：`npm run dist:win`（x64，`nsis` + `portable`，`CSC_IDENTITY_AUTO_DISCOVERY=false` 不签名）。
- macOS：`npm run dist:mac`（`dmg` + `zip`，arm64 + x64，`identity: null` 不签名）。
- 产物在 `release/`。

## 已知限制

- **引擎过程旁白**：依赖 RULES + 前端段过滤双保险；模型违规输出时中间段会被丢弃，但流式期间可能一闪而过。
- **语音输入**：`FreeInput` 依赖 `webkitSpeechRecognition`，Electron 内置 Chromium 不带该 API（按钮不渲染）；浏览器开发模式（Chrome）可用。
- **mac 包未签名**：首次打开需右键 → 打开。
- **image_gen 依赖账号套餐**（Imagine 额度）：不可用或限额时引擎静默跳过，游戏不受影响。

## 修改指引

### 加一个剧本

复制 `presets/` 下任意子目录改 `preset.md`。字段分两层消费：

| 字段 | 消费方 | 作用 |
|---|---|---|
| frontmatter `id` / `title` / `tagline` / `genre` / `rating` | **server**（`FM_KEYS`） | 标题屏卡片展示；`id`/`title` 必填，缺失整个剧本被跳过 |
| frontmatter `theme`（缩进子键 `accent` / `accent2` / `motif`） | **server**（`THEME_KEYS`）→ 前端 | 剧本主题配色与氛围图案（见「主题系统」）；坏值逐键兜底 aurora 默认 |
| `presets/<id>/cover.jpg`（可选） | **server**（`listAssets` 封面扫描）+ 前端 | 标题屏卡带封面（`coverUrl`，三个官方剧本已配）；缺失回退主题渐变+motif；创作模式装配与封面重绘会自动生成 |
| frontmatter `pov` / `art_style` / `rating` | **引擎**（SKILL 直读原文） | 叙述人称 / 立绘画风 / 尺度基调 |
| `# 世界观`、`# 硬规则` | 引擎 | 背景设定 / 世界不变量 |
| `# quick_start` | 引擎 | 快速开局预设主角 |
| `# 主要角色` 的 `## <角色名>（…）` | **server + 引擎**（server 提取名字列表，预载屏槽位；引擎读全卡） | 每人身份/性格/口癖/agenda/秘密/`art_prompt` |
| `# protagonist_card` | **server + 引擎**（server 提取问题行，捏人屏 chips；引擎开局校验） | 每行 `- 问题: 选项A / 选项B`；标注「选 1-2」允许多选（上限 2） |
| `# opening`、`# 章节`、`# 第一节拍表`、`# 事件池`、`# 主线与结局锚点` | 引擎 | 第一幕指令 / 拆章锚点（章数、各章目标与锚点事件；缺失时按结局锚点自行拆 3–5 章）/ 拆章参考（v1.2 起运行时被剧情树节点取代，保留不删）/ 节点内节奏调剂 / 收束条件 |

无需改任何代码。`/api/presets` 每次请求实时扫描，回标题屏即刷新；给朋友升级就是往他机器的 `resources/game/presets/` 放新文件夹后重启应用。

### 改引擎协议（高危）

文本协议契约散在五处，任何字符串改动必须同步：

| 文件 | 持有的契约 |
|---|---|
| `.grok/skills/bunkiten/SKILL.md` | 引擎侧行为：开局指令与分项美术指令识别、章节规划指令与剧情树纪律（【清单】含差分项/【章】输出）、素材重绘与创作模式指令、每轮协议的【立绘】切换行、**行动**降级格式、【图】标记（三段+重绘段）与预载例外、生成前缓存硬规则、段静默纪律；v1.5 世界线（【世界线】【启动流程】、世界段/续玩指令、世界纪律、fork.md 回退）与剧情编辑（【剧情编辑指令】、【树】行） |
| `src/lib/parser.ts` | 客户端解析/构造：开局指令与分项美术/重绘/章节规划/创作模式指令模板（逐字，含待命/跳过后缀、`美术：` 指令、`开演。`、`规划：第 N 章。`、`ENTER_CREATION`/`BUILD_ASSEMBLE`）、`**行动**` 正则与 `stripOptionsBlock`、标记/清单/章标记正则与差分名拆分、协议行过滤（含【立绘】【新剧本】【树】）；v1.5 世界段（`build*Opening` worldId）/续玩 `buildResumeCommand`/剧情编辑 `buildTreeEditCommand`/`parseStoryTree`/`assetNameMatches` |
| `src/store/game.ts` | 事件编排：段过滤重置逻辑、标记→画面应用、`expression` 表情切换与 `presetAdded` 刷新、章节制作流水线推进（规划→清单→队列→开演→【章】切章）、画廊重绘挂起、创作装配状态机、`awaitCommand` 切屏；v1.5 世界线（`beginNewWorld`/`resumeWorld`）与剧情图 overlay（`openTree`/`forkAt`/`treeEdited`、编辑回合不进历史） |
| `server/acp-server.mjs` | `RULES` 原文（注入 agent 的客户端补丁，含「世界纪律」句）、协议行解析导出（`parseArtLine`/`parseExpressionLine`/`parsePresetAddedLine`/`parseTreeLine`）与 `handleArtLine` 分流、`listAssets(presetId)` 资产形状（每条回填 `preset`；`inUse` 只扫该剧本的世界）、资产落盘纪律（`resolvePersistPreset` 是唯一「落哪个剧本」判定；`assetRelPath`/`assetTargetFile` 是唯一路径构造；封面走 `presets/<id>/cover.jpg`）；v1.5 世界线（`readWorldsIndex`/`listWorlds`/`createWorld`/`forkWorld`/`deleteWorld`/`migrateLegacyState` 与 `/api/worlds`、`/api/tree` 端点） |
| `tests/parser.test.ts`、`tests/crafting.test.ts`、`tests/server.test.ts`、`tests/treeLayout.test.ts`、`tests/ui.test.tsx` | 契约字符串快照与单测：开局指令四变体（含世界段）/续玩/剧情编辑、分项美术/重绘/章节规划/创作模式指令、`开演。`、清单（含差分项）/章标记与选项解析期望值（parser 59 例），章节制作流水线指令序列（crafting 31 例，stub fetch）、世界线/资产落盘判定/协议解析（server 51 例）、布局纯函数（treeLayout 7 例）、组件（ui 23 例） |

v1.3 三组新契约的同步点速查（同一改动五处联动的具体落点）：

| 契约 | 同步点 |
|---|---|
| 差分与表情切换（`【清单】立绘\|<角色>-<变体>` / `美术：立绘 <角色>-<变体>` / `【立绘】<角色>\|<变体>`） | `SKILL.md`【章节与剧情树】差分清单、【每轮协议】【美术】差分规则与导演层第 8 条 · `parser.ts` `splitAssetVariant` · `acp-server.mjs` `parseExpressionLine` · `store/game.ts` `nextPortraitOnExpression` · `PortraitLayer` 两级回退 · `tests` 快照 |
| 重绘（`美术：重绘 <类型> <名>[-<变体>]` 与【图】第四段「重绘」） | `SKILL.md`【素材重绘】+ `RULES` 第 3 句 · `parser.ts` `buildRegenCommand`/`scanMarkers` 四段正则 · `acp-server.mjs` `parseArtLine` regen 分支与 `persistAsset` 覆盖 · `store/game.ts` `startRegen`/`finishRegen` · `tests` 快照 |
| 创作模式（`创作模式：进入剧本创作。` / `装配。` / `【新剧本】<id>`） | `SKILL.md`【剧本创作】+ `RULES` 第 3 句 · `parser.ts` `ENTER_CREATION`/`BUILD_ASSEMBLE`/`isProtocolLine` · `acp-server.mjs` `parsePresetAddedLine` → `presetAdded` 事件 · `store/game.ts` creation 状态机 · `tests` 快照 |

v1.5 世界线 / 剧情树的同步点速查：

| 契约 | 同步点 |
|---|---|
| 世界线（`世界：<worldId>。` / `继续世界：<worldId>。` / `state/worlds/<worldId>/`） | `SKILL.md`【世界线】【启动流程】【状态文件格式】全段 state 路径 · `acp-server.mjs` `WORLDS_ROOT`/`WORLD_FILES` 常量、`readWorldsIndex`/`writeWorldsIndex`/`listWorlds`/`worldChapterNo`/`createWorld`/`forkWorld`/`deleteWorld`/`migrateLegacyState` 与 `/api/worlds`、`/api/tree` 端点 · `parser.ts` `build*Opening`(worldId)/`buildResumeCommand` · `store/game.ts` `beginNewWorld`/`resumeWorld` · `RULES`「世界纪律」句 · `tests/parser.test.ts`+`tests/server.test.ts` 快照 |
| 剧情编辑（`剧情：<指令>` / `【树】` 行） | `SKILL.md`【剧情编辑指令】· `parser.ts` `buildTreeEditCommand`/`parseStoryTree`/`isProtocolLine` · `acp-server.mjs` `parseTreeLine`/`handleArtLine` → `treeEdited` 事件 · `store/game.ts` tree overlay 与「编辑回合不进历史」 · `tests` 快照 |
| 剧情图布局 | `parser.ts`（`parseStoryTree` 与 `TreeNode`/`TreeChapter` 类型）· `treeLayout.ts` `layoutTree` · `StoryTreeScreen.tsx` · `tests/treeLayout.test.ts` |

改完跑 `npm test`（契约快照，改字符串必须同步快照）与 `npm run build` 验证类型与构建。
