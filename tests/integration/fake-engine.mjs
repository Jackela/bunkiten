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
// 探针（v1.10）：env FAKE_ENGINE_PROBE 指向一个 JSONL 时，本进程把「自己拿到的 env 与 argv」与「握手时的
// mcpServers」追加进去——`start` 一条（每次被 spawn 都写，重启后就是第二条；argv = process.argv.slice(2)，
// 即 PATH 垫片原样透传过来的 grok CLI 参数，可断言 spawn 参数面），`session` 每条 session/load|new 一条。
// 用来断言「凭据真的注进了引擎子进程」「图片自备 key 才会挂 MCP」，不必给假引擎加协议外的行为。
//
// 另有一个可选行为（env FAKE_ENGINE_SPAWN_MCP=1）：收到 mcpServers 时**像真 agent 一样把它们拉起来**
// 跑一遍 initialize → tools/list，把结果落成探针的 `mcp` 条目。这是打包态冒烟唯一能验「那条命令
// （packaged 可执行文件 + ELECTRON_RUN_AS_NODE=1 + asar 外的脚本路径）真的跑得起来」的办法——
// 只断言文件存在是不够的：v1.10 实测过「文件在、但相对 import 的兄弟不在 unpacked 树里」导致
// 子进程 ERR_MODULE_NOT_FOUND 的那种坏法。
//
// 另一个可选行为（env FAKE_ENGINE_CALL_MCP=1，隐含 FAKE_ENGINE_SPAWN_MCP=1）：**mock 出图链路**——
// 在已拉起 MCP 之后，收到含「美术：重绘」的 prompt 时真的对那条 MCP 连接发 `tools/call`，
// 工具名用 catalog 全名 `bunkiten-media__generate_image`（真源 = server/media-mcp.mjs 的
// MEDIA_TOOL_CATALOG_NAME；真引擎经 use_tool 用的就是它），参数按指令里的类型/名推出
// `{prompt, kind, name, outRelPath}`（outRelPath = presets/<当前剧本 id>/assets/<类型>-<名>.jpg，
// 封面 presets/<id>/cover.jpg）。请求与结果落一枚探针 `mcp-call` 条目；工具回 ok 时**补发一条脚本化的
// 【图】协议行**（agent_message_chunk 通知，与本文件既有脚本化方式同款），让 app 侧按正常回合收尾
//（画廊 finishRegen 要求收到匹配的 `|重绘` 标记）。剧本 id 的判定顺序见 resolveRegenTarget。
// 默认（不设该 env）一切行为与从前逐字一致。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ART_KINDS } from "../../shared/protocol.mjs";
import { MEDIA_TOOL_CATALOG_NAME } from "../../server/media-mcp.mjs";

