// 把 codex-acp 及其**依赖闭包**从本地 node_modules 铺到 build/codex-acp/node_modules/（v1.11，docs/adr/0022），
// 供 electron-builder 的 extraResources 原样搬进 `resources/codex-acp/node_modules`——打包态
// `server/engines.mjs` 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑闭包里的
// `@agentclientprotocol/codex-acp/dist/index.js`，node 的向上查找会在同一个 node_modules 里解析它的兄弟依赖。
//
// 为什么是「闭包拷贝」而不是再跑一次 npm install：① 不开第二次网络安装（`npm ci` 已经装好了）；
// ② 版本与开发态逐字一致，不会有第二份版本解析；③ 只带运行期真正需要的包——平台二进制由 npm 的
// optionalDependencies 决定（构建机是什么平台就带什么平台的 @openai/codex-*，CI 的 mac/win 矩阵天然各带各的）。
//
// 用法：node scripts/stage-codex-acp.mjs [--arch=arm64|x64]（dist:* 脚本在 electron-builder 之前调用，
// 并把 electron-builder 的目标架构传进来）。缺依赖（没跑过 npm ci / 没装 codex-acp）时直接失败并给人话——
// 打包少一个会崩的后端不如当场红。
//
// **架构自检（v1.11 收尾）**：平台二进制由 npm 按「装依赖那台机器」的架构解析，所以「目标 arch ≠ 构建机
// arch」时产物里会躺着错架构的二进制（App 装得上、Codex 后端一跑就废）——这里当场拦。这也是 mac 端
// 只出 arm64（不再 --x64 交叉打包）的原因之一，见 docs/adr/0011 的「修订」段。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "node_modules");
const OUT = path.join(ROOT, "build", "codex-acp", "node_modules");
const ENTRY = "@agentclientprotocol/codex-acp";

/** 目标架构（`--arch=`；缺省 = 构建机架构） */
const TARGET_ARCH = (process.argv.find((a) => a.startsWith("--arch=")) || "").split("=")[1] || process.arch;

/** 平台二进制包名（`@openai/codex-<platform>-<arch>`，见 @openai/codex 的 optionalDependencies） */
const CODEX_PLATFORM_PKG = `@openai/codex-${process.platform}-${TARGET_ARCH}`;

/**
 * 架构自检：目标架构必须就是构建机架构（我们自己只做本机构建）。
 * @throws {Error} 交叉打包时（构建机会装错平台的二进制）
 */
function assertTargetArch() {
  if (TARGET_ARCH === process.arch) return;
  throw new Error(
    `目标架构 ${TARGET_ARCH} ≠ 构建机 ${process.arch}：随包的 codex 平台二进制是按构建机解析的（npm 的 optionalDependencies），` +
      `交叉打包会把 ${process.arch} 的二进制塞进 ${TARGET_ARCH} 产物（App 装得上、Codex 后端一跑就废）。` +
      `请在目标架构的机器/runner 上打包（CI 的 mac/win 矩阵就是这么做的；mac 只出 arm64）。`,
  );
}

/** 读一个包的 package.json（缺/坏回 null） @param {string} dir @returns {any} */
function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 依赖闭包 BFS。必需依赖（dependencies）缺一个就抛；**可选依赖（optionalDependencies）缺失即跳过**——
 * `@openai/codex` 把每个平台二进制都声明成可选项，npm 只装当前平台的那一个，其余在 node_modules 里
 * 本来就不存在（这正是「构建机是什么平台就带什么平台的二进制」的机制）。peer/peerOptional 不装（npm 也不装）。
 * @param {string} entry 入口包名（npm 形态，可带 scope）
 * @returns {{names: string[], skipped: string[]}} 需要拷贝的包名（含入口）+ 跳过的可选包名
 */
function collectClosure(entry) {
  const seen = new Set();
  /** @type {Map<string, boolean>} 缺失的包 → 是否被必需依赖引用过 */
  const missing = new Map();
  /** @type {Array<{name: string, required: boolean}>} */
  const queue = [{ name: entry, required: true }];
  while (queue.length > 0) {
    const { name, required } = /** @type {{name: string, required: boolean}} */ (queue.shift());
    if (seen.has(name)) continue;
    const pkg = readPkg(path.join(SRC, name));
    if (!pkg) {
      if (required) missing.set(name, true);
      else if (!missing.has(name)) missing.set(name, false);
      continue;
    }
    seen.add(name);
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, required: true });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      if (!seen.has(dep) && !queue.some((q) => q.name === dep && q.required))
        queue.push({ name: dep, required: false });
    }
  }
  const hard = [...missing.entries()].filter(([, req]) => req).map(([n]) => n);
  if (hard.length > 0)
    throw new Error(`node_modules 里缺必需依赖：${hard.join(", ")}——先跑 npm ci（或 npm i -D ${ENTRY}）再打包`);
  return { names: [...seen], skipped: [...missing.keys()] };
}

const { names, skipped } = collectClosure(ENTRY);

/** 目录字节数（打包体积打印用） @param {string} dir @returns {number} */
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      /* 符号链接等：跳过量体积 */
    }
  }
  return total;
}

assertTargetArch();
fs.rmSync(path.join(ROOT, "build", "codex-acp"), { recursive: true, force: true });
let count = 0;
for (const name of names) {
  const from = path.join(SRC, name);
  const to = path.join(OUT, name);
  if (!fs.existsSync(from)) throw new Error(`缺依赖目录：${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
  // npm 会把包内嵌套的 .bin 软链一起带出来——对运行期无用，清掉免得拷进产物里指错地方
  const nestedBin = path.join(to, "node_modules", ".bin");
  fs.rmSync(nestedBin, { recursive: true, force: true });
  count += 1;
}

const entryFile = path.join(OUT, ENTRY, "dist", "index.js");
if (!fs.existsSync(entryFile))
  throw new Error(`入口脚本不存在：${entryFile}（${ENTRY} 的 bin 变了？见 server/engines.mjs 的 codexAcpCommand）`);
// 目标架构的平台二进制必须在树里（架构自检已在开头做过；这里确认那条依赖真的被 npm 装下来了）
if (!names.includes(CODEX_PLATFORM_PKG)) {
  throw new Error(
    `依赖闭包里没有 ${CODEX_PLATFORM_PKG}：本机 node_modules 没装这个平台的 codex 二进制` +
      `（先跑 npm ci；或目标架构与构建机不符——那正是开头架构自检拦的情况）`,
  );
}

const mb = (dirSize(path.join(ROOT, "build", "codex-acp")) / 1024 / 1024).toFixed(1);
const skippedNote = skipped.length > 0 ? `；跳过 ${skipped.length} 个非本平台的可选依赖` : "";
console.log(
  `[stage-codex-acp] ${count} 个包（目标 ${TARGET_ARCH}，平台二进制 ${CODEX_PLATFORM_PKG}）→ build/codex-acp/node_modules（${mb} MB）${skippedNote}；入口 ${path.relative(ROOT, entryFile)}`,
);
