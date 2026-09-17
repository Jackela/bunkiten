// presets/ 剧本目录的解析与导入导出（v1.7 拆模块）：preset.md 手写解析（不引依赖）、
// 落盘目标判定（assetTargetFile，封面按标题反查所以在这里而不在 assets.mjs）、
// 剧本导出包（format:"bunkiten-preset"）的打包与落地。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 与 scripts/doctor.mjs 都从入口 import）。
//
// 注意本模块 import 入口（acp-server.mjs）的 FONT_PRESETS/DIALOG_TEXTURES/DEFAULT_THEME：
// 契约 lint（tests/contract.test.ts ⑥）从**入口源码**抓这三个字面量与 src/theme.ts 比对，
// 它们钉在入口文件里；这里只在函数体内引用（不在模块顶层求值），ESM 环形引用安全。
import fs from "fs";
import path from "path";
import { AUDIO_EXTS } from "../shared/protocol.mjs";
import { GAME_ROOT } from "./config.mjs";
import { PRESET_ID_RE, sanitizeAssetName, assetRelPath, ASSET_DELETE_FILE_RE } from "./assets.mjs";
import { FONT_PRESETS, DIALOG_TEXTURES, DEFAULT_THEME } from "./acp-server.mjs";

// ---------- presets 解析（手写简易解析，不引依赖） ----------
// FM_KEYS/THEME_KEYS 同样导出（doctor 的必填键与 theme 逐键对比与 server 解析口径同源）
/** @type {readonly ["id", "title", "tagline", "genre", "rating"]} */
export const FM_KEYS = ["id", "title", "tagline", "genre", "rating"];
/** @type {readonly ["accent", "accent2", "motif", "font", "dialog"]} */
export const THEME_KEYS = ["accent", "accent2", "motif", "font", "dialog"];

/**
 * preset.md 的 frontmatter 解析结果（值未校验，坏键由调用方兜底）。
 * @typedef {Object} Frontmatter
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [tagline]
 * @property {string} [genre]
 * @property {string} [rating]
 * @property {Record<string, string>} [theme] 块形式的缩进子键（只支持块形式，内联值视为坏格式）
 */

/**
 * normalizeTheme 的产物（逐键兜底后的完整主题；与 src/theme.ts 的 Theme 同键集）。
 * @typedef {Object} ThemeInfo
 * @property {string} accent
 * @property {string} accent2
 * @property {string} motif
 * @property {string} font
 * @property {string} dialog
 */

/**
 * scanPresets 收进轮播的一个剧本。
 * @typedef {Object} PresetInfo
 * @property {string} id
 * @property {string} title
 * @property {string} tagline
 * @property {string} genre
 * @property {string} rating
 * @property {string[]} characters `# 主要角色` 小节的角色名列表
 * @property {string[]} protagonist_card
 * @property {ThemeInfo} theme
 */

// parseFrontmatter/parseCharacters/parseSectionLines 导出给 scripts/doctor.mjs 复用（体检查 preset.md 用同一解析口径，不抄第二份）
/** @param {string} text preset.md 全文 @returns {Frontmatter|null} null = 缺失或格式坏（调用方校验必填字段） */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  /** @type {Frontmatter} */
  const fm = {};
  let inTheme = false;
  for (const line of lines.slice(1, end)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // theme 块的缩进子键（accent/accent2/motif/font/dialog）；其余缩进行照旧忽略
      if (!inTheme) continue;
      const i = line.indexOf(":");
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      // inTheme 为真时 theme 块必已初始化（下方 `fm.theme = {}` 与 inTheme 同步）——cast 只表达这个不变式；
      // includes 的入参 cast 同理：把 string 键交给字面元组的 includes 前先声明「命中也是这五个之一才有意义」
      if (THEME_KEYS.includes(/** @type {"accent"|"accent2"|"motif"|"font"|"dialog"} */ (key))) /** @type {Record<string, string>} */ (fm.theme)[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    inTheme = key === "theme"; // 顶层 key 到来即离开 theme 块
    if (inTheme) fm.theme = {}; // 只支持块形式；内联值视为坏格式，由 normalizeTheme 逐键兜底
    // THEME_KEYS/FM_KEYS 的 includes 入参 cast：字面元组的 includes 只收键联合，先声明键集合归属（见上一处注释）
    else if (FM_KEYS.includes(/** @type {"id"|"title"|"tagline"|"genre"|"rating"} */ (key))) fm[/** @type {"id"|"title"|"tagline"|"genre"|"rating"} */ (key)] = line.slice(i + 1).trim();
  }
  return fm; // 调用方校验必填字段
}

