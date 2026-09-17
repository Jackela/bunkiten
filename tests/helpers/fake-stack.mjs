// 假引擎 UI e2e 进程编排（tests/e2e-ui/ 用）：组合两半——
//   1. tests/integration/harness.mjs 的 startStack：假 ACP 引擎 + 真 acp-server（临时 game root，随机端口）；
//   2. 参照 tests/helpers/stack.mjs 的 vite 段：spawn `node node_modules/vite/bin/vite.js`，
//      env ACP_PROXY_TARGET 指向 harness 栈端口 + NO_COLOR=1（颜色码会打断 `Local:` 行匹配），
//      解析 stdout 的 `Local:` 行得 pageUrl，再等 URL http ok。
// 返回 { stack, pageUrl, stop() }；options 透传 startStack 的全部参数（turns/presets/sessionImages/
// assets/audioFiles/trees/stateFiles/worlds/snapshots，见 harness.mjs 顶部注释）。
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

async function httpOk(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 100, label = "condition" } = {}) {
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
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
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
 * @param {object} [options] 透传 startStack：{turns, presets, sessionImages, assets, audioFiles, trees, stateFiles, worlds, snapshots}
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
    await waitFor(() => httpOk(pageUrl), { label: "vite dev server http" });
    return { stack, pageUrl, stop };
  } catch (e) {
    await stop(); // 启动中途失败也要回收子进程
    throw e;
  }
}
