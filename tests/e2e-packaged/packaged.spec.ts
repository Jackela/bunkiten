// 打包态冒烟（v1.12 起跨平台：macOS 的 .app 与 Windows 的 win-unpacked 都走这一份；定位规则见
// tests/helpers/packaged-app.mjs）——唯一覆盖「打包布局 + asar + 主进程 + resources/game 资源路径 +
// /app 静态托管」的路径。假引擎垫片与临时 HOME 的搭法与 tests/integration/harness.mjs 同款
// （临时 HOME 里写 ~/.grok/auth.json 让 boot 自检通过，PATH 前置一张 `grok` 垫片指到 fake-engine.mjs
// ——打包态 main.js 自己会把 ~/.grok/bin 等常见位置前置到 PATH，所以垫片必须放在 HOME 里的
// .grok/bin（Windows 上落的是 grok.cmd，见 writeCliShim）或直接改写环境变量的 PATH）。
//
// 前置（按平台）：macOS `npm run dist:mac:dir`（release/mac-<arch>/Bunkiten.app）；Windows
// `npm run dist:win:dir`（release/win-unpacked/Bunkiten.exe）。缺失时整组 skip——它是 opt-in 冒烟，
// 不该让没打包的人「跑测试先失败」（CI 的 packaged-win job 会先打包再跑，见 .github/workflows/ci.yml）。
// 已知副作用：打包态的 GAME_ROOT 是产物内的 resources/game（main.js 里写死，env 改不了），
// 应用启动会往里写 state/worlds/（本 spec 只停在标题屏，不做世界线操作，写入量最小）。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { findPackagedApp, packagedSkipHint, writeCliShim } from "../helpers/packaged-app.mjs";
import { startMockImageServer } from "../helpers/mock-image-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_ENGINE = path.join(ROOT, "tests", "integration", "fake-engine.mjs");

const APP = findPackagedApp(ROOT);
const APP_BIN = APP?.exe ?? null;
const SKIP_HINT = packagedSkipHint();

/**
 * 收尾：**先关窗口再 close**，close 卡住就 SIGKILL——冒烟不该把 worker 挂死。
 *
 * 为什么顺序不能反：渲染进程与 acp-server 之间有一条 SSE 长连接（`/events`），页面活着它就活着；
 * `app.close()` 触发的退出走到主进程的 `will-quit`（`electron/main.js`：先 `preventDefault` 再等
 * `stopServer()`），而 `stopServer()` 关闭 HTTP 服务时要等连接散尽——连接不断，退出就永远等下去。
 * 实测：页面开着时 close 30s 不返回，先 `win.close()` 再 close 只需 0.1s。
 * （正常玩家退出不受影响：Electron 的退出序列先关窗口，那时 SSE 已经随渲染进程一起没了。）
 * @param {ElectronApplication} app 已启动的应用
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  for (const w of app.windows()) await w.close().catch(() => {});
  const closed = await Promise.race([
    app.close().then(() => true).catch(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
  ]);
  if (!closed) {
    try {
      const pid = app.process().pid;
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      /* 已经退了 */
    }
  }
}

/**
 * 等子进程真的退出（Windows 上文件锁跟着进程走：KILL 之后还要等一拍，临时目录才删得掉）。
 * 超时就交给 rmTemp 的重试兜底，不在这里抛。
 * @param {ChildProcess | null} proc 目标进程 @param {number} [timeoutMs] 上限
 */
async function waitForExit(proc: ChildProcess | null, timeoutMs = 5000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((r) => proc!.once("exit", () => r())),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** 删临时目录：Windows 上进程刚退时文件锁可能还没放开——带重试（recursive 下 maxRetries 生效），清不掉就留给系统 */
function rmTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 已经在系统临时目录里，删不掉不影响结论 */
  }
}