/**
 * theme 逐键兜底：accent/accent2 要求 #hex 颜色，motif 非空，font/dialog 走白名单；坏值用对应默认键，不抛错。
 * @param {Frontmatter} fm
 * @returns {ThemeInfo}
 */
export function normalizeTheme(fm) {
  /** @type {Record<string, any>} */
  const raw = fm.theme && typeof fm.theme === "object" ? fm.theme : {};
  /** @param {unknown} v */
  const isColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);
  /** @param {unknown} v @param {readonly string[]} list */
  const inList = (v, list) => (typeof v === "string" && list.includes(v.trim()) ? v.trim() : null);
  return {
    accent: isColor(raw.accent) ? raw.accent : DEFAULT_THEME.accent,
    accent2: isColor(raw.accent2) ? raw.accent2 : DEFAULT_THEME.accent2,
    motif: typeof raw.motif === "string" && raw.motif.trim() ? raw.motif.trim() : DEFAULT_THEME.motif,
    font: inList(raw.font, FONT_PRESETS) ?? DEFAULT_THEME.font,
    dialog: inList(raw.dialog, DIALOG_TEXTURES) ?? DEFAULT_THEME.dialog,
  };
}

/**
 * `## <角色名>` 角色节（名字 + 正文行）。
 * @typedef {Object} CharacterSection
 * @property {string} name
 * @property {string[]} body 角色节正文行（非空行，到下一个 ## / # 为止）
 */

/**
 * ## <角色名>（…）小节只出现在「# 主要角色」之下。名字抽取规则（去行尾括注、trim、空名跳过）
 * 只在 parseCharacterSections 这一份；parseCharacters 是它名字列的投影（scanPresets 消费），
 * doctor 消费带正文的 sections 检查角色节字段——两侧同口径，不抄第二份规则。
 * @param {string[]} lines 正文行（text.split(/\r?\n/)）
 * @returns {CharacterSection[]}
 */
