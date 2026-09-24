// 服务目录更新通道的纯函数单测（v1.10，docs/adr/0020）：server/providers-catalog.mjs 的
// 校验 / 缓存读写 / 缓存优先 / 抓取三态。每条都对着「改坏哪一处会红」：
//   · 整包拒 vs 单条丢的两级取捨 → 改 validateCatalogDocument；
//   · https-only 与本机 http 例外 → 改 isAllowedBaseUrl；
//   · 长度上限 / 白名单字段 → 改 MAX_* 常量与 normalizeEntry；
//   · 目录 0700 / 文件 0600 / 原子写 / 坏缓存回落 → 改 readCatalogCache / writeCatalogCache；
//   · 缓存优先与进程内 memo → 改 catalogState；
//   · 两源并行取最新（updatedAt 最大者胜、并列取主源、缺失当最旧）、TTL 节流、两个兼容开关、失败静默 → 改 refreshCatalog / pickNewest；
//   · 读路径的 stale-while-revalidate（单飞、TTL 守卫、永不抛）→ 改 revalidateCatalog。
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CATALOG_FILENAME,
  CATALOG_TTL_MS,
  CATALOG_URLS,
  CATALOG_VERSION,
  catalogCachePath,
  loadCatalog,
  readCatalogCache,
  refreshCatalog,
  revalidateCatalog,
  validateCatalogDocument,
  writeCatalogCache,
  __resetCatalogMemo,
} from "../server/providers-catalog.mjs";
import { credentialsPath } from "../server/credentials.mjs";
import { PROVIDERS } from "../shared/providers.mjs";

/** 临时 HOME（真磁盘验 mode / 往返；结束即删） */
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-catalog-"));
}

/** 一条合法条目（over 覆盖字段造坏输入） */
function entry(over: any = {}) {
  return { id: "svc", label: "Svc", kind: "llm", baseUrl: "https://svc.example/v1", models: [], note: "说明", ...over };
}

/** 一份合法目录文档；updatedAt 传 null 表示**整键缺席**（验「缺失当最旧」） */
function doc(providers: any[] = [entry()], updatedAt: string | null = "2026-01-01T00:00:00.000Z") {
  const d: any = { version: CATALOG_VERSION, providers };
  if (updatedAt !== null) d.updatedAt = updatedAt;
  return d;
}

/** 假 fetch（记录调用；refreshCatalog 只读 res.ok 与 res.text()） */
function makeFetch(route: (url: string, call: number) => { status?: number; text?: string }) {
  const calls: { url: string }[] = [];
  const impl = (async (url: any) => {
    calls.push({ url: String(url) });
    const r = route(String(url), calls.length);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => r.text ?? "" };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  __resetCatalogMemo();
});

