// 服务目录更新通道的集成覆盖（v1.10，docs/adr/0020）：真 acp-server 子进程 + 本地 mock 发布源。
//
// 这一层每条对着「改坏哪一处会红」：
//   · 启动期非阻塞抓取 + /api/providers 的 source 语义 → 改 acp-server.mjs 的 `void refreshCatalog()` 与 routes.mjs 的端点；
//   · 落盘 0600 / 目录 0700 / 缓存路径 → 改 server/providers-catalog.mjs 的 writeCatalogCache / catalogCachePath；
//   · 断源后仍吃缓存、离线回内置兜底 → 改 loadCatalog 的 cache-first 与 refreshCatalog 的静默失败。
//
// 两道既有闸（跨站 403 / body 5MB→413）由 http-util.mjs 的中间件统一覆盖、既有用例已测，这里不重复。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startStack } from "./harness.mjs";
import { PROVIDER_IDS } from "../../shared/providers.mjs";

/** mock 发布源的目录文档（一条一眼可辨的条目，用来证明「拿到的是远端那份」而不是内置表） */
const MOCK_DOC = {
  version: 1,
  updatedAt: "2026-01-02T03:04:05.000Z",
  providers: [{ id: "mock-only", label: "Mock 服务", kind: "llm", baseUrl: "https://mock.example/v1", models: [], note: "集成测试用发布源" }],
};

/** 起一个只回固定 JSON 的本地目录服务器（`BUNKITEN_PROVIDERS_URL` 指它） */
function startMockCatalog(payload: unknown) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as import("net").AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/providers.json`,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}

/** 轮询 /api/providers 直到 source 到期望值（启动期抓取是异步的；拿可见证据而不是 sleep） */
async function waitForSource(s: any, want: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = await s.getJSON("/api/providers");
    if (r.status === 200 && r.body?.source === want) return r.body;
    if (Date.now() > deadline) throw new Error(`timeout waiting for source=${want}（最后一次：${JSON.stringify(r.body)}）`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("服务目录更新通道（v1.10，docs/adr/0020）：远端 → 缓存 → 内置兜底", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-providers-home-"));
  const cacheFile = path.join(home, ".bunkiten", "providers.json");
  let mock: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    mock = await startMockCatalog(MOCK_DOC);
  });

  afterAll(async () => {
    await mock?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("① 启动抓远端：/api/providers 回 mock 目录（source=remote），并落盘 0600 / 目录 0700", async () => {
    const s = await startStack({
      extraEnv: { BUNKITEN_DISABLE_UPDATE: "0", BUNKITEN_PROVIDERS_URL: mock.url },
      homeDir: home,
    });
    try {
      const body = await waitForSource(s, "remote");
      expect(body.providers.map((p: any) => p.id)).toEqual(["mock-only"]);
      expect(typeof body.fetchedAt).toBe("string");
      expect(fs.existsSync(cacheFile)).toBe(true);
      expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(cacheFile)).mode & 0o777).toBe(0o700);
      const onDisk = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      expect(onDisk.providers.map((p: any) => p.id)).toEqual(["mock-only"]);
    } finally {
      await s.stop();
    }
  }, 15000);

  it("② 断源重启：缓存顶上（source=cache），不回内置表", async () => {
    // 把缓存时间戳改旧：否则 TTL 会直接跳过抓取，测不到「抓失败仍用缓存」这条
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    fs.writeFileSync(cacheFile, JSON.stringify({ ...cached, fetchedAt: "2020-01-01T00:00:00.000Z" }, null, 2) + "\n", { mode: 0o600 });
    await mock.close(); // 断源：mock 目录服务器停掉

    const s = await startStack({
      extraEnv: { BUNKITEN_DISABLE_UPDATE: "0", BUNKITEN_PROVIDERS_URL: mock.url },
      homeDir: home,
    });
    try {
      const r = await s.getJSON("/api/providers");
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("cache");
      expect(r.body.providers.map((p: any) => p.id)).toEqual(["mock-only"]);
      expect(r.body.fetchedAt).toBe("2020-01-01T00:00:00.000Z");
    } finally {
      await s.stop();
    }
  }, 15000);

  it("③ 全新 HOME + 抓不到：回内置兜底（source=bundled / fetchedAt=null），不写缓存", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-providers-fresh-"));
    const s = await startStack({
      extraEnv: { BUNKITEN_DISABLE_UPDATE: "0", BUNKITEN_PROVIDERS_URL: "http://127.0.0.1:1/providers.json" },
      homeDir: fresh,
    });
    try {
      const r = await s.getJSON("/api/providers");
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("bundled");
      expect(r.body.fetchedAt).toBe(null);
      expect(r.body.providers.map((p: any) => p.id)).toEqual([...PROVIDER_IDS]);
      expect(fs.existsSync(path.join(fresh, ".bunkiten", "providers.json"))).toBe(false);
    } finally {
      await s.stop();
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  }, 15000);
});
