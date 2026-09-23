// 集成 harness（CONTRACTS §7/§8）：编排「假 ACP 引擎 + 真 acp-server」，供 tests/integration/*.test.ts 复用。
// 做法：建临时目录，注入 GROK_GAME_ROOT / HOME / PORT，写一张临时 PATH 垫片 bin/grok（exec node fake-engine.mjs），
// spawn `node server/acp-server.mjs`，从子进程 stdout 解析实际监听端口、等 `grok session ready` 握手完成，
// 再连 /events 收集 SSE 事件。stop() 干净收尾：SIGTERM（server 自带清理 grok 子进程）+ 删临时目录。
//
// 扩展点（wave2 往里加音频 / 快照断言时直接用，不必改 harness 主体）：
//   · stack.root / stack.home / stack.binDir / stack.sessionImagesDir —— 临时布局的实际路径
//   · stack.putSessionImage(name, buf) —— 往会话图片目录补文件（~/.grok/sessions/<enc root>/<sid>/images/）
//   · stack.events —— 实时 SSE 事件数组；stack.waitFor(pred, {timeout,label}) 轮询断言
//   · stack.stdout() —— acp-server 全量 stdout（日志断言 / 排障）
//   · stack.fetch/getJSON/getText/getBytes/postJSON/prompt —— 打 HTTP 的薄封装
//   · env KEEP_INTEGRATION_TMP=1 —— 失败现场保留（不删 tmp，打印路径）
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_ENGINE = path.join(ROOT, "tests", "integration", "fake-engine.mjs");
const SERVER = path.join(ROOT, "server", "acp-server.mjs");
const SESSION_ID = "fake-session"; // 与 fake-engine.mjs 的 session/new 固定值一致
const KEEP_TMP = process.env.KEEP_INTEGRATION_TMP === "1"; // 失败现场保留开关（默认删）
const BOOT_TIMEOUT_MS = 20000;

// 单引号 shell 转义（垫片脚本里嵌路径用）
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// 预置剧本：frontmatter id/title + `# 主要角色`（server parseCharacters 按 `## 名` 抓取）；
// body 追加在角色小节之后的额外小节（如 `# protagonist_card`，供 UI e2e 走捏人开局）
function presetMarkdown(id, title, body = "") {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "tagline: 集成测试用剧本",
    "genre: 测试",
    "rating: 全年龄",
    "---",
    "",
    "# 主要角色",
    "",
    "## 薇拉（沉默的书记官）",
    "",
    "沉默寡言。",
    "",
    "## 沈屿（谜之少年）",
    "",
    "开朗。",
    "",
    ...(body ? [body, ""] : []),
  ].join("\n");
}

// 预置剧本元素形态：string（只给 id）或 { id, title?, body? }
const presetIdOf = (p) => (typeof p === "string" ? p : p?.id);
const presetTitleOf = (p) =>
  typeof p === "string" ? undefined : typeof p?.title === "string" ? p.title : undefined;

// 单个世界的三文件 + 返回 index 条目（w1 与追加世界共用一套生成逻辑）
function seedWorld(worldsRoot, worldId, preset, title, meta = {}) {
  const dir = path.join(worldsRoot, worldId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "state.md"), `# 剧情状态\n- preset: ${preset}\n- 场景: 教堂\n`);
  writeFileSync(path.join(dir, "summary.md"), "# 前情摘要（滚动）\n");
  writeFileSync(
    path.join(dir, "story-tree.md"),
    "# 剧情树\n## 第 1 章：起点\n- 当前进度: 节点 1-1（已走 0 轮）\n\n### 节点 1-1（门口）\n- 地点: 教堂\n- 状态: 可达\n",
  );
  return {
    worldId,
    preset,
    title,
    chapterNo: meta.chapterNo ?? 1,
    lastPlayed: meta.lastPlayed ?? 1_700_000_000_000,
    note: meta.note ?? "",
    forkedFrom: meta.forkedFrom ?? null,
  };
}

