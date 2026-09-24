// Electron 主进程：确定 GAME_ROOT → 启动 acp-server → 开窗口加载前端
// 开发：concurrently 同时起 vite（默认 5173）与 electron，窗口轮询等 vite 就绪
// 打包：acp-server 由 /app 托管 extraResources 里的 app-dist，生产/开发同构
import { app, BrowserWindow } from "electron";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
// 开发模式 = 项目根；打包后 = extraResources 布局 resources/game（可写数据必须在 asar 外）
const GAME_ROOT = isDev ? path.resolve(__dirname, "..") : path.join(process.resourcesPath, "game");
process.env.GROK_GAME_ROOT = GAME_ROOT;

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

// 打包后 GUI 启动不带 shell PATH，grok CLI 装在这些常见位置——必须先于 acp-server 的 spawn 生效。
// 主目录口径与 server 侧一致（`server/config.mjs` 的 `gameHome()`）：`BUNKITEN_HOME` 显式给定即替换
// `os.homedir()`——打包态 e2e 把整个 home 指到临时目录（PATH 前缀也得跟着走，否则临时 home 里的
// `grok` 垫片不生效、引擎起不来；Windows 上不能改 `USERPROFILE`，那会把 Chromium 弄崩）。
const HOME = process.env.BUNKITEN_HOME || os.homedir();
const PATH_PREFIXES = [path.join(HOME, ".grok", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
process.env.PATH = [...PATH_PREFIXES, process.env.PATH].filter(Boolean).join(path.delimiter);

/**
 * 轮询等一个 URL 可访问（开发态等 vite dev、启动链等都用它）。
 * @param {string} url 目标地址
 * @param {number} [timeoutMs] 上限（ms）
 * @returns {Promise<boolean>} 到点仍不可达时 false（调用方自己决定是继续还是放弃）
 */
async function waitUntilReachable(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* vite 未起，继续等 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const { startServer, stopServer } = await import("../server/acp-server.mjs");
const { port } = await startServer();

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#07080c",
    title: "剧本",
    show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
  });
  if (process.platform !== "darwin") win.removeMenu(); // mac 走 hiddenInset，其余平台去菜单栏
  win.once("ready-to-show", () => win.show());

  if (isDev) {
    if (!(await waitUntilReachable(DEV_URL))) console.error(`[electron] vite dev server 未就绪: ${DEV_URL}`);
    await win.loadURL(DEV_URL);
  } else {
    // 前端对 /api /events /prompt /img 的相对请求由同一 origin 的 acp-server 承接。
    // **尾斜杠是必须的**：产物 index.html 里的资源是相对路径（vite base "./"），文档 URL 少了它
    // 基准地址就落在站点根，./assets/… 会解析成 /assets/…（404）——窗口一片空白。
    // 服务端对 /app（无尾斜杠）也做了 302 兜底，两条入口都不会再踩这个坑。
    await win.loadURL(`http://127.0.0.1:${port}/app/`);
  }
}

// 自动更新：仅打包态启用（开发态没有 app-update.yml，也不该联网查更新）；动态 import 让 electron-updater
// 只在需要时才加载。electron-builder.yml 的 publish.github 是 update channel 的来源。
// 已知限制：未签名 mac 包无法自动更新（Squirrel.Mac 要求新旧包签名一致），本仓库默认发布的正是未签名包——
// 这条路径在 mac 上只会静默失败；升级方式以 docs/ARCHITECTURE.md「打包布局 / 已知限制」为准。
async function checkForUpdates() {
  if (!app.isPackaged || process.env.BUNKITEN_DISABLE_UPDATE === "1") return;
  try {
    const updater = await import("electron-updater"); // CJS 包：具名导出经 ESM 互操作暴露
    const autoUpdater = updater.autoUpdater ?? updater.default?.autoUpdater;
    if (!autoUpdater) return;
    await autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    // electron-updater 未随包分发（例如 --dir 预检产物）时静默降级，不影响启动
  }
}

app.whenReady().then(async () => {
  await createWindow();
  void checkForUpdates(); // 不阻塞开窗
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 优雅退出：等 acp-server 停 HTTP、kill grok 子进程后再真正退出，避免孤儿进程
let quitting = false;
app.on("will-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  Promise.resolve(stopServer())
    .catch(() => {})
    .finally(() => app.quit());
});
