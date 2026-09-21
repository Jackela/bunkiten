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
│ approve         │    │  /api/providers /api/assets /img        │
│ --plugin-dir    │    │ · SSE:  /events（回合事件流）            │
│ <gameRoot>/.grok │    │ · 静态托管: /app（打包前端）              │
│ stdio           │    │ · 资产管线 → presets/<id>/assets/…      │
│                 │    │ · 服务目录 → docs/providers.json        │
│ 引擎 = .grok/   │    │                                         │
│  skills/bunkiten│    │                                         │
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

传输：`spawn("grok", ["agent", "--always-approve", "--plugin-dir", path.join(gameRoot, ".grok"), "stdio"])`（`server/acp.mjs`），cwd = GAME_ROOT，逐行 JSON-RPC 2.0。

> **`--plugin-dir` 是 v1.10 起固定的参数（ADR-0021，引擎 skill 注入）**：项目级 skill（`.grok/skills/bunkiten/SKILL.md`）受 grok CLI 的**文件夹信任**门控——两处 game root（开发态 = 仓库根、打包态 = `resources/game`）都未信托，于是每个真实会话开局的 skills reminder 里都没有 bunkiten，纪律的生效完全押在「模型会不会自己翻到那个文件」（实测：`grok inspect --json` 回 `projectTrusted=false`；把目录写进 `~/.grok/trusted_folders.toml` 后才出现，对照实验）。`--plugin-dir <gameRoot>/.grok` 是 **session 级、always trusted** 的注入通道：不看也不改玩家的全局信任文件，加了这个 flag 后 skills reminder 立刻含 `bunkiten`；指向不存在/空目录**无害**（集成 harness 的临时 game root 就没有 `.grok`）。**前提**：该目录里只有 `commands/` 与 `skills/` 两棵子树——`--plugin-dir` 会把它当 always trusted，往 `.grok` 里加 hooks/MCP 等于对引擎无条件授予执行权（目录布局演进时要守住这条，见 ADR-0021）。

### 请求方法（server → agent）

| 方法 | 参数 | 时机与语义 |
|---|---|---|
| `initialize` | `{ protocolVersion: 1, clientCapabilities: {} }` | 启动后（延迟 800ms）握手 |
| `session/load` | `{ sessionId, cwd: GAME_ROOT, mcpServers: [], _meta }` | 断线续档：读取 `GAME_ROOT/.shell-session.json` 里保存的 sessionId 尝试复用（60s 超时） |
| `session/new` | `{ cwd: GAME_ROOT, mcpServers: [], _meta }` | `session/load` 失败或无存档时降级新建 |
| `session/set_config_option` | `{ sessionId, configId: "reasoning_effort", value: { value: "medium" } }` | 会话就绪后设置推理档。**为什么 medium**：游戏回合是叙事演绎而非难题求解，high 档徒增延迟；`EFFORT` 环境变量可调（设 `high` 换更慢更细）。设置失败静默忽略 |
| `session/prompt` | `{ sessionId, prompt: [{ type: "text", text }] }` | 玩家每条输入一回合（600s 超时；回合进行中再发返回 409） |

`_meta`（load/new 都带）：`{ yoloMode: true, rules: RULES }`。`yoloMode` 免工具审批；`rules` 原文（`server/protocol-lines.mjs` 的 `RULES` 常量、入口 `acp-server.mjs` re-export，**六句拼接**，逐字副本如下——契约 lint 会断言本段与常量一致）：

```
本会话运行在自定义游戏客户端下：ask_user_question 卡片工具不可用，选项一律用文本格式（正文后加粗「**行动**」+ 每行一个编号选项，多问场景每个问题单独从 1 编号）。
你的每条回复只能是简体中文剧情正文和文本选项，绝不输出过程旁白、计划说明或英文。
回复最末尾可以追加若干【图】标记行（由 image_gen 产物而来），格式：【图】立绘|角色名|presets/<id>/assets/立绘-角色.jpg、【图】背景|地点名|presets/<id>/assets/背景-地点.jpg 或 【图】封面|剧本标题|presets/<id>/cover.jpg，重绘覆盖旧图时追加第四段|重绘；剧情演出中可穿插【立绘】角色|变体 行切换表情差分，并可穿插【曲】<名> / 【环境】<名> / 【音效】<名> 切换音频，新剧本入轮播后输出【新剧本】<id> 行；规划回合输出【清单】立绘|<名> / 【清单】背景|<地点> 清单行（只列 presets/<剧本 id>/assets/ 缺失项，全命中时输出【清单】空）；终章回合输出【章】第 N 章 完；剧情编辑回合改完树后输出【树】行。这些协议行独立成段，不进剧情正文。
缓存纪律：任何 image_gen 调用前必须先确认当前剧本 presets/<剧本 id>/assets/ 下无同名文件（唯一例外：美术：重绘）。已有素材绝不重复生成，直接出 presets/<剧本 id>/assets/… 路径标记。
世界纪律：所有 state 文件读写一律在当前世界目录 state/worlds/<世界 id>/ 内（世界 id 由客户端指令给出——开局指令的「世界：<id>。」段或「继续世界：<id>。」；未给出时用 main）；除世界线分叉说明（fork.md）外绝不读写其他世界目录。
音频纪律：场景切换或情绪转折时，可用【曲】<名>、【环境】<名>、【音效】<名> 三行切换音频（各自单独成段，不进正文）；每轮【曲】/【环境】至多各一次、【音效】至多两次，无把握就不发；文件由作者放在 presets/<剧本 id>/audio/ 下（命名 <类型>-<名>.<扩展名>），文件不存在时静默不发——绝不生成音频、绝不在标记里写路径。
```

> **改 `RULES` 必须同步本段**：上面六句是 `server/protocol-lines.mjs` 里 `RULES` 数组六项（入口 re-export）的逐字副本（逐句换行展示；常量本身 `.join("")` 成一条，含第 6 句音频纪律与第 3/4/5 句的 `presets/<id>/assets/` 路径口径）。改任一句就要两处一起改。

`rules` 是客户端会话对 SKILL 协议的「补丁」：把卡片交互降级为文本协议（见下节）。agent → server 的请求一律回 `-32601`（客户端不支持）。

### 通知事件（agent → server）

`session/update`，按 `update.sessionUpdate` 分流：

| sessionUpdate | 载荷 | server 处理 → SSE 事件 |
|---|---|---|
| `agent_message_chunk` | `content.text` | 追加进当前段累积文本 → `{ type: "chunk", seg, text }`；同时对流式完整行跑 `handleArtLine`，**分支顺序固定为 art → expression → tree → presetAdded → audio**（`parseArtLine` 命中即 `persistAsset` 并 return；否则依次试 `parseExpressionLine` → `expression` 事件、`parseTreeLine` → `treeEdited` 事件、`parsePresetAddedLine` → `presetAdded` 事件与占位项按新 id 补落盘、`parseAudioLine` → `audio` 事件） |
| `tool_call` / `tool_call_update` | `title` | 段号 +1 → `{ type: "seg", seg, label }`（label 映射状态栏文字，含「图/imag/paint/draw」则显示「作画中…」） |
| 其余（如 `agent_thought_chunk`） | — | 直接丢弃（思考流不透传给前端） |

SSE 事件全集（`/events`）：`turn_start` / `seg{seg,label}` / `chunk{seg,text}` / `expression{character,variant}` / `presetAdded{id}` / `treeEdited` / `audio{kind,name}` / `turn_end` / `error{message}`。`expression`/`presetAdded`/`treeEdited`/`audio` 由【立绘】/【新剧本】/【树】/【曲】【环境】【音效】协议行派发（只转发、不落盘）。`turn_end` 后 server 补跑一次未落盘资产的持久化（图片文件可能晚于标记到达），并在 `flushArtLines()` 之后、`busy=false` 之前落一条逐轮快照（见「逐轮状态快照与精确回退」）。

## 文本协议契约（最重要）

引擎输出的是纯文本，客户端靠字符串约定驱动 UI。**以下每一条字符串都是跨进程契约，改动必须五处同步**（`SKILL.md` / `parser.ts` / `acp-server.mjs` / `store` / `tests` 快照，见「修改指引」）；协议常量（协议头集合、音频白名单与直服正则、指令前缀正则）的**唯一真源是 `shared/protocol.mjs`**（v1.7：`src/lib/parser.ts` re-export、`server/acp-server.mjs` import 同一份值——此前双侧各一份、只靠 lint 比对两份源码文本，见 `docs/adr/0012`）。机器门禁是**契约 lint**（`tests/contract.test.ts`）断言六组契约：`RULES` 逐字副本（server 常量 ↔ 本节代码块——引擎只读 `.grok/` 提示词、不会 import 代码，这份天然双份）、`PROTOCOL_HEADS` 集合（shared 真源 ↔ server/parser 解析出口 ↔ SKILL 备忘 ↔ 本文档）、指令字符串双处存在（`parser.ts` ↔ `SKILL.md`）、指令前缀正则 `DIRECTIVE_PREFIX_RE` 单一真源（`pickEffort` 与 `isMainTurn` 都消费它）、主题白名单与兜底主题（server ↔ `src/theme.ts` 同集）、用例数与本文档/`README.md`/`AGENTS.md` 声明的分组数字一致、设置键与音频扩展名三处一致。改了契约字符串，这几处断言必须同批改（只改一处会被 lint 挡在测试里）。**该 lint 自身不计入文档里声明的合计口径**。

**协议头集合（唯一真源）**：`shared/protocol.mjs` 的 `PROTOCOL_HEADS = ["图", "清单", "章", "立绘", "新剧本", "树", "曲", "环境", "音效"]`（v1.6 起 9 项；`src/lib/parser.ts` re-export 并由它构造 `isProtocolLine` 的正则）。这 9 个头与 server 侧各 `parse*`、SKILL.md 备忘、本文档表格四处必须一致——契约 lint 会断言。

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
- `【清单】`/`【章】` 与 `【图】`/`【立绘】`/`【新剧本】`/`【树】`/`【曲】`/`【环境】`/`【音效】` 同为协议行：`isProtocolLine`（按 `PROTOCOL_HEADS` 的 9 个头）整行过滤，不进对话正文与历史（含流式打字机与选项段）。

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
- **不进正文**：`isProtocolLine` 把整行以【图】/【清单】/【章】/【立绘】/【新剧本】/【树】/【曲】/【环境】/【音效】开头的协议行过滤，不进对话正文与历史记录。
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

### 【曲】/【环境】/【音效】音频协议行（引擎 → server → 客户端，v1.6）

剧情演出中切换 BGM / 环境音 / 触发一次性音效时，引擎在正文段落之间插入一行（各自单独成段，可穿插在段落之间，与【立绘】同级）：

```
【曲】<名>
【环境】<名>
【音效】<名>
```

- **语义**：`【曲】<名>` 切 BGM、`【环境】<名>` 切环境音、`【音效】<名>` 触发一次性音效（**无停止语义**）；停止用 `【曲】停` / `【环境】停`——`停` 就是一个普通的名字，由客户端翻译成淡出，server 不做特判。
- **不携带路径**：`<名>` 是不含 `|` 与换行的短名，必须与文件名里的 `<名>` 一致；路径永不出现在标记里（这是与【图】的根本区别——【图】必须带路径）。文件由作者预置在 `presets/<剧本 id>/audio/`，见「音频管线」。
- **频率纪律**（引擎侧，SKILL【音频】+ RULES 第 6 句 + 导演层第 9 条）：每轮【曲】/【环境】至多各 1 次，【音效】至多 2 次；无把握就不发。
- **只在正戏使用**：待命/规划/分项美术/重绘/创作模式装配/剧情编辑回合一律不发音频行。
- **server 侧**：`parseAudioLine(line)` 先 trim 再匹配 `^【(曲|环境|音效)】([^\n]*)$` → `{kind, name} | null`；`handleArtLine` 的末位分支广播 SSE `{ type: "audio", kind, name }`。**不落盘、不生成、不进 `assetRegistry`**（音频不属于美术资产）。
- **客户端侧**：store 的 `handleEvent` 新增 `audio` 分支 → `audioManager.handle({ kind, name })`（不写任何 store 字段，音频与回合状态完全解耦）；`AudioManager` 用 `/api/audio` 索引做「类型+名 → 文件」解析，**索引里没有对应文件就静默 no-op**（`console.debug` 一行），绝不打断剧情。
- `isProtocolLine` 同样过滤这三行，不进对话正文与历史（含流式打字机与选项段）。

### 段过滤原理（旁白兜底）

SKILL 要求引擎全程文本静默，但模型不一定完全遵守（如读存档前冒一句「先核对存档」）。兜底是架构性的：

1. server 给 chunk 标段号 `seg`，初始 0；每遇 `tool_call` / `tool_call_update` 段号 +1 并广播 `seg` 事件。
2. 前端收到比当前更大的 `seg` → 整体重置显示状态（清空正文/选项，`turnKey`+1 重置打字机）。
3. 因此「工具调用之间」产生的文本段最多一闪而过；`turn_end` 只取最终段 `segs[curSeg]` 作为 `finalText`，解析选项与标记、写历史。

即：**旁白只会出现在工具调用之间的段里，前端只渲染最终段**。RULES 第 2 句是第一道防线，段过滤是第二道。

## 世界线与状态文件（v1.5）

运行时进度以「世界」为单位：`state/worlds/<worldId>/` 下三份文件（state.md / summary.md / story-tree.md）；同一剧本可并行多条世界线（多周目、平行线），互相完全独立。`state/worlds/index.json` 是索引（server 侧 `readWorldsIndex`/`writeWorldsIndex`，根常量 `WORLDS_ROOT`，三文件常量 `WORLD_FILES`），顶层是**版本化对象** `{ schema: 1, worlds: [...] }`（v1.9 起；v1.8 及以前是裸数组，读路径两种形态都认）。

- **index.json 字段**：`worlds` 每条形如 `{ worldId, preset, title, label, note, chapterNo, lastPlayed, forkedFrom }`；`worldId` 白名单 `[A-Za-z0-9_-]+`（`WORLD_ID_RE`，防路径穿越）；`forkedFrom` 为 `{ worldId, nodeId }` 或 `{ worldId, nodeId, seq }`（精确分叉才带 `seq`）或 `null`。顶层 `schema` 只记录、不做闸门——读路径只要 `worlds` 是数组就照读（条目仍逐条校验），多出来的顶层键一律忽略。
- **`label` / `note`（v1.6；`note` 的分叉语义 v1.8 起撤销）**：`label` 是玩家起的显示名（`POST /api/worlds {action:"update"}` 写入，≤60 字），`note` 是备注（≤200 字）；两者空串=清除，`listWorlds` 对老索引补 `label: ""`。**分叉不再往 `note` 里写任何东西**：`forkWorld` 把 `note` 固定成空串，血缘只走索引的 `forkedFrom`（精确分叉另带 `seq`）与 `fork.md`——旧版 server 写的「分叉自 <世界> @ <节点>」是裸 id 串，而 `note` 会被显示层当成世界名，等于把 slug 端给玩家。客户端显示名（`WorldsScreen.worldDisplayName`）的回退链是 **`label` → `note` → 所属剧本标题 →「未命名世界线」**，其中 `note` 这一档先过 `src/lib/worlds.ts` 的 `isLegacyForkNote`（旧版分叉备注按「没有备注」处理；顶栏世界名 chip、剧情图标题、制作中屏的世界名同款判定）；**裸 `worldId` 永不上玩家的屏**——它只活在目录名、导出文件名与日志里。改名编辑器在世界线行上的 `⋯` 菜单里，导出/导入的提示位也在世界线屏（`WorldsScreen.tsx`）。
- **磁盘自愈**（`listWorlds`）：`/api/worlds` 以 index 为准但实时纠正磁盘真况——`chapterNo` 读该世界 story-tree.md 正文的最后一个 `## 第 N 章`（`worldChapterNo`）、`lastPlayed` 取三文件最新 mtime（与索引取大者），并补 `exists` 字段；列表按 `lastPlayed` 倒序（最近游玩优先）。
- **旧数据迁移**：server 首次启动跑 `migrateLegacyState`，把旧扁平 `state/*.md` 一次性移入 `state/worlds/main/` 并写索引（幂等：`index.json` 已存在即跳过；无旧数据返回 false 不动）。
- **索引 schema 与启动迁移（v1.9，ADR-0018）**：`startServer` 在 `migrateLegacyState` 之后紧跟一次 `migrateWorldsSchema(WORLDS_ROOT)`（都在 listen 之前，HTTP 一开门索引已是当前形态）——上一步可能刚用新写形态建出索引，那时迁移是 no-op；只有 v1.8 及以前的裸数组才被重写成 `{ schema: 1, worlds }`（缺文件/坏 JSON/已是版本化对象一律不动笔，真的迁过才打一行 `[acp]` 日志）。**未知（未来）schema 永不拒绝、也永不被写坏**：`readWorldsIndex` 只认 `worlds` 是不是数组（`schema` 号不设闸门），`writeWorldsIndex` 是读改写——只换 `worlds`，`schema` 与其余顶层键原样保留、绝不降级成 `schema: 1`；玩家降级安装后的旧版本程序因此不会毁掉新版本写出的索引。
- **删除进回收站（v1.7，ADR-0014）**：删除世界线（`{action:"delete"}`，先移索引再挪目录）与画廊素材（`POST /api/assets {action:"delete"}`）都不直删，统一走 `moveToTrash(root, ...rel)`：整个目录/文件 `rename` 进 `state/trash/<删除时间戳ms>-<随机4>-<原名>/`。trash 长在 `state/` 下，不在任何扫描面内（presets 扫描、worlds 索引、旧档迁移都看不到它），挪进去即从游戏里消失；EXDEV 等 rename 失败回退 `rmSync` 直删并标 `fallback:"purged"`（删除语义优先于回收站）。**不自动清理**，恢复只走手工文档（`state/README.md`「回收站」：世界线目录挪回 `state/worlds/` 并手工补 index.json 条目、素材剥掉 trash 前缀挪回 `presets/<id>/assets/`），客户端只在删除成功文案里说明去向，不做恢复 UI。
- **分叉回退**：在剧情图屏对已走过节点「在此分叉」→ `POST /api/worlds {action:"fork", worldId, nodeId, seq?}`：server 复制三文件到新世界目录、按 `forkTreeMarkdown` 回退（`当前进度` 指针 → 分叉节点、轮次清零 `（已走 0 轮）`、`已剪枝` → `可达`）、写 `fork.md` 并在索引记 `forkedFrom`（`note` 保持空串——血缘不进玩家可见的备注）；**不推演任何内容**。带 `seq`（或该节点有逐轮快照）时走**精确分叉**——见「逐轮状态快照与精确回退」。
- **`fork.md` 生命周期**：分叉时由 server 写入（`forkNote`，含来源世界/分叉节点/时间与回退说明）；该世界首次收到 `继续世界：<worldId>。` 时，引擎按其中说明静默校准 state/summary（分叉点之后视为尚未发生）、随后**删除 `fork.md`**——一次性，之后不再处理。有快照的精确分叉同样写 `fork.md`，但此时三文件已经逐字来自目标快照，`fork.md` 只用于让引擎校准树（不再依赖引擎的保守修正，见 ADR-0009）。
- **导出 / 导入（v1.6）**：`GET /api/worlds/export?worldId=` 出 `.world.json` bundle（三文件全文 + 全部快照 + label/note），`POST /api/worlds {action:"import", bundle}` 落回来（重名加 `-2`/`-3` 后缀、note 追加「（导入）」）；格式与校验见「逐轮状态快照与精确回退」。
- **家谱视图（v1.7；画布 v1.8 补缩放平移与渲染宽度上界）**：世界线屏可切「列表 / 家谱」——家谱把 `forkedFrom` 血缘画成 SVG 森林（节点 = 世界线卡：显示名/章数/分叉节点徽章；边 = 父底边中点 → 子顶边中点的圆角拐弯连线），一眼看出「谁从哪条线哪个节点分叉」。**数据零新增**：布局是纯函数 `src/lib/genealogy.ts` 的 `layoutGenealogy(worlds)`，输入就是 `fetchWorlds` 的 `WorldEntry[]`（`forkedFrom` 为 null 的是根，多根并列）。孤儿语义：`forkedFrom` 指向不存在的世界（父线被删）→ 该节点按根处理并标 `missingParent`（UI 显示「⌫ 父线已删」，不画边）；fork 环（A→B→A，含自指）按「剥洋葱」断环——根先定深度 0，反复定「父已定深」者，剥不动的环成员按输入序当根再剥，必然终止。分层：深度 = 沿 forkedFrom 到根的步数，层内按 lastPlayed 降序（相同取 worldId 升序）横排，坐标全整数、紧凑不留空位。键盘走位用 `genealogyStep` 的确定性规则（←→ 同层左右、↑↓ 跨层取水平最近），选中后的快捷条「继续」复用列表行的 `resumeWorld` 路径，「查看」跳回列表并聚焦对应行。**画布两条不变量**：渲染宽度**只封上界**（单节点 ≈270px／`GEN_MAX_NODE_PX`——两三张卡的小森林不再被 `<svg w-full>` 等比撑到 ~490px/节点，森林更宽时上界够不着、照旧铺满可用宽度）；视图能力（滚轮锚点缩放 / 拖拽平移 / 双击复位 / `−` `适应` `+` / `+ - 0`）复用 `lib/treeLayout` 的 TreeView 纯函数与剧情图同一套交互约定，不另写一套几何。列表视图的行同时收成一个**主行动（「继续」）+ 一个 `⋯` 菜单**（改名/导出/删除；删除的两段确认收在菜单内，菜单一关即作废），屏级快捷键挪到右栏「键盘」卡与页脚。

