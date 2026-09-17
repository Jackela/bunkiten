// HTTP 层小工具（v1.7 拆模块）：本地端点防护（来源校验 + body 上限）、静态托管的 MIME 表与目录解析。
// 入口 server/acp-server.mjs re-export isCrossSiteRequest/readBodyText（tests/integration 与入口路由用）；
// MIME/resolveAppDist 由 server/routes.mjs 的 /app 路由消费。
import fs from "fs";
import path from "path";
import { GAME_ROOT } from "./config.mjs";

// ---------- 本地端点防护（v1.6）：来源校验 + body 上限 ----------
// 这个 server 只服务本机（Electron / vite dev / curl），不对外开放。跨站请求一律 403（CSRF/端口探测），
// 但**无 Origin 的非浏览器客户端（curl/集成测试）与同源请求（Electron 打包态 /app）必须放行**——
// Electron 生产态从 http://127.0.0.1:<port>/app 同源请求，vite dev 从 http://localhost:5173 请求（同机来源）。
const MAX_BODY_BYTES = 5 * 1024 * 1024; // POST body 上限 5MB（世界 bundle / 提示词都远小于此）
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

/**
 * 是不是应当拒绝的跨站请求：sec-fetch-site=cross-site 一律拒；带了 Origin 就必须是本机来源。
 * 无 Origin（非浏览器客户端）一律放行——这是 curl / 集成测试 / Electron 同源请求的正常形态。
 * @param {import("http").IncomingMessage} req
 * @returns {boolean} 命中即调用方回 403
 */
export function isCrossSiteRequest(req) {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return true;
  const origin = req.headers.origin;
  return typeof origin === "string" && origin !== "" && !LOCAL_ORIGIN_RE.test(origin);
}

/**
 * 读 POST 的 JSON body：累积上限默认 5MB，超限回 413 并断连；否则把原文交给 onEnd（调用方自行 JSON.parse）。
 * 统一入口让 /prompt、/api/worlds、/api/assets 共用同一上限，避免逐路由各写一份累积逻辑。
 * maxBytes 可选（v1.7）：只有 POST /api/presets 导入传 50MB（包里是 base64 图片/音频），其余调用点零改动。
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {(body: string) => void} onEnd
 * @param {number} [maxBytes] 累积上限（缺省 MAX_BODY_BYTES=5MB）
 */
export function readBodyText(req, res, onEnd, maxBytes = MAX_BODY_BYTES) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let done = false;
  req.on("data", (c) => {
    if (done) return;
    size += c.length;
    if (size > maxBytes) {
      done = true;
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      // 先把 413 刷出去再销毁连接（销毁延后一拍：立即 destroy 会用 RST 把刚发出的响应从客户端接收缓冲里丢掉）
      res.end(JSON.stringify({ error: `请求体过大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）` }), () => {
        const t = setTimeout(() => req.destroy(), 10);
        t.unref?.();
      });
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (done) return;
    done = true;
    onEnd(Buffer.concat(chunks).toString("utf8"));
  });
  req.on("error", () => {
    done = true; // 客户端提前断开：不再回调，静默收尾
  });
}

// 扩展名 → Content-Type（键即 MIME 表，任意扩展名可查、查不到回落 octet-stream——所以是 Record 而非字面量键集）
/** @type {Record<string, string>} */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// 打包布局（resources/app-dist）优先，开发布局（GAME_ROOT/dist）兜底；都不存在则 /app 返回 404
function resolveAppDist() {
  for (const dir of [path.resolve(GAME_ROOT, "..", "app-dist"), path.join(GAME_ROOT, "dist")]) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

export { MIME, resolveAppDist };
