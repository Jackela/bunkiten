# 引擎 skill 注入（spawn 带 `--plugin-dir <gameRoot>/.grok`，绕开文件夹信任门）

bunkiten 的引擎纪律（RULES 六句之外的整本 `SKILL.md`）活在项目级 skill `.grok/skills/bunkiten/` 里，但 grok CLI 把**项目级 skill 按「文件夹信任」门控**：未信托的目录，其 `.grok/skills` 与 `.grok/commands` 一律不进会话。两处 game root 都未信托——bunkiten 开发仓根（`git clone` 出来的 cwd）与打包态 `resources/game`（`app.asar.unpacked` 旁那份只读布局）——因此**每个真实会话开局，引擎都不知道自己被宣告有 bunkiten skill**。实证两路：其一，`grok inspect --json` 在未信托目录下回 `projectTrusted=false`，会话的 skills reminder 里没有任何项目级 skill；把该目录写进 `~/.grok/trusted_folders.toml` 后才出现（对照实验）。其二，Sept 18 的真实会话日志可证这条后果：会话第一条 skills reminder 不含 bunkiten，直到模型自己探索、读到 `.grok/skills/bunkiten/SKILL.md` 之后，才冒出第二条 reminder——**纪律的生效完全押在模型会不会主动去翻文件**，翻不到就整本规则缺席，且不同模型/不同回合的表现不可控。

决定：在 `server/acp.mjs` 的 spawn 参数里**固定带 `--plugin-dir <gameRoot>/.grok`**——`spawn("grok", ["agent", "--always-approve", "--plugin-dir", path.join(gameRoot, ".grok"), "stdio"], …)`。语义要点：`--plugin-dir` 是**session 级、always trusted** 的注入通道（官方给 Agent SDK 用的那一条），把给定目录当作插件/资源根挂进本次会话，**不看也不改全局信任文件**——正好绕开 `trusted_folders.toml` 这道门。gameRoot 是我们本来就传给 cwd 的同一个值，`<gameRoot>/.grok` 同时覆盖开发态（仓根 `.grok/`）与打包态（`resources/game/.grok/`），两处都不需要清单文件。

证据（零成本实验，untrusted 目录下对照）：两处位置在 spawn 加了这个 flag 后，会话开局的 skills reminder **都立刻包含 `bunkiten`（条目数 83，未加 flag 时 82）**；`session/new` 照常成功。**目录不存在或为空都无害**：`--plugin-dir` 指向不存在的路径时握手与回合照常，不报错（集成 harness 的临时 game root 就没有 `.grok`，本条靠它不会被误伤）。**兼容面宽**：该 flag 在 grok 1.0.34 与更老的 1.0.5 上都存在，不是某个新版本才有的通道；不用写版本探测或降级分支。

被否决：**其一，替玩家往全局 `~/.grok/trusted_folders.toml` 写信托条目**——要合写、要撤销，且**信任的是整个文件夹**（该目录里将来的 hooks/MCP 也一并被信任，比 `--plugin-dir` 的单点授予面更宽），还要求玩家的全局 CLI 落一份跨项目的状态，退出游戏后残留；**其二，什么都不做、继续依赖模型自发现**——这正是被实证打穿的那条路（Sept 18 会话），生效与否取决于模型的探索行为，不可复现、不可测试；**其三，把 bunkiten skill 复制/改造成一份独立插件包**——skill 的单一真源是仓内 `.grok/skills/bunkiten/SKILL.md`（契约 lint 与文档都钉着它），复制出第二份副本会漂，改一处忘一处，是典型的多源问题。

副作用与前提：`--plugin-dir` 会把给定目录当作 **always trusted**，因此该目录里的 **hooks 与 MCP 会被自动信任并生效**（这是该通道的既定语义，也是它绕开信任文件的代价）。我们满足前提：`<gameRoot>/.grok` 下**只有 `commands/` 与 `skills/` 两棵子树，不带 hooks、不带 MCP**——这条要在目录布局演进时守住（往 `.grok` 里加 hooks/MCP 等于对引擎无条件授予执行权）。

代价：其一，`server/acp.mjs` 的 spawn 参数面多一个 flag 与一段「为什么」注释，`acp.mjs` 的工厂文档补一句语义；其二，假引擎探针（`tests/integration/fake-engine.mjs`）多记一条 `argv`（`process.argv.slice(2)`，即 PATH 垫片原样透传的 grok 参数），`tests/integration/credentials.test.ts` 据此断言参数面含 `--plugin-dir` 且值 = `<gameRoot>/.grok`——改了 spawn 参数就会红；其三，新增一条「`.grok` 只放 commands/skills、不放 hooks/MCP」的隐性前提，靠本 ADR 与目录现状钉住，暂不引入 lint（当前没有第二处会误加）。
