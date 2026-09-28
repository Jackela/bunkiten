// 世界线（state/worlds/<worldId>/）的索引、迁移、建 / 分叉 / 删、导出导入（v1.7 拆模块）。
// 角色面板的解析与视图 v1.13 拆去 server/state-view.mjs（那是本文件里唯一一块「只管读 state.md」的活）。
// 每个世界三份文件：state.md / summary.md / story-tree.md；index.json 记录元数据（chapterNo/lastPlayed 由磁盘自愈）。
// 三文件读写与快照逻辑在下层 server/snapshots.mjs，本模块只做索引与 CRUD。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 与 scripts/doctor.mjs 都从入口 import）。
// 索引 schema 迁移（migrateWorldsSchema，ROADMAP §1 / ADR-0018）已接启动路径：与其余符号一起 re-export，
// 由入口 startServer 在 migrateLegacyState 之后调一次；同一批改动把 writeWorldsIndex 的写形态翻成
// `{schema: 1, worlds}`（读路径本来就两种形态都认——先翻写形态、后接迁移会造出「读到一半的世界」）。
import fs from "fs";
import path from "path";
import { DATA_ROOT, WORLDS_ROOT } from "./config.mjs";
import { ASSET_DELETE_FILE_RE, PRESET_ID_RE, moveToTrash, mtimeOf, uniqueSuffixedName } from "./assets.mjs";
import { scanPresets } from "./presets.mjs";
import { writeFileAtomic } from "./atomic-fs.mjs";
import {
  WORLD_FILES,
  WORLD_ID_RE,
  TREE_FILE,
  HISTORY_DIRNAME,
  parseTreePointer,
  readWorldFiles,
  writeWorldFiles,
  normalizeSnapshot,
  isSnapshotEntry,
  readSnapshots,
  readSnapshot,
  readSnapshotEntries,
  writeSnapshot,
  selectSnapshotForNode,
  forkTreeMarkdown,
  forkNote,
  invalidateSnapshots,
} from "./snapshots.mjs";

// moveToTrash（删除进回收站的唯一入口）v1.14 起**真源在 assets.mjs**：世界线删除（本模块）、素材删除（routes）、
// 剧本删除（presets）三处都要它，而 presets 不能反向 import 本模块（本模块已 import presets 的 scanPresets，
// 再接回去就是环）。这里逐名 re-export，外部 import 面（acp-server / routes / tests 都从本模块拿它）一字不变。
export { moveToTrash };

// 回收站（v1.7，ADR-0014）：删除不直删——世界线目录与素材文件先整体挪进 state/trash/，误删可手工找回；
// 把目录/文件挪进 trash 的**唯一入口** `moveToTrash` v1.14 起住 assets.mjs（见上方 re-export 处的说明），
// 本模块只在 deleteWorld 与回收站恢复里调它。
/**
 * state/worlds/index.json 的一条世界元数据（listWorlds 的返回在此基础上再补 exists/自愈字段）。
 * @typedef {Object} WorldIndexEntry
 * @property {string} worldId
 * @property {string} preset
 * @property {string} title
 * @property {string} [label] 展示名（v1.6 起可选；老索引缺失时 listWorlds 补空串）
 * @property {string} [note]
 * @property {number} chapterNo
 * @property {number} lastPlayed
 * @property {{worldId: string, nodeId: string, seq?: number}|null} [forkedFrom]
 * @property {Record<string, string>} [snapshotLabels] 玩家给存档点起的名字（v1.12，`{"<seq>": "<名字>"}`）——
 *   索引层的展示元数据，不写进 append-only 的快照文件
 */

/**
 * 世界线导出包的**对外形状**（`<worldId>.world.json`，v3）：exportWorld 造它、importWorld 认它，
 * 客户端 `parseWorldBundle` 与测试都按同一形状读。
 *
 * 为什么单独写成一个 typedef（v1.13）：此前 exportWorld 的返回是 `{bundle?: object}`，
 * 于是每个消费者都得 `as any` 才能碰 `.world.files`——测试里 70 处 `as any` 有一大半来自它。
 * 形状写在这里，类型检查才管得住「导出/导入两侧字段对齐」这件事。
 * @typedef {object} WorldBundle
 * @property {string} format 恒为 WORLD_BUNDLE_FORMAT（导入侧据此拒绝杂包）
 * @property {number} version 1..WORLD_BUNDLE_VERSION（导入接受区间，不是等值）
 * @property {string} exportedAt 导出时刻（ISO）
 * @property {object} world 世界本体
 * @property {string} world.worldId
 * @property {string} world.preset
 * @property {string} world.title
 * @property {string} world.label 玩家改的展示名（未改则空串）
 * @property {string} world.note
 * @property {number} world.chapterNo
 * @property {{worldId: string, nodeId: string, seq?: number}|null} world.forkedFrom 血缘（v2 起；v1 包与手建世界为 null）
 * @property {import("./snapshots.mjs").SnapshotFiles} world.files 三文件全文（不存在的为 null）
 * @property {import("./snapshots.mjs").SnapshotEntry[]} world.snapshots 全部快照（含 at/kind/nodeId/chapterNo/prompt/files）
 * @property {string|null} world.forkMd fork.md 全文（没有该文件时为 null）
 */

/**
 * 全量导出包（`exportAllWorlds` 的产物 / `GET /api/worlds/export?all=1`）：一层容器套多个 WorldBundle。
 * @typedef {object} WorldsBundle
 * @property {string} format 恒为 WORLDS_BUNDLE_FORMAT
 * @property {number} version 容器版本（1）
 * @property {string} exportedAt 导出时刻（ISO）
 * @property {WorldBundle[]} worlds 每个世界一个单体 bundle（与单独导出 `<worldId>.world.json` 逐字同形）
 */

/**
 * state/worlds/index.json 的**版本化**形态（v1.9 起 writeWorldsIndex 写它，见 indexDocumentFor）。读路径两种形态都认。
 * @typedef {{schema: number, worlds: WorldIndexEntry[]}} VersionedWorldsIndex
 */

/**
 * 索引文件的两种顶层形态 → 条目数组；认不出来返回 null（fail-soft 的单一判定点）。
 * ① 裸数组（v1.8 及以前写的形态；启动期由 migrateWorldsSchema 升成 ②）；
 * ② 版本化对象 `{ schema, worlds }`（今天 writeWorldsIndex 写的形态）。schema 号只记录、不做闸门：
 *    只要 worlds 是数组就照读（条目仍逐条校验），多出来的顶层键一律忽略；未知版本对象自有校验兜底。
 * @param {unknown} data JSON.parse 的原始结果
 * @returns {WorldIndexEntry[]|null} 类型上声称是世界元数据；`worldId` 是不是字符串由 readWorldsIndex 逐条滤（旧口径的显式化）
 */
