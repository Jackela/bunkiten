// server 全局配置（v1.7 拆模块，见 docs/ARCHITECTURE）：路径与端口是所有子模块的公共依赖，
// 独立成零依赖叶子模块——其余模块只 import 这里，互相之间不形成环。
// 开发模式 = 项目根；Electron 打包后由 main 进程注入资源目录
import path from "path";
import { fileURLToPath } from "url";

const GAME_ROOT = process.env.GROK_GAME_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PORT = Number(process.env.PORT) || 7800;
const PORT_MAX_RETRY = 10;
const SESSION_FILE = path.join(GAME_ROOT, ".shell-session.json"); // 断线续档：记录 ACP sessionId
const WORLDS_ROOT = path.join(GAME_ROOT, "state", "worlds"); // 世界线：每世界一目录，另有 index.json 索引

export { GAME_ROOT, BASE_PORT, PORT_MAX_RETRY, SESSION_FILE, WORLDS_ROOT };
