// 引擎后端的**行为描述符**（v1.11，docs/adr/0022）：每个后端一份纯函数表；server/acp.mjs 只认描述符、
// 不出现品牌字面量。展示面（id/名字/说明）在 shared/engines.mjs——两份的关系是「同 id、不同面」，
// 契约 lint 钉住 id 集合一致。
//
// 第 0 步实证（docs/adr/0022「第 0 步实证」12 条）是下列每个字面量的依据：
//   · codex-acp 的 initialize 能力位含 `loadSession`；配置项在 `session/new` 的 result.configOptions 里，
//     含 `reasoning_effort`（low…ultra）与 `mode`；设置形状是**裸字符串**（grok 要的是 {value:{value}} 嵌套）；
//   · RULES 走 Codex 的 `developer_instructions`（实测模型回复带出注入标记）；
//   · `project_doc_max_bytes = 0` 关闭 AGENTS.md 注入（实测 `instructionSources` 由 [AGENTS.md] 变 []）——
//     dev 态 cwd=仓根，不关的话本仓自己的 AGENTS.md 会进引擎上下文；
//   · SKILL.md（仓内那份已带 frontmatter）被 `skills.config` 指向的目录发现即进 skill 目录；
//   · `session/new` 的 `mcpServers` 被透传成 app-server 原生 `mcp_servers`（media-mcp 零改造）；
//   · `INITIAL_AGENT_MODE=agent-full-access` ≈ grok 的 `--always-approve`（3 个真回合无审批打断）。
//
// 文件纪律：本模块零第三方依赖，只用 node 内置 + shared/ + credentials.mjs（credentials 不反向 import 本模块，
// 无环）；所有文件写入都幂等、失败不抛（读路径铁律：引擎起不来不该让 server 挂掉）。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { CREDENTIALS_DIRNAME, credentialsToEnv } from "./credentials.mjs";

/** Codex 的游戏管理 home 目录名（`~/.bunkiten/codex`；隔离玩家自己的 `~/.codex`） */
export const CODEX_HOME_DIRNAME = "codex";

/** 落盘 skill 的目录名（与 `.grok/skills/` 侧同名，引擎名同源） */
export const CODEX_SKILL_NAME = "bunkiten";

/** codex-acp 的 npm 包名分段（打包态在 resources 下的路径由它拼出） */
const CODEX_ACP_PACKAGE = ["@agentclientprotocol", "codex-acp"];

/** 随包 codex CLI 的 npm 包名分段（GUI 的「登录 Codex」用它，不必要求玩家另装 CLI） */
const CODEX_CLI_PACKAGE = ["@openai", "codex"];

/**
 * @typedef {import("./credentials.mjs").Credentials} Credentials
 *
 * 一次 spawn 的完整描述（cmd/args/env 三件套；env 与 process.env 合并时**我们的值优先**）。
 * @typedef {Object} SpawnPlan
 * @property {string} cmd 可执行文件（PATH 名 / 绝对路径 / process.execPath；Windows 的 .cmd/.bat 会被
 *   windowsSafeSpawn 换成「整条命令行 + shell:true」——见该函数）
 * @property {string[]} args 参数
 * @property {Record<string, string>} env 注入子进程的 env
 * @property {boolean} [shell] 是否经平台 shell 起（Windows 的 .cmd/.bat 必须；其余情形不设）
 *
 * @typedef {Object} SpawnContext
 * @property {Credentials} creds 当前凭据（引擎选择 + 各组配置）
 * @property {string} home 用户主目录（os.homedir()；单测/集成传临时 HOME）
 * @property {string} gameRoot 引擎 cwd（开发态仓根 / 打包态 resources/game）
 *
 * @typedef {Object} EngineDescriptor
 * @property {string} id 引擎 id（与 shared/engines.mjs 同键）
 * @property {(ctx: SpawnContext) => SpawnPlan} spawn spawn 三件套（含各引擎自己的 env）
 * @property {(rules: string, ctx: {home: string, gameRoot: string}) => string} rulesFor 注入的规则原文（grok 原样；codex 追加 skill 指引）
 * @property {(ctx: {rules: string}) => Record<string, unknown> | null} sessionMeta 会话级扩展参数（grok 的 `_meta`；codex 为 null）
 * @property {(home: string) => string} loginFile 登录态探测文件（玩家侧的登录产物）
 * @property {(ctx: {home: string, gameRoot: string, rules: string}) => void} prepare spawn 前的幂等准备（codex：建 home/同步登录态/写配置/落 skill；失败静默）
 * @property {(ctx: {home: string, gameRoot: string}) => string | null} sessionImagesRoot 引擎自产图的会话根目录（codex 无 → null，出图主路径是 media-mcp）
 * @property {(effort: string) => {configId: string, value: unknown} | null} effortOption 推理档位的下发形状（两引擎不同）
 * @property {(action: "login"|"logout", ctx: {home: string}) => {cmd: string, args: string[], env: Record<string, string>, shell?: boolean, unset?: string[]} | null} authCmd
 *   登录/登出命令（GUI 的按钮用；null = 该引擎没有可用入口）。**在玩家自己的 home 里跑 CLI 自己的登录流程**——
 *   游戏不碰凭据、不存任何东西（登出是全局的：会把玩家终端里那份一起清掉）
 * @property {(ctx: {home: string}) => boolean} authAvailable 登录入口是否可用（GUI 据此禁用按钮并说明，而不是点了才报错）
 */

