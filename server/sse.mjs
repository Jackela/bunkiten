// SSE 广播（v1.13 从入口闭包拆出）：`/events` 的长连接集合与「往每个连接写一条 JSON」。
//
// 为什么值得单独一个模块：这两件事（连接集合的生命周期 + 广播格式）此前和其他七件事挤在
// `startServer` 的同一个闭包里（那个闭包 650+ 行），而它自己只有 6 行——但它的**纪律**值得读清楚：
//   · 只写 `id: <n>` + `data: <json>` 的帧（SSE 帧格式）；
//   · 收尾必须 destroy 每条连接并清掉它的心跳定时器，否则 `server.close()` 的回调永远等不到
//     （长连接不会自己散）；
//   · 广播是**同步**的：写失败的连接摘掉就好，不该让一个回合崩掉（v1.14 用 try/catch + 死活判定接管，
//     此前不包——「连接已死却还在广播」会变成 EPIPE 噪音，而它恰好是「断线重连没对账」这类问题的现场）。
//
// v1.14 的两条新增（docs/adr/0026 的 SSE 面）：
//   · 帧带**单调 `id:`**：断线重连的浏览器会带 Last-Event-ID，客户端据此对账（GET /api/engine/status）
//     判断「断线期间漏了什么」；对既有消费者是透明的一行（他们只读 `data:`）；
//   · 每连接一个 **20s 心跳**（`: ping` 注释帧）：中间要过代理/连接池，静默太久会被当死连接掐掉。
//     定时器随连接建、随连接关；`closeAll` 一并清（进程收尾不留活跃定时器）。
//
// 零依赖（只用 node:http 的类型）。

/**
 * 心跳间隔（v1.14）：20s 一帧注释行。`BUNKITEN_SSE_PING_MS` 是**测试旋钮**（集成用例把 20s 压到几百毫秒，
 * 否则测一次心跳要等 20 秒）；不设时就是产品口径的 20s。
 */
const HEARTBEAT_MS = Number(process.env.BUNKITEN_SSE_PING_MS) || 20000;

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
  /** @type {Map<import("http").ServerResponse, NodeJS.Timeout>} 连接 → 它的心跳定时器 */
  const clients = new Map();
  let frameId = 0; // 帧序号（单调；重连对账面）

  /**
   * 登记一条新连接并给它挂上心跳。SSE 响应头与 `retry:` 由路由自己写（那是 HTTP 层的事），
   * 这里只管记账 + 保活。
   * @param {import("http").ServerResponse} res
   */
  function addClient(res) {
    const timer = setInterval(() => {
      try {
        if (res.destroyed || res.writableEnded) {
          removeClient(res);
          return;
        }
        res.write(": ping\n\n");
      } catch {
        removeClient(res); // 写不动了：摘掉，别每 20s 撞一次 EPIPE
      }
    }, HEARTBEAT_MS);
    // 心跳不该拖住进程退出（连接自己就撑着事件循环；unref 后收尾不必等它到点）
    timer.unref?.();
    // 同一 res 重复登记（理论上不会）先清旧的，免得泄漏一个定时器
    removeClient(res);
    clients.set(res, timer);
  }

  /**
   * 注销一条连接（`/events` 的 `close` 事件与广播里的死活判定都调它）。
   * 不注销的后果是集合只涨不落：广播会一直往已断开的连接 write（EPIPE 噪音）、
   * 心跳定时器也不会停（`closeAll` 之外再没人管它）。
   * @param {import("http").ServerResponse} res
   */
  function removeClient(res) {
    const timer = clients.get(res);
    if (timer) clearInterval(timer);
    clients.delete(res);
  }

  /**
   * 往每条连接写一帧。JSON.stringify 一次、复用给所有连接（同一回合的客户端看到同一份字节）；
   * `id:` 单调递增（v1.14）。
   * @param {object} obj 事件载荷（含 `type`）
   */
  function broadcast(obj) {
    if (clients.size === 0) return;
    const frame = `id: ${++frameId}\ndata: ${JSON.stringify(obj)}\n\n`;
    // 边遍历边删（removeClient）是安全的：Map 的键迭代器按规范容忍迭代期间的删除，不会漏掉后续项
    for (const res of clients.keys()) {
      if (res.destroyed || res.writableEnded) {
        removeClient(res); // 已经断开的连接：不写、直接摘（它不会再收到任何东西）
        continue;
      }
      try {
        res.write(frame);
      } catch {
        removeClient(res); // 写失败（EPIPE/已关）：摘掉这条，别让一个回合崩在广播上
      }
    }
  }

  /** @returns {number} 当前在册连接数（诊断/测试用） */
  function clientCount() {
    return clients.size;
  }

  /**
   * 收尾：断开心跳并强制断开全部长连接。
   * 为什么必须做：SSE 连接不会因为 server.close() 而自己结束——不 destroy 的话 close 回调永远不来
   * （打包态 e2e 实测：页面开着时 `app.close()` 30s 不返回，先关窗口再 close 只要 0.1s）；
   * 心跳定时器同理得清（不然进程明明该退了，还有一个 20s 的 interval 在表上）。
   */
  function closeAll() {
    for (const [res, timer] of clients) {
      clearInterval(timer);
      res.destroy();
    }
    clients.clear();
  }

  return { addClient, removeClient, broadcast, clientCount, closeAll };
}
