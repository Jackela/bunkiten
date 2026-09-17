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
export const EFFORT = process.env.EFFORT || "medium"; // 正戏回合档位：低推理换节奏，可设 high
// 建档/规划类回合（出清单、改树、装配）不需要高推理：单独一档更省、更快（v1.6 分档）
export const EFFORT_PLANNING = process.env.EFFORT_PLANNING || "low";
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

// ---------- 音频素材（v1.6，CONTRACTS §1）：作者手放到 presets/<id>/audio/，server 只扫描+直服，不生成不落盘 ----------
const AUDIO_KINDS = ["曲", "环境", "音效"];
const AUDIO_EXTS = ["mp3", "ogg", "m4a", "wav", "flac"];
// 文件名 <类型>-<名>.<ext>；类型与扩展名都过白名单（名可含中文，不含路径分隔符）
const AUDIO_FILE_RE = new RegExp(`^(${AUDIO_KINDS.join("|")})-(.+)\\.(${AUDIO_EXTS.join("|")})$`);
// 直服白名单（与 /img 同款思路）：相对路径形态 + 无子目录 + 扩展名合法——resolve 前缀校验是第二道闸
const AUDIO_REL_RE = new RegExp(`^presets/[A-Za-z0-9_-]+/audio/[^/]+\\.(${AUDIO_EXTS.join("|")})$`);
const AUDIO_MIME = { mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac" };
// 素材删除的文件名白名单（CONTRACTS §3）：单层文件名、jpe?g；cover.jpg 由路由单独排除
const ASSET_DELETE_FILE_RE = /^[^/\\]+\.jpe?g$/;

/**
 * 扫描 `presets/<id>/audio/`（导出纯读函数，root 可注入以便单测）。
 * 目录不存在 = 该剧本无音频，返回空数组（不报错、不进 assetRegistry——音频不属于美术资产）。
 * @param {string} presetId 剧本 id（非法时返回空数组，绝不拼出目录外路径）
 * @param {string} [root] 游戏根目录（缺省 GAME_ROOT）
 * @returns {Array<{kind: string, name: string, file: string, url: string}>} 音频项（url 供客户端直接播放）
 */
export function scanPresetAudio(presetId, root = GAME_ROOT) {
  const pid = String(presetId || "").trim();
  if (!PRESET_ID_RE.test(pid)) return [];
  let files = [];
  try {
    files = fs.readdirSync(path.join(root, "presets", pid, "audio"));
  } catch {
    return []; // 无 audio 目录 = 无音频（契约：不报错）
  }
  const out = [];
  for (const file of files.sort()) {
    const m = AUDIO_FILE_RE.exec(file);
    if (!m) continue;
    // url 里的文件名必须百分号编码：文件名可含 &/?/#/空格，不编码会把查询串截断（AUDIO_REL_RE 在服务端解回）
    out.push({ kind: m[1], name: m[2], file, url: `/audio?p=presets/${pid}/audio/${encodeURIComponent(file)}` });
  }
  return out;
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

/**
 * 回合档位选择（纯函数）：建档/规划类回合走 planning 档，其余（正戏/自由输入）走正戏档。
 * 与 CONTRACTS §4 的正则逐字一致——「创作模式：」等前缀与 `isDirectivePrompt` 无关，只影响推理档位。
 * 档位值可注入（缺省模块常量）以便单测不依赖环境变量。
 * @param {string} text 发给引擎的提示词原文
 * @param {string} [main] 正戏档位（缺省 EFFORT）
 * @param {string} [planning] 规划档位（缺省 EFFORT_PLANNING）
 * @returns {string} 本次回合应使用的 reasoning_effort
 */
export function pickEffort(text, main = EFFORT, planning = EFFORT_PLANNING) {
  return /^(规划：|美术：|装配。|剧情：|创作模式：)/.test(String(text || "")) ? planning : main;
}

// 导出供契约 lint（tests/contract.test.ts）逐句比对 docs/ARCHITECTURE.md 的副本。
// 为什么导出「逐句数组」而不是只导出拼接后的串：句内本身含句号（如「世界：<id>。」），
// 从长串反推句子边界不可靠；RULES_SENTENCES 是 6 句的真源，RULES 仍是它 `.join("")` 的产物
//（注入 agent 的字符串逐字不变，只是把两个视图都暴露出来）。
export const RULES_SENTENCES = [
  "本会话运行在自定义游戏客户端下：ask_user_question 卡片工具不可用，选项一律用文本格式（正文后加粗「**行动**」+ 每行一个编号选项，多问场景每个问题单独从 1 编号）。",
  "你的每条回复只能是简体中文剧情正文和文本选项，绝不输出过程旁白、计划说明或英文。",
  "回复最末尾可以追加若干【图】标记行（由 image_gen 产物而来），格式：【图】立绘|角色名|presets/<id>/assets/立绘-角色.jpg、【图】背景|地点名|presets/<id>/assets/背景-地点.jpg 或 【图】封面|剧本标题|presets/<id>/cover.jpg，重绘覆盖旧图时追加第四段|重绘；剧情演出中可穿插【立绘】角色|变体 行切换表情差分，并可穿插【曲】<名> / 【环境】<名> / 【音效】<名> 切换音频，新剧本入轮播后输出【新剧本】<id> 行；规划回合输出【清单】立绘|<名> / 【清单】背景|<地点> 清单行（只列 presets/<剧本 id>/assets/ 缺失项，全命中时输出【清单】空）；终章回合输出【章】第 N 章 完；剧情编辑回合改完树后输出【树】行。这些协议行独立成段，不进剧情正文。",
  "缓存纪律：任何 image_gen 调用前必须先确认当前剧本 presets/<剧本 id>/assets/ 下无同名文件（唯一例外：美术：重绘）。已有素材绝不重复生成，直接出 presets/<剧本 id>/assets/… 路径标记。",
  "世界纪律：所有 state 文件读写一律在当前世界目录 state/worlds/<世界 id>/ 内（世界 id 由客户端指令给出——开局指令的「世界：<id>。」段或「继续世界：<id>。」；未给出时用 main）；除世界线分叉说明（fork.md）外绝不读写其他世界目录。",
  // 第 6 句（音频纪律）逐字来自 CONTRACTS §5：与 SKILL 的【音频】小节、客户端 AudioManager 同一份协议
  "音频纪律：场景切换或情绪转折时，可用【曲】<名>、【环境】<名>、【音效】<名> 三行切换音频（各自单独成段，不进正文）；每轮【曲】/【环境】至多各一次、【音效】至多两次，无把握就不发；文件由作者放在 presets/<剧本 id>/audio/ 下（命名 <类型>-<名>.<扩展名>），文件不存在时静默不发——绝不生成音频、绝不在标记里写路径。",
];

/** 注入 agent 的 rules 原文（6 句拼接成一条：`_meta.rules`） */
export const RULES = RULES_SENTENCES.join("");

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

// 【曲】/<名>、【环境】/<名>、【音效】/<名>：音频切换指令（演出指令，与【立绘】同级；server 不落盘，只广播）
// 行首 trim 后匹配（CONTRACTS §1）：名里不再夹带路径，`停` 也是普通名字（客户端自行处理淡出）
export function parseAudioLine(line) {
  const m = /^【(曲|环境|音效)】([^\n]*)$/.exec(String(line ?? "").trim());
  return m ? { kind: m[1], name: m[2] } : null;
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
const THEME_KEYS = ["accent", "accent2", "motif", "font", "dialog"];
// 字体族/对话框质感白名单（v1.7）：与 src/theme.ts 的 FONT_PRESETS/DIALOG_TEXTURES 同集
const FONT_PRESETS = ["serif", "song", "kai", "hei"];
const DIALOG_TEXTURES = ["plain", "silk", "paper", "glass"];
// theme 兜底：块缺失或格式坏时整套默认（aurora 为兜底母题）
const DEFAULT_THEME = Object.freeze({ accent: "#c9a86a", accent2: "#e8e4da", motif: "aurora", font: "serif", dialog: "plain" });

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const fm = {};
  let inTheme = false;
  for (const line of lines.slice(1, end)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // theme 块的缩进子键（accent/accent2/motif/font/dialog）；其余缩进行照旧忽略
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

// theme 逐键兜底：accent/accent2 要求 #hex 颜色，motif 非空，font/dialog 走白名单；坏值用对应默认键，不抛错
export function normalizeTheme(fm) {
  const raw = fm.theme && typeof fm.theme === "object" ? fm.theme : {};
  const isColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);
  const inList = (v, list) => (typeof v === "string" && list.includes(v.trim()) ? v.trim() : null);
  return {
    accent: isColor(raw.accent) ? raw.accent : DEFAULT_THEME.accent,
    accent2: isColor(raw.accent2) ? raw.accent2 : DEFAULT_THEME.accent2,
    motif: typeof raw.motif === "string" && raw.motif.trim() ? raw.motif.trim() : DEFAULT_THEME.motif,
    font: inList(raw.font, FONT_PRESETS) ?? DEFAULT_THEME.font,
    dialog: inList(raw.dialog, DIALOG_TEXTURES) ?? DEFAULT_THEME.dialog,
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

// ---------- 逐轮状态快照与精确回退（v1.6，CONTRACTS §2） ----------
// 目录 state/worlds/<worldId>/history/NNNN.json（4 位递增、append-only）。存整份文件的全文，
// 这样「精确回退」= 直接把快照三文件写回，不依赖引擎再推演（兼容路径才让引擎按 fork.md 校准）。
const HISTORY_DIRNAME = "history";
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

// 选精确回退源（纯逻辑）：显式 seq 命中优先；否则按 nodeId 取最早匹配快照；都没有 → null（走兼容路径）
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
 * @returns {{bundle: object}|{error: string}}
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
 * @param {object} bundle 导出体
 * @returns {{worldId: string}|{error: string}}
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
      // label 是 v1.6 新增的展示名（update 写入）；老索引没有该字段时补空串，客户端不必判 undefined
      return { ...e, label: typeof e.label === "string" ? e.label : "", chapterNo, lastPlayed, exists };
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

// ---------- 本地端点防护（v1.6）：来源校验 + body 上限 ----------
// 这个 server 只服务本机（Electron / vite dev / curl），不对外开放。跨站请求一律 403（CSRF/端口探测），
// 但**无 Origin 的非浏览器客户端（curl/集成测试）与同源请求（Electron 打包态 /app）必须放行**——
// Electron 生产态从 http://127.0.0.1:<port>/app 同源请求，vite dev 从 http://localhost:5173 请求（同机来源）。
const MAX_BODY_BYTES = 5 * 1024 * 1024; // POST body 上限 5MB（世界 bundle / 提示词都远小于此）
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

/**
 * 是不是应当拒绝的跨站请求：sec-fetch-site=cross-site 一律拒；带了 Origin 就必须是本机来源。
 * 无 Origin（非浏览器客户端）一律放行——这是 curl / 集成测试 / Electron 同源请求的正常形态。
 * @param {import("http").IncomingMessage} req
 * @returns {boolean} 命中即调用方回 403
 */
export function isCrossSiteRequest(req) {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return true;
  const origin = req.headers.origin;
  return typeof origin === "string" && origin !== "" && !LOCAL_ORIGIN_RE.test(origin);
}

/**
 * 读 POST 的 JSON body：累积上限 5MB，超限回 413 并断连；否则把原文交给 onEnd（调用方自行 JSON.parse）。
 * 统一入口让 /prompt、/api/worlds、/api/assets 共用同一上限，避免逐路由各写一份累积逻辑。
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {(body: string) => void} onEnd
 */
export function readBodyText(req, res, onEnd) {
  const chunks = [];
  let size = 0;
  let done = false;
  req.on("data", (c) => {
    if (done) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      done = true;
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      // 先把 413 刷出去再销毁连接（销毁延后一拍：立即 destroy 会用 RST 把刚发出的响应从客户端接收缓冲里丢掉）
      res.end(JSON.stringify({ error: "请求体过大（上限 5MB）" }), () => {
        const t = setTimeout(() => req.destroy(), 10);
        t.unref?.();
      });
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (done) return;
    done = true;
    onEnd(Buffer.concat(chunks).toString("utf8"));
  });
  req.on("error", () => {
    done = true; // 客户端提前断开：不再回调，静默收尾
  });
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
  let currentWorldId = null; // 当前世界 id（sniffPreset 一并保存；逐轮快照按它落盘 history/NNNN.json）
  let lastEffort = EFFORT; // 上次已生效的推理档位（boot 已设 EFFORT；档位变化才再发 set_config_option）
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
    // 【树】= 剧情编辑回合的静默刷新信号（客户端收到即重取 /api/tree）：此前漏接线，只在单测里被直接调用过
    if (parseTreeLine(line)) { broadcast({ type: "treeEdited" }); return; }
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
    // 分支顺序末位的 audio（CONTRACTS §1）：演出指令，只转发事件，不落盘、不生成、不进 registry
    const audio = parseAudioLine(line);
    if (audio) broadcast({ type: "audio", kind: audio.kind, name: audio.name });
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
    // 世界 id 与剧本 id **一并**在这里落定：指令没给世界段（非指令/无段）时保持上次值，
    // 逐轮快照的落盘目录随之确定（否则快照会写进错误的世界）。
    currentWorldId = worldId;
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

  // 档位分档（CONTRACTS §4）：正戏/自由输入走 EFFORT，规划/建档类走 EFFORT_PLANNING；
  // 与上次已生效的档位不同才发 set_config_option，失败静默（不支持就保持现状，下次变化再试）。
  async function applyEffort(text) {
    const effort = pickEffort(text);
    if (effort === lastEffort) return;
    try {
      await request("session/set_config_option", {
        sessionId, configId: "reasoning_effort", value: { value: effort },
      });
      lastEffort = effort;
      console.log(`[acp] reasoning_effort -> ${effort}`);
    } catch { /* 引擎不支持档位：静默，不阻断回合 */ }
  }

  // 正戏回合判定（纯逻辑，CONTRACTS §2）：规划/美术/剧情/装配/创作模式回合、以及带「待命：」的开局指令
  // 都不推进剧情正文，不该产生逐轮快照。
  function isMainTurn(text) {
    const s = String(text || "").trim();
    if (/^(规划：|美术：|剧情：|装配。|创作模式：)/.test(s)) return false;
    if (s.includes("待命：")) return false;
    return true;
  }

  // 逐轮快照（CONTRACTS §2）：正戏回合结束后把当前世界三文件全文存一份 history/NNNN.json。
  // 调用点固定在 flushArtLines() 之后、busy=false 之前——此刻本轮所有落盘都已定型，内容不会再多变。
  function writeTurnSnapshot(text) {
    if (!isMainTurn(text)) return;
    const worldId = currentWorldId;
    if (!worldId || !WORLD_ID_RE.test(worldId)) return; // 还没定下世界（未开局）→ 无从落快照
    const files = readWorldFiles(path.join(WORLDS_ROOT, worldId));
    const res = writeSnapshot(WORLDS_ROOT, worldId, {
      kind: "turn",
      nodeId: parseTreePointer(files.tree),
      chapterNo: files.tree != null ? worldChapterNo(files.tree) : null,
      files,
    });
    if (res.ok) console.log(`[acp] snapshot written: ${worldId}/history/${String(res.seq).padStart(4, "0")}.json`);
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
      await applyEffort(text); // 档位变化才 set_config_option（在 session/prompt 之前）
      const r = await request("session/prompt", {
        sessionId, prompt: [{ type: "text", text }],
      }, 600000);
      // request() 会 resolve 整个响应 msg：引擎按 JSON-RPC 回 error response（而不是断流/超时）时
      // 以前被当成功回合处理（照写快照、广播 turn_end、HTTP 200）——这里显式抛错，落进下方 catch
      //（error 事件 + busy 复位 + 不写快照 + POST /prompt 409），与超时/进程崩掉同一错误路径。
      if (r && r.error) {
        throw new Error(`引擎回合失败：${r.error.message ?? JSON.stringify(r.error)}`);
      }
      flushArtLines();
      writeTurnSnapshot(text); // 逐轮快照：flushArtLines 之后、busy=false 之前
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

    // 来源校验（统一入口，先于所有路由）：跨站请求一律 403（无 Origin 的 curl/测试/Electron 同源请求放行）
    if (isCrossSiteRequest(req)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "跨站请求被拒绝" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      // 首页导览：把 v1.6 的新路由（音频列表/直服、历史快照、世界导出）一并列上，方便 curl 排查
      res.end(
        "galgame acp-server running. API: /api/presets /api/auth /api/assets?preset=(GET,POST删除) /api/audio?preset= " +
          "/api/worlds(POST: create/fork/restore/update/delete/import) /api/worlds/export?worldId= /api/history?worldId=[&seq=] " +
          "/api/tree /events(SSE) /prompt(POST) /img?p=&t=&n=&preset= /audio?p=. 打包前端见 /app。",
      );
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

    // 素材批量删除（CONTRACTS §3）：只删 presets/<id>/assets/ 下的单层 jpe?g，封面（cover.jpg）不可删
    if (req.method === "POST" && url.pathname === "/api/assets") {
      readBodyText(req, res, (body) => {
        let payload = {};
        try { payload = JSON.parse(body) || {}; } catch {}
        const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
        if (String(payload.action || "") !== "delete") return json(400, { error: "未知动作" });
        const presetId = String(payload.preset || "");
        const file = String(payload.file || "");
        // preset 过白名单、file 单层且是 jpe?g（防穿越）；封面不在 assets/ 也不允许删
        if (!PRESET_ID_RE.test(presetId) || !ASSET_DELETE_FILE_RE.test(file) || file === "cover.jpg") {
          return json(400, { error: "参数不合法" });
        }
        const abs = path.join(GAME_ROOT, "presets", presetId, "assets", file);
        if (!fs.existsSync(abs)) return json(404, { error: "素材不存在" });
        try {
          fs.unlinkSync(abs);
        } catch (e) {
          // ENOENT = 竞态下已被删走 → 仍按「不存在」404；其余（EACCES/EPERM/EBUSY…）才是真失败 → 500
          return e.code === "ENOENT" ? json(404, { error: "素材不存在" }) : json(500, { error: "素材删除失败" });
        }
        console.log(`[acp] asset deleted: presets/${presetId}/assets/${file}`);
        return json(200, { ok: true });
      });
      return;
    }

    // 音频清单（CONTRACTS §1）：preset 必填且过白名单（与 /api/assets 同款；音频随剧本站，不给全局池）
    if (req.method === "GET" && url.pathname === "/api/audio") {
      const presetId = url.searchParams.get("preset") || "";
      if (!PRESET_ID_RE.test(presetId)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少或非法的 preset 参数" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ items: scanPresetAudio(presetId) }));
      return;
    }

    // 逐轮状态快照（CONTRACTS §2）：列表只回元信息；带 &seq=<n> 时**只读目标文件**并只回该条（回退预览用）。
    // 带 seq 的调用很热（预览/重建），不能为了附 files 把整个 history 目录全量 parse。
    if (req.method === "GET" && url.pathname === "/api/history") {
      const worldId = url.searchParams.get("worldId") || "";
      if (!WORLD_ID_RE.test(worldId)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少或非法的 worldId 参数" }));
        return;
      }
      const seqParam = url.searchParams.get("seq");
      if (seqParam != null && seqParam !== "") {
        const one = readSnapshot(worldId, seqParam, WORLDS_ROOT);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ worldId, snapshots: one ? [one] : [] }));
        return;
      }
      const snapshots = readSnapshots(worldId, WORLDS_ROOT).map((s) => ({
        seq: s.seq, at: s.at, kind: s.kind, nodeId: s.nodeId, chapterNo: s.chapterNo,
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ worldId, snapshots }));
      return;
    }

    // 世界导出（CONTRACTS §2）：GET /api/worlds/export?worldId=<id> → 附件下载 <worldId>.world.json
    if (req.method === "GET" && url.pathname === "/api/worlds/export") {
      const worldId = url.searchParams.get("worldId") || "";
      const out = exportWorld(WORLDS_ROOT, worldId); // 内部已过 WORLD_ID_RE + 存在性校验
      if (out.error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: out.error }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${worldId}.world.json"`,
      });
      res.end(JSON.stringify(out.bundle));
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
      readBodyText(req, res, (body) => {
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
          // seq 可选：显式给出时优先用那条快照做精确源（CONTRACTS §2）
          const seq = payload.seq == null || payload.seq === "" ? null : Number(payload.seq);
          const seqOk = seq == null || (Number.isInteger(seq) && seq >= 1);
          out = WORLD_ID_RE.test(worldId) && nodeId && seqOk ? forkWorld(WORLDS_ROOT, worldId, nodeId, seq) : { error: "参数不合法" };
        } else if (action === "restore") {
          const worldId = String(payload.worldId || "");
          const seq = Number(payload.seq);
          out = WORLD_ID_RE.test(worldId) && Number.isInteger(seq) ? restoreWorld(WORLDS_ROOT, worldId, seq) : { error: "参数不合法" };
        } else if (action === "update") {
          const worldId = String(payload.worldId || "");
          const patch = {};
          if ("label" in payload) patch.label = payload.label;
          if ("note" in payload) patch.note = payload.note;
          out = WORLD_ID_RE.test(worldId) ? updateWorld(WORLDS_ROOT, worldId, patch) : { error: "参数不合法" };
        } else if (action === "import") {
          out = importWorld(WORLDS_ROOT, payload.bundle);
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

    // 音频直服（CONTRACTS §1）：白名单形态 + path.resolve 前缀校验（与 /img 同款两道闸）；
    // 直接整文件 200（不做 Range——音频文件小，客户端拉全量即可），长缓存。
    if (req.method === "GET" && url.pathname === "/audio") {
      const p = url.searchParams.get("p") || "";
      if (AUDIO_REL_RE.test(p)) {
        const file = path.resolve(GAME_ROOT, p);
        if (file.startsWith(path.resolve(GAME_ROOT) + path.sep)) {
          const ext = path.extname(file).slice(1).toLowerCase();
          fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, {
              "content-type": AUDIO_MIME[ext] || "application/octet-stream",
              "cache-control": "public, max-age=86400",
            });
            res.end(data);
          });
          return;
        }
      }
      res.writeHead(404); res.end();
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
      readBodyText(req, res, async (body) => {
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