test("打包态：codex-acp 资源树就位，且打包态可执行文件（ELECTRON_RUN_AS_NODE）能把它跑出 initialize", async () => {
  test.skip(APP_BIN === null, SKIP_HINT);
  const acpRoot = path.join(APP!.resources, "codex-acp", "node_modules");
  const entry = path.join(acpRoot, "@agentclientprotocol", "codex-acp", "dist", "index.js");
  expect(
    existsSync(entry),
    `extraResources 没把 codex-acp 铺进 resources/codex-acp：${entry}（检查 electron-builder.yml 与 scripts/stage-codex-acp.mjs——dist:* 之前必须跑过铺场脚本）`,
  ).toBe(true);
  // 平台二进制也必须在（它跟着构建机走；缺了 initialize 会失败），且**架构要与产物一致**——
  // mac 只出 arm64（ADR-0011 修订），这条就是「交叉打包会把错架构的二进制装进产物」的守门断言。
  const openaiDir = path.join(acpRoot, "@openai");
  const platformPkgs = readdirSync(openaiDir).filter((n) => n.startsWith("codex-"));
  expect(platformPkgs.length, "resources/codex-acp 里没有平台二进制包（@openai/codex-<platform>-<arch>）").toBeGreaterThan(0);
  const expectedPlatform = `codex-${process.platform}-${process.arch}`;
  expect(
    platformPkgs,
    `平台二进制与产物架构不符：期望 ${expectedPlatform}，实际 ${platformPkgs.join("、")}（是不是交叉打包了？见 scripts/stage-codex-acp.mjs 的架构自检）`,
  ).toContain(expectedPlatform);

  // 运行期配方实证（与 server/engines.mjs 的 codexAcpCommand 同款）：打包态可执行文件 + ELECTRON_RUN_AS_NODE=1
  // + 资源树里的入口脚本 → initialize 必须成功。只断言「文件存在」不够——依赖闭包缺一个兄弟就 ERR_MODULE_NOT_FOUND，
  // 而那正是 v1.10 的 MCP 打包踩过的坑（见 docs/adr/0022 第 14 条）。
  // CODEX_HOME 必须先存在：codex-acp 对不存在的路径直接回 initialize 错误（同 ADR 第 13 条）。
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bunkiten-packaged-codex-"));
  const codexHome = path.join(tmp, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  let child: ChildProcess | null = null;
  try {
    const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const proc = spawn(APP_BIN as string, [entry], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEX_HOME: codexHome, NO_BROWSER: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", (e) => resolve({ ok: false, detail: `spawn 失败：${e.message}` }));
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        resolve({ ok: false, detail: `initialize 超时；stderr=${stderr.slice(0, 400)}` });
      }, 25_000);
      readline.createInterface({ input: proc.stdout }).on("line", (line) => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== 1) return;
        clearTimeout(timer);
        try { proc.kill("SIGKILL"); } catch {}
        if (msg.error) resolve({ ok: false, detail: `initialize 回错误：${msg.error.message ?? JSON.stringify(msg.error)}` });
        else resolve({ ok: true, detail: String(msg.result?.agentInfo?.name ?? "(无 agentInfo)") });
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
    });
    expect(result.ok, `codex-acp 入口跑不起来：${result.detail}`).toBe(true);
    expect(result.detail).toContain("codex-acp");
  } finally {
    // Windows 上文件锁跟着进程：SIGKILL 之后要等它真的退出，临时目录才删得掉（否则 EPERM）
    await waitForExit(child);
    rmTemp(tmp);
  }
});

