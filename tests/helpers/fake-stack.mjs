// 假引擎 UI e2e 进程编排（tests/e2e-ui/ 用）：组合两半——
//   1. tests/integration/harness.mjs 的 startStack：假 ACP 引擎 + 真 acp-server（临时 game root，随机端口）；
//   2. 参照 tests/helpers/stack.mjs 的 vite 段：spawn `node node_modules/vite/bin/vite.js`，
//      env ACP_PROXY_TARGET 指向 harness 栈端口 + NO_COLOR=1（颜色码会打断 `Local:` 行匹配），
//      解析 stdout 的 `Local:` 行得 pageUrl，再等 URL http ok。
// 返回 { stack, pageUrl, stop() }；options 透传 startStack 的全部参数（turns/presets/sessionImages/
// assets/audioFiles/trees/stateFiles/worlds/snapshots/indexSchema/indexExtra/legacyIndexArray，
// 见 harness.mjs 顶部注释）。
//
// stop 顺序：先停 vite 再 stack.stop()——vite 是页面入口，先关入口避免收尾窗口里浏览器/代理还在向
// 正在关闭的 acp-server 发请求（ECONNRESET 噪音）；且 stack.stop() 会删临时 game root，vite 若还活着
// 会因源文件消失再喷一轮报错。两者都走 SIGTERM → 4s 宽限 → SIGKILL 兜底（与两份现有编排同款纪律）。
// vite stdout tee 到 test-results-ui/（排障用，与 stack.mjs 的 test-results/ 分开）。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStack } from "../integration/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VITE_BIN = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const ANSI_RE = /\x1B\[[0-9;]*m/g; // 防御性去色（NO_COLOR=1 已设，双保险）

/** 诊断 tee：把 vite stdout 原样落盘（test-results-ui/vite-dev.log），排查启动问题时看 */
function teeFactory() {
  const dir = path.join(ROOT, "test-results-ui");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const file = path.join(dir, "vite-dev.log");
  try {
    appendFileSync(file, `--- start ${new Date().toISOString()} cwd=${process.cwd()} ---\n`);
  } catch {}
  return (chunk) => {
    try {
      appendFileSync(file, chunk);
    } catch {}
  };
}

/**
 * 单跳探活的等待上限（ms）：冷代理下**裸 fetch 会挂到 undici 的头超时（~5 分钟）**，而 Playwright 会先以
 * 60s 超收场——拿不到「vite proxy /api/auth」这条诊断（只看到一条 60s timeout）。给单跳一个上限，
 * 让「没就绪」在 4s 内变成一条可读的状态/错误，再由 waitFor 按 100ms 间隔继续探。
 */
const PROBE_TIMEOUT_MS = 4000;

/**
 * 探活一跳：单次带上限 + **消费掉 body**（每 100ms 一跳、最长 30s，不消费的响应体会积一堆短命连接）。
 * 失败不抛错（轮询期间失败视同未就绪），把「最后一次看到的状态/错误」写进 ctx.last——
 * waitFor 失败时贴进消息，否则只剩一句 timeout，分不清是没起来、还是 502/ECONNREFUSED。
 * @param {string} url 探的地址
 * @param {{last: string}} ctx 跨跳共享的诊断槽（每次覆盖为最新一跳）
 * @returns {Promise<boolean>} HTTP ok 与否
 */
