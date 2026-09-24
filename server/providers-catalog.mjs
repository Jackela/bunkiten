// 服务目录的「随版本更新」通道（v1.10，docs/adr/0020）：远端发布源 → 校验 → 本地缓存 → 内置兜底。
//
// 为什么要这条通道：服务目录（shared/providers.mjs 的 PROVIDERS）此前是**打进包里的死数据**——
// 新服务、或某家改了 base_url / 模型示例，只有等下一个游戏版本才到得了玩家机器。把目录搬进仓库里的
// docs/providers.json（发布源，由 scripts/export-providers.mjs 从真源生成），服务端启动时**非阻塞**地
// 抓一次、校验后落 `~/.bunkiten/providers.json`，下一次启动就吃缓存——玩家不换版本也能拿到新目录。
// 发布→可见的窗口由三层决定（ADR-0020 的「修订」段把这条算式钉死）：① 发布源各自的 CDN 缓存；
// ② 本地缓存的 TTL 节流（CATALOG_TTL_MS）；③ 触发抓取的时机——启动一次 + 每个 `GET /api/providers`
// 的**后台 revalidate**（revalidateCatalog，stale-while-revalidate：先回当前视图、再异步刷新）。
// 所以「改了 docs/providers.json」到「长开着的应用下次开设置屏就吃到」不再需要重启。
//
// 铁律（安全面，任何调用方都不许越过）：
//   · 远端**只喂下拉候选**：本模块只回答「目录里有哪些服务可选」，**绝不据此改写玩家已存的
//     baseUrl / key / 模型**（那些是 GUI 里手填的一等公民，见 server/credentials.mjs）；
//   · **https-only**：发布源里的 base_url 只收 https（例外：本机 http://localhost 与 http://127.0.0.1，
//     内置表里就有 ollama / LM Studio 两条本机服务）；整包校验不过就弃用远端，回落缓存/内置；
//   · 读路径永不抛（坏缓存当无缓存）；写路径原子（临时文件 + rename，目录 0700 / 文件 0600）。
//
// 与目录真源的关系：内置兜底就是 shared/providers.mjs 的 PROVIDERS——本模块不抄第二份目录，只加
// 「远端覆盖」这一层；发布源也从同一份真源生成（契约 lint ⑦ 组断言 docs/providers.json 与它深等）。
import fs from "fs";
import { gameHome } from "./config.mjs";
import path from "path";
import { PROVIDERS, PROVIDER_ID_RE } from "../shared/providers.mjs";
import { CREDENTIALS_DIRNAME } from "./credentials.mjs";
import { withTimeoutSignal } from "./http-util.mjs";

/** 目录缓存文件名（落在凭据目录 `~/.bunkiten/` 里——目录名从 credentials.mjs 借用，不抄第二份） */
export const CATALOG_FILENAME = "providers.json";

/** 目录文档的结构版本（与 scripts/export-providers.mjs 写出的 version 对齐；不匹配即弃用远端） */
export const CATALOG_VERSION = 1;

/**
 * 本地缓存的保鲜期（6h）：本地副本还在期内就不打扰发布源，过了才重抓一次。
 * 为什么从 24h 收到 6h（ADR-0020 的「修订」段）：TTL 直接落进「发布→可见」的窗口算式里，
 * 一天太长；6h 与常用 CDN 的边缘缓存量级相近，让本地这一层不再是窗口里的主导项。
 */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** 单次抓取的墙钟上限（照 credentials-probe.mjs 的 timeoutSignal 风格：连不上/被墙都不该拖住启动） */
export const CATALOG_TIMEOUT_MS = 10_000;

/**
 * 发布源：**固定这两个**，**并行都抓**，谁的分发路径先吐出新内容就用谁（见 pickNewest）。
 *   1. jsDelivr CDN —— `@main` 分支引用，边缘缓存让它在 GitHub 直连不稳的地区也能到，代价是更新有缓存窗口；
 *   2. GitHub raw —— 源站直出、缓存窗口是分钟级，CDN 抽风或滞后时更快拿到新内容。
 * 为什么不走「可配置的目录服务器」：这是一份公开的静态 JSON（纯内容分发，不是账号级接口），
 * 固定两个公开源最省；测试/镜像用 BUNKITEN_PROVIDERS_URL 覆盖（覆盖时保持单源语义，见 refreshCatalog）。
 * 为什么不再「先主后备、首个有效即止」：那样只要主源可达（哪怕它正吐一份缓存的旧目录）就永远赢，
 * 备源那条更快的路径被白等；两源都抓、在有效结果里取 updatedAt 最大的那份，才让可达性兜底不拖慢新鲜度。
 */