test("打包态：窗口能开、标题屏渲染、/app 与 resources/game 资源可达", async () => {
  test.skip(APP_BIN === null, SKIP_HINT);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bunkiten-packaged-"));
  const home = path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  const probeFile = path.join(tmp, "probe.jsonl");
  mkdirSync(path.join(home, ".grok"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(home, ".grok", "auth.json"), "{}\n");
  // v1.10：让引擎侧真的挂上出图 MCP（image.mode=byok 才会挂）。凭据写在临时 HOME 里，
  // 打包态 acp-server 的 os.homedir() 就是这个 HOME。
  mkdirSync(path.join(home, ".bunkiten"), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(home, ".bunkiten", "credentials.json"),
    JSON.stringify({
      version: 1,
      llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
      image: { mode: "byok", provider: "custom", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-packaged-e2e-0001", model: "img", size: "" },
    }),
    { mode: 0o600 },
  );
  // PATH 垫片：`grok` → 同一个 node 跑假引擎（打包态 acp-server 启动时要握手一个会话）。
  // **必须放在临时 HOME 的 `~/.grok/bin` 里**：electron/main.js 会把 `~/.grok/bin`、`/usr/local/bin`、
  // `/opt/homebrew/bin` 前置到 PATH——放别的目录（哪怕是测试自己 PATH 的第一位）会被本机真实安装的
  // grok 盖掉，于是「假引擎根本没跑、boot 静默失败」而用例照样绿（v1.10 实测：本机 /usr/local/bin 有 grok，
  // 旧版冒烟一直没验过引擎握手所以没暴露）。`~/.grok/bin` 是 main.js 的第一个前缀，放这里必胜。
  // FAKE_ENGINE_SPAWN_MCP=1 让假引擎**真的把 mcpServers 拉起来**跑 initialize → tools/list——
  // 这是唯一能验「那条命令（packaged 可执行文件 + ELECTRON_RUN_AS_NODE=1 + asar 外脚本路径）跑得起来」的地方。
  mkdirSync(path.join(home, ".grok", "bin"), { recursive: true });
  writeCliShim(path.join(home, ".grok", "bin"), "grok", process.execPath, FAKE_ENGINE);

  const app = await electron.launch({
    executablePath: APP_BIN as string,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_ENGINE_TURNS: "[]",
      FAKE_ENGINE_PROBE: probeFile,
      FAKE_ENGINE_SPAWN_MCP: "1",
      BUNKITEN_DISABLE_UPDATE: "1", // 打包态会查更新：冒烟不该联网
    },
  });
  const appLogs: string[] = [];
  app.process().stdout?.on("data", (d) => appLogs.push(String(d)));
  app.process().stderr?.on("data", (d) => appLogs.push(String(d)));
  try {
    const win = await app.firstWindow();

    // 主进程视角：窗口真的开了，尺寸是 electron/main.js 里配置的 1440×900
    //（窗口 show:false + ready-to-show 才显示，所以「可见」要轮询等一拍；
    //  标题的最终值来自页面 <title>，是渲染侧的事，不在这里断言）
    const winState = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), ...w.getBounds() })),
      );
    await expect.poll(async () => (await winState()).length).toBe(1);
    // 宽高都可能被屏幕**可用区**夹小：Windows runner 的虚拟屏只有 1024×768（实测宽度被夹成 1024），
    // macOS 上 Dock/菜单栏也会吃掉高度（实测给出 800）。所以断言「不超过配置值、也没被压扁」，不钉死
    // 1440/900——钉死会让这条冒烟变成「取决于跑测试那台机器的屏幕」，与它要验的东西（窗口真的按配置
    // 开出来）无关。
    const bounds = (await winState())[0] as { width: number; height: number };
    expect(bounds.width).toBeLessThanOrEqual(1440);
    expect(bounds.width).toBeGreaterThan(800);
    expect(bounds.height).toBeLessThanOrEqual(900);
    expect(bounds.height).toBeGreaterThan(600);
    await expect.poll(async () => (await winState())[0]?.visible).toBe(true);

    // 打包态走 acp-server 的静态托管（不是 vite）：**尾斜杠**是关键——产物 index.html 的资源是相对路径，
    // 少了它基准地址落在站点根、./assets/… 全部 404、窗口一片空白（本 spec 首跑就抓到过这个真 bug，
    // 见 electron/main.js 的注释与 server/routes.mjs 的 /app 302）。
    await expect.poll(() => win.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\/$/);
    const port = new URL(win.url()).port;

    // 关键资源不许 404（script/stylesheet/document）：这条是「窗口一片空白」的直接探针
    const bad: string[] = [];
    win.on("response", (r) => {
      const type = r.request().resourceType();
      if (r.status() >= 400 && (type === "script" || type === "stylesheet" || type === "document")) {
        bad.push(`${r.status()} ${type} ${r.url()}`);
      }
    });

    // 标题屏渲染（boot 自检通过 → title；剧本来自 resources/game/presets）
    await expect(win.getByTestId("title-wordmark")).toBeVisible();
    await expect(win.getByTestId("title-card-center")).toBeVisible();
    expect(bad, "打包前端有关键资源 404（页面会是空白）：先查 /app 的尾斜杠与 resources/app-dist 布局").toEqual([]);

    // resources/game 布局可读：server 能列出 extraResources 里的 presets
    const res = await fetch(`http://127.0.0.1:${port}/api/presets`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { presets: { id: string }[] };
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets.length).toBeGreaterThan(0);

    // asarUnpack 的产物真的在（v1.10 出图 MCP 的前提）：MCP server 是引擎拉起的**子进程**，
    // 子进程读不了 asar，所以 electron-builder.yml 把 server/** 与 shared/** 两整棵树解到
    // app.asar.unpacked/，运行时 mediaMcpPath() 把 `app.asar` 段换成 `app.asar.unpacked`。
    // 断言面不只是「media-mcp 在」：它相对 import 的每一层兄弟都必须在同一棵 unpacked 树里——
    // 只解一个文件时那些兄弟不在，子进程第一步就 ERR_MODULE_NOT_FOUND（v1.10 实测抓到过）。
    const unpackedRoot = path.join(APP!.resources, "app.asar.unpacked");
    const unpacked = path.join(unpackedRoot, "server", "media-mcp.mjs");
    expect(existsSync(unpacked), `asarUnpack 没把出图 MCP 解开到 asar 外：${unpacked}（检查 electron-builder.yml 的 asarUnpack）`).toBe(true);
    expect(existsSync(path.join(APP!.resources, "app.asar")), "app.asar 不在预期位置（打包布局变了，mediaMcpPath 的替换规则要跟着看）").toBe(true);
    // 顺着 import 图把 server/ 与 shared/ 的整棵依赖树逐个 stat（不是硬编码文件清单：
    // 从 media-mcp.mjs 出发递归读 `from "…"` 相对路径，谁缺了都报出来）
    const missing: string[] = [];
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      let src = "";
      try {
        src = readFileSync(file, "utf8");
      } catch {
        missing.push(file);
        return;
      }
      for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
        walk(path.resolve(path.dirname(file), m[1]));
      }
    };
    walk(unpacked);
    expect(missing, `unpacked 树里缺这些被 import 的模块（子进程会 ERR_MODULE_NOT_FOUND）：${missing.join("、")}`).toEqual([]);
    expect(seen.size, "import 图走下来只看到一个文件？递归没生效（这条断言就白写了）").toBeGreaterThan(5);
    expect(readFileSync(unpacked, "utf8")).toContain('export const MEDIA_TOOL_NAME = "generate_image"');

    // 最有价值的一条：**打包态里真的把 MCP 拉起来跑一遍握手**。
    // 断言链：acp-server 按 image.mode=byok 挂上 mcpServers（探针的 session 条目）→ 假引擎按原样 spawn
    // → initialize/tools/list 都成功、serverInfo 是 bunkiten-media、工具是 generate_image。
    // 这条路走的是「packaged 可执行文件 + ELECTRON_RUN_AS_NODE=1 + app.asar.unpacked 里的脚本」——
    // dev 与集成层都验不到它（v1.10 的 ERR_MODULE_NOT_FOUND 就是死在这里）。
    const probeEntries = (): any[] =>
      existsSync(probeFile)
        ? readFileSync(probeFile, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
        : [];
    // 先等握手（假引擎至少写下 start + session 两条），失败时把探针原文贴出来——
    // 「凭据没读到」「mcpServers 是空的」「假引擎没起来」这三种坏法的排查全靠它
    if (!probeEntries().length) console.log("[packaged] app logs:", appLogs.join("").slice(-2500));
    await expect
      .poll(() => probeEntries().some((e) => e.kind === "session"), {
        timeout: 20000,
        message: `假引擎没写下 session 握手探针（FAKE_ENGINE_PROBE 没生效？）probe=${JSON.stringify(probeEntries())}；app logs=${appLogs.join("").slice(-800)}`,
      })
      .toBe(true);
    console.log("[packaged] probe:", JSON.stringify(probeEntries()));
    await expect
      .poll(() => probeEntries().some((e) => e.kind === "mcp"), {
        timeout: 20000,
        message: "假引擎没有拉起 MCP（凭据没生效或 mcpServers 没挂上）",
      })
      .toBe(true);
    const mcp = probeEntries().find((e) => e.kind === "mcp");
    expect(mcp.ok, `打包态 MCP 握手失败：${mcp.error ?? "(无原因)"}`).toBe(true);
    expect(mcp.serverInfo?.name).toBe("bunkiten-media");
    expect(mcp.tools).toContain("generate_image");
    expect(String(mcp.command)).toContain(path.basename(APP!.exe)); // 命令就是打包态可执行文件本身（ELECTRON_RUN_AS_NODE 让它当 node 跑）
    expect(String(mcp.args?.[0])).toContain("app.asar.unpacked"); // 且指向 asar 外的真实脚本
    const sessionEntry = probeEntries().find((e) => e.kind === "session");
    expect(sessionEntry?.mcpServers?.map((s: any) => s.name)).toEqual(["bunkiten-media"]);
  } finally {
    await closeApp(app);
    rmTemp(tmp);
  }
});

