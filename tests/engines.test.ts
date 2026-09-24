// 引擎后端的描述符单测（v1.11，docs/adr/0022）：server/engines.mjs 的 spawn 三件套 / 规则注入 / 档位形状 /
// 登录探测 / CODEX_HOME 准备（真磁盘往返）+ shared/engines.mjs 的表与描述符表的一致性。
// 每条都对着「改坏哪一处会红」：
//   · spawn 参数面（grok 的 --plugin-dir、codex 的 CODEX_HOME/INITIAL_AGENT_MODE/NO_BROWSER）→ server/engines.mjs
//   · 档位下发形状（grok 嵌套 {value:{value}}、codex 裸串）→ 同文件（第 0 步实证，ADR-0022）
//   · prepare 的落盘（config.toml 的 developer_instructions / project_doc_max_bytes、auth 同步、skill 复制）→ 同文件
//   · 引擎表（id 唯一、byok 与说明自洽、与描述符表 id 集合一致）→ shared/engines.mjs / server/engines.mjs
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINES, ENGINE_IDS, DEFAULT_ENGINE_ID, engineById } from "../shared/engines.mjs";
import {
  CODEX_SKILL_NAME,
  ENGINE_DESCRIPTORS,
  codexHome,
  engineFor,
  prepareSpawn,
  windowsSafeSpawn,
} from "../server/engines.mjs";
import { defaultCredentials } from "../server/credentials.mjs";

/** 建一个临时的「用户主目录 + 游戏根」小世界，结束即删 */
const tmpDirs: string[] = [];
function tmpDir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 游戏根：放一份与仓内同构的 skill 源（`.grok/skills/bunkiten/SKILL.md`，带 frontmatter） */
function makeGameRoot(withSkill = true) {
  const root = tmpDir("bunkiten-engines-root-");
  if (withSkill) {
    const src = path.join(root, ".grok", "skills", CODEX_SKILL_NAME, "SKILL.md");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "---\nname: bunkiten\ndescription: 探针 skill\n---\n\n正文标记\n");
  }
  return root;
}

/** 玩家侧登录态（`~/.codex/auth.json`），可指定 mtime 以验「更新才重拷」 */
function putPlayerCodexAuth(home: string, content = '{"token":"probe"}\n', mtimeMs?: number) {
  const file = path.join(home, ".codex", "auth.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

describe("shared/engines.mjs 的表", () => {
  it("id 唯一、默认 id 在表里、engineById 未命中回 null", () => {
    const ids = ENGINES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ENGINE_IDS]);
    expect(engineById(DEFAULT_ENGINE_ID)).not.toBeNull();
    expect(engineById("no-such-engine")).toBeNull();
  });

  it("byok=false 的引擎必须给一句玩家话的原因（设置屏禁用按钮时要显示它）", () => {
    for (const e of ENGINES) {
      if (!e.byok) expect(e.byokNote.trim().length, `引擎「${e.id}」少了 byokNote`).toBeGreaterThan(0);
      expect(e.loginHint.trim().length).toBeGreaterThan(0);
    }
  });

  it("描述符表的 id 集合与真源一致（两边各加一个引擎而漏改另一边会红）", () => {
    expect([...ENGINE_DESCRIPTORS.keys()].sort()).toEqual([...ENGINE_IDS].sort());
  });
});

describe("engineFor：未知 id 回落默认引擎（读路径永不抛）", () => {
  it("未知 / 空 / undefined 一律回默认描述符", () => {
    for (const bad of ["", "no-such-engine", undefined, null, 42, {}]) {
      expect(engineFor(bad).id).toBe(DEFAULT_ENGINE_ID);
    }
  });

  it("两个已知 id 各自取到自己", () => {
    expect(engineFor("grok").id).toBe("grok");
    expect(engineFor("codex").id).toBe("codex");
  });
});