export const CATALOG_URLS = Object.freeze([
  "https://cdn.jsdelivr.net/gh/Jackela/bunkiten@main/docs/providers.json",
  "https://raw.githubusercontent.com/Jackela/bunkiten/main/docs/providers.json",
]);

// 字段长度上限（与 credentials.mjs 的 MAX_* 常量同款纪律）：远端是不可信输入，超限即丢**该条**（不弃整包）
const MAX_ID = 40;
const MAX_LABEL = 80;
const MAX_URL = 500;
const MAX_NOTE = 400;
const MAX_MODEL = 200;
const MAX_MODELS = 50;

/** 用途集合（与 shared/providers.mjs 的 ProviderEntry.kind 同集） */
const KINDS = Object.freeze(["llm", "image", "both"]);

/** @param {unknown} v @returns {string} 字符串化并去掉首尾空白（非字符串给空串） */
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * base_url 是否准收：https-only，例外是本机 http（`http://localhost` / `http://127.0.0.1`）。
 * 例外不能省：内置表里 ollama / LM Studio 就是本机明文 HTTP 服务。
 * @param {string} baseUrl 候选地址
 * @returns {boolean} 是否准收
 */
function isAllowedBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
  return false;
}

/**
 * 一串模型 id 候选是否合法（是数组、条数与单项长度都在限内、逐项非空）。
 * @param {unknown} v 候选
 * @returns {string[] | null} 合法时返回规范化数组；否则 null（调用方据此丢该条）
 */
function parseModelList(v) {
  if (!Array.isArray(v) || v.length > MAX_MODELS) return null;
  /** @type {string[]} */
  const out = [];
  for (const item of v) {
    const s = str(item);
    if (!s || s.length > MAX_MODEL) return null;
    out.push(s);
  }
  return out;
}

/**
 * 一条候选条目 → 合法条目（不合规回 null，调用方**只丢该条**、不弃整包）。
 * 只搬白名单字段：远端的未知键一律丢掉（那些键进了 GUI 视图就是注入面）。
 * @param {unknown} raw 候选条目
 * @returns {import("../shared/providers.mjs").ProviderEntry | null} 合法条目或 null
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const id = str(src.id);
  if (!id || id.length > MAX_ID || !PROVIDER_ID_RE.test(id)) return null;
  const label = str(src.label);
  if (!label || label.length > MAX_LABEL) return null;
  const kind = str(src.kind);
  if (!KINDS.includes(kind)) return null;
  const baseUrl = str(src.baseUrl);
  if (baseUrl.length > MAX_URL) return null;
  const models = parseModelList(src.models);
  if (models === null) return null;
  const note = src.note === undefined ? "" : str(src.note);
  if (note.length > MAX_NOTE) return null;
  if (!baseUrl && !note) return null; // 地址留空必须说明「该填什么形态」（与内置表同一条纪律）
  if (baseUrl && !isAllowedBaseUrl(baseUrl)) return null;
  const entry = /** @type {import("../shared/providers.mjs").ProviderEntry} */ ({ id, label, kind, baseUrl, models });
  if (src.imageModels !== undefined) {
    const imageModels = parseModelList(src.imageModels);
    if (imageModels === null) return null;
    entry.imageModels = imageModels;
  }
  if (note) entry.note = note;
  return entry;
}

/**
 * 目录文档（发布源与缓存的落盘形状）。
 * @typedef {Object} CatalogDocument
 * @property {number} version 结构版本
 * @property {string} [updatedAt] 发布时刻（ISO；可选，仅作展示）
 * @property {import("../shared/providers.mjs").ProviderEntry[]} providers 服务条目（顺序即下拉顺序）
 */

/**
 * 校验一份目录文档（纯函数，单测直测）。两级取捨：
 *   · 整包形状坏（非对象 / version 不认 / providers 不是数组 / 剔完一条不剩）→ **拒整包**（{ok:false}）；
 *   · 单条坏（id 非法或重复、kind 不认识、地址非法、超长、留空又没 note…）→ **只丢那一条**。
 * 为什么不「逐键容错回默认」：远端是不可信输入，而目录是**下拉候选全集**——半份坏数据静默混进来，
 * 玩家在设置屏选到一个打不通的地址，比少一个选项难排查得多；宁可不更新，也不下发没把握的地址。
 * @param {unknown} doc 远端 JSON.parse 的结果（或缓存原文）
 * @returns {{ok: true, doc: CatalogDocument} | {ok: false, error: string}} 校验结果
 */
