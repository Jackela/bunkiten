// ACP 子进程封装（v1.7 拆模块）：spawn grok agent stdio、JSON-RPC request/响应分发、
// sessionId 存取（断线续档）、boot 握手（session/load 降级 session/new + 推理档位）、会话图片定位。
// 与 HTTP 层的接缝是两个回调：onChunk（agent_message_chunk 文本）与 onSeg（tool_call 进度 label）——
// 流式【图】标记扫描、seg 计数与 SSE broadcast 留在入口的 startServer 闭包里（那里才有 registry 与 clients）。
import { spawn } from "child_process";
import readline from "readline";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 建 ACP 会话（工厂）。行为与拆模块前的 startServer 内联实现逐字一致（日志/超时/JSON-RPC 错误回复都不变）。
 * @param {object} opts
 * @param {string} opts.gameRoot 引擎 cwd（也是 ~/.grok/sessions/<encode(gameRoot)> 的会话目录键）
 * @param {string} opts.sessionFile 断线续档文件（config.SESSION_FILE）
 * @param {string} opts.rules 注入 agent 的 rules 原文（protocol-lines.RULES）
 * @param {string} opts.effort 初始推理档位（entry.EFFORT）
 * @param {(text: string) => void} opts.onChunk agent_message_chunk 的文本（入口做标记扫描 + broadcast）
 * @param {(label: string) => void} opts.onSeg tool_call/tool_call_update 的进度标题（入口 seg+=1 + broadcast）
 * @param {Record<string, string>} [opts.env] 额外注入子进程的 env（自备 key 的 BYOK 变量；
 *   **我们的值优先**——展开顺序是 `{...process.env, ...env}`，同名键由这里覆盖，见 docs/ARCHITECTURE.md「引擎凭据与自备 key」）
 * @param {Array<object>} [opts.mcpServers] 挂到会话上的 MCP server 列表（ACP McpServerStdio 形态；
 *   配了图片自备 key 时才给，见 server/media-mcp.mjs 的 mediaMcpServers）
 * @returns {{proc: import("child_process").ChildProcess, request: (method: string, params?: object|null, timeoutMs?: number) => Promise<any>,
 *   boot: () => Promise<void>, resolveImage: (name: string) => string|null, sessionId: string|null}} sessionId 是 getter——
 *   sendPrompt 与 /img 路由经它读当前会话；request 的 Promise resolve 整个响应 msg（result/error 都在）
 */