describe("spawn 三件套", () => {
  it("grok：命令/参数与历史逐字一致（--always-approve + --plugin-dir <gameRoot>/.grok + stdio）", () => {
    // 命令名走 PATH 解析（v1.12：Windows 上 npm 全局装的是 grok.cmd，裸名 spawn 会 ENOENT）——
    // 这里把 PATH 钉到临时目录，断言「解析到 PATH 里那一份」而不是这台机器上恰好装了什么
    const prev = process.env.PATH;
    const dir = tmpDir("bunkiten-engines-cmd-");
    try {
      process.env.PATH = dir;
      const gameRoot = makeGameRoot();
      const noGrok = engineFor("grok").spawn({
        creds: defaultCredentials(),
        home: tmpDir("bunkiten-engines-home-"),
        gameRoot,
      });
      expect(noGrok.cmd).toBe("grok"); // PATH 里没有 → 回落裸名（交给系统）

      const shim = path.join(dir, "grok");
      fs.writeFileSync(shim, "#!/bin/sh\n", { mode: 0o755 });
      const plan = engineFor("grok").spawn({
        creds: defaultCredentials(),
        home: tmpDir("bunkiten-engines-home-"),
        gameRoot,
      });
      expect(plan.cmd).toBe(shim);
      expect(plan.args).toEqual(["agent", "--always-approve", "--plugin-dir", path.join(gameRoot, ".grok"), "stdio"]);
      expect(plan.env).toEqual({}); // session 模式：不注 BYOK
    } finally {
      process.env.PATH = prev;
    }
  });

  it("grok：BUNKITEN_GROK_MODEL 显式给定才加 --model（真引擎冒烟用便宜档跑）；缺省/空白逐字不变", () => {
    const prev = process.env.BUNKITEN_GROK_MODEL;
    // home 是 SpawnContext 的必填项（codex 要用它准备 CODEX_HOME）；grok 的 spawn 不读它，给个占位值即可
    const spawnGrok = () => engineFor("grok").spawn({ creds: defaultCredentials(), home: "/h", gameRoot: "/g" });
    const base = ["agent", "--always-approve", "--plugin-dir", "/g/.grok"];
    try {
      delete process.env.BUNKITEN_GROK_MODEL;
      expect(spawnGrok().args).toEqual([...base, "stdio"]);
      process.env.BUNKITEN_GROK_MODEL = "grok-4.7-build-fast";
      expect(spawnGrok().args).toEqual([...base, "--model", "grok-4.7-build-fast", "stdio"]);
      process.env.BUNKITEN_GROK_MODEL = "   "; // 只有空白 = 没给（trim 后为空）
      expect(spawnGrok().args).toEqual([...base, "stdio"]);
    } finally {
      if (prev === undefined) delete process.env.BUNKITEN_GROK_MODEL;
      else process.env.BUNKITEN_GROK_MODEL = prev;
    }
  });

  it("grok：windowsSafeSpawn —— Windows 上的 .cmd/.bat 换成「整条命令行 + shell:true」（带空格的路径要加引号）", () => {
    const prev = process.platform;
    const as = (platform: NodeJS.Platform) =>
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      const plan = {
        cmd: "C:\\Users\\a b\\AppData\\Roaming\\npm\\grok.cmd",
        args: ["agent", "--plugin-dir", "C:\\g a m e\\.grok", "stdio"],
        env: {},
      };
      // 非 Windows：逐字返回（产品路径一字不变）
      as("darwin");
      expect(windowsSafeSpawn(plan)).toEqual(plan);
      // Windows + .cmd：整条命令行 + shell:true，可执行文件与带空格的参数都加引号
      as("win32");
      const win = windowsSafeSpawn(plan);
      expect(win.shell).toBe(true);
      expect(win.args).toEqual([]);
      expect(win.cmd).toBe(
        '"C:\\Users\\a b\\AppData\\Roaming\\npm\\grok.cmd" agent --plugin-dir "C:\\g a m e\\.grok" stdio',
      );
      // Windows + .exe：不换形态（原生可执行文件直接 spawn）
      expect(windowsSafeSpawn({ ...plan, cmd: "C:\\tools\\grok.exe" })).toEqual({
        ...plan,
        cmd: "C:\\tools\\grok.exe",
      });
    } finally {
      as(prev);
    }
  });

  it("grok：byok 凭据 → GROK_* 四件套进 env（我们的值优先，合并序在 acp.mjs）", () => {
    const creds = {
      ...defaultCredentials(),
      llm: { mode: "byok", provider: "openai", baseUrl: "https://x.example/v1", apiKey: "sk-k", model: "m-1" },
    };
    const plan = engineFor("grok").spawn({ creds, home: tmpDir("bunkiten-engines-home-"), gameRoot: makeGameRoot() });
    expect(plan.env.GROK_MODELS_BASE_URL).toBe("https://x.example/v1");
    expect(plan.env.XAI_API_KEY).toBe("sk-k");
    expect(plan.env.GROK_DEFAULT_MODEL).toBe("m-1");
    expect(Object.keys(plan.env).sort()).toEqual([
      "GROK_CONFIG",
      "GROK_DEFAULT_MODEL",
      "GROK_MODELS_BASE_URL",
      "XAI_API_KEY",
    ]);
  });

  it("codex：默认吃仓内 node_modules 里的入口（process.execPath + dist/index.js），env 带 CODEX_HOME / INITIAL_AGENT_MODE / NO_BROWSER", () => {
    const home = tmpDir("bunkiten-engines-home-");
    const plan = engineFor("codex").spawn({
      creds: { ...defaultCredentials(), engine: "codex" },
      home,
      gameRoot: makeGameRoot(),
    });
    // 开发态直接跑仓内那份入口（npm i 装好即可，不必进 PATH）；打包态换成 resources 下的同一入口 + ELECTRON_RUN_AS_NODE
    expect(plan.cmd).toBe(process.execPath);
    expect(plan.args).toHaveLength(1);
    expect(plan.args[0]).toMatch(
      new RegExp(`node_modules[/\\\\]@agentclientprotocol[/\\\\]codex-acp[/\\\\]dist[/\\\\]index\\.js$`),
    );
    expect(fs.existsSync(plan.args[0]), `入口脚本不存在：${plan.args[0]}（跑过 npm ci 吗？）`).toBe(true);
    expect(plan.env.CODEX_HOME).toBe(codexHome(home));
    expect(plan.env.INITIAL_AGENT_MODE).toBe("agent-full-access");
    expect(plan.env.NO_BROWSER).toBe("1");
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined(); // 只有打包态（process.resourcesPath 分支）才要它
  });

  it("codex：BUNKITEN_CODEX_ACP 覆盖优先（测试/打包态的注入面）", () => {
    const prev = process.env.BUNKITEN_CODEX_ACP;
    process.env.BUNKITEN_CODEX_ACP = "/tmp/shim/codex-acp";
    try {
      const plan = engineFor("codex").spawn({
        creds: { ...defaultCredentials(), engine: "codex" },
        home: tmpDir("bunkiten-engines-home-"),
        gameRoot: makeGameRoot(),
      });
      expect(plan.cmd).toBe("/tmp/shim/codex-acp");
      expect(plan.args).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.BUNKITEN_CODEX_ACP;
      else process.env.BUNKITEN_CODEX_ACP = prev;
    }
  });
});

