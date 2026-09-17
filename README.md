<p align="center"><img src="build/icon.png" width="120" alt="bunkiten 图标：金色分岔线与分岔点的暖光"></p>

# bunkiten（分岐点）

<p align="center"><a href="https://github.com/Jackela/bunkiten/actions/workflows/ci.yml"><img src="https://github.com/Jackela/bunkiten/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a> <a href="https://github.com/Jackela/bunkiten/releases"><img src="https://img.shields.io/github/v/release/Jackela/bunkiten?label=release" alt="最新 release"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a> <img src="https://img.shields.io/badge/node-24-brightgreen.svg" alt="Node 24"></p>

> v1.6.0 —— 给单人定制的 LLM 互动 AVG（文字冒险 / 视觉小说）完整产品：Electron 桌面壳 + React 前端 + grok CLI（ACP）叙事引擎；本版补上**音频层**（【曲】/【环境】/【音效】三类协议行 + `presets/<id>/audio/`）、**逐轮快照与精确回退**（回到任意一轮或节点，分叉/回退/导出导入世界线），并把发布工程化（**打 tag 即发版**、条件化签名与公证、electron-updater）；另有体验补课：设置屏（音量/静音/文本速度/自动前进）、世界线重命名与导出导入、画廊批量重绘与删除、剧情图大图降级与缩放平移、键盘 1-9 选择与空格补全。

一个自包含的游戏：**引擎是 skill**（`.grok/skills/bunkiten/SKILL.md`），**剧本是数据**（`presets/`），**进度是文件**（`state/`），**美术按需生成**（image_gen，按「类型+名字」持久化到当前剧本的 `presets/<id>/assets/`）。AI 实时演绎剧情、画立绘背景，你做选择。每个剧本自带一套主题——配色与氛围图案从标题屏卡带一路贯穿到对话框。

## 一屏看懂

