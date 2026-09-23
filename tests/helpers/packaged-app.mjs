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
      found = { exe: path.join(app, "Contents", "MacOS", "Bunkiten"), resources: path.join(app, "Contents", "Resources"), label: `${dir.name}/Bunkiten.app` };
    } else if (platform === "win32") {
      found = { exe: path.join(base, "Bunkiten.exe"), resources: path.join(base, "resources"), label: `${dir.name}/Bunkiten.exe` };
    } else {
      found = { exe: path.join(base, "bunkiten"), resources: path.join(base, "resources"), label: `${dir.name}/bunkiten` };
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
  const script = platform === "darwin" ? "npm run dist:mac:dir" : platform === "win32" ? "npm run dist:win:dir" : "npm run dist:linux:dir";
  return `未找到打包产物：先跑 \`${script}\`（产物在 release/ 下，见 tests/helpers/packaged-app.mjs）`;
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
