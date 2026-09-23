# 多引擎后端：引擎可选（grok / Codex），Codex 走 ACP 适配器 `codex-acp` 随包分发

bunkiten 的叙事引擎此前只有一个后端：本机 grok CLI（`spawn("grok", ["agent", "--always-approve", "--plugin-dir", <gameRoot>/.grok, "stdio"])`，见 `server/acp.mjs`）。本 ADR 记录引入第二个后端（OpenAI Codex）的裁决：**接入点是 ACP（会话层），工具层继续用 MCP**——不是二选一，而是两层各司其职。Codex 侧由 `@agentclientprotocol/codex-acp` 承担 ACP 适配（它内部启动官方 Codex App Server 并把 ACP 请求翻译成 Codex 操作），游戏侧只认识一份 ACP 客户端（`server/acp.mjs`）。

**为什么是 ACP 而不是「让 Codex 当 MCP 服务端」**：`codex mcp-server` 把 Codex 暴露成一个被调用的工具，控制流反转——游戏要自己做 agent loop、自己维护「一轮对话」的语义，且 ACP 的会话/续档/流式/客户端能力注入全丢。**为什么不直接驱动 `codex app-server`**：那是给「写专属客户端」准备的（thread/turn/item 原语、WebSocket 面官方标注 experimental），而 `codex-acp` 就是生态在维护的这层适配（原 zed-industries 仓 2026-07 归档、开发汇入 `agentclientprotocol` 组织，包自带兼容的 `@openai/codex` 依赖）；再写一份专属客户端等于把这份维护成本抄回自己家。**为什么 MCP 层不变**：`session/new` 的 `mcpServers` 是 ACP 标准字段，codex-acp 支持客户端注入 stdio/HTTP MCP server——现有 `server/media-mcp.mjs`（`bunkiten-media__generate_image`）原样可用，出图管线零改动。

## 第 0 步实证（2026-09，`@agentclientprotocol/codex-acp@1.12.0` + `@openai/codex` 0.154，本机 ChatGPT 登录态，隔离 `CODEX_HOME`）

全部结论来自一次性探针（`spawn node <codex-acp>/dist/index.js`，抄 `server/acp.mjs` 的 newline JSON-RPC 传输；探针脚本跑完即弃）：

