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

// 预置剧本：frontmatter id/title + `# 主要角色`（server parseCharacters 按 `## 名` 抓取）
function presetMarkdown(id, title) {
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
  ].join("\n");
}

// 临时 game root 的预置数据：presets/<id>/{preset.md,assets/} + state/worlds/index.json 与 w1 三文件
function seedStack(root, presets) {
  mkdirSync(path.join(root, "presets"), { recursive: true });
  mkdirSync(path.join(root, "state", "worlds"), { recursive: true });
  for (const id of presets) {
    const dir = path.join(root, "presets", id);
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    writeFileSync(path.join(dir, "preset.md"), presetMarkdown(id, id === "demo" ? "示例剧本" : "对照剧本"));
  }
  // 世界线索引 + 一个 demo 世界 w1（sniffPreset 用它把 w1 → demo）
  writeFileSync(
    path.join(root, "state", "worlds", "index.json"),
    JSON.stringify(
      [{ worldId: "w1", preset: "demo", title: "示例剧本", chapterNo: 1, lastPlayed: 1_700_000_000_000, note: "", forkedFrom: null }],
      null,
      2,
    ) + "\n",
  );
  const w1 = path.join(root, "state", "worlds", "w1");
  mkdirSync(w1, { recursive: true });
  writeFileSync(path.join(w1, "state.md"), "# 剧情状态\n- preset: demo\n- 场景: 教堂\n");
  writeFileSync(path.join(w1, "summary.md"), "# 前情摘要（滚动）\n");
  writeFileSync(
    path.join(w1, "story-tree.md"),
    "# 剧情树\n## 第 1 章：起点\n- 当前进度: 节点 1-1（已走 0 轮）\n\n### 节点 1-1（门口）\n- 地点: 教堂\n- 状态: 可达\n",
  );
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
 * @param {string[]} [opts.presets] 预置的剧本 id 列表（默认 demo + other 对照）
 * @param {Record<string, string|Buffer>} [opts.sessionImages] 预置会话图片：文件名 → 内容
 * @returns {Promise<object>} stack 句柄（root/home/events/waitFor/prompt/stop 等）
 */
export async function startStack({ turns = [], presets = ["demo", "other"], sessionImages = {} } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bunkiten-it-"));
  const root = path.join(tmp, "game");
  const home = path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  seedStack(root, presets);

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