export function createAcpSession({ gameRoot, sessionFile, rules, effort, onChunk, onSeg, env = {}, mcpServers = [] }) {
  const proc = spawn("grok", ["agent", "--always-approve", "stdio"], { cwd: gameRoot, env: { ...process.env, ...env } });
  proc.stderr.on("data", (d) => process.stderr.write("[grok] " + d.toString().slice(0, 300)));
  proc.on("exit", (code) => console.error(`[acp] grok agent exited: ${code}`));
  const rl = readline.createInterface({ input: proc.stdout });

  let nextId = 1;
  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  /** @type {string|null} */
  let sessionId = null;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
      return;
    }
    if (!msg.method) return;
    if (msg.id !== undefined) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported by game shell" } }) + "\n");
    }
    if (msg.method !== "session/update") return;
    const u = msg.params.update;
    if (u.sessionUpdate === "agent_message_chunk") {
      onChunk(u.content?.text ?? "");
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      onSeg(String(u.title || u.toolCall?.title || "工作"));
    }
  });

  /**
   * @param {string} method JSON-RPC 方法名
   * @param {object|null} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} resolve 整个响应 msg（result/error 都在里面，由调用方分辨）
   */
  function request(method, params, timeoutMs = 120000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function sessionImagesDir() {
    // 唯一调用点 resolveImage 入口有 `!sessionId → return null` 守卫（boot 完成前的【图】补落盘路径曾违反
    // 旧不变式直接 TypeError），走到这里时 sessionId 必非空——cast 依赖该守卫，删守卫前先改这里。
    const base = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(gameRoot), /** @type {string} */ (sessionId));
    return path.join(base, "images");
  }

  // 会话图索引（v1.7 读路径索引化）：imageName → 该名字最新的一份（跨会话续档时 /img 反复来查，
  // 原先每次未命中都 readdirSync 扫全部历史会话目录逐个 statSync）。挂在会话实例闭包而非模块级：
  // gameRoot/sessionId 都是本工厂的入参与状态，换一个会话实例索引自然隔离，不会串根。
  /** @type {Map<string, {absPath: string, mtimeMs: number}>} */
  const imageIndex = new Map();
  let imageIndexScannedAt = 0; // 上次全量重建的时间戳（TTL 节流用）
  const IMAGE_INDEX_TTL_MS = 5000;

  // 全量重建索引：扫会话根下所有会话目录的 images/，同名取 mtime 最新
  function rebuildImageIndex() {
    imageIndex.clear();
    const base = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(gameRoot));
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const imagesDir = path.join(base, d.name, "images");
        let names = [];
        try {
          names = fs.readdirSync(imagesDir);
        } catch {
          continue;
        }
        for (const name of names) {
          const f = path.join(imagesDir, name);
          try {
            const st = fs.statSync(f);
            const prev = imageIndex.get(name);
            if (!prev || st.mtimeMs > prev.mtimeMs) imageIndex.set(name, { absPath: f, mtimeMs: st.mtimeMs });
          } catch {}
        }
      }
    } catch {}
    imageIndexScannedAt = Date.now();
  }

  // 图片落在 per-session 目录：当前会话没有时，查会话图索引（miss 才全量重建）
  /** @param {string} name 图片文件名 @returns {string|null} 绝对路径；找不到时 null */
  function resolveImage(name) {
    // boot 前 / 无会话：安全返回 null（此前 sessionId 为 null 时 path.join(..., null) 会抛 TypeError，
    // flushArtLines 的【图】补落盘路径没有守卫，这个修复让 /img 走正常 404 而不是 500）
    if (!sessionId) return null;
    const cur = path.join(sessionImagesDir(), name);
    if (fs.existsSync(cur)) return cur;
    const hit = imageIndex.get(name);
    if (hit) {
      try {
        fs.statSync(hit.absPath); // 命中但文件还在才算数
        return hit.absPath;
      } catch {
        imageIndex.delete(name); // 已被删：剔除后走下面的重扫找次新
      }
    } else if (Date.now() - imageIndexScannedAt < IMAGE_INDEX_TTL_MS) {
      // /img 未命中是低频路径：会话目录被外部清掉后不该每个请求都全量重扫一遍——
      // TTL 内的 miss 直接判 miss。选 TTL 而非目录 mtime 是因为多层父目录的 mtime 不可靠（下级变化不一定冒泡）。
      return null;
    }
    rebuildImageIndex();
    const again = imageIndex.get(name);
    return again ? again.absPath : null;
  }

  function saveSessionId() {
    try { fs.writeFileSync(sessionFile, JSON.stringify({ sessionId }) + "\n"); } catch {}
  }

  function loadSavedSessionId() {
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      return typeof data.sessionId === "string" && data.sessionId ? data.sessionId : null;
    } catch { return null; }
  }

  async function boot() {
    await new Promise((r) => setTimeout(r, 800));
    await request("initialize", { protocolVersion: 1, clientCapabilities: {} });

    // 断线续档：优先 session/load 复用上次会话，失败降级 session/new 并覆写。
    // mcpServers 两条路径都传（第 0 步实证：session/load 与 session/new 一样会拉起 MCP 子进程）。
    const savedId = loadSavedSessionId();
    let booted = false;
    if (savedId) {
      try {
        const r = await request("session/load", {
          sessionId: savedId, cwd: gameRoot, mcpServers, _meta: { yoloMode: true, rules },
        }, 60000);
        if (r.error) throw new Error(r.error.message || "session/load rejected");
        sessionId = r.result?.sessionId || savedId;
        booted = true;
        console.log(`[acp] session/load 复用会话: ${sessionId}`);
      } catch (e) {
        console.log(`[acp] session/load 失败（${e.message}），降级 session/new`);
      }
    }
    if (!booted) {
      const s = await request("session/new", {
        cwd: gameRoot, mcpServers, _meta: { yoloMode: true, rules },
      });
      if (s.error) throw new Error(s.error.message || "session/new rejected");
      sessionId = s.result.sessionId;
      console.log(`[acp] session/new 新会话: ${sessionId}`);
    }
    saveSessionId();
    console.log(`[acp] grok session ready: ${sessionId}`);
    // 游戏回合不需要 high 档推理，降到 medium 提速（失败忽略；load/new 会话同样生效）
    try {
      await request("session/set_config_option", {
        sessionId, configId: "reasoning_effort", value: { value: effort },
      });
      console.log(`[acp] reasoning_effort -> ${effort}`);
    } catch { /* 不支持就保持默认 */ }
  }

  return {
    proc,
    request,
    boot,
    resolveImage,
    get sessionId() { return sessionId; },
  };
}