```
启动 → 检查 grok 登录 → 标题屏卡带轮播（← → 切换 · Enter 装载；右下角 素材画廊 / 创作新剧本）
     → 世界线屏（继续一条世界线读档续演 / 新世界线 / 行内重命名与备注 / 导出导入 .world.json / 两段确认删除；「家谱」视图把分叉血缘画成森林——谁从哪条线哪个节点分出来一目了然，⌫ = 父线已删）→ 新世界线才去捏主角（或快速开局）→ [制作中：第 1 章大纲 → 按清单逐张生成本章美术（含表情差分，可跳过） | 跳过直接开演] → 开演
每轮：正文（打字机，点对话框或按空格立即显示全文；角色立绘随情绪切换差分）→ 【行动】选项按钮（点按钮或按 1-9）/ 自由输入（含输入选项编号）→ 下一轮；不满意这一掷？右侧「重掷」撤销刚走完的这一轮并自动重发同一句输入重新演绎（本世界第一轮除外，可连掷；历史里只留一条分割线，旧幕不删）
声音：引擎每轮可发【曲】/【环境】/【音效】三行——BGM 与环境音各一条通道交叉淡入、音效一次性；文件由作者放在 presets/<id>/audio/，没放就静默
动效：跟随系统「减少动态效果」（prefers-reduced-motion，不新增设置开关——OS 级偏好是用户已做的选择）——位移类动效瞬时化、脉冲光标静止、打字机直接整段显示（淡入淡出保留，属无障碍推荐替代）
章间：本章收束 → 自动进下一章制作（大纲 → 本章全部分支美术）→ 开演，直至终局
画面：封面卡带 + 背景层 + 角色立绘（差分两级回退）+ 对话框 + 主题化配色/氛围层；顶栏左上角是 状态点/状态文字/章号/世界名，右侧竖排按钮轨从上到下 历史/角色（面板：好感度/表情/秘密（默认折叠防剧透）/导演手记，回合后自动刷新）/素材（画廊）/剧情图/重掷（有上一轮输入时）/重开/前情/换剧本/设置（齿轮：主音量与静音/BGM·环境·音效/文本速度/自动前进）/帮助
剧情图：节点带快照标注（#seq · 第 N 轮），可「回退到此节点」（覆盖该世界线三文件并让引擎重新读档续演）；本章节点 > 40 默认降级为列表（可切回图形）；图形模式滚轮缩放 · 拖拽平移 · 双击复位
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
├─ server/
│  └─ acp-server.mjs        # ACP 客户端 + HTTP/SSE + /img 图片服务 + /audio 音频直服 + 资产持久化 + 世界线/剧情树/逐轮快照接口（零依赖）
├─ shared/
│  ├─ protocol.mjs          # 协议常量唯一真源（v1.7）：PROTOCOL_HEADS 9 头 / AUDIO_* 音频白名单与直服正则 / DIRECTIVE_PREFIX_RE 指令前缀（pickEffort 与 isMainTurn 共用）
│  └─ protocol.d.mts        # 手写类型声明（tsc -b 经 .mjs→.d.mts 解析；运行时直接吃 .mjs）
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
│  ├─ lib/treeLayout.ts     # 剧情树分层布局纯函数（最长路径分层/抗环/贝塞尔边 + 缩放平移视口，零依赖）
│  ├─ lib/genealogy.ts      # 世界线家谱布局纯函数（forkedFrom 森林分层/孤儿与环容错 + 键盘步进，零依赖）
│  ├─ lib/diff.ts           # 快照对比纯函数（行级 LCS diffLines + +N −M 摘要 diffStats，零依赖）
│  ├─ lib/audio.ts          # 音频管理器单例：BGM/环境音双通道交叉淡入、音效一次性、缺文件静默
│  ├─ lib/settings.ts       # 玩家设置纯逻辑（音量/静音/文本速度/自动前进）+ localStorage 逐键校验
│  ├─ lib/acp.ts            # HTTP/SSE 客户端 + 世界线/剧情树/快照/音频/角色面板（state.md 视图）接口
│  ├─ theme.ts              # 剧本主题（accent/accent2/motif）解析与 CSS 变量注入
│  └─ components/           # boot/title/worlds/protagonist/crafting/game 各屏 + assets 画廊 / creation 创作 / story-tree 剧情图 / settings 设置四个 overlay 屏、motifs/ 氛围层与 HUD
│     ├─ WorldsScreen.tsx   # 世界线屏：继续 / 新世界线 / 行内重命名与备注 / 导出导入 .world.json / 两段确认删除 / 列表·家谱视图（forkedFrom 森林）
│     ├─ StoryTreeScreen.tsx # 剧情图屏：SVG 节点图（缩放平移）/> 40 节点降级列表 / 节点详情 / 精确分叉 / 快照回退与对比 / 一句话改树
│     └─ SettingsScreen.tsx # 设置屏：主音量/静音/BGM/环境/音效 + 文本速度/自动前进
├─ .grok/
│  ├─ skills/bunkiten/SKILL.md  # 引擎全部真相：每轮协议/章节与剧情树/世界线/美术/音频/预载/导演层/状态纪律
│  └─ commands/             # /new-game /recap /presets /help
├─ presets/                 # 剧本数据，每个子目录一个 preset.md
│  └─ <presetId>/
│     ├─ assets/            # 该剧本的立绘/背景：<类型>-<名字>.jpg（封面同级 cover.jpg；资产随故事走）
│     └─ audio/             # 可选：<类型>-<名>.<ext>（曲/环境/音效 × mp3/ogg/m4a/wav/flac），没有就静默
├─ state/                   # 运行时进度：state/worlds/<worldId>/{state,summary,story-tree}.md + index.json 索引（旧扁平布局首启由 server 迁入 main；删除即重置）
│  ├─ worlds/<id>/history/  # 逐轮快照 NNNN.json（append-only，回退与精确分叉的数据源；运行时生成，不入库）
│  └─ README.md             # 进度目录说明（唯一随包分发的文件，进度本身绝不打包）
├─ tests/
│  ├─ setup-react-act.mjs   # vitest 环境：React act() 兼容补丁
│  ├─ parser.test.ts        # 文本协议契约快照单测（65 例）
│  ├─ crafting.test.ts      # 章节制作与创作/画廊编排单测（52 例）
│  ├─ server.test.ts        # server 协议行与世界线/快照/音频/剧本导出包/角色面板接口单测（99 例）
│  ├─ treeLayout.test.ts    # 剧情树分层布局与缩放视口纯函数单测（7 例）
│  ├─ genealogy.test.ts     # 世界线家谱布局与键盘步进纯函数单测（8 例）
│  ├─ diff.test.ts          # 快照对比行级 LCS 纯函数单测（8 例）
│  ├─ doctor.test.ts        # 剧本体检查纯函数单测（tmp 根造 preset，12 例）
│  ├─ ui.test.tsx           # 组件测试（TopBar/世界线（含家谱视图）/剧情图（含快照对比）/设置/Creation/Assets/主题/重掷/角色面板/标题屏剧本导出导入，109 例）
│  ├─ contract.test.ts      # 契约 lint（防漂移门禁：协议头/音频白名单/指令前缀真源断言（shared/protocol.mjs）/RULES 逐字副本/指令字符串/主题白名单/用例数/设置键；自身不计入 381 口径）
│  ├─ integration/          # 假引擎集成层（假 ACP 引擎 + 真 acp-server 子进程，21 例、秒级）
│  │  ├─ harness.mjs        # 起全栈：临时 game root/HOME/PORT + path 垫片，收 SSE 事件与断言辅助
│  │  ├─ fake-engine.mjs    # 最小 ACP 假引擎（按脚本队列回 session/update，可制造段切换）
│  │  └─ *.test.ts          # 图片落盘与目录穿越防护 / 音频索引与逐轮快照 / 编译-落盘-事件管线
│  ├─ helpers/stack.mjs     # e2e 全栈编排（起 acp-server + vite）
│  └─ e2e/smoke.spec.ts     # 真引擎 E2E 冒烟（helpers/stack.mjs 起全栈）
├─ docs/
│  ├─ ARCHITECTURE.md       # 架构：ACP 契约、文本协议契约、资产与音频管线、打包与发布布局
│  ├─ adr/                  # 裁决记录：0001-0008（kebab-case 编号递增）
│  └─ releases/             # 发布说明：<tag>.md（release.yml 直接当作 GitHub Release notes）
├─ .github/workflows/
│  ├─ ci.yml                # CI：npm ci + npm test + npm run build
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
| `npm test` | 单测 + 集成全量 381 例：parser 65 + server 99 + crafting 52 + treeLayout 7 + genealogy 8 + diff 8 + doctor 12 + ui 109 + integration 21（含假引擎集成层，整体秒级；改协议字符串必须同步快照）；另跑契约 lint `tests/contract.test.ts`（防漂移门禁：协议常量真源断言 + 双侧逐字比对，**不计入这 381**） |
| `npm run doctor` | 剧本体检查（作者侧工具，按需跑、不进 CI）：`node scripts/doctor.mjs` 校验 `presets/` 每个剧本的结构健康度——frontmatter 必填键与 id=目录名、theme 逐键回退预警、`# 主要角色` 与角色建议字段、封面、assets/audio 文件名契约、孤儿素材；输出 `[ok]`/`[warn]`/`[error]` 明细报告，**退出码非 0 当且仅当有 error**（warning 不影响——孤儿素材这类可解释项不拦你发布） |
| `npm run test:e2e` | 真引擎 E2E 冒烟（约 6 分钟，2 回合） |
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

