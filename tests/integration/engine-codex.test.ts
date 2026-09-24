// Codex 后端的集成覆盖（v1.11，docs/adr/0022）：engine=codex 的整栈里 spawn 面 / CODEX_HOME 的准备 /
// 登录探测 / 换引擎后的续档语义 / MCP 透传。每条都对着「改坏哪一处会红」：
//   · spawn 三件套（argv 无 --plugin-dir、CODEX_HOME / INITIAL_AGENT_MODE / NO_BROWSER）→ server/engines.mjs 的 CODEX 描述符；
//   · CODEX_HOME 的落盘（auth 同步 / config.toml 的 developer_instructions 与 project_doc_max_bytes / skill 目录）→ 同文件 prepare；
//   · 会话参数（不带 grok 的 `_meta`）→ 描述符 sessionMeta；
//   · /api/auth 的引擎分支（codex 的登录文件 + byok=false 的 hasCredentials）→ routes.mjs + 描述符 loginFile；
//   · 换引擎后不硬 load 旧会话 → acp.mjs 的 loadSavedSession + boot 的 engine 比对；
//   · MCP 透传（两引擎同走 ACP 的 mcpServers 字段）→ 入口 buildAcp 的 mediaMcpServers。
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startStack, type StackHandle } from "./harness.mjs";

/** startStack 的入参形状（真源在 harness 的 JSDoc，不在这里抄第二份） */
type StackOptions = NonNullable<Parameters<typeof startStack>[0]>;

/** 本文件起过的栈（afterEach 统一收尾） */
const started: StackHandle[] = [];
afterEach(async () => {
  while (started.length) await started.pop()?.stop();
});

/** 起一套栈并登记（afterEach 统一收尾） */
async function stack(opts: StackOptions = {}): Promise<StackHandle> {
  const s = await startStack(opts);
  started.push(s);
  return s;
}

/** 预置一份 engine=codex 的凭据文档（对话沿用终端登录；出图默认不用） */
const codexCreds = (llmOver: Record<string, unknown> = {}, imageOver: Record<string, unknown> = {}) => ({
  version: 1,
  engine: "codex",
  llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "", ...llmOver },
  image: { mode: "off", provider: "custom", baseUrl: "", apiKey: "", model: "", size: "", ...imageOver },
});

/** v1.10 及以前的凭据文档形态：没有 engine 键（读路径必须回落 grok） */
const legacyGrokCreds = () => ({
  version: 1,
  llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
  image: { mode: "off", provider: "openai", baseUrl: "", apiKey: "", model: "", size: "" },
});

const startsOf = (s: StackHandle) => s.engineProbeEntries().filter((e) => e.kind === "start");
const sessionsOf = (s: StackHandle) => s.engineProbeEntries().filter((e) => e.kind === "session");

/**
 * 最后一条 session 探针——**没有就抛**。
 * 为什么不用 `sessionsOf(s).at(-1)`：返回 `T | undefined`，下面每一处属性访问都得写 `?.`，
 * 而「压根没有 session 条目」本该当场炸成一条看得懂的错。
 */
function lastSession(s: StackHandle): Record<string, any> {
  const last = sessionsOf(s).at(-1);
  if (!last) throw new Error("假引擎探针里没有 session 条目（假引擎没收到 session/new？）");
  return last;
}

