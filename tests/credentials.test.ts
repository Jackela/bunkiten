// 引擎凭据的纯函数单测（v1.10，docs/adr/0019）：credentials.mjs / credentials-probe.mjs / media-mcp.mjs 的
// 判定面 + shared/providers.mjs 的表完整性。每条都对着「改坏哪一处会红」：
//   · 掩码边界 / publicView / credentialsToEnv 的键集合 → 改 server/credentials.mjs；
//   · 容错（坏 JSON、缺键、多余键、超长）→ 改 normalizeCredentials；
//   · 目录表（id 唯一、地址合法、kind 覆盖）→ 改 shared/providers.mjs；
//   · 出图端点拼接 / 尺寸默认 / 目标路径 / 响应取字节 / 参数退让 → 改 server/media-mcp.mjs；
//   · 探活的两条路径（/models 与最小对话）→ 改 server/credentials-probe.mjs。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CREDENTIALS_VERSION,
  credentialsPath,
  credentialsToEnv,
  defaultCredentials,
  hasKey,
  llmReady,
  maskKey,
  mergeCredentials,
  normalizeCredentials,
  publicView,
  readCredentials,
  sanitizeErrorMessage,
  secretsOf,
  validateCredentialsPatch,
  writeCredentials,
} from "../server/credentials.mjs";
import { providersFor, providerById } from "../shared/providers.mjs";
import {
  DEFAULT_SIZES,
  generateImage,
  handleMcpMessage,
  imageSizeFor,
  imagesEndpoint,
  MEDIA_MCP_NAME,
  MEDIA_TOOL_NAME,
  mediaMcpPath,
  mediaMcpServers,
  asarUnpackedPath,
  pickImagePayload,
  requestImage,
  resolveOutputPath,
} from "../server/media-mcp.mjs";
import { testImage, testLlm } from "../server/credentials-probe.mjs";

/** 临时 HOME（单测用真磁盘验 mode / 往返；结束即删） */
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-creds-"));
}

// ---------- 假 fetch（记录调用；按脚本回包） ----------
type Reply = { status?: number; json?: unknown; text?: string; bytes?: Buffer };

