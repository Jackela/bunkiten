// 假 ACP 引擎（集成测试专用，CONTRACTS §8）。
// 扮演真 `grok agent --always-approve stdio` 在 acp-server 眼里的角色：stdio 逐行 JSON-RPC 2.0。
// 零网络、零真实引擎：固定应答握手，再按环境变量里的「脚本队列」回放 session/update 通知。
//
// 脚本格式（env FAKE_ENGINE_TURNS = JSON 数组），每个元素 = 一次 session/prompt 的回放：
//   ["正文第一段\n\n【图】立绘|薇拉|images/1.jpg\n"]                 // 纯字符串 = agent_message_chunk 文本
//   { match:"改树", ops:["已改好。\n", { tool:"写剧情树" }, "【树】\n"] } // 对象：按 match 子串选中；ops 里
//                                                                     // {tool} 视作 tool_call（制造 seg 切换）
// 选中规则：优先「含 match 子串且尚未用过」的条目；否则按声明顺序顺次消费（队列语义）。
// session/prompt 先逐条发通知、再回 {result:{}}（与真引擎「边流式边结束」一致）。
import readline from "node:readline";

const script = (() => {
  try {
    const raw = JSON.parse(process.env.FAKE_ENGINE_TURNS || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
})();

const used = new Set(); // 已消费的条目下标（match 命中与顺次消费共用，保证不重复）
let cursor = 0; // 顺次消费的游标

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { update } });

// 选一条脚本（match 优先，否则顺次）；返回它的 ops 数组
function pickOps(promptText) {
  for (let i = 0; i < script.length; i++) {
    if (used.has(i)) continue;
    const entry = script[i];
    const match = entry && !Array.isArray(entry) ? entry.match : undefined;
    if (typeof match === "string" && promptText.includes(match)) {
      used.add(i);
      return Array.isArray(entry.ops) ? entry.ops : [];
    }
  }
  while (cursor < script.length && used.has(cursor)) cursor++;
  const entry = cursor < script.length ? script[cursor] : null;
  if (entry) used.add(cursor);
  cursor++;
  return entry ? (Array.isArray(entry) ? entry : Array.isArray(entry.ops) ? entry.ops : []) : [];
}

// 回放一个回合：string → chunk 通知；{tool} → tool_call 通知（server 据此 seg+1）
function playTurn(ops) {
  for (const op of ops) {
    if (typeof op === "string") {
      notify({ sessionUpdate: "agent_message_chunk", content: { text: op } });
    } else if (op && typeof op.tool === "string") {
      notify({ sessionUpdate: "tool_call", title: op.tool, toolCall: { title: op.tool } });
    }
  }
}

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, { protocolVersion: 1 });
    case "session/new":
      return reply(msg.id, { sessionId: "fake-session" });
    case "session/load":
      // 固定拒绝：让 server 走「降级 session/new」这条确定路径（CONTRACTS §8）
      return fail(msg.id, -32000, "no session");
    case "session/set_config_option":
      return reply(msg.id, {});
    case "session/prompt": {
      const text = msg.params?.prompt?.[0]?.text ?? "";
      playTurn(pickOps(text));
      return reply(msg.id, {});
    }
    default:
      return reply(msg.id, {}); // 宽容：未知带 id 请求一律回空结果
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || !msg.method) return; // 只应答 server 的请求，忽略其余
  try {
    handle(msg);
  } catch {
    /* 假引擎不因单条消息崩掉 */
  }
});
// 父进程（acp-server）退出 → stdin 关闭 → 假引擎跟着退，避免留孤儿进程
rl.on("close", () => process.exit(0));
