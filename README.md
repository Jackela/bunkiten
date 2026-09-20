<p align="center"><img src="build/icon.png" width="120" alt="bunkiten 图标：金色分岔线与分岔点的暖光"></p>

# bunkiten（分岐点）

<p align="center"><a href="https://github.com/Jackela/bunkiten/actions/workflows/ci.yml"><img src="https://github.com/Jackela/bunkiten/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a> <a href="https://github.com/Jackela/bunkiten/releases"><img src="https://img.shields.io/github/v/release/Jackela/bunkiten?label=release" alt="最新 release"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a> <img src="https://img.shields.io/badge/node-24-brightgreen.svg" alt="Node 24"></p>

> v1.9.0 —— 给单人定制的 LLM 互动 AVG（文字冒险 / 视觉小说）完整产品：Electron 桌面壳 + React 前端 + grok CLI（ACP）叙事引擎；本版把 v1.8.0 之后欠的账清完——**存档有版本判据**（世界线索引升成 `{schema, worlds}`、启动期一次性迁移、`schema` 更新时只读不覆写，旧导出包照收并按当前形状补齐；导出包 v2 带上分叉血缘，导入回来不再变成根），**舞台能同框两人**（发言者高亮 + 名牌、非发言者压暗，第三人按队首淘汰），**菜单交给 headless 原语**（Radix DropdownMenu：↑↓/Home/End 与 typeahead），**作者工具进了游戏**（剧本体检屏直出 `npm run doctor` 的判定），无障碍补齐浮层语义（焦点陷阱、背景 `inert`、滚动锁），世界线行加了封面缩略图，并把性能**测成了数字**（结论：当前规模不需要虚拟化）。

一个自包含的游戏：**引擎是 skill**（`.grok/skills/bunkiten/SKILL.md`），**剧本是数据**（`presets/`），**进度是文件**（`state/`），**美术按需生成**（image_gen，按「类型+名字」持久化到当前剧本的 `presets/<id>/assets/`）。AI 实时演绎剧情、画立绘背景，你做选择。每个剧本自带一套主题——配色与氛围图案从标题屏卡带一路贯穿到对话框。

## 一屏看懂

```
启动 → 检查 grok 登录 → 标题屏卡带轮播（← → 切换 · Enter 装载；左下「继续上次」直通最近玩的那条世界线，右下角落簇 导出（把当前这部剧本打包分享）/ 导入剧本 / 素材 / 创作新剧本）
     → 世界线屏（每行一个「继续」+ 一个 ⋯ 菜单（改名 / 导出 .world.json / 两段确认删除），右上「新世界线」与「导入」；「家谱」视图把分叉血缘画成森林——谁从哪条线哪个节点分出来一目了然，⌫ = 父线已删，可滚轮缩放 / 拖拽平移）→ 新世界线才去捏主角（或快速开局）→ [制作中：第 1 章大纲 → 按清单逐张生成本章美术（含表情差分，可跳过） | 跳过直接开演] → 开演
每轮：正文（打字机，点对话框或按空格立即显示全文；角色立绘随情绪切换差分）→ 【行动】选项按钮（点按钮或按 1-9）/ 自由输入（含输入选项编号）→ 下一轮；对话框右上角另有两个小控件——「自动」（开自动前进）与「快进」（立即显示全文）；不满意这一掷？右侧「重演」撤销刚走完的这一轮并自动重发同一句输入重新演绎（本世界第一轮除外，可连掷；回想里只留一条分割线，旧幕不删）
声音：引擎每轮可发【曲】/【环境】/【音效】三行——BGM 与环境音各一条通道交叉淡入、音效一次性；文件由作者放在 presets/<id>/audio/，没放就静默
动效：跟随系统「减少动态效果」（prefers-reduced-motion，不新增设置开关——OS 级偏好是用户已做的选择）——位移类动效瞬时化、脉冲光标静止、打字机直接整段显示（淡入淡出保留，属无障碍推荐替代）
章间：本章收束 → 自动进下一章制作（大纲 → 本章全部分支美术）→ 开演，直至终局；跨章时画面正中亮一次「第 N 章」过场（约 2 秒，不拦点击、不抢焦点）
画面：封面卡带 + 背景层 + 角色立绘（差分两级回退）+ 对话框（宽屏时右侧留出立绘宽度，对话框整体左移、不压在立绘上）+ 主题化配色/氛围层；各屏共用一套版式——满幅主题底 + 宽栏 + 统一的面板底与字号档位，不再各屏自写居中小窄栏（外框见 src/components/ShellPage.tsx）；顶栏左上角只在「忙 / 出错 / 待重同步」时现身（状态点 + 玩家口吻的状态文字（忙时带已耗时秒数）+ 世界名 + 重同步徽章），一切正常时整簇收起、把画面还给立绘；章号不在顶栏——它只出现在过场卡与回想抽屉标题上；右侧竖排按钮轨从上到下 设置（齿轮：主音量与静音/BGM·环境/音效/文本速度/自动前进）/历史（回想）/角色（面板：好感度/表情/秘密（默认折叠防剧透）/导演手记，回合后自动刷新）/画廊/剧情图/重演（有上一轮输入时）/重开/前情/换剧本/帮助
剧情图：节点带存档点标注（存档点 · 第 N 幕），可「回退到此节点（原地）」（覆盖该世界线三文件并让引擎重新读档续演），详情里还能「与上一个存档点对比（第 N 幕 → 第 M 幕）」（当前状态/前情提要/剧情图三个 tab 逐行 diff）；顶部章节切换器列出解析出的每一章，点谁画谁（归档章只剩目录信息，点了会直说）；宽屏时节点详情住在右侧栏，窄屏回到画布下方；本章节点 > 40 默认降级为列表（可切回图形）；图形模式滚轮缩放 · 拖拽平移 · 双击复位
画廊：进「选择模式」勾选多张 → 批量重绘（顺序队列）/ 批量删除（两段确认）；封面不参与删除
```

