// 「测试连接」（v1.10，docs/adr/0019）：POST /api/credentials/test 的实作——真的打一次服务，
// 回 `{ok, status, ms, error?}`。纯 IO 逻辑（fetch 可注入），路由只做读凭据 + 脱敏 + 回包。
//
// 为什么 LLM 侧先试 GET {baseUrl}/models：这既是我们自己会打的端点（第 0 步实证：grok CLI 的
// GROK_MODELS_BASE_URL 通道第一步就是拉 /models），也最省——不消耗生成额度。有些网关不暴露
// /models（404/405/501），退化成一次最小 completion：那才是真正证明「能对话」的那一步。
//
// 图片侧没有便宜的探活：兼容服务的 /models 通常只列对话模型，HEAD 也不保证实现。按 ADR-0019
// 的取舍做一次最小生成（小提示词、n=1、用户配的尺寸），成本是玩家点「测试连接」时要付的那一点点。
import { requestImage } from "./media-mcp.mjs";
import { sanitizeErrorMessage } from "./credentials.mjs";
import { errName, errText } from "./errors.mjs";
import { joinEndpoint, withTimeoutSignal } from "./http-util.mjs";

/** 探活的单次 HTTP 上限（毫秒）：连接测试要快，不能像回合那样等 90s */
export const PROBE_TIMEOUT_MS = 15_000;

/** 测试用的最小出图尺寸（不占额度大头，也不挑服务的常见档位） */
export const PROBE_IMAGE_SIZE = "1024x1024";

/**
 * 一次带超时的 fetch，永不抛：网络错误/超时统一成 `{error}`。
 * @param {typeof fetch} fetchImpl fetch 实现
 * @param {string} url 地址
 * @param {RequestInit} init 请求
 * @param {number} timeoutMs 超时
 * @returns {Promise<{res: Response} | {error: string}>}
 */
async function fetchSafe(fetchImpl, url, init, timeoutMs) {
  const t = withTimeoutSignal(timeoutMs, "probe");
  try {
    return { res: await fetchImpl(url, { ...init, signal: t.signal }) };
  } catch (e) {
    return {
      error:
        errName(e) === "AbortError" || /timeout/.test(errText(e))
          ? `连接超时（${Math.round(timeoutMs / 1000)}s）`
          : `连不上：${errText(e)}`,
    };
  } finally {
    t.clear();
  }
}

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} ok 通了没有
 * @property {number} status 最后一次 HTTP 状态（连不上时为 0）
 * @property {number} ms 墙钟耗时
 * @property {string} [error] 失败原因（已脱敏、已截断）
 * @property {string} [detail] 成功时的补充（如模型条数）
 */

/**
 * 测 LLM 连接：GET {baseUrl}/models；不支持（404/405/501）时退化为一次最小 completion。
 * @param {{baseUrl: string, apiKey: string, model?: string}} cfg 凭据（明文只在这次请求里用）
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [deps] 依赖注入（单测传假 fetch）
 * @returns {Promise<ProbeResult>} 结果（永不抛）
 */
export async function testLlm({ baseUrl, apiKey, model = "" }, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();
  const done = (/** @type {Partial<ProbeResult> & {ok: boolean, status: number}} */ r) => ({
    ok: r.ok,
    status: r.status,
    ms: Date.now() - started,
    ...(r.error ? { error: r.error } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
  });
  const trim = (/** @type {string} */ s) => sanitizeErrorMessage(s, [apiKey]);
  if (!baseUrl) return done({ ok: false, status: 0, error: "还没填服务地址" });
  if (!apiKey) return done({ ok: false, status: 0, error: "还没填密钥" });

  const headers = { authorization: `Bearer ${apiKey}` };
  const models = await fetchSafe(fetchImpl, joinEndpoint(baseUrl, "/models"), { headers }, timeoutMs);
  if ("error" in models) return done({ ok: false, status: 0, error: models.error });
  if (models.res.ok) {
    // 模型条数只是锦上添花：解析失败不影响「通了」这个结论
    let detail;
    try {
      const body = /** @type {any} */ (await models.res.json());
      const n = Array.isArray(body?.data) ? body.data.length : 0;
      if (n > 0) detail = `服务列出了 ${n} 个模型`;
    } catch {}
    return done({ ok: true, status: models.res.status, detail });
  }
  const canFallback = [404, 405, 501].includes(models.res.status);
  if (!canFallback) {
    const text = await models.res.text().catch(() => "");
    return done({
      ok: false,
      status: models.res.status,
      error: trim(`HTTP ${models.res.status} ${text.slice(0, 200)}`),
    });
  }
  if (!model)
    return done({
      ok: false,
      status: models.res.status,
      error: "服务没有模型清单接口（HTTP " + models.res.status + "）：请先填模型名再测",
    });

  // 退化路径：一次最小 completion（max_tokens 与 max_completion_tokens 二选一，看服务端认哪个）
  /** @type {Record<string, unknown>} */
  let body = { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchSafe(
      fetchImpl,
      joinEndpoint(baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if ("error" in r) return done({ ok: false, status: 0, error: r.error });
    if (r.res.ok) return done({ ok: true, status: r.res.status, detail: "对话端点可用" });
    const text = await r.res.text().catch(() => "");
    if (attempt === 0 && r.res.status === 400 && /max_tokens/.test(text)) {
      body = { model, messages: [{ role: "user", content: "ping" }], max_completion_tokens: 1 };
      continue;
    }
    return done({ ok: false, status: r.res.status, error: trim(`HTTP ${r.res.status} ${text.slice(0, 200)}`) });
  }
  return done({ ok: false, status: 0, error: "对话端点不接受最小请求" });
}

/**
 * 测图片服务：做一次最小生成（真的是能出图才算通）。
 * 复用 media-mcp 的 requestImage——测试与真出图共用一条实现，不会两处漂移。
 * @param {{baseUrl: string, apiKey: string, model?: string, size?: string}} cfg 图片凭据
 * @param {{fetchImpl?: typeof fetch}} [deps] 依赖注入
 * @returns {Promise<ProbeResult>} 结果（永不抛）
 */
export async function testImage({ baseUrl, apiKey, model = "", size = "" }, deps = {}) {
  const started = Date.now();
  if (!baseUrl) return { ok: false, status: 0, ms: 0, error: "还没填服务地址" };
  if (!apiKey) return { ok: false, status: 0, ms: 0, error: "还没填密钥" };
  if (!model) return { ok: false, status: 0, ms: 0, error: "还没填出图模型" };
  const out = await requestImage({
    baseUrl,
    apiKey,
    model,
    prompt: "一个红色圆点（连接测试）",
    size: size || PROBE_IMAGE_SIZE,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  const ms = Date.now() - started;
  if ("error" in out) return { ok: false, status: out.status ?? 0, ms, error: out.error };
  return { ok: true, status: out.status, ms, detail: `已生成 ${Math.round(out.bytes.length / 1024)} KB 测试图` };
}
