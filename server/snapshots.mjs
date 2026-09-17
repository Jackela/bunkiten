// 世界三文件与逐轮快照的地基（v1.7 拆模块）：state/worlds/<worldId>/ 的三文件清单、
// 世界 id 白名单（WORLD_ID_RE）、三文件读写、history/NNNN.json 快照的读写与选择、分叉回退的纯函数。
// 世界线 CRUD（索引/导入导出/迁移）在上层 server/worlds.mjs——它 import 本模块，本模块不反向依赖。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 从入口 import）。
import fs from "fs";
import path from "path";
import { WORLDS_ROOT } from "./config.mjs";

/** @type {readonly ["state.md", "summary.md", "story-tree.md"]} */
export const WORLD_FILES = ["state.md", "summary.md", "story-tree.md"];
// 世界 id 白名单（防路径穿越）：世界线所有读写的第一道闸（快照与 CRUD 共用，所以钉在这层地基里）
export const WORLD_ID_RE = /^[A-Za-z0-9_-]+$/;
// ---------- 逐轮状态快照与精确回退（v1.6，CONTRACTS §2） ----------
// 目录 state/worlds/<worldId>/history/NNNN.json（4 位递增、append-only）。存整份文件的全文，
// 这样「精确回退」= 直接把快照三文件写回，不依赖引擎再推演（兼容路径才让引擎按 fork.md 校准）。
// worlds.mjs 的 importWorld 落快照文件用同一目录名（不抄第二份字面量）
export const HISTORY_DIRNAME = "history";
const SNAPSHOT_SEQ_MAX = 9999; // 4 位上限：seq > 9999 不再写（warn once），避免文件名溢出 5 位
/** @type {Record<"state.md"|"summary.md"|"story-tree.md", "state"|"summary"|"tree">} */
const WORLD_FILE_KEY = { "state.md": "state", "summary.md": "summary", "story-tree.md": "tree" };

/**
 * 世界三文件全文（快照条目、导出 bundle 与各处读写的公共形状）：null = 该文件当时不存在。
 * @typedef {Object} SnapshotFiles
 * @property {string|null} state state.md 全文
 * @property {string|null} summary summary.md 全文
 * @property {string|null} tree story-tree.md 全文
 */

/**
 * 规范化后的快照条目（normalizeSnapshot 的产物 = 磁盘上唯一的条目形状）。
 * @typedef {Object} SnapshotEntry
 * @property {number} seq
 * @property {string} at
 * @property {"turn"|"backup"} kind
 * @property {string|null} nodeId
 * @property {number|null} chapterNo
 * @property {SnapshotFiles} files
 */
let warnedSnapshotOverflow = false; // 溢出告警只打一次（每回合都会触发判断，不去重会刷屏）

// readSnapshots 的列表缓存（v1.7 读路径索引化）：/api/history 列表形态会 strip 掉 files，
// 却照样为每次读付出「逐文件 readFileSync + JSON.parse 全文（含 files 大字符串）」——
// 长世界 history 目录上百条时每次打开剧情图都要全量解析一遍。
/**
 * @typedef {Object} SnapshotCacheSlot
 * @property {SnapshotEntry[]} entries 已按 seq 升序的规范化条目（缓存内部形状；出口一律给浅拷贝）
 * @property {Map<string, number>} stamp 文件名 → mtimeMs（失效判据：名字集合或任一 mtime 变了就全量重解析）
 */
/** @type {Map<string, SnapshotCacheSlot>} */
const snapCache = new Map(); // key = history 目录绝对路径
// 测试探针计数（__snapshotCacheStats 用；下划线开头表意仅测试消费）
const cacheStats = { parses: 0, hits: 0 };

/**
 * readSnapshots 缓存计数探针（**仅测试用**，tests/server.test.ts 断言缓存行为；
 * 产品代码不要依赖——它的存在就是为了让「缓存真的命中了」可断言）。
 * @returns {{parses: number, hits: number}} parses = 全量重解析次数、hits = stamp 一致命中次数
 */
export function __snapshotCacheStats() {
  return { ...cacheStats };
}

/**
 * 从 story-tree.md 解析当前进度指针（纯函数）：`- 当前进度: 节点 <id>（已走 X 轮）` → `<id>`。
 * 节点 id 到全角括号或空白为止（与 forkTreeMarkdown 写出的格式互为逆运算）。
 * @param {string|null} md 剧情树原文（null/undefined 视同空文本——调用方的三文件本来就允许缺失）
 * @returns {string|null} 节点 id；无该行时 null
 */