const probeFile = process.env.FAKE_ENGINE_PROBE || "";
// FAKE_ENGINE_CALL_MCP=1：把「美术：重绘」回合真的走一遍 MCP tools/call（mock 出图链路）。
// 它隐含 FAKE_ENGINE_SPAWN_MCP：没拉起 MCP 就无从 tools/call，所以两者取或（默认两个都不设时行为一字不变）。
const CALL_MCP = process.env.FAKE_ENGINE_CALL_MCP === "1";
const SPAWN_MCP = process.env.FAKE_ENGINE_SPAWN_MCP === "1" || CALL_MCP;
/** 出图工具在引擎 catalog 里的全名（真源 = server/media-mcp.mjs 的 MEDIA_TOOL_CATALOG_NAME，别抄第二份字面量） */
const MCP_TOOL_NAME = MEDIA_TOOL_CATALOG_NAME;
/** 「美术：重绘 <类型> <名>」（SKILL【素材重绘】）；类型段取 shared 真源 ART_KINDS，不抄第二份 */
const REGEN_RE = new RegExp(`美术：重绘\\s+(${ART_KINDS.join("|")})\\s+([^\\n]+)`);
if (probeFile) {
  try {
    fs.appendFileSync(
      probeFile,
      JSON.stringify({
        kind: "start",
        at: Date.now(),
        pid: process.pid,
        // 垫片（bin/grok）用 `exec node fake-engine.mjs "$@"` 原样透传，故 slice(2) = acp.mjs spawn 的 grok 参数
        argv: process.argv.slice(2),
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

/** @type {null | {request: (method: string, params?: object, timeoutMs?: number) => Promise<any>, kill: () => void}} */
let persistentMcp = null; // CALL_MCP 时保留的 MCP 长连接（握手成功后才有值）
/** MCP 握手完成的 promise（session/new 里起，handleRegenTurn await 它，避免抢在握手前 tools/call） */
let mcpReady = Promise.resolve();
let sessionCwd = ""; // 会话 cwd（session/new|load 的 params.cwd）= 引擎的 GAME_ROOT；推出 outRelPath 用它

/**
 * 建一条到 MCP server 的 stdio 长连接（JSON-RPC 逐行）：把 ACP 的 env 数组并进本进程 env 后 spawn，
 * 逐行解析 stdout 的响应。握手与（CALL_MCP 时的）后续 tools/call 都走这里。
 * @param {any} entry ACP 的 McpServerStdio 条目
 * @returns {{child: import("node:child_process").ChildProcess, request: (method: string, params?: object, timeoutMs?: number) => Promise<any>, stderr: () => string, kill: () => void}}
 */
function openMcp(entry) {
  const child = spawn(entry.command, entry.args ?? [], { env: mcpEnvOf(entry), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
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
  const request = (method, params, timeoutMs = 5000) =>
    new Promise((res, rej) => {
      const myId = id++;
      const to = setTimeout(() => rej(new Error(`${method} 无响应${stderr ? `；stderr=${stderr.slice(0, 300)}` : ""}`)), timeoutMs);
      waiting.set(myId, (m) => { clearTimeout(to); res(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  return {
    child,
    request,
    stderr: () => stderr,
    kill: () => { try { child.kill("SIGKILL"); } catch {} },
  };
}

/**
 * 像真 agent 那样把一个 MCP server 拉起来走一遍握手（FAKE_ENGINE_SPAWN_MCP=1 时）。
 * 结果落成探针的 `mcp` 条目：{name, command, args, ok, serverInfo?, tools?, error?}。
 * 失败不抛——探针记下 error 就够了（用例据此红/绿）。
 * CALL_MCP=1 且握手成功时**不 kill**，把连接留在 persistentMcp 给后续 tools/call（<-- mock 出图链路）。
 * @param {any} entry ACP 的 McpServerStdio 条目
 * @returns {Promise<void>}
 */
function spawnAndProbeMcp(entry) {
  return new Promise((resolve) => {
    const rec = { kind: "mcp", name: entry?.name ?? "", command: entry?.command ?? "", args: entry?.args ?? [] };
    let h;
    try {
      h = openMcp(entry);
    } catch (e) {
      probe({ ...rec, ok: false, error: `spawn 失败：${e?.message ?? e}` });
      resolve();
      return;
    }
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      // CALL_MCP 且握手成功：保留连接（别 kill）——后续「美术：重绘」回合要在它上面发 tools/call。
      // 会话可能先 session/load（被拒）再 session/new，两条都 spawn 一次 MCP：换手时把上一条关掉，别留泄漏。
      // 其余一律 kill，与旧行为逐字一致。
      if (CALL_MCP && extra.ok === true) {
        try { persistentMcp?.kill(); } catch {}
        persistentMcp = h;
      } else h.kill();
      probe({ ...rec, ...extra });
      resolve();
    };
    h.child.on("error", (e) => finish({ ok: false, error: `spawn error：${e?.message ?? e}` }));
    // 兜底：打包态里子进程起不来/不回应时别把假引擎挂住
    const t = setTimeout(() => finish({ ok: false, error: `MCP 握手超时；stderr=${h.stderr().slice(0, 400)}` }), 8000);
    (async () => {
      try {
        const init = await h.request("initialize", { protocolVersion: "2025-11-25", clientCapabilities: {} });
        const list = await h.request("tools/list", {});
        clearTimeout(t);
        finish({
          ok: !init.error && !list.error,
          serverInfo: init.result?.serverInfo ?? null,
          tools: (list.result?.tools ?? []).map((x) => x.name),
          ...(init.error || list.error ? { error: JSON.stringify(init.error ?? list.error) } : {}),
        });
      } catch (e) {
        clearTimeout(t);
        finish({ ok: false, error: `${e?.message ?? e}${h.stderr() ? `；stderr=${h.stderr().slice(0, 400)}` : ""}` });
      }
    })();
  });
}

/** @param {string} s JSON 文本 @returns {any|null} 解析失败回 null（探针不该因坏回包崩） */
function safeParse(s) {
  try { return JSON.parse(String(s)); } catch { return null; }
}

/** @param {string} text 提示词原文 @returns {{kind: string, name: string}|null} 「美术：重绘 …」里的类型/名 */
function parseRegenPrompt(text) {
  const m = REGEN_RE.exec(String(text || ""));
  if (!m) return null;
  const name = m[2].trim();
  return name ? { kind: m[1], name } : null;
}

/** @param {string} gameRoot 引擎 GAME_ROOT @param {string} id 剧本 id @returns {string} preset.md 的 title（读不到回空串） */
function readPresetTitle(gameRoot, id) {
  try {
    const md = fs.readFileSync(path.join(gameRoot, "presets", id, "preset.md"), "utf8");
    const m = /^title:\s*(.+)$/m.exec(md);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

/**
 * 从重绘指令推出落盘目标（mock 出图用）：**当前剧本 id** 的判定顺序——
 *   ① 封面指令的末段就是剧本 id（`美术：重绘 封面 <id>`）；
 *   ② 该剧本已有同类型同名的资产（重绘的目标按定义已经存在）——扫 `presets/<id>/assets/<类型>-<名>.jpg`；
 *   ③ 兜底取 `presets/` 下排序第一个目录（用例里通常只有/先有它）。
 * 资产文件名的口径与 server 侧一致（`<类型>-<名>.jpg`，差分名已在 name 里）。
 * @param {string} gameRoot 引擎 GAME_ROOT（= 会话 cwd）
 * @param {string} kind 类型（立绘/背景/封面）
 * @param {string} name 名（立绘=角色名[-差分]；背景=地点名；封面=剧本 id）
 * @returns {{id: string, outRelPath: string, markerName: string}|null} 解析不出剧本 id 时 null
 */
function resolveRegenTarget(gameRoot, kind, name) {
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(path.join(gameRoot, "presets"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {}
  if (kind === "封面") {
    const id = /^[A-Za-z0-9_-]+$/.test(name) ? name : "";
    if (!id) return null;
    return { id, outRelPath: `presets/${id}/cover.jpg`, markerName: readPresetTitle(gameRoot, id) || id };
  }
  const file = `${kind}-${name}.jpg`;
  let id = dirs.find((d) => fs.existsSync(path.join(gameRoot, "presets", d, "assets", file)));
  if (!id) id = dirs[0];
  if (!id) return null;
  return { id, outRelPath: `presets/${id}/assets/${file}`, markerName: name };
}

/**
 * 「美术：重绘」回合的 mock 出图（FAKE_ENGINE_CALL_MCP=1）：真的经 MCP 连接发 tools/call（catalog 全名），
 * 请求/结果落探针 `mcp-call` 条目，工具回 ok 时补发一条【图】标记行让 app 侧收尾一致。
 * 与既有脚本化的接缝：只吃**显式 match 了本 prompt** 的脚本条目（不消费顺次队列，免得误吃给后续回合准备的条目）。
 * @param {string} text session/prompt 的提示词原文
 * @param {number} id  JSON-RPC 请求 id
 * @returns {Promise<void>}
 */
async function handleRegenTurn(text, id) {
  // 显式 match 本回合的脚本先演（与本文件既有脚本化方式一致）；它若含 {error} 已回 error，不再回 result
  const ops = pickMatchedOps(text);
  if (ops && !playTurn(ops, id)) return;
  await mcpReady; // 别抢在 MCP 握手前 tools/call
  const info = parseRegenPrompt(text);
  const gameRoot = sessionCwd || process.env.GROK_GAME_ROOT || "";
  /** @type {any} */ let args = null;
  /** @type {any} */ let target = null;
  /** @type {any} */ let payload = null;
  /** @type {string|null} */ let error = null;
  try {
    if (!info) throw new Error("无法从指令解析出类型/名");
    target = resolveRegenTarget(gameRoot, info.kind, info.name);
    if (!target) throw new Error("无法解析出剧本 id（GAME_ROOT/presets 为空？）");
    if (!persistentMcp) throw new Error("没有可用的 MCP 连接（需 FAKE_ENGINE_SPAWN_MCP=1）");
    args = { prompt: `mock regen: ${info.kind} ${info.name}`, kind: info.kind, name: info.name, outRelPath: target.outRelPath };
    const r = await persistentMcp.request("tools/call", { name: MCP_TOOL_NAME, arguments: args }, 20000);
    if (r?.error) throw new Error(JSON.stringify(r.error));
    payload = safeParse(r?.result?.content?.[0]?.text);
  } catch (e) {
    error = e?.message ?? String(e);
  }
  probe({ kind: "mcp-call", tool: MCP_TOOL_NAME, args, ok: payload?.ok === true, result: payload, error });
  // 工具成功才补【图】协议行（失败镜像真引擎的静默跳过：不发标记，app 侧自然收尾到「未确认」）
  if (payload?.ok === true && info && target) {
    notify({ sessionUpdate: "agent_message_chunk", content: { text: `【图】${info.kind}|${target.markerName}|${target.outRelPath}|重绘\n` } });
  }
  reply(id, {});
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

// 只认「显式 match 本 prompt」的脚本条目（match 命中的那一支，不消费顺次队列）——
// CALL_MCP 的重绘回合用它：脚本若写了 `{match:"美术：重绘", ops:[…]}` 就先演，否则交回 null（不误吃顺次条目）。
// 返回 null = 没有命中（与「命中但 ops 为空」的 [] 区分开）。
function pickMatchedOps(promptText) {
  for (let i = 0; i < script.length; i++) {
    if (used.has(i)) continue;
    const entry = script[i];
    if (!entry || Array.isArray(entry) || typeof entry === "string") continue;
    if (typeof entry.match === "string" && promptText.includes(entry.match)) {
      used.add(i);
      return Array.isArray(entry.ops) ? entry.ops : [];
    }
  }
  return null;
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
      sessionCwd = msg.params?.cwd ?? sessionCwd; // 会话 cwd = 引擎 GAME_ROOT：推 outRelPath 时用它
      probe({ kind: "session", method: "session/new", mcpServers: msg.params?.mcpServers ?? null });
      if (SPAWN_MCP) for (const s of msg.params?.mcpServers ?? []) mcpReady = spawnAndProbeMcp(s);
      return reply(msg.id, { sessionId: "fake-session" });
    }
    case "session/load":
      // 固定拒绝：让 server 走「降级 session/new」这条确定路径（CONTRACTS §8）
      sessionCwd = msg.params?.cwd ?? sessionCwd;
      probe({ kind: "session", method: "session/load", mcpServers: msg.params?.mcpServers ?? null });
      if (SPAWN_MCP) for (const s of msg.params?.mcpServers ?? []) mcpReady = spawnAndProbeMcp(s);
      return fail(msg.id, -32000, "no session");
    case "session/set_config_option":
      return reply(msg.id, {});
    case "session/prompt": {
      const text = msg.params?.prompt?.[0]?.text ?? "";
      // mock 出图链路（FAKE_ENGINE_CALL_MCP=1）：含「美术：重绘」的回合走真实 tools/call（异步，独立收尾）。
      // .catch 是最后兜底：万一它异步抛（正常路径不会），也要保证 session/prompt 一定有应答，别把回合挂死。
      if (CALL_MCP && text.includes("美术：重绘")) {
        handleRegenTurn(text, msg.id).catch(() => {
          try { reply(msg.id, {}); } catch {}
        });
        return;
      }
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
// 收尾：CALL_MCP 时保留的 MCP 长连接别留成孤儿（本进程退出时一并杀掉）
process.on("exit", () => {
  try {
    persistentMcp?.kill();
  } catch {
    /* 已经退了 */
  }
});
// 父进程（acp-server）退出 → stdin 关闭 → 假引擎跟着退，避免留孤儿进程
rl.on("close", () => process.exit(0));