1. **握手能力位**（`initialize` 的 result）：`protocolVersion: 1`；`agentCapabilities.loadSession: true`（**支持 session/load**）、`sessionCapabilities: {resume,list,close,delete,fork,additionalDirectories,subagents}`、`mcpCapabilities: {acp:false,http:true,sse:false}`、`promptCapabilities: {embeddedContext,image}`；`authMethods` 在 `NO_BROWSER=1` 下只剩 `api-key`（ChatGPT 登录法在无浏览器环境被隐藏——我们用登录态复用，不靠它）。
2. **配置项在 `session/new` 的 result 里**（顶层键：`sessionId`、`models`、`modes`、`configOptions`）：`mode`（`read-only`｜`agent`｜`agent-full-access`）、`collaboration_mode`、`model`、`reasoning_effort`（`low`｜`medium`｜`high`｜`xhigh`｜`max`｜`ultra`）、`fast-mode`。**设置形状是裸字符串**：`session/set_config_option {sessionId, configId:"reasoning_effort", value:"low"}` 成功（返回更新后的全量 `configOptions`）；嵌套 `{value:{value}}` 形态无响应——**grok 要的恰是嵌套形态**（`server/acp-server.mjs` 的 `applyEffortValue` 现状），两引擎的取值形状必须分开。
3. **审批等价物**：`INITIAL_AGENT_MODE=agent-full-access` 生效（`mode` 的 currentValue 即 `agent-full-access`），等价 grok 的 `--always-approve`。
4. **RULES 渠道**：把 RULES 写进游戏管理的 `CODEX_HOME/config.toml` 的 `developer_instructions` 键——模型回复里如实带出了探针标记（`PROBE_RULES_BETA`），**确认进模型上下文**。grok 侧的 `_meta:{yoloMode,rules}` 对 Codex 无意义（Codex 不是 grok，`_meta` 被忽略）。
5. **AGENTS.md 注入与关闭杠杆**：默认下 workspace 的 `AGENTS.md` 会被读入（`thread/start` 的 `instructionSources` 列出该路径）——dev 态 cwd=仓根，**本仓自己的 `AGENTS.md`（协作说明）会进引擎上下文**，必须关掉。控制变量实验：`config.toml` 写 `project_doc_max_bytes = 0` → `instructionSources` 为空（同一 workspace、同一 `AGENTS.md` 文件），去掉该键 → 又列出该文件。**结论：`project_doc_max_bytes = 0` 是确定性关闭阀**（`CODEX_HOME` 隔离已挡掉玩家全局 `~/.codex/AGENTS.md`；`~/.agents/skills` 那类个人 skill 目录不在此列，见第 8 条）。
6. **SKILL 渠道 = Codex skills**：`config.toml` 的 `skills.config = [{path, enabled}]` 指向一个含 `SKILL.md` 的目录即可被目录发现；**但 SKILL.md 必须带 YAML frontmatter**——首轮探针缺 frontmatter 时 app-server 明报 `missing YAML frontmatter delimited by ---`，补上 `---\nname: …\ndescription: …\n---` 后 errors 清空、skill 进入目录。引擎可用 `/skills`（`available_commands_update` 里确认该命令存在）列举。
7. **客户端注入的 MCP server 透传**：`session/new` 带 `{name:"bunkiten-media", command, args, env}` 后，app-server 日志里出现原生 `"mcp_servers":{"bunkiten-media":{"command":…,"args":[…],"env":{"ELECTRON_RUN_AS_NODE":"1"}}}` ——**字段一一对应，media-mcp 不需要任何改造**。
8. **`session/load` 会重放整段历史**（与 ACP 规格一致）：12 条 `session/update`，其中 `user_message_chunk`×3、`agent_message_chunk`×4（正文原样重放）、`tool_call`/`tool_call_update`×2，外加 `available_commands_update` 与 `session_info_update`。**含义**：游戏 `boot()` 的 `session/load` 重放文本会流经入口的标记扫描（`ingestChunkText`）——与 grok 同款路径，落盘幂等（缓存命中即跳过），但实现时要确认无副作用（见「代价」）。`session/load` 的 result 同时带回 `models` 全量清单。
9. **权限请求（`session/request_permission`）在默认配置下不出现**：3 个真回合（含 `mode` 切 `read-only` 后要求往 workspace 外写文件、命令照常执行成功）**一次都没有**发权限请求——本轮未解释清楚（可能与审批策略仍为 full access、或 ACP 客户端未声明相关能力有关），但结论对本项目可用：**游戏用 `agent-full-access`，回合不会被审批卡住**，与 grok `--always-approve` 的体验一致。我们仍按 ACP 规格实现应答（`{outcome:{outcome:"selected", optionId}}`，优先 `allow_once`；规格明文允许客户端自动放行）作为兜底——**现状是遇到任何 Agent→Client 请求回 `-32601`，那是错的**（`server/acp.mjs`），Codex 下必须补。
10. **其余更新面**（实测 kinds）：`agent_message_chunk`、`tool_call`、`tool_call_update`（现有解析直接可用）、外加 `session_info_update`（含 thread 状态/title）、`usage_update`（token 用量）、`available_commands_update`（斜杠命令清单）。`session/prompt` 的 result 是 `{stopReason:"end_turn", usage:{…}}`——现有客户端不读 stopReason，可留。
11. **CODEX_HOME 产物**：`auth.json`、`config.toml`、`sessions/`（rollout）、`session_index.jsonl`、数个 sqlite（state/logs/memories/thread_history/goals/queue）、`skills/.system/*`（Codex 自带系统 skill 自动下发）、`logs/`、`cache/`。**都写在 `CODEX_HOME` 里**，不碰玩家 `~/.codex`。
12. **打包体量**：`@agentclientprotocol/codex-acp` 2.1MB（入口 `dist/index.js`，依赖 `@agentclientprotocol/sdk`/`diff`/`open`/`vscode-jsonrpc`/`zod`）+ `@openai/codex` 包装包 20KB + **平台二进制包 `@openai/codex-<platform>` 289MB**（darwin-arm64 实测）。裸 `node dist/index.js` 可跑（等价 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 的既有 spawn 配方），且它从自己的依赖树解析 codex 二进制，**不需要 `CODEX_PATH`**。
13. **`CODEX_HOME` 必须已存在**：把 `CODEX_HOME` 指到一个不存在的路径时，codex-acp 直接回 initialize 错误（`Error: CODEX_HOME points to "…", but that path does not exist`，code 1001）——不是「自己建」而是硬失败。所以游戏侧的顺序必须是**先 prepare（建目录）再 spawn**（`prepareSpawn` 就是这么排的）；顺带解释为什么 prepare 的第一件事是 `mkdirSync`。
14. **铺场闭包的自包含性**（打包态前提，实测）：把 `@agentclientprotocol/codex-acp` 与其依赖闭包（19 个包，其中 5 个非本平台的可选依赖被 npm 跳过）拷贝成 `node_modules` 布局后，`node <树>/@agentclientprotocol/codex-acp/dist/index.js` 能独立完成 initialize（`agentInfo.name` 与 `loadSession: true` 都在）——没有 `ERR_MODULE_NOT_FOUND`（v1.10 的 MCP 打包就栽在这类「文件在、兄弟不在」上，所以这条要单独实证）。
15. **spawn 失败会打穿进程**（真链路实测抓到的既有缺陷，v1.11 顺手补掉）：`spawn` 失败（PATH 里没有 codex-acp）时 Node 在子进程对象上发 `'error'`，而 `server/acp.mjs` 从来没有监听器——**未捕获异常直接让 server 退出**（Electron 主进程没有 uncaughtException 兜底，冒烟时表现为「应用闪退」）。修复：接住 `proc.on("error")` 与 `proc.stdin.on("error")`（EPIPE），把错误记在闭包里，`request()` 据此立刻失败、boot 落回既有的「boot failed」分支（HTTP 照起）。同批把开发态的入口解析从「PATH 名 `codex-acp`」改成「仓内 `node_modules/…/dist/index.js` 优先」（`npm i` 装好即可，不必进 PATH）——这两个问题只有真链路跑一次才看得见。
16. **真链路验收（一次真回合，engine=codex）**：临时 HOME（拷玩家真 `~/.codex/auth.json`）+ 临时 game root（`.grok`/`presets` 符号链接）+ `POST /prompt` 发真实开局指令（`开局：《裂痕纹章》。快速开局：… 跳过美术预载，直接开演。`）。结果：`**行动**` 选项段与【立绘】/【图】标记都出现在回复里，引擎按 SKILL 写出了完整的 `state/worlds/main/state.md`（`# 剧情状态` 的 preset/章节/场景、`# 主角`、`# 导演手记` 的张力/节拍/倒计时/NPC 场外进度/演出模式、`# 角色卡` 的好感度/art_prompt/art_file/agenda 全在）、`summary.md`，且 server 侧的 `logs/0001.json`（回合日志）与 `history/0001.json`（逐轮快照）都落了盘——**叙事纪律与既有管线在 Codex 后端上原样成立**（SKILL 是按 grok 的行为习惯写的，这是它不必按后端分叉的实证）。

