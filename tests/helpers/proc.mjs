// 进程编排原语（tests/ 各编排器共用）：SIGTERM → 宽限期 → SIGKILL 的收尾、信号路径兜底清理、
// 「起进程并逐行等 stdout 命中」的样板、单跳 HTTP 探活。
//
// 为什么收在一处：这几段此前在 tests/integration/harness.mjs、tests/helpers/stack.mjs、
// tests/helpers/fake-stack.mjs 里各抄了一份（连 4s 宽限期与 90s 超时都靠注释互相同步）。任一份漂开都会
// 重新出现孤儿进程——AGENTS.md 记着实测留下过 3 只 acp-server（各占一个端口、roots 在 /var/folders/**）。
// 真源只留这里一份；各编排器只传自己的「杀谁」与「收到信号退不退」。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 信号 → 惯例退出码（128 + signo），`process.exit` 用 */
export const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

/**
 * SIGTERM → 等退出（宽限期内不退再 SIGKILL）。
 * 语义与三份旧实现逐字一致：进程已退出直接回；SIGTERM 后等 `graceMs`，到点补 SIGKILL；
 * kill 抛错（进程刚好退）也 resolve——收尾绝不把测试挂死。
 * @param {{exitCode: number|null, signalCode: NodeJS.Signals|null, kill: (signal?: NodeJS.Signals) => boolean}} proc 目标进程
 * @param {number} [graceMs] 宽限期（ms）
 * @returns {Promise<void>} 进程退出或宽限期到（已补 SIGKILL）后 resolve
 */
export function killProc(proc, graceMs = 4000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已经退了 */
      }
      resolve();
    }, graceMs);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      proc.kill("SIGTERM"); // acp-server 收 SIGTERM 会自带清理引擎子进程
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

/**
 * 并发收尾一组进程（每只走 {@link killProc} 的同款纪律）。
 * @param {Array<Parameters<typeof killProc>[0]>} procs 目标进程
 * @param {number} [graceMs] 宽限期（ms）
 * @returns {Promise<void>} 全部收尾后 resolve
 */
export function killGracefully(procs, graceMs = 4000) {
  return Promise.all(procs.map((p) => killProc(p, graceMs)));
}

/**
 * 安装「测试进程异常退出 / 收到信号时同步收尾子进程」的兜底，返回 dispose() 摘掉全部监听。
 *
 * **信号路径必须显式接管**：Node 收到 SIGINT/SIGTERM/SIGHUP/SIGQUIT 默认直接终止、**不触发 'exit'**——
 * 只挂 'exit' 等于漏掉 Ctrl-C、关终端（SIGHUP）、上层超时杀进程这三条路（实测留下过孤儿 acp-server）。
 * dispose() 必须由正常收尾调用：单个测试进程里 startStack 会被调用很多次（credentials 集成就起十几套），
 * 不摘会累积监听——实测 11 个 SIGINT 监听触发 MaxListenersExceededWarning。
 * @param {() => void} onExit 收尾动作（通常是「杀自己的子进程」）
 * @param {object} [opts]
 * @param {string[]} [opts.signals] 接管的信号（缺省 = {@link SIGNAL_EXIT_CODES} 的全部键）
 * @param {boolean} [opts.exit] 收到信号时是否 `process.exit(惯例码)`——保持各调用方既有语义
 *   （harness / real 栈主动退出；fake 栈只收尾，退出交给 Playwright 的处理器）
 * @returns {() => void} 摘掉全部监听（幂等）
 */
export function installProcessCleanup(onExit, { signals = Object.keys(SIGNAL_EXIT_CODES), exit = true } = {}) {
  const onExitEvent = () => {
    try {
      onExit();
    } catch {
      /* 收尾里再抛也不该盖住退出路径 */
    }
  };
  process.on("exit", onExitEvent);
  const handlers = signals.map((sig) => {
    const h = () => {
      onExitEvent();
      if (exit) process.exit(SIGNAL_EXIT_CODES[sig] ?? 1);
    };
    process.on(sig, h);
    return [sig, h];
  });
  return () => {
    process.removeListener("exit", onExitEvent);
    for (const [sig, h] of handlers) process.removeListener(sig, h);
  };
}

/**
 * 诊断 tee：把子进程输出原样落盘（排障看日志）。父目录自动建；写失败静默——
 * 诊断不该反过来把测试挂掉。
 * @param {string} file 落点
 * @returns {(chunk: Buffer | string) => void} 喂给子进程 data 事件的回调
 */
export function createTee(file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 建不出来就算了 */
  }
  try {
    appendFileSync(file, `--- start ${new Date().toISOString()} cwd=${process.cwd()} ---\n`);
  } catch {
    /* 同上 */
  }
  return (chunk) => {
    try {
      appendFileSync(file, chunk);
    } catch {
      /* 同上 */
    }
  };
}

// oxlint-disable-next-line eslint/no-control-regex -- ANSI 颜色码本身就是控制字符（\x1B），这条正则要的就是它
const ANSI_RE = /\x1B\[[0-9;]*m/g; // vite 在 CI 环境会给 banner 上色，颜色码会打断行匹配

/**
 * 起一个进程并逐行监听 stdout，直到 matcher 命中某行；onSpawn 在 spawn 后立刻回调（供清理注册）。
 * stdout 原样 tee 到 `teeFile`（给了才写）；stderr 转发到本进程 stderr 并留尾（早退消息里贴）。
 * @param {string} cmd 命令
 * @param {string[]} args 参数
 * @param {object} opts
 * @param {Record<string, string>} [opts.env] 追加进 process.env 的键值
 * @param {(line: string) => unknown} opts.matcher 逐行匹配（行已去 ANSI 颜色码）；返回真值即命中，该值进 resolve
 * @param {string} opts.label 人读标签（超时/早退消息里用，也是 stderr 转发前缀）
 * @param {number} [opts.timeoutMs] 等这一行的上限
 * @param {(proc: import("node:child_process").ChildProcess) => void} [opts.onSpawn] spawn 后立刻回调
 * @param {string} [opts.teeFile] 诊断日志落点（给了才 tee）
 * @param {string} [opts.cwd] 工作目录（缺省 = 仓库根）
 * @returns {Promise<{proc: import("node:child_process").ChildProcess, match: any}>} 命中的进程与 matcher 的返回值
 */
export function spawnAndAwaitLine(
  cmd,
  args,
  { env, matcher, label, timeoutMs = 90_000, onSpawn, teeFile, cwd = ROOT },
) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn?.(proc);
    const tee = teeFile ? createTee(teeFile) : null;
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timeout waiting for ${label} (stdout so far: ${buf.slice(-500)})`));
    }, timeoutMs);
    const onData = (chunk) => {
      tee?.(chunk);
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

/**
 * 单跳 HTTP 探活（失败不抛，回 false——轮询期间失败视同未就绪）。
 * @param {string} url 探的地址
 * @returns {Promise<boolean>} HTTP ok 与否
 */
export async function httpOk(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
