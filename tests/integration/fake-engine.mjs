// 假 ACP 引擎（集成测试专用，CONTRACTS §8）。
// 扮演真 `grok agent --always-approve stdio` 在 acp-server 眼里的角色：stdio 逐行 JSON-RPC 2.0。
// 零网络、零真实引擎：固定应答握手，再按环境变量里的「脚本队列」回放 session/update 通知。
//
// 脚本格式（env FAKE_ENGINE_TURNS = JSON 数组），每个元素 = 一次 session/prompt 的回放：
//   ["正文第一段\n\n【图】立绘|薇拉|images/1.jpg\n"]                 // 数组 = ops 列表（纯字符串 = agent_message_chunk 文本）
//   "正文一段\n\n**行动**\n1. …\n"                                 // 裸字符串 = 单条文本 op（等价于只含一个字符串的数组）
//   { match:"改树", ops:["已改好。\n", { tool:"写剧情树" }, "【树】\n"] } // 对象：按 match 子串选中；ops 里
//                                                                     // {tool} 视作 tool_call（制造 seg 切换）
// ops 元素三种：string = chunk 文本；{tool:"名"} = tool_call 通知（制造 seg 切换）；
//   {error:"消息"} = 中止回放，直接回 JSON-RPC error（code -32603，message 用给定文本）——
//   供「引擎回合失败 / 再同步失败」类用例制造 server 侧 error 事件。
// 选中规则：优先「含 match 子串且尚未用过」的条目；否则按声明顺序顺次消费（队列语义）。
// session/prompt 先逐条发通知、再回 {result:{}}（与真引擎「边流式边结束」一致）。
//
// 探针（v1.10）：env FAKE_ENGINE_PROBE 指向一个 JSONL 时，本进程把「自己拿到的 env」与「握手时的 mcpServers」
// 追加进去——`start` 一条（每次被 spawn 都写，重启后就是第二条），`session` 每条 session/load|new 一条。
// 用来断言「凭据真的注进了引擎子进程」「图片自备 key 才会挂 MCP」，不必给假引擎加协议外的行为。
//
// 另有一个可选行为（env FAKE_ENGINE_SPAWN_MCP=1）：收到 mcpServers 时**像真 agent 一样把它们拉起来**
// 跑一遍 initialize → tools/list，把结果落成探针的 `mcp` 条目。这是打包态冒烟唯一能验「那条命令
// （packaged 可执行文件 + ELECTRON_RUN_AS_NODE=1 + asar 外的脚本路径）真的跑得起来」的办法——
// 只断言文件存在是不够的：v1.10 实测过「文件在、但相对 import 的兄弟不在 unpacked 树里」导致
// 子进程 ERR_MODULE_NOT_FOUND 的那种坏法。
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const probeFile = process.env.FAKE_ENGINE_PROBE || "";
const SPAWN_MCP = process.env.FAKE_ENGINE_SPAWN_MCP === "1";
if (probeFile) {
  try {
    fs.appendFileSync(
      probeFile,
      JSON.stringify({
        kind: "start",
        at: Date.now(),
        pid: process.pid,
        env: {
          GROK_MODELS_BASE_URL: process.env.GROK_MODELS_BASE_URL ?? null,
          XAI_API_KEY: process.env.XAI_API_KEY ?? null,
          GROK_DEFAULT_MODEL: process.env.GROK_DEFAULT_MODEL ?? null,
          GROK_CONFIG: process.env.GROK_CONFIG ?? null,
        },
      }) + "\n",
    );
  } catch {}
}
/** @param {object} entry 探针条目 */
function probe(entry) {
  if (!probeFile) return;
  try {
    fs.appendFileSync(probeFile, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {}
}

/** 把 ACP 的 env 数组（[{name,value}]）并进本进程的 env */
function mcpEnvOf(entry) {
  const out = { ...process.env };
  for (const kv of entry?.env ?? []) if (kv && typeof kv.name === "string") out[kv.name] = String(kv.value ?? "");
  return out;
}

/**
 * 像真 agent 那样把一个 MCP server 拉起来走一遍握手（FAKE_ENGINE_SPAWN_MCP=1 时）。
 * 结果落成探针的 `mcp` 条目：{name, command, args, ok, serverInfo?, tools?, error?}。
 * 失败不抛——探针记下 error 就够了（用例据此红/绿）。
 * @param {any} entry ACP 的 McpServerStdio 条目
 * @returns {Promise<void>}
 */
function spawnAndProbeMcp(entry) {
  return new Promise((resolve) => {
    const rec = { kind: "mcp", name: entry?.name ?? "", command: entry?.command ?? "", args: entry?.args ?? [] };
    let child;
    try {
      child = spawn(entry.command, entry.args ?? [], { env: mcpEnvOf(entry), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      probe({ ...rec, ok: false, error: `spawn 失败：${e?.message ?? e}` });
      resolve();
      return;
    }
    let stderr = "";
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      probe({ ...rec, ...extra });
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    };
    child.on("error", (e) => finish({ ok: false, error: `spawn error：${e?.message ?? e}` }));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    // 兜底：打包态里子进程起不来/不回应时别把假引擎挂住
    const t = setTimeout(() => finish({ ok: false, error: `MCP 握手超时；stderr=${stderr.slice(0, 400)}` }), 8000);
    const rl = readline.createInterface({ input: child.stdout });
    /** @type {Map<number, (m: any) => void>} */
    const waiting = new Map();
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const w = msg.id !== undefined ? waiting.get(msg.id) : undefined;
      if (w) { waiting.delete(msg.id); w(msg); }
    });
    let id = 1;
    const ask = (method, params) =>
      new Promise((res, rej) => {
        const myId = id++;
        const to = setTimeout(() => rej(new Error(`${method} 无响应${stderr ? `；stderr=${stderr.slice(0, 300)}` : ""}`)), 5000);
        waiting.set(myId, (m) => { clearTimeout(to); res(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      });
    (async () => {
      try {
        const init = await ask("initialize", { protocolVersion: "2025-11-25", clientCapabilities: {} });
        const list = await ask("tools/list", {});
        clearTimeout(t);
        finish({
          ok: !init.error && !list.error,
          serverInfo: init.result?.serverInfo ?? null,
          tools: (list.result?.tools ?? []).map((x) => x.name),
          ...(init.error || list.error ? { error: JSON.stringify(init.error ?? list.error) } : {}),
        });
      } catch (e) {
        clearTimeout(t);
        finish({ ok: false, error: `${e?.message ?? e}${stderr ? `；stderr=${stderr.slice(0, 400)}` : ""}` });
      }
    })();
  });
}

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
  // 元素三种形态：数组 = ops 列表本身；对象 = 取 .ops；**裸字符串 = 单条文本 op**。
  // 裸字符串这一支是 v1.9 补的：tests/e2e-ui/stack.ts 的 UiStackOptions.turns 声明「元素为纯文本（顺次消费）」，
  // 但这里此前把裸字符串当成「没有 ops 的对象」返回 []——那一跳静默什么都不演（无 chunk、回合空收尾），
  // 是最难查的一类假绿（scale.spec.ts 的长历史用例就撞在这上面）。声明与实现取其一，这里选收编。
  if (entry === null || entry === undefined) return [];
  if (typeof entry === "string") return [entry];
  return Array.isArray(entry) ? entry : Array.isArray(entry.ops) ? entry.ops : [];
}

// 回放一个回合：string → chunk 通知；{tool} → tool_call 通知（server 据此 seg+1）；
// {error} → 回 JSON-RPC error 并中止（返回 false，调用方不再回 result）
function playTurn(ops, id) {
  for (const op of ops) {
    if (typeof op === "string") {
      notify({ sessionUpdate: "agent_message_chunk", content: { text: op } });
    } else if (op && typeof op.error === "string") {
      fail(id, -32603, op.error);
      return false;
    } else if (op && typeof op.tool === "string") {
      notify({ sessionUpdate: "tool_call", title: op.tool, toolCall: { title: op.tool } });
    }
  }
  return true;
}

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, { protocolVersion: 1 });
    case "session/new": {
      probe({ kind: "session", method: "session/new", mcpServers: msg.params?.mcpServers ?? null });
      if (SPAWN_MCP) for (const s of msg.params?.mcpServers ?? []) void spawnAndProbeMcp(s);
      return reply(msg.id, { sessionId: "fake-session" });
    }
    case "session/load":
      // 固定拒绝：让 server 走「降级 session/new」这条确定路径（CONTRACTS §8）
      probe({ kind: "session", method: "session/load", mcpServers: msg.params?.mcpServers ?? null });
      if (SPAWN_MCP) for (const s of msg.params?.mcpServers ?? []) void spawnAndProbeMcp(s);
      return fail(msg.id, -32000, "no session");
    case "session/set_config_option":
      return reply(msg.id, {});
    case "session/prompt": {
      const text = msg.params?.prompt?.[0]?.text ?? "";
      if (playTurn(pickOps(text), msg.id)) return reply(msg.id, {});
      return; // {error} op 已回过 JSON-RPC error，不再回 result
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