// 临时 game root 的预置数据：presets/<id>/{preset.md,assets/} + state/worlds/index.json 与 w1 三文件。
// extra 全部可选（不传 = 与历史行为逐字一致）：
//   · assets:     { presetId: [{name, bytes}] }        → 写 presets/<id>/assets/<name>
//   · audioFiles: { presetId: [{name, bytes}] }        → 写 presets/<id>/audio/<name>
//   · trees:      { worldId: "story-tree.md 全文" }     → 覆盖对应世界的树文件（须先有该世界）
//   · stateFiles: { worldId: "state.md 全文" }         → 覆盖对应世界的状态文件（须先有该世界；角色面板 e2e 用）
//   · worlds:     [{id, title?, preset?, forkedFrom?}] → 追加世界（复用 w1 三文件逻辑）
//   · snapshots:  { worldId: [{seq,at?,kind,nodeId,chapterNo,prompt?,files}] } → 写 state/worlds/<id>/history/NNNN.json
//                 （条目形状与 server writeSnapshot 的磁盘格式一致：prompt = 可重演的玩家输入，files = {state,summary,tree}）
//   · indexSchema: number        → 版本化索引的 schema 号（缺省 1 = 当前形态；2 = 未来版本，验「读到、不降级写回」）
//   · indexExtra:  object        → 版本化索引里追加的未知顶层键（验读改写保留）
//   · legacyIndexArray: boolean  → 写 v1.8 及以前的**裸数组**索引（验启动期 migrateWorldsSchema 真的升了它）
//   · auth: "ok" | "missing"     → 是否在临时 HOME 里写 ~/.grok/auth.json（缺省 "ok"；"missing" = boot 屏未登录态）
//   · credentials: object        → 写临时 HOME 的 ~/.bunkiten/credentials.json（0600；验自备 key 的注入与端点）
function seedStack(root, presets, extra = {}) {
  const {
    assets = {},
    audioFiles = {},
    trees = {},
    stateFiles = {},
    worlds = [],
    snapshots = {},
    indexSchema = 1,
    indexExtra = {},
    legacyIndexArray = false,
    auth = "ok",
  } = extra;
  mkdirSync(path.join(root, "presets"), { recursive: true });
  const worldsRoot = path.join(root, "state", "worlds");
  mkdirSync(worldsRoot, { recursive: true });
  for (const p of presets) {
    const id = presetIdOf(p);
    const dir = path.join(root, "presets", id);
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    const title = presetTitleOf(p) ?? (id === "demo" ? "示例剧本" : "对照剧本");
    writeFileSync(path.join(dir, "preset.md"), presetMarkdown(id, title, typeof p === "object" && p ? p.body : ""));
    for (const f of assets[id] ?? []) writeFileSync(path.join(dir, "assets", f.name), f.bytes);
    if (audioFiles[id]?.length) {
      const audioDir = path.join(dir, "audio");
      mkdirSync(audioDir, { recursive: true });
      for (const f of audioFiles[id]) writeFileSync(path.join(audioDir, f.name), f.bytes);
    }
  }
  // 世界线索引 + 一个 demo 世界 w1（sniffPreset 用它把 w1 → demo）+ 可选追加世界
  const index = [seedWorld(worldsRoot, "w1", "demo", "示例剧本")];
  for (const w of worlds) {
    index.push(
      seedWorld(worldsRoot, w.id, w.preset ?? "demo", w.title ?? "示例剧本", {
        forkedFrom: w.forkedFrom,
        chapterNo: w.chapterNo,
        lastPlayed: w.lastPlayed,
        note: w.note,
      }),
    );
  }
  // 索引形态（写盘那一份 = 启动时磁盘上的既有档）：
  //   缺省写当前形态 `{schema:1, worlds}`（v1.9 起 server 写出来的样子）；
  //   legacyIndexArray 写 v1.8 及以前的裸数组（启动期由 migrateWorldsSchema 一次性升上来）；
  //   indexSchema/indexExtra 造一个「未来版本」的索引（验读路径照读 + 写回不降级、未知顶层键保留）。
  const indexDoc = legacyIndexArray ? index : { schema: indexSchema, ...indexExtra, worlds: index };
  writeFileSync(path.join(worldsRoot, "index.json"), JSON.stringify(indexDoc, null, 2) + "\n");
  // 树覆盖（w1 或追加世界的 story-tree.md 换成调用方全文）
  for (const [worldId, text] of Object.entries(trees)) {
    writeFileSync(path.join(worldsRoot, worldId, "story-tree.md"), text);
  }
  // 状态文件覆盖（w1 或追加世界的 state.md 换成调用方全文，如带完整角色卡的样例）
  for (const [worldId, text] of Object.entries(stateFiles)) {
    writeFileSync(path.join(worldsRoot, worldId, "state.md"), text);
  }
  // 逐轮快照（server writeSnapshot 的磁盘形状：NNNN.json = {seq,at,kind,nodeId,chapterNo,files}）
  for (const [worldId, entries] of Object.entries(snapshots)) {
    for (const e of entries) {
      const entry = { at: new Date().toISOString(), ...e }; // at 可省，缺省给当前时间
      const name = `${String(entry.seq).padStart(4, "0")}.json`;
      const dir = path.join(worldsRoot, worldId, "history");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), JSON.stringify(entry, null, 2) + "\n");
    }
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// SIGTERM → 等退出（宽限期内不退再 SIGKILL）
function killProc(proc, graceMs = 4000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve();
    }, graceMs);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

