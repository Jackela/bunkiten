// 世界三文件与逐轮快照的地基（v1.7 拆模块）：state/worlds/<worldId>/ 的三文件清单、
// 世界 id 白名单（WORLD_ID_RE）、三文件读写、history/NNNN.json 快照的读写与选择、分叉回退的纯函数，
// 以及 logs/NNNN.json 回合原文日志（writeTurnLog，v1.7）。
// 世界线 CRUD（索引/导入导出/迁移）在上层 server/worlds.mjs——它 import 本模块，本模块不反向依赖。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 从入口 import）。
import fs from "fs";
import path from "path";
import { WORLDS_ROOT } from "./config.mjs";
import { writeFileAtomic } from "./atomic-fs.mjs";

/** 三文件里的剧情树文件名（fork/listWorlds/migrate 与 /api/tree 直接读写它——单一字面，别再手写） */
export const TREE_FILE = "story-tree.md";
/** @type {readonly ["state.md", "summary.md", "story-tree.md"]} */
export const WORLD_FILES = ["state.md", "summary.md", TREE_FILE];
// 世界 id 白名单（防路径穿越）：世界线所有读写的第一道闸（快照与 CRUD 共用，所以钉在这层地基里）
export const WORLD_ID_RE = /^[A-Za-z0-9_-]+$/;
// ---------- 逐轮状态快照与精确回退（v1.6，CONTRACTS §2） ----------
// 目录 state/worlds/<worldId>/history/NNNN.json（4 位递增、append-only）。存整份文件的全文，
// 这样「精确回退」= 直接把快照三文件写回，不依赖引擎再推演（兼容路径才让引擎按 fork.md 校准）。
// worlds.mjs 的 importWorld 落快照文件用同一目录名（不抄第二份字面量）
export const HISTORY_DIRNAME = "history";
const SNAPSHOT_SEQ_MAX = 9999; // 4 位上限：seq > 9999 不再写（warn once），避免文件名溢出 5 位
/** @type {Record<"state.md"|"summary.md"|"story-tree.md", "state"|"summary"|"tree">} */
const WORLD_FILE_KEY = { "state.md": "state", "summary.md": "summary", [TREE_FILE]: "tree" };

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
 * @property {string} prompt 可重演的玩家输入（v1.13，docs/adr/0023）：输入与其产生的状态同条目绑定。
 *   只记玩家叙事输入——客户端的开局/续玩指令回填空串（它们是客户端生成的指令，不是玩家的话）、
 *   backup 条目也没有；旧档没有该字段，normalize 统一为 ""（重演入口据此降级提示，不回填）
 * @property {SnapshotFiles} files
 */
/**
 * 快照条目的**元字段**（readSnapshots 列表形态，v1.14 轻量化）：不含 `files` 三文件全文。
 * 列表/剧情图只要这些（`GET /api/history` 的列表形态本就 strip 掉 files/prompt）；要全文的调用方
 * （回退/精确分叉/导出）走 readSnapshot / readSnapshotEntries 现读盘。
 * @typedef {Object} SnapshotMeta
 * @property {number} seq
 * @property {string} at
 * @property {"turn"|"backup"} kind
 * @property {string|null} nodeId
 * @property {number|null} chapterNo
 * @property {string} prompt 可重演的玩家输入（v1.13，docs/adr/0023）
 */
let warnedSnapshotOverflow = false; // 溢出告警只打一次（每回合都会触发判断，不去重会刷屏）

/** 快照/日志文件名：4 位递增 seq（`NNNN.json`）——**只此一份**（v1.13 收口：此前同一个正则在本文件出现四遍） */
const SEQ_FILE_RE = /^\d{1,4}\.json$/;

// readSnapshots 的列表缓存（v1.7 读路径索引化，v1.14 轻量化 + LRU）：/api/history 列表形态只要元字段，
// 而每条快照的 `files` 是三份文件全文（长世界条目可达 MB 级）——把全文长期驻留在长开的 Electron 进程里
// 纯属浪费。现在缓存只留**元字段**（seq/at/kind/nodeId/chapterNo/prompt），按「文件名 + mtimeMs」逐条复用；
// 只有新增/被覆盖的文件需要读盘解析。要三文件全文的调用方（回退/精确分叉/导出）现走 readSnapshot /
// readSnapshotEntries 现读盘——列表视图与全文视图各有各的路，不再让列表替所有人扛着大字符串。
/**
 * @typedef {Object} SnapshotCacheSlot
 * @property {Map<string, {mtimeMs: number, meta: SnapshotMeta}>} byFile 文件名 → 已解析元字段与解析时的 mtimeMs
 */