export function validateCatalogDocument(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "目录不是对象" };
  const d = /** @type {Record<string, unknown>} */ (doc);
  if (d.version !== CATALOG_VERSION)
    return { ok: false, error: `目录版本不匹配：${String(d.version)}（本机只认 ${CATALOG_VERSION}）` };
  if (!Array.isArray(d.providers)) return { ok: false, error: "providers 不是数组" };
  const seen = new Set();
  /** @type {import("../shared/providers.mjs").ProviderEntry[]} */
  const providers = [];
  for (const raw of d.providers) {
    const entry = normalizeEntry(raw);
    if (!entry) continue; // 单条坏：丢这一条
    if (seen.has(entry.id)) continue; // id 必须唯一：重复的后来者丢掉（保持首现顺序）
    seen.add(entry.id);
    providers.push(entry);
  }
  if (providers.length === 0) return { ok: false, error: "没有一条合法条目" };
  const updatedAt = str(d.updatedAt);
  /** @type {CatalogDocument} */
  const out = { version: CATALOG_VERSION, providers };
  if (updatedAt) out.updatedAt = updatedAt;
  return { ok: true, doc: out };
}

/**
 * 目录缓存的绝对路径（复用凭据目录 `~/.bunkiten/`——CREDENTIALS_DIRNAME 只有一份）。
 * @param {string} [root] 用户主目录（缺省 gameHome()——`BUNKITEN_HOME` 可覆盖；单测/harness 传临时 HOME）
 * @returns {string} `~/.bunkiten/providers.json`
 */
export function catalogCachePath(root = gameHome()) {
  return path.join(root, CREDENTIALS_DIRNAME, CATALOG_FILENAME);
}

/**
 * 读缓存：文件不存在 / 坏 JSON / 形状不是本模块写的那种 / 校验不过一律回 null（**永不抛**）。
 * 回来的 doc 上多一个 `fetchedAt`（本机上次抓取时间——TTL 与 `/api/providers` 的 fetchedAt 用它）；
 * 老缓存缺它就当「没有时间戳」（视为过期，下次启动会重抓一次）。
 * @param {string} [root] 用户主目录
 * @returns {(CatalogDocument & {fetchedAt: string | null}) | null} 缓存文档或 null
 */
export function readCatalogCache(root = gameHome()) {
  try {
    const file = catalogCachePath(root);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const check = validateCatalogDocument(raw);
    if (!check.ok) return null;
    const fetchedAt = str(/** @type {any} */ (raw).fetchedAt);
    return { ...check.doc, fetchedAt: fetchedAt || null };
  } catch {
    return null;
  }
}

/**
 * 写缓存：目录 0700、文件 0600，临时文件 + rename 原子落盘（进程被杀不会留半截 JSON）。**永不抛**——
 * 落盘失败（磁盘满/权限/只读 HOME）只回 false：目录更新是尽力而为的后台动作，绝不该阻断启动。
 * @param {string} root 用户主目录
 * @param {CatalogDocument} doc 已校验的目录文档
 * @param {string} [fetchedAt] 本次抓取的 ISO 时间（缺省 now）
 * @returns {boolean} 是否落盘成功
 */
export function writeCatalogCache(root, doc, fetchedAt = new Date().toISOString()) {
  try {
    const file = catalogCachePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...doc, fetchedAt }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600); // rename 保留 tmp 的权限，这里显式再钉一次（旧文件可能带别的 mode）
    return true;
  } catch {
    return false;
  }
}

/**
 * 进程内当前目录状态。
 * @typedef {Object} CatalogState
 * @property {import("../shared/providers.mjs").ProviderEntry[]} providers
 * @property {"remote" | "cache" | "bundled"} source **本条 providers 的来源**：`"remote"` = 本进程抓到过远端；
 *   `"cache"` = 读的本地缓存；`"bundled"` = 内置兜底
 * @property {string | null} fetchedAt 抓到远端的那次时刻（缓存/内置为 null 或缓存的 fetchedAt）
 * @property {number} at 解析出这层目录时的墙钟毫秒（refreshCatalog 的 TTL 判据）
 */

/** 进程内 memo（`/api/providers` 是热端点，一次进程生命周期只解析一次目录） @type {CatalogState | null} */
let memo = null;

/** 清掉进程内 memo 的测试探针（与 snapshots.mjs 的 `__snapshotCacheStats` 同款：只为单测从干净状态起，不是对外 API）。 */
export function __resetCatalogMemo() {
  memo = null;
}

/**
 * 解析当前目录（memo → 缓存 → 内置，进程内只走一遍）。
 * @param {string} root 用户主目录
 * @param {number} now 墙钟毫秒
 * @returns {CatalogState} 当前目录状态（同时写进 memo）
 */