export function parseTreePointer(md) {
  const m = /^-\s*当前进度\s*[:：]\s*节点\s*([^\s（(]+)/m.exec(String(md || ""));
  return m ? m[1] : null;
}

/**
 * 读世界三文件全文（缺失 = null）。快照条目与导出 bundle 的 files 都用这个形状。
 * @param {string} dir 世界目录绝对路径
 * @returns {SnapshotFiles}
 */
export function readWorldFiles(dir) {
  /** @type {SnapshotFiles} */
  const out = { state: null, summary: null, tree: null };
  for (const f of WORLD_FILES) {
    try {
      out[WORLD_FILE_KEY[f]] = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      out[WORLD_FILE_KEY[f]] = null;
    }
  }
  return out;
}

/**
 * 把三文件写进世界目录（精确回退/精确分叉/导入共用）。
 * 快照三键就是**该时刻磁盘的真实快照**：字符串 = 写入；null/undefined = 当时不存在 → 删除既有文件。
 * 旧写法对 null 跳过不写，会让「当时 summary 还不存在」的快照在回退/精确分叉/导入后留下磁盘上后来才出现的
 * summary.md（「未来」内容），世界自相矛盾。所有调用方传的值都来自 normalizeSnapshot 或同形状对象，
 * 三键一律按「有则写、无则删」处理。
 * @param {string} dir 世界目录绝对路径
 * @param {{state?: unknown, summary?: unknown, tree?: unknown}} files 三文件全文（逐键 typeof 校验后才写盘，导入的 JSON 也走这里）
 */
export function writeWorldFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of WORLD_FILES) {
    const v = files?.[WORLD_FILE_KEY[f]];
    if (typeof v === "string") fs.writeFileSync(path.join(dir, f), v);
    else fs.rmSync(path.join(dir, f), { force: true }); // null/undefined = 快照时该文件不存在 → 一并清掉
  }
}

/**
 * 快照条目字段规范化（导出纯函数）：统一 seq 类型、at 默认当前时间、kind 归一、files 三键缺省 null。
 * 写盘与读取都走它，保证磁盘上的条目形状只有一个（导入校验也复用同一形状）。
 * @param {Partial<SnapshotEntry>} [entry] 原始条目（可能是刚 JSON.parse 出来的任意形状）
 * @returns {SnapshotEntry}
 */
export function normalizeSnapshot(entry = {}) {
  /** @type {Partial<SnapshotFiles>} */
  const files = entry.files && typeof entry.files === "object" ? entry.files : {};
  /** @param {unknown} v */
  const str = (v) => (typeof v === "string" ? v : null);
  const num = Number(entry.seq);
  return {
    seq: Number.isFinite(num) ? num : 0,
    at: typeof entry.at === "string" && entry.at ? entry.at : new Date().toISOString(),
    kind: entry.kind === "backup" ? "backup" : "turn",
    nodeId: entry.nodeId == null ? null : String(entry.nodeId),
    chapterNo: entry.chapterNo == null ? null : Number(entry.chapterNo),
    files: { state: str(files.state), summary: str(files.summary), tree: str(files.tree) },
  };
}

/**
 * 快照条目结构校验（导出纯函数，导入 bundle 用）：字段类型与取值域都必须合法。
 * @param {any} obj 待校验对象（JSON 直入，字段类型未知——函数体内逐字段 typeof/取值域检查，故入参按 any 收口）
 * @returns {obj is SnapshotEntry} 是否是合法的快照条目（filter 里当类型守卫用）
 */
export function isSnapshotEntry(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!Number.isInteger(obj.seq) || obj.seq < 1 || obj.seq > SNAPSHOT_SEQ_MAX) return false;
  if (typeof obj.at !== "string" || !obj.at) return false;
  if (obj.kind !== "turn" && obj.kind !== "backup") return false;
  if (obj.nodeId != null && typeof obj.nodeId !== "string") return false;
  if (obj.chapterNo != null && typeof obj.chapterNo !== "number") return false;
  const f = obj.files;
  if (!f || typeof f !== "object") return false;
  return WORLD_FILES.every((name) => f[WORLD_FILE_KEY[name]] === null || typeof f[WORLD_FILE_KEY[name]] === "string");
}

/**
 * 读某世界全部快照（升序）。文件名即 seq 来源；坏 JSON / 越界文件名一律跳过（不让单条坏档拖垮回退界面）。
 * 列表缓存（v1.7）：目录项「名字集合 + 逐文件 mtimeMs」与缓存 stamp 逐项一致 → 直接回缓存；
 * 不一致（新增/删除/覆盖快照文件）→ 全量重解析并更新缓存。出口条目一律拷贝（含 files 一层）——
 * 调用方拿到的是自己的数组与自己的条目对象，任何属性赋值都改不到缓存。
 * @param {string} worldId 世界 id（调用方先用 WORLD_ID_RE 校验）
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {SnapshotEntry[]} 规范化后的快照条目（含 files），按 seq 升序
 */
