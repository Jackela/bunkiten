// 未知错误的读取口（v1.13）：`tsconfig.server.json` 打开 `useUnknownInCatchVariables` 之后，
// `catch (e)` 里的 `e` 是 `unknown`——直接 `e.message` 在类型上不成立。以前这条是**靠关掉检查**绕过去的
// （原来写 false），代价是整个 server 树的 catch 变量都不再受类型保护。
//
// 为什么不就地写 `e instanceof Error ? e.message : String(e)`：这个形状在 server 树里出现了 20 次，
// 每一处都是「日志里到底写什么」的同一个决定；收在这里，改口径只改一处。
// 零依赖（server 树不许引第三方，也不 import 其它 server 模块，免得进任何一条环）。
/**
 * 取错误的人读文本：Error → message；其余（含 throw 字符串、undefined）→ String(e)。
 * @param {unknown} e 捕获到的值（JS 允许 throw 任何东西，未必是 Error）
 * @returns {string} 可直接拼进日志 / 错误响应的文本
 */
export function errText(e) {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

/**
 * 取错误名：给「按 name 分类」的分支用（AbortError / TimeoutError / ERR_* 等）。
 * 非 Error（或匿名 Error 没有 name）时回空串——调用方按「不是那个名字」处理，不会误判。
 * @param {unknown} e 捕获到的值
 * @returns {string} `Error.name`；非 Error 时为空串
 */
export function errName(e) {
  return e instanceof Error ? e.name : "";
}
