// 立绘相关的纯函数（v1.6 slice 拆分抽出）：无状态、不依赖 set/get，单测直接调。
// 对外 API 不变：game.ts 原样 `export {...} from "./portrait"`，组件与测试的 import 路径不动。
// v1.9 同屏多立绘：单槽（PortraitState | null）→ 队列（PortraitState[]，出场顺序，末位=发言者），
// 上限 MAX_STAGE——applyExpression 是唯一的入队口（变异与淘汰都在这里，组件/store 侧不再自己拼数组）。
import { assetFileUrl, assetPath, assetUrl } from "../lib/acp";
import type { PortraitState } from "./types";

/** 同屏立绘上限（VN 通行做法：发言者 + 至多一位留场者；第三位上屏即淘汰最早出场的那位） */
export const MAX_STAGE = 2;

/** 名字归一化：去掉「」『』包夹与首尾空白（槽位名与引擎标记名对齐） */
export function normName(x: string): string {
  return x.replace(/[「」『』]/g, "").trim();
}

/**
 * 队列里的同名槽位（按 {@link normName} 归一化比对）：换差分前先取它，才能把既有 baseUrl 带过去
 * （差分 404 时回退的是**这个角色**的基础图，不是按名字现拼的兜底路径）。
 * @param {readonly PortraitState[]} cast 当前立绘队列
 * @param {string} name 角色名（引擎标记/事件里的原文，可带「」）
 * @returns {PortraitState | null} 命中槽位；不在队列里为 null
 */
export function castMember(cast: readonly PortraitState[], name: string): PortraitState | null {
  const who = normName(name);
  return cast.find((p) => normName(p.name) === who) ?? null;
}

/**
 * 把一个新的立绘状态并进队列（纯函数，供单测）：**同名者原地更新并移到队尾**（成为发言者），
 * 新角色追加到队尾，超过 {@link MAX_STAGE} 时从**队首**淘汰——最近发言的两位留场，位序即出场/发言新旧。
 * 队列顺序 = 渲染顺序（左到右），所以淘汰/移动都只改数组，组件不持有任何位序状态。
 * @param {readonly PortraitState[]} cast 当前立绘队列
 * @param {PortraitState} next 该角色的新状态（由 {@link nextPortraitOnExpression} 构造）
 * @returns {PortraitState[]} 新队列（新数组；未命中上限时就是「其余 + 新项」）
 */
export function applyExpression(cast: readonly PortraitState[], next: PortraitState): PortraitState[] {
  const who = normName(next.name);
  const out = [...cast.filter((p) => normName(p.name) !== who), next];
  return out.length > MAX_STAGE ? out.slice(out.length - MAX_STAGE) : out;
}

/**
 * 当前发言者 = 队列末位（名牌归属与「亮/暗」都由它判定）。
 * @param {readonly PortraitState[]} cast 当前立绘队列
 * @returns {PortraitState | null} 末位槽位；队列为空为 null
 */
export function speakerOf(cast: readonly PortraitState[]): PortraitState | null {
  return cast.length > 0 ? cast[cast.length - 1] : null;
}

/**
 * 【立绘】表情切换事件 → 该角色的下一个立绘状态（纯函数，供单测）。
 * `prev` 传**该角色在队列里的既有槽位**（castMember）：同角色只换 variant/url（保留 baseUrl），
 * 否则按本剧本的基础立绘起步。入队/淘汰交给 {@link applyExpression}。
 * @param {PortraitState | null} prev 该角色的既有槽位（不在场上给 null）
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
  return {
    name: keep ? keep.name : character,
    variant,
    url: variantPath ? assetFileUrl(variantPath) : baseUrl,
    baseUrl,
  };
}

/**
 * 立绘图 404（差分素材尚未生成）时的回退 URL（纯函数，供单测）。
 * @param {PortraitState} p 当前立绘状态
 * @returns {string} 回退目标（基础立绘）；url 已是基础时原样返回
 */
export function fallbackPortraitUrl(p: PortraitState): string {
  return p.baseUrl;
}
