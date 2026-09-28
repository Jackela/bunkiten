// server/data-root.mjs — 打包态可写数据根（v1.14，ADR-0024）：一次性迁移 + 每次启动 seed-sync。
//
// 背景：此前打包态一切可写数据都落在 app bundle 内的 resources/game，macOS 覆盖安装会整包替换
// （v1.6 发布说明还写着「不会被覆盖安装清掉」——错的），玩家的世界线/快照/素材随之消失。
// 现在 bundle 只做只读种子（.grok/、app-dist、随包 presets），数据根 = app.getPath("userData")/game
// （main 进程注入 BUNKITEN_DATA_ROOT，dev 不设 → DATA_ROOT === GAME_ROOT，行为一字不变）。
//
// 两条职责（都幂等，随每次启动跑；由 electron/main.js 在 import acp-server 之前调用）：
//   ① 一次性迁移：数据根那一片（state/ 与 presets/ 各自独立判定）还空着、bundle 里有货 → 整树复制
//      （**复制不删源**，失败保底；旧 bundle 里的数据原样留在原地）。.shell-session.json 缺则补。
//   ② seed-sync：bundle presets 里每个文件——数据根缺 → 补拷；已有且**内容仍等于种子哈希**（玩家没改过）
//      → 随版本更新覆盖；玩家改过的一律不碰。种子哈希记账在 `<数据根>/presets/.seeded.json`。
// 刻意不做：不动 bundle 的 state/ 里除首次迁移外的任何东西（那只是 README 种子）；不动 .grok/ 与 app-dist。
import fs from "fs";
import path from "path";
import crypto from "crypto";

/** 种子哈希清单文件名（落在 `<数据根>/presets/` 下，键 = 相对数据根的 posix 路径） */
export const SEEDED_FILE = ".seeded.json";

/**
 * 文件内容 sha1（种子记账用；只在「比对玩家是否改过」与「登记新品种子」时调用）。
 * @param {string} file 绝对路径
 * @returns {string} 十六进制 sha1
 */
function sha1File(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

/** @typedef {Record<string, string>} SeedManifest rel → sha1 */

/**
 * 读取种子清单；缺文件/坏 JSON/形态不对都当「没有」（返回空对象），绝不抛。
 * @param {string} dataRoot 数据根
 * @returns {SeedManifest} rel → sha1
 */
export function readSeedManifest(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, "presets", SEEDED_FILE), "utf8"));
    const files = raw && typeof raw === "object" && raw.files && typeof raw.files === "object" ? raw.files : null;
    /** @type {SeedManifest} */
    const out = {};
    if (files) {
      for (const [k, v] of Object.entries(files)) if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写种子清单（tmp+rename 原子落盘；失败静默——种子记账坏一次的代价只是「下次不自动更新已改文件」，不值得挡启动）。
 * @param {string} dataRoot 数据根
 * @param {SeedManifest} files rel → sha1
 */
export function writeSeedManifest(dataRoot, files) {
  const dir = path.join(dataRoot, "presets");
  const file = path.join(dir, SEEDED_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, files }, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清临时文件也失败就随它去 */
    }
  }
}

/**
 * 某剧本是不是「随包种子」（任一文件在种子清单里被登记过）→ 是则不可删除
 * （随包内容删了下次启动 seed-sync 也会补回来，删除入口直接拒才诚实）。
 * @param {string} dataRoot 数据根
 * @param {string} presetId 剧本目录名
 * @returns {boolean} 是否随包种子
 */
export function isSeededPreset(dataRoot, presetId) {
  const prefix = `presets/${presetId}/`;
  return Object.keys(readSeedManifest(dataRoot)).some((k) => k.startsWith(prefix));
}

/**
 * 递归列出目录下所有文件的相对路径（posix 风格、按字典序；目录不存在返回空）。
 * @param {string} dir 目录
 * @returns {string[]} 相对路径列表
 */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} cur 当前绝对目录 @param {string} rel 当前相对前缀 */
  const step = (cur, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) step(abs, r);
      else if (e.isFile()) out.push(r);
    }
  };
  step(dir, "");
  return out.sort();
}