/** @type {Map<string, SnapshotCacheSlot>} */
const snapCache = new Map(); // key = history 目录绝对路径（LRU：最近访问排队尾）
// 缓存按 world（history 目录）计数，超过就丢最久未用的：同进程里切来切去玩很多条世界线时，
// 别让 Map 无限长大（每条只是一把元字段，8 个 world 的量级足够覆盖剧情图/世界线屏的来回切屏）。
const SNAP_CACHE_MAX_WORLDS = 8;
// 测试探针计数（__snapshotCacheStats 用；下划线开头表意仅测试消费）
const cacheStats = { parses: 0, hits: 0 };

/** 超上限时丢最久未用的 history 目录（Map 的插入序即访问序：访问时 delete+set 挪到队尾） */
function evictSnapCache() {
  while (snapCache.size > SNAP_CACHE_MAX_WORLDS) {
    const oldest = snapCache.keys().next().value;
    if (oldest === undefined) return;
    snapCache.delete(oldest);
  }
}

/**
 * readSnapshots 缓存计数探针（**仅测试用**，tests/server.test.ts 断言缓存行为；
 * 产品代码不要依赖——它的存在就是为了让「缓存真的命中了」可断言）。
 * @returns {{parses: number, hits: number}} parses = 逐文件解析次数（全量重解析 N 个文件即 +N）、
 *   hits = 零解析完成（全部条目复用）的读取次数
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

/** 精确回退/精确分叉/导入覆盖三文件期间落下的「进行中」标记文件名（writeWorldFiles 开头落、写完删） */
export const RESTORE_MARKER_FILE = ".restore-in-progress";

/**
 * 把三文件写进世界目录（精确回退/精确分叉/导入共用）。
 * 快照三键就是**该时刻磁盘的真实快照**：字符串 = 写入；null/undefined = 当时不存在 → 删除既有文件。
 * 旧写法对 null 跳过不写，会让「当时 summary 还不存在」的快照在回退/精确分叉/导入后留下磁盘上后来才出现的
 * summary.md（「未来」内容），世界自相矛盾。所有调用方传的值都来自 normalizeSnapshot 或同形状对象，
 * 三键一律按「有则写、无则删」处理。
 * 原子性（v1.14）：逐文件 writeFileAtomic（写到一半被杀不会留半截文件），整段开头落一个
 * `.restore-in-progress` 标记、写完删——启动期 findInProgressRestores 能发现「上次回退写到一半就断电」的世界。
 * @param {string} dir 世界目录绝对路径
 * @param {{state?: unknown, summary?: unknown, tree?: unknown}} files 三文件全文（逐键 typeof 校验后才写盘，导入的 JSON 也走这里）
 */