export function readSnapshots(worldId, root = WORLDS_ROOT) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return [];
  const dir = path.join(root, worldId, HISTORY_DIRNAME);
  let dirents = [];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // stamp：候选文件（合法 NNNN.json 且是普通文件）→ mtimeMs；stat 不到的文件不进 stamp，
  // 交给下面的重解析路径处理（那里 readFileSync 同样会跳过它）
  /** @type {Map<string, number>} */
  const stamp = new Map();
  for (const d of dirents) {
    if (!d.isFile() || !/^\d{1,4}\.json$/.test(d.name)) continue;
    try {
      stamp.set(d.name, fs.statSync(path.join(dir, d.name)).mtimeMs);
    } catch {}
  }
  const cached = snapCache.get(dir);
  if (cached && stamp.size === cached.stamp.size && [...stamp].every(([n, t]) => cached.stamp.get(n) === t)) {
    cacheStats.hits += 1;
    return copyEntries(cached.entries); // 深一层拷 files：出口不脏缓存由结构保证，不靠调用方自觉
  }
  cacheStats.parses += 1;
  const out = [];
  for (const name of stamp.keys()) {
    try {
      const entry = normalizeSnapshot(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
      if (entry.seq >= 1) out.push(entry);
    } catch {}
  }
  out.sort((a, b) => a.seq - b.seq);
  snapCache.set(dir, { entries: out, stamp });
  return copyEntries(out);
}

// 出口拷贝：条目浅拷 + files 三键再拷一层（成本是三个 string 引用赋值），调用方对返回值做任何
// 属性赋值都改不到缓存里的条目——把「只读契约」从注释不变式升级成结构保证。
/** @param {SnapshotEntry[]} entries @returns {SnapshotEntry[]} */
function copyEntries(entries) {
  return entries.map((e) => ({ ...e, files: { ...e.files } }));
}

/** 主动失效某个世界的快照缓存（writeSnapshot 写盘后与 deleteWorld 删目录后都调：
 *  mtime 比对已可兜底，但写方/删方主动失效让同进程下一次读立刻见新/释放内存，不等下次 readdir）。
 * @param {string} worldId 世界 id
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT） */
export function invalidateSnapshots(worldId, root = WORLDS_ROOT) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return;
  snapCache.delete(path.join(root, worldId, HISTORY_DIRNAME));
}

// 历史目录里 seq 最大的一条（只看文件名 O(目录项数)，不读文件内容）。没有合法文件时 {seq:0, file:null}。
/** @param {string} dir 历史目录绝对路径 @returns {{seq: number, file: string|null}} */
function latestSnapshot(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { seq: 0, file: null };
  }
  let seq = 0;
  let file = null;
  for (const name of names) {
    if (!/^\d{1,4}\.json$/.test(name)) continue;
    const n = Number(name.slice(0, -5)); // 去掉末尾 ".json"，取数字部分
    if (n > seq) {
      seq = n;
      file = name;
    }
  }
  return { seq, file };
}

// 读单条快照文件（name 为历史目录下的文件名）；坏档/越界返回 null。
/** @param {string} dir 历史目录绝对路径 @param {string} name 文件名 @returns {SnapshotEntry|null} */
function readSnapshotFile(dir, name) {
  try {
    const entry = normalizeSnapshot(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    return entry.seq >= 1 ? entry : null;
  } catch {
    return null;
  }
}

/**
 * 读单条快照全文（GET /api/history?seq= 用）：只读目标文件，不 parse 整个 history 目录。
 * @param {string} worldId 世界 id（调用方先用 WORLD_ID_RE 校验）
 * @param {number|string} seq 目标 seq
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {SnapshotEntry|null} 规范化后的快照条目；不存在/坏档时 null
 */
export function readSnapshot(worldId, seq, root = WORLDS_ROOT) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return null;
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1 || n > SNAPSHOT_SEQ_MAX) return null;
  const dir = path.join(root, worldId, HISTORY_DIRNAME);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = names.find((f) => /^\d{1,4}\.json$/.test(f) && Number(f.slice(0, -5)) === n);
  return name ? readSnapshotFile(dir, name) : null;
}

/**
 * 追加一条快照（seq = 上一条 + 1，起始 1）。
 * 去重：与上一条 files 全等则跳过（dedupe=false 时用于 backup——backup 必须落盘，否则恢复不了）。
 * 溢出：seq 将 > 9999 时不再写并 warn once。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @param {{kind?: "turn"|"backup", nodeId?: string|null, chapterNo?: number|null, files?: SnapshotFiles, at?: string, seq?: number}} entry 条目（seq 由本函数分配，忽略传入值）
 * @param {{dedupe?: boolean}} [opts]
 * @returns {{ok: true, seq: number, entry: SnapshotEntry}|{ok?: false, skipped: true, reason: string, seq: number|null}}
 *   失败分支的 ok 缺省（不是 false）：调用方一律按 `if (res.ok)` / `if (!res.ok)` 真值判定
 */
