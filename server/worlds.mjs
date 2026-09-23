// 世界线（state/worlds/<worldId>/）的索引、迁移、建 / 分叉 / 删、导出导入与角色面板解析（v1.7 拆模块）。
// 每个世界三份文件：state.md / summary.md / story-tree.md；index.json 记录元数据（chapterNo/lastPlayed 由磁盘自愈）。
// 三文件读写与快照逻辑在下层 server/snapshots.mjs，本模块只做索引与 CRUD。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 与 scripts/doctor.mjs 都从入口 import）。
// 索引 schema 迁移（migrateWorldsSchema，ROADMAP §1 / ADR-0018）已接启动路径：与其余符号一起 re-export，
// 由入口 startServer 在 migrateLegacyState 之后调一次；同一批改动把 writeWorldsIndex 的写形态翻成
// `{schema: 1, worlds}`（读路径本来就两种形态都认——先翻写形态、后接迁移会造出「读到一半的世界」）。
import fs from "fs";
import path from "path";
import { WORLDS_ROOT } from "./config.mjs";
import { mtimeOf, uniqueSuffixedName } from "./assets.mjs";
import { scanPresets } from "./presets.mjs";
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
  writeSnapshot,
  selectSnapshotForNode,
  forkTreeMarkdown,
  forkNote,
  invalidateSnapshots,
} from "./snapshots.mjs";

// 回收站（v1.7，ADR-0014）：删除不直删——世界线目录与素材文件先整体挪进 state/trash/，误删可手工找回。
// trash 长在 state/ 下，天然不在任何扫描面内：scanPresets/scanPresetAudio/listAssets 只看 presets/，
// listWorlds/快照只看 worlds/ 与 index.json，migrateLegacyState 只读 state/ 本层的 *.md——挪进去即从游戏里消失。
// 尽力而为：同卷 rename 原子、极端撞名靠随机后缀规避；跨设备（EXDEV）等 rename 失败时回退直删，
// 因为回收站不能让「删除」这个操作本身失败（回退的 rmSync 若也失败则原样抛出，两个调用方
// /api/assets 与 /api/worlds delete 都在各自路由里 catch 成 4xx/5xx，绝不冒泡成 uncaughtException——
// server 在 Electron 主进程内运行，冒泡即应用闪退）。
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

// label：可选归属标注（素材删除传 presetId）——跨剧本同名文件在 trash 里靠它区分该挪回哪个剧本。
/** @param {string} root 游戏根目录 @param {string[]} rel 相对 root 的路径段 @param {string} [label] @returns {{trashed: boolean, fallback?: string}} */
export function moveToTrash(root, rel, label = "") {
  const src = path.join(root, ...rel);
  if (!fs.existsSync(src)) return { trashed: false }; // 本来就没有可挪的东西（如索引在、目录已被手删），不谎报也不占位
  const trash = path.join(root, "state", "trash");
  const tag = label ? `-${label}` : "";
  try {
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(src, path.join(trash, `${Date.now()}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}${tag}-${path.basename(src)}`));
    return { trashed: true };
  } catch {
    fs.rmSync(src, { recursive: true, force: true });
    return { trashed: false, fallback: "purged" };
  }
}

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
 * @param {string} root 世界根目录
 * @returns {WorldIndexEntry[]} 坏 JSON / 结构不认识（含 `{schema:1}` 没有 worlds、worlds 非数组）时为空数组
 */