## 逐轮状态快照与精确回退（v1.6）

问题：v1.5 的分叉靠「复制当前三文件 + 引擎按 `fork.md` 保守修正」——回退精度取决于引擎的推理质量，且只有「切到新世界线」一条路，无法原地回到某一轮。

解法：**每个正戏回合自动落一份三文件全文快照**（append-only），回退与分叉都变成「把快照三文件写回去」的确定性文件操作（见 ADR-0009）。

### 快照文件布局

```
state/worlds/<worldId>/history/0001.json     # 4 位递增、append-only
```

条目结构（`normalizeSnapshot` 是唯一形状，写盘与读取都过它）：

```json
{
  "seq": 1,
  "at": "2026-01-01T00:00:00.000Z",
  "kind": "turn",                        // turn=正戏回合自动快照；backup=回退前自动备份的当前状态
  "nodeId": "3-2",                       // 从 story-tree.md「- 当前进度: 节点 <id>（已走 X 轮）」解析，读不到为 null
  "chapterNo": 3,                        // 读 story-tree.md 的 `## 第 N 章`，读不到为 null
  "files": { "state": "…", "summary": "…", "tree": "…" }   // 三文件全文；当时不存在的文件为 null
}
```

- **写入时机**：`sendPrompt` 内、`flushArtLines()` 之后、`busy = false` 之前（此刻本轮所有落盘都已定型）。
- **只为正戏回合写**（`isMainTurn`）：prompt 不以 `规划：`/`美术：`/`剧情：`/`装配。`/`创作模式：` 开头（前缀正则 `DIRECTIVE_PREFIX_RE`，真源 `shared/protocol.mjs`、与 `pickEffort` 共用）、且不含 `待命：` 才算正戏；规划/美术/编辑/创作回合不产生快照。
- **世界来源**：server 跟踪 `currentWorldId`（在 `sniffPreset` 里与剧本 id 一并落定；指令没给世界段时保持上次值）；世界 id 非法或尚未定下时不写。
- **去重**：与上一条快照 `files` 逐字全等则跳过（不产生重复条目）；`dedupe: false` 只给 `backup` 用（备份必须落盘，否则恢复不可撤）。
- **上限**：`seq > 9999` 不再写并 `warn once`（文件名保持 4 位）。
- **读取**：`/^\d{1,4}\.json$/` 之外的文件名一律跳过，单条坏 JSON 只跳过该条（不让坏档拖垮回退界面）；`latestSnapshot` 只看文件名取最大 seq（O(1)，不再每回合全量 parse 整个 history 目录）。
- **`writeWorldFiles` 的 null 语义**：字符串=写入；null/undefined=**删除该文件**（快照三键就是该时刻磁盘的真实状态，不能让「当时还不存在的 summary.md」在回退后留下后来的内容）。精确分叉、原地回退、导入三处共用这一条。

### 三个入口（API 与语义）

| 动作 | 载荷 | 语义 |
|---|---|---|
| 精确分叉 | `POST /api/worlds {action:"fork", worldId, nodeId, seq?}` | 显式 `seq` 命中优先，否则按 `nodeId` 取**最早匹配**快照（`selectSnapshotForNode`）→ 以快照三文件建新世界（仍写 `fork.md`，引擎只校准树）；索引 `forkedFrom` 带 `seq`（`note` 保持空串——血缘不进玩家可见文案，见「世界线与状态文件」）。**无快照 → 走 v1.5 兼容路径**（复制当前文件 + `forkTreeMarkdown` 回退），旧世界的载荷逐字不变 |
| 原地回退 | `POST /api/worlds {action:"restore", worldId, seq}` | 先写一条 `kind:"backup"`（当前三文件，`dedupe:false`）再覆盖为目标快照；返回 `{ ok:true, backupSeq }`。写备份失败即回退失败（不写半个世界） |
| 自动化 | — | 客户端在回退成功后自增 `treeStamp` 并补发 `继续世界：<worldId>。`（`buildResumeCommand`）——磁盘三文件只是「档」，引擎会话里还留着回退点之后的记忆，必须让它重新读档 |

- **客户端纪律**：`restoreSnapshot` 在引擎忙或有排队指令时**拒绝**（回退覆盖的正是引擎此刻可能正在写的文件），提示「忙碌中，等这一幕结束再回退」；回退是破坏性动作，图屏两段确认（首点进确认态、二点才发）。
- **图屏呈现**：快照索引（`GET /api/history`）驱动节点上的「存档点 · 第 N 幕」标注与「回退到此节点」按钮；有快照的节点「在此分叉」自动携带该 seq。`snapshotTurnNo` 数「seq ≤ 目标的 turn 快照条数」（backup 不算新的一轮）——它只用于内部账目，屏上不印轮次。
- **history 性能取舍**：列表请求只回元信息（不回 `files`）；`GET /api/history?worldId=&seq=<n>` 只读目标文件、只回那一条（预览/重建很热，不为附 `files` 全量 parse 整个目录）。列表读取带**元信息缓存**（v1.7，`server/snapshots.mjs`）：目录项「文件名集合 + 逐文件 mtime」与缓存 stamp 逐项一致 → 直接回缓存（省掉逐文件 readFileSync + JSON.parse 全文）；不一致（新增/删除/覆盖快照文件）→ 全量重解析该目录并更新缓存；`writeSnapshot` 落盘后主动失效，同进程读立刻见新。缓存出口给条目浅拷贝，调用方改返回值不脏缓存。

### 回退后的客户端语义（v1.7）

回退只覆盖磁盘三文件，客户端侧的两件事由 store 补齐，玩家的历史与档不再各说各话：

- **history 非破坏式分割线**：`restoreSnapshot` 成功时往 `history` 追加一条 `{kind:"rollback", seq, at}`（`types.ts` 的 `HistoryRollbackMark`，与正文幕 `{n,t}` 组成 `HistoryItem` union），**不删除任何旧幕**。`HistoryDrawer` 把分割线之前的幕降不透明度（`opacity-50`）、分割线本身渲染成居中细线「—— 已回溯到第 N 幕 ——」；回退后的新回合正文照常叠在分割线之后。
- **待重同步（`pendingResync`）**：restore 成功、补发 `继续世界：<worldId>。` 的同时置 `pendingResync: {worldId, seq}`。该回合 `turn_end` 成功 → 清除；失败（POST `/prompt` 409/网络异常，或引擎回 error → SSE `error` 事件）→ 保留并置 `resyncFailed`。UI 三处可见：TopBar「待重同步」徽章（失败时旁边长出「再同步」按钮，点击重发 `buildResumeCommand` 走正常 send 流程）、`WorldsScreen` 对应世界行内小标、图屏提示条 `treeNotice` 三态文案（「正在同步进度…」→「已回到第 N 幕，进度已同步」→「重同步失败，可点再同步重试」）。
- **不持久化的理由**：`pendingResync` 是会话内内存态。App 重启后玩家走「继续世界线」本来就会重发续玩指令重读档，语义自洽；换世界/换本时由 `resetRunState` 一并清掉。

**引擎 error response 的传播**：`session/prompt` 若按 JSON-RPC 回 `error`（而非断流/超时），`sendPrompt` 显式抛错落进既有 catch——SSE 广播 `error` 事件、`busy` 复位、**不写快照**、`POST /prompt` 回 409。此前该形态被当成功回合处理（照写快照、广播 `turn_end`、HTTP 200）。

### 重演本幕（reroll，v1.7）

「重演」（内部仍叫 reroll/`rerollTurn`）= 撤销刚结束的正戏回合并重发同一玩家输入（TopBar 右侧「重演」按钮，`rerollTurn` 在 tree slice 里与 `restoreSnapshot` 共用「restore + 分割线 + 重同步」内核，同一套时序不复制）。完整五步：

1. **取目标**：`GET /api/history` 取 `kind:"turn"` 的快照，**次新**的那条 = 上一回合结束态（最新那条是刚结束的本回合；`backup` 不参与计数）。不足两条（本世界第一回合）→ status 反馈「无法重掷」并中止，不打扰服务端。**入口可见性**由 `turnSnapshots`（当前世界已知的 turn 快照数）决定：建新世界置 0（`beginNewWorld` 与开局 `startGame` 的 resetRunState 都带——后者会把前者的 0 清掉，所以两处都要）；入场（`resumeWorld`，含切分叉）与「未知或 <2」的回合收尾按需补拉一次 `/api/history`（`context.refreshTurnSnapshots`，数够即停；补拉失败把已知值回落为 null——宁可展示 + 点击判定，不永久藏住可能可用的功能）；已知 <2 → 按钮不渲染，null（未知）→ 仍展示、点击后再判定。
2. **回退**：`POST /api/worlds {action:"restore", worldId, seq: <次新>}`——与剧情图回退同一端点，server 先写 `backup` 快照再覆盖三文件（server 侧零改动）。
3. **重同步**：history 追加带 `reason:"reroll"` 的分割线（`HistoryRollbackMark.reason`；渲染为「—— 第 N 幕已重演 ——」，`restore`/缺省保持「—— 已回溯到第 N 幕 ——」）、置 `pendingResync`/`resyncing`、发 `继续世界：<worldId>。`——**不能只重发 prompt**：引擎会话记忆仍带着上一掷的叙事，必须让它重读档。
4. **排队跟进**：重掷时把玩家输入存进 `pendingRerollPrompt`；重同步回合 `turn_end` 成功、清完 `pendingResync` 之后立即经 `sendPlayerTurn` 重发并清空（走正常玩家回合路径）。防重入：先清后发，且只有 `resyncing` 收尾的回合认领。重同步失败 → `pendingRerollPrompt` 保留，玩家点「再同步」成功后照常跟进；玩家改发普通指令 → 随 `pendingResync` 在 send 入口一并静默作废。
5. **输入记账**：`lastTurnPrompt`（上一成功玩家回合的输入）由玩家叙事输入的两个入口（OptionList 选项、FreeInput 自由输入；自动前进代点同路径）在 send 前记进在途的 `pendingTurnPrompt`，`turn_end` 成功时定格；指令类发送（美术/规划/剧情/续档…）不经玩家入口，天然不记录。投递失败或引擎出错即在途作废。`resetRunState` 清空全部三个字段。

**连掷**：重掷出的新回合照常走玩家路径（`pendingTurnPrompt` 重新记录、`turn_end` 重新定格），回合结束即恢复重掷入口——再点一次就按**此刻**快照账本的次新 turn 快照重新走一遍五步。三个记账字段都是会话内内存态，理由同 `pendingResync`。

### 快照对比（diff，v1.7）

ADR-0007 许诺的「看两份存档差在哪」：剧情图节点详情在快照**有基线**时显示「与上一个存档点对比」按钮，点开拉两条快照全文（`GET /api/history?worldId=&seq=` 各取当前与基线），逐行 diff 后按三个 tab 展示——当前状态 / 前情提要 / 剧情图（↔ `files.state`/`summary`/`tree`，tab 名是玩家侧说法），tab 头给 `+N −M` 摘要。

- **基线的选择**：同世界 history 里 **seq 更小的最近一条**，`kind` 不限——`backup`（回退前的自动备份）也是合法基线，排除它会让回退后的第一个对比无基线可比。全局最小的快照没有基线，不显示按钮。
- **diff 是纯函数**：`src/lib/diff.ts` 的 `diffLines(a, b)`（行级 LCS，经典 O(n·m) DP——三文件通常 <100 行，换 Myers 算法在这个规模没有收益）与 `diffStats(rows)`；以 b（当前快照）为目标：add=b 新增行、remove=a 独有行，替换块 remove 在 add 前（git 惯例）。行尾换行不产生噪音行、空串/undefined 容错为 0 行。
- **面板形态**：详情区内嵌展开（不做浮层——剧情图 overlay 已是一层浮层，App 的 Esc 链只管关 overlay）；remove 行红系、add 行绿系（tailwind 内置 rose/emerald 档，不引新颜色 token）；equal 行 `ink-faint` 且默认折叠——只保留 add/remove 上下各 2 行上下文，其余合并成「…共 N 行未变」可展开（切 tab 回到折叠态）。换节点自动收起；请求过期应答作废（换节点时 bump 请求序号）。
- **剧透口径**：`state.md` 含引擎维护的秘密字段（角色秘密/导演手记）。diff 面板属于玩家**主动**查看两份自己存档的差异，按原文显示、不额外遮蔽。

### 世界线导出包（World Bundle）

`GET /api/worlds/export?worldId=<id>` 回 `Content-Disposition: attachment; filename="<worldId>.world.json"`，体（**v2**，v1.8 起）：

```json
{ "format": "bunkiten-world", "version": 2, "exportedAt": "<ISO>",
  "world": { "worldId": "…", "preset": "…", "title": "…", "label": "…", "note": "…", "chapterNo": 3,
             "forkedFrom": { "worldId": "…", "nodeId": "…", "seq": 1 },
             "files": { "state": "…", "summary": "…", "tree": "…" },
             "snapshots": [ { "seq": 1, "at": "…", "kind": "turn", "nodeId": "…", "chapterNo": 1, "files": { … } } ],
             "forkMd": "# 分叉说明\n…" } }
```

- **血缘（v2 新增的两个键）**：`world.forkedFrom` 是索引条目里的原值（根世界 / 老索引 → `null`），`world.forkMd` 是 `fork.md` 全文（引擎处理完首个回合会自行删除该文件，没有它就是 `null`）。v1 包没有这两个键——少了它们，**导入回来的分叉线在家谱里会变成根**（家谱只认 `forkedFrom`），正好把 v1.8「血缘从 `note` 挪进 `forkedFrom`」那次收拾抵消掉。除这两个键外键序与形状与 v1 一致（`forkedFrom` 排在元数据段末、`forkMd` 跟在 `files`/`snapshots` 之后），**下载文件名不变**。
- 版本常量 `WORLD_BUNDLE_VERSION`（`server/worlds.mjs`，命名与 `presets.mjs` 的 `PRESET_BUNDLE_VERSION` 同款）：**导出写它、导入接受 `1..它`**（下一条）。

`POST /api/worlds {action:"import", bundle}` 的校验与落盘纪律：

- `format === "bunkiten-world" && 1 ≤ version ≤ WORLD_BUNDLE_VERSION && WORLD_ID_RE.test(world.worldId)`——**版本闸是区间不是等值**：v1 包照收、按当前形状补齐（`forkedFrom` 为 `null`、不落 `fork.md`），这就是 ROADMAP §1「旧包 accept + upgrade」策略的落地样板（刻意先于通用迁移钩子做：改动局部、收益立刻可见）。`files.state` 必须是**非空字符串**（空 state 会导入出一个不可玩的世界，一律拒绝）；`label ≤ 60` / `note ≤ 200`（超限 400，绝不静默截断）。
- **血缘坏值降级，不整包拒绝**：`forkedFrom` 逐字段校验（`worldId` 过白名单、`nodeId` 非空字符串、`seq` 可选正整数），**任何一处不合形态整条降级为 `null`**——血缘只作家谱连线用，为它把玩家的整份档挡在门外不划算（与 `files.state` 的硬口径刻意相反）。`forkMd` 是非空字符串才逐字节原样落 `fork.md`（空串 = 「没有这个文件」，不落 0 字节文件）。
- 快照逐条过 `isSnapshotEntry`（seq 1–9999 整数、at 非空字符串、kind ∈ turn|backup、nodeId/chapterNo 可空、files 三键为 string|null），不合法的条目被丢弃而非整包拒绝。
- 重名（索引里有，**或磁盘上有目录但索引缺失**）→ `<id>-2`、`-3`…，绝不覆盖既有世界。
- 落盘：三文件 + `fork.md`（包里有才写）+ 快照目录 + 索引条目（`note` 追加「（导入）」，`forkedFrom` = 包内血缘（v1 包与坏值都是 `null`），`lastPlayed: now`）。
- 客户端侧 `parseWorldBundle` 只做最小校验（能 JSON.parse、format/version 对、`world.worldId` 非空）——重名改名与文件写入一律由服务端裁决，前端不替服务端预判。**它的版本闸当前仍只认 v1**（`src/store/slices/world.ts`）：放宽到 `1..2` 是服务端已就绪、客户端待同批落地的一步，在那之前应用内「导入」会本地挡下 v2 包（服务端 `POST /api/worlds` 已收）。

### 剧本导出包（Preset Bundle，v1.7）

与世界线导出包对称的**剧本**分享通道：标题屏当前卡带「导出」小按钮 → `GET /api/presets/export?id=<id>` 回 `Content-Disposition: attachment; filename="<id>.preset.json"`，体：

```json
{ "format": "bunkiten-preset", "version": 1, "id": "<id>", "title": "<frontmatter title>",
  "exportedAt": "<ISO>", "presetMd": "<preset.md 全文>",
  "assets": { "<文件名>": "<base64>" }, "audio": { "<文件名>": "<base64>" } }
