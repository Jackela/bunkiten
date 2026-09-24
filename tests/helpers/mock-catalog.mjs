// 服务目录在线通道的本地 mock 发布源（tests/integration/ 的 credentials 与 providers-catalog 两处共用）。
//
// 收编的两份副本：tests/integration/credentials.test.ts 的 `startMockCatalog`（只回固定文档、无计数）
// 与 tests/integration/providers-catalog.test.ts 的 `startMockCatalog`（payload + failFirst + 请求计数，
// 是超集）——统一成这一份超集；`waitForSource` 两处逐字相同，也收在这里。
import http from "node:http";

/**
 * 起一个只回固定 JSON 的本地目录服务器（`BUNKITEN_PROVIDERS_URL` 指它），并记录请求数。
 * @param {unknown} payload 固定回的 JSON
 * @param {object} [opts]
 * @param {boolean} [opts.failFirst] 首个请求回 **503**、其后回 200——用来把**启动期**那次抓取挡掉，
 *   让「成功的那次」只能来自 `GET /api/providers` 触发的后台 revalidate（把因果钉死，不靠时序巧合）
 * @returns {Promise<{url: string, count: () => number, close: () => Promise<void>}>} url = 发布源地址；count = 请求数；close = 收尾
 */
export function startMockCatalog(payload, { failFirst = false } = {}) {
  /** @type {string[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (failFirst && requests.length === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("starting up");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = /** @type {import("net").AddressInfo} */ (server.address()).port;
      resolve({
        url: `http://127.0.0.1:${port}/providers.json`,
        count: () => requests.length,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}

/**
 * 轮询 /api/providers 直到 source 到期望值（启动期抓取是异步的；拿可见证据而不是 sleep）。
 * @param {{getJSON: (p: string) => Promise<{status: number, body: any}>}} stack 集成栈句柄
 * @param {string} want 期望的 source（bundled / cache / remote）
 * @param {number} [timeout] 上限（ms）
 * @returns {Promise<any>} 命中时的 /api/providers 响应体
 */
export async function waitForSource(stack, want, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = await stack.getJSON("/api/providers");
    if (r.status === 200 && r.body?.source === want) return r.body;
    if (Date.now() > deadline)
      throw new Error(`timeout waiting for source=${want}（最后一次：${JSON.stringify(r.body)}）`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
