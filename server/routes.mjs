// HTTP 路由链（v1.7 拆模块）：createRequestHandler(ctx) 返回 (req,res) 处理器，分支顺序与响应体
// 与拆模块前的 startServer 内联实现逐字一致。路由分派保持 if-chain（先匹配先赢，路径少、
// 且部分前缀路由（/app/）依赖 startsWith，表驱动没有净收益）。
// ctx 是入口 startServer 的闭包能力注入：SSE 客户端集合、发提示词、画廊/落盘、会话图片定位、
// 当前剧本 id 与 sessionId（getter——快照与嗅探会改它们，路由每次读最新值）。
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { AUDIO_MIME, AUDIO_REL_RE } from "../shared/protocol.mjs";
import { engineById } from "../shared/engines.mjs";
// 剧本/资产/音频一律以**可写数据根**为根（v1.14，ADR-0024）：随包的 presets/ 只是种子，
// 玩家看到与引擎写的是数据根里那一份（config.DATA_ROOT，dev 下与 GAME_ROOT 同一个）。GAME_ROOT 只留
// 只读内容（.grok/、app-dist，后者在 http-util.mjs 的 resolveAppDist 里）。
import { DATA_ROOT, BASE_PORT, WORLDS_ROOT, gameHome } from "./config.mjs";
import { isCrossSiteRequest, readBodyText, MIME, resolveAppDist } from "./http-util.mjs";
import { withinRoot } from "./fs-guard.mjs";
import {
  PRESET_ID_RE,
  LEGACY_ASSET_RE,
  ASSET_DELETE_FILE_RE,
  presetIdFromPath,
  legacyAssetCandidates,
  resolvePersistPreset,
} from "./assets.mjs";
import {
  parseFrontmatter,
  scanPresets,
  assetTargetFile,
  buildPresetBundle,
  importPresetBundle,
  deletePreset,
  PRESET_IMPORT_MAX_BYTES,
} from "./presets.mjs";
import { scanPresetAudio } from "./audio.mjs";
import { readCredentials, llmReady } from "./credentials.mjs";
import { engineFor } from "./engines.mjs";
import { WORLD_ID_RE, TREE_FILE, readSnapshot, readSnapshots, readTurnLogs } from "./snapshots.mjs";
import {
  moveToTrash,
  readWorldsIndex,
  listWorlds,
  createWorld,
  forkWorld,
  restoreWorld,
  updateWorld,
  labelSnapshot,
  exportWorld,
  exportAllWorlds,
  importWorld,
  deleteWorld,
  listTrash,
  restoreTrash,
} from "./worlds.mjs";
import { stateViewFor } from "./state-view.mjs";

/**
 * 入口闭包注入的能力集（startServer → 路由链；currentPresetId/sessionId 是 getter，每次读最新值）。
 * @typedef {Object} HandlerContext
 * @property {import("./sse.mjs").Broadcaster} sse SSE 广播器（/events 注册；收尾由入口的 closeAll 做）
 * @property {(text: string) => Promise<{ok: boolean, error?: string}>} sendPrompt
 * @property {(presetId: string) => Array<object>} listAssets 画廊数据（registry + 磁盘扫描）
 * @property {(type: string, rawName: string, src: string, presetId?: string, srcRel?: string) => boolean} persistAssetFromFile
 * @property {(name: string) => string|null} resolveImage 会话图片定位（ACP 会话闭包）
 * @property {(rel: string) => void} warnLegacyPathOnce 旧档路径告警（去重）
 * @property {string} currentPresetId 嗅探出的当前剧本 id
 * @property {string|null} sessionId 当前 ACP 会话 id
 * @property {() => object} credentialsView 引擎凭据的脱敏视图（**永不含明文 key**）
 * @property {(patch: {engine?: string, llm?: Record<string, unknown>, image?: Record<string, unknown>}, clear: string[]) => {ok: boolean, error?: string, view?: object}} updateCredentials
 *   局部更新凭据（校验 → 合并 → 原子落盘；空串=清该字段，clear 里的组整组回默认）
 * @property {(target: string) => Promise<{ok: boolean, status: number, ms: number, error?: string, detail?: string}>} testCredentials
 *   真连一次（LLM 走 /models 或最小 completion；图片走一次最小生成）
 * @property {(opts?: {force?: boolean}) => Promise<{ok: boolean, error?: string}>} restartEngine 引擎会话重启
 *   （保存 key / 切引擎后一键生效；`force:true` 时正在演绎中也重启——先停这一回合再换会话，见入口 restartAcp）
 * @property {() => boolean} cancelTurn 停止当前回合（发 `session/cancel` 通知 + 作废本地在途回合）；
 *   返回是否真的停了一个在途回合（空闲时回 false，不是错误）
 * @property {() => {busy: boolean, turn: number}} engineStatus 引擎状态（SSE 断线重连的对账面）
 * @property {() => Promise<{ok: boolean, error?: string, hint?: string}>} startEngineLogin
 *   把玩家自己的 CLI 登录流程拉起来（回执式；结果靠客户端轮询 `/api/auth`，见 server/engine-auth.mjs）
 * @property {() => Promise<{ok: boolean, error?: string}>} logoutEngine
 *   执行 CLI 自己的登出（**全局动作**：玩家终端里那份也会没；GUI 已先确认）
 * @property {() => {providers: object[], source: string, fetchedAt: string|null}} providersView 服务目录候选（设置屏下拉数据；
 *   source 是本条 providers 的来源：remote/cache/bundled，见 server/providers-catalog.mjs 的 loadCatalog）
 */

/**
 * 一条 JSON 响应（v1.10 起的新路由共用；既有路由保留各自就地写法，不做无谓改动）。
 * @param {import("http").ServerResponse} res 响应对象
 * @param {number} code HTTP 状态
 * @param {object} obj 响应体
 */