/** 扫 `presets/<id>/assets/*.jpe?g`（相对路径 → {size, mtimeMs}）：跑前后各取一次做「新文件」判定 */
function snapshotPackagedAssets(presetsRoot: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  let dirs: string[] = [];
  try {
    dirs = readdirSync(presetsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const id of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(path.join(presetsRoot, id, "assets"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.jpe?g$/i.test(f)) continue;
      try {
        const st = statSync(path.join(presetsRoot, id, "assets", f));
        out[`presets/${id}/assets/${f}`] = { size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return out;
}

// 打包态 · mock 出图（opt-in，**不需要任何真凭据/真网络**；见 playwright.electron.config.ts 文件头）：
// 打包 .app + 假引擎（FAKE_ENGINE_SPAWN_MCP=1 + FAKE_ENGINE_CALL_MCP=1）+ 本 spec 进程内起的假图片服务，
// 把「打包布局 → 引擎子进程 → 拉起 MCP → tools/call → 打自备图片服务 → 落盘 resources/game/presets」
// 这条 v1.10 出图链路**在打包态**串起来验一遍——real-image.spec 是同一条链路的真跑版（要真凭据、真出网），
// 本条是它的离线替身：只花本地端口与一个假服务。
//
// 与 real-image.spec 的差异（更轻量）：不点 UI（直接 POST /prompt 发重绘指令）、不碰包里自带的资产——
// 用一个包里没有的唯一立绘名，让假引擎兜底落「排序第一个剧本目录」，于是断言面就是「跑前后快照里多出的那张 jpg」。
// 已知副作用：同第一条冒烟，应用启动会往 resources/game 写 state/worlds/；收尾只删本次新增的 jpg。
test("打包态 mock 出图：假引擎真发 tools/call + 本地假图片服务，resources/game 落一张新 jpg 且 /img 直服 200", async () => {
  test.skip(APP_BIN === null, SKIP_HINT);
  test.setTimeout(180_000);

  const mock = await startMockImageServer();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bunkiten-packaged-mock-"));
  const home = path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  const probeFile = path.join(tmp, "probe.jsonl");
  mkdirSync(path.join(home, ".grok"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(home, ".grok", "auth.json"), "{}\n");
  // 图片自备 key 指向本 spec 进程内的假服务（0600 落盘；打包态 acp-server/media-mcp 的 os.homedir() 就是这个 HOME）
  mkdirSync(path.join(home, ".bunkiten"), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(home, ".bunkiten", "credentials.json"),
    JSON.stringify({
      version: 1,
      llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
      image: { mode: "byok", provider: "custom", baseUrl: mock.base, apiKey: "sk-packaged-mock-0001", model: "mock-image", size: "" },
    }),
    { mode: 0o600 },
  );
  // PATH 垫片：`grok` → 同一个 node 跑假引擎（与第一条冒烟同款：必须放临时 HOME 的 ~/.grok/bin 里）
  mkdirSync(path.join(home, ".grok", "bin"), { recursive: true });
  writeCliShim(path.join(home, ".grok", "bin"), "grok", process.execPath, FAKE_ENGINE);

  // 打包态 GAME_ROOT = .app 内 resources/game（main.js 写死；extraResources 把仓库 presets/ 铺到这）
  const gameRoot = path.join(APP!.resources, "game");
  const presetsRoot = path.join(gameRoot, "presets");
  const before = snapshotPackagedAssets(presetsRoot);
  // 包里没有的唯一立绘名：重绘后必然是一个「新文件」（与包里自带的资产区分开）
  const name = `MockProbe${Date.now().toString(36)}`;
  let created: string[] = [];

  let app: ElectronApplication | null = null;
  const appLogs: string[] = [];
  try {
    app = await electron.launch({
      executablePath: APP_BIN as string,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_ENGINE_TURNS: "[]",
        FAKE_ENGINE_PROBE: probeFile,
        FAKE_ENGINE_SPAWN_MCP: "1",
        FAKE_ENGINE_CALL_MCP: "1",
        BUNKITEN_DISABLE_UPDATE: "1",
      },
    });
    app.process().stdout?.on("data", (d) => appLogs.push(String(d)));
    app.process().stderr?.on("data", (d) => appLogs.push(String(d)));

    const win = await app.firstWindow();
    await expect(win.getByTestId("title-wordmark")).toBeVisible({ timeout: 60_000 });
    const port = new URL(win.url()).port;
    const probeEntries = (): any[] =>
      existsSync(probeFile)
        ? readFileSync(probeFile, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
        : [];
    const postPrompt = () =>
      fetch(`http://127.0.0.1:${port}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `美术：重绘 立绘 ${name}` }),
      });
    // 引擎握手就绪的判据与第一条冒烟同款：假引擎收到 session/new 就写一条 `session` 探针。
    //（**不**依赖 app 日志：打包态 Electron 主进程的 stdout 在 _electron 下不定能被捕获；
    //  探针走文件，是这两条 spec 都实测可靠的信号。）
    try {
      await expect
        .poll(() => probeEntries().some((e) => e.kind === "session"), { timeout: 60_000, message: "假引擎没写下 session 握手探针（FAKE_ENGINE_PROBE 没生效？）" })
        .toBe(true);
    } catch (e) {
      console.log("[packaged-mock] probe:", JSON.stringify(probeEntries()));
      console.log("[packaged-mock] app logs:", appLogs.join("").slice(-2500));
      throw e;
    }
    // 就绪前 POST /prompt 会 409（引擎未就绪/上一回合在跑）；轮询到 200——成功那一次就是唯一一次真正发指令
    try {
      await expect
        .poll(async () => (await postPrompt()).status, { timeout: 60_000, message: "POST /prompt 一直不是 200（409=引擎未就绪）" })
        .toBe(200);
    } catch (e) {
      console.log("[packaged-mock] probe:", JSON.stringify(probeEntries()));
      console.log("[packaged-mock] app logs:", appLogs.join("").slice(-2500));
      throw e;
    }

    // 断言：resources/game/presets/**/assets/ 里多出一张 jpg（跑前后快照对比）
    await expect
      .poll(() => Object.keys(snapshotPackagedAssets(presetsRoot)).filter((k) => !(k in before)).length, {
        timeout: 30_000,
        message: "重绘后 resources/game/presets 下没有出现新 jpg",
      })
      .toBe(1);
    created = Object.keys(snapshotPackagedAssets(presetsRoot)).filter((k) => !(k in before));
    const newRel = created[0];
    expect(newRel, "新 jpg 的文件名应就是本次重绘的目标").toMatch(new RegExp(`^presets/[^/]+/assets/立绘-${name}\\.jpg$`));
    const bytes = readFileSync(path.join(gameRoot, newRel));
    expect(bytes.length, "新 jpg 应非空").toBeGreaterThan(0);
    expect(bytes.equals(mock.imageBytes), "落盘字节应等于假服务返回的图").toBe(true);
    expect(mock.calls, "假图片服务应恰好收到 1 次生成请求").toHaveLength(1);

    // /img 直服 200 且非空（落盘契约的另一半）
    const served = await fetch(`http://127.0.0.1:${port}/img?p=${encodeURIComponent(newRel)}`);
    expect(served.status, `/img 直服 ${newRel} 应 200`).toBe(200);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    expect(servedBytes.length).toBeGreaterThan(0);
    expect(servedBytes.equals(mock.imageBytes)).toBe(true);
    console.log(`[packaged-mock] 新增 ${newRel}（${bytes.length}B），mock 收到 ${mock.calls.length} 次请求`);
  } finally {
    if (app) await closeApp(app);
    // 收尾：只删本次新增的 jpg（绝不动包里自带的）
    for (const rel of created) {
      try {
        rmSync(path.join(gameRoot, rel));
      } catch {
        /* 删不掉就留着，已在报告里说明 */
      }
    }
    rmTemp(tmp);
    await mock.close();
  }
});