/**
 * 整树复制（目录不存在是 no-op；目标逐文件覆盖写）。
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 */
function copyTree(src, dest) {
  if (!fs.existsSync(src)) return;
  for (const rel of walkFiles(src)) {
    const to = path.join(dest, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, ...rel.split("/")), to);
  }
}

/**
 * 准备数据根：一次性迁移 + seed-sync（见文件头两条职责）。幂等，可随每次启动调用。
 * `migrate=false`（dev）或 `dataRoot === bundleRoot` 时直接返回（零行为）。
 * @param {{ dataRoot: string, bundleRoot: string, migrate?: boolean }} opts 数据根 / 只读内容根 / 是否迁移
 * @returns {{ migrated: boolean, seeded: number, updated: number }} 本次动作计数（日志与测试用）
 */
export function prepareDataRoot({ dataRoot, bundleRoot, migrate = false }) {
  /** @type {{ migrated: boolean, seeded: number, updated: number }} */
  const result = { migrated: false, seeded: 0, updated: 0 };
  fs.mkdirSync(dataRoot, { recursive: true });
  if (!migrate) return result;
  if (path.resolve(dataRoot) === path.resolve(bundleRoot)) return result;

  const manifest = readSeedManifest(dataRoot);
  const bundlePresets = path.join(bundleRoot, "presets"); // bundle 的随包剧本树（迁移与 seed-sync 共用）

  // ① 一次性迁移：state/ 与 presets/ 各自独立判定（避免「一半迁过」时漏掉另一半）
  const freshState = !fs.existsSync(path.join(dataRoot, "state"));
  const freshPresets = !fs.existsSync(path.join(dataRoot, "presets"));
  if (freshState) {
    copyTree(path.join(bundleRoot, "state"), path.join(dataRoot, "state"));
    result.migrated = true;
  }
  if (freshPresets) {
    copyTree(bundlePresets, path.join(dataRoot, "presets"));
    result.migrated = true;
    // 迁移复制出来的每一个文件都是**原封未动的官方种子**——连同哈希登记进清单。
    // 漏了这一步会同时坏两件事：① seed-sync 的「已登记才随版本更新」分支永远轮不到它们（升级新增/改过的
    // 官方 preset.md、cover、audio 静默停在旧版）；② isSeededPreset 判 false，内置剧本会被当成玩家自有剧本
    // 放行删除（删掉删完下次启动又补回来）。这里只登记、不覆盖：freshPresets 为真意味着目标目录本来不存在。
    for (const rel of walkFiles(bundlePresets)) {
      manifest[`presets/${rel}`] = sha1File(path.join(bundlePresets, ...rel.split("/")));
    }
  }
  const sessionSrc = path.join(bundleRoot, ".shell-session.json");
  const sessionDest = path.join(dataRoot, ".shell-session.json");
  if (fs.existsSync(sessionSrc) && !fs.existsSync(sessionDest)) {
    try {
      fs.copyFileSync(sessionSrc, sessionDest);
    } catch {
      /* 续档文件复制失败不值得挡启动 */
    }
  }

  // ② seed-sync：bundle presets → 数据根（缺补、未改过随版本更新、改过不碰）
  for (const rel of walkFiles(bundlePresets)) {
    const key = `presets/${rel}`;
    const src = path.join(bundlePresets, ...rel.split("/"));
    const dest = path.join(dataRoot, ...key.split("/"));
    const srcHash = sha1File(src);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      manifest[key] = srcHash;
      result.seeded += 1;
      continue;
    }
    const recorded = manifest[key];
    if (!recorded) continue; // 未登记（玩家自有/迁移前就在）→ 不碰
    const destHash = sha1File(dest);
    if (destHash === srcHash) continue; // 已经一致
    if (destHash === recorded) {
      fs.copyFileSync(src, dest); // 玩家没改过 → 随版本更新
      manifest[key] = srcHash;
      result.updated += 1;
    }
    // else：玩家改过（destHash !== recorded）→ 保留玩家的
  }
  writeSeedManifest(dataRoot, manifest);
  return result;
}