function sendJSON(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/**
 * 在文件管理器里打开一个目录（v1.14 的 POST /api/open-dir）：darwin `open` / win `explorer` /
 * 其余 `xdg-open`，一律 `detached + stdio:ignore + unref`——拉起来的文件管理器不该被我们等，
 * 也不该在它报错时冒成未捕获异常。**参数按数组传**（目录是进程内常量的 DATA_ROOT，不为拼接留口子）。
 * 目录不存在时先建一个：空目录也能开（否则 dev 态点「打开日志目录」什么都不会发生，那比不提供更糟）。
 * 起不来（没装 xdg-open / 无图形会话）静默：这是便利入口，不是功能路径。
 * @param {string} dir 目标目录绝对路径
 */
function openDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来也照样试着开：可能是权限问题，但打开既有目录仍然有意义 */
  }
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // 起不来就静默（端点的 ok 说的是「已发出打开请求」）
    child.unref();
  } catch {
    /* spawn 本身抛（极罕见）：同上静默 */
  }
}

// ---------- 剧本体检（v1.8）：GET /api/presets/check?id=<id> 的作者侧 doctor 直出 ----------
// 判定只有一份：scripts/doctor.mjs 的 checkPreset（`npm run doctor` 的核，作者侧 CLI 与这里 import 同一个函数）。
// 本模块只做三件事：id 白名单 → 剧本目录存在性 → 把 DoctorResult 归一成客户端画得出块的契约。

/**
 * 体检响应里的一条结论（与 src/lib/acp.ts 的 PresetCheckItem 对齐）。
 * @typedef {Object} PresetCheckItem
 * @property {"ok"|"warn"|"error"} level 严重度（doctor 的 Finding.level 原样，不改口径）
 * @property {string} group 组名（doctor 七组 + 「preset.md」缺档；见 PRESET_CHECK_GROUPS）
 * @property {string} label 那一行的中文原文（doctor 逐字产出，屏上照抄）
 */

/**
 * GET /api/presets/check?id=<id> 的响应体（与 src/lib/acp.ts 的 PresetCheckResult 对齐）。
 * @typedef {Object} PresetCheckResult
 * @property {boolean} ok 无 error 级问题时为 true（warning 不影响；⟺ doctor 的 errors === 0）
 * @property {string} id 剧本 id（frontmatter id；缺失/非法时 doctor 回落目录名）
 * @property {string} title 剧本标题（frontmatter title；读不到回落 id）
 * @property {PresetCheckItem[]} items 逐条结论，顺序与 doctor 的报告一致
 */

/**
 * findings → 组名的归属表：**只列 doctor 自己写死的行首字面**，不复制任何检查逻辑（判定仍只有 doctor 一份）。
 * 为什么需要它：checkPreset 把七组 findings `flat()` 成扁平数组，组名只活在各组干净时的 ok 行与它自己的注释里；
 * 客户端要按组画块、又不能在屏上丢条目，所以这里把行首前缀映射回组名；表外的条目归「其他」而不是被丢掉
 * （宁可在屏上看到一条没归类的行，也不要静默吞掉一条 error）。
 * 组名取 doctor JSDoc 里的用法：frontmatter / theme / 正文小节 / 封面 / 资产命名 / 孤儿素材 / 音频。
 */
const PRESET_CHECK_GROUPS = [
  { group: "preset.md", re: /^preset\.md 缺失/ },
  { group: "frontmatter", re: /^(frontmatter|id「)/ },
  { group: "theme", re: /^theme/ },
  { group: "正文小节", re: /^(正文|`# 主要角色`|角色「)/ },
  { group: "封面", re: /^(封面|只有 cover\.jpeg|缺封面)/ },
  { group: "资产命名", re: /^资产/ },
  { group: "孤儿素材", re: /^孤儿素材/ },
  { group: "音频", re: /^音频/ },
];

/**
 * 一条 finding 归哪个组（组名归属的唯一判定点，presetCheckResult 消费）。
 * @param {string} message doctor 产出的行原文
 * @returns {string} 组名；表外归「其他」
 */
function presetCheckGroupOf(message) {
  const line = String(message ?? "");
  for (const { group, re } of PRESET_CHECK_GROUPS) if (re.test(line)) return group;
  return "其他";
}

/**
 * 把 doctor 的 DoctorResult 归一成客户端契约（纯函数，导出给 tests/server.test.ts 直测）。
 * 只搬不改：`level` 与 `label`（行原文）逐字来自 doctor，`ok` = 没有任何 error（与 doctor 的退出码同判据）。
 * @param {{id?: string, findings?: {level: "ok"|"warn"|"error", message: string}[]}} doctorOut checkPreset 的返回值
 * @param {string} [title] 剧本标题（frontmatter title；缺省回落 id）
 * @returns {PresetCheckResult}
 */
export function presetCheckResult(doctorOut, title) {
  const id = String(doctorOut?.id ?? "");
  const items = (doctorOut?.findings ?? []).map((f) => ({
    level: f.level,
    group: presetCheckGroupOf(f.message),
    label: f.message,
  }));
  return { ok: !items.some((i) => i.level === "error"), id, title: title || id, items };
}

/**
 * 眉标用的剧本标题：preset.md 的 frontmatter `title`（读不到/没写就回落 id 自己）。
 * 只取一个展示用键——体检判定仍在 doctor，这里不碰任何检查口径。
 * @param {string} presetDir 剧本目录绝对路径
 * @param {string} id 请求里的剧本 id（回落值）
 * @returns {string}
 */
function presetTitle(presetDir, id) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(presetDir, "preset.md"), "utf8");
  } catch {}
  const fm = text ? parseFrontmatter(text) : null;
  const title = typeof fm?.title === "string" ? fm.title.trim() : "";
  return title || id;
}