function indexEntriesOf(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  const worlds = /** @type {{worlds?: unknown}} */ (data).worlds;
  return Array.isArray(worlds) ? worlds : null;
}

/**
 * 读世界线索引（两种顶层形态都认，见 indexEntriesOf）。
 * 自愈（v1.14）：文件缺失 / 坏 JSON / 结构不认识（`{schema:1}` 没有 worlds、worlds 非数组）时**按磁盘重建**
 * ——遍历 `state/worlds/` 下的每个世界目录，用磁盘真况造条目（preset 从 state.md 读、chapterNo 从 story-tree.md 读、
 * lastPlayed 取目录 mtime）。**只读不写**：读路径绝不覆写索引（坏 JSON 也可能只是写了一半，覆写等于把玩家的
 * 世界线列表写没了），要不要落盘交给调用方 / 下次写路径。
 * @param {string} root 世界根目录
 * @returns {WorldIndexEntry[]} 索引条目；索引读不出来时 = 磁盘扫描重建的结果
 */
export function readWorldsIndex(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, "index.json"), "utf8");
  } catch {
    return rebuildWorldsIndex(root); // 文件不在（手删 / 首次迁移中途）→ 也从磁盘读到什么算什么
  }
  let list;
  try {
    list = indexEntriesOf(JSON.parse(raw));
  } catch {
    return rebuildWorldsIndex(root); // 坏 JSON
  }
  if (list === null) return rebuildWorldsIndex(root); // 结构不认识
  return list.filter((e) => e && typeof e.worldId === "string");
}

/**
 * 索引读不出来时的**磁盘重建**（v1.14 自愈）：遍历 `state/worlds/` 下每个目录，按每个世界目录的现状造条目。
 * preset 从 `state.md` 读（presetFromStateFile）、chapterNo 从 `story-tree.md` 读、lastPlayed 取目录 mtime；
 * title/label/note 置空、forkedFrom 置 null（这些只有索引里才有，磁盘上没有——显示层对空值有回退链）。
 * @param {string} root 世界根目录
 * @returns {WorldIndexEntry[]} 重建出的条目（目录级乱序，调用方各自排）；目录不存在时为空数组
 */
function rebuildWorldsIndex(root) {
  let dirents = [];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // 目录都不在：全新安装 / 路径未定 → 空世界列表
  }
  /** @type {WorldIndexEntry[]} */
  const out = [];
  for (const d of dirents) {
    if (!d.isDirectory() || !WORLD_ID_RE.test(d.name)) continue;
    const dir = path.join(root, d.name);
    let tree = null;
    try {
      tree = fs.readFileSync(path.join(dir, TREE_FILE), "utf8");
    } catch {}
    out.push({
      worldId: d.name,
      preset: presetFromStateFile(d.name, root),
      title: "",
      label: "",
      note: "",
      chapterNo: tree != null ? worldChapterNo(tree) : 1,
      lastPlayed: mtimeOf(dir),
      forkedFrom: null,
    });
  }
  return out;
}

/**
 * 落盘对象形态的唯一判定点（纯函数，root 不参与）：**只有 `worlds` 是要写入的新值，其余一律沿用磁盘上那一份**。
 *   ① 上一份读不出来（缺文件 / 坏 JSON）或就是裸数组 → `{schema: 1, worlds}`（v1.9 起的当前形态；
 *      顺带让「写回」本身也能把裸数组升上来，即便启动期迁移这次没跑到）；
 *   ② 上一份是版本化对象（非数组对象）→ 读改写：`schema` 与**所有其它顶层键原样保留**，只换 `worlds`。
 *      其中最重要的一条是**永不降级写回**：`schema: 2` 的索引经新版本写、再被旧版本程序写时仍是 2。
 *      玩家降级安装后旧版把它改写成 `{schema: 1}`，等于替未来版本宣布「这就是 schema 1 的结构」——
 *      升级回来时既认不出它是新结构（标记自相矛盾），也判断不出该不该再迁移，只能靠猜。
 *      `schema` 缺失或不是正整数时才补 1（写者自己知道写的是什么形态，不该留一个不可比的版本号）。
 * 读改写之间不取锁：本仓既有约定（索引只有一个写者——server 在 Electron 主进程内同步写；`updateWorld`
 * 等三个写点都是「读一次、改、整份写回」）。跨进程并发写在这里早就互相覆盖，不在这条路径上发明新机制。
 * @param {unknown} prev 现有 index.json 的 JSON.parse 结果（缺文件/坏 JSON 时传 undefined）
 * @param {WorldIndexEntry[]} list 要写入的完整条目列表
 * @returns {VersionedWorldsIndex & Record<string, unknown>} 落盘对象（当前形态恒含 `schema` 与 `worlds`）
 */
function indexDocumentFor(prev, list) {
  if (prev && typeof prev === "object" && !Array.isArray(prev)) {
    const prevObj = /** @type {Record<string, unknown>} */ (prev);
    const schema =
      typeof prevObj.schema === "number" && Number.isInteger(prevObj.schema) && prevObj.schema >= 1
        ? prevObj.schema
        : 1;
    return { ...prevObj, schema, worlds: list };
  }
  return { schema: 1, worlds: list };
}

/**
 * 写世界线索引：顶层 `{schema: 1, worlds}`（v1.9 起；v1.8 及以前是裸数组，readWorldsIndex 两种都认）。
 * `list` 整体覆写 `worlds`；顶层其它键见 indexDocumentFor（未来 schema 与其未知键原样保留，不降级写回）。
 * 落盘形态（v1.14）：写前把上一份 rename 成 `index.json.bak`（缺则不复制），新内容走 writeFileAtomic
 *（tmp + rename）——写到一半被杀不会留下半截索引，且误写还有一份上一版可回退。
 * @param {string} root 世界根目录
 * @param {WorldIndexEntry[]} list 完整索引
 */
export function writeWorldsIndex(root, list) {
  const file = path.join(root, "index.json");
  /** @type {unknown} */
  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    prev = undefined; // 缺文件 / 读不动 / 坏 JSON：都按「没有可沿用的上一份」处理
  }
  fs.mkdirSync(root, { recursive: true });
  // 写前留一份上一版：先删旧 .bak 再 rename（Windows 上 rename 覆盖既有文件的行为不统一，显式删更稳）
  if (fs.existsSync(file)) {
    try {
      fs.rmSync(`${file}.bak`, { force: true });
      fs.renameSync(file, `${file}.bak`);
    } catch {
      /* 留不下 .bak 不挡写：索引原子的那份（writeFileAtomic）才是主保护 */
    }
  }
  writeFileAtomic(file, JSON.stringify(indexDocumentFor(prev, list), null, 2) + "\n");
}