/** @param {(url: string, init: any, call: number) => Reply} route 按调用次序决定回包 */
function makeFetch(route: (url: string, init: any, call: number) => Reply) {
  const calls: { url: string; init: any }[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = route(String(url), init, calls.length);
    const status = r.status ?? 200;
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => (r.json !== undefined ? r.json : JSON.parse(text)),
      arrayBuffer: async () => Uint8Array.from(r.bytes ?? Buffer.from(text)).buffer,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("credentials.mjs：出厂默认与容错读取", () => {
  it("默认态是「沿用 grok 登录 + 不出图」——与 v1.9 行为一致", () => {
    const d = defaultCredentials();
    expect(d.version).toBe(CREDENTIALS_VERSION);
    expect(d.llm).toEqual({ mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" });
    expect(d.image).toEqual({ mode: "off", provider: "openai", baseUrl: "", apiKey: "", model: "", size: "" });
  });

  it("normalize：缺键/多余键/类型不对逐键回默认，未知 provider 回默认 provider", () => {
    const n = normalizeCredentials({
      version: 99,
      llm: { mode: "byok", provider: "no-such-provider", baseUrl: 42, apiKey: null, model: "m", extra: "x" },
      image: "not-an-object",
      junk: true,
    });
    expect(n.version).toBe(CREDENTIALS_VERSION);
    expect(n.llm).toMatchObject({ mode: "byok", provider: "openai", baseUrl: "", apiKey: "", model: "m" });
    expect(n.image.mode).toBe("off");
    expect(Object.keys(n)).toEqual(["version", "llm", "image"]); // 多余键被丢掉
  });

  it("normalize：非法 mode 回该组默认、超长字段截断（不整份拒绝）", () => {
    const n = normalizeCredentials({
      llm: { mode: "banana", apiKey: "k".repeat(5000) },
      image: { mode: "byok", size: "s".repeat(200) },
    });
    expect(n.llm.mode).toBe("session");
    expect(n.llm.apiKey.length).toBe(1000);
    expect(n.image.mode).toBe("byok");
    expect(n.image.size.length).toBe(40);
  });

  it("readCredentials：文件不存在 / 坏 JSON / 目录被删都回默认且不抛", () => {
    const home = tmpHome();
    try {
      expect(readCredentials(home)).toEqual(defaultCredentials());
      fs.mkdirSync(path.dirname(credentialsPath(home)), { recursive: true });
      fs.writeFileSync(credentialsPath(home), "{ this is not json");
      expect(readCredentials(home)).toEqual(defaultCredentials());
      fs.writeFileSync(credentialsPath(home), JSON.stringify([1, 2, 3]));
      expect(readCredentials(home)).toEqual(defaultCredentials());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("credentials.mjs：写入往返与权限", () => {
  it("write→read 往返一致，目录 0700 / 文件 0600，且是原子写（没有残留 tmp 文件）", () => {
    const home = tmpHome();
    try {
      const next = mergeCredentials(defaultCredentials(), {
        llm: { mode: "byok", provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-roundtrip-key-4f2a", model: "deepseek-chat" },
      });
      const written = writeCredentials(home, next);
      expect(written.llm.provider).toBe("deepseek");
      expect(readCredentials(home)).toEqual(written);
      expect(fs.statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(credentialsPath(home))).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(path.dirname(credentialsPath(home)))).toEqual(["credentials.json"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("再次写入会覆盖旧值与旧权限（旧文件被换掉，不叠加）", () => {
    const home = tmpHome();
    try {
      writeCredentials(home, mergeCredentials(defaultCredentials(), { llm: { mode: "byok", apiKey: "sk-first-key-0001" } }));
      const second = writeCredentials(home, mergeCredentials(defaultCredentials(), { image: { mode: "byok", apiKey: "sk-second-key-0002" } }));
      const onDisk = readCredentials(home);
      expect(onDisk).toEqual(second);
      expect(onDisk.llm.apiKey).toBe("");
      expect(fs.statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("credentials.mjs：merge / validate", () => {
  it("merge 只动出现的键；空串=清字段；clear 整组回默认", () => {
    const base = normalizeCredentials({
      llm: { mode: "byok", provider: "openai", baseUrl: "https://a.example/v1", apiKey: "sk-a-123456", model: "m1" },
      image: { mode: "byok", provider: "openai", baseUrl: "https://b.example/v1", apiKey: "sk-b-123456", model: "m2", size: "512x512" },
    });
    const patched = mergeCredentials(base, { llm: { model: "m3", apiKey: "" } });
    expect(patched.llm).toEqual({ mode: "byok", provider: "openai", baseUrl: "https://a.example/v1", apiKey: "", model: "m3" });
    expect(patched.image.size).toBe("512x512"); // 没给的组原样不动
    const cleared = mergeCredentials(patched, {}, ["image"]);
    expect(cleared.image).toEqual(defaultCredentials().image);
    expect(cleared.llm.model).toBe("m3");
  });

  it("validate：未知字段/未知 clear/非字符串/非法 mode/非法地址/非法尺寸都拒", () => {
    const bad = [
      { llm: { nope: "1" } },
      { image: { size: "1024x1536x2" } },
      { image: { size: "huge" } },
      { llm: { mode: "hybrid" } },
      { image: { mode: "session" } },
      { llm: { baseUrl: "javascript:alert(1)" } },
      { llm: 12 },
      { llm: { apiKey: 123 } },
    ];
    for (const p of bad) {
      expect(validateCredentialsPatch(p).ok, `应拒绝 ${JSON.stringify(p)}`).toBe(false);
    }
    expect(validateCredentialsPatch({}, ["nope"]).ok).toBe(false);
    expect(validateCredentialsPatch({ llm: { mode: "byok", baseUrl: "http://localhost:11434/v1", apiKey: "k", model: "m" } }).ok).toBe(true);
    expect(validateCredentialsPatch({ image: { size: "auto" } }).ok).toBe(true);
    expect(validateCredentialsPatch({ image: { size: "" } }).ok).toBe(true);
  });
});

describe("credentials.mjs：掩码与脱敏视图", () => {
  it("maskKey 的边界：空串、短 key（整串打点）、常规 key（首三 + 末四）", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("   ")).toBe("");
    expect(maskKey("short")).toBe("•••••");
    expect(maskKey("12345678")).toBe("••••••••");
    expect(maskKey("sk-abcdef1234564f2a")).toBe("sk-…4f2a");
    expect(maskKey("xai-0123456789abcdef")).toBe("xai…cdef");
  });

  it("publicView 永不含明文：键只有 mode/provider/baseUrl/model/size/hasKey/apiKeyMasked", () => {
    const creds = normalizeCredentials({
      llm: { mode: "byok", provider: "xai", baseUrl: "https://api.x.ai/v1", apiKey: "sk-view-secret-4f2a", model: "grok-4.6" },
      image: { mode: "byok", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-img-secret-9b7c", model: "gpt-image-1", size: "1024x1024" },
    });
    const view = publicView(creds);
    expect(view.llm).toEqual({
      mode: "byok",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.6",
      hasKey: true,
      apiKeyMasked: "sk-…4f2a",
    });
    expect(view.image.apiKeyMasked).toBe("sk-…9b7c");
    expect(view.image.size).toBe("1024x1024");
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("hasKey / llmReady / secretsOf 的判定", () => {
    const session = defaultCredentials();
    expect(hasKey(session, "llm")).toBe(false);
    expect(llmReady(session)).toBe(false);
    expect(secretsOf(session)).toEqual([]);
    const byok = normalizeCredentials({ llm: { mode: "byok", baseUrl: "https://x.example/v1", apiKey: "sk-llm-key-1111" }, image: { mode: "byok", apiKey: "sk-img-key-2222" } });
    expect(llmReady(byok)).toBe(true);
    expect(secretsOf(byok)).toEqual(["sk-llm-key-1111", "sk-img-key-2222"]);
    // 只有 key 没有地址：不算「可以开玩」（CLI 不知道往哪打）
    expect(llmReady(normalizeCredentials({ llm: { mode: "byok", apiKey: "sk-only-key-3333" } }))).toBe(false);
  });
});

describe("credentials.mjs：credentialsToEnv（注入引擎子进程的键集合）", () => {
  it("session/off 模式不产生任何键", () => {
    expect(credentialsToEnv(defaultCredentials())).toEqual({});
    expect(credentialsToEnv(normalizeCredentials({ image: { mode: "byok", baseUrl: "https://i.example/v1", apiKey: "k" } }))).toEqual({});
  });

  it("byok 模式逐键生成，空字段不产生空串键", () => {
    const full = normalizeCredentials({ llm: { mode: "byok", baseUrl: "https://api.example/v1", apiKey: "sk-env-key-4f2a", model: "m" } });
    expect(credentialsToEnv(full)).toEqual({ GROK_MODELS_BASE_URL: "https://api.example/v1", XAI_API_KEY: "sk-env-key-4f2a", GROK_DEFAULT_MODEL: "m" });
    const noModel = normalizeCredentials({ llm: { mode: "byok", baseUrl: "https://api.example/v1", apiKey: "sk-env-key-4f2a" } });
    expect(credentialsToEnv(noModel)).toEqual({ GROK_MODELS_BASE_URL: "https://api.example/v1", XAI_API_KEY: "sk-env-key-4f2a" });
    const onlyKey = normalizeCredentials({ llm: { mode: "byok", apiKey: "sk-env-key-4f2a" } });
    expect(credentialsToEnv(onlyKey)).toEqual({ XAI_API_KEY: "sk-env-key-4f2a" });
  });

  it("sanitizeErrorMessage：抹掉明文、压空白、截断 200 字", () => {
    expect(sanitizeErrorMessage("  bad\nkey  ", [])).toBe("bad key");
    expect(sanitizeErrorMessage("rejected sk-abcdef1234564f2a here", ["sk-abcdef1234564f2a"])).toBe("rejected sk-…4f2a here");
    const long = sanitizeErrorMessage("x".repeat(500), []);
    expect(long.length).toBe(201);
    expect(long.endsWith("…")).toBe(true);
    // 太短的值不做替换（否则会把正文里的短词打成点）
    expect(sanitizeErrorMessage("abc abc", ["abc"])).toBe("abc abc");
  });
});

describe("shared/providers.mjs：目录表完整性", () => {
  it("id 唯一且是 kebab-case；label 非空；kind 合法", () => {
    const seen = new Set<string>();
    for (const p of providersFor("llm")) {
      expect(p.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(seen.has(p.id), `重复 id：${p.id}`).toBe(false);
      seen.add(p.id);
      expect(p.label.length).toBeGreaterThan(0);
      expect(["llm", "image", "both"]).toContain(p.kind);
      expect(Array.isArray(p.models)).toBe(true);
      for (const m of p.models) expect(typeof m).toBe("string");
      if (p.imageModels) for (const m of p.imageModels) expect(typeof m).toBe("string");
    }
  });

  it("baseUrl 要么是 http(s) 地址、要么留空且带 note 说明怎么填", () => {
    for (const p of providersFor("llm")) {
      if (p.baseUrl === "") {
        expect(p.note, `${p.id} 留空地址就得说明形态`).toBeTruthy();
      } else {
        const u = new URL(p.baseUrl);
        expect(["http:", "https:"], `${p.id} 的地址必须是 http(s)`).toContain(u.protocol);
        expect(p.baseUrl.endsWith("/"), `${p.id} 的地址不该以 / 结尾`).toBe(false);
      }
    }
  });

  it("每条都有一句 note，且站点/地域成对的那些互相指路（密钥与站点必须配套）", () => {
    for (const p of providersFor("llm")) {
      expect(p.note, `${p.id} 没有 note：玩家看不出这条服务的地址/口径特殊在哪`).toBeTruthy();
    }
    // 国内/海外站点成对的服务：两边的 note 必须互相点名（选错站点是 401 的最常见原因）
    const pairs: [string, string][] = [
      ["moonshot", "moonshot-global"],
      ["minimax", "minimax-global"],
      ["dashscope", "dashscope-intl"],
    ];
    for (const [cnId, intlId] of pairs) {
      const cn = providerById(cnId);
      const intl = providerById(intlId);
      expect(cn, `目录里找不到 ${cnId}`).toBeTruthy();
      expect(intl, `目录里找不到 ${intlId}`).toBeTruthy();
      expect(cn!.baseUrl === intl!.baseUrl, `${cnId} 与 ${intlId} 的地址不该相同（站点不同）`).toBe(false);
      expect(cn!.note, `${cnId} 的 note 应指向它的海外站（${intlId}）`).toContain(intl!.label);
      expect(intl!.note, `${intlId} 的 note 应指向它的国内站（${cnId}）`).toContain(cn!.label);
    }
  });

  it("两种用途都有可选项；both 的服务同时出现在两个下拉里；providerById 未知回 null", () => {
    expect(providersFor("llm").length).toBeGreaterThan(5);
    expect(providersFor("image").length).toBeGreaterThan(2);
    const both = providersFor("llm").filter((p) => p.kind === "both");
    for (const p of both) expect(providersFor("image").map((q) => q.id)).toContain(p.id);
    expect(providerById("custom")?.kind).toBe("both");
    expect(providerById("nope")).toBe(null);
    expect(providerById("")).toBe(null);
  });
});

describe("media-mcp.mjs：纯函数", () => {
  it("imageSizeFor：按类型默认，玩家填了就一律用它", () => {
    expect(DEFAULT_SIZES.立绘).toBe("1024x1536");
    expect(DEFAULT_SIZES.背景).toBe("1536x1024");
    expect(imageSizeFor("立绘", "")).toBe("1024x1536");
    expect(imageSizeFor("背景", "")).toBe("1536x1024");
    expect(imageSizeFor("封面", "  512x512 ")).toBe("512x512");
    expect(imageSizeFor("未知", "")).toBe("1024x1024");
  });

  it("imagesEndpoint：去尾斜杠后接 /images/generations", () => {
    expect(imagesEndpoint("https://api.example.com/v1")).toBe("https://api.example.com/v1/images/generations");
    expect(imagesEndpoint("https://api.example.com/v1/")).toBe("https://api.example.com/v1/images/generations");
    expect(imagesEndpoint(" https://api.example.com/v1// ")).toBe("https://api.example.com/v1/images/generations");
  });

  it("resolveOutputPath：立绘/背景/封面按 outRelPath 的剧本 id 重建路径；坏输入给人话", () => {
    expect(resolveOutputPath({ kind: "立绘", name: "薇拉", outRelPath: "presets/demo/assets/立绘-薇拉.jpg" })).toEqual({ rel: "presets/demo/assets/立绘-薇拉.jpg" });
    expect(resolveOutputPath({ kind: "立绘", name: "薇拉", variant: "微笑", outRelPath: "presets/demo/assets/立绘-薇拉.jpg" })).toEqual({
      rel: "presets/demo/assets/立绘-薇拉-微笑.jpg",
    });
    // 引擎把变体写进 name 又另给 variant：不重复拼
    expect(resolveOutputPath({ kind: "立绘", name: "薇拉-微笑", variant: "微笑", outRelPath: "presets/demo/assets/x.jpg" })).toEqual({
      rel: "presets/demo/assets/立绘-薇拉-微笑.jpg",
    });
    // 封面：剧本 id 以 outRelPath 为准（不看标题——同名剧本才不会被写错地方）
    expect(resolveOutputPath({ kind: "封面", name: "随便什么标题", outRelPath: "presets/demo/cover.jpg" })).toEqual({ rel: "presets/demo/cover.jpg" });
    // 名字里的路径分隔符被 sanitize（穿越不到 assets/ 之外）
    expect(resolveOutputPath({ kind: "立绘", name: "../../etc/passwd", outRelPath: "presets/demo/assets/x.jpg" }).rel).toBe("presets/demo/assets/立绘-.._.._etc_passwd.jpg");
    expect(resolveOutputPath({ kind: "海报", name: "薇拉", outRelPath: "presets/demo/assets/x.jpg" })).toEqual({ error: "kind 必须是 立绘/背景/封面" });
    expect("error" in resolveOutputPath({ kind: "立绘", name: "薇拉", outRelPath: "images/1.jpg" })).toBe(true);
    expect("error" in resolveOutputPath({ kind: "立绘", name: "  ", outRelPath: "presets/demo/assets/x.jpg" })).toBe(true);
  });

  it("requestImage 的失败路径（非法 kind/无 outRelPath 时 generateImage 直接回错误，不发请求）", async () => {
    const creds = normalizeCredentials({
      llm: { mode: "session" },
      image: { mode: "byok", baseUrl: "https://img.example/v1", apiKey: "sk-img-key-5555", model: "img" },
    });
    const { impl, calls } = makeFetch(() => ({ json: {} }));
    const bad = await generateImage({ prompt: "p", kind: "海报", name: "薇拉", outRelPath: "presets/demo/assets/x.jpg" }, { creds, gameRoot: os.tmpdir(), fetchImpl: impl });
    expect(bad.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("pickImagePayload：b64_json / url / 裸字符串，缺 data 时给错误", () => {
    expect("bytes" in pickImagePayload({ data: [{ b64_json: PNG.toString("base64") }] })).toBe(true);
    expect(pickImagePayload({ data: [{ url: "https://cdn.example/a.png" }] })).toEqual({ url: "https://cdn.example/a.png" });
    expect("bytes" in pickImagePayload({ data: PNG.toString("base64") })).toBe(true);
    expect(pickImagePayload({ data: [{ nope: 1 }] })).toEqual({ error: "响应里既没有 b64_json 也没有 url" });
    expect("error" in pickImagePayload({})).toBe(true);
  });
});

describe("media-mcp.mjs：MCP 协议面（直喂消息，不必 spawn 子进程）", () => {
  /** 收一条回包（handleMcpMessage 是「喂消息 + 回调」的纯接口） */
  async function ask(msg: any, callTool?: (p: object) => Promise<{ ok?: boolean }>) {
    const replies: any[] = [];
    await handleMcpMessage(msg, (m) => replies.push(m), callTool);
    return replies;
  }

  it("initialize 回协议版本与 serverInfo（name 取自 MEDIA_MCP_NAME）", async () => {
    const [r] = await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    expect(r.result.serverInfo.name).toBe("bunkiten-media");
    expect(r.result.protocolVersion).toBe("2025-11-25");
    expect(r.result.capabilities).toEqual({ tools: {} });
    // 客户端没给版本时回落一个确定的默认值（不是 undefined）
    const [r2] = await ask({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    expect(typeof r2.result.protocolVersion).toBe("string");
  });

  it("通知类消息（无 id / notifications/initialized）不回包", async () => {
    expect(await ask({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual([]);
    expect(await ask({ jsonrpc: "2.0", method: "tools/list" })).toEqual([]); // 无 id 的请求按通知处理
  });

  it("tools/list 回唯一工具，schema 的必填项与实现一致", async () => {
    const [r] = await ask({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect(r.result.tools).toHaveLength(1);
    const tool = r.result.tools[0];
    expect(tool.name).toBe(MEDIA_TOOL_NAME);
    expect(tool.name).toBe("generate_image");
    expect(tool.inputSchema.required).toEqual(["prompt", "kind", "name", "outRelPath"]);
    expect(tool.inputSchema.properties.kind.enum).toEqual(["立绘", "背景", "封面"]);
  });

  it("tools/call 把执行结果包成 content + isError（成功/失败两条路径都覆盖）", async () => {
    const ok = await ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: MEDIA_TOOL_NAME, arguments: { prompt: "p" } } }, async () => ({
      ok: true,
      relPath: "presets/demo/assets/立绘-薇拉.jpg",
    }));
    expect(ok[0].result.isError).toBe(false);
    expect(JSON.parse(ok[0].result.content[0].text)).toEqual({ ok: true, relPath: "presets/demo/assets/立绘-薇拉.jpg" });

    const failed = await ask({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: MEDIA_TOOL_NAME, arguments: {} } }, async () => ({ ok: false, error: "未配置图片服务" }));
    expect(failed[0].result.isError).toBe(true);
    expect(JSON.parse(failed[0].result.content[0].text)).toEqual({ ok: false, error: "未配置图片服务" });
  });

  it("tools/call 的执行器抛异常也不会打穿协议（兜成 isError 结果）", async () => {
    const [r] = await ask({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: MEDIA_TOOL_NAME, arguments: {} } }, async () => {
      throw new Error("boom");
    });
    expect(r.result.isError).toBe(true);
    expect(String(r.result.content[0].text)).toContain("boom");
  });

  it("未知工具名与未知方法：前者回 isError 结果，后者回 JSON-RPC -32601；垃圾输入不抛", async () => {
    const [unknownTool] = await ask({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } });
    expect(unknownTool.result.isError).toBe(true);
    const [unknownMethod] = await ask({ jsonrpc: "2.0", id: 8, method: "resources/list", params: {} });
    expect(unknownMethod.error.code).toBe(-32601);
    expect(await ask(null)).toEqual([]);
    expect(await ask({ jsonrpc: "2.0", id: 9 })).toEqual([]);
    expect(await ask("不是对象")).toEqual([]);
  });
});

describe("media-mcp.mjs：挂载项与 asar 路径（打包态前提）", () => {
  it("mediaMcpServers 只在图片自备 key 时给挂载项，且形态是 ACP 的 McpServerStdio", () => {
    const off = defaultCredentials();
    expect(mediaMcpServers(off)).toEqual([]);
    expect(mediaMcpServers(normalizeCredentials({ image: { mode: "session" } }))).toEqual([]);

    const byok = normalizeCredentials({ image: { mode: "byok", baseUrl: "https://img.example/v1", apiKey: "sk-x-1234", model: "m" } });
    const servers = mediaMcpServers(byok);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      name: MEDIA_MCP_NAME,
      command: process.execPath,
      args: [mediaMcpPath()],
      env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
    });
  });

  it("asarUnpackedPath：把 app.asar 段换成 app.asar.unpacked；开发态路径原样", () => {
    const sep = path.sep;
    expect(asarUnpackedPath(`/Applications/B.app/Contents/Resources/app.asar${sep}server${sep}media-mcp.mjs`)).toBe(
      `/Applications/B.app/Contents/Resources/app.asar.unpacked${sep}server${sep}media-mcp.mjs`,
    );
    // 幂等：已经是 unpacked 的不再动
    const already = `/x/app.asar.unpacked${sep}server${sep}media-mcp.mjs`;
    expect(asarUnpackedPath(already)).toBe(already);
    // 开发态（仓库里）原样返回
    const dev = `${sep}Users${sep}me${sep}bunkiten${sep}server${sep}media-mcp.mjs`;
    expect(asarUnpackedPath(dev)).toBe(dev);
  });

  it("mediaMcpPath 指向真实存在的本文件（打包态靠 asarUnpack 保证 unpacked 那份也在）", () => {
    const p = mediaMcpPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith(`server${path.sep}media-mcp.mjs`)).toBe(true);
    expect(fs.existsSync(p), `mediaMcpPath 指到了不存在的文件：${p}`).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toContain('export const MEDIA_TOOL_NAME = "generate_image"');
  });
});

describe("media-mcp.mjs：requestImage 的兼容梯子", () => {
  it("成功：POST /images/generations，Bearer 认证，回字节与状态", async () => {
    const { impl, calls } = makeFetch(() => ({ json: { created: 1, data: [{ b64_json: PNG.toString("base64") }] } }));
    const out = await requestImage({ baseUrl: "https://api.example.com/v1", apiKey: "sk-req-key-1234", model: "m", prompt: "p", size: "1024x1024", fetchImpl: impl });
    expect("bytes" in out && out.bytes.equals(PNG)).toBe(true);
    expect(calls[0].url).toBe("https://api.example.com/v1/images/generations");
    expect(calls[0].init.headers.authorization).toBe("Bearer sk-req-key-1234");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ model: "m", prompt: "p", n: 1, size: "1024x1024", response_format: "b64_json" });
  });

  it("服务抱怨 response_format（gpt-image-1 一类）→ 去掉它重试一次", async () => {
    const { impl, calls } = makeFetch((url, init, call) =>
      call === 1
        ? { status: 400, text: "Unsupported parameter: response_format" }
        : { json: { data: [{ b64_json: PNG.toString("base64") }] } },
    );
    const out = await requestImage({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", prompt: "p", size: "1024x1024", fetchImpl: impl });
    expect("bytes" in out).toBe(true);
    expect(calls.length).toBe(2);
    expect("response_format" in JSON.parse(calls[1].init.body)).toBe(false);
  });

  it("服务不认 size（xAI 一类）→ 去掉 size 重试；两次都不行才放弃并回脱敏错误", async () => {
    const { impl, calls } = makeFetch((url, init, call) =>
      call === 1 ? { status: 400, text: "unknown field size" } : { json: { data: [{ b64_json: PNG.toString("base64") }] } },
    );
    const out = await requestImage({ baseUrl: "https://api.example.com/v1", apiKey: "sk-drop-size-1234", model: "m", prompt: "p", size: "1024x1024", fetchImpl: impl });
    expect("bytes" in out).toBe(true);
    expect("size" in JSON.parse(calls[1].init.body)).toBe(false);

    const always = makeFetch(() => ({ status: 400, text: "nope size and response_format" }));
    const bad = await requestImage({ baseUrl: "https://api.example.com/v1", apiKey: "sk-secret-key-7777", model: "m", prompt: "p", size: "1x1", fetchImpl: always.impl });
    expect("error" in bad && bad.error.includes("HTTP 400")).toBe(true);
    expect(always.calls.length).toBeLessThanOrEqual(3); // 最多三次尝试，不会无限退让
  });

  it("回 url 时下载；下载失败也算失败（不落半张图）", async () => {
    const ok = makeFetch((url) => (url.includes("/images/generations") ? { json: { data: [{ url: "https://cdn.example/a.png" }] } } : { bytes: PNG }));
    const out = await requestImage({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", prompt: "p", size: "1x1", fetchImpl: ok.impl });
    expect("bytes" in out && out.bytes.equals(PNG)).toBe(true);
    expect(ok.calls[1].url).toBe("https://cdn.example/a.png");

    const bad = makeFetch((url) => (url.includes("/images/generations") ? { json: { data: [{ url: "https://cdn.example/a.png" }] } } : { status: 404, text: "gone" }));
    const out2 = await requestImage({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", prompt: "p", size: "1x1", fetchImpl: bad.impl });
    expect("error" in out2 && out2.error.includes("下载图片失败")).toBe(true);
  });

  it("错误信息脱敏：服务端把 key 回显出来也不会原样返回", async () => {
    const key = "sk-echoed-back-9911";
    const { impl } = makeFetch(() => ({ status: 401, text: `invalid key ${key}` }));
    const out = await requestImage({ baseUrl: "https://api.example.com/v1", apiKey: key, model: "m", prompt: "p", size: "1x1", fetchImpl: impl });
    expect("error" in out && out.error.includes(key)).toBe(false);
    expect("error" in out && out.error.includes("sk-…9911")).toBe(true);
  });
});

describe("credentials-probe.mjs：测试连接的判定", () => {
  it("testLlm：缺地址/缺 key 时直接给一句人话（不发起请求）", async () => {
    const { impl, calls } = makeFetch(() => ({ json: {} }));
    const noUrl = await testLlm({ baseUrl: "", apiKey: "k", model: "m" }, { fetchImpl: impl });
    expect(noUrl).toMatchObject({ ok: false, status: 0 });
    expect(noUrl.error).toContain("服务地址");
    const noKey = await testLlm({ baseUrl: "https://a.example/v1", apiKey: "", model: "m" }, { fetchImpl: impl });
    expect(noKey.error).toContain("密钥");
    expect(calls.length).toBe(0);
  });

  it("testLlm：/models 通了就通过（不消耗生成额度），并回模型条数", async () => {
    const { impl, calls } = makeFetch(() => ({ json: { object: "list", data: [{ id: "a" }, { id: "b" }, { id: "c" }] } }));
    const out = await testLlm({ baseUrl: "https://a.example/v1/", apiKey: "k", model: "m" }, { fetchImpl: impl });
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.detail).toContain("3 个模型");
    expect(calls[0].url).toBe("https://a.example/v1/models");
  });

  it("testLlm：/models 404 → 退化最小对话；没填模型时明说先填模型", async () => {
    const { impl, calls } = makeFetch((url) => (url.endsWith("/models") ? { status: 404, text: "not found" } : { json: { choices: [] } }));
    const noModel = await testLlm({ baseUrl: "https://a.example/v1", apiKey: "k", model: "" }, { fetchImpl: impl });
    expect(noModel.ok).toBe(false);
    expect(noModel.error).toContain("模型名");
    const out = await testLlm({ baseUrl: "https://a.example/v1", apiKey: "k", model: "m" }, { fetchImpl: impl });
    expect(out.ok).toBe(true);
    expect(out.detail).toContain("对话端点");
    // 前两次调用分别是那两条 /models（顺序无关），最后一次才是退化出来的对话请求
    expect(calls[calls.length - 1].url).toBe("https://a.example/v1/chat/completions");
    expect(calls.filter((c) => c.url.endsWith("/chat/completions"))).toHaveLength(1);
  });

  it("testLlm：服务端只认 max_completion_tokens 时退让重试一次", async () => {
    const { impl, calls } = makeFetch((url, init) => {
      if (url.endsWith("/models")) return { status: 404, text: "not found" };
      const body = JSON.parse(init.body);
      return "max_tokens" in body ? { status: 400, text: "unknown parameter max_tokens" } : { json: { choices: [] } };
    });
    const out = await testLlm({ baseUrl: "https://a.example/v1", apiKey: "k", model: "m" }, { fetchImpl: impl });
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(3);
    expect(JSON.parse(calls[2].init.body)).toHaveProperty("max_completion_tokens", 1);
  });

  it("testLlm：401 直接判失败（不退化成对话），错误脱敏", async () => {
    const key = "sk-probe-secret-5533";
    const { impl, calls } = makeFetch(() => ({ status: 401, text: `bad key ${key}` }));
    const out = await testLlm({ baseUrl: "https://a.example/v1", apiKey: key, model: "m" }, { fetchImpl: impl });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(401);
    expect(out.error).not.toContain(key);
    expect(calls.length).toBe(1);
  });

  it("testImage：必须填模型；通了回体积，失败回脱敏原因", async () => {
    const { impl } = makeFetch(() => ({ json: { data: [{ b64_json: PNG.toString("base64") }] } }));
    const noModel = await testImage({ baseUrl: "https://a.example/v1", apiKey: "k", model: "" }, { fetchImpl: impl });
    expect(noModel.error).toContain("出图模型");
    const ok = await testImage({ baseUrl: "https://a.example/v1", apiKey: "k", model: "img" }, { fetchImpl: impl });
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain("KB");
    const fail = makeFetch(() => ({ status: 403, text: "quota exceeded" }));
    const bad = await testImage({ baseUrl: "https://a.example/v1", apiKey: "k", model: "img" }, { fetchImpl: fail.impl });
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(403);
    expect(bad.error).toContain("quota");
  });
});
