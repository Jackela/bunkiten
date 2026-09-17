// 世界线（state/worlds/<worldId>/）的索引、迁移、建 / 分叉 / 删、导出导入与角色面板解析（v1.7 拆模块）。
// 每个世界三份文件：state.md / summary.md / story-tree.md；index.json 记录元数据（chapterNo/lastPlayed 由磁盘自愈）。
// 三文件读写与快照逻辑在下层 server/snapshots.mjs，本模块只做索引与 CRUD。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 与 scripts/doctor.mjs 都从入口 import）。
import fs from "fs";
import path from "path";
import { WORLDS_ROOT } from "./config.mjs";
import { mtimeOf } from "./assets.mjs";
import { scanPresets } from "./presets.mjs";
import {
  WORLD_FILES,
  WORLD_ID_RE,
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

/** @param {string} root 世界根目录 @returns {WorldIndexEntry[]} 坏 JSON / 非数组时为空数组 */
export function readWorldsIndex(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    return Array.isArray(data) ? data.filter((e) => e && typeof e.worldId === "string") : [];
  } catch {
    return [];
  }
}

/** @param {string} root 世界根目录 @param {WorldIndexEntry[]} list 完整索引（整体覆写） */
export function writeWorldsIndex(root, list) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(list, null, 2) + "\n");
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
  let note;
  let forkedFrom;
  if (snap) {
    writeWorldFiles(dstDir, snap.files); // 精确：快照三文件原样落地，不本地改树（引擎按 fork.md 校准）
    chapterNo = snap.chapterNo != null ? snap.chapterNo : snap.files.tree != null ? worldChapterNo(snap.files.tree) : entry.chapterNo;
    note = `分叉自 ${originId} @ ${nodeId}（精确快照 #${snap.seq}）`;
    forkedFrom = { worldId: originId, nodeId, seq: snap.seq };
  } else {
    for (const f of WORLD_FILES) {
      const src = path.join(srcDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, f));
    }
    const treeFile = path.join(dstDir, "story-tree.md");
    const treeText = fs.existsSync(treeFile) ? fs.readFileSync(treeFile, "utf8") : "";
    if (treeText) fs.writeFileSync(treeFile, forkTreeMarkdown(treeText, nodeId));
    chapterNo = treeText ? worldChapterNo(forkTreeMarkdown(treeText, nodeId)) : entry.chapterNo;
    note = `分叉自 ${originId} @ ${nodeId}`;
    forkedFrom = { worldId: originId, nodeId };
  }
  fs.writeFileSync(path.join(dstDir, "fork.md"), forkNote(originId, nodeId));
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

/**
 * 打包一个世界（含全部快照）为可迁移 bundle（CONTRACTS §2）。
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
    seq: s.seq, at: s.at, kind: s.kind, nodeId: s.nodeId, chapterNo: s.chapterNo, files: s.files,
  }));
  return {
    bundle: {
      format: "bunkiten-world",
      version: 1,
      exportedAt: new Date().toISOString(),
      world: {
        worldId,
        preset: entry?.preset || "",
        title: entry?.title || "",
        label: entry?.label || "",
        note: entry?.note || "",
        chapterNo: files.tree != null ? worldChapterNo(files.tree) : entry?.chapterNo || 1,
        files,
        snapshots,
      },
    },
  };
}

/**
 * 导入一个 bundle：校验 format/version/worldId → 重名时加 `-2/-3…` 后缀 → 写文件 + 快照 + 索引（note 追加「（导入）」）。
 * 校验口径与导出对称，任何字段不合法一律拒绝（不写半个世界）。
 * @param {string} root 世界根目录
 * @param {{format?: unknown, version?: unknown, world?: {
 *   worldId?: unknown, preset?: unknown, title?: unknown, label?: unknown, note?: unknown, chapterNo?: unknown,
 *   files?: {state?: unknown, summary?: unknown, tree?: unknown},
 *   snapshots?: unknown[]|null}}} bundle 导出体（JSON 直入，函数内逐字段校验）
 * @returns {{worldId?: string, error?: string}}
 */
export function importWorld(root, bundle) {
  const w = bundle && typeof bundle === "object" ? bundle.world : null;
  if (!bundle || bundle.format !== "bunkiten-world" || bundle.version !== 1 || !w || !WORLD_ID_RE.test(String(w.worldId || ""))) {
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
  let id = String(w.worldId);
  let n = 1;
  while (taken.has(id)) {
    n += 1;
    id = `${w.worldId}-${n}`; // 重名后缀：-2、-3…（不覆盖既有世界）
  }
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  writeWorldFiles(dir, filesIn); // 三键：字符串写入；null/undefined 删除（新目录下即无操作）
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
    forkedFrom: null,
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
        try { chapterNo = worldChapterNo(fs.readFileSync(path.join(dir, "story-tree.md"), "utf8")); } catch {}
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
  const tree = path.join(dir, "story-tree.md");
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
