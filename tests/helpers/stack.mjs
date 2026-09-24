// E2E 进程编排：child_process 起 acp-server（7800，被占自动 +1）+ vite dev（5173，被占自动 +1），
// 解析各自 stdout 拿实际端口，vite 用 ACP_PROXY_TARGET 指向真实 acp 端口。afterAll 调 stop() 清理。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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

// oxlint-disable-next-line eslint/no-control-regex -- ANSI 颜色码本身就是控制字符（\x1B），这条正则要的就是它
const ANSI_RE = /\x1B\[[0-9;]*m/g; // vite 在 CI 环境会给 banner 上色，颜色码会打断行匹配

/** 起一个进程并逐行监听 stdout，直到 matcher 命中某行；onSpawn 在 spawn 后立刻回调（供清理注册） */
function spawnAndAwaitLine(cmd, args, { env, matcher, label, timeoutMs = 90_000, onSpawn }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: ROOT,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        reject(
          new Error(
            `${label} exited early with code ${code} (stderr: ${Buffer.concat(stderrBuf).toString().slice(-800)})`,
          ),
        );
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
 * 起 acp-server + vite，返回 { pageUrl, acpPort, stop() }。
 * 等到引擎 session ready 才 resolve（否则点击开演时 /prompt 会 409「引擎未就绪」）。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.homeDir] 给 acp-server 的 HOME（缺省 = 本机真 HOME）。**Codex 冒烟用它**：
 *   临时 HOME 里放一份从真 `~/.codex/auth.json` 拷来的登录态 + `engine:"codex"` 的凭据，
 *   既走真登录又绝不动玩家本机的凭据文件（ADR-0022 的隔离在测试侧的同款口径）。
 * @param {object|null} [opts.credentials] 写进 `<homeDir>/.bunkiten/credentials.json` 的凭据文档（需 homeDir）
 * @param {Record<string,string>} [opts.env] 追加/覆盖 acp-server 的环境变量（测试开关，如 BUNKITEN_*）
 * @returns {Promise<{pageUrl: string, acpPort: string, stop: () => Promise<void>}>}
 */
export async function startStack({ homeDir = null, credentials = null, env = {} } = {}) {
  const children = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await killGracefully(children);
  };
  // 兜底：playwright 进程退出（含崩溃/中断）时同步杀掉子进程。
  // **信号路径必须显式接管**：Node 收到信号默认直接终止、**不触发 'exit'**——只挂 'exit' + SIGINT/SIGTERM
  // 会漏掉关终端（SIGHUP）与 Ctrl-\（SIGQUIT）这两条（同源问题在 integration 栈上实测留下过孤儿进程）。
  const emergencyKill = () => {
    for (const p of children) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  };
  process.on("exit", emergencyKill);
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGQUIT", 131],
  ]) {
    process.on(sig, () => {
      emergencyKill();
      process.exit(code);
    });
  }

  try {
    return await start(children, stop, { homeDir, credentials, env });
  } catch (e) {
    await stop(); // 启动中途失败也要回收子进程
    throw e;
  }
}

async function start(children, stop, { homeDir = null, credentials = null, env = {} } = {}) {
  // 临时 HOME 的凭据（0600，与真服务端同一形状）：Codex 冒烟靠它把引擎切成 codex 而不碰玩家本机文件
  if (homeDir && credentials) {
    const dir = path.join(homeDir, ".bunkiten");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  }
  // acp-server：显式钉一个高位端口起（避开开发中的 7800 实例，保证 e2e 与外部服务隔离）；
  // 被占时 server 自身 +1 重试，行里打印的是**实际监听端口**（server.address().port）
  const acp = await spawnAndAwaitLine(process.execPath, ["server/acp-server.mjs"], {
    env: { PORT: "7900", ...(homeDir ? { HOME: homeDir, BUNKITEN_HOME: homeDir } : {}), ...env },
    matcher: (line) => /\[acp\] http:\/\/localhost:(\d+)/.exec(line),
    label: "acp-server listen",
    onSpawn: (p) => children.push(p),
  });
  const acpPort = acp.match[1];

  await waitFor(() => httpOk(`http://localhost:${acpPort}/api/auth`), { label: "acp-server /api/auth" });
  // 等引擎 session 就绪（boot: initialize → session/new → "<engine> session ready"；两个后端都有这一行）
  await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("session ready")) {
        acp.proc.stdout.removeListener("data", onData);
        resolve();
      } else if (buf.includes("boot failed")) {
        acp.proc.stdout.removeListener("data", onData);
        reject(new Error("acp-server boot failed (引擎 session 未建立)"));
      }
    };
    acp.proc.stdout.on("data", onData);
    setTimeout(() => {
      acp.proc.stdout.removeListener("data", onData);
      reject(new Error("timeout waiting for session ready"));
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
