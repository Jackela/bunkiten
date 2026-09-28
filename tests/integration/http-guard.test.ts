// 集成测试（v1.6）：本地端点来源校验（403）+ POST body 上限（413）+ GET /api/history?seq= 只回目标条目
// + GET /app 的尾斜杠 302（v1.9）+ v1.14 新端点的同一组门禁与 SSE 帧格式（id/心跳）。
// 同栈形态：假 ACP 引擎（PATH 垫片 bin/grok）+ 真 server/acp-server.mjs 子进程，全程离线。
//
// 覆盖：
//   跨站 POST（sec-fetch-site: cross-site / 非本机 Origin）→ 403；无 Origin 与本机 Origin 放行
//   超限 body → 413（/api/worlds、/prompt 同款上限）
//   GET /api/history?seq= 只读目标文件、只回目标条目；不存在的 seq → 空列表
//   GET /app（无尾斜杠）→ 302 /app/；临时 game root 没有 dist 时 /app/ 回可读的 404
//   v1.14：新端点（cancel / open-dir / trash / presets delete / logs）同一套 403 + 413 + 参数白名单
//   v1.14：SSE 帧带单调 `id:`、心跳注释帧（`BUNKITEN_SSE_PING_MS` 压到 250ms 才测得起）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { startStack } from "./harness.mjs";
import { waitFor } from "../helpers/poll.mjs";

// 用 node:http 直发 POST：超限时服务端会「先回 413 再断连」，fetch 可能看到连接被重置；
// 原生 request 能在 response 事件里拿到 413，比 fetch 更稳。
function rawPost(
  base: string,
  p: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const u = new URL(base + p);
    let settled = false;
    const settle = (v: { status: number; text: string }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        const finish = () => settle({ status: res.statusCode ?? 0, text });
        res.on("end", finish);
        res.on("aborted", finish); // 服务端断连：拿到已收到的状态即可
        res.on("error", finish);
      },
    );
    // 服务端回 413 后断连，客户端可能先撞上 write EPIPE/ECONNRESET；此时若已收到响应就照常返回
    req.on("error", () => settle({ status: 0, text: "" }));
    req.end(body);
  });
}

// 直连 /events 读原文（fire-and-forget）：SSE 是文本协议，`id:` 行与 `: ping` 注释帧只有看原文才验得到
// （harness 的 readSSE 只挑 `data:` 行）。`text` 是实时累积的字符串，用例按它轮询断言。
function openSSE(base: string): { text: string; close: () => void } {
  const state: { text: string; close: () => void } = { text: "", close: () => {} };
  const u = new URL(base + "/events");
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "GET" }, (res) => {
    res.on("data", (c) => (state.text += c.toString()));
  });
  req.on("error", () => {
    /* 连接被 destroy（收尾路径）：原文里已有的帧仍然可断言 */
  });
  req.end();
  state.close = () => req.destroy();
  return state;
}

