// vite dev 服务器的启动样板（tests/helpers/stack.mjs 与 tests/helpers/fake-stack.mjs 共用）。
//
// 两边都要「起 `node node_modules/vite/bin/vite.js` → 解析 stdout 的 `Local:` 行拿 pageUrl」，
// 此前各抄一份（连 ANSI 去色与 `ACP_PROXY_TARGET`/`NO_COLOR` 两个 env 都靠注释互相同步）——
// 真源只留这里一份。
//
// **只负责起进程与解析地址**：起栈后的 HTTP 探活由调用方按自己的口径做
// （fake 栈要先探一次**经 Vite 代理**的 /api/auth 把转发路径捂热，real 栈只探 index）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAndAwaitLine } from "./proc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 起 vite dev（默认 5173，被占自动 +1），把 `ACP_PROXY_TARGET` 指向给定后端，解析 `Local:` 行拿 pageUrl。
 * @param {object} opts
 * @param {string} opts.acpBase acp-server 的 base（如 `http://localhost:12345`）
 * @param {string} [opts.teeFile] 诊断日志落点（给了才 tee）
 * @param {(proc: import("node:child_process").ChildProcess) => void} [opts.onSpawn] spawn 后立刻回调（供清理注册）
 * @param {number} [opts.timeoutMs] 等 `Local:` 行的上限
 * @returns {Promise<{proc: import("node:child_process").ChildProcess, pageUrl: string}>} 进程与页面地址（已去尾斜杠）
 */
export async function spawnViteDev({ acpBase, teeFile, onSpawn, timeoutMs = 30_000 }) {
  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const { proc, match } = await spawnAndAwaitLine(process.execPath, [viteBin], {
    env: { ACP_PROXY_TARGET: acpBase, NO_COLOR: "1" }, // NO_COLOR：颜色码会打断 `Local:` 行匹配
    matcher: (line) => /Local:\s+(http:\/\/\S+?\/)/.exec(line),
    label: "vite dev server",
    timeoutMs,
    onSpawn,
    teeFile,
  });
  return { proc, pageUrl: String(match[1]).replace(/\/$/, "") };
}