function catalogState(root, now) {
  if (memo) return memo;
  const cached = readCatalogCache(root);
  if (cached) {
    const parsed = cached.fetchedAt ? Date.parse(cached.fetchedAt) : NaN;
    // 时间戳不可信（缺失/解析不出）时 at 记 0：TTL 判它「过期」，下次启动会重抓一次
    memo = {
      providers: cached.providers,
      source: "cache",
      fetchedAt: cached.fetchedAt,
      at: Number.isFinite(parsed) ? parsed : 0,
    };
    return memo;
  }
  memo = { providers: [...PROVIDERS], source: "bundled", fetchedAt: null, at: now };
  return memo;
}

/**
 * 服务目录的可下发视图（`/api/providers` 的响应主体，也可直接给 GUI 画下拉）。
 * source 是**本条 providers 的来源**：刚抓到远端是 `"remote"`，读的本地缓存是 `"cache"`，
 * 缓存坏/缺、回落内置表是 `"bundled"`。**只读**：调用方拿它画候选，绝不据此改写玩家已存的值。
 * @param {{root?: string, now?: number}} [opts] root = 用户主目录（缺省 gameHome()）；now = 墙钟（可注入）
 * @returns {{providers: import("../shared/providers.mjs").ProviderEntry[], source: "remote" | "cache" | "bundled", fetchedAt: string | null}}
 */
export function loadCatalog({ root = gameHome(), now = Date.now() } = {}) {
  const s = catalogState(root, now);
  return { providers: s.providers, source: s.source, fetchedAt: s.fetchedAt };
}

/**
 * 一次带超时的 GET（**永不抛**）：超时 / 网络错误 / 非 2xx 统一回 null。
 * 定时器 unref 掉——抓取进行中用户退出进程，不该被这个定时器拖住。
 * @param {typeof fetch} fetchImpl fetch 实现（可注入）
 * @param {string} url 地址
 * @returns {Promise<string | null>} 响应体原文或 null
 */