/** Codex 的游戏管理 home：`~/.bunkiten/codex`（与 credentials.json 同目录树下） @param {string} home 用户主目录 @returns {string} */
export function codexHome(home) {
  return path.join(home, CREDENTIALS_DIRNAME, CODEX_HOME_DIRNAME);
}

/**
 * Windows 上 `.cmd`/`.bat` 不能直接 spawn：Node 自 18.20 / 20.12.2 / 21.7.3 起（CVE-2024-27980 的加固）
 * 对这类文件在 `shell: false` 下直接抛 `EINVAL`——而 npm 全局安装的 grok 正是 `grok.cmd`
 *（`resolveOnPath` 如实取到它，见该函数注释）。这里统一改成经 cmd.exe 起：因为 `shell: true` 时
 * Node 是把 `cmd + args` 用空格**直接拼**成一条命令行（`windowsVerbatimArguments`，不做逐参引号），
 * 所以这里自己拼整条命令行、把可执行文件与含空格的参数都加上引号（`cmd /d /s /c "…"` 的外层引号由
 * Node 加，`/s` 会剥掉它，内层引号原样交给 cmd 解析）。`%`/`!` 这类 cmd 会展开的字符在路径里极罕见——
 * 真遇到也只是回到「起不来」，不会比现状差（现状是必然 EINVAL）。
 * 其余情形（`.exe`、非 Windows）**逐字返回**，产品路径一字不变。
 * @param {SpawnPlan} plan spawn 三件套
 * @returns {SpawnPlan} 可能被换成「命令行 + shell:true」的三件套
 */