/**
 * 世界线索引 schema 的一次性升级：旧裸数组重写成 `{schema: 1, worlds}`（ROADMAP §1 / ADR-0018，
 * 由入口 startServer 在 migrateLegacyState 之后调用一次）。
 * 四种输入四种结局，全部不抛错、且天然幂等：
 *   缺文件 / 读不动 → false（**不创建文件**：全新安装不该被迁移顺手造出一个空索引）；
 *   顶层是数组     → 重写成 `{schema: 1, worlds}`，worlds 就是原数组**逐条原样**（不补字段、不过滤坏条目）→ true；
 *   已是版本化对象 → false（不改一个字节，再调多少次都还是 false——幂等由「只认数组」这个判据成立，不靠记忆；
 *                    含 `schema` 比当前版本新的索引：读路径照读、写路径保留其 schema，迁移对它无事可做）；
 *   坏 JSON / 其它 → false 且**不动笔**（解析不出就别覆写：宁可下次启动再试，也不能把玩家的世界线列表写没了）。
 * 重写走 writeWorldsIndex（落盘形态只有一处定义）：数组输入在那边正落到 `{schema: 1, worlds}`。
 * 与 migrateLegacyState 同款：函数内不打日志、只回布尔，由调用方决定要不要 console.log（时机与措辞归启动路径）。
 * @param {string} root 世界根目录
 * @returns {boolean} 是否真的改写了文件
 */
export function migrateWorldsSchema(root) {
  const file = path.join(root, "index.json");
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false; // 缺文件 / 读不动 / 坏 JSON：三种都按「这次不迁」处理
  }
  if (!Array.isArray(data)) return false; // 已版本化的对象（或任何别的 JSON）：no-op
  try {
    writeWorldsIndex(root, data);
  } catch {
    return false; // 写不动（权限/磁盘满）当作没迁：文件维持旧形态，下次启动再试
  }
  return true;
}

/**
 * 世界目录 state.md 里的 `- preset: <id>`（导出纯读函数，root 可注入以便单测）。
 * 与 SKILL「当前剧本 id = 本局 state.md 的 `- preset: <id>`」同一口径：
 * index.json 缺该世界（手建世界、索引被删、迁移漏记）时用它自愈「当前剧本」。
 * @param {string} worldId 世界 id（调用方先用 WORLD_ID_RE 校验）
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {string} 剧本 id；文件/字段缺失或值不合法时为空串
 */
