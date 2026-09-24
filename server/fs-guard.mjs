// 文件系统边界判定（v1.13 收口）：**路径越界守卫只有这一份**。
//
// 为什么值得单独一个模块：这条判定是**安全不变量**——`/img`·`/audio`·`/app` 三条直服与 media-mcp 的
// 落盘都靠它把「用户可控的路径」挡在允许的根之外。此前它在四个地方各写了一遍
// （media-mcp 落盘、routes 的 /app·/img·/audio），四处拷贝意味着「哪天修一处漏三处」。
// 收成纯函数之后它也有了单测的落点（tests/server.test.ts 的 withinRoot 组）。
// 零依赖（只用 node:path），不 import 任何 server 模块——谁都可以引它，不进任何环。
import path from "path";

/**
 * 目标路径是否落在某个根**之内**（不含根本身）。
 * 语义要点（照抄既有四处守卫的口径，改它就是改安全边界）：
 *   · 两侧都 `path.resolve`：调用方可能传相对路径（`../etc/passwd`），不解析就能被绕过；
 *   · 比较串是 `root + path.sep`：**必须带分隔符**——只比 `startsWith(root)` 会让 `/game-evil`
 *     被当成 `/game` 的子路径；
 *   · 根自身不算「在内」（与四处旧实现逐字一致：根目录本身不是可直服的资产）。
 * @param {string} abs 待判定的路径（可以是相对路径，函数内会 resolve）
 * @param {string} root 允许的根目录
 * @returns {boolean} 在其内为 true
 */
export function withinRoot(abs, root) {
  return path.resolve(abs).startsWith(path.resolve(root) + path.sep);
}
