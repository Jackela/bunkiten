// Electron 主进程：确定 GAME_ROOT / 数据根 → 迁移+seed-sync → 启动 acp-server → 开窗口加载前端
// 开发：concurrently 同时起 vite（默认 5173）与 electron，窗口轮询等 vite 就绪
// 打包：acp-server 由 /app 托管 extraResources 里的 app-dist，生产/开发同构
import { app, BrowserWindow, dialog } from "electron";
import path from "path";
import os from "os";
import fs from "fs";
import util from "util";
import { fileURLToPath } from "url";
import { prepareDataRoot } from "../server/data-root.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
// 开发模式 = 项目根；打包后 = extraResources 布局 resources/game（**只读内容根**：.grok/、app-dist、随包种子）
const GAME_ROOT = isDev ? path.resolve(__dirname, "..") : path.join(process.resourcesPath, "game");
process.env.GROK_GAME_ROOT = GAME_ROOT;

// 可写数据根（v1.14，ADR-0024）：打包态 = userData/game——覆盖安装只换 bundle，玩家数据不再随之蒸发。
// env `BUNKITEN_DATA_ROOT` 可覆盖（测试与回退用）。dev **不设**该 env——`server/config.mjs` 的 DATA_ROOT
// 回落 GAME_ROOT，写路径仍在项目根内，行为与改动前一字不差。
const dataRoot = process.env.BUNKITEN_DATA_ROOT || path.join(app.getPath("userData"), "game");

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

/**
 * 打包态日志镜像：把 console.log/warn/error 追加进 `<数据根>/logs/app.log`（ISO 时间戳前缀），
 * 让主进程与 acp-server 的输出在打包态也留得下来（`will-quit` 前就一直开着这个 fd）。
 * dev **不接**（会往项目根/仓库写文件）；目录与文件打不开就静默降级——日志落不了盘不该挡启动。
 * @param {string} root 数据根
 */
function mirrorConsoleToFile(root) {
  try {
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    const fd = fs.openSync(path.join(root, "logs", "app.log"), "a");
    /**
     * 把一行写进镜像文件（失败只吞掉自己，绝不冒泡进 console 造成递归）。
     * @param {"log"|"warn"|"error"} level 日志级别
     * @param {any[]} args 原样透传的 console 参数
     */
    const tee = (level, args) => {
      try {
        fs.writeSync(fd, `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`);
      } catch {
        /* 写文件失败静默降级 */
      }
    };
    // 先抓住原方法（避免包装后的自己再进 tee），再各包一层：echo 到控制台 + 追加进文件
    const log = console.log.bind(console);
    const warn = console.warn.bind(console);
    const error = console.error.bind(console);
    console.log = (...args) => {
      log(...args);
      tee("log", args);
    };
    console.warn = (...args) => {
      warn(...args);
      tee("warn", args);
    };
    console.error = (...args) => {
      error(...args);
      tee("error", args);
    };
  } catch {
    /* 数据根不可写：降级为纯控制台 */
  }
}

/** acp-server 的优雅停止句柄（bootstrap 成功后赋值；`will-quit` 收尾用） @type {null | (() => Promise<void>)} */
let stopServer = null;
/** 实际监听端口（bootstrap 成功后才有值；`createWindow` 与 `second-instance` 用） @type {number|null} */
let port = null;

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

/**
 * 启动链（拿不到单实例锁就不会走到这里）：打包态先备好数据根（迁移 + seed-sync + 日志镜像），
 * 再 import/startServer，最后挂 whenReady 开窗。任何一步的启动失败都在这里收敛成可诊断的弹窗 + 退出。
 */
async function bootstrap() {
  if (!isDev) {
    // 必须早于 import acp-server：`server/config.mjs` 在**模块加载期**读这个 env 决定 DATA_ROOT/WORLDS_ROOT/SESSION_FILE
    process.env.BUNKITEN_DATA_ROOT = dataRoot;
    mirrorConsoleToFile(dataRoot); // server 的日志也要进文件 → 镜像先接好
    try {
      // 一次性迁移 + 每次启动 seed-sync（幂等；只复制不删源，失败保底）。dev 不迁移（migrate 恒 true 只在此分支内）。
      const { migrated, seeded, updated } = prepareDataRoot({ dataRoot, bundleRoot: GAME_ROOT, migrate: true });
      console.log(`[electron] 数据根 ${dataRoot}（migrated=${migrated} seeded=${seeded} updated=${updated}）`);
    } catch (e) {
      // 数据根准备失败不挡启动：迁移只复制不删源，bundle 里那份还在；server 按数据根现状读
      console.error("[electron] 数据根准备失败（迁移/seed-sync）：", e);
    }
  }

  try {
    const mod = await import("../server/acp-server.mjs");
    stopServer = mod.stopServer;
    ({ port } = await mod.startServer());
  } catch (e) {
    // 启动失败要可诊断：dialog 在 ready 前调用受限，先确保 ready 再弹；消息给三条最可能的原因 + 数据目录
    await app.whenReady();
    dialog.showErrorBox(
      "无法启动 Bunkiten",
      [
        `原因：${e instanceof Error ? e.message : String(e)}`,
        "",
        "可能已有另一个实例在运行（请先把它关掉再试）；",
        "或端口 7800-7810 被占用（关掉占用这些端口的程序再试）。",
        `数据目录：${isDev ? GAME_ROOT : dataRoot}`,
      ].join("\n"),
    );
    app.exit(1);
    return;
  }

  app.whenReady().then(async () => {
    await createWindow();
    void checkForUpdates(); // 不阻塞开窗
  });
}

// 单实例锁：**必须在 import acp-server 之前**——第二个实例不迁移、不 seed、不抢 7800-7810 端口、不开窗，
// 直接退出（两个进程同时跑会抢端口并并发写同一份数据根）。拿不到锁时不进入 bootstrap。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 第二实例被拒后，操作系统把它的「想启动」转到这里：把已有窗口拉到前台；一个窗口都没有就补一个
  //（参照下方 activate 分支）。port 还没就绪时不开窗（启动窗口期极短，此时第二实例本就该静默退出）。
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else if (port !== null) {
      void createWindow();
    }
  });
  await bootstrap();
}

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
  // bootstrap 没走到 startServer（例如已经在弹启动失败框并 app.exit）时没有句柄，直接放行退出。
  Promise.resolve(stopServer ? stopServer() : undefined)
    .catch(() => {})
    .finally(() => app.quit());
});
