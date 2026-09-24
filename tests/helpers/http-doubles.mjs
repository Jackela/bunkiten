// HTTP 测试替身（tests/ 各层共用）：最小 JSON Response + 假 fetch 工厂。
//
// 收编的三份副本：
//   · `jsonResponse` —— tests/engine-login.test.ts 一份（另有两份在 tests/crafting.test.ts 与
//     tests/ui.test.tsx，那两个文件归别的 agent，本次不动）；
//   · `makeFetch` —— tests/credentials.test.ts（支持 json/text/bytes）与 tests/providers-catalog.test.ts
//     （只支持 text）各一份，签名统一成 `(url, init, call)`；回包面取超集。
// 真源只留这里一份。

/**
 * 最小 JSON Response（node 环境自带 Response；登录轮询等单测 stub 全局 fetch 时用）。
 * @param {unknown} body 响应体（会被 JSON.stringify）
 * @param {number} [status] 状态码
 * @returns {Response} 带 `application/json` 头的 Response
 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * 假 fetch 工厂：记录每次调用（`{url, init}`，按发生顺序），按 `route` 脚本回包。
 * 返回的 impl 覆盖 server 侧会读到的全部面：`ok` / `status` / `text()` / `json()` / `arrayBuffer()`。
 * @param {(url: string, init: any, call: number) => {status?: number, json?: unknown, text?: string, bytes?: Buffer}} route
 *   按调用次序决定回包（`call` 从 1 起）
 * @returns {{impl: typeof fetch, calls: Array<{url: string, init: any}>}} 假 fetch 与调用记录
 */
export function makeFetch(route) {
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  const impl = async (url, init) => {
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
  };
  return { impl: /** @type {any} */ (impl), calls };
}