## 决定

1. **引擎选择进 `~/.bunkiten/credentials.json` 的顶层 `engine` 字段**（`"grok"|"codex"`，缺省 grok、未知值回落 grok）：与既有原子写/0600/脱敏出口/「重启引擎生效」同一条通道，服务端 spawn 时读的就是它；旧凭据文件天然升级（读路径容忍未知键、无该键即 grok），`CREDENTIALS_VERSION` 不变。
2. **引擎 id/label 的唯一真源是新文件 `shared/engines.mjs`**（仿 `shared/providers.mjs`：`ENGINES`/`ENGINE_IDS`/`engineById` + 手写 `.d.mts`），GUI 只渲染、不自带第二份表；服务端校验用同一份。
3. **后端行为描述符收在 `server/engines.mjs`**（每引擎：`command()` spawn 参数、`buildEnv()`、`sessionMeta()`、`loginFile()`、`prepare()`、`imageResolver()`、`effortOption()`）；`server/acp.mjs` 只认描述符，不再出现品牌字面量。
4. **Codex 的 `CODEX_HOME` = `~/.bunkiten/codex`（0700，游戏管理）**：`prepare()` 负责建目录、把玩家 `~/.codex/auth.json`（更新时）拷成 `auth.json`（0600）、写游戏管理的 `config.toml`（`developer_instructions` = RULES、`project_doc_max_bytes = 0`、`skills.config` 指向落盘的 bunkiten skill）。**登录态的方向是单向的、玩家说了算**：终端 `codex login` 与 `grok login` 同款，游戏不驱动登录流程、不写玩家的文件；玩家重新登录（文件更新）就重拷，**玩家登出（文件消失）就删掉游戏侧副本**——否则会出现「启动屏说未登录、引擎却还能跑」的自相矛盾（v1.11 收尾补上这一半）。
5. **RULES → `developer_instructions`；SKILL → Codex skill（带 frontmatter）+ RULES 内绝对路径兜底**：SKILL 的单一真源仍是仓内 `.grok/skills/bunkiten/SKILL.md`（`prepare()` 在落盘时补 frontmatter，不生成第二份手写副本）；同时把那句「出图工具优先」改写成引擎无关（grok 先 `search_tool`/`use_tool`、Codex 直接调 `bunkiten-media__generate_image`），契约 lint 钉的工具名字符串保持逐字。
6. **推理档位走能力驱动**：读 `session/new` 返回的 `configOptions`，按 `configId` 找选项；grok 发嵌套 `{value:{value}}`，Codex 发裸字符串——由描述符的 `effortOption()` 决定；值不在选项集合里就跳过（静默，不阻断回合）。
7. **权限请求按 ACP 规格应答**（auto-allow：`allow_once` → `allow_always` → `cancelled`），其余未知请求保持 `-32601`。
8. **续档标记带引擎**：`.shell-session.json` 记 `{engine, sessionId}`，与当前引擎不一致就当没有（走 `session/new`）；无 `engine` 字段的旧文件按 grok 读。
9. **`codex-acp` 随 app 打包**（玩家零安装）：`electron-builder.yml` 的 `extraResources` 加 codex-acp 与其依赖树（保留 `node_modules` 布局，不进 asar），运行期用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` + 入口脚本 spawn（与 `media-mcp.mjs` 的既有配方同款）；**开发态吃仓内 `node_modules` 里那份同一个入口**（`npm i` 装好即可，不必进 PATH——早期写成 PATH 名时实测 ENOENT），测试/打包冒烟用 `BUNKITEN_CODEX_ACP`（ACP 适配器）与 `BUNKITEN_CODEX_BIN`（codex CLI，供一键登录）覆盖到垫片。
10. **首期只做 ChatGPT 登录复用，不做 Codex 的 BYOK**：Codex 自定义模型端点（`model_providers.<id>.wire_api`）**只支持 `responses`**，要求端点提供 `POST /v1/responses`——服务目录里绝大多数（chat/completions 形态的）服务商不适用；设置屏在 Codex 下把「自备密钥」按钮禁用并给一句玩家话说明。
11. **登录/登出是 GUI 的一等公民（v1.11 收尾）**：四个面（grok / codex / 对话自备 key / 出图自备 key）都要「状态看得见、按钮点得动」——启动屏未登录态一键登录、设置屏「引擎与密钥」顶部一条登录状态行（已登录 / 未登录 + 登录 / 两段确认的登出）。**登录态仍然是玩家的**：游戏不驱动登录流程、不存凭据、不改玩家的文件，按钮只是把 CLI 自己的 `login`/`logout` 叫起来（玩家在浏览器里完成；完成后客户端轮询 `/api/auth` 自动继续，5 分钟等不到给一句人话）。codex 侧用的是**随包**的 codex 二进制，所以「要不要为了登录去装一个 CLI」这个门槛被拿掉了；登出是**全局**动作（玩家终端里那份也一起清），因此 GUI 两段确认、服务端执行完顺手删掉游戏侧的登录副本。**被否决的备选**：自己实现 OAuth（要维护客户端 id、回调与刷新，且玩家为游戏单独授权一份，与「沿用终端登录」的取舍相反）；只给终端指引（对非技术玩家等于没降门槛——而这正是本轮要解决的问题）。

## 被否决

- **`codex mcp-server`（Codex 当工具）做叙事主通道**：控制流反转、会话语义自建、与 ACP 注入面（skill/审批/续档）不兼容。
- **直连 `codex app-server`**：等于自维护一份专属客户端；`codex-acp` 是生态在维护的同一件事，且随包分发的成本更低。
- **用玩家的真实 `~/.codex`（不做 `CODEX_HOME` 隔离）**：玩家全局 `AGENTS.md`/`config.toml`/历史会渗进游戏会话（本机实测玩家 `config.toml` 16KB、全局 `AGENTS.md` 7KB），且游戏会话会写进玩家的 Codex 历史；隔离 + auth 拷贝只多一步、收益确定。
- **把 SKILL 塞进 `AGENTS.md`**：41KB 超过 `project_doc_max_bytes` 默认 32KiB，且 AGENTS.md 是「项目指引」语义；Codex skills 是按需加载的目录面，语义与 grok 的 `--plugin-dir` 对齐。
- **`model_instructions_file` 替换内建 instructions**：会顶掉 Codex 自己的基础行为约定，风险大于收益（未采用，未实证）。
- **为 Codex 手写第二份 SKILL/规则副本**：真源唯一（`.grok/skills/bunkiten/SKILL.md`），副本必漂。

## 副作用与前提

- `~/.bunkiten/codex/` 多一棵游戏管理的 Codex home（含 sqlite 与 rollout），删除它等于登出+清历史；不进世界线导出包。
- 玩家个人 skill 目录（`~/.agents/skills/*`）**不受 `CODEX_HOME` 隔离**（实测仍被列入 skills 目录，`scope:"user"`）：Codex 会话会看到这些个人 skill 的名录——目前只影响目录体积/噪声，不注入正文；若将来要清干净，再看 Codex 是否提供 skill 根白名单。
- SKILL.md 落盘时补 frontmatter，是**派生**而非副本：真源仍是仓内文件，`prepare()` 每次 spawn 前重写（幂等）。
- 289MB 平台二进制随包：安装包体积显著增长；只在对应平台的构建产物里各带各的（CI mac/win 矩阵天然满足）。
- `.grok` 目录「只放 commands/skills」的前提继续成立（ADR-0021），Codex 侧无同类信任门。

## 代价

- `server/acp.mjs` 的 spawn/`_meta`/权限应答/档位形状/图片解析五处参数化，`server/credentials.mjs` 多一个顶层字段与它的校验，`src/components/EngineKeysSection.tsx` 多一个选择器与 Codex 下的降级说明；契约 lint 与文档同步表各多一组。
- `session/load` 的重放流会经过标记扫描（与 grok 同款）：需在实现时确认重放不会重复落盘/重复广播（落盘幂等已由缓存检查保证；broadcast 在 boot 时无订阅者）。
- Codex 的叙事遵从度（【图】【立绘】**行动** 等协议行）需要真机验收；SKILL 是按 grok 行为习惯写的，Codex 首轮真链路验收是发布门槛。
