// 打包产物的定位与垫片写法（跨平台）：打包态 e2e（tests/e2e-packaged/）的公共基座。
//
// 为什么单独一个模块：win 产物只能在 Windows runner 上验（本机 macOS 交叉出不了 nsis/win-unpacked），
// 至少让「产物在哪、资源树在哪、垫片怎么写」这三段纯逻辑在本地有单测（tests/packaged-app.test.ts），
// 而不是等 CI 红了才知道路径写错了。
//
// 各平台的 --dir 产物布局：
//   macOS   release/mac-<arch>/Bunkiten.app/Contents/MacOS/Bunkiten   （资源在 Contents/Resources）
//   Windows release/win-unpacked/Bunkiten.exe                          （资源在同级 resources/）
//   Linux   release/linux-unpacked/bunkiten                            （未发布，留个口子）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * @typedef {object} PackagedApp
 * @property {string} exe 打包态可执行文件绝对路径
 * @property {string} resources 资源目录（resources/game 与 resources/codex-acp 都在它下面）
 * @property {string} label 人读的产物标识（跳过提示与断言消息里用）
 */

/**
 * 在 release/ 里找最近的打包产物。
 * macOS 分支**跳过 x64/ia32 目录**：mac 只出 arm64（ADR-0011 修订），历史遗留的 `release/mac-x64/`
 * 不该被拿去跑冒烟（万一它 mtime 更新就会顶着跑）。
 * @param {string} root 仓库根
 * @param {NodeJS.Platform} [platform] 平台（可注入——单测要覆盖三个分支，跑测试的机器只有一个平台）
 * @returns {PackagedApp | null} 找到的产物；没有时 null
 */