export function presetFromStateFile(worldId, root = WORLDS_ROOT) {
  try {
    const md = fs.readFileSync(path.join(root, worldId, "state.md"), "utf8");
    const m = /^-\s*preset\s*[:：]\s*([A-Za-z0-9_-]+)\s*$/m.exec(md);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// 当前章号从树文件正文取（最后一个 `## 第 N 章`）；读不到回退 index 记录
/** @param {string} md story-tree.md 全文（null/undefined 视同空文本） @returns {number} */
export function worldChapterNo(md) {
  let n = 1;
  for (const m of String(md || "").matchAll(/^##\s*第\s*(\d+)\s*章/gm)) n = Number(m[1]);
  return n;
}

/** 新建世界（分配 id、建目录、写索引）；新世界的三份文件由引擎在开局/规划时初始化
 *  @param {string} root 世界根目录 @param {string} preset 剧本 id @param {string} [title] @returns {WorldIndexEntry} */
export function createWorld(root, preset, title = "") {
  const list = readWorldsIndex(root);
  const base = String(preset || "world").replace(/[^A-Za-z0-9_-]/g, "-") || "world";
  const taken = new Set(list.map((e) => e.worldId));
  let n = 1;
  while (taken.has(`${base}-${n}`)) n += 1;
  const entry = {
    worldId: `${base}-${n}`,
    preset: String(preset || ""),
    title,
    chapterNo: 1,
    lastPlayed: Date.now(),
    note: "",
    forkedFrom: null,
  };
  fs.mkdirSync(path.join(root, entry.worldId), { recursive: true });
  writeWorldsIndex(root, [...list, entry]);
  console.log(`[acp] world created: ${entry.worldId}`);
  return entry;
}

// 选精确回退源（纯逻辑）：显式 seq 命中优先；否则按 nodeId 取最早匹配快照；都没有 → null（走兼容路径）。
// 输入是 readSnapshots 的**元字段列表**（不含 files，v1.14）；调用方拿到选中的 seq 后再 readSnapshot 取全文。
/** @param {import("./snapshots.mjs").SnapshotMeta[]} snaps @param {string} nodeId @param {number|string|null} seq @returns {import("./snapshots.mjs").SnapshotMeta|null} */
function pickForkSnapshot(snaps, nodeId, seq) {
  if (seq != null && seq !== "") {
    const hit = snaps.find((s) => s.seq === Number(seq));
    if (hit) return hit;
  }
  return selectSnapshotForNode(snaps, nodeId);
}

// 手动分叉（v1.6 支持精确快照源）：
//   有快照（显式 seq 或按 nodeId 最早匹配）→ 精确：以快照三文件建新世界（仍写 fork.md，引擎只校准树）；
//   无快照 → 兼容路径：复制当前三文件 + 本地回退进度指针（既有行为，字节不变）。
/** @param {string} root 世界根目录 @param {string} originId 来源世界 id @param {string} nodeId 分叉节点 id @param {number|null} [seq] 显式快照 seq @returns {{worldId: string, entry: WorldIndexEntry|undefined}|{error: string}} */
export function forkWorld(root, originId, nodeId, seq = null) {
  const origin = readWorldsIndex(root).find((e) => e.worldId === originId);
  if (!origin) return { error: "来源世界不存在" };
  const srcDir = path.join(root, originId);
  if (!fs.existsSync(srcDir)) return { error: "来源世界目录不存在" };

  // 先用元字段列表选中分叉点，再现读那一条的全文（readSnapshots 不含 files，v1.14）
  const picked = pickForkSnapshot(readSnapshots(originId, root), nodeId, seq);
  const snap = picked ? readSnapshot(originId, picked.seq, root) : null;
  const entry = createWorld(root, origin.preset, origin.title);
  const dstDir = path.join(root, entry.worldId);

  let chapterNo = entry.chapterNo;
  let forkedFrom;
  if (snap) {
    writeWorldFiles(dstDir, snap.files); // 精确：快照三文件原样落地，不本地改树（引擎按 fork.md 校准）
    chapterNo =
      snap.chapterNo != null
        ? snap.chapterNo
        : snap.files.tree != null
          ? worldChapterNo(snap.files.tree)
          : entry.chapterNo;
    forkedFrom = { worldId: originId, nodeId, seq: snap.seq };
  } else {
    for (const f of WORLD_FILES) {
      const src = path.join(srcDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, f));
    }
    const treeFile = path.join(dstDir, TREE_FILE);
    const treeText = fs.existsSync(treeFile) ? fs.readFileSync(treeFile, "utf8") : "";
    if (treeText) fs.writeFileSync(treeFile, forkTreeMarkdown(treeText, nodeId));
    chapterNo = treeText ? worldChapterNo(forkTreeMarkdown(treeText, nodeId)) : entry.chapterNo;
    forkedFrom = { worldId: originId, nodeId };
  }
  // 分叉关系由 forkedFrom（与 fork.md）完整记录，索引 note 保持空串——旧版在这里写「分叉自 <id> @ <节点>」，
  // 而 note 会被显示层当成世界名，等于把裸 id 端到玩家眼前（v1.7.1 起交还给玩家自己命名）
  const note = "";
  fs.writeFileSync(path.join(dstDir, FORK_FILE), forkNote(originId, nodeId));
  const list = readWorldsIndex(root).map((e) =>
    e.worldId === entry.worldId ? { ...e, chapterNo, note, forkedFrom, lastPlayed: Date.now() } : e,
  );
  writeWorldsIndex(root, list);
  console.log(`[acp] world forked: ${originId}@${nodeId} → ${entry.worldId}${snap ? ` (精确快照 #${snap.seq})` : ""}`);
  return { worldId: entry.worldId, entry: list.find((e) => e.worldId === entry.worldId) };
}

/**
 * 精确回退到某条快照：先写一条 kind:"backup"（当前三文件）再覆盖为目标快照。
 * backup 去重关掉——它就是恢复前的地板，必须落盘，否则这次恢复无法再撤销。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @param {number|string} seq 目标快照 seq
 * @returns {{backupSeq: number}|{error: string}}
 */
export function restoreWorld(root, worldId, seq) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return { error: "参数不合法" };
  // 目标快照现读全文（readSnapshots 只回元字段，v1.14）：这里本就只认一个 seq，直接读那一条更省
  const target = readSnapshot(worldId, seq, root);
  if (!target) return { error: "快照不存在" };
  const dir = path.join(root, worldId);
  const current = readWorldFiles(dir);
  const backup = writeSnapshot(
    root,
    worldId,
    {
      kind: "backup",
      nodeId: parseTreePointer(current.tree),
      chapterNo: current.tree != null ? worldChapterNo(current.tree) : null,
      files: current,
    },
    { dedupe: false },
  );
  if (!backup.ok) return { error: "写入备份快照失败" };
  writeWorldFiles(dir, target.files);
  console.log(`[acp] world restored: ${worldId} → #${target.seq}（备份 #${backup.seq}）`);
  return { backupSeq: backup.seq };
}

/**
 * 给某个存档点起名（v1.12，剧情图的「存档点命名」）：名字存在世界条目上（`snapshotLabels`，
 * `{"<seq>": "<名字>"}`），**不进快照文件本身**——快照是引擎进度的逐轮真相、append-only；
 * 名字是玩家给时间点贴的标签，属于索引层的展示元数据（与 label/note 同层）。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @param {number|string} seq 快照序号
 * @param {string} label 名字（空串 = 清除这一条）
 * @returns {{ok?: true, labels?: Record<string, string>} | {error: string}} 结果或错误
 */
export function labelSnapshot(root, worldId, seq, label) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return { error: "参数不合法" };
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1) return { error: "seq 不合法" };
  const clean = String(label ?? "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  if (clean.length > 40) return { error: "名字过长（≤40）" };
  const list = readWorldsIndex(root);
  const idx = list.findIndex((e) => e.worldId === worldId);
  if (idx === -1) return { error: "世界不存在" };
  const entry = { ...list[idx] };
  const labels = { ...entry.snapshotLabels }; // 展开 nullish 本来就是 no-op（`{...undefined}` = `{}`），不必写 `?? {}`
  if (clean) labels[String(n)] = clean;
  else delete labels[String(n)];
  entry.snapshotLabels = labels;
  list[idx] = entry;
  writeWorldsIndex(root, list);
  return { ok: true, labels };
}

/**
 * 更新世界索引里的展示字段：label(≤60) / note(≤200)，空串 = 清除。
 * patch 里**出现**该键才改（用 `in` 判定），没出现的键保持原值——避免把「没传」当成「清空」。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @param {{label?: string, note?: string}} patch 待更新字段
 * @returns {{entry: object}|{error: string}}
 */
export function updateWorld(root, worldId, patch = {}) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return { error: "参数不合法" };
  const list = readWorldsIndex(root);
  const idx = list.findIndex((e) => e.worldId === worldId);
  if (idx === -1) return { error: "世界不存在" };
  const entry = { ...list[idx] };
  if ("label" in patch) {
    const label = String(patch.label ?? "").trim();
    if (label.length > 60) return { error: "label 过长（≤60）" };
    entry.label = label; // 空串即清除
  }
  if ("note" in patch) {
    const note = String(patch.note ?? "").trim();
    if (note.length > 200) return { error: "note 过长（≤200）" };
    entry.note = note;
  }
  list[idx] = entry;
  writeWorldsIndex(root, list);
  return { entry };
}

// ---------- 世界线导出包（v1.6 起，format:"bunkiten-world"；v2 起带血缘；v3 起快照带重演输入） ----------
// 与剧本导出包（presets.mjs 的 buildPresetBundle/importPresetBundle）对称：导出 JSON + attachment 下载、
// 导入先整体校验再重名加 -2/-3。v2 只加两个键，其余键序与形状一个字节不动：
//   world.forkedFrom —— 索引里的血缘原值（老索引没有该字段 → null）。家谱连线只认它，v1 包丢了它就等于
//                       把导入回来的分叉线变回根（v1.8 把血缘从 note 挪到 forkedFrom 之后的反向抵消）
//   world.forkMd     —— 世界目录 fork.md 全文（引擎处理完首个回合会自行删除该文件，此时 → null）
// v3 只加一个键：快照条目的 prompt（可重演的玩家输入，docs/adr/0023）——存档自洽（换台机器也能重演）；
// 旧包（1/2）照收，缺 prompt 的条目 normalize 为 ""（那几幕的重演入口给「这一档没有留下当时的输入」）。
// 导入侧接受 1..WORLD_BUNDLE_VERSION（老包照收、按当前形状补齐）——ROADMAP §1「旧包 accept + upgrade」的落地样板。
const WORLD_BUNDLE_FORMAT = "bunkiten-world";
/** 当前世界线导出包的版本（v2 起带 forkedFrom/forkMd、v3 起快照带 prompt）：导出写它，导入接受 1..它（见 importWorld 的版本闸） */
export const WORLD_BUNDLE_VERSION = 3;
/** 分叉说明文件名：forkWorld 写它、exportWorld 收它、importWorld 落它——三处必须同一个名字 */
const FORK_FILE = "fork.md";

/**
 * 世界的 fork.md 全文（该文件由 forkWorld 写、引擎首个回合处理后删除）。
 * @param {string} dir 世界目录绝对路径
 * @returns {string|null} 文件内容；不存在/读不动时 null（与「没有这个文件」同义，导出侧据此写 null）
 */
function readForkMd(dir) {
  try {
    return fs.readFileSync(path.join(dir, FORK_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * 打包一个世界（含全部快照）为可迁移 bundle（CONTRACTS §2）。
 * 刻意**不含 logs/**（v1.7 回合原文日志）：那是本机的排障面（引擎到底说了什么），不是可迁移的档——
 * 导入侧的引擎没有这段历史，带着它只会让新世界的时间线自相矛盾。
 * @param {string} root 世界根目录
 * @param {string} worldId 世界 id
 * @returns {{bundle?: WorldBundle, error?: string}} 成功时 bundle、失败时 error（HTTP 层按字段有无分流）
 */
export function exportWorld(root, worldId) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return { error: "参数不合法" };
  const entry = readWorldsIndex(root).find((e) => e.worldId === worldId);
  const dir = path.join(root, worldId);
  if (!entry && !fs.existsSync(dir)) return { error: "世界不存在" };
  const files = readWorldFiles(dir);
  // 导出要**三文件全文**，所以走 readSnapshotEntries（readSnapshots 只回元字段，v1.14）：键序与形状照旧逐个显式映射
  const snapshots = readSnapshotEntries(worldId, root).map((s) => ({
    seq: s.seq,
    at: s.at,
    kind: s.kind,
    nodeId: s.nodeId,
    chapterNo: s.chapterNo,
    prompt: s.prompt,
    files: s.files,
  }));
  return {
    bundle: {
      format: WORLD_BUNDLE_FORMAT,
      version: WORLD_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      world: {
        worldId,
        preset: entry?.preset || "",
        title: entry?.title || "",
        label: entry?.label || "",
        note: entry?.note || "",
        chapterNo: files.tree != null ? worldChapterNo(files.tree) : entry?.chapterNo || 1,
        // 血缘取索引原值（手建世界/老索引没有该字段 → null）；forkMd 与 files/snapshots 同族（都是文件全文），
        // 排在它们之后，免得插进元数据段里打乱既有键序
        forkedFrom: entry?.forkedFrom ?? null,
        files,
        snapshots,
        forkMd: readForkMd(dir),
      },
    },
  };
}

/** 全量导出容器格式（`exportAllWorlds` 写它、importWorld 认它循环导入）；与单体 WORLD_BUNDLE_FORMAT 是两个格式名 */
const WORLDS_BUNDLE_FORMAT = "bunkiten-worlds";
/** 全量导出容器版本（目前只有 1；导入侧只看 format + worlds 数组，版本号留给将来加壳） */
const WORLDS_BUNDLE_VERSION = 1;

/**
 * 打包**全部世界线**为一个容器（`GET /api/worlds/export?all=1` 的落地，v1.14 的一次性备份入口）。
 * 容器里每个元素就是 `exportWorld` 的单体 bundle（逐字同形），导入侧循环导入即可——用一条 `format`
 * 把「单世界线导出包」与「全量备份包」分开，两种都能原样导回。
 * 索引里存在但目录已不在的世界（exists:false 的手删残留）跳过：没有目录就没什么可备份的。
 * @param {string} root 世界根目录
 * @returns {WorldsBundle} 容器（不含 logs/，与单体导出同一口径）
 */
export function exportAllWorlds(root) {
  /** @type {WorldBundle[]} */
  const worlds = [];
  for (const e of readWorldsIndex(root)) {
    if (!fs.existsSync(path.join(root, e.worldId))) continue;
    const out = exportWorld(root, e.worldId);
    if (out.bundle) worlds.push(out.bundle);
  }
  return {
    format: WORLDS_BUNDLE_FORMAT,
    version: WORLDS_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    worlds,
  };
}

/**
 * 导出包里的血缘（v2 起 `world.forkedFrom`）逐字段校验：worldId 过白名单、nodeId 非空字符串、seq 可选正整数
 * （JSON 里必须是数字——`"1"` 这种字符串形态一律按坏值处理，免得一个错误的精确分叉点被当真）。
 * **任何一处不合形态 → 整条降级为 null**，既不做半留（`seq` 坏掉时不留 `{worldId, nodeId}`：半留会让
 * 「精确分叉自第 N 条快照」的说法对不上真快照，宁可退回「父线已知、分叉点不明」），也不整包 400——
 * 血缘只作家谱连线用，为它把玩家的整份档挡在门外不划算（与 files.state 的硬校验口径刻意相反）。
 * v1 包没有该字段（`undefined`）同样落到 null。
 * @param {unknown} raw bundle 里的 forkedFrom 原值
 * @returns {{worldId: string, nodeId: string, seq?: number}|null} 合法血缘；否则 null（= 根节点）
 */
function bundleForkedFrom(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { worldId, nodeId, seq } = /** @type {{worldId?: unknown, nodeId?: unknown, seq?: unknown}} */ (raw);
  if (typeof worldId !== "string" || !WORLD_ID_RE.test(worldId)) return null;
  if (typeof nodeId !== "string" || nodeId.trim() === "") return null;
  if (seq == null) return { worldId, nodeId };
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  return { worldId, nodeId, seq };
}

/**
 * 导入一个 bundle：校验 format/version/worldId → 重名时加 `-2/-3…` 后缀 → 写文件 + 快照 + 索引（note 追加「（导入）」）。
 * 校验口径与导出对称，任何字段不合法一律拒绝（不写半个世界）。
 * 版本闸**不是硬等值**：接受 1..WORLD_BUNDLE_VERSION——v1 包照收、按当前形状补齐（forkedFrom null、不落
 * fork.md），v2 包才带血缘（见 bundleForkedFrom 的降级口径）。
 * 剧本校验（v1.14）：`<数据根>/presets/<world.preset>/preset.md` 不存在 → 拒绝并给一句人话——
 * 导进来一条缺剧本的世界线，玩家点「继续」只会撞一堵墙，不如先让 ta 把剧本导进来。
 * 也接受**全量容器**（`exportAllWorlds` 的 `bunkiten-worlds`）：逐个走上面的单体导入，返回 `{worldIds}`。
 * @param {string} root 世界根目录
 * @param {Record<string, any> | null} bundle 导出体（JSON 直入：字段类型未知，函数内逐字段校验，
 *   故按 any 收口——与 isSnapshotEntry 同一口径；null/非对象一律回拒绝而不是抛）
 * @returns {{worldId?: string, worldIds?: string[], error?: string}} 单体导入回 worldId；容器导入回 worldIds
 */
export function importWorld(root, bundle) {
  // 全量容器（format:"bunkiten-worlds"）：循环导入单体；任何一个失败即整体回 error（不落半批）
  if (bundle && typeof bundle === "object" && bundle.format === WORLDS_BUNDLE_FORMAT) {
    if (!Array.isArray(bundle.worlds)) return { error: "bundle 校验失败" };
    /** @type {string[]} */
    const worldIds = [];
    for (const one of bundle.worlds) {
      const out = importWorld(root, one);
      if (out.error) return { error: out.error };
      if (out.worldId) worldIds.push(out.worldId);
    }
    return { worldIds };
  }
  const w = bundle && typeof bundle === "object" ? bundle.world : null;
  if (!bundle || bundle.format !== WORLD_BUNDLE_FORMAT || !w || !WORLD_ID_RE.test(String(w.worldId || ""))) {
    return { error: "bundle 校验失败" };
  }
  const version = bundle.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > WORLD_BUNDLE_VERSION) {
    return { error: "bundle 校验失败" };
  }
  // files.state 必须是非空字符串：空/缺失的 state 快照会导入出一个不可玩的世界，一律拒绝（不写半个世界）
  const filesIn = w.files && typeof w.files === "object" ? w.files : null;
  if (!filesIn || typeof filesIn.state !== "string" || filesIn.state.trim() === "") {
    return { error: "bundle 校验失败：files.state 必须是非空字符串" };
  }
  // 剧本必须在场（剧本根由世界根上溯两级；生产 = DATA_ROOT，单测注入根同样成立——别直接绑 DATA_ROOT，
  // 那会让注入根的单测查仓库自己的 presets）：缺就先让玩家导入剧本，别造一条打不开的世界线
  const preset = String(w.preset ?? "").trim();
  if (!PRESET_ID_RE.test(preset) || !fs.existsSync(path.join(gameRootOf(root), "presets", preset, "preset.md"))) {
    return { error: `缺少剧本《${preset || "(未标注)"}》：请先导入该剧本，再导入这条世界线` };
  }
  // label/note 与 updateWorld 同款长度约束（≤60 / ≤200）：超限直接 400，绝不静默截断
  const label = String(w.label ?? "").trim();
  if (label.length > 60) return { error: "label 过长（≤60）" };
  const note = String(w.note ?? "").trim();
  if (note.length > 200) return { error: "note 过长（≤200）" };
  const list = readWorldsIndex(root);
  const taken = new Set(list.map((e) => e.worldId));
  // 磁盘上已存在但索引缺失的世界目录同样算被占用：否则导入会静默顶替它，把该目录的内容覆盖掉
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory()) taken.add(ent.name);
    }
  } catch {}
  // 重名后缀：-2、-3…（与 importPresetBundle 共用 uniqueSuffixedName，不覆盖既有世界）
  const id = uniqueSuffixedName(taken, String(w.worldId));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  writeWorldFiles(dir, filesIn); // 三键：字符串写入；null/undefined 删除（新目录下即无操作）
  // 血缘（v2）：只做展示面用途（家谱连线），坏值降级成 null 而不整包拒绝（见 bundleForkedFrom）
  const forkedFrom = bundleForkedFrom(w.forkedFrom);
  // fork.md（v2）：只有非空字符串才落盘，且逐字节原样写——空串等同「没有这个文件」（与导出侧的 null 对齐），
  // 免得落一个 0 字节 fork.md 让引擎的首个回合读到一份空指令
  const forkMd = typeof w.forkMd === "string" && w.forkMd !== "" ? w.forkMd : null;
  if (forkMd !== null) fs.writeFileSync(path.join(dir, FORK_FILE), forkMd);
  const files = readWorldFiles(dir);
  const snaps = Array.isArray(w.snapshots) ? w.snapshots.filter(isSnapshotEntry) : [];
  if (snaps.length) {
    const hdir = path.join(dir, HISTORY_DIRNAME);
    fs.mkdirSync(hdir, { recursive: true });
    for (const s of snaps) {
      fs.writeFileSync(
        path.join(hdir, `${String(s.seq).padStart(4, "0")}.json`),
        JSON.stringify(normalizeSnapshot(s), null, 2) + "\n",
      );
    }
  }
  const entry = {
    worldId: id,
    preset: String(w.preset || ""),
    title: String(w.title || ""),
    label, // 已过 ≤60 校验
    note: `${note}（导入）`, // 标注来源：一眼看出是导入的世界（note 已过 ≤200 校验）
    chapterNo: files.tree != null ? worldChapterNo(files.tree) : Number(w.chapterNo) || 1,
    lastPlayed: Date.now(),
    forkedFrom, // v2 带血缘、v1 包与坏值都是 null（= 家谱里的根）
  };
  writeWorldsIndex(root, [...list, entry]);
  console.log(`[acp] world imported: ${w.worldId} → ${id}`);
  return { worldId: id };
}

/**
 * 删一个世界：**先**把目录整体挪进回收站，成功了**再**摘索引条目（v1.14 修顺序）。
 * 为什么是这个顺序：反过来（旧实现）会出现「索引没了、目录还在」的失联世界——列表里看不到，也删不掉。
 * 现在只要移动没成（rename 与直删兜底都失败），索引一个字不动、返回人话 error，世界照常可见可重试。
 * @param {string} root 世界根目录 @param {string} worldId @returns {{ok: true, trashed: boolean, fallback?: string}|{error: string}}
 */
export function deleteWorld(root, worldId) {
  const list = readWorldsIndex(root);
  if (!list.some((e) => e.worldId === worldId)) return { error: "世界不存在" };
  // root 是 worlds 根（<gameRoot>/state/worlds）：整个世界目录搬进 <gameRoot>/state/trash/
  /** @type {{trashed: boolean, fallback?: string}} */
  let t;
  try {
    t = moveToTrash(path.dirname(path.dirname(root)), ["state", "worlds", worldId]);
  } catch {
    // 回收站挪不走、直删兜底也失败（EACCES/EPERM/EBUSY…）：目录还在原位、索引尚没动 → 报错保留，可重试
    return { error: "世界删除失败：无法移入回收站" };
  }
  if (!t.trashed && fs.existsSync(path.join(root, worldId))) {
    // 兜底：moveToTrash 既没挪走也没删掉（目录仍在）→ 同样保留索引
    return { error: "世界删除失败：无法移入回收站" };
  }
  writeWorldsIndex(
    root,
    list.filter((e) => e.worldId !== worldId),
  );
  // 顺手释放该世界的快照缓存（不摘的话已删世界的元字段会挂在 LRU 里直到被挤掉）
  invalidateSnapshots(worldId, root);
  console.log(`[acp] world deleted: ${worldId}${t.trashed ? " → state/trash" : ""}`);
  return { ok: true, ...t };
}

// 列表：index 为准，磁盘自愈（chapterNo 读树、lastPlayed 取三文件最新 mtime）；按最近游玩倒序
/** @param {string} root 世界根目录 @param {string|null} [presetFilter] 按剧本 id 过滤 @returns {Array<WorldIndexEntry & {exists: boolean, presetExists: boolean}>} */
export function listWorlds(root, presetFilter = null) {
  return readWorldsIndex(root)
    .filter((e) => !presetFilter || e.preset === presetFilter)
    .map((e) => {
      const dir = path.join(root, e.worldId);
      const exists = fs.existsSync(dir);
      let chapterNo = e.chapterNo || 1;
      let lastPlayed = e.lastPlayed || 0;
      if (exists) {
        try {
          chapterNo = worldChapterNo(fs.readFileSync(path.join(dir, TREE_FILE), "utf8"));
        } catch {}
        lastPlayed = Math.max(lastPlayed, ...WORLD_FILES.map((f) => mtimeOf(path.join(dir, f))), 0);
      }
      // label 是 v1.6 新增的展示名（update 写入）；老索引没有该字段时补空串，客户端不必判 undefined。
      // presetExists（v1.14）：该世界的剧本还在不在数据根里——不在就在行上标注，别让玩家点开一堵墙
      return {
        ...e,
        label: typeof e.label === "string" ? e.label : "",
        chapterNo,
        lastPlayed,
        exists,
        presetExists: presetExists(e.preset),
      };
    })
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

/**
 * 某剧本还在不在**数据根**里（世界线列表缺剧本时行上标注、importWorld 校验共用这一口径）。
 * 剧本根用 config 的 DATA_ROOT（不是调用方传进来的 world root——那是世界根，两者不是一个层级）。
 * @param {string} presetId 剧本 id
 * @returns {boolean}
 */
function presetExists(presetId) {
  if (!PRESET_ID_RE.test(String(presetId || ""))) return false;
  return fs.existsSync(path.join(DATA_ROOT, "presets", presetId, "preset.md"));
}

// 旧版扁平 state/*.md 一次性迁入 state/worlds/main/（可重入：索引缺 main 条目就补；任一步崩掉重跑能补完）
/** @param {string} stateDir 旧 state 目录 @param {string} worldsRoot 世界根目录 @returns {boolean} 本次是否做了（或补做了）迁移
 *
 * 判据（v1.14 幂等/可重入化）：索引里已有 `main` 条目 → 早迁完了，直接 false；否则只要「旧 state/*.md 还在」
 * 或「worlds/main 已有文件但索引缺条目」（上次崩在搬完文件之后）就继续。步骤固定为**先逐文件搬、后写索引**：
 *   ① 搬文件：逐文件 rename，源已不在就跳过——上次崩在这一步之后，重跑能把剩下的搬完；
 *   ② 写索引：按 main 目录的**现状**重建条目（preset 从 state.md、chapterNo 从 story-tree.md）。
 * 索引存在 ⟺ 文件已搬完（写索引在最后），所以「索引有 main」这个判据是安全的；崩在 ① 与 ② 之间时，
 * 重跑会落进「main 有文件、索引缺条目」这一支，把索引补上。
 */
export function migrateLegacyState(stateDir, worldsRoot) {
  const index = readWorldsIndex(worldsRoot);
  if (index.some((e) => e.worldId === "main")) return false; // 已迁过
  let files = [];
  try {
    files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return false;
  }
  const dir = path.join(worldsRoot, "main");
  const mainHasFiles = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  if (files.length === 0 && !mainHasFiles) return false; // 既无旧文件、main 也空 → 全新安装，什么都不做（不建索引）

  // ① 搬文件（逐文件、幂等：源已不在就跳过；单个搬不动就跳过，索引按实际落地的内容重建）
  if (files.length) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const src = path.join(stateDir, f);
      const dst = path.join(dir, f);
      if (!fs.existsSync(src)) continue;
      try {
        fs.renameSync(src, dst);
      } catch {}
    }
  }
  // ② 索引条目（读 main 现状重建；只补 main 这一条，别的世界条目原样保留）
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    const preset = presetFromStateFile("main", worldsRoot);
    const tree = path.join(dir, TREE_FILE);
    const chapterNo = fs.existsSync(tree) ? worldChapterNo(fs.readFileSync(tree, "utf8")) : 1;
    const entry = {
      worldId: "main",
      preset,
      title: scanPresets().presets.find((p) => p.id === preset)?.title || "",
      chapterNo,
      lastPlayed: Date.now(),
      label: "",
      note: "",
      forkedFrom: null,
    };
    writeWorldsIndex(worldsRoot, [...index, entry]);
  }
  return true;
}