async function httpProbe(url, ctx) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    void r.body?.cancel(); // 只关心 ok/status：body 不读就显式取消（不消费会一直攒连接）
    ctx.last = `GET ${url} -> HTTP ${r.status}`;
    return r.ok;
  } catch (e) {
    ctx.last = `GET ${url} -> ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    return false;
  }
}

/**
 * 轮询到 predicate 为真。
 * 注意 deadline 是在 predicate **返回之后**才查的：单跳最长可以吃掉 PROBE_TIMEOUT_MS，
 * 所以真实上限是 timeoutMs + 一跳的预算（探活那种一跳带上限的用法下这是有界的；带无止境 await 的
 * predicate 仍会拖过 deadline，别拿它当硬截止）。
 * @param {() => Promise<boolean> | boolean} predicate 未就绪返回假值（抛错视同未就绪）
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string, detail?: string | (() => string)}} [options]
 *   detail：失败消息里追加的实况（如最后一次探活看到的 HTTP 状态/错误）
 */
function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 100, label = "condition", detail } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let ok = false;
      try {
        ok = await predicate();
      } catch {
        /* 轮询期间失败视同未就绪 */
      }
      if (ok) return resolve();
      if (Date.now() > deadline) {
        const extra = typeof detail === "function" ? detail() : detail;
        return reject(new Error(`timeout waiting for ${label}${extra ? `（最后状态：${extra}）` : ""}`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// SIGTERM → 等退出（宽限期内不退再 SIGKILL；与 harness.mjs/stack.mjs 的 killProc 同款）
function killProc(proc, graceMs = 4000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve();
    }, graceMs);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

/**
 * 起一套假引擎 UI 栈（假 ACP 引擎 + 真 acp-server + vite dev）。
 * @param {object} [options] 透传 startStack：{turns, presets, sessionImages, assets, audioFiles, trees, stateFiles, worlds, snapshots, indexSchema, indexExtra, legacyIndexArray}
 * @returns {Promise<{stack: object, pageUrl: string, stop: () => Promise<void>}>}
 */
export async function startFakeStack(options = {}) {
  const stack = await startStack(options); // 先起后端（含引擎握手与 SSE），失败自回收

  const children = [];
  let stopped = false;
  const stopVite = () => Promise.all(children.map((p) => killProc(p)));
  // 兜底：playwright 进程退出（含崩溃/中断）时同步杀 vite（acp-server 的兜底在 harness 里）
  const emergencyKill = () => {
    for (const p of children) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  };
  process.once("exit", emergencyKill);
  process.once("SIGINT", emergencyKill);
  process.once("SIGTERM", emergencyKill);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // 摘掉兜底监听：9 个 spec 各自起停一套栈，不摘会累积 27 个 once 监听并触发
    // MaxListenersExceededWarning（removeListener 对已触发/未触发都安全；正常收尾走这里）
    for (const ev of ["exit", "SIGINT", "SIGTERM"]) process.removeListener(ev, emergencyKill);
    await stopVite(); // 先关页面入口，再停后端并删临时目录（理由见文件头）
    await stack.stop();
  };

  try {
    // vite dev：默认 5173，被占自动 +1；代理目标指向 harness 栈实际端口
    const pageUrl = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [VITE_BIN], {
        cwd: ROOT,
        env: { ...process.env, ACP_PROXY_TARGET: stack.base, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(proc);
      const tee = teeFactory();
      let buf = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`timeout waiting for vite dev server (stdout so far: ${buf.slice(-500)})`));
      }, 30_000);
      const onData = (chunk) => {
        tee(chunk);
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const m = /Local:\s+(http:\/\/\S+?\/)/.exec(line.replace(ANSI_RE, ""));
          if (m) {
            proc.stdout.removeListener("data", onData);
            clearTimeout(timer);
            settled = true;
            resolve(m[1].replace(/\/$/, ""));
            return;
          }
        }
      };
      proc.stdout.on("data", onData);
      const stderrTail = [];
      proc.stderr.on("data", (d) => {
        stderrTail.push(d);
        process.stderr.write(`[vite-dev] ${d}`);
      });
      proc.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`vite dev server exited early with code ${code} (stderr: ${Buffer.concat(stderrTail).toString().slice(-800)})`));
        }
      });
    });
    // 探活两跳共用一个诊断槽：失败消息里贴的是**最后一跳**看到的 HTTP 状态/错误（不是一句光秃秃的 timeout）
    const probe = { last: "还没有探活结果" };
    await waitFor(() => httpProbe(pageUrl, probe), { label: "vite dev server http", detail: () => probe.last });
    // 再等一次**经 Vite 代理**的 /api/auth：上面的只等 index.html，页面已能加载不等于 /api/* 的转发已热。
    // 冷代理下测试的首个 goto 会撞上「页面起来了、boot 的第一个 GET 却卡住」——启动屏停在
    // 「正在确认登录状态…」直到断言超时（历史上 flaky 的那一段）。先戳一次把代理路径捂热再交给用例。
    await waitFor(() => httpProbe(pageUrl + "/api/auth", probe), { label: "vite proxy /api/auth", detail: () => probe.last });
    return { stack, pageUrl, stop };
  } catch (e) {
    await stop(); // 启动中途失败也要回收子进程
    throw e;
  }
}
