// 轮询原语（tests/ 各层共用）。谓词返回值**一律 await**——把 async 谓词误传给同步版会得到
// 「Promise 恒真 → 立即通过」的假绿（tests/integration/engine-auth.test.ts 的旧注释记的就是这只坑）。
//
// 默认口径按调用方历史值给足参数（集成 harness 25ms/8s、fake 栈 100ms/30s、real 栈 400ms/90s），
// 不硬编一套「通用默认」去改各处既有预算；timeoutMs/intervalMs 由调用方显式传。
/**
 * 轮询直到谓词为真；超时抛错（label 与 detail 进错误消息，便于定位）。
 * @param {() => unknown | Promise<unknown>} predicate 未就绪返回假值（抛错视同未就绪）；返回值会被 await
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 上限（ms）
 * @param {number} [opts.intervalMs] 轮询间隔（ms）
 * @param {string} [opts.label] 失败标签
 * @param {string | (() => string)} [opts.detail] 失败消息里追加的实况（如最后一次探活看到的 HTTP 状态）
 * @returns {Promise<void>} 谓词为真时 resolve；超时 reject
 */
export function waitFor(predicate, { timeoutMs = 8000, intervalMs = 25, label = "condition", detail } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let ok = false;
      try {
        ok = Boolean(await predicate());
      } catch {
        /* 轮询期间失败视同未就绪 */
      }
      if (ok) return resolve();
      if (Date.now() > deadline) {
        const extra = typeof detail === "function" ? detail() : detail;
        return reject(new Error(`timeout waiting for ${label}${extra ? `（${extra}）` : ""}`));
      }
      setTimeout(tick, intervalMs);
    };
    void tick();
  });
}
