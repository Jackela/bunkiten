// 世界三文件与逐轮快照的地基（v1.7 拆模块）：state/worlds/<worldId>/ 的三文件清单、
// 世界 id 白名单（WORLD_ID_RE）、三文件读写、history/NNNN.json 快照的读写与选择、分叉回退的纯函数。
// 世界线 CRUD（索引/导入导出/迁移）在上层 server/worlds.mjs——它 import 本模块，本模块不反向依赖。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 从入口 import）。
import fs from "fs";
import path from "path";
import { WORLDS_ROOT } from "./config.mjs";

export const WORLD_FILES = ["state.md", "summary.md", "story-tree.md"];
// 世界 id 白名单（防路径穿越）：世界线所有读写的第一道闸（快照与 CRUD 共用，所以钉在这层地基里）
export const WORLD_ID_RE = /^[A-Za-z0-9_-]+$/;
// ---------- 逐轮状态快照与精确回退（v1.6，CONTRACTS §2） ----------
// 目录 state/worlds/<worldId>/history/NNNN.json（4 位递增、append-only）。存整份文件的全文，
// 这样「精确回退」= 直接把快照三文件写回，不依赖引擎再推演（兼容路径才让引擎按 fork.md 校准）。
// worlds.mjs 的 importWorld 落快照文件用同一目录名（不抄第二份字面量）
export const HISTORY_DIRNAME = "history";
const SNAPSHOT_SEQ_MAX = 9999; // 4 位上限：seq > 9999 不再写（warn once），避免文件名溢出 5 位
const WORLD_FILE_KEY = { "state.md": "state", "summary.md": "summary", "story-tree.md": "tree" };
let warnedSnapshotOverflow = false; // 溢出告警只打一次（每回合都会触发判断，不去重会刷屏）

/**
 * 从 story-tree.md 解析当前进度指针（纯函数）：`- 当前进度: 节点 <id>（已走 X 轮）` → `<id>`。
 * 节点 id 到全角括号或空白为止（与 forkTreeMarkdown 写出的格式互为逆运算）。
 * @param {string} md 剧情树原文
 * @returns {string|null} 节点 id；无该行时 null
 */
export function parseTreePointer(md) {
  const m = /^-\s*当前进度\s*[:：]\s*节点\s*([^\s（(]+)/m.exec(String(md || ""));
  return m ? m[1] : null;
}

/**
 * 读世界三文件全文（缺失 = null）。快照条目与导出 bundle 的 files 都用这个形状。
 * @param {string} dir 世界目录绝对路径
 * @returns {{state: string|null, summary: string|null, tree: string|null}}
 */
export function readWorldFiles(dir) {
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
 * @param {{state?: string|null, summary?: string|null, tree?: string|null}} files 三文件全文
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
 * @param {object} [entry] 原始条目
 * @returns {{seq: number, at: string, kind: "turn"|"backup", nodeId: string|null, chapterNo: number|null, files: {state: string|null, summary: string|null, tree: string|null}}}
 */
export function normalizeSnapshot(entry = {}) {
  const files = entry.files && typeof entry.files === "object" ? entry.files : {};
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
 * @param {unknown} obj 待校验对象
 * @returns {boolean} 是否是合法的快照条目
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
 * @param {string} worldId 世界 id（调用方先用 WORLD_ID_RE 校验）
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {Array<object>} 规范化后的快照条目（含 files），按 seq 升序
 */
export function readSnapshots(worldId, root = WORLDS_ROOT) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return [];
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, worldId, HISTORY_DIRNAME));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^\d{1,4}\.json$/.test(name)) continue;
    try {
      const entry = normalizeSnapshot(JSON.parse(fs.readFileSync(path.join(root, worldId, HISTORY_DIRNAME, name), "utf8")));
      if (entry.seq >= 1) out.push(entry);
    } catch {}
  }
  return out.sort((a, b) => a.seq - b.seq);
}

// 历史目录里 seq 最大的一条（只看文件名 O(目录项数)，不读文件内容）。没有合法文件时 {seq:0, file:null}。
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
 * @returns {object|null} 规范化后的快照条目；不存在/坏档时 null
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
 * @param {object} entry 条目（seq 由本函数分配，忽略传入值）
 * @param {{dedupe?: boolean}} [opts]
 * @returns {{ok: true, seq: number, entry: object}|{skipped: true, reason: string, seq: number|null}}
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
  return { ok: true, seq, entry: final };
}

// 三文件全文是否逐字相同（去重判定用；只看内容，不看 at/kind）
function sameFiles(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 从快照列表里按节点挑「最早匹配」的一条（纯函数，CONTRACTS §2 的精确回退源）。
 * @param {Array<object>} snapshots 快照列表（顺序无所谓，内部按 seq 排序）
 * @param {string} nodeId 目标节点 id
 * @returns {object|null} 最早（seq 最小）的那个匹配快照；无匹配时 null
 */
export function selectSnapshotForNode(snapshots, nodeId) {
  const list = Array.isArray(snapshots) ? snapshots.filter((s) => s && typeof s === "object") : [];
  return list.filter((s) => s.nodeId === nodeId).sort((a, b) => a.seq - b.seq)[0] || null;
}

// 分叉回退（纯函数）：当前进度指针 → 目标节点、轮次清零、已剪枝恢复可达；
// 分叉点之后的情节视为尚未发生——由引擎按 fork.md 静默校准 state/summary（见 SKILL【世界线】）
export function forkTreeMarkdown(md, nodeId) {
  return String(md || "")
    .replace(/^-\s*当前进度\s*[:：].*$/m, `- 当前进度: 节点 ${nodeId}（已走 0 轮）`)
    .replace(/^(\s*-\s*状态\s*[:：]\s*)已剪枝\s*$/gm, "$1可达");
}

/** 分叉说明文件：给引擎的一次性回退指令（处理完引擎自行删除） */
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