```

导出收文件（`buildPresetBundle(root, id)` 纯函数，root 可注入单测）：`preset.md` 全文；`assets/` 下全部 `jpe?g`（**跳过 assets 里的 cover.jpe?g——那是死路径**）；preset 根的 `cover.jpe?g`（键名就是 `cover.jpg`）；`audio/` 下全部合法扩展名文件。子目录、不认识的扩展名与 0 字节文件一律跳过（保证导出的包能原样导回）。id 非法 400、目录/`preset.md` 不存在 404。

`POST /api/presets {action:"import", bundle}` 的校验与落盘纪律（`importPresetBundle(root, bundle)` 纯函数）：

- `format === "bunkiten-preset" && version === 1 && PRESET_ID_RE.test(id)`；`presetMd` 必须是**非空字符串**。
- **文件名安全**（键名直接拼路径，任何一项不合法整包拒绝、不写半个剧本）：单层文件名（不得含 `/`、`\`、`..`、首尾空白）、**长度 ≤200、非 Windows 保留名**（CON/PRN/AUX/NUL/COM1-9/LPT1-9，按去扩展名 stem 大小写不敏感——超长名/保留名会写盘抛异常，而 server 在 Electron 主进程内运行，异常冒出即应用闪退）；assets 键限 `jpe?g`、audio 键限 `AUDIO_EXTS`（都从 server 既有常量取集合，不抄第二份白名单）。
- **内容校验**：严格 base64（Node 的解码会静默丢弃非法字符，用 round-trip 比对兜住截断/夹私货的形态）；解码总量 ≤50MB。
- **重名语义**：`presets/<id>/` 目录已被占用 → `<id>-2`、`-3`…（与 importWorld 同款循环；占用以磁盘目录为准——presets 没有索引文件）。落地 id 与 frontmatter id 不一致时（重名改名或手写包），preset.md 的 `id:` 行随落地 id 改写——`scanPresets` 按 frontmatter id 进轮播，不改写会出现「目录 demo-2、轮播里还叫 demo」的重复卡带，后续美术/音频也会落错目录。
- 写盘（**临时目录 + rename 进位**，v1.7 审查修复）：全部校验通过后先写 `presets/.tmp-<id>-<随机>`，全量写完再 `renameSync` 进位到 `presets/<id>/`；写盘/rename 的任何 IO 异常都会被 catch、临时目录清理、整包拒绝——磁盘满等环境故障绝不留半个剧本，也绝不让异常冒出函数（Electron 主进程无 uncaughtException 兜底）。落成 `preset.md` + `assets/`（封面键落 preset 根，其余落 `assets/`）+ `audio/`（目录按需建），回 `{ ok:true, id:<实际落地的 id> }`。
- **body 上限例外**：包里是 base64 图片/音频，5MB 不够用——**仅此端点**放宽到 50MB（`readBodyText` 的可选 `maxBytes` 参数；其余调用点仍走 5MB 缺省，http-guard 语义不变）。
- 客户端侧 `parsePresetBundle`（`store/slices/nav.ts`，由 `store/game` 再导出）只做最小校验（能 JSON.parse、format/version 对、`id` 与 `presetMd` 非空）——文件名安全与重名改名一律由服务端裁决。

## 回合日志与质量守卫（v1.7）

问题有二：其一，`turnText` 只在 server 内存里累积、回合结束随下次 `sendPrompt` 清空——引擎某轮说了什么，出问题后无从回溯；其二，引擎偶尔忘写每轮协议要求的 `**行动**` 选项段（玩家没有选项只能自由输入，体验降级）。见 ADR-0015。

### 回合原文日志（logs/NNNN.json）

```
state/worlds/<worldId>/logs/NNNN.json     # 与 history/ 平级；4 位递增、append-only、不清理
```

条目结构（`writeTurnLog` 是唯一写方，`server/snapshots.mjs`）：

```json
{ "seq": 1, "at": "2026-01-01T00:00:00.000Z", "prompt": "推门看看。", "text": "正文…\n**行动**\n1. …" }
```

- **写入时机与判定**：与逐轮快照完全同一处——`sendPrompt` 内 `flushArtLines()` 之后、`busy=false` 之前，`isMainTurn(prompt) && currentWorldId` 才写（指令回合、未开局都不写）。
- **seq 对齐**：正常路径与同回合快照同 seq（`writeSnapshot` 的返回，ok 与 duplicate 分支都带 seq——两边都从空起步、每回合同增，天然 1:1）。快照去重的回合（三文件全等、快照跳过）**日志照写**：日志记的是叙事原文，与三文件去重是两回事，此时对齐值追不上 logs 自己的进度，退回 logs 的 max+1——append-only 永不让步，任何路径都不覆盖既有文件。`restore` 的 `backup` 只进 history 不写日志，同样会让两边步进错位：logs 的定位是「按时间读原文」，不是 join key。
- **溢出**：seq > 9999 与快照同款截断（warn once、不再写）。
- **不进世界线导出包**：`exportWorld` 只读三文件与 `history/`——日志是本机排障面，不是可迁移的档（导入侧的引擎没有这段历史）。fork 也不复制 logs（新世界自己的回合自己记）。
- **无读取端点**：日志只写不读（API 一览无变化），排查时直接看文件。

### 质量守卫（缺选项段自动追问一次）

`sendPrompt` 成功路径里、`flushArtLines()` 与快照/日志落盘之间：`isMainTurn(prompt) && currentWorldId && turnText 不含 **行动**` → 在**同一 busy 窗口内**自动补发一条内部追问（`SUPPLEMENT_PROMPT`，`server/protocol-lines.mjs`，以「补充：」开头、只要求补发完整的每轮协议回合尾，不重述正文）。

- **同一回合语义**：追问复用 acp 会话再发一次 `session/prompt`，chunks 流进同一 `turnText`——客户端看到的是同一回合的补全（SSE chunk 照常流，无任何 client 改动），也省一次 `turn_end`；追问不另写快照与日志条目，日志的 `text` 自然含补全后的全文。
- **一次性**：每回合至多一次（单次判定、无重试循环）。追问后仍缺 `**行动**` 或追问本身失败（引擎 error/超时）都放弃——回合照常成功收尾，日志里留痕（text 缺选项段即证据），玩家仍可自由输入。
- **档位**：追问走 `EFFORT_PLANNING` 低档（它不在 `DIRECTIVE_PREFIX_RE` 前缀集，`pickEffort` 会给正戏档，所以显式指定）；`lastEffort` 已记账，下个正戏回合的 `applyEffort` 自动拉回。
- **边界**：`SUPPLEMENT_PROMPT` 是 server → 引擎的内部指令，**不进 `shared/protocol.mjs`**——客户端从不构造也从不解析它，协议头集合与指令前缀都与它无关；RULES 六句不含它（追问不是给引擎的常驻纪律，是客户端的纠错行为，SKILL「每轮协议」第 5 条已让引擎知情）。

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
  → resolveImage("12.jpg")：当前会话目录 → 会话图索引（跨会话同名取 mtime 最新；索引 miss 才全量重扫，5s TTL 节流）
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
3. 否则 `p` 形如 `images/<N>.jpg` 且有 sessionId：`resolveImage`（当前会话 → 跨会话最新 mtime）；带 `t`&`n` 时顺手落盘到当前剧本的 `assets/` 再返回。跨会话查找走**会话图索引**（v1.7，`server/acp.mjs`，每会话实例一份）：imageName → mtime 最新路径；索引命中且文件仍在 → 直接返回，索引 miss（或条目指向的文件已被删）→ 全量扫会话根下所有会话目录重建索引再查一次，重建后 5s 内的后续 miss 直接 404（`/img` 未命中是低频路径，防会话目录被清后每个请求都重扫；选 TTL 而非目录 mtime 是因为多层父目录的 mtime 不可靠）。sessionId 为 null（boot 前）安全返回不命中，不再抛 TypeError。
4. 旧档兼容（只读）：`p` 形如 `assets/<文件>.jpg` 时在**当前剧本目录**内探测一次——命中直服，未命中 404（不跨剧本扫描、不迁落）。
5. 已落盘资产直服白名单：`p` 匹配 `presets/<id>/assets/<文件>.jpg` 或 `presets/<id>/cover.jpg`（差分立绘、封面与画廊预览走这里，可带 `v=` 破缓存戳）——resolve 后必须仍在 GAME_ROOT 内。
6. 都不命中 → 404。

响应带 `cache-control: public, max-age=86400`。

### 剧本体检查（doctor，v1.7）

`scripts/doctor.mjs`（`npm run doctor`，作者侧 CLI）把上面这些命名契约反向用起来：不再静默跳过对不上的文件，而是逐剧本报给人看。核心是可导入纯函数 `checkPreset(presetDir, root)` / `checkAllPresets(root)`（`tests/doctor.test.ts` 的测试 seam），`main()` 只做打印与退出码；解析口径 import 自 `server/acp-server.mjs`（`parseFrontmatter`/`parseCharacterSections`/`parseSectionLines`/`normalizeTheme`/`PRESET_ID_RE`/`FM_KEYS`/`THEME_KEYS`/`AUDIO_KINDS`/`AUDIO_EXTS`——不抄第二份白名单）与 `src/theme.ts`（`HEX_RE`/`MOTIFS`/`FALLBACK_THEME`；`.ts` 由 Node ≥23.6 的 type stripping 直接 import）。

七组检查：frontmatter 必填键非空（id/title 缺失 = `scanPresets` 跳过、进不了轮播；tagline/genre/rating 缺失 = 标题屏栏位为空——均为 error）、id 过白名单且等于目录名（error）；theme 双层回退预警——先按 server 的 `normalizeTheme` 逐键对比（server 放行 3-8 位 hex、motif 只要求非空），再叠客户端更严的一层（`src/theme.ts` 的 `HEX_RE` 只认 6 位 `#rrggbb`、`MOTIFS` 是 summer/rune/imperial/aurora 闭集；server 放行但客户端会拦下的值单独报「将被客户端回退」，warning）；`# 主要角色` 存在且有 `## <角色名>` 节（error，角色节定位复用 server 的 `parseCharacterSections`——名字抽取规则只有一份），角色节建议字段 `art_prompt`/`agenda`（SKILL 装配模板要求）与 `# protagonist_card` 缺失（warning——快速开局路径仍可用）；`cover.jpg` 缺失、或只有 `cover.jpeg`（客户端 `coverUrl` 只请求 `presets/<id>/cover.jpg`，提示改名；warning）；`assets/` 文件名不匹配 `<立绘|背景>-<名>.jpe?g`（error——落盘与 `/img` 白名单都只认这个形态）；孤儿素材 = 既不被任何世界 `state.md` 引用（扫 `state/worlds/` 全部 state.md，`state/trash` 不算）、也不被任何 preset.md 文本提及（按素材名或差分基础名；warning）；`audio/` 文件名不匹配 `<类型>-<名>.<ext>`（error）与 `类型-名` 多份不同扩展名（warning）。每个剧本输出 `<id> ✓ N 项通过 · M 警告 · K 错误` + `[ok]`/`[warn]`/`[error]` 明细；**退出码非 0 当且仅当存在 error**。

**不进 CI（取舍）**：CI 的测试步骤（`npm run test:coverage`，与 `npm test` 同一批测试文件）已守 doctor 纯函数判定，而「仓库此刻 preset 的健康度」随游玩数据（state/worlds、素材增删）漂移——孤儿素材这类 warning 依赖本机世界进度，门禁化会误伤；它是作者侧工具，改 preset 结构或新增剧本后按需跑。

## 音频管线（v1.6：作者提供，客户端只切换）

问题：剧本需要 BGM / 环境音 / 音效，但本项目**没有任何音频生成能力**（引擎只有 `image_gen`）。

解法：音频是**剧本自带数据**——作者把文件放进剧本目录，引擎只发协议行切换，server 只扫描与直服（见 ADR-0010）。

```
presets/<剧本 id>/audio/曲-雨夜.mp3        # BGM
presets/<剧本 id>/audio/环境-旅店大堂.mp3   # 环境音（循环）
presets/<剧本 id>/audio/音效-门响.wav       # 一次性音效
```

- **命名**：`<类型>-<名>.<扩展名>`，类型 ∈ `曲 | 环境 | 音效`（`AUDIO_KINDS`），扩展名 ∈ `mp3 | ogg | m4a | wav | flac`（`AUDIO_EXTS`；这些常量与下面的 `AUDIO_FILE_RE`/`AUDIO_REL_RE`/`AUDIO_MIME` 真源都在 `shared/protocol.mjs`，server import）；`<名>` 可含中文，不得含 `|` 与换行。文件名解析正则 `AUDIO_FILE_RE`；不匹配的文件被忽略。
- **目录不存在 = 该剧本没有音频**：`scanPresetAudio` 返回空数组，**不报错**；音频不进 `assetRegistry`、不落盘、不生成——`/api/assets` 也从不列音频（音频与美术资产是两条独立管线）。
- **缺失静默**（端到端）：引擎侧「没有对应文件就静默不发」是 SKILL【音频】的硬规则；客户端侧 `AudioManager` 在索引里查不到「类型|名」就是 `console.debug` 一行、no-op——**玩家感知到的只是没有音乐，剧情照常推进**。
- **`GET /api/audio?preset=<id>`** → `{ items: [{ kind, name, file, url }] }`（按文件名排序）；`preset` 必填且须过 `PRESET_ID_RE`，缺失或非法 → 400（与 `/api/assets` 同款）。`url` 是服务端拼好的 `/audio?p=…`，文件名做了百分号编码（名字里可能有 `&`、空格）。
- **`GET /audio?p=<相对路径>`**：两道闸——白名单正则 `AUDIO_REL_RE`（`^presets/[A-Za-z0-9_-]+/audio/[^/]+\.(mp3|ogg|m4a|wav|flac)$`，单层、无子目录）+ `path.resolve` 前缀校验（同 `/img`）；命中即整文件 200（**不做 Range**——音频文件小，客户端拉全量），未命中 404。
- **MIME**（`AUDIO_MIME`）：mp3=`audio/mpeg`、ogg=`audio/ogg`、m4a=`audio/mp4`、wav=`audio/wav`、flac=`audio/flac`；响应带 `cache-control: public, max-age=86400`。
- **客户端播放策略**（`src/lib/audio.ts` 的 `AudioManager` 单例，挂在 store 之外、不依赖 React）：`setPreset(presetId)` 换本时 `stopAll()` 再拉 `/api/audio` 建索引；BGM / 环境音各一对音频元素**交叉淡入 ≈600ms**（`FADE_MS`，`setTimeout` 步进而非 `rAF`——后台标签页 rAF 会停摆），同一首在播不重启；音效一次性、并发上限 4（`MAX_SFX`，超出丢弃）、`ended`/`error`/播放失败/8s 兜底超时四路任一先到即释放槽位；索引未就绪时【曲】/【环境】各挂起最近一条、就绪后补播，【音效】不挂起（补播反而错位）。
- **设置**：音量按「主音量 × 通道音量」叠加，静音归 0（`applySettings` 立即作用到在播通道）；键与默认值见「前端结构」的设置说明。
- **换本/回标题不自动停 BGM**：`selectPreset` 由 `setPreset` 内部 `stopAll()` 收尾（旧本的曲不带进新本）；回标题屏不停（由【曲】停或下一次换本重置）。同一个本重复选卡不打断正在播的曲、也不重拉索引（在途/就绪/已判定失败三种情况都幂等早退）。
- **仓库现状**：`rift-mark` 带 `audio/` 示例目录（三个合成 wav：`曲-夜灯谣.wav` / `环境-雨夜檐滴.wav` / `音效-翻页.wav`，8kHz/16bit/mono PCM，共约 160KB），其余三个 preset 目录**没有** `audio/` 子目录（即默认静默不播）——音频是纯可选增量，加音频只需往剧本目录丢文件、无需改代码。

## 角色面板（v1.7）

游戏屏随时查看引擎维护的角色状态（好感度 / 表情 / 秘密 / 最近互动 / 幕后手记 / 线索 / 未了伏笔——后三项在 state.md 里仍叫「导演手记 / Flags / 未回收伏笔」，改名只动呈现层）——此前这些信息只躺在 state.md 里，前端零解析、server 无对外接口。

- **数据源与端点**：`GET /api/state?worldId=<id>` 读当前世界的 `state.md`（与引擎的 SSOT 同一份文件，不另建缓存）。路由判定收敛在纯函数 `stateViewFor(worldId, root)`（导出、root 可注入单测）：`worldId` 缺失或不过白名单 400、世界没有 `state.md` 404；`/` 首页 banner 也列了它。
- **容错解析原则**（`parseStateFile(text)`，导出纯函数）：state.md 由引擎（LLM）维护，**小节可能缺、顺序可能乱、值可能越界**——解析绝不抛错，缺的静默缺省（字符串字段空串、数值 null）。逐条规则：`# 剧情状态` 的固定键 → `status`（preset/周目→playthrough/时间→time/场景→scene，缺 null）；`# 主角`/`# 导演手记` 的键值行原样收进 Record（引擎可自由加字段）；`# 角色卡` 的 `## <角色名>` 子节 → `characters`（身份→role、性格关键词→traits、口癖→catchphrase、好感度→favor、art_file→artFile、表情→expression、秘密→secret、最近互动→recentInteraction；好感度取行内整数**夹进 [0,100]**，非整数（如「很高」）为 null）；`# Flags` → 键值列表；`# 未回收伏笔` → 文本列表（行尾「埋于第 N 轮」拆出 `turn`，缺 null）。未知小节（场景美术等）与角色卡的未知键（`art_prompt`）忽略、不进响应。冒号全半角都认。
- **客户端**（`lib/acp.ts` `fetchState`/`StateView` + `store/slices/characters.ts` + `components/game/CharactersDrawer.tsx`）：TopBar 命令轨「角色」入口（`data-testid="characters"`，面板容器 `characters-panel`）开右滑入抽屉，分块渲染剧情状态/主角/角色卡/幕后手记/线索·未了伏笔（后三块的标题是玩家侧说法，state.md 的 `# 导演手记` / `# Flags` / `# 未回收伏笔` 原样解析）。好感度用 ink 阶梯 + accent（数字与细进度条），不引入新颜色 token。
- **剧透折叠**：角色的「秘密」默认收起（按钮 `aria-expanded`，点击展开）；引擎写「无」或空串时不留折叠位。剧情图/面板都不替玩家预判剧透边界——折叠而非隐藏。
- **刷新时机**：面板打开拉一次；`turn_end` 后面板开着自动重拉（好感度/导演手记/伏笔随回合变）；关着不拉。换世界/换本/新开局（`resetRunState`）收起面板并清空视图；请求失败（含 404 还没写过 state.md）保持 null → 面板显示占位说明文案。

## 引擎凭据与自备 key（v1.10，ADR-0019）

默认形态没变：引擎用本机 grok CLI 的登录态（终端里 `grok login`）。v1.10 起玩家可以在设置屏改用**自备 key**——对话与出图各一组，填完立刻生效（引擎会话重启后拿到新配置）。凭据落在 `~/.bunkiten/credentials.json`（目录 0700 / 文件 0600），**不进仓库、不进世界线、不进任何导出包**。

### 为什么是「服务目录 + 环境变量」，不是 .env、也不是逐家适配

- **事实标准优先**：目标服务都说 OpenAI 兼容协议（`/chat/completions`、`/images/generations`），差别只在 base_url 与模型名——把差异收进一张数据表（`shared/providers.mjs`），协议层就不必为每家写代码；长尾（自建、私有部署、聚合网关）用 one-api / LiteLLM 这类网关当逃生口。目录里目前 27 条（对话侧 27、出图侧 12），覆盖 OpenAI / Azure / Gemini / Mistral / OpenRouter / DeepSeek / Kimi（国内 + 全球）/ 智谱 / 百炼（北京 + 新加坡）/ SiliconFlow / 火山方舟 / Groq / Together / Fireworks / xAI / 本机（Ollama、LM Studio）/ 自建与网关，以及国内的千帆、混元、星火、MiniMax（国内 + 全球）。**地址一律按各家当前官方文档核对后写入**（不凭记忆），条目里的 `note` 承担那些文档才知道的坑：站点/地域必须与密钥配套（选错是 401 的常见原因）、模型格该填哪种形态的 id、某些通道只有 v2 才兼容 OpenAI。
- **对话通道不自己实现**：`grok agent` 自带 BYOK 通道（`GROK_MODELS_BASE_URL` + `XAI_API_KEY` + `GROK_DEFAULT_MODEL`），我们只负责把凭据变成子进程 env；媒体生成没有这条通道，才需要自建 MCP 工具。也正因为走的是 CLI 的 env 通道，**Anthropic 原生协议（`/v1/messages`）不在目录里**：CLI 的 `api_backend` 只能写在 `~/.grok/config.toml` 的 `[model.*]` 里，env 通道给不了（要用 Anthropic 就走它的兼容网关，或等后续版本引入我们自己的 grok 配置文件）。
- **不做 .env / 手改配置文件**：玩家不该为了填一个 key 去编辑文件或设环境变量；GUI 即时保存 + 「立刻重启引擎」比环境文件准确，也不会污染 shell（取舍与备选见 ADR-0019）。

### 落点、形状与读写纪律

| 项 | 值 |
|---|---|
| 路径 | `~/.bunkiten/credentials.json`（**刻意不放 GAME_ROOT**：开发态它等于仓库根，`state/` 的 gitignore 规则不覆盖新文件，放那里迟早被 git 收走） |
| 权限 | 目录 0700、文件 0600；临时文件 + rename 原子写（进程被杀也不会留半截 JSON） |
| 形状 | `{ version: 1, llm: { mode:"session"\|"byok", provider, baseUrl, apiKey, model }, image: { mode:"off"\|"byok", provider, baseUrl, apiKey, model, size, sizeBackground } }`（尺寸两格：`size` 是**通用覆盖**（历史语义，对所有类型生效），`sizeBackground` 只对背景生效、优先于 `size`） |
| 读路径 | 坏 JSON / 缺键 / 多余键 / 类型不对 / 超长一律**逐键**回默认，永不抛（凭据坏了不该让 server 起不来） |
| 写出面 | 只有脱敏视图（`publicView` → `hasKey` + `apiKeyMasked`，如 `sk-…4f2a`）；明文只活在磁盘与「玩家正在输入」的那一帧 |
| 不进 | 日志、逐轮快照、回合日志、世界线/剧本导出包、SSE 事件 |

### LLM 侧：凭据 → 引擎子进程 env（我们的值优先）

`credentialsToEnv(creds)` 只生成非空项（`llm.mode !== "byok"` 时是空对象，一个键都不产生）：

| 凭据字段 | 注入的变量 | 说明 |
|---|---|---|
| `llm.baseUrl` | `GROK_MODELS_BASE_URL` | grok CLI 的「Custom Models Endpoint」通道：它据此拉 `{base}/models` 并把推理打到该地址 |
| `llm.apiKey` | `XAI_API_KEY` | 以 `Authorization: Bearer` 发出；**有它就不需要 `grok login`** |
| `llm.model` | `GROK_DEFAULT_MODEL` | 新会话的默认模型；留空时 CLI 用自带默认名（对第三方服务多半不存在，所以 GUI 提示填） |
| `llm.model`（同一格） | `GROK_CONFIG` | 内联 JSON 覆盖，只设 `{"models":{"session_summary":"<模型>"}}`：CLI 起会话时会用**它自己的**默认模型名去打一次 `{base}/responses` 生成会话标题，对第三方端点必然 404（只留一条 stderr 杂音）——把 session_summary 指到玩家配的模型，那条请求就变成一次正常的 chat 调用（实测：`/responses` 消失、`chat/completions` 多一条标题请求）。只覆盖这一个键，玩家配置文件里其它 `[models]` 设置不动（覆盖层在 requirements 之下，企业 pin 仍然赢） |

