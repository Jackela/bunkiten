// HTTP 路由链（v1.7 拆模块）：createRequestHandler(ctx) 返回 (req,res) 处理器，分支顺序与响应体
// 与拆模块前的 startServer 内联实现逐字一致。路由分派保持 if-chain（先匹配先赢，路径少、
// 且部分前缀路由（/app/）依赖 startsWith，表驱动没有净收益）。
// ctx 是入口 startServer 的闭包能力注入：SSE 客户端集合、发提示词、画廊/落盘、会话图片定位、
// 当前剧本 id 与 sessionId（getter——快照与嗅探会改它们，路由每次读最新值）。
import fs from "fs";
import os from "os";
import path from "path";
import { AUDIO_MIME, AUDIO_REL_RE } from "../shared/protocol.mjs";
import { GAME_ROOT, BASE_PORT, WORLDS_ROOT } from "./config.mjs";
import { isCrossSiteRequest, readBodyText, MIME, resolveAppDist } from "./http-util.mjs";
import { PRESET_ID_RE, LEGACY_ASSET_RE, ASSET_DELETE_FILE_RE, presetIdFromPath, legacyAssetCandidates, resolvePersistPreset } from "./assets.mjs";
import { scanPresets, assetTargetFile, buildPresetBundle, importPresetBundle, PRESET_IMPORT_MAX_BYTES } from "./presets.mjs";
import { scanPresetAudio } from "./audio.mjs";
import { WORLD_ID_RE, TREE_FILE, readSnapshot, readSnapshots } from "./snapshots.mjs";
import {
  moveToTrash, readWorldsIndex, listWorlds, createWorld, forkWorld, restoreWorld, updateWorld,
  exportWorld, importWorld, deleteWorld, stateViewFor,
} from "./worlds.mjs";

