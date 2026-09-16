// galgame ACP server — 零依赖 Node，spawn grok agent stdio (ACP)，SSE 推流 + 图片服务 + 静态托管
// 迁移自 shell/server.mjs（协议逻辑保持不变），扩展：GAME_ROOT 注入、可被 import、端口重试、/api/*、/app
// 用法：node server/acp-server.mjs  →  http://localhost:7800 ；或 import { startServer }
import http from "http";
import { spawn } from "child_process";
import readline from "readline";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// 开发模式 = 项目根；Electron 打包后由 main 进程注入资源目录
const GAME_ROOT = process.env.GROK_GAME_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PORT = Number(process.env.PORT) || 7800;
const PORT_MAX_RETRY = 10;
const EFFORT = process.env.EFFORT || "medium"; // 游戏回合用低推理档换节奏，可设 high
const SESSION_FILE = path.join(GAME_ROOT, ".shell-session.json"); // 断线续档：记录 ACP sessionId

// 文件名安全字符：名字里的路径分隔符与引号类字符一律替换为 _
function sanitizeAssetName(name) {
  const safe = String(name).replace(/[\\/:*?"<>|「」『』\r\n\t]/g, "_").trim();
  return safe || "unnamed";
}

// ---------- 美术资产路径契约（v1.5.1：资产随故事走，不写全局 assets/ 池） ----------
// 剧本 id 白名单：字母数字与 -_（防路径穿越；id 来自 preset frontmatter 与客户端指令）
export const PRESET_ID_RE = /^[A-Za-z0-9_-]+$/;
// 旧档格式：v1.5 之前资产堆在全局 assets/，state.md 与标记里记的是 `assets/<类型>-<名>.jpg`
const LEGACY_ASSET_RE = /^assets\/([^/]+\.jpe?g)$/;

/**
 * 某剧本的资产目录（绝对路径）：`presets/<presetId>/assets/`。
 * @param {string} presetId 剧本 id（调用方先用 PRESET_ID_RE 校验）
 * @returns {string} 绝对路径
 */
export function presetAssetsDir(presetId) {
  return path.join(GAME_ROOT, "presets", presetId, "assets");
}

/**
 * 资产的相对路径（posix 分隔符：要原样写进 state.md 与【图】标记）：`presets/<presetId>/assets/<类型>-<名>.jpg`。
 * 封面不走这里——封面仍是 `presets/<id>/cover.jpg`（见 assetTargetFile）。
 * @param {string} type 立绘 | 背景
 * @param {string} name 已 sanitize 的名字（角色名/地点名；差分形如 `薇拉-微笑`）
 * @param {string} presetId 剧本 id
 * @returns {string} 相对 GAME_ROOT 的路径
 */
export function assetRelPath(type, name, presetId) {
  return `presets/${presetId}/assets/${type}-${name}.jpg`;
}

/**
 * 从标记/state 路径里解析剧本 id（容错来源：引擎缓存命中时会直接把 `presets/<id>/…` 写进【图】标记）。
 * @param {string} rel 标记第三段或 state 里的路径
 * @returns {string|null} 剧本 id；不是 `presets/<id>/assets/<文件>.jpg` 或 `presets/<id>/cover.jpg` 时为 null
 */
export function presetIdFromPath(rel) {
  const m = /^presets\/([A-Za-z0-9_-]+)\/(?:assets\/[^/]+\.jpe?g|cover\.jpg)$/.exec(String(rel || "").trim());
  return m ? m[1] : null;
}

/**
 * 旧档资产路径 → 候选新位置（纯函数）：**只给当前剧本目录**。
 * v1.5.2（I1）：取消「全 presets 同名扫描」——跨剧本探测会让 A 剧本的老路径直服到 B 剧本的同名图（串味），
 * 还会把别剧本的图迁落过来。找不到就 404，由调用方 console.warn 提示老路径。
 * @param {string} rel 旧路径（如 `assets/背景-灰雀镇旅店.jpg`）
 * @param {string} presetId 当前剧本 id（空或非法 → 无候选）
 * @returns {string[]} 候选相对路径（最多一个）；rel 不是旧格式或剧本 id 不合法时为空数组
 */
export function legacyAssetCandidates(rel, presetId) {
  const m = LEGACY_ASSET_RE.exec(String(rel || ""));
  if (!m) return [];
  const pid = String(presetId || "").trim();
  if (!PRESET_ID_RE.test(pid)) return [];
  return [`presets/${pid}/assets/${m[1]}`];
}

/**
 * 「这次落盘/直服算哪个剧本的」唯一判定（导出纯函数：服务端三处调用点共用，行为必须一致）。
 * 顺序：合法显式 id（/img 的 `&preset=` 或调用方传入）→ 来源路径自带 `presets/<id>/…` → currentPresetId → null。
 * **currentPresetId 只在调用方声明本场景可信（validPreset）时才兜底**：
 * 创作模式装配新剧本时 currentPresetId 还是上一局的剧本，一旦回退就会把新剧本的立绘写进旧剧本目录（B1），
 * 所以标记流与 /img 都传 false —— 拿不到就不落盘，留给【新剧本】<id> 或带 `&preset=` 的请求补落。
 * @param {object} [ctx] 判定上下文
 * @param {string} [ctx.queryPreset] 显式剧本 id（非空且合法时最优先）
 * @param {string} [ctx.srcRel] 来源/标记路径（`presets/<id>/assets/…` 或 `presets/<id>/cover.jpg` 时从中解析）
 * @param {string} [ctx.currentPresetId] 提示词嗅探出的当前剧本 id（仅 validPreset=true 时兜底）
 * @param {boolean} [ctx.validPreset] 本场景是否允许回退 currentPresetId
 * @returns {{presetId: string|null, reason: "query"|"path"|"current"|"query-illegal"|"none"}} 剧本 id 与命中来源
 */
export function resolvePersistPreset({ queryPreset = "", srcRel = "", currentPresetId = "", validPreset = false } = {}) {
  const q = String(queryPreset ?? "").trim();
  if (PRESET_ID_RE.test(q)) return { presetId: q, reason: "query" };
  const fromPath = presetIdFromPath(srcRel);
  if (fromPath) return { presetId: fromPath, reason: "path" };
  if (validPreset) {
    const cur = String(currentPresetId ?? "").trim();
    if (PRESET_ID_RE.test(cur)) return { presetId: cur, reason: "current" };
  }
  // 显式 id 非空但不合法（调用方已告警）→ 说明「为什么没定下来」，方便排障
  return { presetId: null, reason: q ? "query-illegal" : "none" };
}

/**
 * 落盘目标（相对 GAME_ROOT 的 posix 路径，导出纯函数：落盘与单测共用）。
 * 封面走 `presets/<id>/cover.jpg`（契约不变，**不能**用 assetRelPath —— `assets/封面-X.jpg` 是死路径）：
 * id 先按「剧本标题」反查（封面标记的第二段就是标题），查不到才用调用方给的 id。
 * 立绘/背景走 `presets/<id>/assets/<类型>-<名>.jpg`。
 * 最终 id 一律再校验一次白名单（I2）：不合法 → null，调用方不写盘。
 * @param {string} type 立绘 | 背景 | 封面
 * @param {string} rawName 标记里的原始名（立绘/背景=角色或地点名；封面=剧本标题）
 * @param {string} [presetId] 调用方解析出的剧本 id
 * @returns {string|null} 目标相对路径；拿不到合法剧本 id 时为 null
 */
export function assetTargetFile(type, rawName, presetId = "") {
  const pid = String(presetId || "").trim();
  if (type === "封面") {
    const title = String(rawName ?? "").trim();
    const byTitle = scanPresets().presets.find((p) => p.title === title)?.id || "";
    const finalId = PRESET_ID_RE.test(byTitle) ? byTitle : pid;
    return PRESET_ID_RE.test(finalId) ? `presets/${finalId}/cover.jpg` : null;
  }
  // 类型也过 sanitize（与旧实现一致）：`t` 参数里带 `/`「..」时不会拼出 assets/ 目录外的路径
  return PRESET_ID_RE.test(pid) ? assetRelPath(sanitizeAssetName(type), sanitizeAssetName(rawName), pid) : null;
}

/**
 * 提示词里的世界段嗅探（纯函数）：开局指令中段的 `世界：<worldId>。` 与续玩指令的 `继续世界：<worldId>。`。
 * @param {string} text 发给引擎的提示词原文
 * @returns {string|null} 世界 id
 */
export function parseWorldRef(text) {
  const m = /世界[：:]\s*([A-Za-z0-9_-]+)\s*[。.]/.exec(String(text || ""));
  return m ? m[1] : null;
}

/**
 * 提示词是不是客户端指令（纯函数）：**只有指令才允许改变「当前剧本」**。
 * 玩家自由输入（比如自己打一句「世界：rift-mark。」）不得改变落盘目录，否则美术会归错剧本。
 * @param {string} text 发给引擎的提示词原文
 * @returns {boolean} 以 `开局：` 或 `继续世界：` 开头（客户端两条开局/续玩指令的固定前缀）
 */
export function isDirectivePrompt(text) {
  return /^\s*(开局：|继续世界：)/.test(String(text || ""));
}

const RULES = [
  "本会话运行在自定义游戏客户端下：ask_user_question 卡片工具不可用，选项一律用文本格式（正文后加粗「**行动**」+ 每行一个编号选项，多问场景每个问题单独从 1 编号）。",
  "你的每条回复只能是简体中文剧情正文和文本选项，绝不输出过程旁白、计划说明或英文。",
  "回复最末尾可以追加若干【图】标记行（由 image_gen 产物而来），格式：【图】立绘|角色名|presets/<id>/assets/立绘-角色.jpg、【图】背景|地点名|presets/<id>/assets/背景-地点.jpg 或 【图】封面|剧本标题|presets/<id>/cover.jpg，重绘覆盖旧图时追加第四段|重绘；剧情演出中可穿插【立绘】角色|变体 行切换表情差分，新剧本入轮播后输出【新剧本】<id> 行；规划回合输出【清单】立绘|<名> / 【清单】背景|<地点> 清单行（只列 presets/<剧本 id>/assets/ 缺失项，全命中时输出【清单】空）；终章回合输出【章】第 N 章 完；剧情编辑回合改完树后输出【树】行。这些协议行独立成段，不进剧情正文。",
  "缓存纪律：任何 image_gen 调用前必须先确认当前剧本 presets/<剧本 id>/assets/ 下无同名文件（唯一例外：美术：重绘）。已有素材绝不重复生成，直接出 presets/<剧本 id>/assets/… 路径标记。",
  "世界纪律：所有 state 文件读写一律在当前世界目录 state/worlds/<世界 id>/ 内（世界 id 由客户端指令给出——开局指令的「世界：<id>。」段或「继续世界：<id>。」；未给出时用 main）；除世界线分叉说明（fork.md）外绝不读写其他世界目录。",
].join("");

// ---------- 协议行解析（模块级导出，供流式 ingest 与单测复用；只有完整行传入才可能命中） ----------
// 【图】(立绘|背景|封面)|<名>|<路径>[|重绘]：资产标记（封面即剧本标题，重绘要求覆盖同名文件）
export function parseArtLine(line) {
  const m = /^\s*【图】(立绘|背景|封面)\|([^|]+)\|([^|]+?)(?:\|(重绘))?\s*$/.exec(line);
  return m ? { type: m[1], name: m[2], srcRel: m[3], regen: m[4] === "重绘" } : null;
}

// 【立绘】<角色>|<变体>：表情切换指令，不是资产（server 不持久化，只转发事件）
export function parseExpressionLine(line) {
  const m = /^\s*【立绘】([^|]+?)\|([^|]*)\s*$/.exec(line);
  return m ? { character: m[1].trim(), variant: m[2].trim() } : null;
}

// 【新剧本】<id>：新剧本入轮播通知
export function parsePresetAddedLine(line) {
  const m = /^\s*【新剧本】(.+?)\s*$/.exec(line);
  return m ? { id: m[1] } : null;
}

// 【树】：剧情图编辑完成通知（引擎已静默写回 story-tree.md）；行尾可带的摘要按 note 透传
export function parseTreeLine(line) {
  const m = /^\s*【树】(.*?)\s*$/.exec(line);
  return m ? { note: m[1].trim() } : null;
}

// 差分文件名解析：<名>[-<变体>]（第一个 - 分隔；无 - 即基础版 variant=""）
function splitAssetVariant(rest) {
  const i = rest.indexOf("-");
  return i === -1 ? { name: rest, variant: "" } : { name: rest.slice(0, i), variant: rest.slice(i + 1) };
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// 打包布局（resources/app-dist）优先，开发布局（GAME_ROOT/dist）兜底；都不存在则 /app 返回 404
function resolveAppDist() {
  for (const dir of [path.resolve(GAME_ROOT, "..", "app-dist"), path.join(GAME_ROOT, "dist")]) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// ---------- presets 解析（手写简易解析，不引依赖） ----------
const FM_KEYS = ["id", "title", "tagline", "genre", "rating"];
const THEME_KEYS = ["accent", "accent2", "motif"];
// theme 兜底：块缺失或格式坏时整套默认（aurora 为兜底母题）
const DEFAULT_THEME = Object.freeze({ accent: "#c9a86a", accent2: "#e8e4da", motif: "aurora" });

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const fm = {};
  let inTheme = false;
  for (const line of lines.slice(1, end)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // theme 块的缩进子键（accent/accent2/motif）；其余缩进行照旧忽略
      if (!inTheme) continue;
      const i = line.indexOf(":");
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      if (THEME_KEYS.includes(key)) fm.theme[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    inTheme = key === "theme"; // 顶层 key 到来即离开 theme 块
    if (inTheme) fm.theme = {}; // 只支持块形式；内联值视为坏格式，由 normalizeTheme 逐键兜底
    else if (FM_KEYS.includes(key)) fm[key] = line.slice(i + 1).trim();
  }
  return fm; // 调用方校验必填字段
}

// theme 逐键兜底：accent/accent2 要求 #hex 颜色，motif 非空；坏值用对应默认键，不抛错
function normalizeTheme(fm) {
  const raw = fm.theme && typeof fm.theme === "object" ? fm.theme : {};
  const isColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);
  return {
    accent: isColor(raw.accent) ? raw.accent : DEFAULT_THEME.accent,
    accent2: isColor(raw.accent2) ? raw.accent2 : DEFAULT_THEME.accent2,
    motif: typeof raw.motif === "string" && raw.motif.trim() ? raw.motif.trim() : DEFAULT_THEME.motif,
  };
}

// ## <角色名>（…）小节只出现在「# 主要角色」之下
function parseCharacters(lines) {
  const names = [];
  let inCast = false;
  for (const line of lines) {
    if (/^# [^#]/.test(line)) inCast = line.trim().startsWith("# 主要角色");
    if (inCast && line.startsWith("## ")) {
      let name = line.slice(3);
      const paren = name.search(/[（(]/);
      if (paren > 0) name = name.slice(0, paren);
      name = name.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

// 取 `# <heading 前缀>` 小节的正文行（到下一个一级标题为止）
function parseSectionLines(lines, headingPrefix) {
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^# [^#]/.test(line)) inSection = line.trim().startsWith(headingPrefix);
    else if (inSection && line.trim()) out.push(line);
  }
  return out;
}

/**
 * 扫描 `presets/<目录>/preset.md`（导出纯读函数，root 可注入以便单测）。
 * I2：id 直接参与路径拼接（presets/<id>/assets/…、presets/<id>/cover.jpg），
 * 所以 id 非法（含 `/`、`..`、中文等）的 preset 一律**丢弃**——进 errors 并告警，不进轮播。
 * @param {string} [root] 游戏根目录（缺省 GAME_ROOT）
 * @returns {{presets: Array<object>, errors: Array<{dir: string, error: string}>}}
 */
export function scanPresets(root = GAME_ROOT) {
  const presets = [];
  const errors = [];
  const dir = path.join(root, "presets");
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { presets, errors: [{ dir: "presets", error: "presets 目录不存在" }] };
  }
  for (const name of entries.sort()) {
    try {
      const file = path.join(dir, name, "preset.md");
      const text = fs.readFileSync(file, "utf8");
      const fm = parseFrontmatter(text);
      if (!fm || !fm.id || !fm.title) throw new Error("frontmatter 缺失或缺少 id/title");
      if (!PRESET_ID_RE.test(fm.id)) {
        // 不给轮播、不给落盘：这个 id 一旦拼进路径就可能跑到 presets/ 之外
        console.warn(`[acp] 丢弃 preset「${name}」：id 非法（只允许字母数字与 -_）: ${fm.id}`);
        errors.push({ dir: name, error: `preset id 非法（只允许字母数字与 -_）: ${fm.id}` });
        continue;
      }
      const lines = text.split(/\r?\n/);
      presets.push({
        id: fm.id,
        title: fm.title,
        tagline: fm.tagline || "",
        genre: fm.genre || "",
        rating: fm.rating || "",
        characters: parseCharacters(lines),
        protagonist_card: parseSectionLines(lines, "# protagonist_card"),
        theme: normalizeTheme(fm),
      });
    } catch (e) {
      errors.push({ dir: name, error: e.message });
    }
  }
  return { presets, errors };
}

const WORLDS_ROOT = path.join(GAME_ROOT, "state", "worlds"); // 世界线：每世界一目录，另有 index.json 索引
export const WORLD_FILES = ["state.md", "summary.md", "story-tree.md"];
const WORLD_ID_RE = /^[A-Za-z0-9_-]+$/; // 世界 id 白名单（防路径穿越）

// ---------- 世界线（state/worlds/<worldId>/）：索引、迁移、建 / 分叉 / 删 ----------
// 每个世界三份文件：state.md / summary.md / story-tree.md；index.json 记录元数据（chapterNo/lastPlayed 由磁盘自愈）
// 世界 id 白名单：字母数字与 -_（防路径穿越；id 由 createWorld 生成或来自迁移的 main）
export function readWorldsIndex(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    return Array.isArray(data) ? data.filter((e) => e && typeof e.worldId === "string") : [];
  } catch {
    return [];
  }
}

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
export function worldChapterNo(md) {
  let n = 1;
  for (const m of String(md || "").matchAll(/^##\s*第\s*(\d+)\s*章/gm)) n = Number(m[1]);
  return n;
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

/** 新建世界（分配 id、建目录、写索引）；新世界的三份文件由引擎在开局/规划时初始化 */
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

// 手动分叉：复制来源世界三文件 → 进度回退到目标节点、轮次清零、已剪枝恢复可达 → 写 fork.md；不推演任何内容
export function forkWorld(root, originId, nodeId) {
  const origin = readWorldsIndex(root).find((e) => e.worldId === originId);
  if (!origin) return { error: "来源世界不存在" };
  const srcDir = path.join(root, originId);
  if (!fs.existsSync(srcDir)) return { error: "来源世界目录不存在" };
  const entry = createWorld(root, origin.preset, origin.title);
  const dstDir = path.join(root, entry.worldId);
  for (const f of WORLD_FILES) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, f));
  }
  const treeFile = path.join(dstDir, "story-tree.md");
  const treeText = fs.existsSync(treeFile) ? fs.readFileSync(treeFile, "utf8") : "";
  if (treeText) fs.writeFileSync(treeFile, forkTreeMarkdown(treeText, nodeId));
  fs.writeFileSync(path.join(dstDir, "fork.md"), forkNote(originId, nodeId));
  const list = readWorldsIndex(root).map((e) =>
    e.worldId === entry.worldId
      ? {
          ...e,
          chapterNo: treeText ? worldChapterNo(forkTreeMarkdown(treeText, nodeId)) : e.chapterNo,
          note: `分叉自 ${originId} @ ${nodeId}`,
          forkedFrom: { worldId: originId, nodeId },
          lastPlayed: Date.now(),
        }
      : e,
  );
  writeWorldsIndex(root, list);
  console.log(`[acp] world forked: ${originId}@${nodeId} → ${entry.worldId}`);
  return { worldId: entry.worldId, entry: list.find((e) => e.worldId === entry.worldId) };
}

export function deleteWorld(root, worldId) {
  const list = readWorldsIndex(root);
  if (!list.some((e) => e.worldId === worldId)) return { error: "世界不存在" };
  writeWorldsIndex(root, list.filter((e) => e.worldId !== worldId));
  fs.rmSync(path.join(root, worldId), { recursive: true, force: true });
  console.log(`[acp] world deleted: ${worldId}`);
  return { ok: true };
}

// 列表：index 为准，磁盘自愈（chapterNo 读树、lastPlayed 取三文件最新 mtime）；按最近游玩倒序
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
      return { ...e, chapterNo, lastPlayed, exists };
    })
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

// 旧版扁平 state/*.md 一次性迁入 state/worlds/main/（幂等：index.json 已存在即跳过；无旧数据返回 false）
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

// ---------- server ----------
let instance = null;
let stopServerFn = null;

// 优雅退出：停 HTTP server（先断 SSE）+ kill grok 子进程；幂等，供 Electron will-quit 与信号处理复用
export function stopServer() {
  return stopServerFn ? stopServerFn() : Promise.resolve();
}

export function startServer() {
  if (instance) return instance;

  // ACP client
  const proc = spawn("grok", ["agent", "--always-approve", "stdio"], { cwd: GAME_ROOT });
  proc.stderr.on("data", (d) => process.stderr.write("[grok] " + d.toString().slice(0, 300)));
  proc.on("exit", (code) => console.error(`[acp] grok agent exited: ${code}`));
  const rl = readline.createInterface({ input: proc.stdout });

  let nextId = 1;
  const pending = new Map();
  let sessionId = null;
  let seg = 0;
  let busy = false;

  // assets registry：<剧本 id>|type|sanitizedName -> {type,name,rawName,presetId,file,srcRel,ready,regen}；磁盘真况见 listAssets()
  const assetRegistry = new Map();
  let currentPresetId = ""; // 当前剧本 id（sendPrompt 嗅探世界段得出；/img 的旧档直服与嗅探比对用它）
  let turnText = ""; // 当前回合 chunk 文本累积，用于流式解析【图】标记行
  let artScanPos = 0;

  const clients = new Set();
  function broadcast(obj) {
    const s = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) res.write(s);
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
      return;
    }
    if (!msg.method) return;
    if (msg.id !== undefined) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported by game shell" } }) + "\n");
    }
    if (msg.method !== "session/update") return;
    const u = msg.params.update;
    if (u.sessionUpdate === "agent_message_chunk") {
      const text = u.content?.text ?? "";
      ingestChunkText(text);
      broadcast({ type: "chunk", seg, text });
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      seg += 1;
      broadcast({ type: "seg", seg, label: String(u.title || u.toolCall?.title || "工作") });
    }
  });

  function request(method, params, timeoutMs = 120000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function sessionImagesDir() {
    const base = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(GAME_ROOT), sessionId);
    return path.join(base, "images");
  }

  // 图片落在 per-session 目录：当前会话没有时，扫所有历史会话取最新（跨会话续档）
  function resolveImage(name) {
    const cur = path.join(sessionImagesDir(), name);
    if (fs.existsSync(cur)) return cur;
    const base = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(GAME_ROOT));
    let best = null, bestT = 0;
    try {
      for (const d of fs.readdirSync(base)) {
        const f = path.join(base, d, "images", name);
        try { const st = fs.statSync(f); if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = f; } } catch {}
      }
    } catch {}
    return best;
  }

  // ---------- 资产持久化：按「剧本 + 类型 + 名字」落盘（封面 presets/<id>/cover.jpg；重绘标志覆盖同名文件） ----------
  // 「拿不到剧本」告警去重（同一 key 只警告一次）：回合末补扫、每条 /img 预载都会反复走到同一资产，
  // 不去重会把控制台刷爆，真正的告警反而看不见。
  const warnedPresetless = new Set();
  function warnPresetlessOnce(type, name, rawName) {
    const key = `${type}|${name}`;
    if (warnedPresetless.has(key)) return;
    warnedPresetless.add(key);
    console.warn(`[acp] 拿不到当前剧本，暂不落盘（等【新剧本】或带 &preset= 的请求补落）: ${type}|${rawName}`);
  }
  // 旧档路径提示去重（预载/轮播会反复命中同一条老路径）
  const warnedLegacyPaths = new Set();
  function warnLegacyPathOnce(rel) {
    if (warnedLegacyPaths.has(rel)) return;
    warnedLegacyPaths.add(rel);
    console.warn(`[acp] 请求了旧档资产路径（v1.5 之前的全局 assets/ 格式），只按当前剧本目录直服: ${rel}`);
  }

  /**
   * 落盘一个资产（流式【图】标记与回合末补扫共用）。
   * 目标随剧本走：presets/<剧本 id>/assets/<类型>-<名>.jpg（封面 presets/<id>/cover.jpg）。
   * 剧本 id 只认「调用方显式传入」或「标记路径自带 presets/<id>/…」（resolvePersistPreset），
   * **不再回退 currentPresetId**（B1）：创作模式装配新剧本时 currentPresetId 还是上一局的剧本，
   * 一退回就会把新剧本的立绘写进旧剧本的 assets 目录。
   * 拿不到剧本时不落盘，registry 留 ready:false 占位（同一 key 只告警一次），
   * 等【新剧本】<id> 标记（handleArtLine 用它重试整批占位项）或带 &preset= 的 /img 请求补落。
   * @param {string} type 立绘 | 背景 | 封面
   * @param {string} rawName 标记里的原始名（角色名/地点名/剧本标题）
   * @param {string} srcRel 标记里的原始路径（images/N.jpg 或 presets/<id>/assets/…）
   * @param {boolean} [regen] 第四段「重绘」：覆盖同名文件
   * @param {string} [presetId] 调用方解析出的剧本 id（【新剧本】补落盘会显式给出新剧本 id）
   * @returns {boolean} 目标文件是否已就绪
   */
  function persistAsset(type, rawName, srcRel, regen = false, presetId = "") {
    const name = sanitizeAssetName(rawName);
    const { presetId: pid } = resolvePersistPreset({ queryPreset: presetId, srcRel });
    const file = assetTargetFile(type, rawName, pid || "");
    if (!file) {
      const key = `${pid || ""}|${type}|${name}`;
      const entry = assetRegistry.get(key) || { type, name, rawName, presetId: pid || "", file: "", srcRel, ready: false };
      entry.rawName = rawName;
      entry.srcRel = srcRel;
      entry.regen = regen;
      entry.ready = false;
      assetRegistry.set(key, entry);
      warnPresetlessOnce(type, name, rawName);
      return false;
    }
    const finalPid = presetIdFromPath(file) || pid || ""; // 封面按标题反查到的剧本也算数
    const key = `${finalPid}|${type}|${name}`;
    const abs = path.join(GAME_ROOT, file);
    const entry = assetRegistry.get(key) || { type, name, rawName, presetId: finalPid, file, srcRel, ready: false };
    entry.presetId = finalPid;
    entry.rawName = rawName;
    entry.srcRel = srcRel;
    entry.file = file;
    entry.regen = regen;
    if (regen || !fs.existsSync(abs)) {
      // 标记出现时图片文件应已生成（引擎先 image_gen 再输出标记）；当前会话没有就跨会话扫描
      const src = resolveImage(path.basename(srcRel));
      if (!src) {
        entry.ready = false;
        assetRegistry.set(key, entry);
        return false;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(src, abs);
    }
    entry.ready = true;
    assetRegistry.set(key, entry);
    // 清掉此前「拿不到剧本」留下的同名占位项（那些 key 里的剧本 id 是空串）
    for (const [k, e] of assetRegistry) {
      if (k !== key && !e.ready && e.type === type && e.name === name) assetRegistry.delete(k);
    }
    console.log(`[acp] asset persisted: ${file}`);
    return true;
  }

  function handleArtLine(line) {
    const art = parseArtLine(line);
    if (art) { persistAsset(art.type, art.name, art.srcRel, art.regen); return; }
    const expr = parseExpressionLine(line);
    if (expr) { broadcast({ type: "expression", character: expr.character, variant: expr.variant }); return; }
    const added = parsePresetAddedLine(line);
    if (added) {
      const newId = String(added.id || "").trim();
      if (PRESET_ID_RE.test(newId)) {
        // 【新剧本】<id> = 装配期的补落盘信号（B1）：装配时【图】标记先到（那时还没人知道新剧本 id，
        // 这批条目的 presetId 是空串），标记后到就把它们全部按新剧本 id 重试一次——这批就是新剧本的美术。
        currentPresetId = newId;
        const pending = [...assetRegistry.values()].filter((e) => !e.ready);
        for (const e of pending) persistAsset(e.type, e.rawName ?? e.name, e.srcRel, e.regen === true, newId);
      } else {
        console.warn(`[acp] 【新剧本】id 非法，已忽略（不改当前剧本）: ${added.id}`);
      }
      broadcast({ type: "presetAdded", id: added.id });
    }
  }

  // 只解析已到达完整行（\n 结尾）的部分，避免流式 chunk 截断标记
  function ingestChunkText(text) {
    turnText += text;
    let nl;
    while ((nl = turnText.indexOf("\n", artScanPos)) !== -1) {
      handleArtLine(turnText.slice(artScanPos, nl));
      artScanPos = nl + 1;
    }
  }

  function flushArtLines() {
    if (artScanPos < turnText.length) handleArtLine(turnText.slice(artScanPos));
    artScanPos = turnText.length;
    // 图片文件可能晚于标记落盘，回合结束补一次。
    // 剧本 id 一律用条目上记的（`e.presetId` 为空=装配期还没拿到新剧本 id）——**不回退 currentPresetId**（B1）：
    // 那一退回就是"新剧本的美术写进上一局剧本"，正确出口是【新剧本】<id> 的补落盘或带 &preset= 的 /img。
    for (const [, e] of [...assetRegistry]) {
      if (!e.ready) persistAsset(e.type, e.rawName ?? e.name, e.srcRel, e.regen === true, e.presetId || "");
    }
  }

  /**
   * 某剧本的画廊数据：只扫该剧本的 assets/ 与封面（磁盘为准），registry 补尚未落盘的项。
   * variant 从文件名解析；inUse 只扫**该剧本的世界**（index.json 按 preset 过滤）的 state.md 是否含该名。
   * 资产随故事走，跨剧本不再串味——所以剧本 id 是必填参数。
   * @param {string} presetId 剧本 id（调用方已用 PRESET_ID_RE 校验）
   * @returns {Array<object>} 资产项列表
   */
  function listAssets(presetId) {
    const stateTexts = [];
    for (const e of readWorldsIndex(WORLDS_ROOT)) {
      if (e.preset !== presetId) continue;
      try { stateTexts.push(fs.readFileSync(path.join(WORLDS_ROOT, e.worldId, "state.md"), "utf8")); } catch {}
    }
    const inUse = (name) => stateTexts.some((t) => t.includes(name));
    const out = new Map();
    const push = (key, type, rest, file, ready) => {
      const { name, variant } = splitAssetVariant(rest);
      // preset 必填：客户端画廊按它做防御性过滤（跨剧本条目一律丢弃并告警）
      out.set(key, { type, name, variant, file, ready, preset: presetId, inUse: inUse(name), mtime: mtimeOf(path.join(GAME_ROOT, file)) });
    };
    try {
      for (const f of fs.readdirSync(presetAssetsDir(presetId))) {
        // 只认立绘/背景：封面不在 assets/ 里（契约是 presets/<id>/cover.jpg，另见下面那条），
        // `assets/封面-X.jpg` 是死路径，扫了只会给画廊塞进永远 404 的项。
        const m = /^(立绘|背景)-(.+)\.jpe?g$/.exec(f);
        // file 用**磁盘上的真实文件名**拼（v1.5 之前的素材可能是 .jpeg，硬拼 .jpg 会让画廊 404）
        if (m) push(`${m[1]}|${m[2]}`, m[1], m[2], `presets/${presetId}/assets/${f}`, true);
      }
    } catch {}
    try {
      // 封面随 preset 目录分发：presets/<id>/cover.jpg，name 用剧本标题
      const file = `presets/${presetId}/cover.jpg`;
      const preset = scanPresets().presets.find((p) => p.id === presetId);
      if (preset && fs.existsSync(path.join(GAME_ROOT, file))) push(`封面|${preset.title}`, "封面", preset.title, file, true);
    } catch {}
    for (const [, e] of assetRegistry) {
      if (e.presetId !== presetId) continue;
      const key = `${e.type}|${e.name}`; // 与磁盘扫描同键去重（registry 键含剧本 id）
      if (!out.has(key)) push(key, e.type, e.name, e.file, e.ready);
    }
    return [...out.values()];
  }

  /**
   * /img 从会话命中时顺手落盘（src 是绝对路径）。
   * 剧本 id 与 persistAsset 用同一套判定（resolvePersistPreset）：显式传入 → 来源路径解析 → 都不行就不落盘。
   * **不回退 currentPresetId**（B1）：调用方（/img 与【新剧本】补落盘）自己决定该用哪个剧本，判定只有一处。
   * @param {string} type 立绘 | 背景 | 封面
   * @param {string} rawName 标记里的原始名
   * @param {string} src 会话图片的绝对路径
   * @param {string} [presetId] 调用方解析出的剧本 id（不给即视为拿不到剧本）
   * @param {string} [srcRel] 原始来源路径（images/N.jpg 或 presets/<id>/assets/…，用于路径兜底解析）
   * @returns {boolean} 是否新落盘（目标已存在或拿不到剧本时为 false）
   */
  function persistAssetFromFile(type, rawName, src, presetId = "", srcRel = "") {
    const name = sanitizeAssetName(rawName);
    const { presetId: pid } = resolvePersistPreset({ queryPreset: presetId, srcRel });
    const file = assetTargetFile(type, rawName, pid || "");
    if (!file) {
      warnPresetlessOnce(type, name, rawName);
      return false;
    }
    const abs = path.join(GAME_ROOT, file);
    if (fs.existsSync(abs)) return false;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(src, abs);
    const finalPid = presetIdFromPath(file) || pid || "";
    assetRegistry.set(`${finalPid}|${type}|${name}`, {
      type, name, rawName, presetId: finalPid, file, srcRel, ready: true,
    });
    console.log(`[acp] asset persisted: ${file}`);
    return true;
  }


  function saveSessionId() {
    try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }) + "\n"); } catch {}
  }

  function loadSavedSessionId() {
    try {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      return typeof data.sessionId === "string" && data.sessionId ? data.sessionId : null;
    } catch { return null; }
  }

  async function boot() {
    await new Promise((r) => setTimeout(r, 800));
    await request("initialize", { protocolVersion: 1, clientCapabilities: {} });

    // 断线续档：优先 session/load 复用上次会话，失败降级 session/new 并覆写
    const savedId = loadSavedSessionId();
    let booted = false;
    if (savedId) {
      try {
        const r = await request("session/load", {
          sessionId: savedId, cwd: GAME_ROOT, mcpServers: [], _meta: { yoloMode: true, rules: RULES },
        }, 60000);
        if (r.error) throw new Error(r.error.message || "session/load rejected");
        sessionId = r.result?.sessionId || savedId;
        booted = true;
        console.log(`[acp] session/load 复用会话: ${sessionId}`);
      } catch (e) {
        console.log(`[acp] session/load 失败（${e.message}），降级 session/new`);
      }
    }
    if (!booted) {
      const s = await request("session/new", {
        cwd: GAME_ROOT, mcpServers: [], _meta: { yoloMode: true, rules: RULES },
      });
      if (s.error) throw new Error(s.error.message || "session/new rejected");
      sessionId = s.result.sessionId;
      console.log(`[acp] session/new 新会话: ${sessionId}`);
    }
    saveSessionId();
    console.log(`[acp] grok session ready: ${sessionId}`);
    // 游戏回合不需要 high 档推理，降到 medium 提速（失败忽略；load/new 会话同样生效）
    try {
      await request("session/set_config_option", {
        sessionId, configId: "reasoning_effort", value: { value: EFFORT },
      });
      console.log(`[acp] reasoning_effort -> ${EFFORT}`);
    } catch { /* 不支持就保持默认 */ }
  }

  /**
   * 提示词里的世界段 → 当前剧本：开局指令的 `世界：<worldId>。` / 续玩指令的 `继续世界：<worldId>。`
   * 是流式落盘唯一可靠的剧本来源（/img 的 &preset= 与标记路径是另外两条兜底）。
   * 两道闸：
   * 1. 只嗅探**以客户端指令开头**的提示词（isDirectivePrompt）——玩家自由输入里写一句
   *    「世界：rift-mark。」不该把后续美术的落盘目录改掉；
   * 2. 世界 → 剧本先查 `state/worlds/index.json`，查不到或记录里的 preset 不合法时
   *    回退读该世界 `state.md` 的 `- preset: <id>`（与 SKILL 的「当前剧本 id」口径一致，可自愈索引缺失）；
   *    仍然拿不到就保持原值不动（宁可沿用上一局，也不乱归档）并告警。
   */
  function sniffPreset(text) {
    if (!isDirectivePrompt(text)) return;
    const worldId = parseWorldRef(text);
    if (!worldId) return;
    const entry = readWorldsIndex(WORLDS_ROOT).find((e) => e.worldId === worldId);
    let preset = PRESET_ID_RE.test(entry?.preset || "") ? entry.preset : "";
    if (!preset) {
      preset = presetFromStateFile(worldId);
      if (preset) console.warn(`[acp] 世界 ${worldId} 未在 index.json 里记到合法 preset，改用其 state.md 的 preset: ${preset}`);
    }
    if (!PRESET_ID_RE.test(preset) || preset === currentPresetId) {
      if (!PRESET_ID_RE.test(preset)) {
        console.warn(`[acp] 世界 ${worldId} 查不到合法 preset（索引与 state.md 都没有），保持当前剧本: ${currentPresetId || "（无）"}`);
      }
      return;
    }
    currentPresetId = preset;
    console.log(`[acp] current preset: ${currentPresetId} (world ${worldId})`);
  }

  async function sendPrompt(text) {
    if (busy || !sessionId) return { ok: false, error: busy ? "上一回合还在进行" : "引擎未就绪" };
    sniffPreset(text);
    busy = true;
    seg = 0;
    turnText = "";
    artScanPos = 0;
    broadcast({ type: "turn_start" });
    try {
      await request("session/prompt", {
        sessionId, prompt: [{ type: "text", text }],
      }, 600000);
      flushArtLines();
      // 先复位再广播：客户端收到 turn_end 会立即发下一条（制作流水线自动推进），
      // 若广播后才复位会撞 409 窗口（v1.4 实测抓到的竞态）
      busy = false;
      broadcast({ type: "turn_end" });
      return { ok: true };
    } catch (e) {
      flushArtLines();
      busy = false;
      broadcast({ type: "error", message: e.message });
      return { ok: false, error: e.message };
    }
  }

  // 旧版扁平 state/*.md 一次性迁入 state/worlds/main/（幂等；已是多世界布局或无旧数据时不动）
  if (migrateLegacyState(path.join(GAME_ROOT, "state"), WORLDS_ROOT)) {
    console.log("[acp] legacy state/*.md → state/worlds/main/ 已迁移");
  }

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${BASE_PORT}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("galgame acp-server running. API: /api/presets /api/auth /api/assets?preset= /api/worlds /api/tree /events(SSE) /prompt(POST) /img?p=&t=&n=&preset=. 打包前端见 /app。");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/presets") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(scanPresets()));
      return;
    }

    // 画廊数据：资产随剧本走，必须指明剧本（缺失或非法 → 400，绝不给全局池）
    if (req.method === "GET" && url.pathname === "/api/assets") {
      const presetId = url.searchParams.get("preset") || "";
      if (!PRESET_ID_RE.test(presetId)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少或非法的 preset 参数" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(listAssets(presetId)));
      return;
    }

    // 世界线列表（可选 ?preset=<id> 过滤；chapterNo/lastPlayed 由磁盘自愈）
    if (req.method === "GET" && url.pathname === "/api/worlds") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ worlds: listWorlds(WORLDS_ROOT, url.searchParams.get("preset")) }));
      return;
    }

    // 世界线管理：create=建新世界（分配 id、写索引）；fork=在指定节点手动分叉（不推演）；delete=删除
    if (req.method === "POST" && url.pathname === "/api/worlds") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(body) || {}; } catch {}
        const action = String(payload.action || "");
        let out;
        if (action === "create") {
          const id = String(payload.preset || "");
          out = createWorld(WORLDS_ROOT, id, scanPresets().presets.find((p) => p.id === id)?.title || "");
        } else if (action === "fork") {
          const worldId = String(payload.worldId || "");
          const nodeId = String(payload.nodeId || "");
          out = WORLD_ID_RE.test(worldId) && nodeId ? forkWorld(WORLDS_ROOT, worldId, nodeId) : { error: "参数不合法" };
        } else if (action === "delete") {
          const worldId = String(payload.worldId || "");
          out = WORLD_ID_RE.test(worldId) ? deleteWorld(WORLDS_ROOT, worldId) : { error: "参数不合法" };
        } else {
          out = { error: "未知动作" };
        }
        const ok = !out.error;
        res.writeHead(ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok, ...out }));
      });
      return;
    }

    // 剧情树原文（剧情图屏解析用）：?worldId=<id>，缺省 main
    if (req.method === "GET" && url.pathname === "/api/tree") {
      const worldId = url.searchParams.get("worldId") || "main";
      let markdown = null;
      if (WORLD_ID_RE.test(worldId)) {
        try { markdown = fs.readFileSync(path.join(WORLDS_ROOT, worldId, "story-tree.md"), "utf8"); } catch {}
      }
      if (markdown === null) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "剧情树不存在" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ worldId, markdown }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth") {
      const loggedIn = fs.existsSync(path.join(os.homedir(), ".grok", "auth.json"));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ loggedIn }));
      return;
    }

    // 打包后的前端静态托管（生产/开发同构，前端请求一律走相对路径）
    if (req.method === "GET" && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
      const appDist = resolveAppDist();
      if (!appDist) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("app dist not built"); return; }
      let rel;
      try { rel = decodeURIComponent(url.pathname.slice("/app/".length)); } catch { rel = ""; }
      let file = rel ? path.join(appDist, rel) : path.join(appDist, "index.html");
      if (!path.resolve(file).startsWith(path.resolve(appDist) + path.sep)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(appDist, "index.html"); // SPA fallback
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/img") {
      const p = url.searchParams.get("p") || "";
      const t = url.searchParams.get("t") || "";
      const n = url.searchParams.get("n") || "";
      // 当前剧本：只认显式 &preset=（画廊/预载直服会带）或标记路径自带的 presets/<id>/…。
      // 非法 &preset= 告警后忽略（视为没带）；**绝不回退 currentPresetId**（B1）：
      // 创作模式装配新剧本时它是上一局的剧本，回退会把新剧本的立绘写进旧剧本目录。
      const qRaw = url.searchParams.get("preset") || "";
      const qPreset = PRESET_ID_RE.test(qRaw) ? qRaw : "";
      if (qRaw && !qPreset) console.warn(`[acp] /img 的 &preset= 非法，已忽略: ${qRaw}`);
      const { presetId: targetPid } = resolvePersistPreset({ queryPreset: qPreset, srcRel: p });
      const serve = (file) => fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
        res.end(data);
      });
      // t&n 齐备时，直服/落盘共用的目标：presets/<剧本 id>/assets/<类型>-<名>.jpg；
      // 封面（t=封面）走 assetTargetFile 的 presets/<id>/cover.jpg 分支——assets/封面-X.jpg 是死路径
      const targetRel = t && n ? assetTargetFile(t, n, targetPid || "") : "";
      const target = targetRel ? path.join(GAME_ROOT, targetRel) : "";
      // 新契约 ?t=<类型>&n=<名字>[&p=<会话路径>][&preset=<剧本 id>]：该剧本 assets 永久命中优先
      if (target && fs.existsSync(target)) { serve(target); return; }
      // 旧契约 / 会话兜底：当前会话 → 跨会话扫描；带 t&n 与剧本时顺手落盘到该剧本的 assets
      if (/^images\/\d+\.jpe?g$/.test(p) && sessionId) {
        const file = resolveImage(path.basename(p));
        if (file) {
          if (target) {
            try { persistAssetFromFile(t, n, file, targetPid || "", p); } catch {}
            if (fs.existsSync(target)) { serve(target); return; }
          }
          serve(file);
          return;
        }
      }
      // 旧档兼容（v1.5 之前老存档里记的是 assets/<类型>-<名>.jpg）：I1 起**只探测当前剧本目录**，
      // 命中即直服；找不到就 404——不再跨剧本扫同名文件（会串味），也不再迁落别剧本的图。
      // 这里只读不写：候选本来就落在当前剧本目录里，搬过去是自己搬自己。
      if (LEGACY_ASSET_RE.test(p)) {
        warnLegacyPathOnce(p);
        const legacyPid = qPreset || presetIdFromPath(p) || currentPresetId || "";
        const rel = legacyAssetCandidates(p, legacyPid)[0];
        const file = rel ? path.join(GAME_ROOT, rel) : "";
        if (file && fs.existsSync(file)) { serve(file); return; }
      }
      // 已落盘资产直服白名单（统一 jpe?g）：presets/<id>/assets/<文件> 与 presets/<id>/cover.jpg（resolve 后必须仍在 GAME_ROOT 内）
      if (/^presets\/[A-Za-z0-9_-]+\/assets\/[^/]+\.jpe?g$/.test(p) || /^presets\/[A-Za-z0-9_-]+\/cover\.jpe?g$/.test(p)) {
        const file = path.resolve(GAME_ROOT, p);
        if (file.startsWith(path.resolve(GAME_ROOT) + path.sep)) { serve(file); return; }
      }
      res.writeHead(404); res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", async () => {
        let text = "";
        try { text = JSON.parse(body).text || ""; } catch {}
        if (!text.trim()) { res.writeHead(400); res.end("{}"); return; }
        const r = await sendPrompt(text.trim());
        res.writeHead(r.ok ? 200 : 409, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  function listenWithRetry(attempt) {
    return new Promise((resolve, reject) => {
      const port = BASE_PORT + attempt;
      const onError = (e) => {
        if (e.code === "EADDRINUSE" && attempt < PORT_MAX_RETRY) {
          server.removeListener("error", onError);
          resolve(listenWithRetry(attempt + 1));
        } else {
          reject(e);
        }
      };
      server.once("error", onError);
      server.listen(port, () => {
        server.removeListener("error", onError);
        // 端口以**实际监听结果**为准：双栈/被占重试时，早先 attempt 的回调可能迟到触发，
        // 用闭包 port 会打印出假的「第一行」（真实 socket 可能在下一个端口），
        // 进而骗过按首行解析端口的测试编排（tests/helpers/stack.mjs）。
        const actualPort = server.address()?.port ?? port;
        console.log(`[acp] http://localhost:${actualPort}  (game root: ${GAME_ROOT})`);
        resolve({ port: actualPort, server, proc });
      });
    });
  }

  instance = listenWithRetry(0).then(async (handle) => {
    try { await boot(); } catch (e) { console.error("[acp] boot failed:", e.message); }
    return handle;
  });

  let stopped = false;
  stopServerFn = async () => {
    if (stopped) return;
    stopped = true;
    let handle = null;
    try { handle = await instance; } catch { /* 启动失败也要清理子进程 */ }
    for (const res of clients) res.destroy(); // SSE 长连接会拖住 server.close 回调
    clients.clear();
    if (handle) await new Promise((resolve) => handle.server.close(() => resolve()));
    try { proc.kill(); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 1500).unref(); // SIGTERM 不退则强杀
  };

  const signalExit = (sig) => {
    console.log(`[acp] ${sig} received, shutting down`);
    stopServerFn().catch(() => {}).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => signalExit("SIGINT"));
  process.on("SIGTERM", () => signalExit("SIGTERM"));
  return instance;
}

// 直接运行：node server/acp-server.mjs
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) startServer();