export function readWorldsIndex(root) {
  try {
    const list = indexEntriesOf(JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")));
    return list === null ? [] : list.filter((e) => e && typeof e.worldId === "string");
  } catch {
    return [];
  }
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
  fs.writeFileSync(file, JSON.stringify(indexDocumentFor(prev, list), null, 2) + "\n");
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

// ---------- 角色面板（v1.7）：state.md 容错解析 → GET /api/state ----------
// state.md 由引擎（LLM）维护：小节可能缺、顺序可能乱、值可能越界——这里只做「尽力解析、缺的静默缺省」，
// 任何输入都不抛错；未知小节（场景美术等）与角色卡的未知键（art_prompt 等）一律忽略，不进响应。

/** state.md 的键值行：`- <键>: <值>`（冒号全半角都认；值可为空串） */
const STATE_KV_RE = /^-\s*([^:：]+?)\s*[:：]\s*(.*)$/;
/** 未回收伏笔行尾的轮次标注：`（埋于第 N 轮）`（全半角括号都认） */
const FORESHADOW_TURN_RE = /[（(]埋于第\s*(\d+)\s*轮[）)]\s*$/;

/** 好感度解析：取行内第一个整数并夹进 [0,100]（引擎可能写出界）；解析不出（如「很高」）→ null
 *  @param {unknown} raw @returns {number|null} */
function parseFavor(raw) {
  const m = /-?\d+/.exec(String(raw ?? ""));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

/** 行内整数（周目）；解析不出 → null
 *  @param {unknown} raw @returns {number|null} */
function parseIntOrNull(raw) {
  const m = /-?\d+/.exec(String(raw ?? ""));
  return m && Number.isFinite(Number(m[0])) ? Number(m[0]) : null;
}

/**
 * 角色面板里的单张角色卡（parseStateFile 的 characters 元素）。
 * @typedef {Object} CharacterCard
 * @property {string} name
 * @property {string} role 身份
 * @property {string} traits 性格关键词
 * @property {string} catchphrase 口癖
 * @property {number|null} favor 好感度（夹 0-100，解析不出 null）
 * @property {string} artFile
 * @property {string} expression 表情
 * @property {string} secret 秘密
 * @property {string} recentInteraction 最近互动
 */

/**
 * 世界 state.md 解析出的角色面板视图（GET /api/state 的响应体骨架）。
 * @typedef {Object} WorldStateView
 * @property {{preset: string|null, playthrough: number|null, time: string|null, scene: string|null}} status
 * @property {Record<string, string>} protagonist
 * @property {Record<string, string>} director
 * @property {CharacterCard[]} characters
 * @property {Array<{name: string, value: string}>} flags
 * @property {Array<{text: string, turn: number|null}>} foreshadowing
 */

/** 空角色卡（角色卡的缺省形状：字符串字段空串、好感度 null）
 *  @param {string} name @returns {CharacterCard} */
function newCharacterCard(name) {
  return { name, role: "", traits: "", catchphrase: "", favor: null, artFile: "", expression: "", secret: "", recentInteraction: "" };
}

/**
 * 解析世界 state.md 为角色面板视图（纯函数，容错见函数组头注释）。
 * `# 剧情状态` 的固定键 → status（preset/周目→playthrough/时间→time/场景→scene，缺省 null）；
 * `# 主角` / `# 导演手记` 的键值行原样收进 Record（键→值，引擎可自由加字段）；
 * `# 角色卡` 的 `## <角色名>` 子节 → characters（身份→role、性格关键词→traits、口癖→catchphrase、
 * 好感度→favor（夹 0-100，解析不出 null）、art_file→artFile、表情→expression、秘密→secret、最近互动→recentInteraction；
 * art_prompt 等未知键忽略）；`# Flags` → flags；`# 未回收伏笔` → foreshadowing（行尾「埋于第 N 轮」拆出 turn，缺省 null）。
 * @param {string} text state.md 全文（null/undefined 视同空文本）
 * @returns {WorldStateView}
 */
export function parseStateFile(text) {
  /** @type {WorldStateView} */
  const out = {
    status: { preset: null, playthrough: null, time: null, scene: null },
    protagonist: {},
    director: {},
    characters: [],
    flags: [],
    foreshadowing: [],
  };
  /** @type {Record<string, "preset"|"playthrough"|"time"|"scene">} */
  const STATUS_KEYS = { preset: "preset", 周目: "playthrough", 时间: "time", 场景: "scene" };
  /** @type {Record<string, "role"|"traits"|"catchphrase"|"favor"|"artFile"|"expression"|"secret"|"recentInteraction">} */
  const CHARACTER_KEYS = {
    身份: "role",
    性格关键词: "traits",
    口癖: "catchphrase",
    好感度: "favor",
    art_file: "artFile",
    表情: "expression",
    秘密: "secret",
    最近互动: "recentInteraction",
  };
  let section = ""; // 当前一级小节名（未知小节也跟踪，只是不解析内容）
  /** @type {CharacterCard|null} */ let character = null; // 角色卡小节里当前的 ## 角色（其它小节恒为 null）
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const h2 = /^##(?!#)\s*(.+?)\s*$/.exec(line);
    if (h2) {
      // 二级标题：角色卡小节里是角色名（开一张新卡）；其它小节里出现只结束当前上下文。
      // 同名卡 last-wins 去重：引擎整文件重写时旧卡新卡可能并存，不去重会撞 React key 与 testid。
      if (section === "角色卡") {
        const name = h2[1];
        const prev = out.characters.findIndex((c) => c.name === name);
        if (prev !== -1) out.characters.splice(prev, 1);
        character = newCharacterCard(name);
        out.characters.push(character);
      } else {
        character = null;
      }
      continue;
    }
    const h1 = /^#(?!#)\s*(.+?)\s*$/.exec(line);
    if (h1) {
      // 剥行尾括注再比对：SKILL 模板自带「# 角色卡（每个角色一节）」这类写给引擎看的说明，
      // LLM 拷模板时带上括注是完全可能的漂移——精确匹配会把整节角色卡静默吞掉。
      section = h1[1].replace(/[（(][^）)]*[）)]\s*$/, "").trim();
      character = null;
      continue;
    }
    const kv = STATE_KV_RE.exec(line);
    if (section === "剧情状态" && kv) {
      const key = STATUS_KEYS[kv[1].trim()];
      if (!key) continue;
      const v = kv[2].trim();
      if (key === "playthrough") out.status.playthrough = parseIntOrNull(v);
      else out.status[key] = v || null;
    } else if (section === "主角" && kv) {
      out.protagonist[kv[1].trim()] = kv[2].trim();
    } else if (section === "导演手记" && kv) {
      out.director[kv[1].trim()] = kv[2].trim();
    } else if (section === "角色卡" && character && kv) {
      const field = CHARACTER_KEYS[kv[1].trim()];
      if (field === "favor") character.favor = parseFavor(kv[2]);
      else if (field) character[field] = kv[2].trim();
    } else if (section === "Flags" && kv) {
      out.flags.push({ name: kv[1].trim(), value: kv[2].trim() });
    } else if (section === "未回收伏笔" && line.startsWith("-")) {
      let t = line.replace(/^-\s*/, "").trim();
      if (!t) continue;
      /** @type {number|null} */
      let turn = null;
      const m = FORESHADOW_TURN_RE.exec(t);
      if (m) {
        turn = Number(m[1]);
        t = t.slice(0, m.index).trim();
      }
      out.foreshadowing.push({ text: t, turn });
    }
  }
  return out;
}

/**
 * GET /api/state 的路由判定与响应体（导出纯函数，root 可注入以便单测）：
 * worldId 缺失或不过 WORLD_ID_RE → 400；世界没有 state.md → 404；否则 200 + `{worldId, ...parseStateFile}`。
 * @param {string} worldId 查询参数（调用方原样传入，缺失就是空串）
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {{code: number, body: object}} 路由直接 writeHead/JSON 用
 */
export function stateViewFor(worldId, root = WORLDS_ROOT) {
  if (!worldId || !WORLD_ID_RE.test(worldId)) return { code: 400, body: { error: "缺少或非法的 worldId 参数" } };
  let md = null;
  try {
    md = fs.readFileSync(path.join(root, worldId, "state.md"), "utf8");
  } catch {
    md = null;
  }
  if (md === null) return { code: 404, body: { error: "状态文件不存在" } };
  return { code: 200, body: { worldId, ...parseStateFile(md) } };
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

// 选精确回退源（纯逻辑）：显式 seq 命中优先；否则按 nodeId 取最早匹配快照；都没有 → null（走兼容路径）
/** @param {import("./snapshots.mjs").SnapshotEntry[]} snaps @param {string} nodeId @param {number|string|null} seq @returns {import("./snapshots.mjs").SnapshotEntry|null} */
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

  const snap = pickForkSnapshot(readSnapshots(originId, root), nodeId, seq);
  const entry = createWorld(root, origin.preset, origin.title);
  const dstDir = path.join(root, entry.worldId);

  let chapterNo = entry.chapterNo;
  let forkedFrom;
  if (snap) {
    writeWorldFiles(dstDir, snap.files); // 精确：快照三文件原样落地，不本地改树（引擎按 fork.md 校准）
    chapterNo = snap.chapterNo != null ? snap.chapterNo : snap.files.tree != null ? worldChapterNo(snap.files.tree) : entry.chapterNo;
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
  const target = readSnapshots(worldId, root).find((s) => s.seq === Number(seq));
  if (!target) return { error: "快照不存在" };
  const dir = path.join(root, worldId);
  const current = readWorldFiles(dir);
  const backup = writeSnapshot(root, worldId, {
    kind: "backup",
    nodeId: parseTreePointer(current.tree),
    chapterNo: current.tree != null ? worldChapterNo(current.tree) : null,
    files: current,
  }, { dedupe: false });
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
  const clean = String(label ?? "").replace(/\s*\n+\s*/g, " ").trim();
  if (clean.length > 40) return { error: "名字过长（≤40）" };
  const list = readWorldsIndex(root);
  const idx = list.findIndex((e) => e.worldId === worldId);
  if (idx === -1) return { error: "世界不存在" };
  const entry = { ...list[idx] };
  const labels = { ...(entry.snapshotLabels ?? {}) };
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
 * @returns {{bundle?: object, error?: string}} 成功时 bundle、失败时 error（HTTP 层按字段有无分流）
 */
export function exportWorld(root, worldId) {
  if (!WORLD_ID_RE.test(String(worldId || ""))) return { error: "参数不合法" };
  const entry = readWorldsIndex(root).find((e) => e.worldId === worldId);
  const dir = path.join(root, worldId);
  if (!entry && !fs.existsSync(dir)) return { error: "世界不存在" };
  const files = readWorldFiles(dir);
  const snapshots = readSnapshots(worldId, root).map((s) => ({
    seq: s.seq, at: s.at, kind: s.kind, nodeId: s.nodeId, chapterNo: s.chapterNo, prompt: s.prompt, files: s.files,
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
 * @param {string} root 世界根目录
 * @param {{format?: unknown, version?: unknown, world?: {
 *   worldId?: unknown, preset?: unknown, title?: unknown, label?: unknown, note?: unknown, chapterNo?: unknown,
 *   forkedFrom?: unknown, forkMd?: unknown,
 *   files?: {state?: unknown, summary?: unknown, tree?: unknown},
 *   snapshots?: unknown[]|null}}} bundle 导出体（JSON 直入，函数内逐字段校验）
 * @returns {{worldId?: string, error?: string}}
 */
export function importWorld(root, bundle) {
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
      fs.writeFileSync(path.join(hdir, `${String(s.seq).padStart(4, "0")}.json`), JSON.stringify(normalizeSnapshot(s), null, 2) + "\n");
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

/** @param {string} root 世界根目录 @param {string} worldId @returns {{ok: true, trashed: boolean, fallback?: string}|{error: string}} */
export function deleteWorld(root, worldId) {
  const list = readWorldsIndex(root);
  if (!list.some((e) => e.worldId === worldId)) return { error: "世界不存在" };
  writeWorldsIndex(root, list.filter((e) => e.worldId !== worldId));
  // 顺手释放该世界的快照缓存（长世界的 files 字符串可达 MB 级，别让它在 Electron 长驻进程里滞留）
  invalidateSnapshots(worldId, root);
  // root 是 worlds 根（<gameRoot>/state/worlds）：整个世界目录搬进 <gameRoot>/state/trash/（索引先移除，恢复需手工补条目）
  const t = moveToTrash(path.dirname(path.dirname(root)), ["state", "worlds", worldId]);
  console.log(`[acp] world deleted: ${worldId}${t.trashed ? " → state/trash" : ""}`);
  return { ok: true, ...t };
}

// 列表：index 为准，磁盘自愈（chapterNo 读树、lastPlayed 取三文件最新 mtime）；按最近游玩倒序
/** @param {string} root 世界根目录 @param {string|null} [presetFilter] 按剧本 id 过滤 @returns {Array<WorldIndexEntry & {exists: boolean}>} */
export function listWorlds(root, presetFilter = null) {
  return readWorldsIndex(root)
    .filter((e) => !presetFilter || e.preset === presetFilter)
    .map((e) => {
      const dir = path.join(root, e.worldId);
      const exists = fs.existsSync(dir);
      let chapterNo = e.chapterNo || 1;
      let lastPlayed = e.lastPlayed || 0;
      if (exists) {
        try { chapterNo = worldChapterNo(fs.readFileSync(path.join(dir, TREE_FILE), "utf8")); } catch {}
        lastPlayed = Math.max(lastPlayed, ...WORLD_FILES.map((f) => mtimeOf(path.join(dir, f))), 0);
      }
      // label 是 v1.6 新增的展示名（update 写入）；老索引没有该字段时补空串，客户端不必判 undefined
      return { ...e, label: typeof e.label === "string" ? e.label : "", chapterNo, lastPlayed, exists };
    })
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

// 旧版扁平 state/*.md 一次性迁入 state/worlds/main/（幂等：index.json 已存在即跳过；无旧数据返回 false）
/** @param {string} stateDir 旧 state 目录 @param {string} worldsRoot 世界根目录 @returns {boolean} 是否真的迁移了 */
export function migrateLegacyState(stateDir, worldsRoot) {
  if (fs.existsSync(path.join(worldsRoot, "index.json"))) return false;
  let files = [];
  try {
    files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return false;
  }
  if (files.length === 0) return false;
  const dir = path.join(worldsRoot, "main");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.renameSync(path.join(stateDir, f), path.join(dir, f));
  let preset = "";
  try {
    preset = (fs.readFileSync(path.join(dir, "state.md"), "utf8").match(/^-\s*preset\s*[:：]\s*(\S+)/m) || [])[1] || "";
  } catch {}
  const tree = path.join(dir, TREE_FILE);
  writeWorldsIndex(worldsRoot, [
    {
      worldId: "main",
      preset,
      title: scanPresets().presets.find((p) => p.id === preset)?.title || "",
      chapterNo: fs.existsSync(tree) ? worldChapterNo(fs.readFileSync(tree, "utf8")) : 1,
      lastPlayed: Date.now(),
      note: "",
      forkedFrom: null,
    },
  ]);
  return true;
}
