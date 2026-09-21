// 引擎凭据的集成覆盖（v1.10，docs/adr/0019）：HTTP 端点 + 真注进引擎子进程的 env + MCP 出图 server 的冒烟。
//
// 这一层每条用例都对着「改坏哪一处会红」：
//   · 端点契约（脱敏视图 / 400 校验 / clear 回落）→ 改 server/routes.mjs 的凭据分支或 credentials.mjs 的 publicView；
//   · 盘上 0600 → 改 writeCredentials 的 mode 参数；
//   · env 注入 → 改 acp.mjs 的 spawn env 或入口 buildAcp 的 credentialsToEnv 调用；
//   · MCP 挂载 → 改 mediaMcpServers 的 byok 判定或 acp.mjs 传 mcpServers 的两处；
//   · skill 注入 → 改 acp.mjs 的 spawn 参数（--plugin-dir <gameRoot>/.grok，ADR 0021）；
//   · 重启 → 改 restartAcp（没真正重 spawn 就看不到第二条探针）；
//   · media-mcp 的协议/落盘 → 改 server/media-mcp.mjs。
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { startStack } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MEDIA_MCP = path.join(ROOT, "server", "media-mcp.mjs");

/** @type {Array<{stop: () => Promise<void>}>} 本文件起过的栈（afterEach 统一收尾） */
const started = [];

afterEach(async () => {
  while (started.length) await started.pop().stop();
});

/** @param {object} [opts] 见 harness.startStack @returns {Promise<any>} */
async function stack(opts = {}) {
  const s = await startStack(opts);
  started.push(s);
  return s;
}

/** 预置一份「LLM 自备 key」的凭据文档 */
const llmByok = (over = {}) => ({
  version: 1,
  llm: { mode: "byok", provider: "custom", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-integration-llm-key-4f2a", model: "it-model", ...over },
  image: { mode: "off", provider: "custom", baseUrl: "", apiKey: "", model: "", size: "" },
});

/** 预置一份「图片自备 key」的凭据文档 */
const imageByok = () => ({
  version: 1,
  llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
  image: { mode: "byok", provider: "custom", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-integration-image-key-9b7c", model: "it-image", size: "" },
});

const credentialsFile = (/** @type {any} */ s) => path.join(s.home, ".bunkiten", "credentials.json");

/** 假的 OpenAI 兼容出图端点（记录请求；按脚本回包） */
async function fakeImages(handler) {
  /** @type {Array<{url: string, body: any, headers: any}>} */
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      requests.push({ url: req.url || "", body: parsed, headers: req.headers });
      handler(req, res, parsed);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("net").AddressInfo} */ (server.address()).port;
  return { port, requests, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

/**
 * 起一个 media-mcp 子进程并给它发 JSON-RPC（逐行）。
 * @param {Record<string, string>} env 子进程 env（HOME/GROK_GAME_ROOT 由调用方给）
 * @returns {{request: (method: string, params?: object) => Promise<any>, lines: string[], stop: () => void}}
 */
function mcpClient(env) {
  const proc = spawn(process.execPath, [MEDIA_MCP], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  /** @type {string[]} */
  const lines = [];
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const rl = readline.createInterface({ input: proc.stdout });
  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    lines.push(line);
    const msg = JSON.parse(line);
    if (msg.id !== undefined) {
      const r = pending.get(msg.id);
      if (r) {
        pending.delete(msg.id);
        r(msg);
      }
    }
  });
  let nextId = 1;
  return {
    lines,
    stderr: () => stderr,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`mcp timeout: ${method}`)), 10000);
        pending.set(id, (m) => {
          clearTimeout(t);
          resolve(m);
        });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    stop() {
      try {
        proc.kill("SIGKILL");
      } catch {}
    },
  };
}

