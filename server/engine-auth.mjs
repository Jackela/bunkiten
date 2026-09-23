// 登录 / 登出（v1.11 收尾，docs/adr/0022）：GUI 的「登录 / 登出」按钮把**玩家自己**的 CLI 登录流程跑起来。
// 权责边界与「沿用终端登录」同款：游戏只是把 CLI 叫起来、看结果，不碰凭据、不存任何东西——
//   · 登录产物落在玩家自己的 home（grok：`~/.grok/auth.json`；codex：`~/.codex/auth.json`），
//     游戏侧唯一动作是 prepare() 在 spawn 时按需同步一份进 CODEX_HOME（那只为隔离，见 ADR）；
//   · 登出是**全局**的：会把玩家终端里那份一起清掉，所以 GUI 必须先确认再点（服务端只负责执行）。
//
// 形态：登录是长事务（开浏览器、等回调，可能几分钟），HTTP 端点不能挂在那儿——
// startLogin 只负责把它拉起来并回执，GUI 靠轮询 `/api/auth`（看文件在不在）等结果；
// 同一个引擎重复点 = 杀掉上一个再起一个（卡住的浏览器流程要能重来）。登出很快，runLogout 直接等它。
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { codexHome } from "./engines.mjs";

/** 每个引擎至多一个在途登录（重复点 = 换一个） @type {Map<string, import("child_process").ChildProcess>} */
const pending = new Map();
/** 最近一次登录进程的输出尾巴（诊断/提示用；上限 40 行，不含任何凭据） @type {string[]} */
let lastOutput = [];

/** @param {string} line 追加一行输出（裁到 40 行、单行裁到 300 字） */
function pushOutput(line) {
  lastOutput.push(String(line).slice(0, 300));
  if (lastOutput.length > 40) lastOutput.splice(0, lastOutput.length - 40);
}

/** @returns {string[]} 最近一次登录的输出尾巴（只读浅拷贝） */
export function lastLoginOutput() {
  return [...lastOutput];
}

/**
 * 起一个登录进程（GUI 的「登录」按钮）。
 * @param {{engine: import("./engines.mjs").EngineDescriptor, home: string}} ctx 当前引擎描述符与用户主目录
 * @returns {Promise<{ok: boolean, error?: string, hint?: string}>} 回执；`hint` 是 CLI 头几行输出（如手填 URL 的提示）
 */
export async function startLogin({ engine, home }) {
  const spec = engine.authCmd("login", { home });
  if (!spec) return { ok: false, error: "这个引擎没有可用的登录入口（随包运行时缺失？）" };
  // 上一个还没退就先杀掉：卡住的浏览器回调不该挡住第二次点击
  const prev = pending.get(engine.id);
  if (prev) {
    try { prev.kill("SIGKILL"); } catch {}
    pending.delete(engine.id);
  }
  lastOutput = [];
  const env = { ...process.env, ...spec.env };
  for (const key of spec.unset ?? []) delete env[key];
  /** @type {import("child_process").ChildProcess} */
  let proc;
  try {
    proc = spawn(spec.cmd, spec.args, { env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { ok: false, error: `没能启动登录：${/** @type {Error} */ (e).message}` };
  }
  proc.stdout?.on("data", (d) => String(d).split("\n").forEach((l) => l.trim() && pushOutput(l)));
  proc.stderr?.on("data", (d) => String(d).split("\n").forEach((l) => l.trim() && pushOutput(l)));
  proc.on("error", (e) => pushOutput(`启动失败：${e.message}`));
  proc.on("exit", (code) => {
    pushOutput(`登录进程退出（code ${code}）`);
    if (pending.get(engine.id) === proc) pending.delete(engine.id);
  });
  pending.set(engine.id, proc);

  // 等一小会儿把首行输出带回去：浏览器没弹出时玩家至少能看到 CLI 打的手动链接（降低认知负荷）
  const t0 = Date.now();
  while (Date.now() - t0 < 1200 && lastOutput.length === 0) await new Promise((r) => setTimeout(r, 100));
  return { ok: true, ...(lastOutput.length > 0 ? { hint: lastOutput[0] } : {}) };
}

/**
 * 登出（GUI 的「登出」按钮；**全局动作**——终端里那份也会没，GUI 已先确认）。
 * 结束后顺手清掉游戏侧的 codex 登录副本（它由 prepare 同步而来，登出后不该留着）。
 * @param {{engine: import("./engines.mjs").EngineDescriptor, home: string}} ctx 当前引擎描述符与用户主目录
 * @returns {Promise<{ok: boolean, error?: string}>} 执行结果（失败原因已脱敏/截断，来自 CLI 输出尾巴）
 */
export async function runLogout({ engine, home }) {
  const spec = engine.authCmd("logout", { home });
  if (!spec) return { ok: false, error: "这个引擎没有可用的登出入口" };
  const env = { ...process.env, ...spec.env };
  for (const key of spec.unset ?? []) delete env[key];
  const out = await new Promise((resolve) => {
    let text = "";
    /** @type {import("child_process").ChildProcess} */
    let proc;
    try {
      proc = spawn(spec.cmd, spec.args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, text: /** @type {Error} */ (e).message });
      return;
    }
    const cap = (/** @type {any} */ d) => { text += String(d); if (text.length > 2000) text = text.slice(-2000); };
    proc.stdout?.on("data", cap);
    proc.stderr?.on("data", cap);
    proc.on("error", (e) => resolve({ code: -1, text: e.message }));
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve({ code: -1, text: "登出超时" }); }, 20000);
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, text }); });
  });
  if (out.code !== 0) return { ok: false, error: `登出失败：${out.text.trim().split("\n").slice(-2).join(" ").slice(0, 200) || `退出码 ${out.code}`}` };
  // 游戏侧的 codex 副本：登录态已经没了，副本不该留着（下一次 spawn 的同步也会删，这里立刻做掉）
  try { fs.rmSync(path.join(codexHome(home), "auth.json"), { force: true }); } catch {}
  return { ok: true };
}

/** 在途登录进程数（诊断/测试用） @returns {number} */
export function pendingLoginCount() {
  return pending.size;
}

/** 收尾：杀掉所有在途登录进程（stopServer / 进程退出时调用；登录是长事务，不该拖着服务器不放） */
export function killPendingLogins() {
  for (const [, proc] of pending) {
    try { proc.kill("SIGKILL"); } catch {}
  }
  pending.clear();
}