// ---------- 回收站读写（v1.14，ADR-0014 的「恢复 UI」修订）----------
// 两个薄函数，供 GET /api/trash 与 POST /api/trash {action:"restore"} 用；条目的产生只在 moveToTrash（assets.mjs）。
// 条目名 `<ts>-<rand4>[-<label>]-<原名>`（moveToTrash 写），三种产生者：
//   · 世界线目录 deleteWorld（不带 label）→ `<ts>-<rand4>-<worldId>`
//   · 剧本目录 deletePreset（label=id）→ `<ts>-<rand4>-<id>-<id>`
//   · 素材文件 /api/assets delete（label=presetId）→ `<ts>-<rand4>-<presetId>-<类型>-<名>.jpg`
// 原名本身可含 `-`，所以只按「可判定的形态」拆 label 与 name（见 splitTrashEntryName）。

/** trash 目录（回收站根）：`<gameRoot>/state/trash`，gameRoot 由世界根反推（worldsRoot = `<gameRoot>/state/worlds`） */
/** @param {string} root 世界根目录 @returns {string} */
function trashDirOf(root) {
  return path.join(path.dirname(root), "trash");
}

/** 游戏根（数据根）：`<gameRoot>`，由世界根上溯两级 */
/** @param {string} root 世界根目录 @returns {string} */
function gameRootOf(root) {
  return path.dirname(path.dirname(root));
}