export function writeWorldFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, RESTORE_MARKER_FILE);
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`); // 标记本身小且可重建，直写即可
  } catch {
    /* 标记写不下（只读目录等）不挡写盘：自愈面的告警不值得让回退/导入失败 */
  }
  try {
    for (const f of WORLD_FILES) {
      const v = files?.[WORLD_FILE_KEY[f]];
      if (typeof v === "string") writeFileAtomic(path.join(dir, f), v);
      else fs.rmSync(path.join(dir, f), { force: true }); // null/undefined = 快照时该文件不存在 → 一并清掉
    }
  } finally {
    try {
      fs.rmSync(marker, { force: true }); // 无论成败都清标记：失败的那次由调用方按异常处理，不该把它一直挂在那里
    } catch {}
  }
}

/**
 * 列出带「回退进行中」标记的世界目录（启动期告警与测试用）：上次精确回退/精确分叉/导入写到一半就中断，
 * 该世界的三文件可能停在半中间（回退前的旧文件 + 回退后的新文件混着）。读到什么算什么（读不出目录 = 空数组）。
 * @param {string} root 世界根目录
 * @returns {string[]} 世界 id 列表（未排序，按目录枚举序）
 */
export function findInProgressRestores(root) {
  let dirents = [];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (fs.existsSync(path.join(root, d.name, RESTORE_MARKER_FILE))) out.push(d.name);
  }
  return out;
}

/**
 * 快照条目字段规范化（导出纯函数）：统一 seq 类型、at 默认当前时间、kind 归一、prompt 缺省空串、
 * files 三键缺省 null。写盘与读取都走它，保证磁盘上的条目形状只有一个（导入校验也复用同一形状）。
 * @param {Record<string, unknown>} [entry] 原始条目（刚 JSON.parse 出来的任意形状；字段逐个 typeof 收敛。
 *   声明成 Partial<SnapshotEntry> 是在撒谎——本函数的全部意义就是把类型不对的输入收敛成合法形状）
 * @returns {SnapshotEntry}
 */
export function normalizeSnapshot(entry = {}) {
  /** @type {Partial<SnapshotFiles>} */
  const files =
    entry.files && typeof entry.files === "object" ? /** @type {Partial<SnapshotFiles>} */ (entry.files) : {};
  /** @param {unknown} v */
  const str = (v) => (typeof v === "string" ? v : null);
  const num = Number(entry.seq);
  return {
    seq: Number.isFinite(num) ? num : 0,
    at: typeof entry.at === "string" && entry.at ? entry.at : new Date().toISOString(),
    kind: entry.kind === "backup" ? "backup" : "turn",
    nodeId: entry.nodeId == null ? null : String(entry.nodeId),
    chapterNo: entry.chapterNo == null ? null : Number(entry.chapterNo),
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
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
  // 缺省合法：v1/v2 导出包与旧档没有 prompt 字段，照收（导入后 normalize 为 ""，重演入口降级提示）
  if (obj.prompt != null && typeof obj.prompt !== "string") return false;
  const f = obj.files;
  if (!f || typeof f !== "object") return false;
  return WORLD_FILES.every((name) => f[WORLD_FILE_KEY[name]] === null || typeof f[WORLD_FILE_KEY[name]] === "string");
}

/**
 * 读某世界全部快照的**元字段列表**（升序）。文件名即 seq 来源；坏 JSON / 越界文件名一律跳过
 * （不让单条坏档拖垮回退界面）。**不含 files**（v1.14 轻量化）——要三文件全文的调用方走
 * readSnapshot（单条）或 readSnapshotEntries（全部，导出用）。
 * 列表缓存（v1.7 逐文件复用，v1.14 只缓存元字段 + 按 world 的 LRU）：文件名 + mtimeMs 都没变的条目直接
 * 沿用缓存里的解析结果，只有新增/被覆盖的文件才读盘解析；文件被删除时随新表自然消失。出口条目一律浅拷贝——
 * 调用方拿到的是自己的数组与自己的条目对象，任何属性赋值都改不到缓存。
 * @param {string} worldId 世界 id（调用方先用 WORLD_ID_RE 校验）
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {SnapshotMeta[]} 规范化后的快照元字段，按 seq 升序
 */
export function readSnapshots(worldId, root = WORLDS_ROOT) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return [];
  const dir = path.join(root, worldId, HISTORY_DIRNAME);
  let dirents = [];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    snapCache.delete(dir); // 目录没了：顺手释放缓存，别让它挂在 Map 里
    return [];
  }
  // stamp：候选文件（合法 NNNN.json 且是普通文件）→ mtimeMs；stat 不到的文件不进 stamp，
  // 交给下面的重解析路径处理（那里 readFileSync 同样会跳过它）
  /** @type {Map<string, number>} */
  const stamp = new Map();
  for (const d of dirents) {
    if (!d.isFile() || !SEQ_FILE_RE.test(d.name)) continue;
    try {
      stamp.set(d.name, fs.statSync(path.join(dir, d.name)).mtimeMs);
    } catch {}
  }
  let slot = snapCache.get(dir);
  if (!slot) slot = { byFile: new Map() };
  // LRU：访问即挪到队尾（Map 插入序 = 访问序），再按上限淘汰最久未用的 world
  snapCache.delete(dir);
  snapCache.set(dir, slot);
  evictSnapCache();
  let parsed = 0;
  /** @type {SnapshotCacheSlot["byFile"]} */
  const next = new Map();
  for (const [name, mtimeMs] of stamp) {
    const prev = slot.byFile.get(name);
    if (prev && prev.mtimeMs === mtimeMs) {
      next.set(name, prev); // 复用：不读盘、不解析
      continue;
    }
    const meta = readSnapshotMeta(dir, name); // 坏档 → null（不进缓存，下次再试）
    if (!meta) continue;
    next.set(name, { mtimeMs, meta });
    parsed += 1;
  }
  slot.byFile = next; // 已被删除的文件名随新表消失
  if (parsed === 0) {
    // 整表零解析才算「命中」；空目录/整目录坏档（readSnapshotMeta 返回 null、永不入缓存）不算
    if (next.size > 0) cacheStats.hits += 1;
  } else cacheStats.parses += parsed;
  const out = [...next.values()].map((x) => x.meta).sort((a, b) => a.seq - b.seq);
  return copyMetas(out);
}

// 出口拷贝：条目浅拷（成本是几个字段赋值），调用方对返回值做任何属性赋值都改不到缓存里的条目——
// 把「只读契约」从注释不变式升级成结构保证。
/** @param {SnapshotMeta[]} metas @returns {SnapshotMeta[]} */
function copyMetas(metas) {
  return metas.map((m) => ({ ...m }));
}

/** 整体释放某个世界的快照缓存（deleteWorld 删目录后调用；缓存本身只留元字段，但别让它挂着已删的世界）。
 *  写盘路径**不需要**调用它——缓存按「文件名 + mtime」逐条复用，产品路径只写新文件名，天然未命中；
 *  外部原地覆盖写由逐文件 mtime 比对兜底。
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
    if (!SEQ_FILE_RE.test(name)) continue;
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

// 读单条快照文件的**元字段**（列表缓存用）：与 readSnapshotFile 同一份 normalize，只少留 files。
/** @param {string} dir 历史目录绝对路径 @param {string} name 文件名 @returns {SnapshotMeta|null} */
function readSnapshotMeta(dir, name) {
  const entry = readSnapshotFile(dir, name);
  if (!entry) return null;
  return {
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    nodeId: entry.nodeId,
    chapterNo: entry.chapterNo,
    prompt: entry.prompt,
  };
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
  const name = names.find((f) => SEQ_FILE_RE.test(f) && Number(f.slice(0, -5)) === n);
  return name ? readSnapshotFile(dir, name) : null;
}

/**
 * 读某世界**全部快照连三文件全文**（升序）：导出打包装箱用（worlds.exportWorld）。
 * 与 readSnapshots 的区别只在每条都真读盘解析 files——列表/剧情图别用它（那是 readSnapshots 的活，
 * 它刻意不背大字符串）。不走缓存：导出是低频动作，现读现解析最简单也最不会错。
 * @param {string} worldId 世界 id（调用方先用 WORLD_ID_RE 校验）
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {SnapshotEntry[]} 完整快照条目（含 files），按 seq 升序；非法世界 id / 目录不存在为空数组
 */
export function readSnapshotEntries(worldId, root = WORLDS_ROOT) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return [];
  const dir = path.join(root, worldId, HISTORY_DIRNAME);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!SEQ_FILE_RE.test(name)) continue;
    const entry = readSnapshotFile(dir, name); // 坏档跳过（不让单条坏档拖垮导出）
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 追加一条快照（seq = 上一条 + 1，起始 1）。
 * 去重：**没有新东西可说就跳过**——三文件与上一条全等，且这次没有新的玩家输入（prompt 为空，
 * 或与上一条相同）。玩家输入永远落盘（files 相同也是新的一幕：「最新带输入的 turn 条目 ⟺ 最新一幕」
 * 的重演不变量靠它，docs/adr/0023）；续玩/读档这类空输入回合只有真的改了文件才落盘。
 * dedupe=false 时用于 backup——backup 必须落盘，否则恢复不了。
 * 溢出：seq 将 > 9999 时不再写并 warn once。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @param {{kind?: "turn"|"backup", nodeId?: string|null, chapterNo?: number|null, prompt?: string, files?: SnapshotFiles, at?: string, seq?: number}} entry 条目（seq 由本函数分配，忽略传入值）
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
    if (lastEntry) {
      // lastEntry 经 normalizeSnapshot，prompt 恒为字符串——空输入（指令/续玩）只有内容也全等才跳过
      const nothingNew =
        sameFiles(lastEntry.files, norm.files) && (norm.prompt === "" || lastEntry.prompt === norm.prompt);
      if (nothingNew) return { skipped: true, reason: "duplicate", seq: last.seq };
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
  writeFileAtomic(path.join(dir, `${String(seq).padStart(4, "0")}.json`), JSON.stringify(final, null, 2) + "\n");
  // 无需失效快照列表缓存：seq 递增意味着这里**永远写新文件名**（产品路径没有任何「原地覆盖同名快照」的写法——
  // importWorld 写全新目录、fork/restore 不写 history），新名字天然未命中，下一次 readSnapshots 只解析这一个文件。
  // 外部进程若在同一秒内原地覆盖同名文件，理论上可能被 mtime 粒度漏判（历史行为同款、无产品路径触发）。
  return { ok: true, seq, entry: final };
}

// 三文件全文是否逐字相同（去重判定的一半；另一半是 prompt——只看内容，不看 at/kind）
/** @param {SnapshotFiles} a @param {SnapshotFiles} b @returns {boolean} */
function sameFiles(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 从快照列表里按节点挑「最早匹配」的一条（纯函数，CONTRACTS §2 的精确回退源）。
 *
 * 类型按「实际读到什么」声明（v1.13）：函数只读 `nodeId` 与 `seq`，且显式容忍 null/非数组/非对象元素
 * （读路径永不抛）。此前声明成 `SnapshotEntry[]` 同样是在撒谎——它让「传一条只有 seq/nodeId 的候选」
 * 在类型上不成立，而实现明明吃得下。用模板参数保真：给什么形状就回什么形状。
 * @template {{seq: number, nodeId: string|null}} T
 * @param {readonly T[]|null} snapshots 快照列表（顺序无所谓，内部按 seq 排序；null/非数组 → 无匹配）
 * @param {string} nodeId 目标节点 id
 * @returns {T|null} 最早（seq 最小）的那个匹配快照；无匹配时 null
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

// ---------- 回合原文日志（v1.7）：logs/NNNN.json ----------
// 目录 state/worlds/<worldId>/logs/NNNN.json（与 history/ 平级、4 位递增、append-only、不清理）。
// 存 {seq, at, prompt, text}（v1.14 起可选带 cancelled/error）——正戏回合「发了什么 + 引擎回了什么」的原文：
// turnText 只在内存累积、回合结束随下次 sendPrompt 清空，出问题（引擎胡言乱语、缺选项段、被玩家停掉、
// 超时失败）无法回溯，这份日志就是回溯面。与快照是两回事：快照存三文件全文（回退用），日志存叙事原文
// （排查 / 回想用）——快照去重（duplicate）的回合日志照写；也**不进世界线导出包**（exportWorld 只读三文件与
// history/，见 worlds.mjs 的注释）。
export const LOGS_DIRNAME = "logs";
let warnedLogOverflow = false; // 溢出告警只打一次（与 warnedSnapshotOverflow 同款理由）

/**
 * 一条回合原文日志（磁盘形状；读取时**原样**返回，缺省字段按实际有无）。
 * @typedef {Object} TurnLogEntry
 * @property {number} seq
 * @property {string} at
 * @property {string} prompt 本轮发出去的字（与快照的 prompt 口径不同：那是「只记玩家输入」，见 ADR-0023）
 * @property {string} text 引擎本轮产出的叙事原文
 * @property {boolean} [cancelled] 被玩家停掉的回合（v1.14）
 * @property {string} [error] 被判失败的回合的引擎错误原文（v1.14）
 */

// logs 目录里 seq 最大的一条（只看文件名，O(目录项数)；与 latestSnapshot 同款，只是不需要返回文件名）
/** @param {string} dir logs 目录绝对路径 @returns {number} 最大 seq；目录不存在/无合法文件时 0 */
function latestLogSeq(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let seq = 0;
  for (const name of names) {
    if (!SEQ_FILE_RE.test(name)) continue;
    const n = Number(name.slice(0, -5));
    if (n > seq) seq = n;
  }
  return seq;
}

/**
 * 追加一条回合原文日志（v1.7，与 writeTurnSnapshot 同判定、同时机调用）。
 * seq 取向：优先与同回合快照对齐（entry.seq 用 writeSnapshot 的返回——ok 与 duplicate 两个分支都带 seq，
 * history 与 logs 起步前都为空、每回合同增，正常路径天然 1:1 对齐）；对齐值追不上 logs 自己的进度时
 * （快照去重的回合日志照写、restore 的 backup 只进 history，两边步进会错位）退回 logs 的 max+1——
 * append-only 永不让步：任何路径都不覆盖既有文件。溢出（>9999）与 writeSnapshot 同款截断（warn once、不再写）。
 * v1.14 加两个**可选**留痕字段：`cancelled`（被玩家停掉的回合）与 `error`（被判失败的回合的引擎错误原文）——
 * 只在显式给出且为真/非空时写入条目，既有调用零改动（不传就是老形状 {seq,at,prompt,text}）。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @param {{seq?: number|null, at?: string, prompt?: string, text?: string, cancelled?: boolean, error?: string}} entry
 *   seq 为快照对齐提示（见上）；at 缺省当前时间；prompt/text 缺省空串；cancelled/error 缺省不写
 * @returns {{ok: true, seq: number}|{ok?: false, skipped: true, reason: "bad-world-id"|"overflow"}}
 *   失败分支的 ok 缺省（与 writeSnapshot 同款真值判定口径）
 */
export function writeTurnLog(root, worldId, entry = {}) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return { skipped: true, reason: "bad-world-id" };
  const dir = path.join(root, worldId, LOGS_DIRNAME);
  const last = latestLogSeq(dir);
  // 对齐值合法且领先 logs 进度才用（Math.max 语义）；追不上就自己递增——绝不写已存在的序号
  const want = Number(entry.seq);
  const seq = Number.isInteger(want) && want > last ? want : last + 1;
  if (seq > SNAPSHOT_SEQ_MAX) {
    if (!warnedLogOverflow) {
      warnedLogOverflow = true;
      console.warn(`[acp] 世界 ${worldId} 的回合日志已达上限 ${SNAPSHOT_SEQ_MAX}，此后的回合日志不再写入`);
    }
    return { skipped: true, reason: "overflow" };
  }
  /** @type {TurnLogEntry} */
  const final = {
    seq,
    at: typeof entry.at === "string" && entry.at ? entry.at : new Date().toISOString(),
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
    text: typeof entry.text === "string" ? entry.text : "",
  };
  if (entry.cancelled) final.cancelled = true;
  if (typeof entry.error === "string" && entry.error) final.error = entry.error;
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, `${String(seq).padStart(4, "0")}.json`), JSON.stringify(final, null, 2) + "\n");
  return { ok: true, seq };
}

// 读一条日志文件（按 seq 推文件名）；坏档/不存在返回 null。读取一律现读现解析——logs 是 append-only 的
// 长目录，缓存换不来什么（回想面板一页十几条），正确性优先。
/** @param {string} dir logs 目录绝对路径 @param {number} seq 序号 @returns {TurnLogEntry|null} */
function readTurnLogFile(dir, seq) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${String(seq).padStart(4, "0")}.json`), "utf8"));
    return raw && typeof raw === "object" ? /** @type {TurnLogEntry} */ (raw) : null;
  } catch {
    return null;
  }
}