幕后一句话：`grok agent --always-approve stdio`（ACP 协议）做引擎，客户端只渲染正文通道（思考流与工具旁白被架构性过滤）；每会话注入 rules 让引擎输出文本选项，前端解析成按钮；`【图】立绘|角色|images/N.jpg` 标记驱动画面，`【立绘】角色|变体` 行随情绪切换差分立绘；`【曲】`/`【环境】`/`【音效】`三行切换音频（按名字映射到 `presets/<id>/audio/` 里的文件，缺失即静默）；回合推理档默认 medium 提速（`EFFORT` 可调）。

## 两种运行方式

交付形态只有一种：Electron 桌面应用（MVP 期的终端 TUI 已删除）。下表两列是同一种形态的两种跑法。

> 不想从源码跑？直接下载安装包：[Releases](https://github.com/Jackela/bunkiten/releases)（未签名：macOS 首次打开需右键「打开」，Windows 会有 SmartScreen 提示）。配套的自动更新（electron-updater，打包态启动时查一次）只在**签名构建**上可用——未签名 mac 包装上后不会自动升级（Squirrel.Mac 要求签名一致），想更新就重新下载安装包覆盖安装。

| | 桌面安装包（给朋友） | 开发模式（给自己） |
|---|---|---|
| 启动 | `release/` 产物：Windows `Bunkiten Setup.exe` / portable；mac `.dmg` | `npm run dev:electron`（vite + Electron 并行；纯前端调试可 `npm run dev`，另起 `node server/acp-server.mjs`） |
| 前端来源 | acp-server 同源托管打包产物（`/app`） | vite dev server（proxy → `localhost:7800`） |
| 数据根 | `resources/game/`（asar 外可写） | 项目根 |

玩家侧安装与故障排查见 [QUICKSTART.md](QUICKSTART.md)。

## 目录结构

```
bunkiten/
├─ electron/
│  ├─ main.js               # Electron 主进程：GAME_ROOT、PATH 补齐、启动 acp-server、开窗口、打包态查更新（electron-updater）
│  └─ notarize.cjs          # afterSign 公证钩子：APPLE_* 三件套不齐直接 return（本地与未配 secrets 的构建照常成功）
├─ server/                  # 本地 Node 服务（零依赖；v1.7 拆成入口 + 10 模块，v1.10 加 3 个凭据/出图模块，模块地图见入口文件头注释）
│  ├─ acp-server.mjs        # 入口与装配：ACP 客户端 + HTTP/SSE 路由 + /img /audio 直服 + 资产落盘 + 世界线/快照/剧本导出包接口 + 引擎凭据端点
│  ├─ credentials.mjs       # 引擎凭据（v1.10）：~/.bunkiten/credentials.json 的读写/脱敏/转引擎 env（纯函数，永不抛）
│  ├─ credentials-probe.mjs # 「测试连接」（v1.10）：对话侧 /models（或退化最小 completion）、图片侧一次最小生成
│  └─ media-mcp.mjs         # 自建出图 MCP server（v1.10，stdio JSON-RPC，零依赖）：把自备图片服务变成引擎可调用的 generate_image
├─ shared/
│  ├─ protocol.mjs          # 协议常量唯一真源（v1.7）：PROTOCOL_HEADS 9 头 / AUDIO_* 音频白名单与直服正则 / DIRECTIVE_PREFIX_RE 指令前缀（pickEffort 与 isMainTurn 共用）
│  ├─ protocol.d.mts        # 手写类型声明（tsc -b 经 .mjs→.d.mts 解析；运行时直接吃 .mjs）
│  ├─ providers.mjs         # 服务目录唯一真源（v1.10）：设置屏两个下拉与 server 侧校验共用（id/baseUrl/模型提示/说明）
│  └─ providers.d.mts       # 同款手写类型声明
├─ scripts/
│  └─ doctor.mjs            # 剧本体检查 CLI（npm run doctor，作者侧、不进 CI）：frontmatter/正文/封面/资产与音频命名/孤儿素材，退出码非 0 ⟺ 有 error
├─ src/                     # React 前端
│  ├─ App.tsx               # 屏幕切换 + SSE 接入 + 主题变量注入
│  ├─ store/                # 全局状态机（zustand），按动作切片，共享一个模块级单例
│  │  ├─ game.ts            # 组装切片 + SSE 事件分发（段过滤/标记/选项/音频事件转发）
│  │  ├─ types.ts           # GameStore 类型契约（各切片共同依赖）
│  │  ├─ context.ts         # 模块级单例：set/get 与定时器（看门狗 / 自动前进）及清理
│  │  ├─ portrait.ts        # 立绘差分解析（两级回退）
│  │  └─ slices/            # nav / world / crafting / gameplay / tree / assets / creation / characters 八个动作切片
│  ├─ lib/parser.ts         # 文本协议纯函数（契约字符串；协议头/音频类型 re-export 自 shared/protocol.mjs 唯一真源，含【曲】【环境】【音效】）
│  ├─ lib/treeLayout.ts     # 剧情树分层布局纯函数（最长路径分层/抗环/贝塞尔边 + 缩放平移视口，剧情图与家谱两块画布共用，零依赖）
│  ├─ lib/genealogy.ts      # 世界线家谱布局纯函数（forkedFrom 森林分层/孤儿与环容错 + 键盘步进，零依赖）
│  ├─ lib/diff.ts           # 快照对比纯函数（行级 LCS diffLines + +N −M 摘要 diffStats，零依赖）
│  ├─ lib/audio.ts          # 音频管理器单例：BGM/环境音双通道交叉淡入、音效一次性、缺文件静默
│  ├─ lib/settings.ts       # 玩家设置纯逻辑（音量/静音/文本速度/自动前进）+ localStorage 逐键校验
│  ├─ lib/status.ts         # 引擎状态文案 → 玩家说法（「引擎演绎中…」→「故事展开中…」，表外原样透传）
│  ├─ lib/worlds.ts         # 显示名兜底：识别旧版写进世界线备注的裸 id 串，按「没有备注」处理（裸 worldId 不上玩家的屏）
│  ├─ lib/acp.ts            # HTTP/SSE 客户端 + 世界线/剧情树/快照/音频/角色面板（state.md 视图）接口
│  ├─ theme.ts              # 剧本主题（accent/accent2/motif）解析与 CSS 变量注入
│  ├─ components/ShellPage.tsx # 壳层页框（满幅主题底 + 宽栏 + 统一表头 + 可选宽屏右栏，各屏不再自写居中小窄栏）
│  └─ components/           # boot/title/worlds/protagonist/crafting/game 各屏 + assets 画廊 / creation 创作 / story-tree 剧情图 / settings 设置四个 overlay 屏、motifs/ 氛围层与 HUD（game/ 里 TopBar / DialogueBox / ChapterCard 等）
│     ├─ WorldsScreen.tsx   # 世界线屏：继续 / 新世界线 / 导入 .world.json / 每行 ⋯ 菜单（改名与备注 / 导出 / 两段确认删除）/ 列表·家谱视图（forkedFrom 森林，可缩放平移）
│     ├─ StoryTreeScreen.tsx # 剧情图屏：SVG 节点图（缩放平移）/ 顶部章节切换器 /> 40 节点降级列表 / 节点详情（宽屏右栏）/ 精确分叉 / 存档点回退与对比 / 一句话改树
│     ├─ EngineKeysSection.tsx # 「引擎与密钥」设置节（v1.10）：自备对话/出图服务两组表单 + 测试连接 + 立刻重启引擎（密钥只显掩码）
│     └─ SettingsScreen.tsx # 设置屏：主音量/静音/BGM/环境/音效 + 文本速度/自动前进 + 引擎与密钥
├─ .grok/
│  ├─ skills/bunkiten/SKILL.md  # 引擎全部真相：每轮协议/章节与剧情树/世界线/美术/音频/预载/导演层/状态纪律
│  └─ commands/             # /new-game /recap /presets /help
├─ presets/                 # 剧本数据，每个子目录一个 preset.md
│  └─ <presetId>/
│     ├─ assets/            # 该剧本的立绘/背景：<类型>-<名字>.jpg（封面同级 cover.jpg；资产随故事走）
│     └─ audio/             # 可选：<类型>-<名>.<ext>（曲/环境/音效 × mp3/ogg/m4a/wav/flac），没有就静默
├─ state/                   # 运行时进度：state/worlds/<worldId>/{state,summary,story-tree}.md + index.json 索引（顶层 { schema: 1, worlds }，旧裸数组首启升级；旧扁平布局首启由 server 迁入 main）
│  ├─ worlds/<id>/history/  # 逐轮快照 NNNN.json（append-only，回退与精确分叉的数据源；运行时生成，不入库）
│  ├─ worlds/<id>/logs/     # 回合原文日志 NNNN.json（v1.7，{seq,at,prompt,text}，append-only 排障面；不进世界线导出包）
│  ├─ trash/                # 回收站（v1.7）：删除的世界线/素材先整体挪进来，不自动清理、手工可找回（见 state/README.md）
│  └─ README.md             # 进度目录说明（唯一随包分发的文件，进度本身绝不打包）
├─ tests/
│  ├─ setup-react-act.mjs   # vitest 环境：React act() 兼容补丁
│  ├─ parser.test.ts        # 文本协议契约快照单测
│  ├─ crafting.test.ts      # 章节制作与创作/画廊编排单测
│  ├─ server.test.ts        # server 协议行与世界线/快照/音频/剧本导出包（v2 血缘）/角色面板/回合日志/剧本体检接口单测
│  ├─ treeLayout.test.ts    # 剧情树分层布局与缩放视口纯函数单测
│  ├─ genealogy.test.ts     # 世界线家谱布局与键盘步进纯函数单测
│  ├─ diff.test.ts          # 快照对比行级 LCS 纯函数单测
│  ├─ doctor.test.ts        # 剧本体检查纯函数单测（tmp 根造 preset）
│  ├─ preload.test.ts       # 立绘差分预热（清单每剧本一次/命中角色全差分/失败静默）
│  ├─ credentials.test.ts   # 引擎凭据纯函数（读写/0600/掩码/转 env/服务目录表/出图工具与探活，v1.10）
│  ├─ ui.test.tsx           # 组件测试（TopBar/世界线（含家谱视图）/剧情图（含快照对比）/设置/Creation/Assets/主题/重演/角色面板/标题屏剧本导出导入/剧本体检屏/同屏多立绘）
│  ├─ contract.test.ts      # 契约 lint（防漂移门禁：协议头/音频白名单/指令前缀真源断言（shared/protocol.mjs）/RULES 逐字副本/指令字符串/主题白名单/用例数下限/设置键；自身不计入合计下限）
│  ├─ integration/          # 假引擎集成层（假 ACP 引擎 + 真 acp-server 子进程，秒级）
│  │  ├─ harness.mjs        # 起全栈：临时 game root/HOME/PORT + path 垫片，收 SSE 事件与断言辅助
│  │  ├─ fake-engine.mjs    # 最小 ACP 假引擎（按脚本队列回 session/update，可制造段切换）
│  │  └─ *.test.ts          # 图片落盘与目录穿越防护 / 音频索引与逐轮快照 / 编译-落盘-事件管线 / 引擎凭据端点与 env 注入
│  ├─ e2e/smoke.spec.ts     # 真引擎 E2E 冒烟（helpers/stack.mjs 起全栈）
│  ├─ e2e-ui/               # 假引擎确定性 UI e2e（20 个 spec / 41 条用例，随 CI 跑）
│  └─ e2e-packaged/         # 打包态冒烟（_electron 起 dist:mac:dir 的 .app；opt-in，不进 CI）
├─ docs/
│  ├─ ARCHITECTURE.md       # 架构：ACP 契约、文本协议契约、资产与音频管线、打包与发布布局
│  ├─ adr/                  # 裁决记录：0001-0017（kebab-case 编号递增）
│  └─ releases/             # 发布说明：<tag>.md（release.yml 直接当作 GitHub Release notes）
├─ .github/workflows/
│  ├─ ci.yml                # CI：npm ci + build + typecheck:server + test:coverage（单测/集成/契约 lint + 覆盖率阈值，替代 npm test 步骤）+ 假引擎 UI e2e
│  └─ release.yml           # push v* tag：guard 校验 tag=v<package.json version> 并跑测试 → 双平台打包 → 建 Release
├─ build/
│  ├─ icon.png              # 应用图标（electron-builder 派生 .icns/.ico）
│  └─ entitlements.mac.plist # mac 硬化运行时/公证所需 entitlements
├─ .commandcode/agents/     # 协作者角色定义（docs-sync / contract-sync / verifier 等，非代码）
├─ QUICKSTART.md            # 玩家侧说明
├─ AGENTS.md                # AI 协作者导航
├─ CONTEXT.md               # 领域词表
├─ LICENSE                  # MIT
├─ .editorconfig            # 缩进/换行风格
├─ .gitignore               # 忽略构建产物、state/worlds/ 运行时进度与 .shell-session.json
├─ index.html               # vite 入口 HTML
├─ package.json             # 依赖与 scripts（版本号同步点）
├─ package-lock.json        # 依赖锁定（npm ci 用）
├─ playwright.config.ts     # e2e 配置（真引擎冒烟）
├─ electron-builder.yml     # 打包布局与目标
├─ tsconfig.json            # TS 配置（含 noUnusedLocals 等门禁）
├─ vitest.config.ts         # 单测环境（jsdom + setup-react-act）
└─ vite.config.ts           # dev proxy 与相对 base
```

`dist/`、`release/`、`test-results/`、`node_modules/` 是构建与运行时产物，不入库。

## Scripts

| 命令 | 作用 |
|---|---|
| `npm run dev` | 仅 vite 前端（浏览器调试，需另起 acp-server） |
| `npm run dev:electron` | vite + Electron 并行开发 |
| `npm run build` | `tsc -b && vite build`（类型检查 + 前端构建） |
| `npm run typecheck:server` | server/shared/scripts 的 checkJs 门禁（`tsconfig.server.json` 对 `server/**/*.mjs` + `shared/*.mjs` + `scripts/doctor.mjs` 开 strict 检查，类型全靠 JSDoc；CI 也会跑） |
| `npm test` | 单测 + 集成全量 497+ 例（含假引擎集成层，整体秒级；改协议字符串必须同步快照）。**用例数是下限口径**：唯一维护点是 `tests/contract.test.ts` 的 `CASE_GROUPS`/`CASE_TOTAL`——加用例不用改任何文档、删用例会在 lint 里红；同一文件另跑契约 lint（防漂移门禁：协议常量真源断言 + 双侧逐字比对，自身不计入合计下限） |
| `npm run test:coverage` | 同一批测试 + 覆盖率仪表（`@vitest/coverage-v8`，量 `src`/`server`/`shared`/`scripts` 四棵树，配置在 `vitest.config.ts`）：thresholds 是**防下滑线**（2026-09 基线 - 2pp：lines 74 / branches 64 / functions 77 / statements 72）——实际余量 1.56-1.87pp（基线未取整），不是硬指标；CI 用它替代 `npm test` 步骤（同一套测试避免双跑）并上传 HTML 报告 artifact |
| `npm run doctor` | 剧本体检查（作者侧工具，按需跑、不进 CI）：`node scripts/doctor.mjs` 校验 `presets/` 每个剧本的结构健康度——frontmatter 必填键与 id=目录名、theme 逐键回退预警、`# 主要角色` 与角色建议字段、封面、assets/audio 文件名契约、孤儿素材；输出 `[ok]`/`[warn]`/`[error]` 明细报告，**退出码非 0 当且仅当有 error**（warning 不影响——孤儿素材这类可解释项不拦你发布） |
| `npm run test:e2e` | 真引擎 E2E 冒烟（2 回合；约 6–12 分钟，视模型与网络。前提：本机登录 grok CLI 且能出网到 x.ai——代理环境开 TUN 或给命令带 `https_proxy`，直连被墙的表现是回合 600s 超时） |
| `npm run test:e2e:ui` | 假引擎确定性 UI e2e（`tests/e2e-ui/`，20 个 spec / 41 条用例，默认 chromium、不重试、整套约 4 分钟）：开局与同屏多立绘（两人同屏的双硬约束）/设置/**引擎与密钥（填 key → 掩码 → 刷新仍在 → 重启引擎 → 清空回落 + 明文泄漏哨兵）**/键盘/画廊/剧情图/世界线/回退/重掷/动效降级/焦点/角色面板/剧本导入导出/**章节循环（规划→制作中屏→开演→下一章）**/**创作模式（打磨→装配→新剧本入库 + 失败重试）**/**首启三态（未登录给「填自备密钥」入口 / 已配 key 直接开玩 / 连不上服务可重试）**/**音频可观测面（三行协议各自触发直服请求、元素在播与音量、换曲交叉淡入、静音归零）**/**耐久规模（60 幕长历史与 200 条快照、600 节点大树）**，进程由 `helpers/fake-stack.mjs` 编排（假引擎 + 真 acp-server + vite dev）；CI 也会跑（真引擎 e2e 仍只在本机） |
| `npm run test:e2e:packaged` | **打包态冒烟（opt-in，不进 CI）**：用 Playwright 的 `_electron` 起 `npm run dist:mac:dir` 产出的 `.app`，断言窗口开、标题屏渲染、`/app` 静态托管与 `resources/game` 资源可达——唯一覆盖「打包布局 + asar + 主进程 + 资源路径」的路径（dev 与 UI e2e 都绕开了它）。前置：先跑 `npm run dist:mac:dir`（产物缺失时该 spec 自动 skip）；平台相关，只在 mac 上跑 |
| `npm run dist:win` | build 后打 Windows x64 包（nsis + portable，不签名） |
| `npm run dist:mac` | build 后打 macOS 包（dmg + zip，arm64 + x64，不签名） |
| `npm run dist:mac:dir` | build 后只出 mac `.app` 目录（arm64，不签名、不压缩）：改打包配置时的快速预检，产物里没有 `app-update.yml` |

产物输出到 `release/`。

**打 tag 即发版**：push 一个 `v1.6.0` 这样的 tag（或手动触发）由 [.github/workflows/release.yml](.github/workflows/release.yml) 接手——先跑 `guard`（校验 tag 必须等于 `v<package.json version>`，并跑一遍 `npm test`），通过后 mac/win 各自打包（一律 `--publish never`），最后由 release job 合并校验和、建/更新 GitHub Release，并把 `docs/releases/<tag>.md` 当作发布说明。签名与公证是**条件化**的：仓库配了 `CSC_LINK` 等 secrets 才签名 + 公证，没有就显式走未签名路径（构建照样成功，只是 mac 包装上后不能自动更新）。

## 克隆即玩

```bash
git clone https://github.com/Jackela/bunkiten.git
cd bunkiten
npm install
npm run dev:electron
```

> 环境自洽：若你的 shell 导出了 `NODE_ENV=production`，本仓库的 `.npmrc` 会强制安装 devDependencies、`vitest.config.ts` 也会自钉 `NODE_ENV=test`——不需要额外处理。

三步进游戏：克隆 → `npm install` → `npm run dev:electron`。引擎有**两条入场**，任选一条：

1. **终端登录**（默认）：本机装好 grok CLI 后跑一次 `grok login`。
2. **自备密钥**（v1.10，不碰终端）：点开设置屏（或首启屏的「填自备密钥」）→「引擎与密钥」里填服务地址、密钥、模型名——对话与出图各一组，服务目录里预置了常见厂商（OpenAI / DeepSeek / 通义 / 智谱 / OpenRouter / Grok / Ollama…），也可以直接选「自定义」按任意 OpenAI 兼容服务填；改完点「立刻重启引擎」生效。

密钥存在**这台机器上**的 `~/.bunkiten/credentials.json`（目录 0700 / 文件 0600，明文——本机磁盘加密是你的第一道防线），**不进仓库、不进世界线、不进任何导出包**；界面上只显示掩码（`sk-…4f2a`），清空即回落到「沿用终端登录」。填错了/服务方拒绝：对话侧会连不上（设置屏的「测试连接」会告诉你原因），出图失败则静默略过——**剧情照常进行**。

## 文档导航

- 想玩 / 装给朋友：[QUICKSTART.md](QUICKSTART.md)
- 想改代码 / 写剧本 / 接手维护：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（文本协议契约一节必读）
- 想知道某个设计为什么这么做：[docs/adr/](docs/adr/)（0001–0017：剧情树骨架、全分支预生成、差分分层、表情由引擎驱动、缓存权威、世界线与分叉、剧情图、资产随故事走、逐轮快照与精确分叉、音频协议、打 tag 即发版、协议单一真源、server 模块化、删除进回收站、回合日志与质量守卫、剧本导出包、a11y 基线）
- 词表（章节/节点/世界线/分叉/差分…）：[CONTEXT.md](CONTEXT.md)
- AI 协作者从 [AGENTS.md](AGENTS.md) 进来

## 写新剧本

复制 `presets/` 下任意子目录改 `preset.md`，无需改代码。frontmatter 必填 `id` / `title`；`# 主要角色` 每人一节（含 `art_prompt`）；`# protagonist_card` 每行 `- 问题: 选项A / 选项B`。这个目录就是这个故事的全部：封面 `cover.jpg` 与运行时生成的立绘/背景（`assets/<类型>-<名字>.jpg`）都落在这里，拷走整个文件夹即可分享，删掉它也就删掉了这个故事的美术。想加声音就再建一个 `presets/<id>/audio/`，文件名按 `<类型>-<名>.<ext>` 放（类型是 `曲` / `环境` / `音效`，扩展名 `mp3` / `ogg` / `m4a` / `wav` / `flac`，例：`曲-雨夜.mp3`、`环境-旅店大堂.mp3`、`音效-门响.wav`）；引擎在场景切换时会发【曲】/【环境】/【音效】行点名播放，名对不上或没放文件就静默跳过——引擎绝不生成音频、也绝不在标记里写路径。也可以不改文件——标题屏右下「创作新剧本」用自然语言和引擎聊出一份新剧本（见 [QUICKSTART.md](QUICKSTART.md)）。完整字段表与消费方说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#修改指引)。

**分享剧本（v1.7）**：不用拷文件夹也能分享——标题屏右下角落簇里的「导出」（目标恒为当前中央那张卡）下载一个 `<剧本 id>.preset.json`（preset.md、全部立绘/背景/封面与音频都打在里面，导入单包上限 50MB）；对方点同一排的「导入剧本」选这个文件即可，剧本立刻进轮播。导入遇到重名会自动落成 `<id>-2`，不会覆盖你已有的剧本；包格式与安全规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「剧本导出包」一节。

**给剧本体检（v1.7）**：手写或创作模式装配出剧本后，跑 `npm run doctor` 当场检查结构健康度——frontmatter 必填键（id/title 缺失剧本进不了轮播；tagline/genre/rating 缺失只是标题屏栏位为空）与 id=目录名、theme 坏值回退预警（server 与客户端两层判定：`#rrggbb` 6 位 hex、motif 四母题闭集都会被查）、`# 主要角色` 角色节与建议字段（`art_prompt`/`agenda`）、封面（只认 `cover.jpg`，手放成 `.jpeg` 会被点名改名）、`assets/` 与 `audio/` 的文件名契约、孤儿素材（不被任何世界 state.md 引用、也不被任何 preset.md 提及的图）。每个剧本一行小结（`<id> ✓ N 项通过 · M 警告 · K 错误`）加 `[ok]`/`[warn]`/`[error]` 明细；**进程退出码非 0 当且仅当存在 error**（文件名非法、id/title 缺键这类会让剧本进不了轮播或素材永远 404 的问题），warning 只是提示、不影响发布。

## 内容与责任

本项目是**脚手架 / 引擎**：Electron 桌面壳 + React 前端 + ACP 驱动，仓库提供的是机制而非剧情。随附的 preset 剧本保持全年龄向。玩家接入自己的模型后生成的一切内容，由玩家自己与其所用模型负责——项目不做内容审查，也不对生成内容背书。

## 版本沿革

- **v0.1** —— 纯 skill 时代：SKILL.md + 终端 TUI，文件夹即游戏。
- **v0.4** —— ACP 图形壳：网页壳接 `grok agent stdio`，AI 立绘/背景（【图】标记协议）、导演层、pov、3 剧本。
- **v1.0** —— Electron 桌面产品：React 前端 + acp-server + Windows/macOS 安装包，交付从 zip 换成安装包；终端 TUI 入口（play.bat）与旧网页原型（shell/）已退役。
- **v1.1** —— 卡带式标题屏与主题系统：preset frontmatter `theme`（accent/accent2/motif 四母题）、motifs/ 氛围层与胶片颗粒/暗角全局美术；「制作中」确定性预载（待命开局 → 逐项 `美术：` 指令 → `开演。`）；点击对话框立即补全打字机。
- **v1.2** —— 章节制与剧情树：每章开演前 `规划：第 N 章。` 生成完整剧情树（`state/story-tree.md`；骨架制——自由输入即兴嫁接、不可达枝剪枝标记），并按规划回合输出的制作清单预生成本章全部分支美术（取代主要角色硬编码队列，立绘按 `/api/assets` 预过滤）；终章回合【章】标记自动衔接下一章制作，正片期间零美术等待。
- **v1.3** —— 差分立绘、画廊与创作模式：分层差分（规划回合定差分对象 2–3 人 × 表情三项 + 最高好感者服装变体；演出中【立绘】行随情绪切换，PortraitLayer 两级回退交叉淡入）；生成前缓存硬规则（image_gen 前查 `assets/` 同名文件，唯一例外=重绘）；素材画廊（AssetsScreen 分组/inUse/大图，单项 `美术：重绘`）；剧本封面（`presets/<id>/cover.jpg`，标题屏卡底 + 回退渐变）；创作模式（聊天打磨 → `装配。` 自动写 preset + 封面 + 立绘 → `【新剧本】<id>` 入轮播）；对话窗与历史从 `**行动**` 截断去重。单测 66 例。
- **v1.4** —— 最终迭代：差分表情切换真局验证、Esc 统一关闭链、长回合耗时显示、章节指示、创作消息排队补发与选项 chip 化、变体文件名前后端 sanitize 一致、e2e 引擎回合等待对齐 600s；测试套件补齐至 85 例（+server 协议行/+ui 组件）。
- **v1.5** —— 世界线与剧情图：进度从扁平 `state/*.md` 迁到 `state/worlds/<worldId>/{state,summary,story-tree}.md`（旧布局首启由 server 一次性迁入 `main`，另有 `index.json` 索引）；屏幕流变为 title → worlds → protagonist/crafting → game；会话契约新增开局 `世界：<worldId>。` 段与续演 `继续世界：<worldId>。`；世界线 API（`/api/worlds`、`/api/tree`）；分叉=只复制三文件并回退进度指针、**不推演**，切换世界线时引擎按 `fork.md` 静默回退 state/summary 再删除；剧情图屏（容错解析 SVG 节点图 + 归档药丸链 + 节点详情 + 在此分叉 + 一句话 `剧情：` 改树，`【树】` 协议行静默刷新）；缓存权威化（规划前读 `assets/` 只列新增，客户端归一化过滤且**变体必须一致**，修复基础立绘吞掉差分项的 bug）；MVP 期 TUI 遗留（`play.bat` / `install.ps1` / `START-HERE.txt`）已删除——本项目只有 Electron 桌面形态。测试 85 → 139 例。
- **v1.5.1** —— 资产随故事走，并更名 **bunkiten（分岐点）**：立绘/背景从全局 `assets/` 池改为按剧本归档 `presets/<剧本 id>/assets/<类型>-<名字>.jpg`（封面仍是同级 `presets/<id>/cover.jpg`），顶层 `assets/` 目录删除——每个 preset 自带 `art_style`，美术属于某个故事，故事 = 一个可分享/可删除的自包含文件夹；本次迁移按证据把 50 张存量素材归位（campus-summer 9 / rain-rejection 2 / rift-mark 33 / twilight-throne 6）。契约变化：`GET /api/assets` 需 `?preset=<id>`（缺失或非法 400，不再有全局池）、`/img` 白名单改为 `presets/<id>/assets/*.jpg` 与 `presets/<id>/cover.jpg`、画廊按当前剧本取数（`inUse` 只扫该剧本的世界）不再串味；服务端按提示词里的世界段嗅探出当前剧本 id 决定落盘目录，引擎侧新增「资产目录纪律」硬规则（素材一律写进当前剧本目录，绝不使用或新建全局 `assets/` 池）。**旧档兼容**（只读）：老 state/标记里的 `assets/<类型>-<名>.jpg` 只在当前剧本目录内探测一次——命中直服、未命中 404，不跨剧本扫描也不迁落（不把别的故事的同名素材显示进本故事）；落盘纪律：拿不到当前剧本 id 就不落盘，等【新剧本】或带 `&preset=` 的请求补落。命名同步：产品名 `Galgame` → `Bunkiten`，引擎 skill 目录 `.grok/skills/galgame/` → `.grok/skills/bunkiten/`。测试 139 → 171 例。
- **v1.6.0** —— 音频层、逐轮快照精确回退，以及发布工程化与一轮体验补课。**音频**：协议头从 6 项扩到 9 项（`PROTOCOL_HEADS` 新增【曲】【环境】【音效】），三行均为演出指令、不进正文——【曲】/【环境】切换 BGM 与环境音（客户端双通道交叉淡入、重复点同一首不重启），【音效】一次性（并发上限 4、带兜底超时释放槽位）；文件由作者放在 `presets/<剧本 id>/audio/`，命名 `<类型>-<名>.<ext>`（`mp3/ogg/m4a/wav/flac`），服务端新增 `GET /api/audio?preset=`（索引）与 `GET /audio?p=`（白名单 + 前缀校验直服，带长缓存）；文件缺失或剧本没有 `audio/` 目录一律**静默 no-op**，引擎侧新增第 6 句规则（音频纪律：绝不生成音频、绝不在标记里写路径）。**逐轮快照与精确回退**：正戏回合结束后把当前世界三文件全文存一份 `state/worlds/<worldId>/history/NNNN.json`（append-only、内容全等则跳过，含 `nodeId`/`chapterNo` 元信息），新增 `GET /api/history`（可选 `&seq=` 附带全文）、`POST /api/worlds {restore}`（先自动备份当前状态再覆盖目标快照，随后由客户端补发续档指令让引擎重新读档同步，**不是**重开场）、`{fork}` 带 seq 时改为**精确**分叉（以快照三文件建新世界，仍写 `fork.md` 让引擎只校准树；无快照才是旧的兼容路径）。**世界线管理**：`{update}` 支持显示名 `label`（≤60）与备注 `note`（≤200）、`GET /api/worlds/export` 导出单个世界线为 `<worldId>.world.json`（含三文件与全部快照）、`{import}` 导入（校验 `format`/`version`/id 合法性，重名自动落到 `<id>-2`、`-3`…）。**体验补课**：设置屏（顶栏齿轮：主音量/静音/BGM/环境/音效 + 文本速度四档 + 自动前进 0/3s/5s，存 `localStorage` 的 `bunkiten.settings.v1`，逐键校验兜底默认值）、键盘操作（1-9 与 Numpad 选选项、空格补全打字机）、世界线行内重命名与导出导入、画廊「选择模式」批量重绘（顺序队列）与批量删除（两段确认，封面不受理）、剧情图本章节点 > 40 默认降级为列表（可切回图形）且图形模式支持滚轮缩放/拖拽平移/双击复位。**工程与发布**：`.github/workflows/release.yml` 打 tag 即发版（guard 先校验 tag 等于 `v<package.json version>` 再跑 `npm test`，通过才双平台打包，最后合并 `SHA256SUMS.txt` 并建/更新 Release，`docs/releases/<tag>.md` 当发布说明）；签名与公证条件化（有 `CSC_LINK`/`APPLE_*` secrets 才签名 + 公证，否则未签名——未签名 mac 包不能自动更新）；打包态接入 electron-updater（开发态与 `--dir` 预检产物静默跳过）；新增 `dist:mac:dir` 快速预检。**测试**：新增假引擎集成层 `tests/integration/**`（假 ACP 引擎 + 真 acp-server 子进程，秒级覆盖图片管线、目录穿越防护、音频索引与逐轮快照），并把契约自检补进既有套件（协议头 9 项唯一真源 + 与 SKILL 一字不差的字符串快照）；前端 store 按动作拆成 `src/store/slices/*` 切片 + 模块级单例上下文，行为不变。测试 171 → 294 例。
- **v1.7.0** —— 后悔药补全、三个观察面、分享与作者工具、a11y 基线，以及一轮工程加固。**回退与重掷**：TopBar「重掷」撤销刚走完的一轮并自动重发同一句输入重新演绎（可连掷，本世界第一轮除外）；回退后历史只插一条分割线（旧幕不删），引擎重读档期间有「待重同步」徽章、失败可一键再同步。**新视图**：世界线屏「家谱」把 forkedFrom 血缘画成 SVG 森林（父线已删的孤儿带徽章、方向键走位）；剧情图节点详情「与上一快照对比」（剧情状态/前情摘要/剧情树三 tab 行级 diff，未变行折叠）；游戏屏「角色面板」抽屉实时读 state.md（好感度/表情徽章/秘密折叠/导演手记/Flags/伏笔，回合后自动刷新）。**分享与作者工具**：剧本导出包 `<id>.preset.json`（preset.md + 全部图 + 音频，二进制 base64；导入重名自动 `-2`、单包上限 50MB、文件名与内容全量校验）；`npm run doctor` 剧本体体检（七组检查，退出码非 0 当且仅当有 error）。**引擎侧可靠性**：回合原文日志 `logs/NNNN.json`（append-only、只写不读、不进导出包）；引擎漏写 `**行动**` 选项段时同一回合内自动追问一次补全（章末回合豁免）；引擎回 JSON-RPC error 时按失败回合传播（error 事件 + 409 + 不写快照）；快照列表与会话图读路径索引化。**无障碍基线**：跟随系统「减少动态效果」（位移瞬时化、交叉淡入保留、打字机整段显示，不加游戏内开关）、全局 `:focus-visible` 焦点环（键盘可见、鼠标不闪）、文字对比度三档 token（ink-body/ink-hint/ink-faint）。**工程**：协议常量收进 `shared/protocol.mjs` 唯一真源（ADR-0012）、server 拆成入口 + 10 模块（ADR-0013，外部 import 面不变）、删除一律进 `state/trash/` 回收站（ADR-0014，手工可找回、不自动清理）；测试安全网：假引擎确定性 UI e2e（12 个 spec，进 CI）、覆盖率阈值（`npm run test:coverage`）、server typecheck（`npm run typecheck:server`），契约 lint 升级为真源断言。测试 294 → 399 例。
- **v1.8.0** —— 版式收口、文案洗玩家话、立绘归位。**壳层版式系统**：worlds / protagonist / crafting / settings / assets 五屏共用 `ShellPage` 页框（满幅主题底 + 全仓唯一一处定宽 `max-w-[84rem]` + 统一表头与可选 ≥xl 右栏），壳层屏不再各屏自写居中窄栏；面板与遮罩收成 `bg-panel`/`bg-panel-strong`/`bg-scrim`/`bg-scrim-soft` token，`.shell-backdrop`（主题满幅洗色，压住亮底图保对比度）与 `.shell-panel`（面板三件套）两个类刻意写在级联层外，屏里随手写的渐变盖不掉；**字号阶梯**收成 12→28 八档（`text-micro` 12 只给角标、`text-meta` 13 是**可读下限**、`text-ui` 14、正文 16、对话框 17、`text-lead` 18、屏标题 20、主标题 28），全仓不再手写 `text-[Npx]`。**玩家文案清洗**：内部术语一律不上玩家的屏——回合/轮 → **幕**（幕号 = 快照序号）、快照 → **存档点**（剧情图标「存档点 · 第 N 幕」、对比入口写「与上一个存档点对比（第 N 幕 → 第 M 幕）」、历史分割线写「第 N 幕已重演」）、引擎口吻的状态串统一走 `lib/status.ts` 的 `playerStatus`（顶栏 / 制作中屏 / aria-live 播报三处共用），旧版 server 写进世界线备注的「分叉自 <id> @ <节点>」按「没有备注」处理——裸 worldId 与 `快照 #N` 都不再上屏。**画面修复与新增**：立绘改成真占版面的布局盒（grid 单格堆叠、行高显式 `1fr`；此前 shrink-to-fit 包裹层宽恒为 0，`max-w-full` 解析成 `max-width:0`，立绘从来没画出来过），配套 `.portrait-reserve` 在 ≥lg 给对话区预留 `min(40vw,420px)` 右侧安全带；章节**过场卡**（章号一变在正中亮一次「第 N 章」约 2.2s，挂在 App 常驻层，从 overlay 返回不重亮）；对话面板内联**自动/快进**（自动走 `resumeAutoAdvance`，与设置屏同一份自动前进设置）。**各屏形态**：标题屏加产品字标（bunkiten / 分岐点）与左下「继续上次」直通最近游玩的世界线；剧情图顶部**章节切换器**列出解析出的每一章（进度章标「当前」，归档章只留目录信息、点了直说），节点详情 ≥lg 住右侧 380px 栏、<lg 回到画布下方；家谱画布补**缩放平移**（滚轮指针锚点 / 拖拽 / 双击 / `±` 与「适应」/ `+ - 0`）且渲染宽度**只封上界**（单节点 ≈270px，小森林不再被等比撑成巨卡）；世界线行收成一个主行动**「继续」+ 一个 `⋯` 菜单**（改名/导出/删除，两段确认收在菜单内）。**工程**：前端构建按包拆包（react / motion / vendor，首屏不再吃一个整包）。测试 399 → 415 例。
- **v1.9.0** —— 把 v1.8.0 之后欠的账清完。**数据**：世界线索引升成 `{schema: 1, worlds}`（启动期 `migrateLegacyState` → `migrateWorldsSchema` 依序跑；裸数组升级、高版本只读不降级写回，ADR-0018），导出包 v2 带上 `forkedFrom`/`forkMd`（导入接受 1..2，v1 包照收并按当前形状补齐），修掉「导入回来的分叉线在家谱里变成根」。**舞台**：同屏多立绘上限 2（发言者高亮 + 名牌、非发言者压暗缩小，第三人按队首淘汰；让位两档实测面板 732px、两人最左缘 765px），背景 600ms 双层交叉淡入（reduce 下瞬时），立绘差分预热（每剧本拉一次清单、失败静默）。**无障碍**：浮层补齐 role=dialog/aria-modal/焦点陷阱/焦点归还，层开着时背景整块 `inert` + 滚动容器上锁；世界线 `⋯` 菜单迁 `@radix-ui/react-dropdown-menu`（不 portal，保住主题变量；↑↓/Home/End 与 typeahead 由原语接管）。**作者与内容**：剧本体检屏（`GET /api/presets/check?id=` 直出 doctor 判定）、世界线行封面缩略图（无封面退同尺寸占位块）、标题屏「素材」改为带当前中央卡（此前冷启动会打开空画廊）。**工程**：e2e 19 → 28 条（同屏 2 立绘几何/亮暗/名牌、体检屏、菜单键盘路径、家谱缩放、缩略图、reduce 换背景、预热不重复拉清单），spec 样板收进 `stack.ts`；性能实测结论「当前规模不需要虚拟化」（画廊 300 张真实素材与剧情图 600 节点同一时间地板，`/api/assets` 500 素材 + 30 世界 8.1ms），成本排序是图片解码/IO ≫ 布局与 DOM ≫ 纯函数。测试 415 → 447 例。
- **v1.10.0** —— 引擎凭据进 GUI：把「引擎用什么模型、用什么出图」从隐式的本机全局状态（`grok login` 会话、`~/.grok/config.toml`、环境变量）变成应用里可配置、可验证、可撤销的一等公民。**两条入场**：首启屏三态（登录态 / 已配自备 key 直接开玩 / 都没有则给「填自备密钥」与终端登录两个入口），设置屏新增「引擎与密钥」——对话与出图各一组（服务目录下拉 + 地址/密钥/模型，出图另有尺寸高级项），保存即时生效、「测试连接」真连一次服务、key 只显示掩码、清空回落登录态。**对话侧**直接走 grok CLI 的 BYOK 通道（`GROK_MODELS_BASE_URL` + `XAI_API_KEY` + `GROK_DEFAULT_MODEL`，第 0 步实证：agent mode 下真的生效、无需登录）；**图片侧**自建零依赖 MCP server（`bunkiten-media__generate_image`，经 `search_tool`/`use_tool` 调用、自己落盘到剧本 assets），覆盖制作清单/首现背景/重绘三条路径，SKILL 新增「出图工具优先」硬规则。**服务目录**（`shared/providers.mjs`）是唯一真源，一张表同时喂 GUI 下拉与服务端校验；凡说 OpenAI 兼容协议的服务开箱可用（长尾走「自定义」/ one-api / LiteLLM 网关），不引 provider SDK、server 树保持零依赖。**安全面**：明文只落 `~/.bunkiten/credentials.json`（0700/0600），HTTP 出口一律脱敏、不进日志/快照/回合日志/导出包；任何响应与浏览器 console 都没有明文（集成层与 e2e 各有哨兵）。测试 447 → 497 例（+31 单测 / +19 集成），UI e2e 38 → 41 条。
