// 文本展示的小工具（纯函数、零依赖，可直接被 node import 做单测）。

/**
 * 超长截断：长度超过 n 时保留前 n-1 个字符 + 一个省略号（省略号算在 n 之内），否则原样返回。
 * 给 SVG <text> 这类不会自动省略的地方用（剧情图节点、家谱节点）。
 * @param {string} s 原文
 * @param {number} n 上限字数（含省略号）
 * @returns {string} 截断后的文案
 */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
