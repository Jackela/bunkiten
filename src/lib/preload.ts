// 立绘差分预热（v1.8）：让【立绘】换差分时不再「空白一下才画出来」。
// 设计要点（与 lib/audio.ts 的索引记账同款）：
// - 「角色 → 差分文件」只认 /api/assets 清单（协议行不携带差分文件是否存在），**每个剧本只拉一次**：
//   模块级 Map 存 promise（在途与完成同一条），并发的多次调用天然去重；失败静默且不重拉——
//   没有清单只意味着「不预热」（剧本没有 assets 目录、接口不可用、请求失败一视同仁），
//   立绘照旧按 marker URL 加载并自带两级 404 回退（PortraitLayer），演出永不被打断。
//   为什么失败也记账：拉清单可能对每个角色变化发生，失败路径每回合重试一遍纯属噪音。
// - 预热 = `new Image()` 挂 src（浏览器缓存 + 解码就绪），**永不 await**：调用方在渲染路径上
//   fire-and-forget；参考对象留一份（GC 掉在途解码的属性会让预载白做），并记 URL 集合避免重复预载。
// - 匹配规则与制作中屏的缓存清点同源（parser.assetNameMatches 的空白归一 + 互为包含），
//   但**刻意忽略 variant 轴**：这里要的是「这个角色的所有差分」，不是某一版差分。
import { assetFileUrl, fetchAssets, type AssetEntry } from "./acp";
import { assetNameMatches } from "./parser";

/** 同时保留引用的预载对象上限（超出丢最早的；只影响 GC，不影响已发出的请求） */
const KEEP_ALIVE_MAX = 64;

/** preset → /api/assets 清单的 promise（在途/已完成/已判定失败都在这里，见文件头） */
const assetIndex = new Map<string, Promise<AssetEntry[]>>();

/** 已经预载过的 URL（同一角色的差分被反复点名时不再重复 new Image） */
const warmed = new Set<string>();

/** 保活引用：预载中的 Image 被 GC 回收会让浏览器取消在途请求 */
const keepAlive: HTMLImageElement[] = [];

/**
 * 把一张图塞进浏览器缓存（fire-and-forget，绝不抛错、绝不 await）。
 * 无 DOM/无 Image 构造器的环境（node 单测）静默 no-op——预热永远不该让渲染路径崩。
 * @param {string} url 图片 URL（相对路径即可，浏览器按当前 origin 解析）
 */
export function preloadImage(url: string): void {
  if (!url || typeof Image !== "function" || warmed.has(url)) return;
  warmed.add(url);
  try {
    const img = new Image();
    img.src = url;
    keepAlive.push(img);
    if (keepAlive.length > KEEP_ALIVE_MAX) keepAlive.shift();
  } catch {
    /* 忽略：预载失败只影响「快不快」，不影响「画不画得出」 */
  }
}

/**
 * 清单：某个剧本的已落盘资产（每剧本一次，见文件头）。失败**吞掉**并缓存空清单。
 * @param {string} presetId 剧本 id
 * @returns {Promise<AssetEntry[]>} 清单（失败为空数组）
 */
function assetsOf(presetId: string): Promise<AssetEntry[]> {
  const hit = assetIndex.get(presetId);
  if (hit) return hit;
  const pending = fetchAssets(presetId).catch(() => [] as AssetEntry[]);
  assetIndex.set(presetId, pending);
  return pending;
}

/**
 * 预热某个角色在当前剧本下的**全部立绘**（基础 + 各差分）。
 * PortraitLayer 在显示角色变化时调用；不返回值、不阻塞渲染、失败静默。
 * @param {string} presetId 当前剧本 id（空串/无剧本上下文 = 无从查清单，直接返回）
 * @param {string} characterName 显示中的角色名（marker 里的原始名，空白由匹配规则归一）
 */
export function warmPortraitVariants(presetId: string, characterName: string): void {
  const preset = (presetId ?? "").trim();
  const who = (characterName ?? "").trim();
  if (!preset || !who) return;
  void assetsOf(preset).then((items) => {
    for (const a of items) {
      if (a.type !== "立绘" || !a.ready || !a.file) continue;
      // variant 一律按基础项比对（见文件头）：命中角色的基础图与所有差分都进缓存。
      // 比对用 parser 的规范化规则，别在这里自己写一套名字等价关系。
      if (!assetNameMatches({ name: a.name, variant: "" }, { name: who, variant: "" })) continue;
      preloadImage(assetFileUrl(a.file));
    }
  });
}