/**
 * 拆回收站条目名 → {at, label, name}。规则见文件段注释；认不出 `<ts>-<rand4>-…` 形态时 at=0（调用方据此跳过）。
 * @param {string} entryName 条目名 @param {boolean} isDir 是不是目录（决定 label 拆分口径）
 * @returns {{at: number, label: string, name: string}}
 */
function splitTrashEntryName(entryName, isDir) {
  const m = /^(\d+)-([0-9a-z]{4})-(.+)$/.exec(entryName);
  if (!m) return { at: 0, label: "", name: entryName };
  const at = Number(m[1]);
  const rest = m[3];
  if (isDir) {
    // 世界线（无 label）→ rest 即原名；剧本目录（label=id）→ rest 是 `<id>-<id>`，拆成 label=name=id
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && half > 0 && rest[half] === "-" && rest.slice(0, half) === rest.slice(half + 1)) {
      const id = rest.slice(0, half);
      return { at, label: id, name: id };
    }
    return { at, label: "", name: rest };
  }
  // 素材文件：`<label>-<原名>`——原名以中文类型（立绘/背景/封面）开头，label 必为 ASCII 剧本 id，
  // 所以「头一段 ASCII、后接非 ASCII」处即分界（label 可含 `-`，用非贪婪匹配找最早那条分界）
  const a = /^([A-Za-z0-9_-]+?)-([^A-Za-z0-9_].+)$/.exec(rest);
  return a ? { at, label: a[1], name: a[2] } : { at, label: "", name: rest };
}

