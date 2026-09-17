// 剧本体检（preset doctor，v1.7）：`npm run doctor` 校验 presets/ 下每个剧本的结构健康度。
// 作者侧工具——创作模式装配出的新剧本也能当场体检；输出人类可读报告，退出码非 0 当且仅当存在 error 级问题
// （warning 不影响退出码）。不进 CI：CI 的 npm test 已守 checkPreset/checkAllPresets 纯函数，
// 而「仓库此刻的 preset 健康度」随游玩数据（state/worlds、素材增删）漂移，适合按需跑而非门禁化。
//
// 解析口径与 server 同源（import 复用，不抄第二份）：parseFrontmatter/parseCharacterSections/
// parseSectionLines/normalizeTheme/PRESET_ID_RE/FM_KEYS/THEME_KEYS/AUDIO_KINDS/AUDIO_EXTS 都来自
// server/acp-server.mjs（模块以 invokedDirectly 守卫自启，import 无副作用）。
// theme 叠加客户端更严的一层（src/theme.ts 的 HEX_RE/MOTIFS/FALLBACK_THEME：server 的 isColor 放行
// 3-8 位 hex、motif 只要求非空，落到客户端才会被拦）——.ts 在 Node ≥23.6 由 type stripping 直接 import。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIO_EXTS,
  AUDIO_KINDS,
  FM_KEYS,
  PRESET_ID_RE,
  THEME_KEYS,
  normalizeTheme,
  parseCharacterSections,
  parseFrontmatter,
  parseSectionLines,
  readWorldsIndex,
} from "../server/acp-server.mjs";
import { FALLBACK_THEME, HEX_RE, MOTIFS } from "../src/theme.ts";

// 开发模式 = 项目根；Electron 打包后由 main 进程注入资源目录（与 server 同款约定）
const GAME_ROOT = process.env.GROK_GAME_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 资产文件名契约：presets/<id>/assets/<类型>-<名>.jpe?g（落盘与 /img 直服白名单都只认这个形态）
const ASSET_FILE_RE = /^(立绘|背景)-(.+)\.jpe?g$/;
// 音频文件名契约：由 server 的集合构造（<类型>-<名>.<扩展名>；与 server 的 AUDIO_FILE_RE 同源，但 doctor 要看见非法文件而不是静默跳过）
const AUDIO_FILE_RE = new RegExp(`^(${AUDIO_KINDS.join("|")})-(.+)\\.(${AUDIO_EXTS.join("|")})$`);
// 角色节建议字段（SKILL「剧本创作」装配模板：每人含 art_prompt 与 agenda）——缺了引擎只能即兴，warning 而非 error
const CAST_RECOMMENDED_FIELDS = ["art_prompt", "agenda"];

/** @typedef {{level: "error"|"warn"|"ok", message: string}} Finding 一条体检结论（ok 行只在整组干净时出现，组即检查项） */

/**
 * 列目录下的单层文件名（排序保证报告确定）；跳过子目录与点前缀项（.DS_Store、导入中的 .tmp-* 残片）。
 * @param {string} dir 目录绝对路径
 * @returns {string[]|null} 文件名列表；目录不存在时 null（调用方区分「没有」与「空的」）
 */