describe("engine=codex：spawn 面与 CODEX_HOME 的准备", () => {
  it("argv 不含 grok 的 flag；env 换成 CODEX_HOME/INITIAL_AGENT_MODE/NO_BROWSER；会话不带 _meta", async () => {
    const s = await stack({ credentials: codexCreds(), codexAuth: "ok" });

    const starts = startsOf(s);
    expect(starts).toHaveLength(1);
    expect(starts[0].argv).toEqual([]); // codex-acp 是裸 stdio ACP server（--plugin-dir 是 grok 的注入通道）
    expect(starts[0].env.CODEX_HOME).toBe(s.codexHome);
    expect(starts[0].env.INITIAL_AGENT_MODE).toBe("agent-full-access"); // ≈ grok 的 --always-approve
    expect(starts[0].env.NO_BROWSER).toBe("1");
    expect(starts[0].env.GROK_MODELS_BASE_URL).toBeNull(); // codex 不注 grok 的 BYOK 四件套
    expect(starts[0].env.XAI_API_KEY).toBeNull();

    // CODEX_HOME：登录态复用（玩家 ~/.codex/auth.json 拷进来）+ 游戏管理的 config.toml
    expect(fs.readFileSync(path.join(s.codexHome, "auth.json"), "utf8")).toBe('{"token":"fake-codex"}\n');
    const toml = fs.readFileSync(path.join(s.codexHome, "config.toml"), "utf8");
    expect(toml).toContain("project_doc_max_bytes = 0"); // 关掉 AGENTS.md 注入（第 0 步实证）
    expect(toml).toContain("developer_instructions = "); // RULES 的对应渠道
    expect(toml).toContain("[[skills.config]]");

    // 会话参数：codex 没有 grok 的 `_meta:{yoloMode,rules}`（规则走 config.toml）
    const last = lastSession(s);
    expect(last.method).toBe("session/new");
    expect(last.meta).toBeNull();

    expect(s.stdout()).toContain("codex session ready");
  });

  it("/api/auth 按引擎分支：codex 的登录态看 ~/.codex/auth.json，且自备 key 不参与放行（byok=false）", async () => {
    // 未登录：boot 屏走未登录态
    const missing = await stack({ credentials: codexCreds(), codexAuth: "missing" });
    expect((await missing.getJSON("/api/auth")).body).toEqual({
      loggedIn: false,
      hasCredentials: false,
      engine: "codex",
      canLogin: true,
    });

    // 已登录 + 连 llm 都配了 byok：codex 侧仍不算「可以开玩」（自备 key 不转发给它，见描述符）
    const ready = await stack({
      credentials: codexCreds({
        mode: "byok",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "sk-integration-codex-key",
        model: "m",
      }),
      codexAuth: "ok",
    });
    expect((await ready.getJSON("/api/auth")).body).toEqual({
      loggedIn: true,
      hasCredentials: false,
      engine: "codex",
      canLogin: true,
    });
  });

  it("codex + 图片自备 key：mcpServers 照常按 ACP 字段透传（media-mcp 零改造）", async () => {
    const s = await stack({
      credentials: codexCreds(
        {},
        {
          mode: "byok",
          provider: "custom",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "sk-integration-image-key",
          model: "it-image",
        },
      ),
      codexAuth: "ok",
    });
    const last = lastSession(s);
    expect(last.mcpServers).toHaveLength(1);
    expect(last.mcpServers[0].name).toBe("bunkiten-media");
    expect(last.mcpServers[0].args[0]).toContain("media-mcp.mjs");
  });
});

describe("换引擎：v1.10 旧凭据回落 grok、切到 codex 后重启并弃用旧会话", () => {
  it("旧凭据（没有 engine 键）→ grok；POST engine=codex + 重启 → 第二条 spawn 走 codex，存档记下新引擎、旧会话不被硬 load", async () => {
    const s = await stack({ credentials: legacyGrokCreds() });
    // v1.10 的凭据文件读出来就是 grok（行为与升级前一致）
    expect((await s.getJSON("/api/auth")).body.engine).toBe("grok");
    expect((await s.getJSON("/api/credentials")).body.engine).toBe("grok");
    expect(startsOf(s)).toHaveLength(1);
    expect(sessionsOf(s).map((e) => e.method)).toEqual(["session/new"]); // 首次启动没有存档 → 直接 new

    // 切引擎（设置屏的「立即保存」）
    const posted = await s.postJSON("/api/credentials", { engine: "codex" });
    expect(posted.status).toBe(200);
    expect(posted.body.engine).toBe("codex");

    // 「立刻重启引擎」：真杀旧进程再 spawn 一条新的（探针多一条 start）
    const restarted = await s.postJSON("/api/engine/restart", {});
    expect(restarted.status).toBe(200);
    const starts = startsOf(s);
    expect(starts).toHaveLength(2);
    expect(starts.at(-1)?.env.CODEX_HOME).toBe(s.codexHome);
    expect(starts.at(-1)?.env.INITIAL_AGENT_MODE).toBe("agent-full-access");
    expect(s.stdout()).toContain("codex session ready");

    // 断线续档文件换成新引擎；第二次 boot 走 session/new（旧 grok 的 sessionId 不会被拿去 load）
    const saved = JSON.parse(fs.readFileSync(path.join(s.root, ".shell-session.json"), "utf8"));
    expect(saved).toEqual({ engine: "codex", sessionId: "fake-session" });
    expect(sessionsOf(s).map((e) => e.method)).toEqual(["session/new", "session/new"]);
  });
});