describe("引擎凭据端点（GET/POST /api/credentials）", () => {
  it("默认态：没有凭据文件时回 session/off 且 hasKey=false，响应体不含任何 key", async () => {
    const s = await stack({});
    const r = await s.getJSON("/api/credentials");
    expect(r.status).toBe(200);
    expect(r.body.llm).toMatchObject({ mode: "session", hasKey: false, apiKeyMasked: "" });
    expect(r.body.image).toMatchObject({ mode: "off", hasKey: false, apiKeyMasked: "", size: "" });
  });

  it("POST 部分更新：只动给出的键，回脱敏视图（掩码可见、明文不可见），盘上文件 0600", async () => {
    const s = await stack({});
    const key = "sk-secret-value-4f2a";
    const r = await s.postJSON("/api/credentials", { llm: { mode: "byok", provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: key, model: "deepseek-chat" } });
    expect(r.status).toBe(200);
    expect(r.body.llm).toMatchObject({ mode: "byok", provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", hasKey: true });
    expect(r.body.llm.apiKeyMasked).toBe("sk-…4f2a");
    expect(JSON.stringify(r.body)).not.toContain(key);
    // 图片组没给 → 原样不动（默认 off）
    expect(r.body.image.mode).toBe("off");
    // 盘上：目录 0700 / 文件 0600（writeCredentials 的承诺）
    const file = credentialsFile(s);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).llm.apiKey).toBe(key);
  });

  it("POST 只给 apiKey=空串即清掉该字段（回落未配置），clear 整组回默认", async () => {
    const s = await stack({ credentials: llmByok() });
    const cleared = await s.postJSON("/api/credentials", { llm: { apiKey: "" } });
    expect(cleared.body.llm.hasKey).toBe(false);
    expect(cleared.body.llm.apiKeyMasked).toBe("");
    const back = await s.postJSON("/api/credentials", { clear: ["llm"] });
    expect(back.body.llm).toMatchObject({ mode: "session", baseUrl: "", model: "", hasKey: false });
  });

  it("POST 坏输入回 400：未知字段、非法 mode、非 http(s) 地址、非法尺寸", async () => {
    const s = await stack({});
    for (const body of [
      { llm: { nope: "x" } },
      { llm: { mode: "whatever" } },
      { llm: { baseUrl: "ftp://example.com" } },
      { image: { size: "huge" } },
      { clear: ["nope"] },
    ]) {
      const r = await s.postJSON("/api/credentials", body);
      expect(r.status, `应拒绝：${JSON.stringify(body)}`).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
  });

  it("GET/POST 的响应与 server stdout 都不含明文 key（脱敏面唯一）", async () => {
    const s = await stack({});
    const key = "sk-plaintext-should-never-surface-9z8y";
    await s.postJSON("/api/credentials", { llm: { mode: "byok", baseUrl: "https://example.com/v1", apiKey: key, model: "m" } });
    const got = await s.getText("/api/credentials");
    expect(got.body).not.toContain(key);
    const auth = await s.getText("/api/auth");
    expect(auth.body).not.toContain(key);
    expect(s.stdout()).not.toContain(key);
  });

  it("跨站请求 403、超大 body 413（新端点复用既有两道闸）", async () => {
    const s = await stack({});
    const cross = await s.fetch("/api/credentials", { headers: { origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    const crossPost = await s.fetch("/api/credentials", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ llm: { mode: "byok" } }),
    });
    expect(crossPost.status).toBe(403);
    const tooBig = await s.fetch("/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llm: { model: "x".repeat(5 * 1024 * 1024 + 16) } }),
    });
    expect(tooBig.status).toBe(413);
  });
});