合并顺序是 `{...process.env, ...credentialsToEnv(creds)}`（`server/acp.mjs` 的 spawn）：**我们的值优先**——GUI 里填的就是想让引擎用的；沿用登录态时一个键都不产生，不会盖掉玩家 shell 里已有的变量。env 只在 spawn 时读一次，所以「保存 → 立刻重启引擎」（`POST /api/engine/restart`）是唯一生效路径。

### 图片侧：一个 MCP 出图工具，覆盖三条出图路径

grok CLI 的图像通道没有 BYOK 字段（只有 `features.image_gen` 开关与模型覆盖），第三方出图必须我们自己接：`server/media-mcp.mjs` 是零依赖的 stdio MCP server，暴露一个工具。

| 工具（catalog 键） | 入参 | 行为 |
|---|---|---|
| `bunkiten-media__generate_image` | `prompt` / `kind`（立绘\|背景\|封面）/ `name` / `variant?` / `outRelPath` | 自己读凭据 → `POST {baseUrl}/images/generations`（`response_format: b64_json`）→ 自己落盘 `presets/<剧本 id>/assets/<类型>-<名字>[-<变体>].jpg`（封面 `presets/<id>/cover.jpg`）→ 回 `{ ok, relPath }`；失败回 `{ ok:false, error }`，**不抛栈** |

- **挂载**：`session/new` 与 `session/load` 的 `mcpServers` 都传（`{name:"bunkiten-media", command: process.execPath, args:[media-mcp.mjs], env:[{name:"ELECTRON_RUN_AS_NODE", value:"1"}]}`），**只有 `image.mode === "byok"` 才挂**——没配的人不该多一个常驻子进程。
- **引擎怎么用它**：grok 的 MCP 工具不进模型直接工具表，而是经 `search_tool` 发现、`use_tool` 调用（catalog 键 `server__tool`）。SKILL.md 的【美术】首条「出图工具优先（硬规则）」把这条路写给了引擎：先 `search_tool` 找 `bunkiten-media__generate_image`，找到就用 `use_tool` 调，拿到 `ok` 就直接出【图】标记（**不再调内置 `image_gen`**）；工具不在或失败 → 回退内置 `image_gen`；两者都不行 → 静默跳过（正文与选项绝不提图片）。
- **幂等**：工具直接落盘到目标路径，引擎随后的【图】标记带的就是同一个相对路径——缓存检查（SKILL 的「生成前缓存检查」）天然命中，不会二次出图；重绘路径照旧覆盖同名文件。
- **路径纪律**：落盘路径由 `assets.mjs`/`presets.mjs` 的纯函数重建（只从 `outRelPath` 里解析剧本 id，`presetIdFromPath`），并做 `path.resolve` 前缀校验——不接受任意路径。
- **兼容梯子**：默认请求带 `size` 与 `response_format: "b64_json"`；服务端 400 且明确抱怨其中一个时**去掉它重试一次**（gpt-image-1 不接受 `response_format`、xAI 的 imagine 口径不认 `size`）——这就是「不逐个 provider 写适配」的落点。响应里的 `b64_json` 与 `url` 都认（`url` 会下载，超时 45s）。
- **落盘字节与扩展名**：文件名固定 `.jpg`（资产路径契约的一部分：`/img` 直服按 `image/jpeg` 发、state 与【图】标记里写的就是这个路径），而服务商返回的字节可能是 PNG/WebP（gpt-image-1 默认就出 PNG）。浏览器对 `<img>` 按内容嗅探、不看声明的 MIME，所以照常渲染；**不做转码**（要引图像库，违背 server 树零依赖）。要严格对齐格式的话，把「出图模型」换成服务商那边的 JPEG 输出档即可。
- **出图尺寸**：按类型的默认是立绘/封面竖构图（`1024x1536`）、背景横构图（`1536x1024`）；玩家可在设置屏填两格——`size` 是通用覆盖（对所有类型生效），`sizeBackground` 只对背景生效且优先于 `size`。尺寸随请求体里的 `size` 送（OpenAI 口径）；服务端不认 `size` 时按兼容梯子去掉它（服务商自己决定构图）。
- **超时与失败**：一次生成 90s 上限；失败/超时/未配置都回可读的错误串给引擎（`{ok:false, error}`），引擎据此静默回退——玩家感知到的只是「这张图没出现」。
- **不写日志**：MCP 子进程不打印 key；错误信息经 `sanitizeErrorMessage` 抹掉明文再回。
- **工具名两种形态都认（v1.10）**：`tools/call` 的 `params.name` 既接受裸名 `generate_image`（MCP 客户端直发），也接受 catalog 全名 `bunkiten-media__generate_image`（真引擎经 `search_tool`/`use_tool` 调的就是这个键，常量 `MEDIA_TOOL_CATALOG_NAME` 由两个名字拼出）——此前只认裸名，真引擎那一跳会被回成「未知工具」，出图静默变成没图。

### 服务目录在线更新（v1.10，ADR-0020）

服务目录（`shared/providers.mjs` 的 `PROVIDERS`）原先只是**打进包里的死数据**：新服务、或某家改了 `base_url`/模型示例，只有等下一个游戏版本才到得了玩家机器。v1.10 起它变成可**随版本单独更新**的发布物，链路是「仓库 JSON 发布源 → 服务端启动抓取 → 本地缓存 → 内置兜底」：

| 层 | 落点 | 说明 |
|---|---|---|
| 唯一真源 | `shared/providers.mjs` 的 `PROVIDERS` | 也是**内置兜底**那份；加服务仍是改数据不是改代码 |
| 发布源 | `docs/providers.json`（`{version:1, updatedAt, providers}`） | 由 `npm run providers:export`（`scripts/export-providers.mjs`）从真源生成，**只搬不改**；契约 lint ⑦ 组断言它与 `PROVIDERS` 深等——手改 JSON 会红，不存在第二份目录 |
| 抓取 | `server/providers-catalog.mjs` 的 `refreshCatalog()` | `startServer()` 里 `void refreshCatalog()` **非阻塞**跑一次；主源 jsDelivr（`…@main/docs/providers.json`）、备源 GitHub raw（`CATALOG_URLS` 按序试），单次 10s 墙钟上限（`CATALOG_TIMEOUT_MS`），**失败静默**（不抛、不响、不落盘） |
| 缓存 | `~/.bunkiten/providers.json` | 与凭据**同目录**（`CREDENTIALS_DIRNAME` 只有一份），目录 0700 / 文件 0600、临时文件 + rename 原子写；`CATALOG_TTL_MS = 24h` 节流（本地副本还新鲜就不打扰发布源）；坏 JSON / 版本不认 / 校验不过一律**当无缓存**（读路径永不抛） |
| 下发 | `GET /api/providers` | `{ providers, source: "bundled"\|"cache"\|"remote", fetchedAt }`，`loadCatalog()` 按 memo → 缓存 → 内置三级回落；**只读**——只回答「有哪些服务可选」 |

- **开关**（与 electron-updater 的既有做法同款）：`BUNKITEN_PROVIDERS_URL=<url>` 覆盖发布源（只打这一个，测试/镜像用）；`BUNKITEN_DISABLE_UPDATE=1` **跳过抓取**——注意语义是「不抓」，**不禁止读本地缓存**（缓存照吃；打包冒烟用它保证不联网，集成栈也默认钉它，免得网络抖动拖红既有用例）。
- **校验取捨**（`validateCatalogDocument` 纯函数，单测直测）：**整包**形状坏（非对象 / `version` 不认 / `providers` 不是数组 / 剔完一条不剩）→ 拒整包、回落缓存/内置；**单条**坏（id 非法或重复、`kind` 不认识、`label` 空、地址非法、超长、地址留空又没 `note`）→ **只丢那一条**。远端是不可信输入，而目录是下拉候选全集——宁可少一个选项，也不给玩家一个打不通的地址。
- **安全约束（本通道的边界，实现里逐条钉住）**：① **远端只喂下拉候选**——绝不据此改写玩家已存的 `baseUrl`/`apiKey`/模型（那是 GUI 里手填的一等公民，走 `/api/credentials`）；② **https-only**——发布源里的地址只收 `https`，例外只有 `http://localhost:*` 与 `http://127.0.0.1:*`（内置表里 ollama / LM Studio 本就是本机明文 HTTP）；③ **整包校验失败即弃**（不动缓存、不更 memo）；④ **只搬白名单字段**（`normalizeEntry` 重建对象，远端多出的键一律丢掉——那些键进了 GUI 视图就是注入面）。
- **服务端凭据校验随之放宽**：provider 白名单 = **内置 ∪ 当前目录**（入口闭包 `allowedProviderIds()`，注入给 `credentials.mjs` 的 `validateCredentialsPatch`）——目录能被远端注入新 id，下拉里选得到的就必须存得下（否则「能选不能存」）；反过来，目录暂时不可用（抓不到 → `source:"bundled"`）时，玩家**已存的远端 id 也不会被静默改写**。**读路径只按形状**保留（`PROVIDER_ID_RE` 的真源已收进 `shared/providers.mjs`，`credentials.mjs` 不再自带第二份 id 形态）。
- **GUI**（`src/components/EngineKeysSection.tsx`）：下拉**优先在线目录**（`/api/providers`，按 `kind` 过滤），读不到就回落内置真源 `providersFor(kind)`——回落是正常路径，连日志都不该有；`source !== "bundled"` 时在节内标一行「在线目录」（`data-testid="engine-catalog-online"`），让玩家知道候选比随包那份新。

### 端点与客户端

| 端点 | 语义 |
|---|---|
| `GET /api/credentials` | 脱敏视图（`{ok, version, llm, image}`，每组合 `mode/provider/baseUrl/model/size?/hasKey/apiKeyMasked`）；**永不回明文** |
| `POST /api/credentials` | 局部更新 `{ llm?, image?, clear?: ["llm"\|"image"] }`：空串=清该字段、`clear` 整组回默认；逐字段校验（未知字段/非法 mode/非 http(s) 地址 → 400）；成功回脱敏视图 |
| `POST /api/credentials/test` | 真连一次：对话侧先 `GET {baseUrl}/models`（通即通过，不消耗生成额度），404/405/501 时退化为一次最小 completion（`max_tokens` 被拒时换 `max_completion_tokens` 再试一次）；图片侧做一次最小生成（复用 `requestImage`，测试与真出图一条实现）——**这一步真花钱**（一张小图），所以 GUI 在图片组明写了这句。回 `{ ok, status, ms, error?, detail? }`，端点自身恒 200（「没通过」是业务结果）；错误串已脱敏截断 |
| `POST /api/engine/restart` | 优雅重启引擎会话（旧进程退出 → 按当前凭据重建 → 重新握手）；回合进行中拒绝（409，避免截断这一回合的落盘） |

`GET /api/auth` 扩展为 `{ loggedIn, hasCredentials }`（保留 `loggedIn` 字段名）：`hasCredentials` = LLM 侧配全了自备 key（`mode:"byok"` 且地址与密钥都非空），boot 屏据此放行——有登录态或配好 key 任一即可开玩。

客户端：设置屏的「引擎与密钥」节（`src/components/EngineKeysSection.tsx`）两组表单 + 「测试连接」+ 「立刻重启引擎」；key 格 `type="password"` + 「显示」切换 + 失焦即提交并回掩码（输入框清空、占位显示服务端掩码——屏上任何一帧都没有「服务端把明文发回来」这回事）。服务目录的下拉候选**优先吃在线目录**（`GET /api/providers`，v1.10），拉不到才回落 `shared/providers.mjs` 的真源（`providersFor(kind)`；契约 lint ⑦ 组钉住 GUI 不许自带第二份 id 表）——`source !== "bundled"` 时节内标一行「在线目录」（`engine-catalog-online`），拉不到不报错也不打日志（正常回落）。

### 第 0 步实证（2026-09，grok CLI 1.0.34，`grok agent --always-approve stdio`）

三条前提都是实测过的（起真 CLI + 本地 mock 端点 / 迷你 MCP server）：

| 假设 | 结论 | 怎么验的 |
|---|---|---|
| `GROK_MODELS_BASE_URL` + `XAI_API_KEY` + `GROK_DEFAULT_MODEL` 在 agent mode 下生效 | **成立** | 临时 HOME（无 `auth.json`）+ 指向本地 mock：CLI 先 `GET {base}/models`（`Authorization: Bearer`），随后 `POST {base}/chat/completions`（`model` = `GROK_DEFAULT_MODEL`），`session/new` 回 `currentModelId` = 该模型；全程无需登录。副作用：另有一次会话标题请求打到 `{base}/responses`（用的是 CLI 自带默认模型名，第三方端点多半 404，**失败无害**——只留一条 stderr） |
| `session/new` / `session/load` 的 `mcpServers` 被认，子进程语义明确 | **成立** | 传 ACP 形态 `{name, command, args, env:[{name,value}]}`：两条路径都真的拉起了子进程（`initialize` → `notifications/initialized` → `tools/list`），子进程 **cwd = 会话 cwd**、**env = 父进程 env ∪ 我们给的变量**。工具**不直接进模型工具表**：模型看到的是 `search_tool`/`use_tool` 两个元工具，`use_tool` 用 catalog 键 `server__tool` 调（实证里 `bunkiten-media__generate_image` 走通） |
| 有 `XAI_API_KEY`、无 `grok login` 时内置 `image_gen` 可用 | **成立，但走的是另一条 base** | 让 mock 模型发起一次 `image_gen` 工具调用：CLI 打的是 `POST {GROK_XAI_API_BASE_URL}/images/generations`（模型 `grok-imagine-image-quality`，带 `aspect_ratio`/`resolution`/`response_format`），图落进会话目录 `images/1.jpg`。**它认的是 `endpoints.xai_api_base_url`，与 BYOK 的 `GROK_MODELS_BASE_URL` 是两条独立通道**——所以第三方出图不能靠它（地址形态与参数口径都不通用），必须自建 MCP 工具 |

三条都成立，因此设计按原方案落地；第三条的「另一条 base」正是图片侧必须有自己通道的直接证据。

**后续补充实证（同一天，针对三处残留问题）**：

| 问题 | 尝试 | 结论 |
|---|---|---|
| 会话标题那条 `{base}/responses` 请求（用 CLI 自带默认模型名打自备端点，必然 404） | ① `GROK_TITLE_REFRESH=0`；② `GROK_TITLE_REFRESH=false`；③ `GROK_CONFIG='{"features":{"title_refresh":false}}'`；④ `GROK_CONFIG='{"models":{"session_summary":"<自备模型>"}}'` | ①②③ **无效**（请求照发）；④ **有效**——`/responses` 消失，标题请求改走 `chat/completions` 并用我们配的模型（mock 实测：3 条 chat/completions，其中 1 条 body 里是 session title 提示词，全部 `model=mock-model-1`）。取 ④ 落进 `credentialsToEnv` |
| Anthropic 原生协议（`/v1/messages`）能否经我们这条通道支持 | `GROK_CONFIG='{"models":{"default":"bk-anthropic"},"model":{"bk-anthropic":{"model":"claude-x","base_url":"…","api_backend":"messages","api_key":"…"}}}'` | **不成立**：`model.*` 被覆盖层的白名单丢弃（请求仍是 `chat/completions` + env 给的模型、只有 Bearer，没有 `/v1/messages`）。CLI 的 `api_backend` 只能来自 `~/.grok/config.toml` 的 `[model.*]`——那条路是 ADR-0019 明确拒绝的（合写玩家全局配置）。要用 Anthropic 就走它的兼容网关（「自定义」/ one-api / LiteLLM） |
| 打包态 MCP 子进程能不能起来 | 用 `dist:mac:dir` 产物跑 `ELECTRON_RUN_AS_NODE=1 …/app.asar.unpacked/server/media-mcp.mjs` | **坏了**：`ERR_MODULE_NOT_FOUND: Cannot find module '…/app.asar.unpacked/shared/protocol.mjs'`——`asarUnpack` 当时只解了 `media-mcp.mjs` 一个文件，它相对 import 的兄弟（`config.mjs`/`assets.mjs`/`presets.mjs`→`acp-server.mjs`/`credentials.mjs` 与 `shared/*`）都不在 unpacked 树里。修法：`asarUnpack: [server/**, shared/**]` 两整棵树 + 打包态冒烟里真的把 MCP 拉起来跑一遍握手（假引擎加 `FAKE_ENGINE_SPAWN_MCP=1`） |

### 打包（asar）

MCP server 是被引擎拉起的**子进程**，子进程读不了 asar：`electron-builder.yml` 把 **`server/**` 与 `shared/**` 两整棵树**放进 `asarUnpack`（不是只解 `media-mcp.mjs` 一个文件——它相对 import 的兄弟都得在同一棵 unpacked 树里，否则子进程第一步就 `ERR_MODULE_NOT_FOUND`，见上一节的实证表），运行时 `mediaMcpPath()` 把路径里的 `app.asar` 段换成 `app.asar.unpacked`；命令用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（打包态与开发态的 `execPath` 都是 Electron 可执行文件，不带这个变量会起出第二个 Electron 应用——打包态实测：这条命令确实能当 node 跑起来，MCP 握手 `ok` 且工具可见，见 `tests/e2e-packaged/`）。

## HTTP / SSE API 一览