/**
 * GET /api/presets/check 的路由判定（纯函数，root 与 checkPreset 都可注入以便单测：tests/server.test.ts 用
 * tmp 根 + scripts/doctor.mjs 的真函数直测，不起 HTTP）。
 * 状态码与既有端点同口径：id 缺失/非法 400（坏请求）、剧本目录不存在 404（真路过的 id）、
 * doctor 模块不可用 503（scripts/ 不进打包 layout，见 docs/ARCHITECTURE.md「已知限制」）。
 * @param {string} id 查询串里的剧本 id
 * @param {string} root 游戏根目录
 * @param {((presetDir: string, root: string) => any) | null | undefined} check doctor 的 checkPreset（缺省=模块没拿到 → 503）
 * @returns {{code: number, body: PresetCheckResult | {ok: false, error: string}}}
 */
export function presetCheckView(id, root, check) {
  if (!PRESET_ID_RE.test(id)) return { code: 400, body: { ok: false, error: "缺少或非法的 id 参数" } };
  const presetDir = path.join(root, "presets", id);
  if (!fs.existsSync(presetDir)) return { code: 404, body: { ok: false, error: "剧本不存在" } };
  if (typeof check !== "function") {
    return { code: 503, body: { ok: false, error: "剧本体检不可用：scripts/doctor.mjs 只在源码树里" } };
  }
  return { code: 200, body: presetCheckResult(check(presetDir, root), presetTitle(presetDir, id)) };
}

/**
 * doctor 模块的惰性加载：`scripts/doctor.mjs` 是**源码树里的作者工具**（electron-builder 的 files 不含
 * scripts/，它自己还要 import `src/theme.ts`），所以静态 import 会让打包态启动即挂——这里按需加载，
 * 拿不到就由 presetCheckView 回 503 说明，server 照常起。
 * 注：doctor 反向 import 本目录的 acp-server.mjs（解析口径复用）形成 ESM 环，它顶层不读 acp-server 的
 * 任何绑定（只在函数体内用），环安全——tests/doctor.test.ts 里是同一个环。
 * @returns {Promise<(presetDir: string, root: string) => any>} checkPreset
 */
/** @type {Promise<(presetDir: string, root: string) => any>|null} */
let doctorPromise = null;
function loadCheckPreset() {
  if (!doctorPromise) {
    doctorPromise = import("../scripts/doctor.mjs").then(
      (m) => m.checkPreset,
      (e) => {
        doctorPromise = null; // 失败不缓存：源码树补齐/修好后无需重启 server
        throw e;
      },
    );
  }
  return doctorPromise;
}

/**
 * /api/presets/check 的响应（异步只因为 doctor 模块要惰性 import；判定与响应形状都在 presetCheckView）。
 * @param {string} id 查询串里的剧本 id
 * @param {import("http").ServerResponse} res 响应对象
 * @returns {Promise<void>}
 */
async function respondPresetCheck(id, res) {
  const check = await loadCheckPreset().catch(() => null);
  const out = presetCheckView(id, DATA_ROOT, check);
  sendJSON(res, out.code, out.body);
}

/**
 * @param {HandlerContext} ctx 入口闭包注入
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => void}
 */