export function windowsSafeSpawn(plan) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(plan.cmd)) return plan;
  const quote = (/** @type {unknown} */ s) => {
    const t = String(s);
    return /[\s"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return { ...plan, cmd: [quote(plan.cmd), ...plan.args.map(quote)].join(" "), args: [], shell: true };
}

/**
 * 找随包依赖树里的一个文件（打包态 `resources/codex-acp/node_modules/<segments>`；纯 node 环境无
 * `process.resourcesPath` → null）。
 * @param {...string} segments 包名分段与包内路径
 * @returns {string | null} 存在的绝对路径；没有时 null
 */
function packagedDepFile(...segments) {
  // process.resourcesPath 是 Electron 注入的（node 类型里没有），纯 node 下为 undefined → null
  const resources = /** @type {string | undefined} */ (/** @type {any} */ (process).resourcesPath);
  if (!resources) return null;
  try {
    const file = path.join(resources, "codex-acp", "node_modules", ...segments);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * 找仓内 `node_modules` 里的同一个文件（相对本模块定位——打包态本模块在 app.asar.unpacked/server/ 下，
 * 那里没有 node_modules，自然 null，走 resources 那条）。
 * @param {...string} segments 包名分段与包内路径
 * @returns {string | null} 存在的绝对路径；没有时 null
 */
function devDepFile(...segments) {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ...segments);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * codex-acp 的入口命令解析（三级：显式覆盖 → 打包态 resources → 仓内 node_modules → PATH 名）。
 *
 * 打包态与开发态都用 `process.execPath` 跑 JS 入口（打包态还要 `ELECTRON_RUN_AS_NODE=1`）——
 * 与 media-mcp 的既有 spawn 配方同款（见 server/media-mcp.mjs 的 mediaMcpServers）。
 * **开发态直接吃仓内 node_modules 里那份**（`npm i` 装好即可，不必进 PATH——实测 PATH 里没有
 * codex-acp 时旧写法会 ENOENT）；PATH 名只作最后兜底（装了全局的人）。集成测试用
 * BUNKITEN_CODEX_ACP 指到假引擎垫片（与 `grok` 的 PATH 垫片同款约定）。
 * @returns {{cmd: string, args: string[], electronAsNode: boolean}} 入口三件套
 */
function codexAcpCommand() {
  const override = String(process.env.BUNKITEN_CODEX_ACP || "").trim();
  if (override) return { cmd: override, args: [], electronAsNode: false };
  const packaged = packagedDepFile(...CODEX_ACP_PACKAGE, "dist", "index.js");
  if (packaged) return { cmd: process.execPath, args: [packaged], electronAsNode: true };
  const dev = devDepFile(...CODEX_ACP_PACKAGE, "dist", "index.js");
  if (dev) return { cmd: process.execPath, args: [dev], electronAsNode: false };
  return { cmd: "codex-acp", args: [], electronAsNode: false };
}

/**
 * 随包 codex **CLI** 的入口（`@openai/codex/bin/codex.js`，npm 的 bin 包装：内部 exec 平台二进制）。
 * 与 codex-acp 同款三级解析（测试覆盖 `BUNKITEN_CODEX_BIN` → 打包态 → 仓内）；都没有时 null——
 * GUI 据此把「登录 Codex」按钮禁掉并说明，而不是给一个点了会报错的按钮。
 * @returns {{cmd: string, args: string[]} | null} 命令；没有可用入口时 null
 */
function codexCliCommand() {
  const override = String(process.env.BUNKITEN_CODEX_BIN || "").trim();
  if (override) return { cmd: override, args: [] };
  const packaged = packagedDepFile(...CODEX_CLI_PACKAGE, "bin", "codex.js");
  if (packaged) return { cmd: process.execPath, args: [packaged] };
  const dev = devDepFile(...CODEX_CLI_PACKAGE, "bin", "codex.js");
  if (dev) return { cmd: process.execPath, args: [dev] };
  return null;
}

/**
 * 登录态复用：玩家 `~/.codex/auth.json` → 游戏 home 的 `auth.json`。
 * **登录是玩家的事**（终端 `codex login`，与 `grok login` 同款）——这里只读玩家的文件、不改不催；
 * 拷贝是「游戏自己的 CODEX_HOME」这份隔离（规则/skill/不灌玩家全局配置）的代价，不是登录流程的一半：
 *   · 玩家文件更新（重新登录）→ 重拷；
 *   · 玩家文件消失（登出）→ **删掉我们的副本**，否则会出现「启动屏说未登录、引擎却还能跑」的自相矛盾。
 * @param {string} home 用户主目录
 * @param {string} codHome 游戏管理的 CODEX_HOME
 */
function syncCodexAuth(home, codHome) {
  try {
    const src = path.join(home, ".codex", "auth.json");
    const dst = path.join(codHome, "auth.json");
    if (!fs.existsSync(src)) {
      fs.rmSync(dst, { force: true });
      return;
    }
    const st = fs.statSync(src);
    if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= st.mtimeMs) return;
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o600);
  } catch {
    /* 同步失败不阻断 spawn：引擎以未登录态起来，/api/auth 与启动屏会说明 */
  }
}

/**
 * TOML 基本字符串字面量。JSON 的字符串转义（\" \\ \n \t \uXXXX）是 TOML 基本字符串的合法子集，
 * 且中文按 UTF-8 原样通过——所以这里直接用 JSON.stringify，不引 TOML 库（本仓零依赖纪律）。
 * @param {string} s 原文 @returns {string} 可嵌进 TOML 的字面量
 */
function tomlString(s) {
  return JSON.stringify(s);
}

/**
 * 写游戏管理的 `config.toml`（每次 spawn 按当前规则重写，幂等）：
 *   · `developer_instructions` = 注入规则（RULES + skill 指引；grok 的 `_meta.rules` 在 Codex 侧的对应物）；
 *   · `project_doc_max_bytes = 0` = 关闭 AGENTS.md 注入（第 0 步实证：instructionSources 由有变空）；
 *   · `skills.config` 指向落盘的 bunkiten skill。
 * @param {string} codHome 游戏管理的 CODEX_HOME
 * @param {{rules: string, skillDir: string}} ctx 规则原文与 skill 目录
 */
function writeCodexConfig(codHome, { rules, skillDir }) {
  const body = [
    "# bunkiten 引擎自动生成——按当前规则每次启动重写，手改会被覆盖（docs/adr/0022）。",
    `developer_instructions = ${tomlString(rules)}`,
    "project_doc_max_bytes = 0",
    "",
    "[[skills.config]]",
    `path = ${tomlString(skillDir)}`,
    "enabled = true",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codHome, "config.toml"), body, { mode: 0o600 });
}