async function fetchTextSafe(fetchImpl, url) {
  const t = withTimeoutSignal(CATALOG_TIMEOUT_MS, "catalog");
  try {
    const res = await fetchImpl(url, { signal: t.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    t.clear(); // 用完必须清：unref 只保证不吊住事件循环，定时器本身仍占着
  }
}

/**
 * 取一份**有效**目录文档的 updatedAt 时刻（毫秒）。**缺失 / 非字符串 / 解析不出**一律当「最旧」
 * （返回 -Infinity）：没有可信时间戳的发布物，不配在新旧比较里压过有戳的那份。
 * @param {CatalogDocument} doc 已校验的目录文档
 * @returns {number} 毫秒时刻；缺失/不可信为 -Infinity
 */
function catalogUpdatedAtMs(doc) {
  const iso = str(doc.updatedAt);
  if (!iso) return -Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * 抓一个源并校验：**永不抛**，任何一步失败（超时/非 2xx/坏 JSON/校验不过）都回 null。
 * @param {typeof fetch} fetchImpl fetch 实现（可注入）
 * @param {string} url 地址
 * @returns {Promise<CatalogDocument | null>} 有效文档或 null
 */
async function fetchValidCatalog(fetchImpl, url) {
  const text = await fetchTextSafe(fetchImpl, url);
  if (text == null) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const check = validateCatalogDocument(parsed);
  return check.ok ? check.doc : null;
}

/**
 * 在一组**已并行抓回**的有效候选里取「最新有效」那份：按 updatedAt 最大者胜；完全并列（含都没戳）
 * 时按传入顺序取前者——顺序即 `CATALOG_URLS`（主源在前），因此主源在同新度时优先。
 * @param {(CatalogDocument | null)[]} candidates 按 `CATALOG_URLS` 顺序排列的候选（无效为 null）
 * @returns {CatalogDocument | null} 最新的一份；一份都没有则 null
 */
function pickNewest(candidates) {
  /** @type {CatalogDocument | null} */
  let best = null;
  let bestMs = -Infinity;
  for (const doc of candidates) {
    if (!doc) continue;
    const ms = catalogUpdatedAtMs(doc);
    if (best === null || ms > bestMs) {
      best = doc;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * 抓一次发布源（**两源并行、取最新有效**）→ 校验 → 落盘 → 更新 memo。**失败静默**：不抛、不响——
 * 目录更新是尽力而为的后台动作，失败就继续用缓存/内置（调用点在启动路径与 GET 路径，绝不能被一次网络抖动打断）。
 *
 * 抓法（ADR-0020 的「修订」段）：`Promise.allSettled` 并行抓 `CATALOG_URLS`（各自 10s 上限），各自校验；
 * 在**全部有效**结果里取 updatedAt 最大的一份（缺失/解析不出视为最旧、完全并列取靠前那个源）；
 * 只有一份有效就用它；全无效 → `{ok:false}`。为什么不是「先主后备、首个有效即止」：raw 的 CDN 缓存是
 * 分钟级、jsDelivr 可达性好但缓存长——「取最新」让可达性兜底不再拖慢新鲜度。
 * `BUNKITEN_PROVIDERS_URL` 覆盖时**保持单源语义不变**（只打覆盖的那一个，测试/镜像要的就是确定性）。
 *
 * 两个兼容开关（与 electron-updater 的既有做法同款，见 electron/main.js 的 `BUNKITEN_DISABLE_UPDATE`）：
 *   · `BUNKITEN_DISABLE_UPDATE=1` → 直接跳过（打包冒烟用它保证不联网）；
 *   · `BUNKITEN_PROVIDERS_URL=<url>` → 覆盖发布源（测试/镜像指到本地 mock，只打这一个）。
 *
 * TTL 语义：本地缓存还在 6h 保鲜期内就不打扰发布源；没有缓存、缓存过期、或时间戳不可信才真的抓。
 * @param {{root?: string, fetchImpl?: typeof fetch, env?: Record<string, string | undefined>, now?: number}} [opts]
 * @returns {Promise<{ok: boolean}>} 抓取并落盘成功为 true；跳过（开关/TTL）或全源失败为 false
 */
export async function refreshCatalog({
  root = gameHome(),
  fetchImpl = fetch,
  env = process.env,
  now = Date.now(),
} = {}) {
  if (env.BUNKITEN_DISABLE_UPDATE === "1") return { ok: false };
  const state = catalogState(root, now);
  // 本地副本还新鲜：不打扰发布源（TTL 是「最多 6h 拉一次」的节流，不是缓存有效期的上限）
  if (state.source !== "bundled" && state.fetchedAt && now - state.at < CATALOG_TTL_MS) return { ok: false };
  const override = str(env.BUNKITEN_PROVIDERS_URL);
  const urls = override ? [override] : CATALOG_URLS;
  // 并行抓、一起等：两源各自的 10s 上限照旧，最坏情形仍是「一个 10s 窗口」而不是顺序相加。
  const settled = await Promise.allSettled(urls.map((url) => fetchValidCatalog(fetchImpl, url)));
  const candidates = settled.map((r) => (r.status === "fulfilled" ? r.value : null));
  const best = pickNewest(candidates);
  if (!best) return { ok: false };
  const fetchedAt = new Date(now).toISOString();
  writeCatalogCache(root, best, fetchedAt);
  memo = { providers: best.providers, source: "remote", fetchedAt, at: now };
  return { ok: true };
}

/** 进程内在途的 revalidate（单飞：一条在途 Promise 被所有调用方复用，见 revalidateCatalog） @type {Promise<{ok: boolean}> | null} */
let revalidateInFlight = null;

/**
 * 读路径上的**后台刷新**（stale-while-revalidate）：给 `/api/providers` 的读取路径 fire-and-forget 用。
 * 语义与纪律：
 *   · **永不抛**——返回的 Promise 永不 reject（refreshCatalog 本就不抛，这里再兜一层）；
 *   · **非阻塞**——调用方（`providersView`）不 await 它：先立即回当前 `loadCatalog()` 的结果，刷新在后台跑；
 *   · **单飞**——进程内一条在途 Promise 被所有调用方复用（一串并发的 GET 只发一轮抓取），落地后清零；
 *   · TTL/开关守卫**照用**——它只是 refreshCatalog 的一次包装，新鲜（未过期）或 `BUNKITEN_DISABLE_UPDATE=1` 时
 *     直接 `{ok:false}`、**一次网络请求都不发**。
 * 效果：长开着的应用在下次设置屏 GET 时就会后台刷新，不必等重启（发布→可见的窗口第 ③ 项）。
 * @param {{root?: string, fetchImpl?: typeof fetch, env?: Record<string, string | undefined>, now?: number}} [opts]
 * @returns {Promise<{ok: boolean}>} 刷新结果；跳过或失败为 `{ok:false}`（**不 reject**）
 */
export function revalidateCatalog({ root = gameHome(), fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  if (revalidateInFlight) return revalidateInFlight;
  const run = refreshCatalog({ root, fetchImpl, env, now }).catch(() => ({ ok: false }));
  const tracked = run.finally(() => {
    revalidateInFlight = null;
  });
  revalidateInFlight = tracked;
  return tracked;
}
