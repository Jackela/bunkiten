<p align="center"><img src="build/icon.png" width="120" alt="bunkiten 图标：金色分岔线与分岔点的暖光"></p>

# bunkiten（分岐点）

> v1.5.1 —— 给单人定制的 LLM 互动 AVG（文字冒险 / 视觉小说）完整产品：Electron 桌面壳 + React 前端 + grok CLI（ACP）叙事引擎；本版让资产随故事走（立绘/背景落进当前剧本的 `presets/<id>/assets/`）并兼容旧档资产路径，项目更名为 bunkiten（分岐点）。

一个自包含的游戏：**引擎是 skill**（`.grok/skills/bunkiten/SKILL.md`），**剧本是数据**（`presets/`），**进度是文件**（`state/`），**美术按需生成**（image_gen，按「类型+名字」持久化到当前剧本的 `presets/<id>/assets/`）。AI 实时演绎剧情、画立绘背景，你做选择。每个剧本自带一套主题——配色与氛围图案从标题屏卡带一路贯穿到对话框。

## 一屏看懂

```
启动 → 检查 grok 登录 → 标题屏卡带轮播（← → 切换 · Enter 装载；右下角 素材画廊 / 创作新剧本）
     → 世界线屏（继续一条世界线读档续演 / 新世界线 / 两段确认删除）→ 新世界线才去捏主角（或快速开局）→ [制作中：第 1 章大纲 → 按清单逐张生成本章美术（含表情差分，可跳过） | 跳过直接开演] → 开演
每轮：正文（打字机，点对话框立即显示全文；角色立绘随情绪切换差分）→ 【行动】选项按钮 / 自由输入（含输入选项编号）→ 下一轮
章间：本章收束 → 自动进下一章制作（大纲 → 本章全部分支美术）→ 开演，直至终局
画面：封面卡带 + 背景层 + 角色立绘（差分两级回退）+ 对话框 + 主题化配色/氛围层；顶栏左上角是 状态点/状态文字/章号/世界名，右侧竖排按钮轨从上到下 历史/素材（画廊）/剧情图/重开/前情/换剧本/帮助
```

幕后一句话：`grok agent --always-approve stdio`（ACP 协议）做引擎，客户端只渲染正文通道（思考流与工具旁白被架构性过滤）；每会话注入 rules 让引擎输出文本选项，前端解析成按钮；`【图】立绘|角色|images/N.jpg` 标记驱动画面，`【立绘】角色|变体` 行随情绪切换差分立绘；回合推理档默认 medium 提速（`EFFORT` 可调）。

## 两种运行方式

交付形态只有一种：Electron 桌面应用（MVP 期的终端 TUI 已删除）。下表两列是同一种形态的两种跑法。

> 不想从源码跑？直接下载安装包：[Releases](https://github.com/Jackela/bunkiten/releases)（未签名：macOS 首次打开需右键「打开」，Windows 会有 SmartScreen 提示）。

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
│  └─ main.js               # Electron 主进程：GAME_ROOT、PATH 补齐、启动 acp-server、开窗口
├─ server/
│  └─ acp-server.mjs        # ACP 客户端 + HTTP/SSE + /img 图片服务 + 资产持久化 + 世界线/剧情树接口（零依赖）
├─ src/                     # React 前端
│  ├─ App.tsx               # 屏幕切换 + SSE 接入 + 主题变量注入
│  ├─ store/game.ts         # 全局状态机（段过滤/标记/选项/章节制作流水线/世界线与剧情图）
│  ├─ lib/parser.ts         # 文本协议纯函数（契约字符串所在）
│  ├─ lib/treeLayout.ts     # 剧情树分层布局纯函数（最长路径分层/抗环/贝塞尔边，零依赖）
│  ├─ lib/acp.ts            # HTTP/SSE 客户端 + 世界线/剧情树接口
│  ├─ theme.ts              # 剧本主题（accent/accent2/motif）解析与 CSS 变量注入
│  └─ components/           # boot/title/worlds/protagonist/crafting/game 各屏 + assets 画廊 / creation 创作 / story-tree 剧情图三个 overlay 屏、motifs/ 氛围层与 HUD
│     ├─ WorldsScreen.tsx   # 世界线屏：继续 / 新世界线 / 两段确认删除
│     └─ StoryTreeScreen.tsx # 剧情图屏：SVG 节点图 / 节点详情 / 在此分叉 / 一句话改树
├─ .grok/
│  ├─ skills/bunkiten/SKILL.md  # 引擎全部真相：每轮协议/章节与剧情树/世界线/美术/预载/导演层/状态纪律
│  └─ commands/             # /new-game /recap /presets /help
├─ presets/                 # 剧本数据，每个子目录一个 preset.md
│  └─ <presetId>/assets/    # 该剧本的立绘/背景：<类型>-<名字>.jpg（封面同级 cover.jpg；资产随故事走）
├─ state/                   # 运行时进度：state/worlds/<worldId>/{state,summary,story-tree}.md + index.json 索引（旧扁平布局首启由 server 迁入 main；删除即重置）
│  └─ README.md             # 进度目录说明（唯一随包分发的文件，进度本身绝不打包）
├─ tests/
│  ├─ setup-react-act.mjs   # vitest 环境：React act() 兼容补丁
│  ├─ parser.test.ts        # 文本协议契约快照单测（59 例）
│  ├─ crafting.test.ts      # 章节制作与创作/画廊编排单测（30 例）
│  ├─ server.test.ts        # server 协议行与世界线接口单测（34 例）
│  ├─ treeLayout.test.ts    # 剧情树分层布局纯函数单测（7 例）
│  ├─ ui.test.tsx           # 组件测试（TopBar/世界线/剧情图/Creation/Assets，22 例）
│  ├─ helpers/stack.mjs     # e2e 全栈编排（起 acp-server + vite）
│  └─ e2e/smoke.spec.ts     # 真引擎 E2E 冒烟（helpers/stack.mjs 起全栈）
├─ docs/
│  ├─ ARCHITECTURE.md       # 架构：ACP 契约、文本协议契约、资产管线、打包布局
│  └─ adr/                  # 裁决记录：0001-0008（kebab-case 编号递增）
├─ .github/workflows/ci.yml # CI：npm ci + npm test + npm run build
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
| `npm test` | 单测全量 171 例：parser 59 + crafting 31 + server 51 + treeLayout 7 + ui 23（改协议字符串必须同步快照） |
| `npm run test:e2e` | 真引擎 E2E 冒烟（约 6 分钟，2 回合） |
| `npm run dist:win` | build 后打 Windows x64 包（nsis + portable，不签名） |
| `npm run dist:mac` | build 后打 macOS 包（dmg + zip，arm64 + x64，不签名） |

产物输出到 `release/`。

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

复制 `presets/` 下任意子目录改 `preset.md`，无需改代码。frontmatter 必填 `id` / `title`；`# 主要角色` 每人一节（含 `art_prompt`）；`# protagonist_card` 每行 `- 问题: 选项A / 选项B`。这个目录就是这个故事的全部：封面 `cover.jpg` 与运行时生成的立绘/背景（`assets/<类型>-<名字>.jpg`）都落在这里，拷走整个文件夹即可分享，删掉它也就删掉了这个故事的美术。也可以不改文件——标题屏右下「创作新剧本」用自然语言和引擎聊出一份新剧本（见 [QUICKSTART.md](QUICKSTART.md)）。完整字段表与消费方说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#修改指引)。

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
