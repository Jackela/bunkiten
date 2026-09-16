// E2E 进程编排：child_process 起 acp-server（7800，被占自动 +1）+ vite dev（5173，被占自动 +1），
// 解析各自 stdout 拿实际端口，vite 用 ACP_PROXY_TARGET 指向真实 acp 端口。afterAll 调 stop() 清理。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 诊断 tee：把子进程 stdout 原样落盘（test-results/stack-<slug>.log），排查启动问题时看 */
function teeFactory(slug) {
  const dir = path.join(ROOT, "test-results");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const file = path.join(dir, `stack-${slug}.log`);
  try {
    appendFileSync(file, `--- start ${new Date().toISOString()} cwd=${process.cwd()} ---\n`);
  } catch {}
  return (chunk) => {
    try {
      appendFileSync(file, chunk);
    } catch {}
  };
}

/** 轮询等待条件成立；超时抛错（label 进错误消息便于定位） */
function waitFor(predicate, { timeoutMs = 90_000, intervalMs = 400, label = "condition" } = {}) {
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

async function httpOk(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

const ANSI_RE = /\x1B\[[0-9;]*m/g; // vite 在 CI 环境会给 banner 上色，颜色码会打断行匹配

/** 起一个进程并逐行监听 stdout，直到 matcher 命中某行；onSpawn 在 spawn 后立刻回调（供清理注册） */
function spawnAndAwaitLine(cmd, args, { env, matcher, label, timeoutMs = 90_000, onSpawn }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: ROOT, env: env ? { ...process.env, ...env } : process.env, stdio: ["ignore", "pipe", "pipe"] });
    onSpawn?.(proc);
    const tee = teeFactory(label.replace(/\W+/g, "-"));
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timeout waiting for ${label} (stdout so far: ${buf.slice(-500)})`));
    }, timeoutMs);
    const onData = (chunk) => {
      tee(chunk);
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const m = matcher(line.replace(ANSI_RE, ""));
        if (m) {
          proc.stdout.removeListener("data", onData);
          clearTimeout(timer);
          settled = true;
          resolve({ proc, match: m });
          return;
        }
      }
    };
    proc.stdout.on("data", onData);
    const stderrBuf = [];
    proc.stderr.on("data", (d) => {
      stderrBuf.push(d);
      process.stderr.write(`[${label}] ${d}`);
    });
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${label} exited early with code ${code} (stderr: ${Buffer.concat(stderrBuf).toString().slice(-800)})`));
      }
    });
  });
}

function killGracefully(procs) {
  return Promise.all(
    procs.map(
      (p) =>
        new Promise((resolve) => {
          if (p.exitCode !== null) return resolve();
          const t = setTimeout(() => {
            try {
              p.kill("SIGKILL");
            } catch {}
            resolve();
          }, 4000);
          p.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
          try {
            p.kill("SIGTERM"); // acp-server 收 SIGTERM 会自带清理 grok 子进程
          } catch {}
        }),
    ),
  );
}

/**
 * 起 acp-server + vite，返回 { pageUrl, stop() }。
 * 等到 grok session ready 才 resolve（否则点击开演时 /prompt 会 409「引擎未就绪」）。
 */
export async function startStack() {
  const children = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await killGracefully(children);
  };
  // 兜底：playwright 进程退出（含崩溃/中断）时同步杀掉子进程
  const emergencyKill = () => {
    for (const p of children) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  };
  process.on("exit", emergencyKill);
  process.on("SIGINT", emergencyKill);
  process.on("SIGTERM", emergencyKill);

  try {
    return await start(children, stop);
  } catch (e) {
    await stop(); // 启动中途失败也要回收子进程
    throw e;
  }
}

async function start(children, stop) {
  // acp-server：显式钉一个高位端口起（避开开发中的 7800 实例，保证 e2e 与外部服务隔离）；
  // 被占时 server 自身 +1 重试，行里打印的是**实际监听端口**（server.address().port）
  const acp = await spawnAndAwaitLine(process.execPath, ["server/acp-server.mjs"], {
    env: { PORT: "7900" },
    matcher: (line) => /\[acp\] http:\/\/localhost:(\d+)/.exec(line),
    label: "acp-server listen",
    onSpawn: (p) => children.push(p),
  });
  const acpPort = acp.match[1];

  await waitFor(() => httpOk(`http://localhost:${acpPort}/api/auth`), { label: "acp-server /api/auth" });
  // 等引擎 session 就绪（boot: initialize → session/new → "grok session ready"）
  await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("grok session ready")) {
        acp.proc.stdout.removeListener("data", onData);
        resolve();
      } else if (buf.includes("boot failed")) {
        acp.proc.stdout.removeListener("data", onData);
        reject(new Error("acp-server boot failed (grok session 未建立)"));
      }
    };
    acp.proc.stdout.on("data", onData);
    setTimeout(() => {
      acp.proc.stdout.removeListener("data", onData);
      reject(new Error("timeout waiting for grok session ready"));
    }, 120_000).unref();
  });

  // vite dev：默认 5173，被占自动 +1；代理目标指向 acp 实际端口
  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const vite = await spawnAndAwaitLine(process.execPath, [viteBin], {
    env: { ACP_PROXY_TARGET: `http://localhost:${acpPort}`, NO_COLOR: "1" },
    matcher: (line) => /Local:\s+(http:\/\/\S+?\/)/.exec(line),
    label: "vite dev server",
    timeoutMs: 30_000,
    onSpawn: (p) => children.push(p),
  });
  const pageUrl = vite.match[1].replace(/\/$/, "");
  await waitFor(() => httpOk(pageUrl), { label: "vite dev server http" });

  return { pageUrl, acpPort, stop };
}