/**
 * 把仓内唯一真源的 SKILL.md 复制进 CODEX_HOME 的 skill 目录（逐字复制，不加工——仓内那份已带
 * Codex 要求的 frontmatter；缺源文件时静默跳过，规则仍由 developer_instructions 兜底）。
 * @param {string} gameRoot 引擎 cwd
 * @param {string} codHome 游戏管理的 CODEX_HOME
 * @returns {string} skill 目录（skills.config 指向它）
 */
function copyCodexSkill(gameRoot, codHome) {
  const skillDir = path.join(codHome, "skills", CODEX_SKILL_NAME);
  const src = path.join(gameRoot, ".grok", "skills", CODEX_SKILL_NAME, "SKILL.md");
  try {
    if (!fs.existsSync(src)) return skillDir;
    fs.mkdirSync(skillDir, { recursive: true });
    fs.copyFileSync(src, path.join(skillDir, "SKILL.md"));
  } catch {
    /* 落盘失败不阻断 spawn：RULES 里的绝对路径指引会落空，但开发器 instructions 仍在 */
  }
  return skillDir;
}

/** PATH 里找一个可执行文件（给「登录按钮能不能点」用；找不到回 null，不抛） @param {string} name @returns {string | null} */
function resolveOnPath(name) {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        const file = path.join(dir, name + ext);
        if (fs.existsSync(file)) return file;
      } catch {
        /* 目录不可读：跳过 */
      }
    }
  }
  return null;
}

/**
 * grok CLI 的 spawn 入口。**Windows 上不能只写裸名 `grok`**：npm 全局装出来的是 `grok.cmd`，
 * 而 `child_process.spawn` 在 Windows 不做 PATHEXT 解析（裸名只补 `.exe`）→ ENOENT。
 * 所以先按 PATH 解析出真实路径（那里已经认 `.exe/.cmd/.bat`），解析不到再回落裸名
 * （非 Windows 的常规路径，或 PATH 之外的安装方式交给系统去找）。
 * @returns {string} 可执行文件路径或裸命令名
 */
function grokCommand() {
  return resolveOnPath("grok") ?? "grok";
}

/** grok 后端（现状逐字保留：spawn 参数、`_meta`、档位形状、会话图片根都不动） @type {EngineDescriptor} */
const GROK = {
  id: "grok",
  spawn: ({ creds, gameRoot }) => {
    // 测试/实验旋钮：显式覆盖模型（真引擎冒烟用便宜档跑：`BUNKITEN_GROK_MODEL=grok-4.7-build-fast`）。
    // 缺省不传 `--model`，用 CLI 自己的默认模型（本机 `~/.grok/config.toml` 与 CLI 版本说了算）——
    // 与 BUNKITEN_CODEX_ACP/BIN 同款：只在环境里显式给了才生效，产品路径一字不变。
    const model = String(process.env.BUNKITEN_GROK_MODEL || "").trim();
    return {
      cmd: grokCommand(),
      args: [
        "agent",
        "--always-approve",
        "--plugin-dir",
        path.join(gameRoot, ".grok"),
        ...(model ? ["--model", model] : []),
        "stdio",
      ],
      env: credentialsToEnv(creds), // BYOK 四件套（GROK_* / XAI_API_KEY）
    };
  },
  rulesFor: (rules) => rules,
  sessionMeta: ({ rules }) => ({ yoloMode: true, rules }),
  loginFile: (home) => path.join(home, ".grok", "auth.json"),
  prepare: () => {},
  sessionImagesRoot: ({ home, gameRoot }) => path.join(home, ".grok", "sessions", encodeURIComponent(gameRoot)),
  effortOption: (effort) => ({ configId: "reasoning_effort", value: { value: effort } }),
  // grok CLI 自带 login/logout（登出清 `~/.grok/auth.json`）。默认 OAuth 走浏览器；CLI 不在 PATH 时按钮禁用。
  // 命令用**解析后的路径**（与 spawn 同一口径：Windows 上可能是 `grok.cmd`，裸名 spawn 会 ENOENT），
  // 并经 windowsSafeSpawn 换成 shell 形态（同上：.cmd 直启会 EINVAL）。
  authCmd: (action) => windowsSafeSpawn({ cmd: grokCommand(), args: [action], env: {} }),
  authAvailable: () => resolveOnPath("grok") !== null,
};

