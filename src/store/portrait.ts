// 立绘相关的纯函数（v1.6 slice 拆分抽出）：无状态、不依赖 set/get，单测直接调。
// 对外 API 不变：game.ts 原样 `export {...} from "./portrait"`，组件与测试的 import 路径不动。
import { assetFileUrl, assetPath, assetUrl } from "../lib/acp";
import type { PortraitState } from "./types";

/** 名字归一化：去掉「」『』包夹与首尾空白（槽位名与引擎标记名对齐） */
export function normName(x: string): string {
  return x.replace(/[「」『』]/g, "").trim();
}

/**
 * 【立绘】表情切换事件 → 下一个立绘状态（纯函数，供单测）。
 * 当前立绘就是该角色时只换 variant/url（保留 baseUrl）；否则新建槽位（本剧本的基础立绘兜底）。
 * @param {PortraitState | null} prev 当前立绘状态
 * @param {string} character 引擎指令里的角色名
 * @param {string} variant 变体名（空串=回基础立绘）
 * @param {string} preset 当前剧本 id（差分图与兜底图都按它构造，路径走 acp.assetPath；空串=无剧本上下文）
 * @returns {PortraitState} 新立绘状态
 */
export function nextPortraitOnExpression(
  prev: PortraitState | null,
  character: string,
  variant: string,
  preset: string,
): PortraitState {
  const who = normName(character);
  const keep = prev && normName(prev.name) === who ? prev : null;
  const baseUrl = keep ? keep.baseUrl : assetUrl("portrait", who, preset);
  // 无剧本上下文（preset 空）时 assetPath 回空串：宁可用基础图，也不构造 presets//assets/… 这种坏路径
  const variantPath = variant ? assetPath("立绘", `${who}-${variant}`, preset) : "";
  return { name: keep ? keep.name : character, variant, url: variantPath ? assetFileUrl(variantPath) : baseUrl, baseUrl };
}

/**
 * 立绘图 404（差分素材尚未生成）时的回退 URL（纯函数，供单测）。
 * @param {PortraitState} p 当前立绘状态
 * @returns {string} 回退目标（基础立绘）；url 已是基础时原样返回
 */
export function fallbackPortraitUrl(p: PortraitState): string {
  return p.baseUrl;
}