// 消费 /events 的 SSE 流：按 `\n\n` 分块，取 `data:` 行 JSON 推进 events（fire-and-forget）
function readSSE(res, events) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              events.push(JSON.parse(line.slice(5).trim()));
            } catch {}
          }
        }
      }
    } catch {
      /* abort / 连接结束：正常收尾路径 */
    }
  })();
}

async function httpOk(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/**
 * 起一套集成栈（假引擎 + 真 acp-server），返回可供断言/收尾的句柄。
 * @param {object} [opts]
 * @param {Array} [opts.turns] fake-engine 的脚本队列（见 fake-engine.mjs 顶部说明）
 * @param {Array<(string|{id: string, title?: string, body?: string})>} [opts.presets]
 *   预置的剧本列表（默认 demo + other 对照）；元素为 string 时只给 id，对象形态可覆盖标题并追加 body 小节
 * @param {Record<string, string|Buffer>} [opts.sessionImages] 预置会话图片：文件名 → 内容
 * @param {Record<string, Array<{name: string, bytes: Buffer}>>} [opts.assets] 预置资产：presetId → presets/<id>/assets/ 下的文件
 * @param {Record<string, Array<{name: string, bytes: Buffer}>>} [opts.audioFiles] 预置音频：presetId → presets/<id>/audio/ 下的文件
 * @param {Record<string, string>} [opts.trees] 覆盖世界树：worldId → story-tree.md 全文
 * @param {Record<string, string>} [opts.stateFiles] 覆盖世界状态文件：worldId → state.md 全文（角色面板用）
 * @param {Array<{id: string, title?: string, preset?: string, forkedFrom?: string|null}>} [opts.worlds] 追加世界（复用 w1 三文件生成逻辑）
 * @param {Record<string, Array<{seq: number, at?: string, kind: "turn"|"backup", nodeId: string|null, chapterNo: number|null, prompt?: string, files: {state: string|null, summary: string|null, tree: string|null}}>>} [opts.snapshots]
 *   预置逐轮快照：worldId → history/NNNN.json 条目（形状与 server writeSnapshot 落盘格式一致；prompt 可省）
 * @param {number} [opts.indexSchema] 索引的 schema 号（缺省 1；2 = 未来版本，验不降级写回）
 * @param {Record<string, unknown>} [opts.indexExtra] 版本化索引里的未知顶层键（验读改写保留）
 * @param {boolean} [opts.legacyIndexArray] 写 v1.8 及以前的裸数组索引（验启动期 schema 迁移）
 * @param {"ok"|"missing"} [opts.auth] 是否写临时 HOME 的 `~/.grok/auth.json`（缺省 "ok"；"missing" 供 boot 屏未登录态用例）
 * @param {"ok"|"missing"} [opts.codexAuth] 是否写临时 HOME 的 `~/.codex/auth.json`（v1.11；缺省 "missing"——只有
 *   engine=codex 的用例需要它，且它同时是「沿用终端登录」的复用来源，见 server/engines.mjs 的 syncCodexAuth）
 * @param {object} [opts.credentials] 写进临时 HOME 的 `~/.bunkiten/credentials.json`（0600）的凭据文档
 *   （验自备 key：真引擎侧看 fake-engine 的探针 JSONL，HTTP 侧打 /api/credentials）
 * @param {object} [opts.extraEnv] 追加/覆盖给 acp-server 子进程的环境变量（服务目录更新用
 *   `BUNKITEN_PROVIDERS_URL` 指向本地 mock、`BUNKITEN_DISABLE_UPDATE:"0"` 打开抓取）
 * @param {string|null} [opts.homeDir] 复用已有的 HOME（跨多次 startStack 共享 `~/.bunkiten` 缓存；
 *   给了就归调用方所有——stop() 只删临时目录、不动它）
 * @returns {Promise<object>} stack 句柄（root/home/events/waitFor/prompt/stop 等）
 */
export async function startStack({
  turns = [],
  presets = ["demo", "other"],
  sessionImages = {},
  assets = {},
  audioFiles = {},
  trees = {},
  stateFiles = {},
  worlds = [],
  snapshots = {},
  indexSchema = 1,
  indexExtra = {},
  legacyIndexArray = false,
  auth = "ok",
  codexAuth = "missing",
  credentials = null,
  extraEnv = {},
  homeDir = null,
} = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bunkiten-it-"));
  const root = path.join(tmp, "game");
  const home = homeDir ?? path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // server 的 /api/auth 只检查 ~/.grok/auth.json 是否存在（开发机上有真登录态，临时 home 没有）；
  // UI e2e 的 boot 屏靠它放行进 title——占位内容无所谓，写一个空 JSON 即可。
  // auth:"missing" 时**不写**这个文件：给 boot 屏「还没登录叙事引擎」态一个可复现前置
  //（用例可以在中途把这个文件补上，验「重试」真的走通而不是只换个文案）。
  mkdirSync(path.join(home, ".grok"), { recursive: true });
  if (auth === "ok") writeFileSync(path.join(home, ".grok", "auth.json"), "{}\n");
  // v1.11：codex 的登录态（玩家 `~/.codex/auth.json`，即「沿用终端登录」的来源）。
  // codexAuth:"ok" 时才写；engine=codex 的栈靠它让 /api/auth 回 loggedIn=true，并由 prepare() 拷进 ~/.bunkiten/codex。
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  if (codexAuth === "ok") writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"fake-codex"}\n', { mode: 0o600 });
  // 引擎凭据（v1.10）：预置进临时 HOME 的 ~/.bunkiten/credentials.json。mode 与真实写入一致（0600 / 目录 0700），
  // 这样「保存后的权限」与「读路径」在集成层是同一份行为，不必额外伪造。
  if (credentials) {
    const dir = path.join(home, ".bunkiten");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  }
  seedStack(root, presets, { assets, audioFiles, trees, stateFiles, worlds, snapshots, indexSchema, indexExtra, legacyIndexArray, auth });

  // 会话图片目录：server 用 os.homedir()（=HOME）+ encodeURIComponent(GAME_ROOT) + sessionId 拼接
  const sessionImagesDir = path.join(home, ".grok", "sessions", encodeURIComponent(root), SESSION_ID, "images");
  mkdirSync(sessionImagesDir, { recursive: true });
  const putSessionImage = (name, content) => {
    writeFileSync(path.join(sessionImagesDir, name), content);
    return path.join(sessionImagesDir, name);
  };
  for (const [name, content] of Object.entries(sessionImages)) putSessionImage(name, content);

  // PATH 垫片：bin/grok → exec <同一个 node> fake-engine.mjs "$@"（FAKE_ENGINE_AS 告诉假引擎「你是哪家 CLI」，
  // 它据此扮演同名的登录/登出——见 fake-engine.mjs 顶部）
  writeFileSync(path.join(binDir, "grok"), `#!/bin/sh\nexec env FAKE_ENGINE_AS=grok ${shQuote(process.execPath)} ${shQuote(FAKE_ENGINE)} "$@"\n`);
  chmodSync(path.join(binDir, "grok"), 0o755);
  // v1.11：codex 后端的垫片（engine=codex 的栈走它）——同一个假引擎，argv 为空（codex-acp 不带 CLI 参数）
  writeFileSync(path.join(binDir, "codex-acp"), `#!/bin/sh\nexec env FAKE_ENGINE_AS=codex ${shQuote(process.execPath)} ${shQuote(FAKE_ENGINE)} "$@"\n`);
  chmodSync(path.join(binDir, "codex-acp"), 0o755);
  // v1.11 收尾：随包 codex **CLI** 的垫片（GUI 的「登录 Codex」按钮走它）——同样由假引擎扮演 login/logout
  writeFileSync(path.join(binDir, "codex"), `#!/bin/sh\nexec env FAKE_ENGINE_AS=codex ${shQuote(process.execPath)} ${shQuote(FAKE_ENGINE)} "$@"\n`);
  chmodSync(path.join(binDir, "codex"), 0o755);

  const port = 20000 + Math.floor(Math.random() * 40000); // 随机高位端口，避开开发中的 7800
  // 假引擎探针（v1.10）：每次被 spawn 追加一条 start（env），每条 session/load|new 追加一条 session（mcpServers）。
  // 断言面：自备 key 真的注进了引擎子进程 env、图片侧配了 key 才会挂 MCP。
  const engineProbe = path.join(tmp, "fake-engine-probe.jsonl");
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`,
    HOME: home,
    GROK_GAME_ROOT: root,
    PORT: String(port),
    // v1.11：codex 后端的入口走显式覆盖（PATH 名不再是首选——描述符会先看仓内 node_modules，
    // 那是**真** codex-acp，会把假引擎盖掉；这里指到 bin/codex-acp 垫片，与 `grok` 的 PATH 垫片同款语义）；
    // 随包 codex CLI（GUI 的「登录 Codex」）同理指到 bin/codex
    BUNKITEN_CODEX_ACP: path.join(binDir, "codex-acp"),
    BUNKITEN_CODEX_BIN: path.join(binDir, "codex"),
    FAKE_ENGINE_TURNS: JSON.stringify(turns),
    FAKE_ENGINE_PROBE: engineProbe,
    // 服务目录更新（v1.10，ADR-0020）：集成栈默认**离线**——启动时不打扰发布源，让这一层不被网络拖慢/拖红。
    // 要测抓取通道（tests/integration/providers-catalog.test.ts）就在 extraEnv 里显式给它 "0" 并指到本地 mock。
    // 与打包冒烟（tests/e2e-packaged/*.spec.ts）用的是同一个开关，语义见 electron/main.js 的 electron-updater 段。
    BUNKITEN_DISABLE_UPDATE: "1",
    ...extraEnv,
  };

  const proc = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });

  const stdoutLines = [];
  let resolvePort;
  let resolveReady;
  let rejectReady;
  const portP = new Promise((r) => (resolvePort = r));
  const readyP = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let settled = false;
  const readyFail = (e) => {
    if (!settled) {
      settled = true;
      rejectReady(e);
    }
  };
  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      stdoutLines.push(line);
      const m = /\[acp\]\s+http:\/\/localhost:(\d+)/.exec(line);
      if (m) resolvePort(Number(m[1]));
      if (line.includes("session ready")) {
        // v1.11：ready 行带引擎前缀（`grok session ready` / `codex session ready`），两种栈都吃这一条
        settled = true;
        resolveReady();
      } else if (line.includes("boot failed")) {
        readyFail(new Error("acp-server boot failed: " + line));
      }
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write("[acp-it] " + d));
  proc.on("exit", (code) => readyFail(new Error(`acp-server exited early with code ${code}`)));

  const events = [];
  const sseController = new AbortController();
  let stopped = false;

  // 兜底：测试进程异常退出时同步杀掉 server（正常路径走 stop()）
  const onExit = () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  process.once("exit", onExit);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    process.removeListener("exit", onExit);
    try {
      sseController.abort();
    } catch {}
    await killProc(proc);
    if (KEEP_TMP) {
      console.warn(`[integration] 保留临时目录（KEEP_INTEGRATION_TMP=1）: ${tmp}`);
    } else {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  };

  const stack = {
    tmp,
    root,
    home,
    binDir,
    sessionId: SESSION_ID,
    sessionImagesDir,
    putSessionImage,
    /** v1.11：codex 的游戏管理 home（spawn 时 CODEX_HOME 指向它；prepare 在这里落 auth/config/skill） */
    codexHome: path.join(home, ".bunkiten", "codex"),
    events,
    port: null,
    base: null,
    stdout: () => stdoutLines.join("\n"),
    /** 假引擎探针的原始路径（JSONL；每次 spawn 一条 start、每条 session/load|new 一条 session） */
    engineProbe,
    /** @returns {any[]} 探针条目（文件不存在时空数组） */
    engineProbeEntries: () => {
      try {
        return readFileSync(engineProbe, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    stop,
  };
  stack.fetch = (p, init) => fetch(stack.base + p, init);
  stack.getJSON = async (p) => {
    const r = await stack.fetch(p);
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
  };
  stack.getText = async (p) => {
    const r = await stack.fetch(p);
    return { status: r.status, headers: r.headers, body: await r.text() };
  };
  stack.getBytes = async (p) => {
    const r = await stack.fetch(p);
    return { status: r.status, type: r.headers.get("content-type"), bytes: Buffer.from(await r.arrayBuffer()) };
  };
  stack.postJSON = async (p, body) => {
    const r = await stack.fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  stack.prompt = (text) => stack.postJSON("/prompt", { text });
  // 轮询断言：pred 收到实时 events 数组，返回真即 resolve；超时抛错（带上当前事件便于定位）
  stack.waitFor = (pred, { timeout = 8000, interval = 25, label = "condition" } = {}) => {
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const tick = () => {
        let ok = false;
        try {
          ok = Boolean(pred(events));
        } catch {
          ok = false;
        }
        if (ok) return resolve();
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}（events: ${JSON.stringify(events)}）`));
        setTimeout(tick, interval);
      };
      tick();
    });
  };

  try {
    const [actualPort] = await Promise.all([
      withTimeout(portP, BOOT_TIMEOUT_MS, "acp-server 监听端口行"),
      withTimeout(readyP, BOOT_TIMEOUT_MS, "grok session ready（boot 握手）"),
    ]);
    stack.port = actualPort;
    stack.base = `http://localhost:${actualPort}`;
    // 先建 SSE 长连接再让测试发 prompt，避免漏掉 turn_start 等早期事件
    const res = await fetch(stack.base + "/events", { signal: sseController.signal });
    readSSE(res, events);
    await withTimeout(waitForHttp(stack.base + "/api/auth"), BOOT_TIMEOUT_MS, "acp-server http 就绪");
  } catch (e) {
    await stop();
    throw e;
  }
  return stack;
}

async function waitForHttp(url) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (await httpOk(url)) return;
    if (Date.now() > deadline) throw new Error(`http not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
