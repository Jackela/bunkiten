// 本地假图片服务（**只用于测试，不发真网络**）：给「引擎 → MCP 出图工具（server/media-mcp.mjs）
// → 玩家自备的 OpenAI 兼容图片服务 → 落盘 presets/<id>/assets/」这条链路一个**确定性、离线**的替身。
//
// 为什么要它：真链路（tests/e2e-packaged/real-image.spec.ts）要真凭据、真花一次对话与一张图、还要出网；
// MCP 握手冒烟只验「命令跑得起来 + tools/list」。两者之间的「tools/call → POST /v1/images/generations
// → 字节落盘 → 【图】标记」从没被确定性地测穿过——本模块就是补这一段的假服务端。
//
// 实现（零依赖，只用一个本地 http server）：
//   · `POST /v1/images/generations`：读请求体 → 记一条 `calls` → 回一张**真实的小 JPEG**。
//     缺省回 `{created, data:[{b64_json}]}`（media-mcp 的缺省请求就是 `response_format:"b64_json"`）；
//     请求体 `response_format:"url"` 或 URL 带 `?mode=url` 时回 `{created, data:[{url}]}`，
//     并自己直服 `GET /v1/mock-image.jpg`（覆盖 media-mcp 的 url 回包 → 下载分支）。
//   · 其余路径一律 404（便于发现打错端点）。
//
// 用法（vitest 集成用例 / Playwright spec 里）：
//   const mock = await startMockImageServer();
//   // 把图片凭据的 baseUrl 指到 `mock.base`（形如 http://127.0.0.1:<port>/v1；media-mcp 会接 /images/generations）
//   // ……跑链路……
//   mock.calls          // [{url, method, headers, body, prompt, model, size, response_format}] 供断言
//   mock.imageBytes     // 假服务返回的那张 JPEG 的字节（与落盘字节逐字比对）
//   await mock.close()  // 收尾（关掉监听端口）
//
// 返回对象形状固定为 `{ base, calls, close }`（另有 `imageBytes` / `jpegBase64` 两个便利字段）。
import http from "node:http";

/**
 * 一张真实的小 JPEG（1×1 像素，160 字节）——几十~几百字节量级，足够做「落盘字节 == 回包字节」的断言。
 * 与 tests/integration/credentials.test.ts 里的 TINY_JPEG 同源（同一张图，两处都只是测试夹具，不互相 import）。
 */
export const MOCK_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/**
 * 起一个本地假图片服务。
 * @returns {Promise<{
 *   base: string,                                    // 形如 http://127.0.0.1:<port>/v1（credentials.image.baseUrl 用它）
 *   calls: Array<{url: string, method: string, headers: import("node:http").IncomingHttpHeaders,
 *     body: any, prompt: string|null, model: string|null, size: string|null, response_format: string|null}>,
 *   imageBytes: Buffer,                              // 返回的那张 JPEG 的字节
 *   jpegBase64: string,                              // 同一张图的 base64
 *   close: () => Promise<void>,                      // 关掉监听端口
 * }>}
 */
export async function startMockImageServer() {
  /** @type {Array<any>} */
  const calls = [];
  const imageBytes = Buffer.from(MOCK_JPEG_BASE64, "base64");
  /** @type {string} listen 之后才知道端口：origin 拼直服 URL、base（origin + /v1）给凭据的 baseUrl */
  let origin = "";
  let base = "";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    // url 形态的直服：media-mcp 拿到 data[0].url 后会自己来下载这张图
    if (req.method === "GET" && url.pathname === "/v1/mock-image.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(imageBytes);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        /** @type {any} */
        let parsed = {};
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          /* 坏 JSON 也照记（空的），回包仍走缺省 b64_json */
        }
        calls.push({
          url: req.url || "",
          method: req.method || "",
          headers: req.headers,
          body: parsed,
          prompt: parsed.prompt ?? null,
          model: parsed.model ?? null,
          size: parsed.size ?? null,
          response_format: parsed.response_format ?? null,
        });
        const wantUrl = parsed.response_format === "url" || url.searchParams.get("mode") === "url";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            wantUrl
              ? { created: 1, data: [{ url: `${origin}/v1/mock-image.jpg` }] }
              : { created: 1, data: [{ b64_json: MOCK_JPEG_BASE64 }] },
          ),
        );
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  origin = `http://127.0.0.1:${addr.port}`;
  base = `${origin}/v1`;
  return {
    base,
    calls,
    imageBytes,
    jpegBase64: MOCK_JPEG_BASE64,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