export function parseCharacterSections(lines) {
  /** @type {CharacterSection[]} */
  const out = [];
  let inCast = false;
  /** @type {CharacterSection|null} */
  let cur = null;
  for (const line of lines) {
    if (/^# [^#]/.test(line)) {
      inCast = line.trim().startsWith("# 主要角色");
      cur = null; // 一级标题结束当前角色节
      continue;
    }
    if (inCast && line.startsWith("## ")) {
      let name = line.slice(3);
      const paren = name.search(/[（(]/);
      if (paren > 0) name = name.slice(0, paren);
      name = name.trim();
      cur = name ? { name, body: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (cur != null && line.trim()) cur.body.push(line); // 角色节正文（非空行，到下一个 ## / # 为止）
  }
  return out;
}

/** @param {string[]} lines 正文行 @returns {string[]} 角色名列表（parseCharacterSections 的投影） */
export function parseCharacters(lines) {
  return parseCharacterSections(lines).map((s) => s.name);
}

// 取 `# <heading 前缀>` 小节的正文行（到下一个一级标题为止）
/** @param {string[]} lines 正文行 @param {string} headingPrefix 一级标题前缀（如 "# protagonist_card"） @returns {string[]} */
export function parseSectionLines(lines, headingPrefix) {
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
 * @returns {{presets: PresetInfo[], errors: Array<{dir: string, error: string}>}}
 */
export function scanPresets(root = GAME_ROOT) {
  /** @type {PresetInfo[]} */
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

// ---------- 剧本导出包（v1.7，format:"bunkiten-preset"）：presets/<id>/ 全量打包与落地 ----------
// 与世界线导出包（worlds.mjs 的 exportWorld/importWorld）对称：导出 JSON + attachment 下载、导入先整体校验再重名加 -2/-3。
// 包体：preset.md 全文 + assets/*.jpe?g（含封面 cover.jpg，封面在 preset 根）+ audio/<AUDIO_EXTS>，二进制一律 base64。
const PRESET_BUNDLE_FORMAT = "bunkiten-preset";
const PRESET_BUNDLE_VERSION = 1;
// 导入包的解码总量上限（50MB）：POST /api/presets 的 body 上限同源（base64 文本约为解码后的 1.37 倍）
export const PRESET_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
// 导入侧音频文件名白名单（由 AUDIO_EXTS 构造，不抄第二份）：单层文件名 + 合法扩展名
const PRESET_AUDIO_IMPORT_RE = new RegExp(`^[^/\\\\]+\\.(${AUDIO_EXTS.join("|")})$`);
// 封面文件名（assets 键里的 cover.jpe?g 落 preset 根，不进 assets/——`assets/封面-X.jpg` 是死路径）
const COVER_FILE_RE = /^cover\.jpe?g$/;
// Windows 保留设备名（大小写不敏感）：写成 `CON.jpg` 一样无法落盘/被系统吞掉，跨平台导入必须拒收
const WIN_RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * 导入包的文件名安全判定：单层文件名（无路径分隔符、不含 `..`）且扩展名过白名单。
 * 键名要直接拼进 `presets/<id>/{assets,audio}/` 路径，任何穿越形态一律拒绝。
 * 另拒两类「合法字符串、非法文件名」：超长名（主流文件系统单名 255 字节上限，UTF-8 下 CJK 每字 3 字节，
 * >200 字符必然越界，writeFileSync 会抛 ENAMETOOLONG——异常若冒出函数，Electron 主进程 import 了
 * 入口且无兜底，整应用闪退）；Windows 保留名（按去扩展名的 stem 判，`CON.jpg` 也是保留名）。
 * 长度阈值只是软防线（纯 ASCII 200 字节以内仍可能带扩展越界），真正的兜底是落盘段的 try/catch。
 * @param {string} name bundle 里的文件名键
 * @param {RegExp} re 扩展名白名单正则（assets 用 ASSET_DELETE_FILE_RE，audio 用 PRESET_AUDIO_IMPORT_RE）
 * @returns {boolean} 安全才允许落盘
 */
function safeBundleFileName(name, re) {
  if (typeof name !== "string" || name.trim() !== name || name === "" || name.includes("..") || name.length > 200) {
    return false;
  }
  const dot = name.lastIndexOf("."); // 两个白名单正则都要求有扩展名，这里只防手滑传进无扩展名形态
  const stem = (dot > 0 ? name.slice(0, dot) : name).toUpperCase();
  return !WIN_RESERVED_STEMS.has(stem) && re.test(name);
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 严格 base64 解码（导入包用）：Node 的 `Buffer.from(str, "base64")` 会**静默丢弃**非法字符，
 * 这里用 round-trip 比对兜住——解码不回原文（夹了私货/截断/别的编码）一律视为非法内容。
 * @param {unknown} v bundle 里的内容字段
 * @returns {Buffer|null} 解码结果；非字符串、非 base64、解码为空时 null
 */
function decodeBase64Field(v) {
  if (typeof v !== "string" || !B64_RE.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  if (buf.length === 0) return null;
  return buf.toString("base64").replace(/=+$/, "") === v.replace(/=+$/, "") ? buf : null;
}

/**
 * 剧本导出包（format:"bunkiten-preset" v1）。
 * @typedef {Object} PresetBundle
 * @property {string} format
 * @property {number} version
 * @property {string} id
 * @property {string} title
 * @property {string} exportedAt
 * @property {string} presetMd
 * @property {Record<string, string>} assets 文件名 → base64
 * @property {Record<string, string>} audio 文件名 → base64
 */

/**
 * 打包一个剧本为可迁移 bundle（v1.7，导出纯函数，root 可注入以便单测）。
 * 收文件：preset.md 全文；assets/ 下全部 jpe?g（跳过 cover.jpe?g——那是死路径，封面在 preset 根）；
 * preset 根的 cover.jpe?g；audio/ 下全部 AUDIO_EXTS 文件。子目录、不认识的扩展名与 0 字节文件一律跳过
 * （保证导出的包能原样导回）。文件名排序收集，同目录的导出结果确定。
 * @param {string} root 游戏根目录
 * @param {string} id 剧本 id
 * @returns {{bundle?: PresetBundle, error?: string}} 成功时 bundle、失败时 error（HTTP 层按字段有无分流）
 */
export function buildPresetBundle(root, id) {
  const pid = String(id || "").trim();
  if (!PRESET_ID_RE.test(pid)) return { error: "参数不合法" };
  const dir = path.join(root, "presets", pid);
  let presetMd;
  try {
    presetMd = fs.readFileSync(path.join(dir, "preset.md"), "utf8");
  } catch {
    return { error: "剧本不存在" };
  }
  const title = parseFrontmatter(presetMd)?.title || "";
  // 以扩展名收文件：目录不存在 = 空（audio 可选、assets 目录也未必有）；withFileTypes 跳过子目录
  /** @param {string} sub 子目录名（"." = preset 根） @param {RegExp} re 扩展名白名单 @returns {Record<string, string>} */
  const collect = (sub, re) => {
    /** @type {Record<string, string>} */
    const out = {};
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!ent.isFile() || !re.test(ent.name)) continue;
      try {
        const buf = fs.readFileSync(path.join(dir, sub, ent.name));
        if (buf.length > 0) out[ent.name] = buf.toString("base64");
      } catch {}
    }
    return out;
  };
  const assets = { ...collect("assets", /^(?!cover\.jpe?g$)[^/\\]+\.jpe?g$/), ...collect(".", COVER_FILE_RE) };
  return {
    bundle: {
      format: PRESET_BUNDLE_FORMAT,
      version: PRESET_BUNDLE_VERSION,
      id: pid,
      title,
      exportedAt: new Date().toISOString(),
      presetMd,
      assets,
      audio: collect("audio", PRESET_AUDIO_IMPORT_RE),
    },
  };
}

/**
 * 导入一个剧本 bundle（v1.7）：整体校验 → 重名加 -2/-3 → 落盘。
 * 校验口径与导出对称：format/version/id（PRESET_ID_RE）、presetMd 非空字符串、
 * 文件名单层且扩展名过白名单（assets=jpe?g、audio=AUDIO_EXTS，封面键落 preset 根）、
 * 内容严格 base64、解码总量 ≤50MB——任何一项不合法一律拒绝，**不写半个剧本**。
 * 占用判定以磁盘目录为准（presets 没有索引文件，scanPresets 扫的就是目录）。
 * preset.md 原文落地；frontmatter id 与落地 id 不一致时改写 id 行（见下方内联注释）。
 * 落盘走「临时目录写全量 → 同层 rename 进位」：任何写盘异常（磁盘满/文件名超限/rename 失败）清理
 * 临时目录后**返回 error 而不抛出**——readBodyText 的回调没有兜底，冒泡即 uncaughtException，
 * 而 Electron 主进程同进程 import 入口，等于整应用闪退。
 * @param {string} root 游戏根目录
 * @param {{format?: unknown, version?: unknown, id?: unknown, presetMd?: unknown,
 *   assets?: Record<string, unknown>|null, audio?: Record<string, unknown>|null}} bundle 导出体（JSON 直入，函数内逐字段校验）
 * @returns {{ok?: true, id?: string, error?: string}} id = 实际落地的剧本 id（可能已重名改名）
 */
export function importPresetBundle(root, bundle) {
  if (!bundle || typeof bundle !== "object") return { error: "bundle 校验失败" };
  if (bundle.format !== PRESET_BUNDLE_FORMAT || bundle.version !== PRESET_BUNDLE_VERSION) {
    return { error: "bundle 校验失败" };
  }
  const id = String(bundle.id ?? "");
  if (!PRESET_ID_RE.test(id)) return { error: "bundle 校验失败：id 非法" };
  if (typeof bundle.presetMd !== "string" || bundle.presetMd.trim() === "") {
    return { error: "bundle 校验失败：presetMd 必须是非空字符串" };
  }
  // 先校验并解码全部文件，再决定落盘目标 id：中途任何失败都不动磁盘
  const assetsIn = bundle.assets != null && typeof bundle.assets === "object" ? bundle.assets : {};
  const audioIn = bundle.audio != null && typeof bundle.audio === "object" ? bundle.audio : {};
  const files = [];
  let total = 0;
  for (const [name, b64] of Object.entries(assetsIn)) {
    if (!safeBundleFileName(name, ASSET_DELETE_FILE_RE)) return { error: `非法的素材文件名: ${name}` };
    const buf = decodeBase64Field(b64);
    if (!buf) return { error: `素材内容不是有效的 base64: ${name}` };
    total += buf.length;
    files.push({ sub: COVER_FILE_RE.test(name) ? "" : "assets", name, buf });
  }
  for (const [name, b64] of Object.entries(audioIn)) {
    if (!safeBundleFileName(name, PRESET_AUDIO_IMPORT_RE)) return { error: `非法的音频文件名: ${name}` };
    const buf = decodeBase64Field(b64);
    if (!buf) return { error: `音频内容不是有效的 base64: ${name}` };
    total += buf.length;
    files.push({ sub: "audio", name, buf });
  }
  if (total > PRESET_IMPORT_MAX_BYTES) {
    return { error: `包体解码总量超上限（${Math.round(PRESET_IMPORT_MAX_BYTES / 1024 / 1024)}MB）` };
  }
  // 重名后缀：-2、-3…（与 importWorld 同款循环，不覆盖既有剧本）
  const presetsRoot = path.join(root, "presets");
  const taken = new Set();
  try {
    for (const ent of fs.readdirSync(presetsRoot, { withFileTypes: true })) {
      if (ent.isDirectory()) taken.add(ent.name);
    }
  } catch {}
  let finalId = id;
  let n = 1;
  while (taken.has(finalId)) {
    n += 1;
    finalId = `${id}-${n}`;
  }
  // 落盘：先写临时目录（presets/.tmp-<id>-<随机>，点前缀就算极端残留也进不了轮播），全量写完再
  // rename 进位——中途失败（磁盘满/ENAMETOOLONG/被占用）不留半个剧本。整个写盘段包 try/catch，
  // 异常绝不冒出函数（见函数头注释：冒泡即 uncaughtException，Electron 主进程会同进程闪退）。
  const dir = path.join(presetsRoot, finalId);
  const tmp = path.join(presetsRoot, `.tmp-${finalId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  try {
    // preset.md 原文落地；仅当 frontmatter id 与落地目录 id 不一致（重名改名或手写包）时改写 id 行——
    // scanPresets 按 frontmatter id 进轮播，不改写会出现「目录 demo-2、轮播里还叫 demo」的重复卡带，
    // 后续美术/音频也会按轮播 id 落错目录。frontmatter 没有合法 id 行时保持原文（scanPresets 会把它报进 errors）。
    let presetMd = bundle.presetMd;
    const fmId = parseFrontmatter(presetMd)?.id || "";
    if (PRESET_ID_RE.test(fmId) && fmId !== finalId) {
      presetMd = presetMd.replace(/^id:\s*[^\r\n]*$/m, `id: ${finalId}`);
    }
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "preset.md"), presetMd);
    for (const f of files) {
      const targetDir = f.sub ? path.join(tmp, f.sub) : tmp;
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, f.name), f.buf);
    }
    fs.renameSync(tmp, dir); // 同层 rename：要么整体进位、要么目录原样不动
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true }); // 清掉写了一半的临时目录，不留残留
    return { error: `包体写入失败：${e.message}` };
  }
  console.log(`[acp] preset imported: ${id} → ${finalId}`);
  return { ok: true, id: finalId };
}