describe("规则注入与会话扩展（grok 的 _meta ↔ codex 的 config.toml）", () => {
  it("grok：rules 原样进 _meta（yoloMode + rules），rulesFor 不改写", () => {
    const rules = "规则甲。规则乙。";
    const d = engineFor("grok");
    expect(d.rulesFor(rules, { home: "/h", gameRoot: "/g" })).toBe(rules);
    expect(d.sessionMeta({ rules })).toEqual({ yoloMode: true, rules });
  });

  it("codex：会话扩展为 null（不塞 grok 的 _meta），rulesFor 追加 skill 绝对路径指引", () => {
    const home = tmpDir("bunkiten-engines-home-");
    const d = engineFor("codex");
    expect(d.sessionMeta({ rules: "x" })).toBeNull();
    const out = d.rulesFor("规则甲。", { home, gameRoot: "/g" });
    expect(out).toContain("规则甲。");
    expect(out).toContain(path.join(codexHome(home), "skills", CODEX_SKILL_NAME, "SKILL.md"));
  });

  it("档位下发形状：grok 嵌套、codex 裸串（docs/adr/0022 第 0 步实证）", () => {
    expect(engineFor("grok").effortOption("medium")).toEqual({
      configId: "reasoning_effort",
      value: { value: "medium" },
    });
    expect(engineFor("codex").effortOption("medium")).toEqual({ configId: "reasoning_effort", value: "medium" });
  });

  it("登录探测与图片根：grok 看 ~/.grok/auth.json 与会话图目录；codex 看玩家 ~/.codex/auth.json、无图片通道", () => {
    expect(engineFor("grok").loginFile("/h")).toBe(path.join("/h", ".grok", "auth.json"));
    expect(engineFor("codex").loginFile("/h")).toBe(path.join("/h", ".codex", "auth.json"));
    expect(engineFor("grok").sessionImagesRoot({ home: "/h", gameRoot: "/g" })).toBe(
      path.join("/h", ".grok", "sessions", encodeURIComponent("/g")),
    );
    expect(engineFor("codex").sessionImagesRoot({ home: "/h", gameRoot: "/g" })).toBeNull();
  });
});