/**
 * 入口闭包注入的能力集（startServer → 路由链；currentPresetId/sessionId 是 getter，每次读最新值）。
 * @typedef {Object} HandlerContext
 * @property {Set<import("http").ServerResponse>} clients SSE 客户端集合（/events 注册、stopServer 清空）
 * @property {(text: string) => Promise<{ok: boolean, error?: string}>} sendPrompt
 * @property {(presetId: string) => Array<object>} listAssets 画廊数据（registry + 磁盘扫描）
 * @property {(type: string, rawName: string, src: string, presetId?: string, srcRel?: string) => boolean} persistAssetFromFile
 * @property {(name: string) => string|null} resolveImage 会话图片定位（ACP 会话闭包）
 * @property {(rel: string) => void} warnLegacyPathOnce 旧档路径告警（去重）
 * @property {string} currentPresetId 嗅探出的当前剧本 id
 * @property {string|null} sessionId 当前 ACP 会话 id
 */

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
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "跨站请求被拒绝" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      // 首页导览：把 v1.6 的新路由（音频列表/直服、历史快照、世界导出）一并列上，方便 curl 排查
      res.end(
        "galgame acp-server running. API: /api/presets(GET,POST:import) /api/presets/export?id= /api/auth /api/assets?preset=(GET,POST删除) " +
          "/api/audio?preset= /api/worlds(POST: create/fork/restore/update/delete/import) /api/worlds/export?worldId= /api/history?worldId=[&seq=] " +
          "/api/tree /api/state?worldId= /events(SSE) /prompt(POST) /img?p=&t=&n=&preset= /audio?p=. 打包前端见 /app。",
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/presets") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(scanPresets()));
      return;
    }

    // 剧本导出（v1.7）：GET /api/presets/export?id=<id> → 附件下载 <id>.preset.json（base64 图片/音频在包体里）
    if (req.method === "GET" && url.pathname === "/api/presets/export") {
      const id = url.searchParams.get("id") || "";
      const out = buildPresetBundle(GAME_ROOT, id); // 内部已过 PRESET_ID_RE + preset.md 存在性校验
      if (out.error) {
        // 目录/ preset.md 不存在与「id 非法」分开说：前者 404（真路过期的 id），后者 400（坏请求）
        const status = out.error === "剧本不存在" ? 404 : 400;
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: out.error }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${id}.preset.json"`,
      });
      res.end(JSON.stringify(out.bundle));
      return;
    }

    // 剧本导入（v1.7）：POST /api/presets {action:"import", bundle}——包里是 base64 图片/音频，
    // 5MB 不够用：本端点单独放宽到 50MB（readBodyText 其余调用点仍走 5MB 缺省）
    if (req.method === "POST" && url.pathname === "/api/presets") {
      readBodyText(
        req,
        res,
        (body) => {
          // JSON.parse 边界：请求体形状未知，各 action 分支自行取字段并校验
          let payload = /** @type {any} */ ({});
          try { payload = JSON.parse(body) || {}; } catch {}
          if (String(payload.action || "") !== "import") {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "未知动作" }));
            return;
          }
          const out = importPresetBundle(GAME_ROOT, payload.bundle);
          res.writeHead(out.error ? 400 : 200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(out.error ? { ok: false, error: out.error } : { ok: true, id: out.id }));
        },
        PRESET_IMPORT_MAX_BYTES,
      );
      return;
    }

    // 画廊数据：资产随剧本走，必须指明剧本（缺失或非法 → 400，绝不给全局池）
    if (req.method === "GET" && url.pathname === "/api/assets") {
      const presetId = url.searchParams.get("preset") || "";
      if (!PRESET_ID_RE.test(presetId)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少或非法的 preset 参数" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(ctx.listAssets(presetId)));
      return;
    }

    // 素材批量删除（CONTRACTS §3）：只删 presets/<id>/assets/ 下的单层 jpe?g，封面（cover.jpg）不可删
    if (req.method === "POST" && url.pathname === "/api/assets") {
      readBodyText(req, res, (body) => {
        // JSON.parse 边界：同 /api/presets，字段在下方逐个校验
        let payload = /** @type {any} */ ({});
        try { payload = JSON.parse(body) || {}; } catch {}
        const json = /** @param {number} code @param {object} obj */ (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
        if (String(payload.action || "") !== "delete") return json(400, { error: "未知动作" });
        const presetId = String(payload.preset || "");
        const file = String(payload.file || "");
        // preset 过白名单、file 单层且是 jpe?g（防穿越）；封面不在 assets/ 也不允许删
        if (!PRESET_ID_RE.test(presetId) || !ASSET_DELETE_FILE_RE.test(file) || file === "cover.jpg") {
          return json(400, { error: "参数不合法" });
        }
        const abs = path.join(GAME_ROOT, "presets", presetId, "assets", file);
        if (!fs.existsSync(abs)) return json(404, { error: "素材不存在" });
        try {
          // 删除进回收站（v1.7）：rename 进 state/trash/，EXDEV 等 rename 失败由 moveToTrash 回退直删；
          // label 带上 presetId——跨剧本同名素材在 trash 里靠它区分该挪回哪个剧本
          const t = moveToTrash(GAME_ROOT, ["presets", presetId, "assets", file], presetId);
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
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少或非法的 preset 参数" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ items: scanPresetAudio(presetId) }));
      return;
    }

    // 逐轮状态快照（CONTRACTS §2）：列表只回元信息；带 &seq=<n> 时**只读目标文件**并只回该条（回退预览用）。
    // 带 seq 的调用很热（预览/重建），不能为了附 files 把整个 history 目录全量 parse。
    if (req.method === "GET" && url.pathname === "/api/history") {
      const worldId = url.searchParams.get("worldId") || "";
      if (!WORLD_ID_RE.test(worldId)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少或非法的 worldId 参数" }));
        return;
      }
      const seqParam = url.searchParams.get("seq");
      if (seqParam != null && seqParam !== "") {
        const one = readSnapshot(worldId, seqParam, WORLDS_ROOT);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ worldId, snapshots: one ? [one] : [] }));
        return;
      }
      const snapshots = readSnapshots(worldId, WORLDS_ROOT).map((s) => ({
        seq: s.seq, at: s.at, kind: s.kind, nodeId: s.nodeId, chapterNo: s.chapterNo,
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ worldId, snapshots }));
      return;
    }

    // 世界导出（CONTRACTS §2）：GET /api/worlds/export?worldId=<id> → 附件下载 <worldId>.world.json
    if (req.method === "GET" && url.pathname === "/api/worlds/export") {
      const worldId = url.searchParams.get("worldId") || "";
      const out = exportWorld(WORLDS_ROOT, worldId); // 内部已过 WORLD_ID_RE + 存在性校验
      if (out.error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: out.error }));
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
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ worlds: listWorlds(WORLDS_ROOT, url.searchParams.get("preset")) }));
      return;
    }

    // 世界线管理：create=建新世界（分配 id、写索引）；fork=在指定节点手动分叉（不推演）；delete=删除
    if (req.method === "POST" && url.pathname === "/api/worlds") {
      readBodyText(req, res, (body) => {
        // JSON.parse 边界：同 /api/presets，字段在下方逐个校验
        let payload = /** @type {any} */ ({});
        try { payload = JSON.parse(body) || {}; } catch {}
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
          out = WORLD_ID_RE.test(worldId) && nodeId && seqOk ? forkWorld(WORLDS_ROOT, worldId, nodeId, seq) : { error: "参数不合法" };
        } else if (action === "restore") {
          const worldId = String(payload.worldId || "");
          const seq = Number(payload.seq);
          out = WORLD_ID_RE.test(worldId) && Number.isInteger(seq) ? restoreWorld(WORLDS_ROOT, worldId, seq) : { error: "参数不合法" };
        } else if (action === "update") {
          const worldId = String(payload.worldId || "");
          const patch = {};
          if ("label" in payload) patch.label = payload.label;
          if ("note" in payload) patch.note = payload.note;
          out = WORLD_ID_RE.test(worldId) ? updateWorld(WORLDS_ROOT, worldId, patch) : { error: "参数不合法" };
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
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "世界删除失败" }));
              return;
            }
          }
        } else {
          out = { error: "未知动作" };
        }
        const ok = !out.error;
        res.writeHead(ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok, ...out }));
      });
      return;
    }

    // 剧情树原文（剧情图屏解析用）：?worldId=<id>，缺省 main
    if (req.method === "GET" && url.pathname === "/api/tree") {
      const worldId = url.searchParams.get("worldId") || "main";
      let markdown = null;
      if (WORLD_ID_RE.test(worldId)) {
        try { markdown = fs.readFileSync(path.join(WORLDS_ROOT, worldId, TREE_FILE), "utf8"); } catch {}
      }
      if (markdown === null) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "剧情树不存在" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ worldId, markdown }));
      return;
    }

    // 角色面板（v1.7）：读该世界 state.md 并容错解析；?worldId=<id> 必填（缺失/非法 400，无文件 404）
    if (req.method === "GET" && url.pathname === "/api/state") {
      const out = stateViewFor(url.searchParams.get("worldId") || "");
      res.writeHead(out.code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out.body));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth") {
      const loggedIn = fs.existsSync(path.join(os.homedir(), ".grok", "auth.json"));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ loggedIn }));
      return;
    }

    // 打包后的前端静态托管（生产/开发同构，前端请求一律走相对路径）
    if (req.method === "GET" && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
      const appDist = resolveAppDist();
      if (!appDist) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("app dist not built"); return; }
      let rel;
      try { rel = decodeURIComponent(url.pathname.slice("/app/".length)); } catch { rel = ""; }
      let file = rel ? path.join(appDist, rel) : path.join(appDist, "index.html");
      if (!path.resolve(file).startsWith(path.resolve(appDist) + path.sep)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(appDist, "index.html"); // SPA fallback
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
      return;
    }

    // 音频直服（CONTRACTS §1）：白名单形态 + path.resolve 前缀校验（与 /img 同款两道闸）；
    // 直接整文件 200（不做 Range——音频文件小，客户端拉全量即可），长缓存。
    if (req.method === "GET" && url.pathname === "/audio") {
      const p = url.searchParams.get("p") || "";
      if (AUDIO_REL_RE.test(p)) {
        const file = path.resolve(GAME_ROOT, p);
        if (file.startsWith(path.resolve(GAME_ROOT) + path.sep)) {
          const ext = path.extname(file).slice(1).toLowerCase();
          fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, {
              "content-type": AUDIO_MIME[ext] || "application/octet-stream",
              "cache-control": "public, max-age=86400",
            });
            res.end(data);
          });
          return;
        }
      }
      res.writeHead(404); res.end();
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
      const serve = /** @param {string} file */ (file) => fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
        res.end(data);
      });
      // t&n 齐备时，直服/落盘共用的目标：presets/<剧本 id>/assets/<类型>-<名>.jpg；
      // 封面（t=封面）走 assetTargetFile 的 presets/<id>/cover.jpg 分支——assets/封面-X.jpg 是死路径
      const targetRel = t && n ? assetTargetFile(t, n, targetPid || "") : "";
      const target = targetRel ? path.join(GAME_ROOT, targetRel) : "";
      // 新契约 ?t=<类型>&n=<名字>[&p=<会话路径>][&preset=<剧本 id>]：该剧本 assets 永久命中优先
      if (target && fs.existsSync(target)) { serve(target); return; }
      // 旧契约 / 会话兜底：当前会话 → 跨会话扫描；带 t&n 与剧本时顺手落盘到该剧本的 assets
      if (/^images\/\d+\.jpe?g$/.test(p) && ctx.sessionId) {
        const file = ctx.resolveImage(path.basename(p));
        if (file) {
          if (target) {
            try { ctx.persistAssetFromFile(t, n, file, targetPid || "", p); } catch {}
            if (fs.existsSync(target)) { serve(target); return; }
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
        const file = rel ? path.join(GAME_ROOT, rel) : "";
        if (file && fs.existsSync(file)) { serve(file); return; }
      }
      // 已落盘资产直服白名单（统一 jpe?g）：presets/<id>/assets/<文件> 与 presets/<id>/cover.jpg（resolve 后必须仍在 GAME_ROOT 内）
      if (/^presets\/[A-Za-z0-9_-]+\/assets\/[^/]+\.jpe?g$/.test(p) || /^presets\/[A-Za-z0-9_-]+\/cover\.jpe?g$/.test(p)) {
        const file = path.resolve(GAME_ROOT, p);
        if (file.startsWith(path.resolve(GAME_ROOT) + path.sep)) { serve(file); return; }
      }
      res.writeHead(404); res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      ctx.clients.add(res);
      req.on("close", () => ctx.clients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/prompt") {
      readBodyText(req, res, async (body) => {
        let text = "";
        try { text = JSON.parse(body).text || ""; } catch {}
        if (!text.trim()) { res.writeHead(400); res.end("{}"); return; }
        const r = await ctx.sendPrompt(text.trim());
        res.writeHead(r.ok ? 200 : 409, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      });
      return;
    }
    res.writeHead(404); res.end();
  };
}
