// server 全局配置（v1.7 拆模块，见 docs/ARCHITECTURE）：路径与端口是所有子模块的公共依赖，
// 独立成零依赖叶子模块——其余模块只 import 这里，互相之间不形成环。
// 开发模式 = 项目根；Electron 打包后由 main 进程注入资源目录
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const GAME_ROOT = process.env.GROK_GAME_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PORT = Number(process.env.PORT) || 7800;
const PORT_MAX_RETRY = 10;
const SESSION_FILE = path.join(GAME_ROOT, ".shell-session.json"); // 断线续档：记录 ACP sessionId
const WORLDS_ROOT = path.join(GAME_ROOT, "state", "worlds"); // 世界线：每世界一目录，另有 index.json 索引

/**
 * 用户主目录：`~/.bunkiten`（引擎凭据、服务目录缓存）、`~/.grok`/`~/.codex`（登录态探测）、
 * 会话图片根都挂在它下面。**测试/实验旋钮 `BUNKITEN_HOME`**：显式给定即整个替换 `os.homedir()`——
 * 打包态 e2e 要把 home 指到临时目录；而 Windows 上 `os.homedir()` 读的是 `USERPROFILE`，改那个键会连
 * Chromium 一起拖下水（实测打包态启动后即崩），所以链路里**只动这一个变量**（与 BUNKITEN_CODEX_ACP
 * 等旋钮同款：不设就一字不变）。
 * @returns {string} 本机用户主目录（或 BUNKITEN_HOME 指定的那个）
 */
export function gameHome() {
  return process.env.BUNKITEN_HOME || os.homedir();
}

export { GAME_ROOT, BASE_PORT, PORT_MAX_RETRY, SESSION_FILE, WORLDS_ROOT };
