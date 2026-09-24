// 假引擎 UI e2e 进程编排（tests/e2e-ui/ 用）：组合两半——
//   1. tests/integration/harness.mjs 的 startStack：假 ACP 引擎 + 真 acp-server（临时 game root，随机端口）；
//   2. vite dev（tests/helpers/vite.mjs 的 spawnViteDev，与真引擎编排 tests/helpers/stack.mjs 共用同一份
//      启动样板）：env ACP_PROXY_TARGET 指向 harness 栈端口 + NO_COLOR=1，解析 stdout 的 `Local:` 行得 pageUrl。
// 返回 { stack, pageUrl, stop() }；options 透传 startStack 的全部参数（turns/presets/sessionImages/
// assets/audioFiles/trees/stateFiles/worlds/snapshots/indexSchema/indexExtra/legacyIndexArray/presetMd/
// covers/auth/codexAuth/credentials/extraEnv/homeDir，见 harness.mjs 顶部注释）。
// stack 的形态复用 harness 的 StackHandle typedef（不抄第二份）。
//
// 为什么本文件与 tests/helpers/stack.mjs 不合并：前者是**假引擎 fixture**（seed + 探针 + 快照），后者是
// **真引擎编排**（真 game root + 真登录态）。共用原语已抽到 tests/helpers/{proc,poll,vite}.mjs，
// 这里只剩「两半怎么拼」与 fake 栈独有的代理预热；合并会把两套完全不同的失效模式揉成一份。见 stack.mjs 头部。
//
// stop 顺序：先停 vite 再 stack.stop()——vite 是页面入口，先关入口避免收尾窗口里浏览器/代理还在向
// 正在关闭的 acp-server 发请求（ECONNRESET 噪音）；且 stack.stop() 会删临时 game root，vite 若还活着
// 会因源文件消失再喷一轮报错。两者都走 SIGTERM → 4s 宽限 → SIGKILL 兜底（原语在 tests/helpers/proc.mjs）。
// vite stdout tee 到 test-results-ui/（排障用，与 stack.mjs 的 test-results/ 分开）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStack } from "../integration/harness.mjs";
import { installProcessCleanup, killGracefully } from "./proc.mjs";
import { waitFor } from "./poll.mjs";
import { spawnViteDev } from "./vite.mjs";

/** @typedef {import("../integration/harness.mjs").StackHandle} StackHandle */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
 * 起一套假引擎 UI 栈（假 ACP 引擎 + 真 acp-server + vite dev）。
 * @param {object} [options] 透传 startStack：{turns, presets, sessionImages, assets, audioFiles, trees, stateFiles, worlds, snapshots, indexSchema, indexExtra, legacyIndexArray, presetMd, covers, auth, codexAuth, credentials, extraEnv, homeDir}
 * @returns {Promise<{stack: StackHandle, pageUrl: string, stop: () => Promise<void>}>}
 */
export async function startFakeStack(options = {}) {
  const stack = await startStack(options); // 先起后端（含引擎握手与 SSE），失败自回收

  const children = [];
  let stopped = false;
  const stopVite = () => killGracefully(children);
  // 兜底：playwright 进程退出（含崩溃/中断）时同步杀 vite（acp-server 的兜底在 harness 里）。
  // exit=false 保持既有语义：本编排只收尾、不主动 process.exit（退出交给 Playwright 的处理器）。
  const emergencyKill = () => {
    for (const p of children) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  };
  const disposeCleanup = installProcessCleanup(emergencyKill, { signals: ["SIGINT", "SIGTERM"], exit: false });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // 摘掉兜底监听：9 个 spec 各自起停一套栈，不摘会累积监听并触发 MaxListenersExceededWarning
    // （removeListener 对已触发/未触发都安全；正常收尾走这里）。
    disposeCleanup();
    await stopVite(); // 先关页面入口，再停后端并删临时目录（理由见文件头）
    await stack.stop();
  };

  try {
    // vite dev：默认 5173，被占自动 +1；代理目标指向 harness 栈实际端口（启动样板在 tests/helpers/vite.mjs）
    const vite = await spawnViteDev({
      acpBase: stack.base,
      teeFile: path.join(ROOT, "test-results-ui", "vite-dev.log"),
      onSpawn: (p) => children.push(p),
    });
    // 探活两跳共用一个诊断槽：失败消息里贴的是**最后一跳**看到的 HTTP 状态/错误（不是一句光秃秃的 timeout）
    const probe = { last: "还没有探活结果" };
    await waitFor(() => httpProbe(vite.pageUrl, probe), {
      timeoutMs: 30_000,
      intervalMs: 100,
      label: "vite dev server http",
      detail: () => probe.last,
    });
    // 再等一次**经 Vite 代理**的 /api/auth：上面的只等 index.html，页面已能加载不等于 /api/* 的转发已热。
    // 冷代理下测试的首个 goto 会撞上「页面起来了、boot 的第一个 GET 却卡住」——启动屏停在
    // 「正在确认登录状态…」直到断言超时（历史上 flaky 的那一段）。先戳一次把代理路径捂热再交给用例。
    await waitFor(() => httpProbe(vite.pageUrl + "/api/auth", probe), {
      timeoutMs: 30_000,
      intervalMs: 100,
      label: "vite proxy /api/auth",
      detail: () => probe.last,
    });
    return { stack, pageUrl: vite.pageUrl, stop };
  } catch (e) {
    await stop(); // 启动中途失败也要回收子进程
    throw e;
  }
}