| 端点 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 文本 banner（API 导览） |
| `/api/presets` | GET | 扫描 `presets/*/preset.md` → `{ presets: [{ id, title, tagline, genre, rating, characters, protagonist_card, theme }], errors }`（每次请求实时扫描；theme 逐键兜底，见「主题系统」） |
| `/api/presets` | POST | 剧本导入（v1.7）`{ action:"import", bundle }`：校验与落盘纪律见「剧本导出包」→ `{ ok:true, id }`（id = 实际落地的剧本 id，可能已重名改 `-2`）；任何校验失败 400 `{ ok:false, error }`。**body 上限例外 50MB**（其余 POST 仍是 5MB） |
| `/api/presets/export?id=<id>` | GET | 导出剧本包（v1.7）：`Content-Disposition: attachment; filename="<id>.preset.json"`，体为 `{ format:"bunkiten-preset", version:1, id, title, exportedAt, presetMd, assets, audio }`（二进制 base64）；id 非法 400、剧本不存在 404 |
| `/api/presets/check?id=<id>` | GET | 剧本体检（v1.8，见「剧本体检屏」）：把 `npm run doctor` 的判定直出给界面 → `{ ok, id, title, items: [{ level:"ok"\|"warn"\|"error", group, label }] }`。`items` 顺序与 doctor 的报告一致（同组的行连着）；`label` 是 doctor 的行原文（中文逐字不改）；`ok` 为 false ⟺ 至少一条 error。id 缺失/非法 400、剧本目录不存在 404、doctor 模块不可用 503（`scripts/` 不进打包 layout，见「已知限制」） |
| `/api/auth` | GET | `{ loggedIn, hasCredentials }`（v1.10）：`loggedIn` = `~/.grok/auth.json` 存在性；`hasCredentials` = LLM 侧配全了自备 key（boot 屏据此放行，两者任一即可开玩）。**响应里不含任何 key** |
| `/api/providers` | GET | 服务目录候选（v1.10，ADR-0020）→ `{ providers, source:"bundled"\|"cache"\|"remote", fetchedAt }`：`source` 说的是**这一份目录是从哪来的**（本进程刚抓到远端 / 读的本地缓存 / 回落内置表），设置屏两个下拉吃它。**只读**——远端目录只喂下拉候选，绝不据此改写玩家已存的 `baseUrl`/`apiKey`/模型；服务端启动时非阻塞抓一次发布源（`docs/providers.json`），24h TTL、失败静默（见「服务目录在线更新」） |
| `/api/credentials` | GET | 引擎凭据的脱敏视图（v1.10，见「引擎凭据与自备 key」）→ `{ ok, version, llm, image }`，每组 `{ mode, provider, baseUrl, model, size?, hasKey, apiKeyMasked }`；**永不回明文** |
| `/api/credentials` | POST | 局部更新凭据：`{ llm?, image?, clear?: ["llm"\|"image"] }`（空串=清该字段、`clear` 整组回默认）；逐字段校验，非法 400 `{ ok:false, error }`；成功 200 + 脱敏视图。body 上限走缺省 5MB |
| `/api/credentials/test` | POST | 真连一次 `{ target: "llm"\|"image" }` → `{ ok, status, ms, error?, detail? }`（端点自身恒 200，「没通过」是业务结果；`error` 已脱敏截断）。target 非法 400 |
| `/api/engine/restart` | POST | 优雅重启引擎会话（保存 key 后一键生效）：回合进行中 409 `{ ok:false, error }`，成功 200 `{ ok:true }` |
| `/api/assets?preset=<id>` | GET | **该剧本**的资产清单（画廊与制作中屏清点共用）：`preset` 必填且须匹配 `[A-Za-z0-9_-]+`，缺失或非法 → 400 `{ error }`（v1.5.1 起不再有全局池）；磁盘扫描 `presets/<id>/assets/` 与 `presets/<id>/cover.jpg`，registry 补充未落盘项；每条形如 `{ type, name, variant, file, ready, inUse, mtime }`——`variant` 从文件名拆差分、`inUse` **只扫该剧本的世界**（`index.json` 按 preset 过滤后，任一 `state.md` 文本含名字即「在用」）、`mtime` 供画廊破缓存 |
| `/api/assets` | POST | 素材删除 `{ action:"delete", preset, file }`：只删 `presets/<id>/assets/` 下的**单层** `jpe?g`（`ASSET_DELETE_FILE_RE`；`cover.jpg`、子目录、非图片一律不受理）→ `{ ok:true, trashed:true }`（v1.7：文件挪进 `state/trash/<ts>-<rand4>-<原名>`，EXDEV 等 rename 失败回退直删则 `trashed:false`）；未知动作/参数不合法 400、文件不存在 404、其余删除失败 500 |
| `/api/audio?preset=<id>` | GET | 音频清单 → `{ items: [{ kind, name, file, url }] }`（按文件名排序）；`preset` 必填且须过 `PRESET_ID_RE`，缺失或非法 400；**剧本没有 `audio/` 目录 = 空数组**（不是 404）。`url` 是服务端拼好的 `/audio?p=…`，文件名做了百分号编码（名字里可能有 `&`、空格） |
| `/audio?p=<相对路径>` | GET | 音频直服（`<audio src>` 取它）：白名单 `AUDIO_REL_RE` + `path.resolve` 前缀校验两道闸，命中即整文件 200（按扩展名给 `AUDIO_MIME`，`cache-control: public, max-age=86400`）；**不做 Range**（音频文件小，客户端拉全量），未命中/穿越一律 404 |
| `/api/history?worldId=<id>[&seq=<n>]` | GET | 逐轮快照索引：`worldId` 不合法 400；不带 `seq` 回 `{ worldId, snapshots: [{ seq, at, kind, nodeId, chapterNo }] }`（**只回元信息、不带 `files`**）；带 `seq` 只读那一个文件、只回那一条（含 `files`；不存在则 `snapshots: []`） |
| `/api/worlds` | GET | 世界线列表（可选 `?preset=<id>` 过滤）→ `{ worlds: [{ worldId, preset, title, label, note, chapterNo, lastPlayed, forkedFrom, exists }] }`；`label` 老索引补空串，`chapterNo` 读 story-tree.md、`lastPlayed` 取三文件最新 mtime（磁盘自愈），按最近游玩倒序 |
| `/api/worlds` | POST | 世界线管理 `{ action }`：`create`（分配 id、写索引）/ `fork`（`{worldId,nodeId,seq?}` 复制三文件+回退+写 fork.md，不推演；带 `seq` 或该节点有快照时走精确快照）/ `restore`（`{worldId,seq}` 先写一条 backup 再覆盖三文件，回 `{ ok:true, backupSeq }`）/ `update`（`{worldId,label?,note?}` 显示名与备注，≤60/≤200，空串=清除）/ `import`（`{bundle}` 导入世界线包）/ `delete`（移索引 + 目录整体挪进 `state/trash/`，回 `{ ok:true, trashed:true }`，rename 失败回退直删标 `fallback:"purged"`）；未知动作或参数不合法 400 `{ ok:false, error }`，成功 200 `{ ok:true, … }` |
| `/api/worlds/export?worldId=<id>` | GET | 导出世界线包（**v2**，v1.8 起）：`Content-Disposition: attachment; filename="<worldId>.world.json"`，体为 `{ format:"bunkiten-world", version:2, exportedAt, world:{ …, forkedFrom, files, snapshots, forkMd } }`（血缘随包走，导入回来仍是父线的子节点；v1 的两个血缘键是 `null`）；worldId 非法或不存在 400 `{ ok:false, error }` |
| `/api/tree` | GET | 剧情树原文 `?worldId=`（缺省 `main`）→ `{ worldId, markdown }`；无树 404（剧情图屏 `parseStoryTree` 解析用） |
| `/api/state?worldId=<id>` | GET | 角色面板数据（v1.7）：读该世界 `state.md` 容错解析 → `{ worldId, status, protagonist, director, characters, flags, foreshadowing }`；`worldId` 缺失或非法 400、世界没有 `state.md` 404（`stateViewFor` 纯函数，root 可注入单测）。解析原则见「角色面板」 |
| `/img?p=&t=&n=&preset=` | GET | 图片服务（解析顺序见上：当前剧本永久命中 → 会话兜底 → 旧档 `assets/` 兼容 → 白名单直服） |
| `/events` | GET | SSE（`retry: 2000`），回合事件流 |
| `/prompt` | POST | `{ text }` → `{ ok, error }`；空文本 400；上一回合进行中 409 |
| `/app`、`/app/*` | GET | 打包前端静态托管；优先 `resources/app-dist`，兜底 `GAME_ROOT/dist`；SPA fallback 到 `index.html`；带路径穿越防护。`/app`（无尾斜杠）302 到 `/app/`——产物 `index.html` 的资源是相对路径（vite base `./`），少了尾斜杠基准地址会落在站点根、`./assets/…` 全 404（打包态窗口一片空白，v1.9 打包态冒烟抓到的真 bug） |

### 本地端点纪律（v1.6）

这个 server 只服务本机（Electron / vite dev / curl），不对外开放，因此入口处只有两道闸（`isCrossSiteRequest` + `readBodyText`，对所有路由生效、先于路由分发）：

| 闸 | 规则 | 命中结果 |
|---|---|---|
| 来源校验 | `sec-fetch-site: cross-site` 一律拒；带了 `Origin` 就必须匹配 `LOCAL_ORIGIN_RE`（`http(s)://localhost\|127.0.0.1[:端口]`） | 403 `{ error:"跨站请求被拒绝" }` |
| body 上限 | POST body 累计超过 `MAX_BODY_BYTES`（5MB；唯一例外：`POST /api/presets` 导入传 50MB——包里是 base64 图片/音频，见「剧本导出包」） | 413 `{ error:"请求体过大（上限 5MB/50MB）" }`，先刷响应再断连（避免 RST 把 413 丢掉） |

- **无 `Origin` 的请求一律放行**：curl、集成测试、Electron 打包态的同源请求都可能不带 `Origin`——挡掉它们等于把本机工具链一起挡掉。放行的白名单是「没带来源头」，不是「来源头可信」。
- **它防的是跨站浏览器请求，不是身份认证**：非浏览器进程（本机任意脚本）照样能调全部端点，这里不设 token、不做登录（见「已知限制」）。它挡的是浏览器里别的站点发起的 CSRF 与端口探测。
- 前端两侧都在放行范围内：打包态从 `http://127.0.0.1:<port>/app` 同源请求，vite dev 从 `http://localhost:5173` 请求（同机来源）。

## 前端结构（src/）

> **读法提示**：下文凡写 `store/game.ts` 的编排说明（段过滤、标记应用、制作流水线、世界线/剧情图动作…），实现按 slice 分文件（`store/slices/*.ts`），入口仍是同一个 store——`store/game.ts` 只负责组装与再导出，公共 API 与拆分前逐字一致。

屏幕流（zustand `screen` 状态机）：`boot`（登录检查）→ `title`（卡带式剧本轮播：`← →` 切卡、Enter / 点中央卡「插卡」装载，卡底铺各自封面、无封面回退主题渐变；当前卡带「导出」小按钮与右下角「导入剧本」「素材」「创作新剧本」入口——导出/导入见「剧本导出包」）→ `worlds`（世界线屏：列出该剧本已有世界，继续/新世界线/两段确认删除/改名/导出/导入；键盘导航）→ `protagonist`（捏人 chips / 快速开局）→ `crafting`（仅「制作美术并开演」路径：待命开局 → 章节规划 → 逐项美术指令 → `开演。`，见「分项美术指令」「章节与剧情树」）→ `game`。章间循环：game 屏收到【章】标记 → 切回 crafting（「第 N+1 章 · 制作中」）→ 自动规划下一章 → 制作 → 开演，往复直至终局。overlay 屏 `assets`（画廊）、`creation`（创作模式）、`tree`（剧情图）与 `settings`（设置）从 title/game/世界线屏进入，`closeOverlay` 返回进入前的原屏（不动回合与画面状态，画廊重绘与游戏态共用引擎回合）；Esc 关闭链（`App.tsx`，输入框聚焦时不拦截——`type="range"` 的滑杆除外，设置屏滑杆聚焦时 Esc 仍关屏）从里往外为「画廊大图预览 → 剧情图节点详情 → 历史抽屉 → 角色面板 → 创作屏退出确认 → 剧情图屏 / 设置屏 → 世界线屏（回到标题屏）」。

| 文件 | 职责 |
|---|---|
| `App.tsx` | 屏幕切换 + SSE 订阅；根容器按当前剧本注入主题 CSS 变量；背景层常驻（crafting→game 转场不重载）。`<ChapterCard />` 挂在 `AnimatePresence` **之外**的屏根（v1.8）：屏切换会重建整棵子树，过场卡挂在 game 屏内就必然在「画廊/剧情图 → game」返回时同章号再亮一次——跨屏记忆因此留在 `ChapterCard` 自己家。`StatusAnnouncer` 是 `aria-live` 播报点，文案过 `lib/status.ts` 的 `playerStatus`（引擎口吻 → 玩家侧说法的唯一真源，顶栏与制作中屏共用）。Esc 关闭链末端兼作屏级回退：`protagonist → toWorlds()`（捏人屏不是死路，牌面留着）、`worlds → toTitle()` |
| `store/game.ts` + `store/`（v1.6 切片化） | 全局状态机，入口仍是 `game.ts`：它只做四件事——初始 state、`isTypingTarget`、用 `createStoreContext` 建一次共享上下文后 `{...slice(ctx)}` 组装、再导出（类型/立绘纯函数/世界线包校验）。**拆分结构**：`store/context.ts`（跨片共享闭包 `applyMarkers`/`advancePreload`/`finishRegen`/`resetRunState`/`onEngineError`… + 两个定时器单例：610s 看门狗 `WATCHDOG_MS`、自动前进倒计时；为什么必须共享见文件头注释——这些函数彼此递归，塞进任一 slice 都会形成循环依赖）、`store/types.ts`（只放类型，供 slice 与 context `import type`）、`store/portrait.ts`（立绘纯函数 `nextPortraitOnExpression`/`normName`）、`store/slices/{nav,world,tree,assets,creation,crafting,gameplay,characters}.ts`（按功能切块；`handleEvent` 整段不拆——内部时序本身是契约）。**行为**：段过滤、标记应用、表情切换（`expression` → 差分 URL 拼在 `presets/<id>/assets/` 根上）、`presetAdded` 刷新轮播、剧本导入（nav 片 `importPresetText`：`parsePresetBundle` 本地校验 → POST `/api/presets` import → 成功重取轮播并落 `titleNotice` 提示）、选项解析的编排；开局指令构造入口与「制作中」章节制作流水线（init→planning→queue→starting→finished，【章】标记触发章间切章）、清单预过滤按 `selected.id` 调 `fetchAssets(presetId)` 只清点当前剧本；画廊单项/批量重绘（顺序队列 `startRegen`/`startRegenBatch`/`finishRegen`）与批量删除（`deleteAssets`）、创作模式装配状态机；世界线（`beginNewWorld`/`resumeWorld`/`updateWorld`/`importWorldText`/`switchToFork`，v1.8 增 `toWorlds()`：只切屏 + 清看门狗，**不**动 selected/答题/worldId——世界已建在服务端，捏人屏退回世界线屏要留着牌面）、剧情图 overlay（`openTree`/`forkAt`/`treeEdited` 刷新/`restoreSnapshot` 原地回退与回退后分割线·待重同步、`rerollTurn` 重掷本回合（restore 次新 turn 快照 + 重同步 + 重发同一输入，按钮可见性判据 `turnSnapshots` 由 `context.refreshTurnSnapshots` 按需补拉，见「重掷本回合」）、`剧情：` 编辑回合不进历史）；设置（`openSettings`/`updateSettings`——唯一写 localStorage 与 AudioManager 的入口）与自动前进（`armAutoAdvance`/`cancelAutoAdvance`/v1.8 的 `resumeAutoAdvance`——`armAutoAdvance` 是引擎收尾时的自动尝试、必须尊重本回合的 muted，`resumeAutoAdvance` 只由玩家的明确动作触发：清掉 muted 再立刻尝试武装。之所以需要它，是因为 `App` 在 window 捕获阶段把任何 `pointerdown`/`keydown`/`input` 一律当「玩家接管了」而取消倒计时，而对话框面板上点「自动」这一下恰恰是玩家要求自动前进）；角色面板抽屉（`characters` slice：`toggleCharacters` 开合 + `refreshCharacters` 取 `/api/state` 落 `stateView`，turn_end 面板开着重拉、`resetRunState` 清空，见「角色面板」） |
| `lib/audio.ts` | `AudioManager` 单例（挂在 store 之外、不依赖 React）：BGM / 环境音各一对音频元素交叉淡入 ≈600ms（`FADE_MS`，`setTimeout` 步进而非 `rAF`）、音效一次性并发 ≤4（`MAX_SFX`）+ 8s 槽位兜底超时；`setPreset` 换本先 `stopAll` 再拉 `/api/audio` 建「类型\|名 → URL」索引（同一剧本的在途/就绪/已失败三种情况都幂等早退，不重拉也不打断在播的曲），`applySettings` 让音量改动即时生效；索引里查不到就是静默 no-op。细则见「音频管线」 |
| `lib/settings.ts` | 玩家设置纯逻辑（不碰 React/DOM）：`DEFAULT_SETTINGS`、`normalizeSettings`（逐键校验，坏键回默认、存档只坏个别键时不整份丢弃）、`loadSettings`/`saveSettings`——localStorage 键固定 `bunkiten.settings.v1`，缺失/损坏/不可写（隐私模式、配额满）一律静默回默认；另导出打字机档位 `TEXT_SPEED_MS` 与自动前进档位（`AUTO_ADVANCE_OPTIONS`） |
| `components/SettingsScreen.tsx` | 设置 overlay（TopBar 齿轮进入）：音频「主音量 / 静音 / 曲 / 环境 / 音效」+ 文本「文字速度四档 / 自动前进三档」。每个控件直接调 `updateSettings`（无「保存」按钮，改动即时生效：AudioManager 立刻生效 + 写 localStorage），关屏走 `closeOverlay` |
| `lib/parser.ts` | 文本协议纯函数：标记/清单/章标记扫描、`stripOptionsBlock`（对话窗与历史从 `**行动**` 截断）、差分名拆分 `splitAssetVariant`、选项解析、开局/分项美术/重绘/章节规划/创作模式指令构造（契约字符串所在）；v1.5 世界段与续玩/剧情编辑指令构造（`build*Opening` 增 worldId 参数、`buildResumeCommand`、`buildTreeEditCommand`）、`parseStoryTree` 容错解析、`assetNameMatches`（trim/互为包含 + 变体须一致）、`isProtocolLine` 纳入【树】 |
| `lib/acp.ts` | HTTP/SSE 客户端与 `AcpEvent`/`Preset`/`AssetEntry`/`WorldEntry` 类型；`fetchAssets(preset)`/`assetUrl(kind,name,preset)` 支撑制作中屏与画廊清点（v1.5.1：`preset` 由 `presetQuery` 拼成 `&preset=`，空则不拼、服务端回退 `currentPresetId`），`assetFileUrl`/`coverUrl` 走 `/img` 白名单直服（差分、封面、画廊破缓存）；`fetchWorlds`/`postWorld`/`fetchTree` 供世界线屏与剧情图屏。v1.6 增补：`fetchAudio`/`audioFileUrl`（音频索引与 `/audio?p=` 直服 URL）、`fetchHistory`/`fetchSnapshot`（快照索引 / 单条，配 `WorldSnapshotMeta`/`WorldSnapshot`/`SnapshotFiles` 类型）、`worldExportUrl`/`postWorldUpdate`/`postWorldRestore`/`postWorldImport`（世界线改名、原地回退、导出/导入）、`postAssetDelete`（素材批量删除）。v1.7 增补：`fetchState`/`StateView`（角色面板的 state.md 解析视图，见「角色面板」）、`PresetBundle`/`presetExportUrl`/`postPresetImport`（剧本导出下载与导入，见「剧本导出包」） |
| `lib/treeLayout.ts` | 剧情图纯函数布局：最长路径分层 + 抗环 + 确定性坐标（`layoutTree`/`LayoutNode`/`LayoutEdge`/`LayoutOptions`），StoryTreeScreen 的 SVG 数据源，可被 node 单测直引 |
| `lib/genealogy.ts` | 世界线家谱纯函数布局（v1.7）：forkedFrom 森林分层 + 孤儿（父线已删，`missingParent`）/fork 环容错 + 确定性整数坐标（`layoutGenealogy`/`GenealogyLayout`，层内 lastPlayed 降序）与圆角拐弯边路径，`genealogyStep` 给家谱键盘走位的确定性规则，WorldsScreen 家谱视图的 SVG 数据源，可被 node 单测直引 |
| `lib/diff.ts` | 快照对比纯函数（v1.7）：行级 LCS `diffLines(a, b)`（O(n·m) DP，add=b 新增、remove=a 独有，替换块 remove 在前）与 `diffStats` 的 +N −M 摘要，空串/undefined 容错为 0 行，StoryTreeScreen 快照对比面板的数据源，可被 node 单测直引 |
| `theme.ts` | 剧本主题：`getTheme` 逐键校验兜底（默认 aurora + serif + plain）、`themeVars` 注入 `--accent`/`--accent2`/`--font-preset`、`dialogClass` 映射对话框质感类、`FONT_STACKS` 系统字体栈（离线无 webfont） |
| `components/` | 各屏与游戏 HUD：TitleScreen 封面卡带轮播与插卡动画（`CardCover` 404 回退渐变+motif）、CraftingScreen 制作中屏（planning「章节大纲」槽 → 清单美术网格两段进度，planning/queue 均可跳过；差分槽位显示「薇拉 · 微笑」）、AssetsScreen 画廊（按当前剧本取数 `GET /api/assets?preset=`，立绘按角色分组、背景/封面分组，大图预览与单项重绘；角标只标**异常**——`未使用`（在用是多数，标了等于没标），v1.6 增「管理素材」开关：勾选后批量重绘（顺序队列，进度「重绘中 i/N」）与批量删除（两段确认，逐条 `POST /api/assets`）——封面不在删除候选里，引擎忙一律禁用）、CreationScreen 创作模式（打磨对话流 → 装配清单逐项点亮 → 新剧本成功态/重试）、Atmosphere 全局胶片颗粒/暗角、TopBar（左上状态点/状态文字/世界名 chip——**章号已移出顶栏**，现在只在章节过场卡与回想抽屉标题上出现；正常态（`就绪`、不忙、无待重同步）整个状态簇走 `sr-only`，只有异常/忙碌态才画出来（VN 惯例：正常态不画 HUD），状态文案一律过 `playerStatus` 转玩家口吻、`待重同步` 徽章不变；右侧竖排轨按钮 设置/历史/角色/画廊/剧情图/重开/前情/重演（`重演这一幕`，只在就绪、有上一回合输入且不处于待重同步时出现）/换剧本/帮助）、CharactersDrawer 角色面板抽屉（v1.7，右滑入侧栏：剧情状态/主角/角色卡（好感度 accent 数字 + 细进度条、表情徽章、秘密 `aria-expanded` 折叠）/幕后手记/线索/未了伏笔——这是玩家侧的小节名，`state.md` 自己的标题照旧，见「角色面板」）、DialogueBox（打字机，间隔按设置里的文字速度档 `TEXT_SPEED_MS`，点击对话框立即补全全文；v1.8 面板右上角内联 自动/快进 两个控件——「自动」与设置屏的自动前进是同一份设置（开着时走 `resumeAutoAdvance()`：玩家的这一下点击是明确要求，不能被「交互即取消」吞掉），「快进」等价于点击补全、打字打完即置灰；系统开了「减少动态效果」时整段显示，见「动效降级」）、OptionList（选项上屏即起自动前进倒计时并显示「自动前进 · Ns」；1-9 与 Numpad 数字键选选项）/FreeInput 等 |
| `components/WorldsScreen.tsx` | 世界线屏：`GET /api/worlds?preset=` 列表（继续 / 新世界线 / 两段确认删除 / 键盘导航）；`继续` 走 `resumeWorld`，`新世界线` 走 `POST /api/worlds {action:"create"}`，删除走 `{action:"delete"}`。v1.6：行内改名编辑器（`{action:"update"}` 写 `label`/`note`，留空=清除，Enter 保存 / Esc 取消；显示名按 `worldDisplayName` = `label → note → 所属剧本标题 → 「未命名世界线」` 回退（v1.8：旧版 server 自动写进索引的分叉备注按「没有备注」处理——`lib/worlds.ts` 的 `isLegacyForkNote`，免得把裸 worldId 端给玩家；血缘另有 `forkedFrom` 记着））、单条导出（`worldExportUrl` 交给浏览器下载）、打包导入（file input 读 `.world.json` 原文 → store `importWorldText` 校验后 POST）；导入/改名的成功与失败落在屏内提示位（`worldNotice`），列表补 listbox/option 与 roving tabIndex 语义。v1.7：列表/家谱视图切换（分段按钮）——家谱用 `lib/genealogy` 的 `layoutGenealogy` 画 forkedFrom 森林（孤儿 ⌫ 徽章、`genealogyStep` 方向键走位 + Enter 选中），选中节点的快捷条「继续」走行上同一个 `continueWorld`（内部 `resumeWorld`）、「查看」跳回列表聚焦对应行。v1.8：行上动作收成**一个主行动「继续」+ 一个 ⋯ 菜单**（改名/导出/删除，删除的两段确认收在菜单内、菜单一关即作废，Esc 与点外面都关菜单）；家谱画布补齐与剧情图同款的视图能力（滚轮锚点缩放 / 拖拽平移 / 双击复位 / ± 与「适应」/ `+ - 0`，复用 `lib/treeLayout` 的 `fitView`/`zoomViewAt`/`panView`/`viewBoxOf`，不另写一套几何），渲染宽度**只封上界**（`GEN_MAX_NODE_PX = 270`：小森林不再把节点撑到 ~490px，森林更宽时上界够不着、照旧铺满），鼠标/键盘提示留在画布工具条（不落屏脚，1440×900 不滚动即可见），选中详情条 `sticky` 吸底 |
| `components/StoryTreeScreen.tsx` | 剧情图 overlay：`GET /api/tree` 取树原文 → `parseStoryTree` → `layoutTree` 出 SVG 节点图；节点详情、`剧情：` 自然语言编辑（`buildTreeEditCommand`，编辑回合不进历史）、「在此分叉」（`POST /api/worlds {action:"fork"}`）；`treeEdited` 事件、回退完成与手动刷新都让 `treeStamp` 自增触发重取。v1.6：并取快照索引（`GET /api/history`）在节点上标「存档点 · 第 N 幕」（v1.8 起是玩家侧文案：幕号 = 快照序号，与历史抽屉的「已回溯到第 N 幕」同源；`snapshotTurnNo` 仍在算「第几轮」但屏上不再印「轮」、也不印 `快照 #seq`）、详情侧栏给「回退到此节点（原地）」（两段确认 → `restoreSnapshot`），**有快照的节点「在此分叉」自动带该 seq**，无快照的旧世界不渲染这些控件（按现状降级）；图形模式支持缩放（指针锚点）/平移/适应与节点 roving tabIndex + 方向键，当前章节点 > 40 默认降为列表模式（可切回图形）。v1.7：节点详情「与上一个存档点对比」——基线取 seq 更小的最近一条（`prevSnapshotSeq`，kind 不限），拉两条快照全文过 `lib/diff` 渲染三 tab diff 面板（`当前状态 / 前情提要 / 剧情图`，详情区内嵌，equal 默认折叠 ±2 行上下文，见「快照对比」节）。v1.8：章节可达——正文顶部的章节切换器列出解析出的**每一章**（`chapterNoOf`/`chapterLabel`，进度章标「当前」，点谁画谁：重排 + 重适应 + 收掉节点焦点；从前只画进度指针那一章），`## 归档` 章只剩目录信息、点它给一句实话而不是静默；节点详情改为 **≥lg 的右侧栏**（`lg:grid-cols-[minmax(0,1fr)_380px]`，窄屏栈在画布下方） |
| `components/game/PortraitLayer.tsx` | 立绘层：右下竖排名牌；`expression` 事件换差分只做交叉淡入（0.4s），差分图 404 两级回退（差分 → 基础 → 名牌），不重放浮入动画。v1.8：图片改成**真占版面的布局盒**——grid 单格堆叠（两张图 `col-start-1 row-start-1` 同格重叠，差分交叉淡化照旧）、行高显式 `1fr`；此前的 shrink-to-fit 包裹层宽度恒 0，`img` 的 `max-w-full` 就解析成 `max-width:0`，立绘从来没画出来过。e2e 因此断言「立绘 `boundingBox` 非空且渲染宽 > 0（真实解码）」与「对话框与立绘不重叠」两条。配套 `.portrait-reserve`（`styles/global.css`）：≥lg 给对话区的满宽外层预留 `min(40vw,420px)`，可用宽度因此收窄、居中区左移，对话框不再压住立绘（<lg 不预留，优先保证对话区可读宽度） |
| `components/motifs/` | 氛围层：`MotifLayer` 按主题 motif 渲染 summer/rune/imperial/aurora 四款纯 CSS/transform 动画图案 |