describe("登录 / 登出命令（GUI 按钮的服务端面，v1.11 收尾）", () => {
  it("grok：`grok login` / `grok logout` 的命令走 PATH 解析（与 spawn 同口径：Windows 上 npm 装的是 grok.cmd，裸名会 ENOENT），不额外注入 env", () => {
    const prev = process.env.PATH;
    const dir = tmpDir("bunkiten-engines-authcmd-");
    try {
      process.env.PATH = dir;
      const d = engineFor("grok");
      // PATH 里没有 CLI → 回落裸名（与 spawn 的兜底一致）
      expect(d.authCmd("login", { home: "/h" })).toEqual({ cmd: "grok", args: ["login"], env: {} });
      const shim = path.join(dir, "grok");
      fs.writeFileSync(shim, "#!/bin/sh\n", { mode: 0o755 });
      expect(d.authCmd("logout", { home: "/h" })).toEqual({ cmd: shim, args: ["logout"], env: {} });
    } finally {
      process.env.PATH = prev;
    }
  });

  it("grok：authAvailable 跟着 PATH 走（找不到 CLI 时 GUI 禁用按钮，而不是点了才报错）", () => {
    const prev = process.env.PATH;
    const dir = tmpDir("bunkiten-engines-path-");
    try {
      process.env.PATH = dir;
      expect(engineFor("grok").authAvailable({ home: "/h" })).toBe(false);
      fs.writeFileSync(path.join(dir, "grok"), "#!/bin/sh\n", { mode: 0o755 });
      expect(engineFor("grok").authAvailable({ home: "/h" })).toBe(true);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("codex：用随包 CLI 跑 login/logout，CODEX_HOME 指回玩家自己的 ~/.codex，并摘掉 NO_BROWSER（登录要弹浏览器）", () => {
    const home = tmpDir("bunkiten-engines-home-");
    const login = engineFor("codex").authCmd("login", { home });
    expect(login).not.toBeNull();
    expect(login!.args[login!.args.length - 1]).toBe("login");
    expect(login!.env.CODEX_HOME).toBe(path.join(home, ".codex"));
    expect(login!.env.CODEX_HOME).not.toBe(codexHome(home)); // 不是游戏那份（登录要落在玩家终端也在用的那份里）
    expect(login!.unset).toContain("NO_BROWSER");
    const logout = engineFor("codex").authCmd("logout", { home });
    expect(logout!.args[logout!.args.length - 1]).toBe("logout");
    expect(engineFor("codex").authAvailable({ home })).toBe(true); // 仓内 node_modules 里有随包 CLI
  });

  it("codex：BUNKITEN_CODEX_BIN 覆盖优先（测试垫片 / 自定义入口）", () => {
    const prev = process.env.BUNKITEN_CODEX_BIN;
    process.env.BUNKITEN_CODEX_BIN = "/tmp/shim/codex";
    try {
      const plan = engineFor("codex").authCmd("login", { home: "/h" });
      expect(plan!.cmd).toBe("/tmp/shim/codex");
      expect(plan!.args).toEqual(["login"]);
    } finally {
      if (prev === undefined) delete process.env.BUNKITEN_CODEX_BIN;
      else process.env.BUNKITEN_CODEX_BIN = prev;
    }
  });

  it("grok 的 spawn 入口按 PATH 解析（Windows 上 npm 全局装出来的是 grok.cmd，裸名 spawn 会 ENOENT）", () => {
    const prev = process.env.PATH;
    const dir = tmpDir("bunkiten-engines-spawn-");
    try {
      const shim = path.join(dir, "grok");
      fs.writeFileSync(shim, "#!/bin/sh\n", { mode: 0o755 });
      process.env.PATH = dir;
      const plan = engineFor("grok").spawn({ creds: defaultCredentials(), home: "/h", gameRoot: "/g" });
      expect(plan.cmd).toBe(shim); // 解析到真实路径（Windows 分支会把 .exe/.cmd/.bat 也认下来）
      expect(plan.args).toEqual(["agent", "--always-approve", "--plugin-dir", path.join("/g", ".grok"), "stdio"]);

      process.env.PATH = path.join(dir, "empty"); // PATH 里没有 → 回落裸名，交给系统去找
      expect(engineFor("grok").spawn({ creds: defaultCredentials(), home: "/h", gameRoot: "/g" }).cmd).toBe("grok");
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("prepareSpawn：codex 的 CODEX_HOME 准备（幂等、失败不抛）", () => {
  it("建目录（0700）+ 落 skill + 写 config.toml（developer_instructions / project_doc_max_bytes=0 / skills.config）", () => {
    const home = tmpDir("bunkiten-engines-home-");
    const gameRoot = makeGameRoot();
    const plan = prepareSpawn({
      creds: { ...defaultCredentials(), engine: "codex" },
      home,
      gameRoot,
      rules: "规则原文。",
    });

    const codHome = codexHome(home);
    expect(fs.existsSync(codHome)).toBe(true);
    expect(fs.statSync(codHome).mode & 0o777).toBe(0o700);

    const skill = path.join(codHome, "skills", CODEX_SKILL_NAME, "SKILL.md");
    expect(fs.readFileSync(skill, "utf8")).toBe(
      fs.readFileSync(path.join(gameRoot, ".grok", "skills", CODEX_SKILL_NAME, "SKILL.md"), "utf8"),
    );

    const toml = fs.readFileSync(path.join(codHome, "config.toml"), "utf8");
    expect(toml).toContain("project_doc_max_bytes = 0"); // 关掉 AGENTS.md 注入（第 0 步实证）
    expect(toml).toContain("developer_instructions = ");
    expect(toml).toContain("规则原文。"); // 规则进了 developer_instructions（含 codex 的 skill 指引）
    expect(toml).toContain(`path = ${JSON.stringify(path.join(codHome, "skills", CODEX_SKILL_NAME))}`);
    expect(toml).toContain("enabled = true");
    // 注入给会话的规则与写进 config.toml 的是同一份
    expect(plan.rules).toContain("规则原文。");
  });

  it("玩家 ~/.codex/auth.json → 游戏 home 的 auth.json（0600）；玩家文件没更新时不重拷；玩家登出则删副本", () => {
    const home = tmpDir("bunkiten-engines-home-");
    const src = putPlayerCodexAuth(home, '{"token":"v1"}\n');
    const codHome = codexHome(home);
    prepareSpawn({ creds: { ...defaultCredentials(), engine: "codex" }, home, gameRoot: makeGameRoot(), rules: "r" });
    const dst = path.join(codHome, "auth.json");
    expect(fs.readFileSync(dst, "utf8")).toBe('{"token":"v1"}\n');
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600);

    // 玩家没动过 → 幂等（不覆盖也不报错）
    prepareSpawn({ creds: { ...defaultCredentials(), engine: "codex" }, home, gameRoot: makeGameRoot(), rules: "r" });
    expect(fs.readFileSync(dst, "utf8")).toBe('{"token":"v1"}\n');

    // 玩家重新登录（文件更新）→ 重拷
    fs.writeFileSync(src, '{"token":"v2"}\n');
    const future = Date.now() + 5000;
    fs.utimesSync(src, future / 1000, future / 1000);
    prepareSpawn({ creds: { ...defaultCredentials(), engine: "codex" }, home, gameRoot: makeGameRoot(), rules: "r" });
    expect(fs.readFileSync(dst, "utf8")).toBe('{"token":"v2"}\n');

    // 玩家在终端登出（文件消失）→ 游戏侧的副本跟着消失（登录归玩家，登出也要算数）
    fs.rmSync(src);
    prepareSpawn({ creds: { ...defaultCredentials(), engine: "codex" }, home, gameRoot: makeGameRoot(), rules: "r" });
    expect(fs.existsSync(dst), "玩家登出后游戏侧仍留着旧登录副本：启动屏说未登录、引擎却能跑").toBe(false);
  });

  it("玩家没登录 / 游戏根没有 skill 源 → 不抛（spawn 仍以未登录态起来）", () => {
    const home = tmpDir("bunkiten-engines-home-");
    const gameRoot = makeGameRoot(false); // 故意没有 skill 源
    expect(() =>
      prepareSpawn({ creds: { ...defaultCredentials(), engine: "codex" }, home, gameRoot, rules: "r" }),
    ).not.toThrow();
    expect(fs.existsSync(path.join(codexHome(home), "auth.json"))).toBe(false);
  });

  it("grok：prepare 不往主目录写任何东西（现状不变）", () => {
    const home = tmpDir("bunkiten-engines-home-");
    prepareSpawn({ creds: defaultCredentials(), home, gameRoot: makeGameRoot(), rules: "r" });
    expect(fs.existsSync(path.join(home, ".bunkiten"))).toBe(false);
  });
});
