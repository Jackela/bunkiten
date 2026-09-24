// 设置屏与启动屏的服务端面（v1.13 从入口的 startServer 闭包拆出）：
// 「凭据增删查测 + 引擎登录登出 + 服务目录读取」这一族——路由链只做转手，判定全在各自的模块里。
//
// 为什么它们住在一起：这七个函数共享同一条纪律——**每次调用都现读凭据**（`readCredentials()`），
// 不缓存任何一份在闭包里。玩家的钥匙随时可能在设置屏被改/被清，缓存一份就会让「保存后立刻测试连接」
// 读到旧值；而它们此前和 SSE、资产流水线、回合流水线挤在同一个 650+ 行的闭包里，
// 那条纪律只存在于每个函数的实现细节里、没有名字。
//
// 与入口的分工：入口持有**会话**（spawn/重启/回合），本模块只碰**磁盘上的配置**——
// 所以这里没有 restartAcp 的调用（「保存后立刻重启引擎」是客户端连打两个端点，见 routes.mjs）。
import { gameHome } from "./config.mjs";
import { PROVIDER_IDS } from "../shared/providers.mjs";
import {
  mergeCredentials,
  publicView,
  readCredentials,
  sanitizeErrorMessage,
  secretsOf,
  validateCredentialsPatch,
  writeCredentials,
} from "./credentials.mjs";
import { testImage, testLlm } from "./credentials-probe.mjs";
import { runLogout, startLogin } from "./engine-auth.mjs";
import { engineFor } from "./engines.mjs";
import { loadCatalog, revalidateCatalog } from "./providers-catalog.mjs";
import { errText } from "./errors.mjs";

/**
 * 设置面的对外形状（入口转手给路由链的就是它）。
 * @typedef {object} SettingsApi
 * @property {() => import("./credentials.mjs").CredentialsView} credentialsView 脱敏凭据视图（GET /api/credentials）
 * @property {() => Promise<{ok: boolean, error?: string, hint?: string}>} startEngineLogin 拉起玩家 CLI 的登录
 * @property {() => Promise<{ok: boolean, error?: string}>} logoutEngine 执行 CLI 登出并清游戏侧副本
 * @property {(patch: Record<string, any>, clear: string[]) => {ok: boolean, error?: string, view?: object}} updateCredentials 校验→合并→原子落盘
 * @property {(target: string) => Promise<import("./credentials-probe.mjs").ProbeResult>} testCredentials 测一次连接（结果已脱敏）
 * @property {() => {providers: object[], source: string, fetchedAt: string|null}} providersView 服务目录候选（stale-while-revalidate）
 * @property {() => Set<string>} allowedProviderIds 写路径的 provider 白名单（内置 ∪ 当前目录）
 */

/**
 * 造一套设置面。
 * @returns {SettingsApi} 各方法的语义见下面每处的文档（返回面与拆出前逐字一致）
 */