元命令：TopBar 按钮 → `/new-game` `/recap` `/presets` `/help`；`/new-game`、`/presets` 回合结束后切回标题屏（`awaitCommand`）。自由输入框里打选项编号与点该选项等价（都走 `/prompt`，编号语义由引擎按【行动】编号理解）。

### 设计系统（v1.8）

这一版把散在各屏的版面/字号/面板写法收成三处契约，改屏时按这三条走，别再各屏自创：

- **壳层页框 `components/ShellPage.tsx`**：title / worlds / protagonist / crafting / settings / assets 这些非游戏舞台屏共用的外框——满幅主题底 + 宽栏 + 统一表头（eyebrow → 标题 + 短 accent 分隔线 → 右侧动作簇）+ 可选 ≥xl 右栏 + 可选页脚提示行。它约束的规则是：**壳层屏不再各屏自写居中窄栏**（旧屏的 `mx-auto max-w-3xl` 那类）。整屏只有 `ShellPage` 这一处定宽（`max-w-[84rem]`），屏内区块一律撑满可用宽度、靠栅格与多列组织信息；右栏只在 ≥xl 成列（`xl:grid-cols-[minmax(0,1fr)_360px]`），窄屏顺序排在正文之后、不做抽屉。
- **字号阶梯（`styles/global.css` 的 `@theme` 单源）**：`text-micro` 12（只给角标/徽章这类不承载细读信息的短标记）/ `text-meta` 13（**需要读的文字的下限**：提示、图例、元信息、说明句）/ `text-ui` 14（标签、按钮、次级正文）/ `text-body` 16（正文）/ `text-read` 17（对话框叙事正文）/ `text-lead` 18（强调正文）/ `text-title` 20（屏标题）/ `text-display` 28（封面与主标题）。**手写 `text-[Npx]` 一律不许**——取档位类，字号改动才只有一处（SVG 里随画布缩放的 `fontSize` 除外）。
- **表面与遮罩 token + 两个 unlayered 类**：`bg-panel` / `bg-panel-strong` / `bg-scrim` / `bg-scrim-soft` 是暴露给 Tailwind 的底色（带透明度修饰符时用 color-mix 就地混）；`.shell-backdrop` 是壳层屏的主题满幅洗色（顶部 accent 光晕 + accent2 极淡冷调 + 底部压深，压住亮底图保证面板与文字的对比度稳定），`.shell-panel` 是面板三件套（底色 + `blur(14px)` + 一道 ink 发丝描边，圆角与内边距仍归组件）。两者**刻意写在级联层外**：优先级高于 Tailwind utilities，屏里随手写的渐变类盖不掉——壳层底是契约不是默认值，要改就改 token。
- **游戏 HUD 的四处随之成形**：TopBar 正常态整个状态簇 `sr-only`、文案过 `playerStatus`（异常/忙碌态才画出来，见 `components/` 行）；章节过场卡 `<ChapterCard />` 挂在 `App` 根（~2.2s，`CHAPTER_CARD_MS`/`CHAPTER_CARD_FADE_MS` 导出给用例当时间真源，屏上无可聚焦元素也不拦点击）；对话框面板的 自动/快进 两个控件（自动走 `resumeAutoAdvance()`，与设置屏同一份设置）；`.portrait-reserve` 给立绘让出的右侧安全带（≥lg）。

## 主题系统

每个剧本可在 frontmatter 声明 `theme` 块（缩进子键），配色、氛围图案、字体族与对话框质感随剧本切换、贯穿标题屏到对话框：

```yaml
theme:
  accent: "#5f8f6e"   # 主色（#hex）
  accent2: "#d9e8dc"  # 辅色（#hex）
  motif: summer       # 氛围图案：summer | rune | imperial | aurora
  font: serif         # 字体族档位：serif | song | kai | hei（v1.7）
  dialog: silk        # 对话框质感：plain | silk | paper | glass（v1.7）
```

- **server 侧**（`server/presets.mjs` 的 `THEME_KEYS`/`normalizeTheme`；白名单与兜底值 `FONT_PRESETS`/`DIALOG_TEXTURES`/`DEFAULT_THEME` 钉在入口 `acp-server.mjs` 源码，契约 lint ⑥ 与 `src/theme.ts` 比对，见 ADR-0013）：`THEME_KEYS` 只认块形式（内联 `theme: x` 视为坏格式）；`normalizeTheme` 逐键兜底——accent/accent2 须 `#hex` 色值、motif 须非空、font/dialog 须属各自白名单（与 `src/theme.ts` 同集），坏值用默认主题（aurora）的对应键替换，不抛错；解析结果随 `/api/presets` 下发。
- **前端**（`src/theme.ts`）：`getTheme` 对下发字段再校验（hex 色值、motif 须属四枚举、font/dialog 须属白名单），非法或缺省一律回退兜底主题（aurora + serif + plain）；`themeVars` 把 accent/accent2 转成 `--accent`/`--accent2` CSS 变量，把 font 档位展开为 `--font-preset`（对应 `FONT_STACKS` 里的系统字体栈）。
- **注入与消费**：`App` 根容器按当前剧本注入变量并以 `fontFamily: "var(--font-preset)"` 应用字体族（全站唯一真源，不再使用 Tailwind 的 `font-serif` 工具类）；`global.css` 的 `@theme inline` 把 tailwind 的 `gold`/`accent`/`accent2` 色类映射到变量，全站元素（选项 ◇ 子弹与悬停描边、打字机光标、卡面渐变、插卡泛光）随之主题化；标题屏每张卡带按各自 theme 在子树覆盖变量（字体族跟随根容器不按卡切换）。
- **字体族策略（v1.7，离线无 webfont）**：`font` 是档位不是字体名——每档在 `FONT_STACKS` 里展开为「mac 字面 → Windows 字面 → Linux Noto CJK 兜底」的系统字体降级链（serif 档带西文衬线兜底 Georgia，hei 档是无衬线黑体），浏览器取第一个本机可用的字面；应用不下载、不内嵌任何字体文件。
- **对话框质感（v1.7）**：`dialog` 档位经 `dialogClass` 映射为 `DialogueBox` 容器的 `dialog-*` 类，规则全在 `global.css`：`plain` 无规则（=现状半透明面板）；`silk` 纵向极淡 accent 缎面高光渐变；`paper` 复用 `.grain` 的 feTurbulence 噪点（URI 提为 `--grain-url` 变量单源）以 opacity .04 只铺对话框；`glass` 顶部内侧 accent2 高光反射（毛玻璃的 blur 由容器基线类 `backdrop-blur-xl` 提供，全档共享）。三档都只做加法装饰，不动面板底色与文字色——上方「文字对比度阶梯」不许回退。
- **motif 氛围层**：`components/motifs/` 的四款图案（summer/rune/imperial/aurora）是低透明度纯 CSS/transform/opacity 动画，不干扰阅读；常驻 App 背景与标题屏卡面（`dense` 提高密度）。
- **全局美术**（`components/Atmosphere.tsx`，与主题正交）：胶片颗粒（内联 SVG feTurbulence 噪点 + transform 抖动）与暗角 radial-gradient，常驻 App 顶层、pointer-events-none。

## 动效降级（prefers-reduced-motion，v1.7）

客户端动效分三类，各走各的降级路径；全部**跟随系统「减少动态效果」偏好**，不新增游戏内开关——OS 级偏好是用户已经做出的选择，设置屏不重复发明一个（理由同 Web 惯例：一次设置处处生效，也不会出现「游戏开关与系统开关打架」的中间态）。

- **framer-motion**（屏转场 `ScreenShell`、各屏入场/浮入、motif 氛围层四款、Atmosphere 颗粒跳位）：`App.tsx` 根节点包一层 `<MotionConfig reducedMotion="user">`，一处全局生效——**位移/布局动画（transform、layout）降为瞬时**（元素照常挂载与切换，不是删动画元素），标题屏卡带轮播的拖拽手势不受影响（`reducedMotion` 只停自动动画，不停交互）。注意 framer-motion 13 的 `reducedMotion` 不覆盖 opacity：屏转场与差分切换的**交叉淡入照常播放**（0.45s/0.9s），motif 的 opacity 呼吸同理——淡入是 WCAG 推荐的降级替代，要消除的是位移感而非一切变化。
- **CSS keyframes**（`animate-pulse`：打字光标、TopBar 忙点与各屏加载点；`animate-spin`：画廊加载圈）：`global.css` 末尾的 `@media (prefers-reduced-motion: reduce)` 把这两个类 `animation: none`——元素静止但仍渲染（光标停在原地，可见性不丢）。`.grain` 噪点是静态纹理、本来就不动，无需处理。
- **打字机**（`DialogueBox` 的 setTimeout 逐字链，不走 framer 也不走 CSS）：组件内 `usePrefersReducedMotion()` 用 `window.matchMedia("(prefers-reduced-motion: reduce)")` 检测（挂载读一次 + 跟随 change 事件；jsdom 等无 matchMedia 实现的环境防御性视为未开启，探测绝不抛错）。开启时打字间隔按 0 处理——复用「瞬间」档的呈现路径（`interval <= 0` 直接整段），**但不改用户的文字速度设置档位**；`typingDone` 随之即刻为真，「空格补全」提示与光标自然不出现。

测试：`tests/ui.test.tsx` 给 jsdom 手工挂/删 `window.matchMedia` 垫片，覆盖「reduce 时整段显示且设置档位不动」与「matchMedia 缺失不降级」两条；`tests/e2e-ui/reduced-motion.spec.ts` 用 Playwright 的 `browser.newContext({ reducedMotion: "reduce" })` 走开局回合，断言长正文整段立现（无逐字过程）且动效降级不破坏 crafting→game 的屏切换。

## 焦点可见性与文字对比度阶梯（v1.7）

两项无障碍底座，都收在 `src/styles/global.css`：

- **统一焦点环**：`:where(button, a, input, select, textarea, [tabindex]):focus-visible` 画 `outline: 2px solid var(--accent2)` + 2px 偏移。只响应键盘焦点（`:focus-visible`），鼠标点击不闪环——文本输入框例外：浏览器对文字输入控件的启发式判定是**任何聚焦方式都命中** `:focus-visible`，输入中带环是 UA 有意为之的可访问性行为，不做压制。规则写在 unlayered 区（不进 `@layer`）：级联层外的规则优先于 Tailwind v4 的 utilities 层，`:where()` 零特异性兜底，任何工具类都盖不住这圈环——因此组件里不再需要（也不允许）`outline-none`。选中态是另一层语义，与焦点环并存：WorldsScreen 光标行的 `border-gold/40`、剧情图节点的 `--accent2` 描边都原样保留。SVG 节点（`<g tabindex>`）的 outline 由 Chromium 直接支持，无需 `:focus-visible rect` 描边备选。
- **文字对比度阶梯**：`@theme inline` 暴露三档语义色（`--ink` 直混透明度，叠最深面板底 `rgba(12,14,20,.8)×#07080c≈#0b0d12` 上的 WCAG 实测对比度）：
  - `text-ink-body`（ink 80%，≈10.2:1）：次级正文/长说明；
  - `text-ink-hint`（ink 60%，≈6.1:1）：**提示文字下限**——快捷键提示、元信息、状态辅助行、字段标签、图例、加载/空态文案；
  - `text-ink-faint`（ink 45%，≈3.9:1，不达 4.5:1）：**仅限**禁用态（WCAG 对 disabled 控件豁免）、纯装饰符号（如出边列表的 `→`）、≥18px bold 或 ≥24px 的大字——禁止用于正文与常规小字。
  正文主文字继续用 `text-ink`（strong，≈15.8:1）；**全仓文字已全量走 token**——60%/80% 与 hint/body 同值，70/75/85/90 就近归入 body（v1.7.0 收尾第二轮 codemod：全仓不再有 `text-ink/<透明度>` 手写档位，`grep -rn 'text-ink/[0-9]' src/` 应无输出）。

排版收尾：`DialogueBox` 等待玩家输入的继续指示（`◈ 输入数字或直接写下你想做的事`）在就绪且无选项时以主题色轻微脉冲（`animate-pulse text-gold/90`）——reduced-motion 下由上文媒体规则自动停。

测试：`tests/e2e-ui/focus.spec.ts` 在真浏览器断言三处键盘焦点的 computed outline（宽 >0 且 style 非 none）：game 屏 Tab 到命令轨「设置」、世界线屏 ↑↓ roving 到行、剧情图方向键到 SVG 节点 `<g>`（jsdom 不算 computed outline，只能在 e2e 做）。

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
- **`presets/` 随包分发的不只是剧本文件**：立绘/背景（`presets/<id>/assets/`）、封面（`presets/<id>/cover.jpg`）与音频（`presets/<id>/audio/`，v1.6 起）都在里面——打包会把当前仓库的素材一起装进去；顶层 `assets/` 目录在 v1.5.1 已删除，打包配置里不再有它。
- **`.grok/` 随包分发（引擎 skill 的唯一真源）**：`extraResources` 把仓库 `.grok/`（`skills/bunkiten/SKILL.md` + `commands/`）复制进 `resources/game/.grok`，而 `server/acp.mjs` 的 `--plugin-dir` 指的就是它（开发态指仓库根那份）——skill 是引擎纪律的全部真相，必须随包装进去才生效（v1.10，ADR-0021；为什么不是靠文件夹信任，见「ACP 契约」的传输一节）。**该目录只放 `commands/` 与 `skills/`**：`--plugin-dir` 会把它当 always trusted，往里加 hooks/MCP 等于对引擎无条件授予执行权。
- Windows：`npm run dist:win`（x64，`nsis` + `portable`）。不签名由 `electron-builder.yml` 的 `win.signExecutable: false` 决定（只跳过签名，保留图标与版本元数据写入）；本地脚本另设 `CSC_IDENTITY_AUTO_DISCOVERY=false` 双保险。
- macOS：`npm run dist:mac`（`dmg` + `zip`，arm64 + x64）。**签名/公证是条件化的**——`electron-builder.yml` 不再写死 `identity: null`：`CSC_LINK` + `CSC_KEY_PASSWORD` 与 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 齐备时才自动发现证书签名，并由根级 `afterSign: electron/notarize.cjs` 钩子提交 notarytool 公证、成功后 `xcrun stapler staple` 把 ticket 钉进 `.app`（staple 是 best-effort，失败只告警不 fail 构建）；三件套不齐时钩子直接 return，本地 `dist:mac` / `dist:mac:dir` 显式 `CSC_IDENTITY_AUTO_DISCOVERY=false` 走未签名路径。`hardenedRuntime: true` 与 `build/entitlements.mac.plist` 是公证的前置条件。
- `publish` 声明为 **github provider**（`Jackela/bunkiten`）：这是 `latest*.yml` / `app-update.yml` 与 `electron-updater` 的前提。实际发布只由 release job 做（打包一律 `--publish never`），这里只声明 update channel 的来源，避免 update-info 环节拿到 null channel 崩溃。
- 产物在 `release/`。

### 发布（v1.6：打 tag 即发版）

`.github/workflows/release.yml`：push tag `v*`，或手动 `workflow_dispatch`（可填 tag，留空则用 `v<package.json version>`）触发。四个 job：