export function createRequestHandler(ctx) {
  return (req, res) => {
    // http.Server 的请求必有 url（Node 只在极特殊的内部场景才缺席）——cast 表达这个平台不变式
    const url = new URL(/** @type {string} */ (req.url), `http://localhost:${BASE_PORT}`);

    // 来源校验（统一入口，先于所有路由）：跨站请求一律 403（无 Origin 的 curl/测试/Electron 同源请求放行）
    if (isCrossSiteRequest(req)) {
      sendJSON(res, 403, { error: "跨站请求被拒绝" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      // 首页导览：把 v1.6 的新路由（音频列表/直服、历史快照、世界导出）与 v1.14 的一批（回合取消、
      // 引擎状态、回合日志、回收站、剧本删除、全量导出、打开目录）一并列上，方便 curl 排查
      res.end(
        "galgame acp-server running. API: /api/presets(GET,POST:import|delete) /api/presets/export?id= /api/presets/check?id= /api/auth /api/providers /api/assets?preset=(GET,POST删除) " +
          "/api/audio?preset= /api/worlds(POST: create/fork/restore/update/delete/import) /api/worlds/export?worldId=|?all=1 /api/history?worldId=[&seq=] " +
          "/api/tree /api/state?worldId= /api/logs?worldId= /api/trash(GET,POST:restore) /api/credentials(GET,POST) /api/credentials/test " +
          "/api/engine/restart /api/engine/cancel /api/engine/status /api/open-dir " +
          "/events(SSE) /prompt(POST) /img?p=&t=&n=&preset= /audio?p=. 打包前端见 /app。",
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/presets") {
      sendJSON(res, 200, scanPresets(DATA_ROOT));
      return;
    }

    // 剧本导出（v1.7）：GET /api/presets/export?id=<id> → 附件下载 <id>.preset.json（base64 图片/音频在包体里）
    if (req.method === "GET" && url.pathname === "/api/presets/export") {
      const id = url.searchParams.get("id") || "";
      const out = buildPresetBundle(DATA_ROOT, id); // 内部已过 PRESET_ID_RE + preset.md 存在性校验
      if (out.error) {
        // 目录/ preset.md 不存在与「id 非法」分开说：前者 404（真路过期的 id），后者 400（坏请求）
        const status = out.error === "剧本不存在" ? 404 : 400;
        sendJSON(res, status, { ok: false, error: out.error });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${id}.preset.json"`,
      });
      res.end(JSON.stringify(out.bundle));
      return;
    }

    // 剧本体检（v1.8）：GET /api/presets/check?id=<id> → 作者侧 doctor 的体检结果（判定见 presetCheckView）。
    // 响应形状：{ ok, id, title, items: [{ level:"ok"|"warn"|"error", group, label }] }——
    // items 顺序与 doctor 的报告一致（各组连着），查不出来就是 400/404/503 + { ok:false, error }。
    if (req.method === "GET" && url.pathname === "/api/presets/check") {
      void respondPresetCheck(url.searchParams.get("id") || "", res);
      return;
    }

    // 剧本写入（v1.7 导入 / v1.14 删除）：导入包里是 base64 图片/音频，5MB 不够用——本端点单独放宽到
    // 50MB（readBodyText 其余调用点仍走 5MB 缺省）。删除的 body 极小，同一上限是路径级的，不额外开洞。
    if (req.method === "POST" && url.pathname === "/api/presets") {
      readBodyText(
        req,
        res,
        (body) => {
          // JSON.parse 边界：请求体形状未知，各 action 分支自行取字段并校验
          let payload = /** @type {any} */ ({});
          try {
            payload = JSON.parse(body) || {};
          } catch {}
          const action = String(payload.action || "");
          if (action === "import") {
            const out = importPresetBundle(DATA_ROOT, payload.bundle);
            sendJSON(
              res,
              out.error ? 400 : 200,
              out.error ? { ok: false, error: out.error } : { ok: true, id: out.id },
            );
            return;
          }
          if (action === "delete") {
            // 整目录挪进回收站（v1.14，ADR-0014 的「恢复 UI」修订）：id 白名单、存在性、随包种子不可删
            // 三条判定都在 presets.deletePreset 里，路由只做参数归一与状态码分流——人话原因原样透给客户端
            const out = deletePreset(DATA_ROOT, String(payload.id || ""));
            sendJSON(
              res,
              out.error ? 400 : 200,
              out.error ? { ok: false, error: out.error } : { ok: true, trashed: out.trashed === true },
            );
            return;
          }
          sendJSON(res, 400, { ok: false, error: "未知动作" });
        },
        PRESET_IMPORT_MAX_BYTES,
      );
      return;
    }

    // 画廊数据：资产随剧本走，必须指明剧本（缺失或非法 → 400，绝不给全局池）
    if (req.method === "GET" && url.pathname === "/api/assets") {
      const presetId = url.searchParams.get("preset") || "";
      if (!PRESET_ID_RE.test(presetId)) {
        sendJSON(res, 400, { error: "缺少或非法的 preset 参数" });
        return;
      }
      sendJSON(res, 200, ctx.listAssets(presetId));
      return;
    }

    // 素材批量删除（CONTRACTS §3）：只删 presets/<id>/assets/ 下的单层 jpe?g，封面（cover.jpg）不可删
    if (req.method === "POST" && url.pathname === "/api/assets") {
      readBodyText(req, res, (body) => {
        // JSON.parse 边界：同 /api/presets，字段在下方逐个校验
        let payload = /** @type {any} */ ({});
        try {
          payload = JSON.parse(body) || {};
        } catch {}
        const json = /** @param {number} code @param {object} obj */ (code, obj) => {
          sendJSON(res, code, obj);
        };
        if (String(payload.action || "") !== "delete") return json(400, { error: "未知动作" });
        const presetId = String(payload.preset || "");
        const file = String(payload.file || "");
        // preset 过白名单、file 单层且是 jpe?g（防穿越）；封面不在 assets/ 也不允许删
        if (!PRESET_ID_RE.test(presetId) || !ASSET_DELETE_FILE_RE.test(file) || file === "cover.jpg") {
          return json(400, { error: "参数不合法" });
        }
        const abs = path.join(DATA_ROOT, "presets", presetId, "assets", file);
        if (!fs.existsSync(abs)) return json(404, { error: "素材不存在" });
        try {
          // 删除进回收站（v1.7）：rename 进 state/trash/，EXDEV 等 rename 失败由 moveToTrash 回退直删；
          // label 带上 presetId——跨剧本同名素材在 trash 里靠它区分该挪回哪个剧本
          const t = moveToTrash(DATA_ROOT, ["presets", presetId, "assets", file], presetId);
          console.log(`[acp] asset deleted: presets/${presetId}/assets/${file}${t.trashed ? " → state/trash" : ""}`);
          return json(200, { ok: true, trashed: t.trashed });
        } catch {
          // trash 与直删都没能完成（EACCES/EPERM/EBUSY…）才是真失败 → 500
          return json(500, { error: "素材删除失败" });
        }
      });
      return;
    }

    // 音频清单（CONTRACTS §1）：preset 必填且过白名单（与 /api/assets 同款；音频随剧本站，不给全局池）
    if (req.method === "GET" && url.pathname === "/api/audio") {
      const presetId = url.searchParams.get("preset") || "";
      if (!PRESET_ID_RE.test(presetId)) {
        sendJSON(res, 400, { error: "缺少或非法的 preset 参数" });
        return;
      }
      sendJSON(res, 200, { items: scanPresetAudio(presetId, DATA_ROOT) });
      return;
    }

    // 逐轮状态快照（CONTRACTS §2）：列表只回元信息；带 &seq=<n> 时**只读目标文件**并只回该条（回退预览用）。
    // 带 seq 的调用很热（预览/重建），不能为了附 files 把整个 history 目录全量 parse。
    if (req.method === "GET" && url.pathname === "/api/history") {
      const worldId = url.searchParams.get("worldId") || "";
      if (!WORLD_ID_RE.test(worldId)) {
        sendJSON(res, 400, { error: "缺少或非法的 worldId 参数" });
        return;
      }
      // 玩家给存档点起的名字（v1.12）住在索引的世界条目上，读的时候并进快照元信息——
      // 快照文件本身保持 append-only 的引擎真相，名字只是展示层（与世界的 label/note 同层）
      const snapLabels = readWorldsIndex(WORLDS_ROOT).find((e) => e.worldId === worldId)?.snapshotLabels ?? {};
      const seqParam = url.searchParams.get("seq");
      if (seqParam != null && seqParam !== "") {
        const one = readSnapshot(worldId, seqParam, WORLDS_ROOT);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({ worldId, snapshots: one ? [{ ...one, label: snapLabels[String(one.seq)] ?? "" }] : [] }),
        );
        return;
      }
      const snapshots = readSnapshots(worldId, WORLDS_ROOT).map((s) => ({
        seq: s.seq,
        at: s.at,
        kind: s.kind,
        nodeId: s.nodeId,
        chapterNo: s.chapterNo,
        label: snapLabels[String(s.seq)] ?? "",
      }));
      sendJSON(res, 200, { worldId, snapshots });
      return;
    }

    // 回合原文日志（v1.14，A 泳道的 readTurnLogs）：GET /api/logs?worldId=[&before=&limit=]
    // → `{entries:[{seq,at,prompt,text,cancelled?,error?}], nextBefore}`（**最新在前**，`before` 翻页）。
    // 读的是 state/worlds/<w>/logs/NNNN.json（与 history/ 平级的 append-only 回溯面，不进导出包）——
    // 客户端用它做「回想」的分页历史，`cancelled`/`error` 两个字段是 B 泳道写下的留痕。
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const worldId = url.searchParams.get("worldId") || "";
      if (!WORLD_ID_RE.test(worldId)) {
        sendJSON(res, 400, { error: "缺少或非法的 worldId 参数" });
        return;
      }
      // before/limit 交给 readTurnLogs 归一（它按数字语义收口径），这里只把缺省表达成 undefined/null
      const beforeRaw = url.searchParams.get("before");
      const limitRaw = url.searchParams.get("limit");
      sendJSON(
        res,
        200,
        readTurnLogs({
          root: WORLDS_ROOT,
          worldId,
          before: beforeRaw == null || beforeRaw === "" ? null : Number(beforeRaw),
          limit: limitRaw == null || limitRaw === "" ? undefined : Number(limitRaw),
        }),
      );
      return;
    }

    // 世界导出（CONTRACTS §2）：GET /api/worlds/export?worldId=<id> → 附件下载 <worldId>.world.json
    // v1.14 加 `?all=1`：一次性打包**全部**世界线（`{format:"bunkiten-worlds", version:1, exportedAt, worlds:[…]}`，
    // 客户端的一条备份入口；导入侧（A 泳道的 importWorld）认这个容器，循环导入）。
    if (req.method === "GET" && url.pathname === "/api/worlds/export") {
      if (url.searchParams.get("all") === "1") {
        const bundle = exportAllWorlds(WORLDS_ROOT);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="bunkiten-worlds.json"',
        });
        res.end(JSON.stringify(bundle));
        return;
      }
      const worldId = url.searchParams.get("worldId") || "";
      const out = exportWorld(WORLDS_ROOT, worldId); // 内部已过 WORLD_ID_RE + 存在性校验
      if (out.error) {
        sendJSON(res, 400, { ok: false, error: out.error });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${worldId}.world.json"`,
      });
      res.end(JSON.stringify(out.bundle));
      return;
    }

    // 世界线列表（可选 ?preset=<id> 过滤；chapterNo/lastPlayed 由磁盘自愈）
    if (req.method === "GET" && url.pathname === "/api/worlds") {
      sendJSON(res, 200, { worlds: listWorlds(WORLDS_ROOT, url.searchParams.get("preset")) });
      return;
    }

    // 世界线管理：create=建新世界（分配 id、写索引）；fork=在指定节点手动分叉（不推演）；delete=删除
    if (req.method === "POST" && url.pathname === "/api/worlds") {
      readBodyText(req, res, (body) => {
        // JSON.parse 边界：同 /api/presets，字段在下方逐个校验
        let payload = /** @type {any} */ ({});
        try {
          payload = JSON.parse(body) || {};
        } catch {}
        const action = String(payload.action || "");
        // 各 action 的返回形状互不相同（createWorld 返回条目、restore 返回 backupSeq、delete 返回 trashed…），
        // 路由只做 `out.error` 分流与 JSON 透传——按 any 收口，形状由各函数自己的 JSDoc 保证
        /** @type {any} */
        let out;
        if (action === "create") {
          const id = String(payload.preset || "");
          out = createWorld(WORLDS_ROOT, id, scanPresets().presets.find((p) => p.id === id)?.title || "");
        } else if (action === "fork") {
          const worldId = String(payload.worldId || "");
          const nodeId = String(payload.nodeId || "");
          // seq 可选：显式给出时优先用那条快照做精确源（CONTRACTS §2）
          const seq = payload.seq == null || payload.seq === "" ? null : Number(payload.seq);
          const seqOk = seq == null || (Number.isInteger(seq) && seq >= 1);
          out =
            WORLD_ID_RE.test(worldId) && nodeId && seqOk
              ? forkWorld(WORLDS_ROOT, worldId, nodeId, seq)
              : { error: "参数不合法" };
        } else if (action === "restore") {
          const worldId = String(payload.worldId || "");
          const seq = Number(payload.seq);
          out =
            WORLD_ID_RE.test(worldId) && Number.isInteger(seq)
              ? restoreWorld(WORLDS_ROOT, worldId, seq)
              : { error: "参数不合法" };
        } else if (action === "update") {
          const worldId = String(payload.worldId || "");
          const patch = {};
          if ("label" in payload) patch.label = payload.label;
          if ("note" in payload) patch.note = payload.note;
          out = WORLD_ID_RE.test(worldId) ? updateWorld(WORLDS_ROOT, worldId, patch) : { error: "参数不合法" };
        } else if (action === "labelSnapshot") {
          // 给存档点起名（v1.12）：名字落在索引的世界条目上（snapshotLabels），不碰 append-only 的快照文件
          out = labelSnapshot(WORLDS_ROOT, String(payload.worldId || ""), payload.seq, payload.label);
        } else if (action === "import") {
          out = importWorld(WORLDS_ROOT, payload.bundle);
        } else if (action === "delete") {
          const worldId = String(payload.worldId || "");
          if (!WORLD_ID_RE.test(worldId)) {
            out = { error: "参数不合法" };
          } else {
            try {
              out = deleteWorld(WORLDS_ROOT, worldId);
            } catch {
              // moveToTrash 的直删回退也失败（EACCES/EPERM/EBUSY…）才是真失败 → 500；
              // 绝不让异常冒泡出 readBodyText 回调（Electron 主进程无 uncaughtException 兜底，冒泡即闪退）。
              // 注：json 助手只在 /api/assets 分支里定义，这里就地写响应，别引用不存在的闭包。
              sendJSON(res, 500, { ok: false, error: "世界删除失败" });
              return;
            }
          }
        } else {
          out = { error: "未知动作" };
        }
        const ok = !out.error;
        sendJSON(res, ok ? 200 : 400, { ok, ...out });
      });
      return;
    }

    // 回收站（v1.14，ADR-0014 的「恢复 UI」修订）：删掉的世界线目录与素材文件都躺在 state/trash/ 里。
    // GET 列条目（id/kind/name/presetId?/at），POST {action:"restore", id} 把某一条挪回原位。
    // 两类条目的判定与恢复动作都在 worlds.listTrash/restoreTrash，路由只做参数归一与状态码分流。
    if (req.method === "GET" && url.pathname === "/api/trash") {
      sendJSON(res, 200, { entries: listTrash(WORLDS_ROOT) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/trash") {
      readBodyText(req, res, (body) => {
        // JSON.parse 边界：同 /api/presets，字段在下方逐个校验
        let payload = /** @type {any} */ ({});
        try {
          payload = JSON.parse(body) || {};
        } catch {}
        if (String(payload.action || "") !== "restore") {
          sendJSON(res, 400, { ok: false, error: "未知动作" });
          return;
        }
        const out = restoreTrash(WORLDS_ROOT, String(payload.id || ""));
        sendJSON(res, out.error ? 400 : 200, out.error ? { ok: false, error: out.error } : { ok: true });
      });
      return;
    }

    // 剧情树原文（剧情图屏解析用）：?worldId=<id>，缺省 main
    if (req.method === "GET" && url.pathname === "/api/tree") {
      const worldId = url.searchParams.get("worldId") || "main";
      let markdown = null;
      if (WORLD_ID_RE.test(worldId)) {
        try {
          markdown = fs.readFileSync(path.join(WORLDS_ROOT, worldId, TREE_FILE), "utf8");
        } catch {}
      }
      if (markdown === null) {
        sendJSON(res, 404, { error: "剧情树不存在" });
        return;
      }
      sendJSON(res, 200, { worldId, markdown });
      return;
    }

    // 角色面板（v1.7）：读该世界 state.md 并容错解析；?worldId=<id> 必填（缺失/非法 400，无文件 404）
    if (req.method === "GET" && url.pathname === "/api/state") {
      const out = stateViewFor(url.searchParams.get("worldId") || "");
      sendJSON(res, out.code, out.body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth") {
      const creds = readCredentials();
      const entry = engineById(creds.engine);
      // 登录态探测按引擎（v1.11，docs/adr/0022）：grok 看 `~/.grok/auth.json`；codex 看玩家自己的
      // `~/.codex/auth.json`——那正是「沿用终端登录」复用的来源（server/engines.mjs 的 loginFile）。
      const loggedIn = fs.existsSync(engineFor(creds.engine).loginFile(gameHome()));
      // hasCredentials（v1.10/v1.11）：**该引擎支持**自备 key 且 LLM 侧配全时，boot 屏不必再要求终端登录
      const hasCredentials = entry?.byok === true && llmReady(creds);
      // canLogin（v1.11 收尾）：这个引擎的登录入口在不在（grok CLI 在不在 PATH / 随包 codex 在不在）——
      // 启动屏与设置屏据此禁用按钮并给一句人话，而不是点了才报错
      const canLogin = engineFor(creds.engine).authAvailable({ home: gameHome() });
      sendJSON(res, 200, { loggedIn, hasCredentials, engine: creds.engine, canLogin });
      return;
    }

    // 服务目录（v1.10，docs/adr/0020）：给设置屏画下拉候选。`source` 是**本条响应里 providers 的来源**
    //（启动期刚抓到远端是 "remote"、读本地缓存 "cache"、内置兜底 "bundled"）；`fetchedAt` 为抓取时刻或 null。
    // 目录**只喂候选**：绝不据此改写玩家已存的 baseUrl / key（那些走 /api/credentials）。
    if (req.method === "GET" && url.pathname === "/api/providers") {
      sendJSON(res, 200, ctx.providersView());
      return;
    }

    // ---------- 引擎凭据（v1.10，docs/adr/0019）：GUI 里填的自备 key ----------
    // 四个端点的共同纪律：**响应永不回明文 key**（出口一律 credentialsView 的脱敏形状，
    // 见 server/credentials.mjs 的 publicView）。两道闸（跨站 403 / body 5MB→413）由本函数开头与
    // readBodyText 的缺省上限统一覆盖，这里不额外开洞。
    if (req.method === "GET" && url.pathname === "/api/credentials") {
      sendJSON(res, 200, { ok: true, ...ctx.credentialsView() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/credentials") {
      readBodyText(req, res, (body) => {
        // JSON.parse 边界：同 /api/presets，字段在 updateCredentials 里逐个校验（未知字段/非法值 → 400）。
        // engine（v1.11）是顶层标量，与两组字段同一批进校验/合并（docs/adr/0022）。
        let payload = /** @type {any} */ ({});
        try {
          payload = JSON.parse(body) || {};
        } catch {}
        const clear = Array.isArray(payload.clear)
          ? /** @type {unknown[]} */ (payload.clear).map((c) => String(c))
          : [];
        const out = ctx.updateCredentials({ engine: payload.engine, llm: payload.llm, image: payload.image }, clear);
        if (!out.ok) {
          sendJSON(res, 400, { ok: false, error: out.error });
          return;
        }
        sendJSON(res, 200, { ok: true, ...out.view });
      });
      return;
    }
    // 真连一次：判定与脱敏都在 server/credentials-probe.mjs（这里只转手）。
    // 端点自身一律 200——「测试没通过」是业务结果（body 里的 ok:false + error），不是 HTTP 错误。
    if (req.method === "POST" && url.pathname === "/api/credentials/test") {
      readBodyText(req, res, async (body) => {
        let payload = /** @type {any} */ ({});
        try {
          payload = JSON.parse(body) || {};
        } catch {}
        const target = String(payload.target || "");
        if (target !== "llm" && target !== "image") {
          sendJSON(res, 400, { ok: false, error: "target 只能是 llm 或 image" });
          return;
        }
        sendJSON(res, 200, await ctx.testCredentials(target));
      });
      return;
    }
    // 保存 key 后一键生效：引擎会话的 env 只在 spawn 时读一次，必须重启才拿得到新配置。
    // `{force:true}`（v1.14）：正在演绎中也重启——入口先停这一回合（session/cancel + 本地作废）再换会话；
    // 忙碌且没给 force 仍是 409（既有语义：宁可让玩家等这一回合结束）。
    if (req.method === "POST" && url.pathname === "/api/engine/restart") {
      readBodyText(req, res, async (body) => {
        let payload = /** @type {any} */ ({});
        try {
          payload = JSON.parse(body) || {};
        } catch {}
        const out = await ctx.restartEngine({ force: payload.force === true });
        sendJSON(res, out.ok ? 200 : 409, out);
      });
      return;
    }
    // 停止本回合（v1.14，P0）：客户端顶栏的「停止」→ 引擎侧 `session/cancel` 通知 + 本地作废在途回合
    //（turn-pipeline 的 cancel 负责记账：busy 复位、广播 turn_cancelled、留 cancelled 日志、**不写快照**）。
    // 不忙碌时回 `cancelled:false` 而不是错误——客户端可能比服务端先知道回合已经收尾。
    if (req.method === "POST" && url.pathname === "/api/engine/cancel") {
      readBodyText(req, res, () => {
        sendJSON(res, 200, { ok: true, cancelled: ctx.cancelTurn() });
      });
      return;
    }
    // 引擎状态（v1.14）：SSE 断线重连后的对账面——`busy` 决定「停止」按钮可不可点，
    // `turn` 是最近开始过的回合号（客户端拿它跟已收到的 turn_end 比，判断断线期间漏没漏收尾）。
    if (req.method === "GET" && url.pathname === "/api/engine/status") {
      sendJSON(res, 200, ctx.engineStatus());
      return;
    }
    // 打开数据目录（v1.14）：帮助面板的「打开日志目录」与备份提示的两个去处。
    // which 只认 data|logs 两个值（白名单，别的一律 400）——这两个是**数据根**，不是只读 bundle。
    if (req.method === "POST" && url.pathname === "/api/open-dir") {
      readBodyText(req, res, (body) => {
        let payload = /** @type {any} */ ({});
        try {
          payload = JSON.parse(body) || {};
        } catch {}
        const which = String(payload.which || "");
        if (which !== "data" && which !== "logs") {
          sendJSON(res, 400, { ok: false, error: "which 只能是 data 或 logs" });
          return;
        }
        openDirectory(path.join(DATA_ROOT, which === "logs" ? "logs" : ""));
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
    // 登录 / 登出（v1.11 收尾，docs/adr/0022）：把**玩家自己**的 CLI 登录流程拉起来 / 把它清掉。
    // 登录是长事务（开浏览器等回调）——端点立刻回执，客户端轮询 /api/auth 等结果；
    // 登出是全局动作（终端里那份也会没），GUI 已经先确认过，服务端只负责执行。
    if (req.method === "POST" && url.pathname === "/api/engine/login") {
      readBodyText(req, res, async () => {
        const out = await ctx.startEngineLogin();
        sendJSON(res, out.ok ? 200 : 409, out);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/engine/logout") {
      readBodyText(req, res, async () => {
        const out = await ctx.logoutEngine();
        sendJSON(res, out.ok ? 200 : 409, out);
      });
      return;
    }

    // 打包后的前端静态托管（生产/开发同构，前端请求一律走相对路径）。
    // /app（无尾斜杠）302 到 /app/：产物 index.html 的资源是相对路径（vite base "./"），
    // 少了尾斜杠基准地址会落在站点根、./assets/… 全 404（浏览器手输地址时同样中招）。
    if (req.method === "GET" && url.pathname === "/app") {
      res.writeHead(302, { location: "/app/" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/app/")) {
      const appDist = resolveAppDist();
      if (!appDist) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("app dist not built");
        return;
      }
      let rel;
      try {
        rel = decodeURIComponent(url.pathname.slice("/app/".length));
      } catch {
        rel = "";
      }
      let file = rel ? path.join(appDist, rel) : path.join(appDist, "index.html");
      if (!withinRoot(file, appDist)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(appDist, "index.html"); // SPA fallback
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
      return;
    }

    // 音频直服（CONTRACTS §1）：白名单形态 + path.resolve 前缀校验（与 /img 同款两道闸）；
    // 直接整文件 200（不做 Range——音频文件小，客户端拉全量即可），长缓存。
    // 根是**数据根**（v1.14）：音频随剧本走，而剧本目录在可写数据根里（随包那份只是种子）。
    if (req.method === "GET" && url.pathname === "/audio") {
      const p = url.searchParams.get("p") || "";
      if (AUDIO_REL_RE.test(p)) {
        const file = path.resolve(DATA_ROOT, p);
        if (withinRoot(file, DATA_ROOT)) {
          const ext = path.extname(file).slice(1).toLowerCase();
          fs.readFile(file, (err, data) => {
            if (err) {
              res.writeHead(404);
              res.end();
              return;
            }
            res.writeHead(200, {
              "content-type": AUDIO_MIME[ext] || "application/octet-stream",
              "cache-control": "public, max-age=86400",
            });
            res.end(data);
          });
          return;
        }
      }
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/img") {
      const p = url.searchParams.get("p") || "";
      const t = url.searchParams.get("t") || "";
      const n = url.searchParams.get("n") || "";
      // 当前剧本：只认显式 &preset=（画廊/预载直服会带）或标记路径自带的 presets/<id>/…。
      // 非法 &preset= 告警后忽略（视为没带）；**绝不回退 currentPresetId**（B1）：
      // 创作模式装配新剧本时它是上一局的剧本，回退会把新剧本的立绘写进旧剧本目录。
      const qRaw = url.searchParams.get("preset") || "";
      const qPreset = PRESET_ID_RE.test(qRaw) ? qRaw : "";
      if (qRaw && !qPreset) console.warn(`[acp] /img 的 &preset= 非法，已忽略: ${qRaw}`);
      const { presetId: targetPid } = resolvePersistPreset({ queryPreset: qPreset, srcRel: p });
      const serve = /** @param {string} file */ (file) =>
        fs.readFile(file, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
          res.end(data);
        });
      // t&n 齐备时，直服/落盘共用的目标：presets/<剧本 id>/assets/<类型>-<名>.jpg；
      // 封面（t=封面）走 assetTargetFile 的 presets/<id>/cover.jpg 分支——assets/封面-X.jpg 是死路径
      const targetRel = t && n ? assetTargetFile(t, n, targetPid || "") : "";
      // 根是数据根（v1.14）：引擎与 assets-pipeline 都往这里落盘，直服必须跟着同一个根
      const target = targetRel ? path.join(DATA_ROOT, targetRel) : "";
      // 新契约 ?t=<类型>&n=<名字>[&p=<会话路径>][&preset=<剧本 id>]：该剧本 assets 永久命中优先
      if (target && fs.existsSync(target)) {
        serve(target);
        return;
      }
      // 旧契约 / 会话兜底：当前会话 → 跨会话扫描；带 t&n 与剧本时顺手落盘到该剧本的 assets
      if (/^images\/\d+\.jpe?g$/.test(p) && ctx.sessionId) {
        const file = ctx.resolveImage(path.basename(p));
        if (file) {
          if (target) {
            try {
              ctx.persistAssetFromFile(t, n, file, targetPid || "", p);
            } catch {}
            if (fs.existsSync(target)) {
              serve(target);
              return;
            }
          }
          serve(file);
          return;
        }
      }
      // 旧档兼容（v1.5 之前老存档里记的是 assets/<类型>-<名>.jpg）：I1 起**只探测当前剧本目录**，
      // 命中即直服；找不到就 404——不再跨剧本扫同名文件（会串味），也不再迁落别剧本的图。
      // 这里只读不写：候选本来就落在当前剧本目录里，搬过去是自己搬自己。
      if (LEGACY_ASSET_RE.test(p)) {
        ctx.warnLegacyPathOnce(p);
        const legacyPid = qPreset || presetIdFromPath(p) || ctx.currentPresetId || "";
        const rel = legacyAssetCandidates(p, legacyPid)[0];
        const file = rel ? path.join(DATA_ROOT, rel) : "";
        if (file && fs.existsSync(file)) {
          serve(file);
          return;
        }
      }
      // 已落盘资产直服白名单（统一 jpe?g）：presets/<id>/assets/<文件> 与 presets/<id>/cover.jpg（resolve 后必须仍在数据根内）
      if (
        /^presets\/[A-Za-z0-9_-]+\/assets\/[^/]+\.jpe?g$/.test(p) ||
        /^presets\/[A-Za-z0-9_-]+\/cover\.jpe?g$/.test(p)
      ) {
        const file = path.resolve(DATA_ROOT, p);
        if (withinRoot(file, DATA_ROOT)) {
          serve(file);
          return;
        }
      }
      res.writeHead(404);
      res.end();
      return;
    }

    // SSE（v1.14 起帧带单调 `id:`、每连接 20s 一帧 `: ping` 心跳——两者都在 server/sse.mjs 的广播器里，
    // 路由只负责写响应头 + `retry:` + 登记连接）。`req.on("close")` 注销；收尾时 closeAll 会 destroy
    // 全部连接（长连接不散的话 server.close 的回调永远等不到）。
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      ctx.sse.addClient(res);
      req.on("close", () => ctx.sse.removeClient(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/prompt") {
      readBodyText(req, res, async (body) => {
        let text = "";
        try {
          text = JSON.parse(body).text || "";
        } catch {}
        if (!text.trim()) {
          res.writeHead(400);
          res.end("{}");
          return;
        }
        const r = await ctx.sendPrompt(text.trim());
        res.writeHead(r.ok ? 200 : 409, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  };
}