function listFileNames(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

const ok = (message) => ({ level: "ok", message });
const warn = (message) => ({ level: "warn", message });
const error = (message) => ({ level: "error", message });

/**
 * frontmatter 组：必填键齐全且非空、id 过白名单且等于目录名。
 * @param {object|null} fm parseFrontmatter 的产物（null = 缺失/格式坏）
 * @param {string} dirName preset 目录名
 * @returns {Finding[]}
 */
function checkFrontmatter(fm, dirName) {
  if (!fm) return [error("frontmatter 缺失或格式坏（首行须是 --- 且有闭合）——scanPresets 会跳过该剧本")];
  const out = [];
  for (const key of FM_KEYS) {
    const v = typeof fm[key] === "string" ? fm[key].trim() : "";
    if (!v) {
      // id/title 是 scanPresets 的硬门槛；其余三键只回退空串（剧本照进轮播，标题屏栏位为空）
      out.push(
        key === "id" || key === "title"
          ? error(`frontmatter 缺必填键：${key}（scanPresets 直接跳过——整个剧本进不了轮播）`)
          : error(`frontmatter 缺必填键：${key}（标题屏卡片的 ${key} 栏位将为空；scanPresets 回退空串，剧本仍进轮播）`),
      );
    }
  }
  const pid = typeof fm.id === "string" ? fm.id.trim() : "";
  if (pid && !PRESET_ID_RE.test(pid)) {
    out.push(error(`id「${pid}」非法（只允许字母数字与 -_）——scanPresets 会丢弃该剧本，资产/音频也无法按它落目录`));
  } else if (pid && pid !== dirName) {
    out.push(error(`frontmatter id「${pid}」≠ 目录名「${dirName}」——轮播按 id 认剧本、素材按目录名落盘，两边会互相找不到`));
  }
  if (!out.length) return [ok(`frontmatter：必填键齐全（${FM_KEYS.join("/")}），id 合法且与目录名一致`)];
  return out;
}

/**
 * theme 组：双层判定都跟随既有实现，不抄第二份——
 * ① server 层：normalizeTheme 逐键对比原值，凡将被 server 替换为默认值的键报 warning「将被 server 回退」；
 * ② 客户端层（更严）：accent/accent2 只认 6 位 hex（src/theme.ts 的 HEX_RE——server 的 isColor 放行 3-8 位）、
 *    motif 是 4 项闭集（MOTIFS——server 只要求非空）；server 放行但客户端会拦下的值报 warning「将被客户端回退」。
 * @param {object|null} fm parseFrontmatter 的产物
 * @returns {Finding[]}
 */
function checkTheme(fm) {
  if (!fm) return [warn("theme：frontmatter 缺失，主题将整套回退默认")];
  const theme = normalizeTheme(fm);
  const raw = fm.theme && typeof fm.theme === "object" ? fm.theme : null;
  if (!raw) {
    return [warn(`theme 块缺失，将整套回退默认（${THEME_KEYS.map((k) => `${k}=${theme[k]}`).join("、")}）`)];
  }
  const out = [];
  for (const key of THEME_KEYS) {
    const v = raw[key];
    if (typeof v !== "string" || !v.trim()) {
      out.push(warn(`theme.${key} 缺失，将回退 ${theme[key]}`));
      continue;
    }
    if (v.trim() !== theme[key]) {
      out.push(warn(`theme.${key}「${v.trim()}」非法，将被 server 回退 ${theme[key]}`));
      continue;
    }
    // server 放行、客户端更严的第二层：这类值轮播里看不出问题，落到标题屏/对话框才会被兜底
    if ((key === "accent" || key === "accent2") && !HEX_RE.test(v.trim())) {
      out.push(warn(`theme.${key}「${v.trim()}」不是 6 位 hex（#rrggbb）——客户端 HEX_RE 更严，将被客户端回退 ${FALLBACK_THEME[key]}`));
    } else if (key === "motif" && !MOTIFS.includes(v.trim())) {
      out.push(warn(`theme.motif「${v.trim()}」不在客户端母题集（${MOTIFS.join("/")}）内，将被客户端回退 ${FALLBACK_THEME.motif}`));
    }
  }
  if (!out.length) return [ok(`theme：${THEME_KEYS.join("/")} 全部合法（server 与客户端两层判定都通过）`)];
  return out;
}

/**
 * 正文小节组：`# 主要角色` 存在、至少一个 `## <角色名>` 角色节（error）；
 * 角色节建议字段与 protagonist_card 缺失（warning——快速开局路径仍可用）。
 * 角色节定位复用 server 的 parseCharacterSections（名字抽取与正文切片只有 server 一份规则）。
 * @param {string} text preset.md 全文
 * @returns {Finding[]}
 */
function checkSections(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const hasCastHeading = lines.some((line) => /^# [^#]/.test(line) && line.trim().startsWith("# 主要角色"));
  const sections = parseCharacterSections(lines);
  if (!hasCastHeading) {
    out.push(error("正文缺 `# 主要角色` 小节——轮播的角色列表与美术预载队列都依赖它"));
  } else if (sections.length === 0) {
    out.push(error("`# 主要角色` 小节下没有任何 `## <角色名>` 角色节"));
  } else {
    for (const { name, body } of sections) {
      for (const field of CAST_RECOMMENDED_FIELDS) {
        if (!body.join("\n").includes(field)) {
          out.push(warn(`角色「${name}」缺建议字段 ${field}（立绘生成 / NPC 场外自转的锚点；缺失时引擎只能即兴）`));
        }
      }
    }
  }
  const card = parseSectionLines(lines, "# protagonist_card");
  if (card.length === 0) {
    out.push(warn("正文缺 `# protagonist_card` 小节——捏人屏没有问题可问（快速开局路径不受影响）"));
  }
  if (!out.length) {
    return [ok(`正文：# 主要角色（${sections.length} 人，建议字段齐全）；protagonist_card ${card.length} 行`)];
  }
  return out;
}

/**
 * 封面组：preset 根的 cover.jpg（客户端 coverUrl 只请求 presets/<id>/cover.jpg——cover.jpeg 服务端
 * 白名单收得了、导出包也带得走，但客户端永远不会请求它）。缺失 warning——标题屏回退主题渐变，游戏可玩。
 * @param {string} presetDir preset 目录绝对路径
 * @returns {Finding[]}
 */
function checkCover(presetDir) {
  if (fs.existsSync(path.join(presetDir, "cover.jpg"))) {
    return [ok("封面：cover.jpg 存在")];
  }
  if (fs.existsSync(path.join(presetDir, "cover.jpeg"))) {
    return [warn("只有 cover.jpeg：客户端只请求 presets/<id>/cover.jpg，.jpeg 版永远不会被显示——请改名为 cover.jpg")];
  }
  return [warn("缺封面 cover.jpg（标题屏卡带回退主题渐变；创作模式装配或「美术：重绘 封面 <id>」可补）")];
}

/**
 * 资产命名组：assets/ 下每个文件都须匹配 `<立绘|背景>-<名>.jpe?g`——
 * 落盘（persistAsset）与 /img 白名单只认这个形态，别的名字永远不会被服务到。
 * @param {string[]|null} assets assets/ 的文件名列表（null = 目录不存在）
 * @returns {Finding[]}
 */
function checkAssetNames(assets) {
  if (assets == null || assets.length === 0) return [ok("资产：assets/ 无素材（尚未生成或已清空）")];
  const bad = assets.filter((f) => !ASSET_FILE_RE.test(f));
  if (bad.length) {
    return bad.map((f) => error(`资产文件名非法：assets/${f}（应为 <${["立绘", "背景"].join("|")}>-<名>.jpg——落盘与直服白名单都认这个形态，别的名字永远 404）`));
  }
  return [ok(`资产命名：assets/ ${assets.length} 个文件全部符合 <类型>-<名>.jpg`)];
}

/**
 * 孤儿素材组：assets/ 里的文件既不被任何世界 state.md 引用（含 art_file 路径与场景美术清单），
 * 也不被任何 preset.md 文本提及（按素材名或差分基础名）→ warning。
 * 「在用」的判定刻意宽松：宁可漏报也不把游玩期生成、世界还在的素材误判成孤儿。
 * @param {string[]} assets assets/ 的文件名列表
 * @param {{worldStateTexts: string[], presetMdTexts: string[]}} ref 全库引用面（世界 state.md 与 preset.md 的全文）
 * @returns {Finding[]}
 */
function checkOrphans(assets, ref) {
  const valid = assets.filter((f) => ASSET_FILE_RE.test(f));
  if (!valid.length) return [ok("孤儿素材：无（没有可查的素材）")];
  const orphans = [];
  for (const f of valid) {
    const name = ASSET_FILE_RE.exec(f)[2];
    // 差分基础名与 splitAssetVariant 同口径：第一个 - 分隔（立绘-薇拉-微笑 → 薇拉）
    const base = name.includes("-") ? name.slice(0, name.indexOf("-")) : name;
    const referenced =
      ref.worldStateTexts.some((t) => t.includes(`assets/${f}`)) ||
      ref.presetMdTexts.some((t) => t.includes(name) || t.includes(base));
    if (!referenced) orphans.push(f);
  }
  if (!orphans.length) return [ok(`孤儿素材：无（${valid.length} 个素材都有 state.md 引用或 preset.md 提及）`)];
  return [warn(
    `孤儿素材 ${orphans.length} 个（不被任何世界 state.md 引用、也不被任何 preset.md 提及）：${orphans.join("、")}` +
    "——若来自未提交的世界进度，把对应世界留在 state/worlds/ 即不再报；确认没用的可在画廊删除",
  )];
}

/**
 * 音频组：audio/ 下文件名须匹配 `<类型>-<名>.<扩展名>`（类型/扩展名集合来自 server 的 AUDIO_KINDS/AUDIO_EXTS），
 * 违者 error（scanPresetAudio 静默跳过它们，永远不会被播到）；同名 `类型-名` 多份不同扩展名 → warning（索引里只有一份能播）。
 * 目录不存在 = 该剧本无音频（契约：静默不播），整组 ok。
 * @param {string[]|null} audio audio/ 的文件名列表（null = 目录不存在）
 * @returns {Finding[]}
 */
function checkAudio(audio) {
  if (audio == null) return [ok("音频：未配置 audio/（可选；缺失即静默不播）")];
  const out = [];
  const byKey = new Map(); // `类型-名` → 扩展名列表（重复名检测）
  let valid = 0;
  for (const f of audio) {
    const m = AUDIO_FILE_RE.exec(f);
    if (!m) {
      out.push(error(`音频文件名非法：audio/${f}（应为 <${AUDIO_KINDS.join("|")}>-<名>.<${AUDIO_EXTS.join("|")}>——索引只认这个形态，别的文件永远不会被播到）`));
      continue;
    }
    valid += 1;
    const key = `${m[1]}-${m[2]}`;
    byKey.set(key, [...(byKey.get(key) ?? []), m[3]]);
  }
  for (const [key, exts] of byKey) {
    if (exts.length > 1) {
      out.push(warn(`音频重名：「${key}」有多份（${exts.join("、")}）——索引按「类型|名」映射 URL，只会播到其中一份`));
    }
  }
  if (!out.length) return [ok(`音频：audio/ ${valid} 个文件命名合法`)];
  return out;
}

/**
 * 全库引用面（孤儿判定用）：所有世界 state.md 全文 + 所有 preset.md 全文。
 * 世界目录 = index.json 条目 ∪ state/worlds/ 下的目录（手建世界/索引缺失也能查到）；
 * state/trash 不在 state/worlds 下，天然不算。root 可注入以便单测。
 * @param {string} root 游戏根目录
 * @returns {{worldStateTexts: string[], presetMdTexts: string[]}}
 */
function collectReferences(root) {
  const worldsRoot = path.join(root, "state", "worlds");
  const ids = new Set(readWorldsIndex(worldsRoot).map((e) => e.worldId));
  try {
    for (const ent of fs.readdirSync(worldsRoot, { withFileTypes: true })) {
      if (ent.isDirectory() && !ent.name.startsWith(".")) ids.add(ent.name);
    }
  } catch {}
  const worldStateTexts = [];
  for (const id of ids) {
    try {
      worldStateTexts.push(fs.readFileSync(path.join(worldsRoot, id, "state.md"), "utf8"));
    } catch {}
  }
  const presetMdTexts = [];
  try {
    for (const ent of fs.readdirSync(path.join(root, "presets"), { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      try {
        presetMdTexts.push(fs.readFileSync(path.join(root, "presets", ent.name, "preset.md"), "utf8"));
      } catch {}
    }
  } catch {}
  return { worldStateTexts, presetMdTexts };
}

/**
 * 体检一个剧本目录（核心校验逻辑，导出供 tests/doctor.test.ts 直测）。
 * 检查分七组：frontmatter / theme / 正文小节 / 封面 / 资产命名 / 孤儿素材 / 音频；
 * 每组干净时恰好产出一条 [ok]，所以「N 项通过」= 通过的组数。
 * preset.md 缺失时只报一条 error（其余组无从谈起）。
 * @param {string} presetDir preset 目录绝对路径
 * @param {string} [root] 游戏根目录（孤儿判定要扫全库引用面；缺省 GAME_ROOT）
 * @returns {{dir: string, id: string, findings: Finding[], passed: number, warnings: number, errors: number}}
 */
export function checkPreset(presetDir, root = GAME_ROOT) {
  const dirName = path.basename(String(presetDir));
  let text = null;
  try {
    text = fs.readFileSync(path.join(presetDir, "preset.md"), "utf8");
  } catch {}
  if (text == null) {
    const findings = [error("preset.md 缺失——scanPresets 会跳过该目录")];
    return { dir: dirName, id: dirName, findings, passed: 0, warnings: 0, errors: 1 };
  }
  const fm = parseFrontmatter(text);
  const id = typeof fm?.id === "string" && fm.id.trim() ? fm.id.trim() : dirName;
  const assets = listFileNames(path.join(presetDir, "assets")) ?? [];
  const ref = collectReferences(root);
  const groups = [
    checkFrontmatter(fm, dirName),
    checkTheme(fm),
    checkSections(text),
    checkCover(presetDir),
    checkAssetNames(assets),
    checkOrphans(assets, ref),
    checkAudio(listFileNames(path.join(presetDir, "audio"))),
  ].flat();
  const count = (level) => groups.filter((f) => f.level === level).length;
  return {
    dir: dirName,
    id,
    findings: groups,
    passed: count("ok"),
    warnings: count("warn"),
    errors: count("error"),
  };
}

/**
 * 体检 presets/ 下全部剧本（导出供测试直测）：跳过点前缀目录（导入中的 .tmp-* 残片、.DS_Store 类），
 * 按目录名排序保证报告确定。
 * @param {string} [root] 游戏根目录（缺省 GAME_ROOT）
 * @returns {{root: string, results: Array<object>, passed: number, warnings: number, errors: number}}
 */
export function checkAllPresets(root = GAME_ROOT) {
  const presetsRoot = path.join(root, "presets");
  let names = [];
  try {
    names = fs
      .readdirSync(presetsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {}
  const results = names.map((name) => checkPreset(path.join(presetsRoot, name), root));
  const sum = (k) => results.reduce((n, r) => n + r[k], 0);
  return { root, results, passed: sum("passed"), warnings: sum("warnings"), errors: sum("errors") };
}

/**
 * CLI 入口：打印人类可读报告，返回退出码（非 0 当且仅当有 error 级问题；warning 不影响）。
 * @param {string} [root] 游戏根目录（缺省 GAME_ROOT）
 * @returns {number} 退出码
 */
export function main(root = GAME_ROOT) {
  const { results, passed, warnings, errors } = checkAllPresets(root);
  if (!results.length) {
    console.log("presets/ 下没有剧本目录（或目录不存在）");
    return 1;
  }
  for (const r of results) {
    console.log(`${r.id} ${r.errors ? "✗" : "✓"} ${r.passed} 项通过 · ${r.warnings} 警告 · ${r.errors} 错误`);
    for (const f of r.findings) console.log(`  [${f.level}] ${f.message}`);
  }
  console.log(`\n${results.length} 个剧本：${passed} 项通过 · ${warnings} 警告 · ${errors} 错误${errors ? "（存在 error 级问题，退出码 1）" : "（无 error，退出码 0；warning 不影响退出码）"}`);
  return errors ? 1 : 0;
}

// 直接运行：node scripts/doctor.mjs（或 npm run doctor）；被 import 时不执行
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