| job | 做什么 |
|---|---|
| `guard` | 唯一测试门禁，也是唯一跑测试的地方。先核对 **tag == `v<package.json version>`**（不等即秒级失败，避免产物名与 Release 标题不符），再跑全量 `npm test`（单测 + `tests/integration`，约 10s；e2e 不进 CI）。两个 build job 都 `needs: guard`——测试不过就不会产出任何可发布的包 |
| `build-mac` | `macos-14`（arm64 runner）上 `npx electron-builder --mac --arm64 --x64 --publish never`；签名/公证全靠 secrets 条件化（`CSC_IDENTITY_AUTO_DISCOVERY` 由 `secrets.CSC_LINK != ''` 决定，缺 secrets 照样构建成功）；产物清单写 `SHA256SUMS-mac.txt`（`dmg`/`zip`/`latest*.yml`） |
| `build-win` | `windows-latest` 上 `--win --x64 --publish never`；校验和用 PowerShell `Get-FileHash` 写 `SHA256SUMS-win.txt`（`-Encoding ascii`） |
| `release` | `download-artifact`（`merge-multiple`）拉回两个平台的产物 → **合并校验和**：先剥掉每行的行尾 `\r`（Windows 侧是 CRLF，混进发布物会让 `shasum -a 256 -c` 对 `.exe` 那几行报 FAILED），合并后再断言结果**纯 LF 且非空** → `softprops/action-gh-release` 建/更新 Release 并上传产物。notes 优先取 `docs/releases/<tag>.md`，其次 `gh api` 的自动 notes，最后兜底文案 |

- **两个 build job 都不发布**（`--publish never`）：发布只由 release job 做，否则 electron-builder 与 action 会争抢同一个 release。`permissions` 也按 job 收口——默认只读，只有 release job 提到 `contents: write`。
- 平台清单特意分开命名（`SHA256SUMS-<platform>.txt`）：`merge-multiple` 会把两个 artifact 解到同一目录，同名文件会互相覆盖；最终的 `SHA256SUMS.txt` 由 release job 合并生成，保证纯 LF。
- **自动更新**：`electron/main.js` 在打包态调 `electron-updater` 的 `checkForUpdatesAndNotify()`（动态 import，不阻塞开窗；`BUNKITEN_DISABLE_UPDATE=1` 是逃生门，开发态根本不查），更新源就是上面的 GitHub Releases（`latest*.yml`）。**未签名 mac 包无法自动更新**——Squirrel.Mac 要求新旧包签名一致，而本仓库默认发布的正是未签名包，这条路径在 mac 上只会静默失败（升级走手动下载，见「已知限制」）。
- `npm run dist:mac:dir`（`--dir`）的产物**不含 `app-update.yml`**：electron-builder 只在 `dmg`/`zip` 这类 target 才写它，所以那份产物不能用来验证自动更新，只适合本地预检出包内容。

## 已知限制

- **引擎过程旁白**：依赖 RULES + 前端段过滤双保险；模型违规输出时中间段会被丢弃，但流式期间可能一闪而过。
- **语音输入**：`FreeInput` 依赖 `webkitSpeechRecognition`，Electron 内置 Chromium 不带该 API（按钮不渲染）；浏览器开发模式（Chrome）可用。
- **音频没有生成能力（v1.6）**：引擎只有 `image_gen`，音频**纯作者素材**——必须由人把文件放进 `presets/<剧本 id>/audio/`，命名 `<类型>-<名>.<扩展名>`。剧本没放文件（或名字对不上）时端到端静默：引擎不发标记、客户端索引命不中即 no-op，**玩家感知到的只是没有音乐**，绝不会弹错、也绝不会卡住剧情。随附 preset 里目前仅 `rift-mark` 带 `audio/` 示例目录（三个合成 wav），其余 preset 默认静默。
- **快照有量级上限（v1.6）**：`state/worlds/<worldId>/history/NNNN.json` 是 4 位递增，`seq > 9999` 后**不再写快照**并告警一次（文件名位数不变，不做滚动清理）——单条世界线约一万个正戏回合后，回退精度停在最后一条快照上。
- **history 随回合线性增长（v1.6）**：每个正戏回合 append 一条**三文件全文**快照（state/summary/tree 各一份），磁盘占用随游玩线性上升，长世界线会很占地方（内容全等的相邻回合会被去重跳过，但正常回合每轮都不同）。没做压缩或淘汰——快照是精确回退的唯一依据，宁可占地方。
- **本地端点只挡跨站浏览器请求（v1.6）**：来源校验针对的是浏览器发起的跨站请求（CSRF、端口探测），**不防本机其他进程**——本机任意脚本都能直接调 `/api/worlds`、`/prompt` 等端点，这里没有 token、没有登录态校验（`/api/auth` 只是查 `~/.grok/auth.json` 是否存在）。它是「本机专用服务」这个前提下的最小防护，不是鉴权层。
- **mac 包默认未签名（v1.6 起条件签名）**：未配签名 secrets 时产物未签名，首次打开需右键 → 打开；配了 `CSC_LINK` / `APPLE_ID` 三件套的构建才会签名 + 公证 + staple。**未签名的 mac 包无法自动更新**——Squirrel.Mac 要求新旧包签名一致，仓库默认发布的正是未签名包，`electron-updater` 在 mac 上只会静默失败（升级走手动下载 Release 产物）。
- **image_gen 依赖账号套餐**（Imagine 额度）：不可用或限额时引擎静默跳过，游戏不受影响。**根本解法是 v1.10 的图片自备 key**（自建 MCP 工具，见「引擎凭据与自备 key」）——配了自备图片服务就不再经 xAI 的 Imagine 通道；没配的人仍受这条限制。
- **自备 key 明文落盘（v1.10，刻意取舍）**：`~/.bunkiten/credentials.json` 是明文 + 0600——本机磁盘加密（FileVault/BitLocker）是这里的第一道防线，加密存储（keychain/密钥派生）留给后续版本（见 ADR-0019 的「被否决的备选」）。任何本机进程只要读得到这个文件就能拿到 key，这与「本机端点只挡跨站浏览器请求」是同一条前提：server 是单机服务，不是多租户边界。
- **在线服务目录有窗口期（v1.10）**：目录更新是尽力而为的后台动作——主源 jsDelivr 的 `@main` 引用有 CDN 边缘缓存窗口，本机还有 24h TTL 节流，所以「作者往目录里加了一个新服务」到玩家下拉里看得见，最多要等一天 + 边缘缓存；抓不到 / 缓存坏 / 校验不过就继续用内置表（`source:"bundled"`），**这不影响任何已存凭据**——远端只喂下拉候选，永不改写玩家已存的服务地址、密钥与模型（见「服务目录在线更新」）。

## 修改指引

### 加一个剧本

复制 `presets/` 下任意子目录改 `preset.md`。字段分两层消费：

| 字段 | 消费方 | 作用 |
|---|---|---|
| frontmatter `id` / `title` / `tagline` / `genre` / `rating` | **server**（`FM_KEYS`） | 标题屏卡片展示；`id`/`title` 必填，缺失整个剧本被跳过 |
| frontmatter `theme`（缩进子键 `accent` / `accent2` / `motif` / `font` / `dialog`） | **server**（`THEME_KEYS`）→ 前端 | 剧本主题配色、氛围图案、字体族与对话框质感（见「主题系统」）；坏值逐键兜底 aurora/serif/plain 默认 |
| `presets/<id>/cover.jpg`（可选） | **server**（`listAssets` 封面扫描）+ 前端 | 标题屏卡带封面（`coverUrl`，四个官方剧本已配）；缺失回退主题渐变+motif；创作模式装配与封面重绘会自动生成 |
| frontmatter `pov` / `art_style` / `rating` | **引擎**（SKILL 直读原文） | 叙述人称 / 立绘画风 / 尺度基调 |
| `# 世界观`、`# 硬规则` | 引擎 | 背景设定 / 世界不变量 |
| `# quick_start` | 引擎 | 快速开局预设主角 |
| `# 主要角色` 的 `## <角色名>（…）` | **server + 引擎**（server 提取名字列表，预载屏槽位；引擎读全卡） | 每人身份/性格/口癖/agenda/秘密/`art_prompt` |
| `# protagonist_card` | **server + 引擎**（server 提取问题行，捏人屏 chips；引擎开局校验） | 每行 `- 问题: 选项A / 选项B`；标注「选 1-2」允许多选（上限 2） |
| `# opening`、`# 章节`、`# 第一节拍表`、`# 事件池`、`# 主线与结局锚点` | 引擎 | 第一幕指令 / 拆章锚点（章数、各章目标与锚点事件；缺失时按结局锚点自行拆 3–5 章）/ 拆章参考（v1.2 起运行时被剧情树节点取代，保留不删）/ 节点内节奏调剂 / 收束条件 |

无需改任何代码。`/api/presets` 每次请求实时扫描，回标题屏即刷新；给朋友升级就是往他机器的 `resources/game/presets/` 放新文件夹后重启应用。

### 改引擎协议（高危）

文本协议契约散在多处（协议常量的值只有 `shared/protocol.mjs` 一份，其余是消费点与镜像），任何字符串改动必须同步：

| 文件 | 持有的契约 |
|---|---|
| `.grok/skills/bunkiten/SKILL.md` | 引擎侧行为：开局指令与分项美术指令识别、章节规划指令与剧情树纪律（【清单】含差分项/【章】输出）、素材重绘与创作模式指令、每轮协议的【立绘】切换行、**行动**降级格式、【图】标记（三段+重绘段）与预载例外、生成前缓存硬规则、段静默纪律；v1.5 世界线（【世界线】【启动流程】、世界段/续玩指令、世界纪律、fork.md 回退）与剧情编辑（【剧情编辑指令】、【树】行）；v1.6 音频（【音频】小节：文件名口径、频率纪律、缺失静默，与【导演层】第 9 条同源） |
| `src/lib/parser.ts` | 客户端解析/构造：开局指令与分项美术/重绘/章节规划/创作模式指令模板（逐字，含待命/跳过后缀、`美术：` 指令、`开演。`、`规划：第 N 章。`、`ENTER_CREATION`/`BUILD_ASSEMBLE`）、`**行动**` 正则与 `stripOptionsBlock`、标记/清单/章标记正则与差分名拆分、**协议头集合 `PROTOCOL_HEADS`**（re-export 自 `shared/protocol.mjs` 真源，`isProtocolLine` 的正则由它构造，9 项含【曲】【环境】【音效】）；v1.5 世界段（`build*Opening` worldId）/续玩 `buildResumeCommand`/剧情编辑 `buildTreeEditCommand`/`parseStoryTree`/`assetNameMatches`；v1.6 音频（`AUDIO_KINDS` 类型） |
| `src/store/game.ts` + `src/store/slices/*` | 事件编排（v1.6 按 slice 分文件，入口仍是 `store/game.ts`；跨片共享闭包与定时器单例在 `store/context.ts`）：段过滤重置逻辑、标记→画面应用、`expression` 表情切换与 `presetAdded` 刷新、章节制作流水线推进（规划→清单→队列→开演→【章】切章）、画廊单项/批量重绘与批量删除、创作装配状态机、`awaitCommand` 切屏；世界线（`beginNewWorld`/`resumeWorld`/`updateWorld`/`importWorldText`）与剧情图 overlay（`openTree`/`forkAt`/`treeEdited`/`restoreSnapshot`、编辑回合不进历史）；v1.6 设置（`updateSettings`）与自动前进（`armAutoAdvance`） |
| `server/acp-server.mjs`（入口与装配） | `startServer` 闭包：`handleArtLine` 分流（分支顺序 art → expression → tree → presetAdded → audio）、`persistAsset`/`persistAssetFromFile` 落盘纪律（`resolvePersistPreset` 是唯一「落哪个剧本」判定；封面走 `presets/<id>/cover.jpg`）、`listAssets(presetId)` 资产形状（每条回填 `preset`；`inUse` 只扫该剧本的世界）、`sniffPreset` 世界/剧本落定、`sendPrompt` 的正戏回合判定（`isMainTurn`）与快照/回合日志落盘点、质量守卫 `supplementMissingOptions`；`pickEffort`/`isMainTurn`（引用 shared 的 `DIRECTIVE_PREFIX_RE`）与 `DEFAULT_THEME`/`FONT_PRESETS`/`DIALOG_TEXTURES` 钉在入口源码（契约 lint ⑥ 与 `src/theme.ts` 比对）；拆出模块的符号由入口逐名 re-export——外部 import 面不变（见 ADR-0013） |
| `server/protocol-lines.mjs` | `RULES` 原文（注入 agent 的客户端补丁，含「世界纪律」与「音频纪律」句，六句拼接）与五种协议行解析（`parseArtLine`/`parseExpressionLine`/`parsePresetAddedLine`/`parseTreeLine`/`parseAudioLine`）、质量守卫追问指令 `SUPPLEMENT_PROMPT`（server→引擎内部指令，不进 `shared/protocol.mjs`） |
| `server/assets.mjs` | 资产路径契约纯函数：`assetRelPath`（唯一路径构造入口）/`presetAssetsDir`/`presetIdFromPath`/`legacyAssetCandidates`/`sanitizeAssetName`/`splitAssetVariant`/`resolvePersistPreset`/`PRESET_ID_RE`/`mtimeOf`/`uniqueSuffixedName`（导入重名后缀 `base`/`base-2`…，worlds 与 presets 共用），并从 shared re-export `ASSET_FILE_RE`/`ASSET_KINDS`（资产文件名正则唯一真源） |
| `server/presets.mjs` | preset.md 解析（`FM_KEYS`/`THEME_KEYS`/`parseFrontmatter`/`normalizeTheme`/`parseCharacterSections`/`parseSectionLines`）、`assetTargetFile`（封面按标题反查所以在这里）与剧本导出包（`buildPresetBundle`/`importPresetBundle`，见「剧本导出包」）；theme 白名单/兜底值反向 import 入口的三个字面量（仅函数体内引用，ESM 环形安全） |
| `server/snapshots.mjs` | 世界三文件与快照地基：`TREE_FILE`/`WORLD_FILES`/`WORLD_ID_RE`/`readWorldFiles`/`writeWorldFiles`（null=删文件）/`writeSnapshot`/`readSnapshot`/`readSnapshots`（列表缓存**逐文件**复用：名字+mtime 命中即不读盘，只有新增/被覆盖的文件才解析；出口浅拷贝，见「逐轮状态快照与精确回退」）/`selectSnapshotForNode`/`normalizeSnapshot`/`forkTreeMarkdown` 与回合日志 `writeTurnLog`/`LOGS_DIRNAME` |
| `server/worlds.mjs` | 世界线索引与 CRUD：`readWorldsIndex`（裸数组与 `{schema, worlds}` 两种顶层形态都认）/`writeWorldsIndex`（写 `{schema:1, worlds}`，读改写保留未来 `schema` 与未知顶层键——ADR-0018）/`listWorlds`/`createWorld`/`forkWorld`/`restoreWorld`/`updateWorld`/`deleteWorld`（`moveToTrash` 唯一回收站入口，ADR-0014）/`exportWorld`（刻意不含 logs/）/`importWorld`/`migrateLegacyState`（旧扁平布局）/`migrateWorldsSchema`（索引 schema，启动期调用）与角色面板 `parseStateFile`/`stateViewFor` |
| `server/audio.mjs` | `scanPresetAudio`（`presets/<id>/audio/` 扫描；`AUDIO_FILE_RE`/`AUDIO_REL_RE`/`AUDIO_MIME` 真源在 `shared/protocol.mjs`） |
| `server/http-util.mjs` | 本地端点两道闸（`isCrossSiteRequest`/`readBodyText` + `MAX_BODY_BYTES`；可选 `maxBytes` 唯一消费方是剧本导入 50MB）与 `/app` 静态托管的 `MIME`/`resolveAppDist` |
| `server/acp.mjs` | `createAcpSession` 工厂：spawn（参数面固定带 `--plugin-dir <gameRoot>/.grok`，v1.10/ADR-0021——改了它就动引擎侧 skill 的可见性）/JSON-RPC request/sessionId 存取/boot 握手/会话图片定位 `resolveImage`（跨会话图索引 + 5s TTL，见「资产管线」）；与 HTTP 层的接缝是 `onChunk`/`onSeg` 两回调，另有 `env`/`mcpServers` 两个注入项（v1.10：凭据 env 与按需挂 MCP） |
| `server/credentials.mjs` | 引擎凭据（v1.10，ADR-0019）：`defaultCredentials`/`normalizeCredentials`（逐键容错，永不抛）/`credentialsPath`/`readCredentials`/`writeCredentials`（目录 0700、文件 0600、临时文件 + rename）/`mergeCredentials`（空串=清字段，`clear` 整组回默认）/`validateCredentialsPatch`（路由写盘前的字段校验；provider 白名单**由调用方注入**——路由给的是「内置 ∪ 当前在线目录」）/`maskKey`（`sk-…4f2a`）/`hasKey`/`llmReady`/`publicView`（HTTP 出口的脱敏形状，**永不含明文**）/`credentialsToEnv`（BYOK 的三个变量，未配置时是空对象）/`sanitizeErrorMessage`/`secretsOf` |
| `server/credentials-probe.mjs` | 「测试连接」的实作（v1.10）：`testLlm`（先 `GET {baseUrl}/models`；404/405/501 退化一次最小 completion，`max_tokens` 被拒换 `max_completion_tokens`；401 直接判失败）/`testImage`（复用 media-mcp 的 `requestImage` 做一次最小生成）；都回 `{ ok, status, ms, error?, detail? }`，错误已脱敏截断 |
| `server/media-mcp.mjs` | 自建出图 MCP server（v1.10，stdio JSON-RPC，零依赖）：工具 `bunkiten-media__generate_image`（`TOOL_DEFINITION`）、`MEDIA_TOOL_CATALOG_NAME`（catalog 全名——`tools/call` 的 `params.name` **裸名与全名两种都认**，真引擎发的是全名）、`requestImage`（OpenAI 兼容 `/images/generations` + 参数退让梯子 + `b64_json`/`url` 两种回包）、`generateImage`（读凭据 → 出图 → 按 `assets.mjs`/`presets.mjs` 的纯函数落盘）、`resolveOutputPath`/`imageSizeFor`/`imagesEndpoint`/`pickImagePayload`、`mediaMcpPath`/`mediaMcpServers`（asar 外路径与挂载项）、`handleMcpMessage`（协议面，单测直喂消息） |
| `server/providers-catalog.mjs` | 服务目录的在线更新通道（v1.10，ADR-0020，见「服务目录在线更新」）：`CATALOG_URLS`/`CATALOG_VERSION`/`CATALOG_TTL_MS`/`CATALOG_TIMEOUT_MS`、`validateCatalogDocument`（纯函数：整包拒 / 单条丢两级取捨）、`readCatalogCache`/`writeCatalogCache`（`~/.bunkiten/providers.json`，0700/0600 原子写，读路径永不抛）、`loadCatalog`（memo → 缓存 → 内置）、`refreshCatalog`（启动期非阻塞抓一次，两个开关与 TTL 节流，失败静默） |
| `scripts/export-providers.mjs` + `docs/providers.json` | 服务目录发布源（v1.10，ADR-0020）：`npm run providers:export` 从唯一真源 `shared/providers.mjs` 生成仓库 JSON（`{version, updatedAt, providers}`，**只搬不改**）；契约 lint ⑦ 组断言它与 `PROVIDERS` 深等。**改了目录真源要顺手跑一次并提交**，否则 lint 会红 |
| `shared/providers.mjs` | 服务目录唯一真源（v1.10，同时是在线更新的**内置兜底**）：`PROVIDERS`（`{id, label, kind:"llm"\|"image"\|"both", baseUrl, models, imageModels?, note?}`）/`PROVIDER_IDS`（由 `PROVIDERS` 派生）/`providersFor(kind)`（设置屏下拉的**回落**来源）/`providerById`/`PROVIDER_ID_RE`（provider id 形态的唯一真源，`credentials.mjs` 的读路径与目录校验共用）。在线目录（`docs/providers.json` → `server/providers-catalog.mjs`）由它生成、与它深等比对；服务端写路径的白名单是**内置 ∪ 当前目录**。契约 lint ⑦ 组钉住「GUI 吃真源、不许自带第二份 id 表」；类型由手写 `shared/providers.d.mts` 承接（与 `protocol.mjs` 同款机制） |
| `server/routes.mjs` | `createRequestHandler(ctx)` HTTP 路由链（闭包能力由入口注入）：`/api/presets`(GET,POST:import)/`/api/presets/export`、`/api/auth`、`/api/providers`（v1.10）、`/api/credentials`(GET,POST)/`/api/credentials/test`/`/api/engine/restart`、`/api/assets`(GET,POST:删除)、`/api/audio`/`/audio`、`/api/worlds`(GET,POST 全 action)/`/api/worlds/export`、`/api/history`、`/api/tree`、`/api/state`、`/img`、`/events`、`/prompt`、`/app` 静态托管（端点语义见「HTTP / SSE API 一览」） |
| `server/config.mjs` | 路径与端口常量：`GAME_ROOT`/`BASE_PORT`/`PORT_MAX_RETRY`/`SESSION_FILE`/`WORLDS_ROOT` |
| `shared/protocol.mjs` | 协议常量唯一真源（v1.7，见 `docs/adr/0012`）：`PROTOCOL_HEADS`（9 头）、`AUDIO_KINDS`/`AUDIO_EXTS`/`AUDIO_MIME`/`AUDIO_FILE_RE`/`AUDIO_REL_RE`（音频白名单与直服正则，后两者由前两者构造）、`ART_KINDS`/`ASSET_KINDS`/`ASSET_FILE_RE`（美术类型字面与资产文件名正则，v1.7 收尾收编；`ASSET_FILE_RE` 由 `ASSET_KINDS` 构造）、`DIRECTIVE_PREFIX_RE`（指令前缀正则，`pickEffort` 推理分档与 `isMainTurn` 正戏回合判定共用）。`src/lib/parser.ts` re-export（公共 API 不变）并从真源构造 `ART_LINE_BODY`/制作清单正则、`server/acp-server.mjs` import（并 re-export `AUDIO_KINDS`/`AUDIO_EXTS`/`ASSET_FILE_RE`/`ASSET_KINDS` 给 `scripts/doctor.mjs`）；`shared/protocol.d.mts` 是手写类型声明（tsc -b 按 `.mjs`→`.d.mts` 解析；vite/vitest/electron 运行时直接吃 `.mjs`）。`RULES` 刻意不收编：引擎只读 `.grok/` 提示词、不会 import 代码，server↔SKILL.md 双份 + lint 逐字比对仍是正确机制 |
| `tests/parser.test.ts`、`tests/crafting.test.ts`、`tests/server.test.ts`、`tests/treeLayout.test.ts`、`tests/genealogy.test.ts`、`tests/diff.test.ts`、`tests/doctor.test.ts`、`tests/preload.test.ts`、`tests/credentials.test.ts`、`tests/providers-catalog.test.ts`、`tests/ui.test.tsx`、`tests/integration/*` | **单测 + 集成全量 560+ 例**（**下限口径**：数字说的是「不少于」，唯一维护点是 `tests/contract.test.ts` 的 `CASE_GROUPS`/`CASE_TOTAL`——加用例不用改任何文档、删用例才红，逐分组数字不再抄进文档）——契约字符串快照与单测：开局指令四变体（含世界段）/续玩/剧情编辑、分项美术/重绘/章节规划/创作模式指令、`开演。`、清单（含差分项）/章标记与选项解析期望值（parser）、章节制作流水线指令序列（crafting，stub fetch）、世界线/资产落盘判定/协议解析/快照与导出导入/剧本导出包（往返/重名/文件名安全/扩展名与 base64 校验）/state.md 容错解析与 `/api/state` 路由判定、回合日志 `writeTurnLog` 与追问指令常量、索引 schema 与迁移（裸数组升起、写路径写 `{schema:1, worlds}`、未来 schema 读到且写回不降级——ADR-0018）（server，含剧本体检端点）、布局纯函数（treeLayout + genealogy：家谱森林分层、孤儿 missingParent、fork 环终止、层内排序确定性与键盘步进）、快照对比纯函数（diff：全等/全增/全删/替换块相对顺序/空输入/空行/典型 state.md 好感度一行）、剧本体检查纯函数（doctor：tmp 根造 preset 覆盖七组判定、theme 双层回退与 checkAllPresets 汇总，见「剧本体检查」节）、引擎凭据纯函数（credentials：读写往返与 0600、坏 JSON 容错、掩码边界、`credentialsToEnv` 每模式、`publicView` 不含明文、服务目录表完整性、media-mcp 的尺寸/端点/目标路径/取字节/参数退让、探活的两条路径——ADR-0019）、服务目录在线通道纯函数（providers-catalog：整包拒 / 单条丢的两级取捨、https-only 与本机 http 例外、白名单字段重建、目录 0700 / 文件 0600 原子写、坏缓存当无缓存、缓存优先与进程内 memo、先主后备与 TTL 节流、两个开关——ADR-0020）、组件含设置屏、自动前进与回退后分割线/待重同步（含在途中止）、动效降级打字机、主题字体族与对话框质感、重掷本回合全链（含快照数不足时入口不渲染）、角色面板渲染/秘密折叠/turn_end 重拉/空态、世界线家谱视图、快照对比面板、标题屏剧本导出/导入、同屏多立绘的队列渲染与让位档（ui）；立绘差分预热纯函数（preload：清单每剧本只拉一次、命中角色的基础与全部差分都进预载、失败静默）；另有真 server 子进程的集成测试（`integration/pipeline`、`integration/audio-history`、`integration/http-guard`、`integration/credentials`——音频事件、快照落盘与精确回退、世界线与剧本的导出/导入往返、索引 schema 的启动迁移（裸数组升起 / 未来 schema 读到且不被降级写回）、来源校验 403 与 body 上限 413、引擎 error response 的 409 传播、回合原文日志与缺选项段的质量守卫追问；自备 key 则覆盖：端点脱敏与 400 校验、盘上 0600、env 真注进引擎子进程（假引擎探针）、图片侧才挂 MCP 与重启后重 spawn、`/api/auth` 的三态、`/test` 的两条探活路径、media-mcp 子进程的 initialize→tools/list→tools/call 冒烟；服务目录通道则用本地 mock 发布源验三态——启动抓远端（`source:"remote"`）→ 落盘 0600/目录 0700 → 断源重启吃缓存 → 全新 HOME 抓不到回内置兜底且不写缓存（`integration/providers-catalog`，harness 为此加了 `extraEnv`/`homeDir` 两个可选参数并默认钉 `BUNKITEN_DISABLE_UPDATE=1`）；mock 出图链路（`integration/media-mock`：假引擎真发 `tools/call` → media-mcp → `tests/helpers/mock-image-server.mjs` 的本地假图片服务 → 同名 jpg 字节落盘 + 【图】事件）） |
| `tests/contract.test.ts` | v1.6 起契约 lint（防漂移门禁，读源码与文档、不起子进程）：`PROTOCOL_HEADS` 唯一真源（`shared/protocol.mjs` 源码字面 + import 值 + parser re-export 链三方钉住）↔ server/parser 解析出口 ↔ `SKILL.md`「标记格式备忘」/本文档、`RULES` 逐字副本（server 常量 ↔ 本节代码块）、指令字符串双处存在（`parser.ts` ↔ `SKILL.md`）、`DIRECTIVE_PREFIX_RE` 单一真源（`pickEffort`/`isMainTurn` 函数体都引用它、server 无第二份前缀字面）、主题白名单与兜底主题（server ↔ `src/theme.ts` 同集同值）、各测试文件的 `it(`/`test(` 用例数不低于 `CASE_GROUPS` 声明的**分组下限**（下限语义：加用例不用改任何文档，删用例才红；文档只留一句粗口径、不再逐分组抄数字）、设置键 `bunkiten.settings.v1` 与音频扩展名三处一致（音频常量断言指向 `shared/protocol.mjs` 真源）、美术类型集合与资产文件名正则真源（`ART_KINDS`/`ASSET_KINDS`/`ASSET_FILE_RE`：双侧构造 + server/scripts 无第二份字面）、引擎凭据（v1.10，⑦ 组）：服务目录表完整性与「GUI 吃 `shared/providers.mjs` 真源、src/ 不许出现目录 id 字面量」、两组模式字面与 server 的 `LLM_MODES`/`IMAGE_MODES` 同词、MCP 工具名（`media-mcp.mjs` 的两个常量拼出的 `bunkiten-media__generate_image` ↔ SKILL.md 的「出图工具优先」句）、凭据落点与环境变量名 ↔ 本文档逐字一致、服务目录发布源 `docs/providers.json` ↔ `PROVIDERS` 深等（v1.10：手改 JSON 会红，跑 `npm run providers:export` 重新生成）。**它自己的用例不计入合计下限口径**（`tests/e2e/**` 同样不在口径内） |