export function findPackagedApp(root, platform = process.platform) {
  const release = path.join(root, "release");
  if (!fs.existsSync(release)) return null;
  /** @type {(PackagedApp & {mtime: number})[]} */
  const candidates = [];
  for (const dir of fs.readdirSync(release, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = path.join(release, dir.name);
    /** @type {PackagedApp | null} */
    let found = null;
    if (platform === "darwin") {
      if (!dir.name.startsWith("mac") || /x64|ia32/.test(dir.name)) continue;
      const app = path.join(base, "Bunkiten.app");
      found = {
        exe: path.join(app, "Contents", "MacOS", "Bunkiten"),
        resources: path.join(app, "Contents", "Resources"),
        label: `${dir.name}/Bunkiten.app`,
      };
    } else if (platform === "win32") {
      found = {
        exe: path.join(base, "Bunkiten.exe"),
        resources: path.join(base, "resources"),
        label: `${dir.name}/Bunkiten.exe`,
      };
    } else {
      found = {
        exe: path.join(base, "bunkiten"),
        resources: path.join(base, "resources"),
        label: `${dir.name}/bunkiten`,
      };
    }
    if (!fs.existsSync(found.exe)) continue;
    candidates.push({ ...found, mtime: fs.statSync(found.exe).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const best = candidates[0];
  return best ? { exe: best.exe, resources: best.resources, label: best.label } : null;
}

/** 产物缺失时的跳过提示（按平台给对应的打包命令） @param {NodeJS.Platform} [platform] @returns {string} */
export function packagedSkipHint(platform = process.platform) {
  const script = platform === "darwin" ? "npm run dist:mac:dir" : platform === "win32" ? "npm run dist:win:dir" : null;
  return script
    ? `未找到打包产物：先跑 \`${script}\`（产物在 release/ 下，见 tests/helpers/packaged-app.mjs）`
    : "未找到打包产物，且本平台没有对应的 --dir 打包脚本（只有 mac / win 两条线）";
}

/**
 * 产物是否**必须**存在（v1.13）：CI 的 packaged-win job 刚跑完 `dist:win:dir` 就立刻跑冒烟，
 * 那里「找不到产物」是真失败（布局改了 / 铺场脚本没跑 / 产物名变了），不该被 test.skip 吞成绿。
 *
 * 不加这个开关时的病：`findPackagedApp` 返回 null → 整组 test.skip → job 报告成功、**一条断言都没跑**，
 * 「Windows 上的包真能开」这件事重新变成没有证据。开关由 CI 设（BUNKITEN_REQUIRE_PACKAGED=1），
 * 本机手动跑不设——没打包的人依旧是干净跳过，而不是先撞一堵失败的墙。
 * @returns {boolean} 是否要求产物必须存在
 */
export function packagedAppRequired() {
  return process.env.BUNKITEN_REQUIRE_PACKAGED === "1";
}

/**
 * 写一张 CLI 垫片（把某个命令指向「用同一个 node 跑某个脚本」，与 tests/integration/harness.mjs 同款约定）。
 * **Windows 必须写 `.cmd`**：`child_process.spawn` 在 Windows 上不做 PATHEXT 解析（裸名只补 `.exe`），
 * 而且解释器不是 sh——所以那边落一个批处理。
 * @param {string} dir 放垫片的目录（调用方保证已 mkdir）
 * @param {string} name 命令名（不带扩展名）
 * @param {string} nodeExe 解释器（通常是 process.execPath）
 * @param {string} script 要跑的脚本绝对路径
 * @returns {string} 垫片文件绝对路径
 */
export function writeCliShim(dir, name, nodeExe, script) {
  if (process.platform === "win32") {
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, `@echo off\r\n"${nodeExe}" "${script}" %*\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  const quote = (/** @type {string} */ s) => `'${s.replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(file, `#!/bin/sh\nexec ${quote(nodeExe)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  return file;
}

/**
 * 临时 HOME 的环境变量（跨平台）：
 * - `BUNKITEN_HOME` 是**我们自己的旋钮**（`server/config.mjs` 的 `gameHome()` + `electron/main.js` 的 PATH
 *   前缀）——acp-server 的凭据、登录态探测、目录缓存与「去哪找 grok」全跟着它走，Windows 上也生效；
 * - `HOME` 给 POSIX 工具链（node 之外的子进程）用；
 * - **刻意不动 `USERPROFILE`**：Windows 的 `os.homedir()` 读它，但 Chromium 也读——改它会让打包态应用
 *   在启动后立刻崩（实测 exitCode 0x80000003）。
 * @param {string} home 临时主目录 @returns {Record<string, string>} 追加进子进程 env 的键值
 */
export function homeEnv(home) {
  return { HOME: home, BUNKITEN_HOME: home };
}

/**
 * 杀掉整棵进程树。**Windows 上必须**：`ChildProcess.kill("SIGKILL")` 只终止目标进程，它自己 spawn 的
 * 子进程（Electron → acp-server/渲染进程；codex-acp → codex.exe）会活下来握着 stdout 管道——Playwright
 * 的 worker teardown 会一直等这些句柄，120s 后报「Worker teardown timeout」把绿着的用例判红（实测）。
 * POSIX 只 kill 目标进程（进程树由内核/父进程负责）。
 * @param {{pid?: number, exitCode: number|null, signalCode: NodeJS.Signals|null, kill: (signal?: NodeJS.Signals) => boolean} | null} proc 目标进程
 */
export function killTree(proc) {
  const pid = proc?.pid;
  if (!pid || !proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 已经退了 */
    }
  } else {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 已经退了 */
    }
  }
}

/**
 * 等子进程真的退出（Windows 上文件锁跟着进程走：KILL 之后还要等一拍，临时目录才删得掉）。
 * 超时就交给 {@link rmTemp} 的重试兜底，不在这里抛。
 * @param {import("node:child_process").ChildProcess | null} proc 目标进程 @param {number} [timeoutMs] 上限
 */
export async function waitForExit(proc, timeoutMs = 5000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    await Promise.race([
      new Promise((r) => proc.once("exit", () => r())),
      new Promise((r) => {
        timer = setTimeout(r, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 删临时目录：Windows 上进程刚退时文件锁可能还没放开——带重试（recursive 下 maxRetries 生效），清不掉就留给系统 */
export function rmTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 已经在系统临时目录里，删不掉不影响结论 */
  }
}