/**
 * 列回收站条目（GET /api/trash）：`state/trash/` 下每条 → `{id, kind, name, presetId?, at}`。
 * kind 按**条目本体**判定：目录 → "world"，文件 → "asset"（与 ADR-0014 的两类条目对应）。
 * id = 条目名（唯一，restoreTrash 拿它定位）；presetId 只在能解析出 label 时给（素材条目必有，世界线没有）。
 * 认不出命名形态的杂物（手放的文件）跳过——列出来也没法恢复。
 * @param {string} root 世界根目录
 * @returns {Array<{id: string, kind: "world"|"asset", name: string, presetId?: string, at: number}>} 最新删的在前
 */
export function listTrash(root) {
  let dirents = [];
  try {
    dirents = fs.readdirSync(trashDirOf(root), { withFileTypes: true });
  } catch {
    return []; // 回收站还没建 = 空列表
  }
  /** @type {Array<{id: string, kind: "world"|"asset", name: string, presetId?: string, at: number}>} */
  const out = [];
  for (const d of dirents) {
    const parsed = splitTrashEntryName(d.name, d.isDirectory());
    if (parsed.at <= 0) continue;
    /** @type {{id: string, kind: "world"|"asset", name: string, presetId?: string, at: number}} */
    const item = { id: d.name, kind: d.isDirectory() ? "world" : "asset", name: parsed.name, at: parsed.at };
    if (parsed.label) item.presetId = parsed.label;
    out.push(item);
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * 回收站恢复的返回（routes 直接读 `.error`，所以成功/失败两个分支的键都写成可选，别做成判别联合）。
 * @typedef {Object} TrashRestoreResult
 * @property {true} [ok]
 * @property {string} [worldId] 恢复回来的世界 id（目录恢复）
 * @property {string} [preset] 恢复回来的剧本 id（目录其实是个剧本目录时）
 * @property {string} [file] 恢复回来的素材相对路径（素材恢复）
 * @property {string} [error] 失败原因（人话）
 */

/**
 * 把一条回收站条目挪回原位（POST /api/trash {action:"restore"}）。
 *   · world（目录）：回 `state/worlds/<原名>/` 并**回补索引条目**（preset 从 state.md、chapterNo 从
 *     story-tree.md、lastPlayed=now）——不复用原条目（它可能早被删了），按当前磁盘重建一条；
 *     若目录其实是个剧本（带 preset.md，deletePreset 挪的）→ 回 `presets/<id>/`。
 *   · asset（文件）：回 `presets/<label>/assets/<原名>`；label（剧本标注）缺失就无法自动恢复，回人话 error。
 * 同名目标已存在一律拒绝（绝不覆盖既有世界线/剧本/素材）。
 * @param {string} root 世界根目录 @param {string} id 条目名（listTrash 的 id 原样回传）
 * @returns {TrashRestoreResult}
 */
export function restoreTrash(root, id) {
  const name = String(id || "");
  // 条目名是 readdir 出来的单层名：任何路径分隔/上跳一律拒（防穿越）
  if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..") || name !== path.basename(name)) {
    return { error: "参数不合法" };
  }
  const src = path.join(trashDirOf(root), name);
  let isDir;
  try {
    isDir = fs.statSync(src).isDirectory();
  } catch {
    return { error: "回收站条目不存在" };
  }
  const parsed = splitTrashEntryName(name, isDir);
  if (parsed.at <= 0) return { error: "无法自动恢复：条目名不可识别（请手工移回）" };
  if (isDir) return restoreTrashedDir(root, src, parsed);
  return restoreTrashedAsset(root, src, parsed);
}

/**
 * @param {string} root 世界根目录
 * @param {string} src 回收站里的目录绝对路径
 * @param {{name: string}} parsed
 * @returns {TrashRestoreResult}
 */
function restoreTrashedDir(root, src, parsed) {
  // 剧本目录（deletePreset 挪的，带 preset.md）：回 presets/<id>/，不做世界线那一套
  if (fs.existsSync(path.join(src, "preset.md"))) {
    if (!PRESET_ID_RE.test(parsed.name)) return { error: "无法自动恢复：剧本目录名不合法" };
    const dest = path.join(gameRootOf(root), "presets", parsed.name);
    if (fs.existsSync(dest)) return { error: "同名剧本已存在" };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return { ok: true, preset: parsed.name };
  }
  if (!WORLD_ID_RE.test(parsed.name)) return { error: "无法自动恢复：世界线目录名不合法" };
  const dest = path.join(root, parsed.name);
  if (fs.existsSync(dest)) return { error: "同名世界线已存在" };
  fs.renameSync(src, dest);
  // 回补索引条目（读当前磁盘现状重建；同名条目若已存在则替换）
  const preset = presetFromStateFile(parsed.name, root);
  const tree = path.join(dest, TREE_FILE);
  let chapterNo = 1;
  try {
    chapterNo = worldChapterNo(fs.readFileSync(tree, "utf8"));
  } catch {}
  const list = readWorldsIndex(root).filter((e) => e.worldId !== parsed.name);
  list.push({
    worldId: parsed.name,
    preset,
    title: scanPresets().presets.find((p) => p.id === preset)?.title || "",
    chapterNo,
    lastPlayed: Date.now(),
    label: "",
    note: "",
    forkedFrom: null,
  });
  writeWorldsIndex(root, list);
  return { ok: true, worldId: parsed.name };
}

/**
 * @param {string} root 世界根目录
 * @param {string} src 回收站里的文件绝对路径
 * @param {{label: string, name: string}} parsed
 * @returns {TrashRestoreResult}
 */
function restoreTrashedAsset(root, src, parsed) {
  if (!parsed.label || !PRESET_ID_RE.test(parsed.label)) {
    return { error: "无法自动恢复：素材条目缺少剧本标注，请手工移回 presets/<剧本 id>/assets/" };
  }
  if (!ASSET_DELETE_FILE_RE.test(parsed.name)) return { error: "无法自动恢复：素材文件名不合法" };
  const rel = `presets/${parsed.label}/assets/${parsed.name}`;
  const dest = path.join(gameRootOf(root), "presets", parsed.label, "assets", parsed.name);
  if (fs.existsSync(dest)) return { error: "同名素材已存在" };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return { ok: true, file: rel };
}