describe("凭据 → 引擎子进程（env 与 MCP 挂载）", () => {
  it("LLM 自备 key：四个变量真的出现在引擎进程 env 里；session 模式则一个都没有", async () => {
    const byokStack = await stack({ credentials: llmByok() });
    const first = byokStack.engineProbeEntries().find((e) => e.kind === "start");
    expect(first.env).toEqual({
      GROK_MODELS_BASE_URL: "http://127.0.0.1:9/v1",
      XAI_API_KEY: "sk-integration-llm-key-4f2a",
      GROK_DEFAULT_MODEL: "it-model",
      // 会话标题那一下也指到自备模型（见 credentials.mjs 的 credentialsToEnv 注释）
      GROK_CONFIG: JSON.stringify({ models: { session_summary: "it-model" } }),
    });

    const sessionStack = await stack({});
    const plain = sessionStack.engineProbeEntries().find((e) => e.kind === "start");
    expect(plain.env).toEqual({ GROK_MODELS_BASE_URL: null, XAI_API_KEY: null, GROK_DEFAULT_MODEL: null, GROK_CONFIG: null });
  });

  it("图片自备 key 才挂 MCP：挂载项指向 server/media-mcp.mjs，off 时不挂", async () => {
    const withImage = await stack({ credentials: imageByok() });
    const session = withImage.engineProbeEntries().find((e) => e.kind === "session" && e.method === "session/new");
    expect(Array.isArray(session.mcpServers)).toBe(true);
    expect(session.mcpServers).toHaveLength(1);
    expect(session.mcpServers[0].name).toBe("bunkiten-media");
    expect(session.mcpServers[0].command).toBe(process.execPath);
    expect(session.mcpServers[0].args[0]).toBe(MEDIA_MCP);
    expect(session.mcpServers[0].env).toEqual([{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]);

    const noImage = await stack({ credentials: llmByok() });
    const plain = noImage.engineProbeEntries().find((e) => e.kind === "session" && e.method === "session/new");
    expect(plain.mcpServers).toEqual([]);
  });

  it("POST /api/engine/restart：真的重 spawn（第二条 start），并能把新凭据带过去", async () => {
    const s = await stack({ credentials: llmByok() });
    const before = s.engineProbeEntries().filter((e) => e.kind === "start").length;
    expect(before).toBe(1);

    await s.postJSON("/api/credentials", { llm: { baseUrl: "https://changed.example/v1", model: "changed-model" } });
    const r = await s.postJSON("/api/engine/restart", {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const starts = s.engineProbeEntries().filter((e) => e.kind === "start");
    expect(starts.length).toBe(2);
    expect(starts[1].env.GROK_MODELS_BASE_URL).toBe("https://changed.example/v1");
    expect(starts[1].env.GROK_DEFAULT_MODEL).toBe("changed-model");
    expect(starts[1].env.XAI_API_KEY).toBe("sk-integration-llm-key-4f2a");
    // 重启后 HTTP 侧照常可用（新会话已握手）
    const after = await s.getJSON("/api/credentials");
    expect(after.status).toBe(200);
    expect(s.stdout()).toContain("engine restarted");
  });
});

describe("引擎 skill 注入（spawn 的 --plugin-dir，ADR 0021）", () => {
  it("grok 参数含 --plugin-dir 且值 = <gameRoot>/.grok（未信托的会话也要宣告 bunkiten skill）", async () => {
    const s = await stack({});
    const start = s.engineProbeEntries().find((e: any) => e.kind === "start");
    expect(start.argv).toContain("--plugin-dir");
    const i = start.argv.indexOf("--plugin-dir");
    expect(start.argv[i + 1]).toBe(path.join(s.root, ".grok"));
  });
});

describe("/api/auth 扩展（登录态 + 自备 key 两态）", () => {
  it("有登录态、无凭据 → loggedIn=true / hasCredentials=false", async () => {
    const s = await stack({});
    const r = await s.getJSON("/api/auth");
    expect(r.body).toEqual({ loggedIn: true, hasCredentials: false });
  });

  it("无登录态但有 LLM 自备 key → hasCredentials=true（boot 屏据此放行）", async () => {
    const s = await stack({ auth: "missing", credentials: llmByok() });
    const r = await s.getJSON("/api/auth");
    expect(r.body).toEqual({ loggedIn: false, hasCredentials: true });
  });

  it("只有图片自备 key 不算「可以开玩」（hasCredentials 只看对话侧）", async () => {
    const s = await stack({ auth: "missing", credentials: imageByok() });
    const r = await s.getJSON("/api/auth");
    expect(r.body).toEqual({ loggedIn: false, hasCredentials: false });
  });
});

describe("POST /api/credentials/test（真连一次）", () => {
  it("LLM：服务提供 /models 时通过，并回延迟与模型条数", async () => {
    const fake = await fakeImages((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "a" }, { id: "b" }] }));
    });
    const s = await stack({ credentials: llmByok({ baseUrl: fake.base, apiKey: "sk-test-llm-key-1234" }) });
    const r = await s.postJSON("/api/credentials/test", { target: "llm" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.status).toBe(200);
    expect(r.body.ms).toBeGreaterThanOrEqual(0);
    expect(r.body.detail).toContain("2 个模型");
    await fake.close();
  });

  it("LLM：没有 /models 时退化为一次最小对话；密钥错误时失败且原因里不出现明文 key", async () => {
    const key = "sk-should-not-leak-77aa";
    const fake = await fakeImages((req, res) => {
      if (req.url.endsWith("/models")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no models endpoint" } }));
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key " + key } }));
    });
    const s = await stack({ credentials: llmByok({ baseUrl: fake.base, apiKey: key, model: "m" }) });
    const r = await s.postJSON("/api/credentials/test", { target: "llm" });
    expect(r.body.ok).toBe(false);
    expect(r.body.status).toBe(401);
    expect(r.body.error).not.toContain(key); // 服务端回显了 key，我们也不能原样端给屏
    expect(r.body.error).toContain("…");
    await fake.close();
  });

  it("图片：最小生成打的是 /images/generations，通过时给出尺寸与体积", async () => {
    const fake = await fakeImages((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: TINY_JPEG.toString("base64") }] }));
    });
    const s = await stack({ credentials: imageByok() });
    // 把图片组指到我们的假端点（走一次真实的保存-读取往返）
    await s.postJSON("/api/credentials", { image: { baseUrl: fake.base, model: "fake-image" } });
    const r = await s.postJSON("/api/credentials/test", { target: "image" });
    expect(r.body.ok).toBe(true);
    expect(r.body.detail).toContain("KB");
    expect(fake.requests[0].url).toBe("/v1/images/generations");
    expect(fake.requests[0].body.prompt).toBeTruthy();
    await fake.close();
  });

  it("未知 target 回 400（端点自己校验，不转手给探针）", async () => {
    const s = await stack({});
    const r = await s.postJSON("/api/credentials/test", { target: "whatever" });
    expect(r.status).toBe(400);
  });
});