export function writeSnapshot(root, worldId, entry, { dedupe = true } = {}) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return { skipped: true, reason: "bad-world-id", seq: null };
  const dir = path.join(root, worldId, HISTORY_DIRNAME);
  // O(1)：last.seq 只由文件名推出（NNNN.json 里最大者），去重只 parse 这一条——
  // 不再全量 readFileSync + JSON.parse 整个 history 目录（长世界逐轮会越来越慢，且发生在 turn_end 广播前）。
  const last = latestSnapshot(dir);
  const norm = normalizeSnapshot(entry);
  if (dedupe && last.seq >= 1 && last.file) {
    const lastEntry = readSnapshotFile(dir, last.file);
    if (lastEntry && sameFiles(lastEntry.files, norm.files)) {
      return { skipped: true, reason: "duplicate", seq: last.seq };
    }
  }
  const seq = last.seq + 1;
  if (seq > SNAPSHOT_SEQ_MAX) {
    if (!warnedSnapshotOverflow) {
      warnedSnapshotOverflow = true;
      console.warn(`[acp] 世界 ${worldId} 的快照已达上限 ${SNAPSHOT_SEQ_MAX}，此后的逐轮快照不再写入`);
    }
    return { skipped: true, reason: "overflow", seq: null };
  }
  const final = { ...norm, seq };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${String(seq).padStart(4, "0")}.json`), JSON.stringify(final, null, 2) + "\n");
  // 写方主动失效：mtime 比对已可兜底（新文件名必然不在 stamp 里），但同进程读要立刻见新，
  // 不等下一次 readSnapshots 的 readdir/stat 比对——逐轮落盘后紧跟着的 /api/history 就是这个场景
  invalidateSnapshots(worldId, root);
  return { ok: true, seq, entry: final };
}

// 三文件全文是否逐字相同（去重判定用；只看内容，不看 at/kind）
/** @param {SnapshotFiles} a @param {SnapshotFiles} b @returns {boolean} */
function sameFiles(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 从快照列表里按节点挑「最早匹配」的一条（纯函数，CONTRACTS §2 的精确回退源）。
 * @param {SnapshotEntry[]} snapshots 快照列表（顺序无所谓，内部按 seq 排序）
 * @param {string} nodeId 目标节点 id
 * @returns {SnapshotEntry|null} 最早（seq 最小）的那个匹配快照；无匹配时 null
 */
export function selectSnapshotForNode(snapshots, nodeId) {
  const list = Array.isArray(snapshots) ? snapshots.filter((s) => s && typeof s === "object") : [];
  return list.filter((s) => s.nodeId === nodeId).sort((a, b) => a.seq - b.seq)[0] || null;
}

// 分叉回退（纯函数）：当前进度指针 → 目标节点、轮次清零、已剪枝恢复可达；
// 分叉点之后的情节视为尚未发生——由引擎按 fork.md 静默校准 state/summary（见 SKILL【世界线】）
/** @param {string} md 剧情树原文 @param {string} nodeId 目标节点 id @returns {string} 回退后的树原文 */
export function forkTreeMarkdown(md, nodeId) {
  return String(md || "")
    .replace(/^-\s*当前进度\s*[:：].*$/m, `- 当前进度: 节点 ${nodeId}（已走 0 轮）`)
    .replace(/^(\s*-\s*状态\s*[:：]\s*)已剪枝\s*$/gm, "$1可达");
}

/** 分叉说明文件：给引擎的一次性回退指令（处理完引擎自行删除）
 *  @param {string} originWorldId 来源世界 id @param {string} nodeId 分叉节点 id @param {Date} [at] 分叉时间 @returns {string} fork.md 全文 */
export function forkNote(originWorldId, nodeId, at = new Date()) {
  return [
    "# 分叉说明",
    `- 来源世界: ${originWorldId}`,
    `- 分叉节点: ${nodeId}`,
    `- 分叉时间: ${at.toISOString()}`,
    "",
    `本世界由「${originWorldId}」在节点 ${nodeId} 处手动分叉：当前进度指针已回退到该节点，节点之后的情节尚未发生。`,
    "请在首个回合内静默完成两件事，然后删除本文件，照常续演：",
    "1. 把 state.md 与 summary.md 回退到分叉节点之前的一致状态（删去分叉点之后的记录，好感度/Flag/伏笔做保守修正）；",
    "2. 校准 story-tree.md 的节点状态与本世界既有剧情一致。",
    "绝不向玩家输出任何说明文字。",
    "",
  ].join("\n");
}
