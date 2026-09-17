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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
//   · worlds:     [{id, title?, preset?, forkedFrom?}] → 追加世界（复用 w1 三文件逻辑）
//   · snapshots:  { worldId: [{seq,at?,kind,nodeId,chapterNo,files}] } → 写 state/worlds/<id>/history/NNNN.json
//                 （条目形状与 server writeSnapshot 的磁盘格式一致：files = {state,summary,tree}）
function seedStack(root, presets, extra = {}) {
  const { assets = {}, audioFiles = {}, trees = {}, worlds = [], snapshots = {} } = extra;
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
  writeFileSync(path.join(worldsRoot, "index.json"), JSON.stringify(index, null, 2) + "\n");
  // 树覆盖（w1 或追加世界的 story-tree.md 换成调用方全文）
  for (const [worldId, text] of Object.entries(trees)) {
    writeFileSync(path.join(worldsRoot, worldId, "story-tree.md"), text);
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
 * @param {Array<{id: string, title?: string, preset?: string, forkedFrom?: string|null}>} [opts.worlds] 追加世界（复用 w1 三文件生成逻辑）
 * @param {Record<string, Array<{seq: number, at?: string, kind: "turn"|"backup", nodeId: string|null, chapterNo: number|null, files: {state: string|null, summary: string|null, tree: string|null}}>>} [opts.snapshots]
 *   预置逐轮快照：worldId → history/NNNN.json 条目（形状与 server writeSnapshot 落盘格式一致）
 * @returns {Promise<object>} stack 句柄（root/home/events/waitFor/prompt/stop 等）
 */
export async function startStack({
  turns = [],
  presets = ["demo", "other"],
  sessionImages = {},
  assets = {},
  audioFiles = {},
  trees = {},
  worlds = [],
  snapshots = {},
} = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bunkiten-it-"));
  const root = path.join(tmp, "game");
  const home = path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // server 的 /api/auth 只检查 ~/.grok/auth.json 是否存在（开发机上有真登录态，临时 home 没有）；
  // UI e2e 的 boot 屏靠它放行进 title——占位内容无所谓，写一个空 JSON 即可
  mkdirSync(path.join(home, ".grok"), { recursive: true });
  writeFileSync(path.join(home, ".grok", "auth.json"), "{}\n");
  seedStack(root, presets, { assets, audioFiles, trees, worlds, snapshots });

  // 会话图片目录：server 用 os.homedir()（=HOME）+ encodeURIComponent(GAME_ROOT) + sessionId 拼接
  const sessionImagesDir = path.join(home, ".grok", "sessions", encodeURIComponent(root), SESSION_ID, "images");
  mkdirSync(sessionImagesDir, { recursive: true });
  const putSessionImage = (name, content) => {
    writeFileSync(path.join(sessionImagesDir, name), content);
    return path.join(sessionImagesDir, name);
  };
  for (const [name, content] of Object.entries(sessionImages)) putSessionImage(name, content);

  // PATH 垫片：bin/grok → exec <同一个 node> fake-engine.mjs "$@"
  writeFileSync(path.join(binDir, "grok"), `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(FAKE_ENGINE)} "$@"\n`);
  chmodSync(path.join(binDir, "grok"), 0o755);

  const port = 20000 + Math.floor(Math.random() * 40000); // 随机高位端口，避开开发中的 7800
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`,
    HOME: home,
    GROK_GAME_ROOT: root,
    PORT: String(port),
    FAKE_ENGINE_TURNS: JSON.stringify(turns),
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
      if (line.includes("grok session ready")) {
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
    events,
    port: null,
    base: null,
    stdout: () => stdoutLines.join("\n"),
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