三步进游戏：克隆 → `npm install` → `npm run dev:electron`。需要本机已登录 grok CLI（`grok login`）。

## 文档导航

- 想玩 / 装给朋友：[QUICKSTART.md](QUICKSTART.md)
- 想改代码 / 写剧本 / 接手维护：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（文本协议契约一节必读）
- 想知道某个设计为什么这么做：[docs/adr/](docs/adr/)（0001–0008：剧情树骨架、全分支预生成、差分分层、表情由引擎驱动、缓存权威、世界线与分叉、剧情图、资产随故事走）
- 词表（章节/节点/世界线/分叉/差分…）：[CONTEXT.md](CONTEXT.md)
- AI 协作者从 [AGENTS.md](AGENTS.md) 进来

## 写新剧本

复制 `presets/` 下任意子目录改 `preset.md`，无需改代码。frontmatter 必填 `id` / `title`；`# 主要角色` 每人一节（含 `art_prompt`）；`# protagonist_card` 每行 `- 问题: 选项A / 选项B`。这个目录就是这个故事的全部：封面 `cover.jpg` 与运行时生成的立绘/背景（`assets/<类型>-<名字>.jpg`）都落在这里，拷走整个文件夹即可分享，删掉它也就删掉了这个故事的美术。想加声音就再建一个 `presets/<id>/audio/`，文件名按 `<类型>-<名>.<ext>` 放（类型是 `曲` / `环境` / `音效`，扩展名 `mp3` / `ogg` / `m4a` / `wav` / `flac`，例：`曲-雨夜.mp3`、`环境-旅店大堂.mp3`、`音效-门响.wav`）；引擎在场景切换时会发【曲】/【环境】/【音效】行点名播放，名对不上或没放文件就静默跳过——引擎绝不生成音频、也绝不在标记里写路径。也可以不改文件——标题屏右下「创作新剧本」用自然语言和引擎聊出一份新剧本（见 [QUICKSTART.md](QUICKSTART.md)）。完整字段表与消费方说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#修改指引)。

**分享剧本（v1.7）**：不用拷文件夹也能分享——标题屏当前卡带右上角「导出」下载一个 `<剧本 id>.preset.json`（preset.md、全部立绘/背景/封面与音频都打在里面，导入单包上限 50MB）；对方在标题屏右下角「导入剧本」选这个文件即可，剧本立刻进轮播。导入遇到重名会自动落成 `<id>-2`，不会覆盖你已有的剧本；包格式与安全规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「剧本导出包」一节。

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
