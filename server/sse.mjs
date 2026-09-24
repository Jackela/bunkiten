// SSE 广播（v1.13 从入口闭包拆出）：`/events` 的长连接集合与「往每个连接写一条 JSON」。
//
// 为什么值得单独一个模块：这两件事（连接集合的生命周期 + 广播格式）此前和其他七件事挤在
// `startServer` 的同一个闭包里（那个闭包 650+ 行），而它自己只有 6 行——但它的**纪律**值得读清楚：
//   · 只写 `data: <json>\n\n`（SSE 帧格式）；
//   · 收尾必须 destroy 每条连接，否则 `server.close()` 的回调永远等不到（长连接不会自己散）；
//   · 广播是**同步**的：写失败的连接不该让一个回合崩掉（由 http 层自己处理 EPIPE），这里不 try/catch
//     ——把它包起来反而会掩盖「连接已死却还在广播」这类问题。
//
// 零依赖（只用 node:http 的类型）。

/**
 * SSE 广播器的形状（路由链通过 ctx 拿到的就是它）。
 * @typedef {ReturnType<typeof createBroadcaster>} Broadcaster
 */

/**
 * 造一个 SSE 广播器。调用方（入口的 `startServer`）负责把 `addClient` 接到 `/events` 路由上。
 * @returns {{
 *   addClient: (res: import("http").ServerResponse) => void,
 *   removeClient: (res: import("http").ServerResponse) => void,
 *   broadcast: (obj: object) => void,
 *   clientCount: () => number,
 *   closeAll: () => void,
 * }}
 */
export function createBroadcaster() {
  /** @type {Set<import("http").ServerResponse>} */
  const clients = new Set();

  /**
   * 登记一条新连接。SSE 头由路由自己写（那是 HTTP 层的事），这里只管记账。
   * @param {import("http").ServerResponse} res
   */
  function addClient(res) {
    clients.add(res);
  }

  /**
   * 注销一条连接（`/events` 的 `close` 事件里调）。
   * 不注销的后果是集合只涨不落：广播会一直往已断开的连接 write（EPIPE 噪音），
   * `closeAll` 也会对着一堆死连接做无用功。
   * @param {import("http").ServerResponse} res
   */
  function removeClient(res) {
    clients.delete(res);
  }

  /**
   * 往每条连接写一帧。JSON.stringify 一次、复用给所有连接（同一回合的客户端看到同一份字节）。
   * @param {object} obj 事件载荷（含 `type`）
   */
  function broadcast(obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  /** @returns {number} 当前在册连接数（诊断/测试用） */
  function clientCount() {
    return clients.size;
  }

  /**
   * 收尾：强制断开全部长连接。
   * 为什么必须做：SSE 连接不会因为 server.close() 而自己结束——不 destroy 的话 close 回调永远不来
   * （打包态 e2e 实测：页面开着时 `app.close()` 30s 不返回，先关窗口再 close 只要 0.1s）。
   */
  function closeAll() {
    for (const res of clients) res.destroy();
    clients.clear();
  }

  return { addClient, removeClient, broadcast, clientCount, closeAll };
}