describe("validateCatalogDocument：整包取捨（形状坏拒整包）", () => {
  it("合法整包：逐字段搬过来（version 归一、updatedAt 可选）", () => {
    const out = validateCatalogDocument(doc());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.doc.version).toBe(CATALOG_VERSION);
    expect(out.doc.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(out.doc.providers).toEqual([entry()]);
  });

  it("非对象 / 数组 / null → 拒整包", () => {
    for (const bad of [null, undefined, "x", 42, [], [entry()]]) {
      expect(validateCatalogDocument(bad).ok, `应拒绝 ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("version 不认 / providers 不是数组 → 拒整包", () => {
    expect(validateCatalogDocument({ version: 2, providers: [entry()] }).ok).toBe(false);
    expect(validateCatalogDocument({ version: "1", providers: [entry()] }).ok).toBe(false);
    expect(validateCatalogDocument({ version: 1, providers: {} }).ok).toBe(false);
    expect(validateCatalogDocument({ version: 1 }).ok).toBe(false);
  });

  it("剔完一条不剩（全坏）→ 拒整包；坏一条留一条 → 收整包", () => {
    expect(validateCatalogDocument(doc([entry({ id: "Bad Id" })])).ok).toBe(false);
    const out = validateCatalogDocument(doc([entry({ id: "Bad Id" }), entry({ id: "good" })]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.doc.providers.map((p) => p.id)).toEqual(["good"]);
  });

  it("updatedAt 不是字符串就当没写（可选字段，不影响整包）", () => {
    const out = validateCatalogDocument({ version: 1, updatedAt: 123, providers: [entry()] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect("updatedAt" in out.doc).toBe(false);
  });
});

describe("validateCatalogDocument：单条规则（坏一条丢一条）", () => {
  it("id：非法形态 / 空 / 超长 丢该条", () => {
    for (const badId of ["UPPER", "a_b", "-lead", "trail-", "a b", "", "x".repeat(41)]) {
      const out = validateCatalogDocument(doc([entry({ id: badId })]));
      expect(out.ok, `id「${badId}」应被丢`).toBe(false);
    }
  });

  it("id 重复丢后来者，保持首现顺序", () => {
    const out = validateCatalogDocument(
      doc([entry({ id: "dup", label: "第一次" }), entry({ id: "dup", label: "第二次" }), entry({ id: "tail" })]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.doc.providers.map((p) => `${p.id}:${p.label}`)).toEqual(["dup:第一次", "tail:Svc"]);
  });

  it("label：空 / 超长 丢该条", () => {
    expect(validateCatalogDocument(doc([entry({ label: "" })])).ok).toBe(false);
    expect(validateCatalogDocument(doc([entry({ label: "x".repeat(81) })])).ok).toBe(false);
  });

  it("kind 只认 llm / image / both", () => {
    for (const kind of ["llm", "image", "both"]) {
      expect(validateCatalogDocument(doc([entry({ kind })])).ok, `${kind} 应被收`).toBe(true);
    }
    expect(validateCatalogDocument(doc([entry({ kind: "audio" })])).ok).toBe(false);
  });

  it("地址留空必须有 note；非空 note 随条带出", () => {
    expect(validateCatalogDocument(doc([entry({ baseUrl: "", note: "" })])).ok).toBe(false);
    expect(validateCatalogDocument(doc([entry({ baseUrl: "", note: undefined })])).ok).toBe(false);
    const out = validateCatalogDocument(doc([entry({ baseUrl: "", note: "按部署填" })]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.doc.providers[0]).toEqual({
      id: "svc",
      label: "Svc",
      kind: "llm",
      baseUrl: "",
      models: [],
      note: "按部署填",
    });
  });

  it("https-only：远端 http 拒，https 收，本机 http://localhost / http://127.0.0.1 例外", () => {
    expect(validateCatalogDocument(doc([entry({ baseUrl: "http://api.example.com/v1" })])).ok).toBe(false);
    expect(validateCatalogDocument(doc([entry({ baseUrl: "ftp://api.example.com/v1" })])).ok).toBe(false);
    expect(validateCatalogDocument(doc([entry({ baseUrl: "not a url" })])).ok).toBe(false);
    expect(validateCatalogDocument(doc([entry({ baseUrl: "https://api.example.com/v1" })])).ok).toBe(true);
    expect(validateCatalogDocument(doc([entry({ baseUrl: "http://localhost:11434/v1" })])).ok).toBe(true);
    expect(validateCatalogDocument(doc([entry({ baseUrl: "http://127.0.0.1:1234/v1" })])).ok).toBe(true);
    // 本机域名变体不算（只认字面 localhost / 127.0.0.1）
    expect(validateCatalogDocument(doc([entry({ baseUrl: "http://localhost.evil.com/v1" })])).ok).toBe(false);
  });

  it("models：条数与单项长度上限，越界丢该条；imageModels 可选、坏则丢该条", () => {
    expect(validateCatalogDocument(doc([entry({ models: Array.from({ length: 51 }, (_, i) => `m${i}`) })])).ok).toBe(
      false,
    );
    expect(validateCatalogDocument(doc([entry({ models: ["ok", ""] })])).ok).toBe(false);
    expect(validateCatalogDocument(doc([entry({ models: ["x".repeat(201)] })])).ok).toBe(false);
    expect(validateCatalogDocument(doc([entry({ models: ["deepseek-chat"] })])).ok).toBe(true);
    expect(validateCatalogDocument(doc([entry({ models: [], imageModels: ["gpt-image-1"] })])).ok).toBe(true);
    expect(validateCatalogDocument(doc([entry({ models: [], imageModels: "nope" })])).ok).toBe(false);
  });

  it("只搬白名单字段：远端的未知键一律丢掉（不进 GUI 视图）", () => {
    const out = validateCatalogDocument(doc([entry({ secret: "x", __proto__: { polluted: true } })]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.doc.providers[0]).sort()).toEqual(["baseUrl", "id", "kind", "label", "models", "note"]);
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("缓存读写与权限", () => {
  it("write→read 往返一致，目录 0700 / 文件 0600，且原子写没有残留 tmp", () => {
    const home = tmpHome();
    try {
      expect(writeCatalogCache(home, doc(), "2026-04-04T00:00:00.000Z")).toBe(true);
      const back = readCatalogCache(home);
      expect(back?.providers).toEqual([entry()]);
      expect(back?.fetchedAt).toBe("2026-04-04T00:00:00.000Z");
      const file = catalogCachePath(home);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(path.dirname(file))).toEqual([CATALOG_FILENAME]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("缓存路径复用凭据目录 ~/.bunkiten（不抄第二份目录名）", () => {
    const home = tmpHome();
    try {
      expect(path.dirname(catalogCachePath(home))).toBe(path.dirname(credentialsPath(home)));
      expect(catalogCachePath(home).endsWith(path.join(".bunkiten", CATALOG_FILENAME))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("坏缓存当无缓存：坏 JSON / 数组 / 版本不认 / 校验不过一律 null，永不抛", () => {
    const home = tmpHome();
    try {
      expect(readCatalogCache(home)).toBe(null); // 文件都没有
      fs.mkdirSync(path.dirname(catalogCachePath(home)), { recursive: true });
      fs.writeFileSync(catalogCachePath(home), "{ this is not json");
      expect(readCatalogCache(home)).toBe(null);
      fs.writeFileSync(catalogCachePath(home), JSON.stringify([1, 2, 3]));
      expect(readCatalogCache(home)).toBe(null);
      fs.writeFileSync(catalogCachePath(home), JSON.stringify({ version: 99, providers: [entry()] }));
      expect(readCatalogCache(home)).toBe(null);
      fs.writeFileSync(catalogCachePath(home), JSON.stringify(doc([entry({ baseUrl: "http://evil.example/v1" })])));
      expect(readCatalogCache(home)).toBe(null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("写路径永不抛：root 指到一个文件时回 false", () => {
    const home = tmpHome();
    try {
      const asFile = path.join(home, "a-file");
      fs.writeFileSync(asFile, "x");
      expect(writeCatalogCache(asFile, doc())).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("loadCatalog：缓存优先 → 内置兜底（进程内 memo）", () => {
  it("无缓存 → 内置表，source=bundled / fetchedAt=null", () => {
    const home = tmpHome();
    try {
      const out = loadCatalog({ root: home });
      expect(out.source).toBe("bundled");
      expect(out.fetchedAt).toBe(null);
      expect(out.providers).toEqual(PROVIDERS);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("有缓存 → 吃缓存，source=cache / fetchedAt=缓存时间", () => {
    const home = tmpHome();
    try {
      writeCatalogCache(home, doc([entry({ id: "from-cache" })]), "2026-05-05T00:00:00.000Z");
      const out = loadCatalog({ root: home });
      expect(out.source).toBe("cache");
      expect(out.fetchedAt).toBe("2026-05-05T00:00:00.000Z");
      expect(out.providers.map((p) => p.id)).toEqual(["from-cache"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("进程内 memo：一次解析后不再读盘（磁盘换了也只回第一次那份）", () => {
    const home = tmpHome();
    try {
      writeCatalogCache(home, doc([entry({ id: "first" })]));
      expect(loadCatalog({ root: home }).providers.map((p) => p.id)).toEqual(["first"]);
      writeCatalogCache(home, doc([entry({ id: "second" })]));
      expect(loadCatalog({ root: home }).providers.map((p) => p.id)).toEqual(["first"]);
      __resetCatalogMemo();
      expect(loadCatalog({ root: home }).providers.map((p) => p.id)).toEqual(["second"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("refreshCatalog：两源并行取最新、抓取三态与 TTL 节流", () => {
  it("两源都有效 → 两源都抓，落盘 0600 + memo 变 remote", async () => {
    const home = tmpHome();
    try {
      const { impl, calls } = makeFetch(() => ({ text: JSON.stringify(doc([entry({ id: "remote-only" })])) }));
      const now = Date.parse("2026-06-06T00:00:00.000Z");
      const out = await refreshCatalog({ root: home, fetchImpl: impl, env: {}, now });
      expect(out.ok).toBe(true);
      // 两源并行都打（不是首个有效即止）：调用顺序即 CATALOG_URLS 顺序
      expect(calls.map((c) => c.url)).toEqual([...CATALOG_URLS]);
      const loaded = loadCatalog({ root: home });
      expect(loaded.source).toBe("remote");
      expect(loaded.fetchedAt).toBe("2026-06-06T00:00:00.000Z");
      expect(loaded.providers.map((p) => p.id)).toEqual(["remote-only"]);
      const file = catalogCachePath(home);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).fetchedAt).toBe("2026-06-06T00:00:00.000Z");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("两源都有效但 updatedAt 不同 → 取**新**的那份（落盘与 memo 都是它）", async () => {
    const home = tmpHome();
    try {
      // 主源（jsDelivr）吐旧目录、备源（raw）吐新目录：取新，证明没有被「主源可用即止」拖住
      const { impl, calls } = makeFetch((url) =>
        url === CATALOG_URLS[0]
          ? { text: JSON.stringify(doc([entry({ id: "old" })], "2026-01-01T00:00:00.000Z")) }
          : { text: JSON.stringify(doc([entry({ id: "new" })], "2026-06-06T00:00:00.000Z")) },
      );
      const out = await refreshCatalog({ root: home, fetchImpl: impl, env: {} });
      expect(out.ok).toBe(true);
      expect(calls.map((c) => c.url)).toEqual([...CATALOG_URLS]);
      expect(loadCatalog({ root: home }).providers.map((p) => p.id)).toEqual(["new"]); // memo
      const onDisk = JSON.parse(fs.readFileSync(catalogCachePath(home), "utf8"));
      expect(onDisk.providers.map((p: any) => p.id)).toEqual(["new"]); // 落盘
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("只有备用源有效 → 用它（原「先主后备」行为的等价物）", async () => {
    const home = tmpHome();
    try {
      const { impl, calls } = makeFetch((url) =>
        url === CATALOG_URLS[0]
          ? { status: 503, text: "cdn down" }
          : { text: JSON.stringify(doc([entry({ id: "backup" })])) },
      );
      const out = await refreshCatalog({ root: home, fetchImpl: impl, env: {} });
      expect(out.ok).toBe(true);
      expect(calls.map((c) => c.url)).toEqual([...CATALOG_URLS]); // 两源都试过
      expect(loadCatalog({ root: home }).providers.map((p) => p.id)).toEqual(["backup"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("时间戳：缺失/解析不出当最旧（有戳的那份赢）；完全并列取靠前源（主源）", async () => {
    // 其一：主源缺 updatedAt、备源有戳 → 备源赢（缺失不压过有戳）
    const h1 = tmpHome();
    const h2 = tmpHome();
    try {
      const { impl: impl1 } = makeFetch((url) =>
        url === CATALOG_URLS[0]
          ? { text: JSON.stringify(doc([entry({ id: "no-stamp" })], null)) }
          : { text: JSON.stringify(doc([entry({ id: "stamped" })], "2020-01-01T00:00:00.000Z")) },
      );
      expect((await refreshCatalog({ root: h1, fetchImpl: impl1, env: {} })).ok).toBe(true);
      expect(loadCatalog({ root: h1 }).providers.map((p) => p.id)).toEqual(["stamped"]);

      // 其二：两源都缺戳（并列）→ 取靠前源（CATALOG_URLS[0]）
      __resetCatalogMemo();
      const { impl: impl2 } = makeFetch((url) =>
        url === CATALOG_URLS[0]
          ? { text: JSON.stringify(doc([entry({ id: "first-src" })], null)) }
          : { text: JSON.stringify(doc([entry({ id: "second-src" })], null)) },
      );
      expect((await refreshCatalog({ root: h2, fetchImpl: impl2, env: {} })).ok).toBe(true);
      expect(loadCatalog({ root: h2 }).providers.map((p) => p.id)).toEqual(["first-src"]);
    } finally {
      fs.rmSync(h1, { recursive: true, force: true });
      fs.rmSync(h2, { recursive: true, force: true });
    }
  });

  it("全省失败 / 坏文档：静默失败，不落盘，继续内置兜底", async () => {
    for (const reply of [
      { status: 500, text: "boom" },
      { text: "not json at all" },
      { text: JSON.stringify({ version: 1, providers: [entry({ id: "Bad Id" })] }) },
    ]) {
      const home = tmpHome();
      try {
        __resetCatalogMemo();
        const { impl } = makeFetch(() => reply);
        const out = await refreshCatalog({ root: home, fetchImpl: impl, env: {} });
        expect(out.ok).toBe(false);
        expect(readCatalogCache(home)).toBe(null);
        expect(loadCatalog({ root: home }).source).toBe("bundled");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("TTL：本地副本还新鲜就不打扰发布源；过期（或时间戳不可信）才抓（用 CATALOG_TTL_MS 推算）", async () => {
    const now = Date.parse("2026-07-07T00:00:00.000Z");
    // 新鲜（TTL - 1s）→ 不抓；边界（正好 TTL）与过期（TTL + 1s）→ 抓。别写死时长，全按导出的常量推算
    const fresh = tmpHome();
    const boundary = tmpHome();
    const stale = tmpHome();
    try {
      writeCatalogCache(fresh, doc([entry({ id: "fresh" })]), new Date(now - (CATALOG_TTL_MS - 1000)).toISOString());
      const a = makeFetch(() => ({ text: JSON.stringify(doc()) }));
      expect((await refreshCatalog({ root: fresh, fetchImpl: a.impl, env: {}, now })).ok).toBe(false);
      expect(a.calls.length).toBe(0);

      // 过期：真的抓（两源并行 → 一轮 = CATALOG_URLS.length 次）
      __resetCatalogMemo(); // memo 是进程级的（生产里 root 恒为 HOME，测试换了 root 要清）
      writeCatalogCache(boundary, doc([entry({ id: "boundary" })]), new Date(now - CATALOG_TTL_MS).toISOString());
      const c = makeFetch(() => ({ text: JSON.stringify(doc([entry({ id: "refreshed-0" })])) }));
      expect((await refreshCatalog({ root: boundary, fetchImpl: c.impl, env: {}, now })).ok).toBe(true);
      expect(c.calls.length).toBe(CATALOG_URLS.length);

      __resetCatalogMemo();
      writeCatalogCache(stale, doc([entry({ id: "stale" })]), new Date(now - CATALOG_TTL_MS - 60 * 1000).toISOString());
      const b = makeFetch(() => ({ text: JSON.stringify(doc([entry({ id: "refreshed" })])) }));
      expect((await refreshCatalog({ root: stale, fetchImpl: b.impl, env: {}, now })).ok).toBe(true);
      expect(b.calls.length).toBe(CATALOG_URLS.length);
      expect(loadCatalog({ root: stale }).providers.map((p) => p.id)).toEqual(["refreshed"]);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
      fs.rmSync(boundary, { recursive: true, force: true });
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });

  it("BUNKITEN_DISABLE_UPDATE=1 直接跳过（打包冒烟口径）", async () => {
    const home = tmpHome();
    try {
      const { impl, calls } = makeFetch(() => ({ text: JSON.stringify(doc()) }));
      const out = await refreshCatalog({ root: home, fetchImpl: impl, env: { BUNKITEN_DISABLE_UPDATE: "1" } });
      expect(out.ok).toBe(false);
      expect(calls.length).toBe(0);
      expect(readCatalogCache(home)).toBe(null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("BUNKITEN_PROVIDERS_URL 覆盖源：只打这一个（测试/镜像口径；单源语义不变）", async () => {
    const home = tmpHome();
    try {
      const { impl, calls } = makeFetch(() => ({ text: JSON.stringify(doc([entry({ id: "mirror" })])) }));
      const out = await refreshCatalog({
        root: home,
        fetchImpl: impl,
        env: { BUNKITEN_PROVIDERS_URL: "http://127.0.0.1:9/providers.json" },
      });
      expect(out.ok).toBe(true);
      expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:9/providers.json"]);
      expect(loadCatalog({ root: home }).providers.map((p) => p.id)).toEqual(["mirror"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("revalidateCatalog：读路径的 stale-while-revalidate（单飞 / TTL 守卫 / 永不抛）", () => {
  it("新鲜缓存 → 零请求（TTL 守卫照用，一次网络都不打）", async () => {
    const now = Date.parse("2026-08-08T00:00:00.000Z");
    const home = tmpHome();
    try {
      writeCatalogCache(home, doc([entry({ id: "fresh" })]), new Date(now - 60 * 1000).toISOString());
      const { impl, calls } = makeFetch(() => ({ text: JSON.stringify(doc()) }));
      const out = await revalidateCatalog({ root: home, fetchImpl: impl, env: {}, now });
      expect(out.ok).toBe(false);
      expect(calls.length).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("过期缓存 → 真的抓一轮并落地（memo 变 remote）", async () => {
    const now = Date.parse("2026-08-08T00:00:00.000Z");
    const home = tmpHome();
    try {
      writeCatalogCache(home, doc([entry({ id: "stale" })]), new Date(now - CATALOG_TTL_MS - 1000).toISOString());
      const { impl, calls } = makeFetch(() => ({ text: JSON.stringify(doc([entry({ id: "refreshed" })])) }));
      const out = await revalidateCatalog({ root: home, fetchImpl: impl, env: {}, now });
      expect(out.ok).toBe(true);
      expect(calls.length).toBe(CATALOG_URLS.length);
      const loaded = loadCatalog({ root: home });
      expect(loaded.source).toBe("remote");
      expect(loaded.providers.map((p) => p.id)).toEqual(["refreshed"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("并发调用只发一轮（单飞：同一在途 Promise 被复用）", async () => {
    const now = Date.parse("2026-08-08T00:00:00.000Z");
    const home = tmpHome();
    try {
      writeCatalogCache(home, doc([entry({ id: "stale" })]), new Date(now - CATALOG_TTL_MS - 1000).toISOString());
      const { impl, calls } = makeFetch(() => ({ text: JSON.stringify(doc([entry({ id: "once" })])) }));
      const p1 = revalidateCatalog({ root: home, fetchImpl: impl, env: {}, now });
      const p2 = revalidateCatalog({ root: home, fetchImpl: impl, env: {}, now });
      const p3 = revalidateCatalog({ root: home, fetchImpl: impl, env: {}, now });
      expect(p2).toBe(p1); // 进程内一个在途 Promise 复用
      expect(p3).toBe(p1);
      await Promise.all([p1, p2, p3]);
      expect(calls.length).toBe(CATALOG_URLS.length); // 一轮 = 两源各一次，不是三轮
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("永不抛：fetchImpl 直接抛也只回 {ok:false}（返回的 Promise 不 reject）", async () => {
    const now = Date.parse("2026-08-08T00:00:00.000Z");
    const home = tmpHome();
    try {
      writeCatalogCache(home, doc([entry({ id: "stale" })]), new Date(now - CATALOG_TTL_MS - 1000).toISOString());
      const impl = (async () => {
        throw new Error("network exploded");
      }) as unknown as typeof fetch;
      await expect(revalidateCatalog({ root: home, fetchImpl: impl, env: {}, now })).resolves.toEqual({ ok: false });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
