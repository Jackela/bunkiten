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

// 打包后 GUI 启动不带 shell PATH，grok CLI 装在这些常见位置——必须先于 acp-server 的 spawn 生效
const PATH_PREFIXES = [path.join(os.homedir(), ".grok", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
process.env.PATH = [...PATH_PREFIXES, process.env.PATH].filter(Boolean).join(path.delimiter);

async function waitUntilReachable(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* vite 未起，继续等 */ }
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
    minWidth: 960,
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
    // 前端对 /api /events /prompt /img 的相对请求由同一 origin 的 acp-server 承接
    await win.loadURL(`http://127.0.0.1:${port}/app`);
  }
}

app.whenReady().then(createWindow);

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
  Promise.resolve(stopServer()).catch(() => {}).finally(() => app.quit());
});