export function createSettingsApi() {
  /** @returns {import("./credentials.mjs").CredentialsView} 脱敏视图（永不回明文 key） */
  function credentialsView() {
    return publicView(readCredentials());
  }

  /**
   * GUI 的「登录」按钮（POST /api/engine/login）：把**玩家自己**的 CLI 登录流程拉起来（grok → `grok login`、
   * codex → 随包 codex 二进制的 `login`，都写在玩家自己的 home 里）。登录是长事务，这里只回执——
   * 客户端轮询 /api/auth 看玩家 home 里的登录产物出现没有（见 server/engine-auth.mjs）。
   * @returns {Promise<{ok: boolean, error?: string, hint?: string}>}
   */
  function startEngineLogin() {
    return startLogin({ engine: engineFor(readCredentials().engine), home: gameHome() });
  }

  /**
   * GUI 的「登出」按钮（POST /api/engine/logout）：执行 CLI 自己的登出（**全局动作**——终端里那份也会没，
   * GUI 已经先确认过），并把游戏侧的 codex 登录副本一并清掉。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  function logoutEngine() {
    return runLogout({ engine: engineFor(readCredentials().engine), home: gameHome() });
  }

  /**
   * 局部更新凭据：校验 → 合并 → 原子落盘 → 回脱敏视图。
   * @param {Record<string, any>} patch 待写入的分组字段（未出现的键不动；空串=清该字段）
   * @param {string[]} clear 要整组清空的组名
   * @returns {{ok: boolean, error?: string, view?: object}}
   */
  function updateCredentials(patch, clear) {
    const check = validateCredentialsPatch(patch, clear, allowedProviderIds());
    if (!check.ok) return { ok: false, error: check.error };
    try {
      const next = mergeCredentials(readCredentials(), patch, clear);
      writeCredentials(gameHome(), next);
      console.log(`[acp] credentials updated: llm=${next.llm.mode} image=${next.image.mode}`); // 只记模式，不记 key
      return { ok: true, view: publicView(next) };
    } catch (e) {
      return { ok: false, error: `写入凭据失败：${errText(e)}` };
    }
  }

  /**
   * 测一次连接（读当前凭据；错误信息再过一遍 secretsOf 脱敏——探针自己也会脱敏，这里是第二道保险）。
   * @param {string} target "llm" | "image"
   * @returns {Promise<{ok: boolean, status: number, ms: number, error?: string, detail?: string}>}
   */
  async function testCredentials(target) {
    const creds = readCredentials();
    const secrets = secretsOf(creds);
    const out = target === "llm" ? await testLlm(creds.llm) : await testImage(creds.image);
    return out.error ? { ...out, error: sanitizeErrorMessage(out.error, secrets) } : out;
  }

  /**
   * 服务目录候选（GET /api/providers 的响应主体）。只读视图：GUI 拿它画下拉，
   * **绝不据此改写玩家已存的 baseUrl / key**（见 server/providers-catalog.mjs 的铁律）。
   * 顺带做 stale-while-revalidate（ADR-0020 的「修订」段）：先**立即**回当前 `loadCatalog()` 的结果，
   * 再 fire-and-forget 触发一次后台刷新（`revalidateCatalog`——永不抛、非阻塞、进程内单飞、TTL/开关守卫照用）。
   * 效果：长开着的应用下次设置屏 GET 就会后台刷新，不必等重启（发布→可见的窗口第 ③ 项）。
   * @returns {{providers: object[], source: string, fetchedAt: string|null}} source = remote/cache/bundled
   */
  function providersView() {
    const view = loadCatalog({ root: gameHome() });
    void revalidateCatalog({ root: gameHome() });
    return view;
  }

  /**
   * POST /api/credentials 允许写入的 provider id 集合：**内置表 ∪ 当前目录**（remote/cache/bundled 都算）。
   * 为什么写路径要合并目录 id：目录可被远端更新注入新 id，`providersView` 已经把它下发给下拉了，
   * 不合并的话「不换版本用上新服务」在保存这一步就被 400「不在服务目录里」挡住——正是那条通道的核心收益不可达。
   * 为什么读路径不这么做（读路径也不能这么做）：读路径不能依赖目录可达（一次抓不到就回落内置表），
   * 否则玩家已存的远程 id 会被静默改写；所以读路径按「id 形态合法即保留」放宽（见 credentials.mjs 的 normalizeCredentials），
   * 写路径仍严校验。方向：credentials.mjs 不 import 本模块的目录（providers-catalog.mjs 已 import credentials.mjs
   * 的 CREDENTIALS_DIRNAME，反向会成环），故白名单从**调用点注入**，而不是让 credentials.mjs 自己拉目录。
   * @returns {Set<string>} 允许写入的 provider id
   */
  function allowedProviderIds() {
    const ids = new Set(PROVIDER_IDS);
    for (const p of loadCatalog({ root: gameHome() }).providers) ids.add(p.id);
    return ids;
  }

  return {
    credentialsView,
    startEngineLogin,
    logoutEngine,
    updateCredentials,
    testCredentials,
    providersView,
    allowedProviderIds,
  };
}
