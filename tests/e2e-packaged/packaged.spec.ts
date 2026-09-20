// 打包态冒烟（opt-in，不进 CI；见 playwright.electron.config.ts 文件头）：
// 用 _electron 直接起 `npm run dist:mac:dir` 的 .app——唯一覆盖「打包布局 + asar + 主进程 +
// resources/game 资源路径 + /app 静态托管」的路径。假引擎垫片与临时 HOME 的搭法与
// tests/integration/harness.mjs 同款（临时 HOME 里写 ~/.grok/auth.json 让 boot 自检通过，
// PATH 前置一张 `grok` 垫片指到 fake-engine.mjs——打包态 main.js 自己会把 ~/.grok/bin 等
// 常见位置前置到 PATH，所以垫片必须放在 HOME 里的 .grok/bin 或直接改写环境变量的 PATH）。
//
// 前置：npm run dist:mac:dir（产物 release/mac-<arch>/Bunkiten.app）。缺失时整组 skip——
// 它是 opt-in 冒烟，不该让没打包的人「跑测试先失败」。
// 已知副作用：打包态的 GAME_ROOT 是 .app 内的 resources/game（main.js 里写死，env 改不了），
// 应用启动会往里写 state/worlds/（本 spec 只停在标题屏，不做世界线操作，写入量最小）。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_ENGINE = path.join(ROOT, "tests", "integration", "fake-engine.mjs");

/** release/ 里的 .app（mac-arm64 / mac / mac-x64 都认；取 mtime 最新的一个） */
function findApp(): string | null {
  const release = path.join(ROOT, "release");
  if (!existsSync(release)) return null;
  const candidates: { app: string; mtime: number }[] = [];
  for (const dir of readdirSync(release, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith("mac")) continue;
    const appDir = path.join(release, dir.name, "Bunkiten.app");
    const bin = path.join(appDir, "Contents", "MacOS", "Bunkiten");
    if (existsSync(bin)) candidates.push({ app: bin, mtime: statSync(bin).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.app ?? null;
}

const APP_BIN = findApp();

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

test("打包态：窗口能开、标题屏渲染、/app 与 resources/game 资源可达", async () => {
  test.skip(APP_BIN === null, "未找到打包产物：先跑 `npm run dist:mac:dir`（产物在 release/mac-<arch>/Bunkiten.app）");
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
  const shim = path.join(home, ".grok", "bin", "grok");
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_ENGINE}' "$@"\n`);
  chmodSync(shim, 0o755);

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
    // 宽度是 electron/main.js 里配置的 1440；高度会被 macOS 夹到屏幕**可用区**——Dock/菜单栏占位时
    // 900 放不下（实测这台机器给出 800）。所以这里断言「不超过配置值、也没被压扁」而不是钉死 900：
    // 钉死会让这条冒烟变成「取决于跑测试那台机器的 Dock 设置」，与它要验的东西（窗口真的按配置开出来）无关。
    const bounds = (await winState())[0] as { width: number; height: number };
    expect(bounds.width).toBe(1440);
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
    const appRoot = path.resolve(APP_BIN as string, "..", ".."); // Contents/MacOS/Bunkiten → Contents
    const unpackedRoot = path.join(appRoot, "Resources", "app.asar.unpacked");
    const unpacked = path.join(unpackedRoot, "server", "media-mcp.mjs");
    expect(existsSync(unpacked), `asarUnpack 没把出图 MCP 解开到 asar 外：${unpacked}（检查 electron-builder.yml 的 asarUnpack）`).toBe(true);
    expect(existsSync(path.join(appRoot, "Resources", "app.asar")), "app.asar 不在预期位置（打包布局变了，mediaMcpPath 的替换规则要跟着看）").toBe(true);
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
    expect(String(mcp.command)).toContain("Bunkiten.app"); // 命令就是打包态可执行文件本身（ELECTRON_RUN_AS_NODE 让它当 node 跑）
    expect(String(mcp.args?.[0])).toContain("app.asar.unpacked"); // 且指向 asar 外的真实脚本
    const sessionEntry = probeEntries().find((e) => e.kind === "session");
    expect(sessionEntry?.mcpServers?.map((s: any) => s.name)).toEqual(["bunkiten-media"]);
  } finally {
    await closeApp(app);
    rmSync(tmp, { recursive: true, force: true });
  }
});
