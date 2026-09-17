// 美术资产路径契约纯函数（v1.7 拆模块）：文件名净化、剧本 id 白名单、落盘/直服路径的判定与拆分。
// 零业务依赖（只 import config 的 GAME_ROOT）——注意 assetTargetFile 不在这里而在 presets.mjs：
// 封面的「标题 → 剧本 id」反查要读剧本目录（scanPresets），放本模块会造成 assets↔presets 环形依赖。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 与 scripts/doctor.mjs 都从入口 import）。
import fs from "fs";
import path from "path";
import { GAME_ROOT } from "./config.mjs";

// 文件名安全字符：名字里的路径分隔符与引号类字符一律替换为 _
export function sanitizeAssetName(name) {
  const safe = String(name).replace(/[\\/:*?"<>|「」『』\r\n\t]/g, "_").trim();
  return safe || "unnamed";
}

// ---------- 美术资产路径契约（v1.5.1：资产随故事走，不写全局 assets/ 池） ----------
// 剧本 id 白名单：字母数字与 -_（防路径穿越；id 来自 preset frontmatter 与客户端指令）
export const PRESET_ID_RE = /^[A-Za-z0-9_-]+$/;
// 旧档格式：v1.5 之前资产堆在全局 assets/，state.md 与标记里记的是 `assets/<类型>-<名>.jpg`
export const LEGACY_ASSET_RE = /^assets\/([^/]+\.jpe?g)$/;

/**
 * 某剧本的资产目录（绝对路径）：`presets/<presetId>/assets/`。
 * @param {string} presetId 剧本 id（调用方先用 PRESET_ID_RE 校验）
 * @returns {string} 绝对路径
 */
export function presetAssetsDir(presetId) {
  return path.join(GAME_ROOT, "presets", presetId, "assets");
}

// 素材删除的文件名白名单（CONTRACTS §3）：单层文件名、jpe?g；cover.jpg 由路由单独排除
export const ASSET_DELETE_FILE_RE = /^[^/\\]+\.jpe?g$/;

/**
 * 资产的相对路径（posix 分隔符：要原样写进 state.md 与【图】标记）：`presets/<presetId>/assets/<类型>-<名>.jpg`。
 * 封面不走这里——封面仍是 `presets/<id>/cover.jpg`（见 presets.mjs 的 assetTargetFile）。
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

// 差分文件名解析：<名>[-<变体>]（第一个 - 分隔；无 - 即基础版 variant=""）
export function splitAssetVariant(rest) {
  const i = rest.indexOf("-");
  return i === -1 ? { name: rest, variant: "" } : { name: rest.slice(0, i), variant: rest.slice(i + 1) };
}

export function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
