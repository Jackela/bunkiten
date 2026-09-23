// 登录 / 登出端点的集成覆盖（v1.11 收尾，docs/adr/0022）：GUI 那两个按钮在服务端的落地。
// 链路：POST /api/engine/login → 服务端 spawn 玩家自己的 CLI（垫片扮演）→ CLI 写 `~/.<引擎>/auth.json`
// → /api/auth 的 loggedIn 翻真；登出反向，并把游戏侧的 codex 登录副本一并清掉。
// 每条都对着「改坏哪一处会红」：
//   · 登录/登出命令面（cmd/args/env/unset）→ server/engines.mjs 描述符的 authCmd；
//   · 端点与回执形状 → server/routes.mjs 的两个分支；
//   · codex 副本的清理 → server/engine-auth.mjs 的 runLogout；
//   · canLogin → 描述符的 authAvailable（grok 看 PATH、codex 看随包 CLI 在不在）。
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startStack } from "./harness.mjs";

/** @type {Array<{stop: () => Promise<void>}>} 本文件起过的栈（afterEach 统一收尾） */
const started = [];
afterEach(async () => {
  while (started.length) await started.pop().stop();
});

/** @param {object} [opts] 见 harness.startStack @returns {Promise<any>} */
async function stack(opts = {}) {
  const s = await startStack(opts);
  started.push(s);
  return s;
}

/**
 * 轮询直到异步谓词为真（**不用 harness 的 waitFor**：那个谓词是同步口径，返回 Promise 会被当成真）。
 * @param {() => Promise<boolean>} pred 异步谓词
 * @param {{timeout?: number, label?: string}} [opts]
 */
async function until(pred, { timeout = 15000, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`超时：${label}`);
}

const grokAuthFile = (/** @type {any} */ s) => path.join(s.home, ".grok", "auth.json");
const codexAuthFile = (/** @type {any} */ s) => path.join(s.home, ".codex", "auth.json");
/** 预置一份 engine=codex 的凭据文档（对话沿用终端登录；出图不用） */
const codexCreds = () => ({
  version: 1,
  engine: "codex",
  llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
  image: { mode: "off", provider: "custom", baseUrl: "", apiKey: "", model: "", size: "" },
});

describe("POST /api/engine/login|logout：把玩家自己的 CLI 登录流程拉起来 / 清掉", () => {
  it("grok：未登录 → 点登录（垫片写 ~/.grok/auth.json）→ /api/auth 翻真 → 登出后又翻假且文件被删", async () => {
    const s = await stack({ auth: "missing" });
    expect((await s.getJSON("/api/auth")).body).toMatchObject({ loggedIn: false, canLogin: true });

    const login = await s.postJSON("/api/engine/login", {});
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    // 回执是「已拉起」而不是「已登录」：真正的判据是玩家 home 里的登录产物出现（客户端据此轮询）
    await until(async () => (await s.getJSON("/api/auth")).body.loggedIn === true, { label: "grok 登录态出现" });
    expect(fs.existsSync(grokAuthFile(s)), "垫片没把登录产物写进玩家 home").toBe(true);

    const logout = await s.postJSON("/api/engine/logout", {});
    expect(logout.status).toBe(200);
    expect(logout.body.ok).toBe(true);
    expect(fs.existsSync(grokAuthFile(s)), "登出后玩家 home 里还留着登录产物").toBe(false);
    expect((await s.getJSON("/api/auth")).body.loggedIn).toBe(false);
  });

  it("codex：登录写玩家 ~/.codex/auth.json；重启引擎把副本同步进游戏 home；登出把两份都清掉", async () => {
    const s = await stack({ engine: "codex", credentials: codexCreds(), codexAuth: "missing" });
    expect((await s.getJSON("/api/auth")).body).toMatchObject({ loggedIn: false, engine: "codex", canLogin: true });

    const login = await s.postJSON("/api/engine/login", {});
    expect(login.body.ok).toBe(true);
    await until(async () => (await s.getJSON("/api/auth")).body.loggedIn === true, { label: "codex 登录态出现" });
    expect(fs.existsSync(codexAuthFile(s))).toBe(true);
    // 登录产物落在**玩家自己的** home 里（不是游戏那份 ~/.bunkiten/codex）
    expect(fs.existsSync(path.join(s.codexHome, "auth.json"))).toBe(false);

    // 重启引擎 = 重新 spawn = prepare 同步副本（「沿用终端登录」在 codex 侧就是这一步）
    expect((await s.postJSON("/api/engine/restart", {})).status).toBe(200);
    expect(fs.existsSync(path.join(s.codexHome, "auth.json")), "重启后副本没同步进游戏 home").toBe(true);

    const logout = await s.postJSON("/api/engine/logout", {});
    expect(logout.body.ok).toBe(true);
    expect(fs.existsSync(codexAuthFile(s))).toBe(false);
    expect(fs.existsSync(path.join(s.codexHome, "auth.json")), "登出后游戏侧副本还留着（会变成「启动屏说未登录、引擎却能跑」）").toBe(false);
  });

  it("canLogin 是布尔、按当前引擎算（登录入口在不在，GUI 据此禁用按钮）", async () => {
    const grok = await stack({ auth: "missing" });
    expect(typeof (await grok.getJSON("/api/auth")).body.canLogin).toBe("boolean");
    const codex = await stack({ credentials: codexCreds(), codexAuth: "missing" });
    expect(typeof (await codex.getJSON("/api/auth")).body.canLogin).toBe("boolean");
  });
});