describe("media-mcp 冒烟（直接 spawn 子进程走 MCP 协议）", () => {
  it("initialize → tools/list → tools/call：出图落盘到 presets/<id>/assets/ 并按契约命名", async () => {
    const fake = await fakeImages((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: TINY_JPEG.toString("base64") }] }));
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-mcp-home-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-mcp-root-"));
    fs.mkdirSync(path.join(home, ".bunkiten"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(home, ".bunkiten", "credentials.json"),
      JSON.stringify({
        version: 1,
        llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
        image: { mode: "byok", provider: "custom", baseUrl: fake.base, apiKey: "sk-mcp-image-key-1234", model: "img-model", size: "" },
      }),
      { mode: 0o600 },
    );
    const mcp = mcpClient({ HOME: home, GROK_GAME_ROOT: root });
    try {
      const init = await mcp.request("initialize", { protocolVersion: "2025-11-25" });
      expect(init.result.serverInfo.name).toBe("bunkiten-media");
      const list = await mcp.request("tools/list", {});
      expect(list.result.tools.map((t: any) => t.name)).toEqual(["generate_image"]);
      expect(list.result.tools[0].inputSchema.required).toEqual(["prompt", "kind", "name", "outRelPath"]);

      const call = await mcp.request("tools/call", {
        name: "generate_image",
        arguments: { prompt: "a portrait", kind: "立绘", name: "薇拉", variant: "微笑", outRelPath: "presets/demo/assets/立绘-薇拉-微笑.jpg" },
      });
      const payload = JSON.parse(call.result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.relPath).toBe("presets/demo/assets/立绘-薇拉-微笑.jpg");
      const written = fs.readFileSync(path.join(root, payload.relPath));
      expect(written.equals(TINY_JPEG)).toBe(true);
      // 请求体：模型、提示词、按类型给的竖构图尺寸
      expect(fake.requests[0].body.model).toBe("img-model");
      expect(fake.requests[0].body.size).toBe("1024x1536");
      expect(fake.requests[0].headers.authorization).toBe("Bearer sk-mcp-image-key-1234");
      // 子进程的任何输出里都不该出现明文 key（工具结果里也不该有）
      expect(JSON.stringify(call)).not.toContain("sk-mcp-image-key-1234");
      expect(mcp.stderr()).not.toContain("sk-mcp-image-key-1234");
    } finally {
      mcp.stop();
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("图片未配置时报「未配置图片服务」（引擎据此回退内置出图），且不落盘", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-mcp-home-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-mcp-root-"));
    const mcp = mcpClient({ HOME: home, GROK_GAME_ROOT: root });
    try {
      const call = await mcp.request("tools/call", {
        name: "generate_image",
        arguments: { prompt: "x", kind: "背景", name: "教堂", outRelPath: "presets/demo/assets/背景-教堂.jpg" },
      });
      expect(call.result.isError).toBe(true);
      expect(JSON.parse(call.result.content[0].text)).toEqual({ ok: false, error: "未配置图片服务" });
      expect(fs.existsSync(path.join(root, "presets"))).toBe(false);
    } finally {
      mcp.stop();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("未知工具/未知方法的回复仍走 JSON-RPC（isError 或 error 对象），不静默吞", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-mcp-home-"));
    const mcp = mcpClient({ HOME: home, GROK_GAME_ROOT: home });
    try {
      const unknownTool = await mcp.request("tools/call", { name: "nope", arguments: {} });
      expect(unknownTool.result.isError).toBe(true);
      const unknownMethod = await mcp.request("resources/list", {});
      expect(unknownMethod.error.code).toBe(-32601);
    } finally {
      mcp.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
