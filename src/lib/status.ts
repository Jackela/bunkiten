// 引擎状态文案的玩家化映射（唯一真源）：顶栏状态簇与制作中屏的状态行共用这里，
// 免得同一句引擎口吻的话在两个屏上各翻一遍、早晚翻岔（纯映射，可直接被 node import 做单测）。

/**
 * 引擎状态文案 → 玩家侧说法（纯映射，store 里的原字符串一个字不动）。
 * 引擎口吻的词是给开发者看的：「引擎演绎中…」「撰写章节大纲…」把实现细节摊在玩家眼前，
 * 玩家只该知道故事在动、下一章在筹备。表外的状态原样透传——
 * 像「清点既有美术…」（只出现在章节制作屏）、「无法重演…」这类，硬翻只会变成似是而非的说法。
 */
const PLAYER_STATUS: Record<string, string> = {
  "连接引擎…": "连接中…",
  "引擎演绎中…": "故事展开中…",
  "撰写章节大纲…": "章节筹备中…",
  就绪: "就绪",
};

/** 出错前缀：引擎侧写「出错：X」，玩家侧读作「出错了：X」（X 原样保留，不做二次加工） */
const ERROR_PREFIX = "出错：";

/**
 * 状态行显示文案（导出供单测直接打表，不必渲染组件）。
 * @param {string} status store.status 原值
 * @returns {string} 玩家侧文案
 */
export function playerStatus(status: string): string {
  if (status.startsWith(ERROR_PREFIX)) return `出错了：${status.slice(ERROR_PREFIX.length)}`;
  return PLAYER_STATUS[status] ?? status;
}