describe("集成：本地端点来源校验 + body 上限 + history seq（v1.6）", () => {
  let stack: any;

  beforeAll(async () => {
    // 心跳旋钮（v1.14）：产品口径是 20s，测一次要等 20 秒——压到 250ms（见 server/sse.mjs 的 HEARTBEAT_MS）
    stack = await startStack({ turns: [], extraEnv: { BUNKITEN_SSE_PING_MS: "250" } });
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("① 跨站 POST → 403（sec-fetch-site: cross-site / 非本机 Origin）；无 Origin 与本机 Origin 放行", async () => {
    // sec-fetch-site: cross-site（浏览器跨站请求的固有头）
    const bySecFetch = await stack.fetch("/api/worlds", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ action: "create", preset: "demo" }),
    });
    expect(bySecFetch.status).toBe(403);

    // 非本机 Origin（/prompt 与 /api/assets 同款入口校验）
    const byOrigin = await stack.fetch("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(byOrigin.status).toBe(403);
    const assets = await stack.fetch("/api/assets", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ action: "delete", preset: "demo", file: "x.jpg" }),
    });
    expect(assets.status).toBe(403);

    // 无 Origin（curl / 集成测试 / Electron 无来源头）放行
    const noOrigin = await stack.postJSON("/api/worlds", { action: "create", preset: "demo" });
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.body.ok).toBe(true);

    // 本机 Origin（Electron 打包态 /app 同源；vite dev localhost:5173）放行
    const devOrigin = await stack.fetch("/api/worlds", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ action: "create", preset: "demo" }),
    });
    expect(devOrigin.status).toBe(200);
    const loopOrigin = await stack.fetch("/api/worlds", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:1234" },
      body: JSON.stringify({ action: "create", preset: "demo" }),
    });
    expect(loopOrigin.status).toBe(200);
  }, 15000);

  it("② POST body 超 5MB → 413；正常大小 body 不受影响", async () => {
    const oversize = JSON.stringify({ action: "create", preset: "demo", pad: "x".repeat(5 * 1024 * 1024 + 1024) });
    const r = await rawPost(stack.base, "/api/worlds", oversize);
    expect(r.status).toBe(413);
    expect(JSON.parse(r.text).error).toContain("过大");

    // /prompt 同款上限
    const r2 = await rawPost(stack.base, "/prompt", JSON.stringify({ text: "y".repeat(5 * 1024 * 1024 + 1024) }));
    expect(r2.status).toBe(413);

    // 正常大小照常通过（上限不误伤）
    const ok = await stack.postJSON("/api/worlds", { action: "create", preset: "demo" });
    expect(ok.status).toBe(200);
  }, 20000);

  it("③ GET /api/history?seq= 只读目标文件并只回目标条目；列表只回元信息", async () => {
    // 直接在世界 w1 的 history 目录放两条快照（离线，不依赖引擎回合）
    const histDir = path.join(stack.root, "state", "worlds", "w1", "history");
    mkdirSync(histDir, { recursive: true });
    const mk = (seq: number) => ({
      seq,
      at: "2026-01-01T00:00:00.000Z",
      kind: "turn",
      nodeId: "1-1",
      chapterNo: 1,
      files: { state: `# 状态 ${seq}\n`, summary: null, tree: "- 当前进度: 节点 1-1（已走 0 轮）\n" },
    });
    writeFileSync(path.join(histDir, "0001.json"), JSON.stringify(mk(1)) + "\n");
    writeFileSync(path.join(histDir, "0002.json"), JSON.stringify(mk(2)) + "\n");

    const list = await stack.getJSON("/api/history?worldId=w1");
    expect(list.status).toBe(200);
    expect(list.body.snapshots.map((s: any) => s.seq)).toEqual([1, 2]);
    expect(list.body.snapshots.every((s: any) => s.files === undefined)).toBe(true); // 列表只回元信息

    const one = await stack.getJSON("/api/history?worldId=w1&seq=2");
    expect(one.status).toBe(200);
    expect(one.body.snapshots).toHaveLength(1); // 只回目标条目
    expect(one.body.snapshots[0].seq).toBe(2);
    expect(one.body.snapshots[0].files.state).toBe("# 状态 2\n");

    // 不存在的 seq → 空列表（不是整列元信息）
    const missing = await stack.getJSON("/api/history?worldId=w1&seq=9");
    expect(missing.status).toBe(200);
    expect(missing.body.snapshots).toEqual([]);
  }, 15000);

  it("④ GET /app（无尾斜杠）302 到 /app/；静态托管缺产物时给可读的 404", async () => {
    // 产物 index.html 的资源是相对路径（vite base "./"）：文档 URL 少了尾斜杠，./assets/… 就会解析到
    // 站点根、全部 404——打包态窗口一片空白（v1.9 打包态冒烟抓到的真 bug，修在 server/routes.mjs 与
    // electron/main.js）。这条把服务端那半钉住（打包态 spec 是 opt-in，不进 CI）。
    const r = await stack.fetch("/app", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app/");

    // /app/ 走静态托管：集成环境的临时 game root 没有 dist（resolveAppDist 的两条候选都不存在），
    // 回 404 + 原因句——不是 500，也不是空响应
    const slash = await stack.fetch("/app/");
    expect(slash.status).toBe(404);
    expect(await slash.text()).toContain("app dist not built");
  }, 15000);

  it("⑤ v1.14 新端点：同一套跨站 403 + body 413 + 参数白名单（cancel/open-dir/trash/presets/logs）", async () => {
    // 跨站（sec-fetch-site / 非本机 Origin）→ 403：新端点全部走函数开头那道统一门禁
    for (const p of ["/api/engine/cancel", "/api/open-dir", "/api/trash", "/api/presets"]) {
      const bySecFetch = await stack.fetch(p, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ action: "restore", id: "x" }),
      });
      expect(bySecFetch.status, `${p} 没被跨站门禁拦住`).toBe(403);
      const byOrigin = await stack.fetch(p, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ action: "restore", id: "x" }),
      });
      expect(byOrigin.status, `${p} 没被非本机 Origin 拦住`).toBe(403);
    }
    // body 超 5MB → 413（新端点用的是同一个 readBodyText 缺省上限；
    // /api/presets 例外——它按路径放宽到 50MB 供剧本导入，故不在这一轮）
    const oversize = JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024 + 1024) });
    for (const p of ["/api/engine/cancel", "/api/open-dir", "/api/trash"]) {
      const r = await rawPost(stack.base, p, oversize);
      expect(r.status, `${p} 的 body 上限没生效`).toBe(413);
    }
    // 参数白名单：open-dir 只认 data|logs；trash 只认 restore；presets 只认 import|delete；logs 要 worldId
    expect((await stack.postJSON("/api/open-dir", { which: "somewhere" })).status).toBe(400);
    expect((await stack.postJSON("/api/trash", { action: "nope", id: "x" })).status).toBe(400);
    expect((await stack.postJSON("/api/presets", { action: "nope" })).status).toBe(400);
    expect((await stack.getJSON("/api/logs")).status).toBe(400);
    expect((await stack.getJSON("/api/logs?worldId=" + encodeURIComponent("../etc"))).status).toBe(400);

    // 空闲时的契约面（不必起回合）：取消是 no-op、状态可读
    expect((await stack.postJSON("/api/engine/cancel", {})).body).toEqual({ ok: true, cancelled: false });
    expect((await stack.getJSON("/api/engine/status")).body).toEqual({ busy: false, turn: 0 });
  }, 25000);

  it("⑥ SSE 帧带单调 id:，连接存活时按心跳间隔来一帧 `: ping` 注释", async () => {
    // harness 的 readSSE 只看 `data:` 行（id 与注释帧对它透明）；这里直连读原文，验的就是那两样
    const sse = openSSE(stack.base);
    try {
      await waitFor(() => sse.text.includes("retry: 2000"), { timeoutMs: 4000, label: "SSE 首帧 retry" });
      // 连接已在册：触发一回合（turn_start + turn_end 两帧）让 `id:`/`data:` 有料可看
      expect((await stack.prompt("hi")).status).toBe(200);
      await waitFor(() => /id: \d+\ndata: \{"type":"turn_start"/.test(sse.text), {
        timeoutMs: 4000,
        label: "带 id 的 turn_start 帧",
      });
      // 心跳注释帧（250ms 旋钮 → 一秒内必到）
      await waitFor(() => sse.text.includes(": ping"), { timeoutMs: 4000, label: "SSE 心跳" });
      // id 单调（同一连接里序号只增不减）+ 每条 data 帧前面都配了 id 行
      const ids = [...sse.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(
        [...ids].sort((a, b) => a - b),
        `SSE id 不是单调的：${ids.join(",")}`,
      ).toEqual(ids);
      expect(sse.text).toContain('data: {"type":"turn_end"');
    } finally {
      sse.close();
    }
  }, 20000);
});