/** Codex 后端（codex-acp 适配器；配置与实证见本文件头部注释） @type {EngineDescriptor} */
const CODEX = {
  id: "codex",
  spawn: ({ home }) => {
    const codHome = codexHome(home);
    const entry = codexAcpCommand();
    return {
      cmd: entry.cmd,
      args: entry.args,
      env: {
        ...(entry.electronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        CODEX_HOME: codHome,
        // 全自动（≈ grok 的 --always-approve）：第 0 步实证里 3 个真回合零审批打断
        INITIAL_AGENT_MODE: "agent-full-access",
        // 隐藏浏览器登录法：v1 的「沿用终端登录」不驱动登录流，未登录由启动屏给终端指引
        NO_BROWSER: "1",
      },
    };
  },
  rulesFor: (rules, { home }) =>
    `${rules}\n本项目的完整引擎规则是一份名为「${CODEX_SKILL_NAME}」的 skill（文件：${path.join(codexHome(home), "skills", CODEX_SKILL_NAME, "SKILL.md")}）。开局第一步先读它，并全程按它执行——它与本条冲突时以它为准。`,
  sessionMeta: () => null,
  loginFile: (home) => path.join(home, ".codex", "auth.json"),
  prepare: ({ home, gameRoot, rules }) => {
    const codHome = codexHome(home);
    try {
      fs.mkdirSync(codHome, { recursive: true, mode: 0o700 });
      fs.chmodSync(codHome, 0o700);
    } catch {
      return; // 建不出来就什么都不做：spawn 仍会带着既有的 CODEX_HOME 起来
    }
    syncCodexAuth(home, codHome);
    const skillDir = copyCodexSkill(gameRoot, codHome);
    try {
      writeCodexConfig(codHome, { rules, skillDir });
    } catch {
      /* 配置写不进去不阻断 spawn */
    }
  },
  sessionImagesRoot: () => null,
  effortOption: (effort) => ({ configId: "reasoning_effort", value: effort }),
  // 用**随包**的 codex CLI 跑登录（玩家不必另装 CLI）。两条要点：
  //   · CODEX_HOME 显式指回玩家自己的 `~/.codex`（不是游戏那份 `~/.bunkiten/codex`）——登录产物必须落在
  //     玩家终端也在用的那份里，`/api/auth` 与 prepare 的同步都盯着它；
  //   · NO_BROWSER 要摘掉：引擎会话里设它是为了隐藏渲染不了的登录法，这里正相反（浏览器要弹出来）。
  authCmd: (action, { home }) => {
    const cli = codexCliCommand();
    if (!cli) return null;
    return {
      cmd: cli.cmd,
      args: [...cli.args, action],
      env: { CODEX_HOME: path.join(home, ".codex") },
      unset: ["NO_BROWSER"],
    };
  },
  authAvailable: () => codexCliCommand() !== null,
};

/** 引擎 id → 描述符（未知 id 由 engineFor 回落默认） */
const ENGINE_TABLE = new Map([
  ["grok", GROK],
  ["codex", CODEX],
]);

/**
 * 取描述符；未知/缺失 id 回落默认引擎（读路径永不抛——凭据文件是玩家可手改的）。
 * @param {unknown} id 引擎 id
 * @returns {EngineDescriptor} 描述符
 */
export function engineFor(id) {
  const hit = ENGINE_TABLE.get(String(id));
  return hit ?? /** @type {EngineDescriptor} */ (ENGINE_TABLE.get("grok"));
}

/** 描述符表（契约 lint 面：id 集合必须与 shared/engines.mjs 的 ENGINE_IDS 一致） */
export const ENGINE_DESCRIPTORS = ENGINE_TABLE;

/**
 * 一次 spawn 的完整准备：选描述符 → 幂等准备（codex 的 home/登录态/配置/skill）→ 给出 spawn 三件套
 * 与注入规则。acp-server 的 `buildAcp()` 只调它，不碰品牌字面量。
 * @param {{creds: Credentials, home: string, gameRoot: string, rules: string}} ctx 凭据、主目录、引擎 cwd 与规则原文
 * @returns {{engine: EngineDescriptor, rules: string, spawn: SpawnPlan}} 描述符 + 注入规则 + spawn 三件套
 */
export function prepareSpawn({ creds, home, gameRoot, rules }) {
  const engine = engineFor(creds.engine);
  const resolved = engine.rulesFor(rules, { home, gameRoot });
  engine.prepare({ home, gameRoot, rules: resolved });
  // windowsSafeSpawn 是**唯一**的跨平台收口：描述符只写「想跑什么」，要不要经 shell 由这里定
  return { engine, rules: resolved, spawn: windowsSafeSpawn(engine.spawn({ creds, home, gameRoot })) };
}