v1.3 三组新契约的同步点速查（同一改动五处联动的具体落点）：

| 契约 | 同步点 |
|---|---|
| 差分与表情切换（`【清单】立绘\|<角色>-<变体>` / `美术：立绘 <角色>-<变体>` / `【立绘】<角色>\|<变体>`） | `SKILL.md`【章节与剧情树】差分清单、【每轮协议】【美术】差分规则与导演层第 8 条 · `parser.ts` `splitAssetVariant` · `protocol-lines.mjs` `parseExpressionLine`（入口 `handleArtLine` 广播 `expression`）· `store/game.ts` `nextPortraitOnExpression` · `PortraitLayer` 两级回退 · `tests` 快照 |
| 重绘（`美术：重绘 <类型> <名>[-<变体>]` 与【图】第四段「重绘」） | `SKILL.md`【素材重绘】+ `RULES` 第 3 句 · `parser.ts` `buildRegenCommand`/`scanMarkers` 四段正则 · `protocol-lines.mjs` `parseArtLine` regen 分支与入口 `persistAsset` 覆盖 · `store/game.ts` `startRegen`/`finishRegen` · `tests` 快照 |
| 创作模式（`创作模式：进入剧本创作。` / `装配。` / `【新剧本】<id>`） | `SKILL.md`【剧本创作】+ `RULES` 第 3 句 · `parser.ts` `ENTER_CREATION`/`BUILD_ASSEMBLE`/`isProtocolLine` · `protocol-lines.mjs` `parsePresetAddedLine` → 入口广播 `presetAdded` 事件 · `store/game.ts` creation 状态机 · `tests` 快照 |

v1.5 世界线 / 剧情树的同步点速查：

| 契约 | 同步点 |
|---|---|
| 世界线（`世界：<worldId>。` / `继续世界：<worldId>。` / `state/worlds/<worldId>/`） | `SKILL.md`【世界线】【启动流程】【状态文件格式】全段 state 路径 · `config.mjs` `WORLDS_ROOT` 与 `snapshots.mjs` `WORLD_FILES` 常量、`worlds.mjs` `readWorldsIndex`/`writeWorldsIndex`/`listWorlds`/`worldChapterNo`/`createWorld`/`forkWorld`/`deleteWorld`（删除进 `state/trash/`，`moveToTrash` 唯一入口）/`migrateLegacyState` 与 `routes.mjs` 的 `/api/worlds`、`/api/tree` 端点 · `parser.ts` `build*Opening`(worldId)/`buildResumeCommand` · `store/game.ts` `beginNewWorld`/`resumeWorld` · `RULES`「世界纪律」句 · `tests/parser.test.ts`+`tests/server.test.ts` 快照 |
| 剧情编辑（`剧情：<指令>` / `【树】` 行） | `SKILL.md`【剧情编辑指令】· `parser.ts` `buildTreeEditCommand`/`parseStoryTree`/`isProtocolLine` · `protocol-lines.mjs` `parseTreeLine` → 入口 `handleArtLine` 广播 `treeEdited` 事件 · `store/game.ts` tree overlay 与「编辑回合不进历史」 · `tests` 快照 |
| 剧情图布局 | `parser.ts`（`parseStoryTree` 与 `TreeNode`/`TreeChapter` 类型）· `treeLayout.ts` `layoutTree` · `StoryTreeScreen.tsx` · `tests/treeLayout.test.ts` |

v1.6 音频 / 快照 / 世界线管理 / 设置的同步点速查：

| 契约 | 同步点 |
|---|---|
| 音频三行（`【曲】<名>` / `【环境】<名>` / `【音效】<名>`） | `SKILL.md`【音频】+【导演层】第 9 条 + `RULES` 第 6 句（音频纪律） · `shared/protocol.mjs` 的 `PROTOCOL_HEADS`（9 项）/`AUDIO_KINDS`（唯一真源；`parser.ts` re-export 并构造 `isProtocolLine`）· `protocol-lines.mjs` `parseAudioLine` → 入口 `handleArtLine` 末位分支 → `audio` 事件、`audio.mjs` `scanPresetAudio`/`AUDIO_FILE_RE` 与 `routes.mjs` 的 `/api/audio`、`AUDIO_REL_RE`/`AUDIO_MIME` 与 `/audio`（常量 import 自 shared）· `lib/audio.ts` `AudioManager`（「类型\|名 → 文件」索引、缺失静默）· `store/slices/gameplay.ts` `handleEvent` 的 `audio` 分支 · `lib/settings.ts` 音量键 · `tests/integration/audio-history.test.ts` 集成断言 |
| 快照与回退（`state/worlds/<worldId>/history/NNNN.json` 路径与条目结构） | `snapshots.mjs` `writeSnapshot`/`readSnapshot`/`readSnapshots`/`normalizeSnapshot`/`latestSnapshot`/`selectSnapshotForNode`/`writeWorldFiles`（null=删文件）与 `worlds.mjs` `forkWorld(seq)`/`restoreWorld`/`exportWorld`/`importWorld`、`routes.mjs` 的 `/api/history`、`/api/worlds {fork,restore,import}`、`/api/worlds/export` 端点 · `lib/acp.ts` `fetchHistory`/`fetchSnapshot`/`postWorldRestore`/`worldExportUrl`/`postWorldImport` · `store/slices/tree.ts` `restoreSnapshot`（成功后自增 `treeStamp` 并补发 `继续世界：<worldId>。`）/`forkAt` · `StoryTreeScreen` 节点「快照 #seq · 第 N 轮」标注、两段确认回退、有快照的分叉带 seq · `tests/server.test.ts` + `tests/integration/audio-history.test.ts` |
| 世界线 `label` / `note` | `state/worlds/index.json` 字段 · `worlds.mjs` `updateWorld`（≤60 / ≤200，空串=清除）/`importWorld`（note 追加「（导入）」）/`forkWorld`（自动写「分叉自 …」）/`listWorlds`（老索引补 `label:""`） · `lib/acp.ts` `postWorldUpdate` · `store/slices/world.ts` `updateWorld`/`importWorldText`/`parseWorldBundle` · `WorldsScreen` 行内改名编辑器与 `worldDisplayName`（`label → note → worldId`）· `tests/server.test.ts`+`tests/ui.test.tsx` |
| 设置键（`bunkiten.settings.v1`） | `lib/settings.ts` `SETTINGS_STORAGE_KEY`/`DEFAULT_SETTINGS`/`normalizeSettings`/`loadSettings`/`saveSettings`/`TEXT_SPEED_MS`/`AUTO_ADVANCE_OPTIONS` · `store/slices/nav.ts` `updateSettings`（唯一写入方：AudioManager + localStorage）· `SettingsScreen` 控件 · `DialogueBox`（文字速度）/`OptionList`（自动前进）· `App.tsx`（启动时把设置喂给 AudioManager）· `tests/ui.test.tsx` |

v1.10 服务目录在线更新 / 引擎 skill 注入 / 出图工具名的同步点速查：

| 契约 | 同步点 |
|---|---|
| 服务目录在线更新（发布源 `docs/providers.json` → 服务端抓取 → `~/.bunkiten/providers.json` 缓存 → 内置兜底，`/api/providers` 的 `source` 三态） | 真源 `shared/providers.mjs` 的 `PROVIDERS`（也是内置兜底）· `scripts/export-providers.mjs` + `package.json` 的 `providers:export`（改真源要同批重生成并提交，否则契约 lint ⑦ 组红）· `server/providers-catalog.mjs`（`CATALOG_URLS`/`CATALOG_VERSION`/`CATALOG_TTL_MS`/`CATALOG_TIMEOUT_MS`、`validateCatalogDocument`/`readCatalogCache`/`writeCatalogCache`/`loadCatalog`/`refreshCatalog`）与入口 `startServer` 的 `void refreshCatalog()` + 闭包 `providersView`/`allowedProviderIds` · `routes.mjs` 的 `GET /api/providers` · `credentials.mjs` 的 `validateCredentialsPatch`（白名单由调用方注入：内置 ∪ 目录）与 `shared/providers.mjs` 的 `PROVIDER_ID_RE`（形态真源，读路径用）· GUI `src/components/EngineKeysSection.tsx`（在线目录优先、`providersFor(kind)` 回落、「在线目录」标注 `engine-catalog-online`）· `tests/providers-catalog.test.ts` + `tests/integration/providers-catalog.test.ts` · `docs/adr/0020` |
| 引擎 skill 注入（spawn 固定带 `--plugin-dir <gameRoot>/.grok`） | `server/acp.mjs` 的 spawn 参数面 · `.grok/` 目录布局（**只有 `commands/` 与 `skills/`**——`--plugin-dir` 会 always-trust 它，加 hooks/MCP 就是无条件授予执行权）· `electron-builder.yml` 的 `extraResources`（`.grok` → `resources/game/.grok`）与打包布局一节 · 假引擎探针 `tests/integration/fake-engine.mjs`（记录 `argv`）+ `tests/integration/credentials.test.ts`（断言参数含 `--plugin-dir` 且值 = `<gameRoot>/.grok`）· `docs/adr/0021` |
| 出图工具名（`bunkiten-media__generate_image` 与裸名 `generate_image` 都认） | `server/media-mcp.mjs` 的 `MEDIA_MCP_NAME`/`MEDIA_TOOL_NAME`/`MEDIA_TOOL_CATALOG_NAME` 与 `tools/call` 分支 · `SKILL.md`【美术】「出图工具优先（硬规则）」（引擎经 `search_tool`/`use_tool` 用 catalog 全名调）· 契约 lint ⑦ 组（两个常量拼出的键必须逐字出现在 SKILL.md 里）· 三层 mock 出图用例（`tests/integration/media-mock`、`tests/e2e-ui/media-mock.spec.ts`、`tests/e2e-packaged/packaged.spec.ts` 第二条）与真链路 `tests/e2e-packaged/real-image.spec.ts` |

改完跑 `npm test`（单测 + 集成；改契约字符串必须同步快照与 `tests/contract.test.ts` 的三处断言）与 `npm run build` 验证类型与构建。

**出图链路的三层 mock 覆盖（v1.10，改这条链就要按层看住）**：① **集成层** `tests/integration/media-mock.test.ts`（假引擎真对 MCP 连接发 `tools/call` → `server/media-mcp.mjs` → `tests/helpers/mock-image-server.mjs` 起在本进程的本地假图片服务）——断言落盘字节与回包**逐字相等**、二次重绘 mtime 前进、`/img` 直服 200，**随 `npm test` 跑**；② **e2e-ui 层** `tests/e2e-ui/media-mock.spec.ts`——同一跳走**全 UI**（标题屏「素材」→ 立绘卡「重新生成」→ 画廊换图），离线秒级、**进 CI**；③ **打包态** `tests/e2e-packaged/packaged.spec.ts` 的第二个 test——把这条链放回 `.app`（打包布局 + 假引擎 + 假图片服务，**不需要真凭据/真网络**），断言 `Resources/game` 下落出新 jpg 且 `/img` 直服 200。**真链路**是 `tests/e2e-packaged/real-image.spec.ts`（opt-in、不进 CI）：真 grok CLI + 本机登录态 + 真图片服务凭据 + 出网，走画廊重绘（SKILL 里唯一绕过生成前缓存的路），真花一次对话与一张图——三层替身各测各的协议面/UI 面/打包面，真链路负责证明「真能画出来」。

**已知 flake 的历史处置（v1.10，改 e2e 前先读这两条）**：① **焦点归还**——`tests/e2e-ui/flow.ts` 的 `handFocusBackToBody()` 先等 game 屏就绪后那次**被动自动聚焦**（`FreeInput`）真的落地、再点画面角落、最后轮询 `document.activeElement === body`；`focus.spec`/`keyboard.spec` 已改用它。此前那两条用例只等 status 行「就绪」就发键盘，而自动聚焦是回合收尾**之后**才跑的被动 effect，于是 Tab 起点偶发从 body 变成输入框（首个焦点落到面板的麦克风/发送上，数字键与空格被输入框吃掉）——post-merge CI 上偶发红的就是这一条；判据是**事件不是时长**，没有可调的超时。② **冷启动预算**——启动链三条读接口走 `src/lib/acp.ts` 的 `fetchBoot`（`BOOT_FETCH_TIMEOUT_MS`，超时落到两屏既有的错误态而不是一直转圈），e2e 侧只给「进标题屏」这第一个断言 `flow.ts` 的 `BOOT_TO_TITLE_MS`，其余断言照旧走全局 10s（调大全局会把真正的慢一起藏起来）。