/**
 * 读某世界的回合日志（**最新在前**，`before` 翻页）——GET /api/logs 的落地（回想面板的数据源）。
 * 分页：只看 seq < before 的条目（before 缺省/非法 = 不限上界），取最新的 `limit` 条；`nextBefore`
 * = 还有更老的条目时「本页最老一条的 seq」（下次拿它当 before），没有更老的则为 null。
 * @param {{root?: string, worldId: string, before?: number|null, limit?: number}} params
 *   before = 只取 seq 严格小于它的条目（翻页游标）；limit 缺省 50，非法/≤0 也按 50
 * @returns {{entries: TurnLogEntry[], nextBefore: number|null}} entries 最新在前
 */
export function readTurnLogs({ root = WORLDS_ROOT, worldId, before = null, limit = 50 }) {
  /** @type {{entries: TurnLogEntry[], nextBefore: number|null}} */
  const empty = { entries: [], nextBefore: null };
  if (!WORLD_ID_RE.test(String(worldId || ""))) return empty;
  const dir = path.join(root, worldId, LOGS_DIRNAME);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return empty; // 无 logs 目录 = 没有日志（契约：不报错）
  }
  const seqs = names
    .filter((n) => SEQ_FILE_RE.test(n))
    .map((n) => Number(n.slice(0, -5)))
    .sort((a, b) => b - a); // 最新在前
  const lim = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const cap = before == null || !Number.isFinite(Number(before)) ? Infinity : Number(before);
  const matched = seqs.filter((s) => s < cap);
  const picked = matched.slice(0, lim);
  const entries = [];
  for (const s of picked) {
    const entry = readTurnLogFile(dir, s);
    if (entry) entries.push(entry); // 坏档跳过，不让单条坏档拖垮回想面板
  }
  const nextBefore = matched.length > picked.length ? picked[picked.length - 1] : null;
  return { entries, nextBefore };
}

/**
 * 读单条回合日志（按 seq）：不存在/坏档/非法参数返回 null。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @param {number|string} seq 目标 seq
 * @returns {TurnLogEntry|null}
 */
export function readTurnLog(root, worldId, seq) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return null;
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1 || n > SNAPSHOT_SEQ_MAX) return null;
  return readTurnLogFile(path.join(root, worldId, LOGS_DIRNAME), n);
}
