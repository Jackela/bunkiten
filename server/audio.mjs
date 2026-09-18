// 音频素材（v1.6，CONTRACTS §1）：作者手放到 presets/<id>/audio/，server 只扫描+直服，不生成不落盘。
// AUDIO_KINDS/AUDIO_EXTS/AUDIO_FILE_RE/AUDIO_REL_RE/AUDIO_MIME 的真源在 shared/protocol.mjs；
// 这里 re-export AUDIO_KINDS/AUDIO_EXTS/AUDIO_FILE_RE 给 scripts/doctor.mjs（剧本体检查音频文件名
// 用同一集合、同一文件名正则，不抄第二份）。入口 server/acp-server.mjs 同样从这里 re-export（tests 从入口 import）。
import fs from "fs";
import path from "path";
import { AUDIO_FILE_RE } from "../shared/protocol.mjs";
import { GAME_ROOT } from "./config.mjs";
import { PRESET_ID_RE } from "./assets.mjs";

export { AUDIO_KINDS, AUDIO_EXTS, AUDIO_FILE_RE } from "../shared/protocol.mjs";

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
