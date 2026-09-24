// E2E 进程编排：child_process 起 acp-server（7800，被占自动 +1）+ vite dev（5173，被占自动 +1），
// 解析各自 stdout 拿实际端口，vite 用 ACP_PROXY_TARGET 指向真实 acp 端口。afterAll 调 stop() 清理。
//
// 与 tests/integration/harness.mjs 的分工（两份编排器**刻意各留一份**，不合并成一个内核）：
//   · 本文件是**真引擎**编排：不 seed 任何数据，起的是玩家的真 game root，只负责 acp-server + vite 两段
//     进程生命周期与端口解析（真引擎冒烟 tests/e2e/smoke.spec.ts 用）；
//   · harness.mjs 是**假引擎 fixture**：临时 game root + PATH 垫片 + 种子数据 + SSE/HTTP 断言面，
//     起的是 tests/integration/fake-engine.mjs（集成层与假引擎 UI e2e 用，见 tests/helpers/fake-stack.mjs）。
//   两者的失效模式、依赖、断言面都不同，合并只会把「真引擎要真登录态」与「假引擎要脚本队列」揉成一份
//   谁都不敢改的东西。**真正共用的原语**（SIGTERM→宽限→SIGKILL、信号兜底、逐行等 stdout、vite 启动、
//   轮询、探活）已抽到 tests/helpers/{proc,poll,vite}.mjs——那里是真源，两边的差异只留在本文件与 harness 头部。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpOk, installProcessCleanup, killGracefully, spawnAndAwaitLine } from "./proc.mjs";
import { waitFor } from "./poll.mjs";
import { spawnViteDev } from "./vite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 诊断日志落点：test-results/stack-<slug>.log（排障看它；与 fake 栈的 test-results-ui/ 分开） */
const teeFile = (slug) => path.join(ROOT, "test-results", `stack-${slug}.log`);

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
    disposeCleanup();
    await killGracefully(children);
  };
  // 兜底：playwright 进程退出（含崩溃/中断）时同步杀掉子进程。
  // **信号路径必须显式接管**：Node 收到信号默认直接终止、**不触发 'exit'**——只挂 'exit' + SIGINT/SIGTERM
  // 会漏掉关终端（SIGHUP）与 Ctrl-\（SIGQUIT）这两条（同源问题在 integration 栈上实测留下过孤儿进程）。
  // 语义与说明收在 tests/helpers/proc.mjs 的 installProcessCleanup；dispose 在 stop() 里摘掉监听。
  const emergencyKill = () => {
    for (const p of children) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  };
  const disposeCleanup = installProcessCleanup(emergencyKill);

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
    teeFile: teeFile("acp-server-listen"),
    onSpawn: (p) => children.push(p),
  });
  const acpPort = acp.match[1];

  await waitFor(() => httpOk(`http://localhost:${acpPort}/api/auth`), {
    timeoutMs: 90_000,
    intervalMs: 400,
    label: "acp-server /api/auth",
  });
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

  // vite dev：默认 5173，被占自动 +1；代理目标指向 acp 实际端口（启动样板收在 tests/helpers/vite.mjs）
  const vite = await spawnViteDev({
    acpBase: `http://localhost:${acpPort}`,
    teeFile: teeFile("vite-dev-server"),
    onSpawn: (p) => children.push(p),
  });
  await waitFor(() => httpOk(vite.pageUrl), { timeoutMs: 90_000, intervalMs: 400, label: "vite dev server http" });

  return { pageUrl: vite.pageUrl, acpPort, stop };
}
