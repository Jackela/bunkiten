// 打包态 · 真出图（opt-in，**不进 CI**；见 playwright.electron.config.ts 文件头）：
// 唯一一条把「打包布局 + asar + 主进程 + **真 grok CLI** + **真图片服务（bunkiten-media MCP）**」
// 串起来端到端验一遍的 spec——它**真花一次引擎对话、真出并落盘一张 jpg**（用你自己的 grok 登录态与
// 自备图片服务 key）。dev / 假栈 / 集成层都验不到这条路：那三层要么走 vite、要么用假引擎垫片，
// 要么不碰打包态 resources/game 下的资产落盘契约。
//
// 前置（缺一即干净跳过，见下方三个 test.skip）：
//   ① 打包产物 release/mac-<arch>/Bunkiten.app（先跑 `npm run dist:mac:dir`）；
//   ② 可用图片服务凭据——优先 env `BUNKITEN_E2E_CREDENTIALS`（JSON 字符串，形状同 credentials.json），
//      否则读真实 `~/.bunkiten/credentials.json`；要求 image 组 `mode=byok` 且 baseUrl/apiKey/model 齐全；
//   ③ 本机真实 grok CLI（解析见 resolveRealGrok；**在改写 HOME 之前**用原始 PATH/家目录解析）。
//   另外还需要**本机已登录 grok CLI**（引擎靠真登录态跑回合，见下方 GROK_HOME 说明）。
//
// 网络：本机直连被挡时，用代理启动（`https_proxy=… all_proxy=… npx playwright test -c playwright.electron.config.ts
// tests/e2e-packaged/real-image.spec.ts`）——launch env 铺开了 `...process.env`，代理变量会随 env 透传给
// electron 子进程（进而到 acp-server / grok / 图片服务请求）。
//
// 与 packaged.spec 的三处关键差异（沿用其搭法，另加两个打包态才暴露的坑）：
//   · **临时 HOME + 真 grok**：main.js 会把 `~/.grok/bin` 前置到 PATH，而临时 HOME 下那个目录归我们管——
//     在临时 HOME 的 `~/.grok/bin/grok` 放垫片 `exec 真身` 即必胜（放别处会被本机装的真 grok 盖掉）。
//   · **真登录态的落点**：HOME 被改写成临时目录后，真 grok 默认会在临时 `~/.grok` 找 auth.json——那里没有登录。
//     所以额外把 `GROK_HOME` 指向**真实** grok 家目录（`~/.grok`；可用 env GROK_HOME 覆盖），真 CLI 才能拿到
//     本机登录态（`GROK_HOME` = grok 的配置目录，见 `grok --help`/README 的 env 表）。项目级 skill
//     仍从 cwd（= 打包态 resources/game）的 `.grok/skills` 发现，不受 GROK_HOME 影响。
//   · **一次性确定触发**：引擎的「生成前缓存检查（硬规则）」会在资产已存在时跳过出图，而打包产物的
//     `presets/<id>/assets/` 本就带立绘——所以不走「制作美术」路径（那条只会命中缓存、零出图）。
//     改走【素材重绘】= SKILL 里**唯一允许绕过缓存**的路径：画廊里对一张已有立绘点「重新生成」，
//     引擎必重出并覆盖同名文件。断言对象因此钉死在「该剧本 assets 目录里某个 jpg 的 mtime 变了」。
//
// 已知副作用（都写在最终报告里，别在这里偷偷改产品行为）：
//   · 打包态 GAME_ROOT 是 .app 内的 resources/game（main.js 写死），重绘会**覆盖**里面的一张 jpg——
//     本 spec 在收尾把原字节恢复回去（内容与运行前逐字一致，只多一次 mtime 变化）。
//   · 真 grok 会在真实 `~/.grok/sessions/` 下为这个 gameRoot 落一份会话目录（不在本 spec 清理范围内）。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { maskKey, normalizeCredentials, writeCredentials } from "../../server/credentials.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** release/ 里的 .app（mac-arm64 / mac / mac-x64 都认；取 mtime 最新的一个）——与 packaged.spec 同款 */
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
/** Contents 目录（Bunkiten.app/Contents/MacOS/Bunkiten → 上两级）；打包态 GAME_ROOT 在它下面的 Resources/game */
const APP_CONTENTS = APP_BIN ? path.resolve(APP_BIN, "..", "..") : null;
const APP_GAME_ROOT = APP_CONTENTS ? path.join(APP_CONTENTS, "Resources", "game") : null;

// ---- 真凭据：env 优先，其次真实 ~/.bunkiten/credentials.json（形状与 server/credentials.mjs 同口径） ----
const REAL_HOME = os.homedir();
/** 真实 grok 家目录（可被 env GROK_HOME 覆盖）——垫片之外，真 CLI 靠它拿到本机登录态 */
const REAL_GROK_HOME = process.env.GROK_HOME?.trim() || path.join(REAL_HOME, ".grok");

/** 解析真 grok 二进制：优先真实 `~/.grok/bin`，其次 /usr/local/bin、/opt/homebrew/bin（不解析就不跑） */
function findRealGrok(): string | null {
  const candidates = [path.join(REAL_GROK_HOME, "bin", "grok"), "/usr/local/bin/grok", "/opt/homebrew/bin/grok"];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c; // 跟随 symlink（~/.grok/bin/grok 通常是指向 downloads/ 的软链）
    } catch {
      /* 不存在，试下一个 */
    }
  }
  return null;
}

interface CredsPick {
  source: string;
  /** normalize 过的凭据文档；解析/读取失败为 null */
  creds: ReturnType<typeof normalizeCredentials> | null;
  error: string;
}

/** 真凭据来源：env `BUNKITEN_E2E_CREDENTIALS`（JSON 字符串）→ 否则真实 credentials.json */
function resolveCreds(): CredsPick {
  const envRaw = process.env.BUNKITEN_E2E_CREDENTIALS?.trim();
  if (envRaw) {
    try {
      return { source: "env BUNKITEN_E2E_CREDENTIALS", creds: normalizeCredentials(JSON.parse(envRaw)), error: "" };
    } catch {
      return { source: "env BUNKITEN_E2E_CREDENTIALS", creds: null, error: "JSON 解析失败" };
    }
  }
  const file = path.join(REAL_HOME, ".bunkiten", "credentials.json");
  if (!existsSync(file)) return { source: file, creds: null, error: "文件不存在" };
  try {
    return { source: file, creds: normalizeCredentials(JSON.parse(readFileSync(file, "utf8"))), error: "" };
  } catch (e) {
    return { source: file, creds: null, error: `JSON 解析失败：${(e as Error).message}` };
  }
}

const CREDS_PICK = resolveCreds();
const CREDS_OK =
  !!CREDS_PICK.creds &&
  CREDS_PICK.creds.image.mode === "byok" &&
  !!CREDS_PICK.creds.image.baseUrl &&
  !!CREDS_PICK.creds.image.apiKey &&
  !!CREDS_PICK.creds.image.model;

const REAL_GROK = findRealGrok();

const SKIP_APP = APP_BIN === null;
const SKIP_CREDS = !CREDS_OK;
const SKIP_GROK = REAL_GROK === null;

/**
 * 收尾：**先关窗口再 close**，close 卡住就 SIGKILL——SSE 长连接会让主进程的 will-quit 一直等下去
 * （同 packaged.spec：`/events` 不断，stopServer() 就永远等连接散尽）。冒烟/出图都不该把 worker 挂死。
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

/** 目录快照：文件名 → {size, mtimeMs}（出图前后各取一次，用 mtime 判定「真的重出了一张」） */
function snapshotDir(dir: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const st = statSync(path.join(dir, name));
      out[name] = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      /* 读不到就跳过 */
    }
  }
  return out;
}

test("打包态真出图：真 grok CLI + 真图片服务，画廊重绘落一张新 jpg @slow", async () => {
  // 真花一次引擎对话 + 一张图，尺度对齐 smoke.spec.ts（单回合 /prompt 超时 600s、出图还有自己的 90s 上限）
  test.setTimeout(900_000);

  // ---- 三个守门：缺前置即干净跳过，并把原因写进控制台（缺一即 return，后面不再碰任何文件） ----
  console.log(
    `[real-image] 前置：app=${APP_BIN ?? "(无)"}；grok=${REAL_GROK ?? "(无)"}；` +
      `凭据来源=${CREDS_PICK.source}${CREDS_PICK.error ? `（${CREDS_PICK.error}）` : ""}` +
      `${CREDS_PICK.creds ? `；image.mode=${CREDS_PICK.creds.image.mode} key=${maskKey(CREDS_PICK.creds.image.apiKey) || "(空)"} model=${CREDS_PICK.creds.image.model || "(空)"}` : ""}`,
  );
  test.skip(SKIP_APP, "未找到打包产物：先跑 `npm run dist:mac:dir`（产物在 release/mac-<arch>/Bunkiten.app）");
  test.skip(
    SKIP_CREDS,
    `无可用图片服务凭据（${CREDS_PICK.source}）：需要 image 组 mode=byok 且 baseUrl/apiKey/model 齐全` +
      "——可用 env BUNKITEN_E2E_CREDENTIALS 传 JSON，或配置真实 ~/.bunkiten/credentials.json",
  );
  test.skip(SKIP_GROK, "解析不到真 grok 二进制：本机需安装并登录 grok CLI（候选 ~/.grok/bin、/usr/local/bin、/opt/homebrew/bin）");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "bunkiten-realimg-"));
  const home = path.join(tmp, "home");
  const shimDir = path.join(home, ".grok", "bin"); // main.js 的第一个 PATH 前缀；临时 HOME 下归我们管
  mkdirSync(shimDir, { recursive: true });

  // 凭据写进临时 HOME（0600，复用产品自己的 writeCredentials）：出图 MCP 读 os.homedir() = 这个 HOME。
  // 全程不打印 key 明文——上面只打掩码。
  writeCredentials(home, CREDS_PICK.creds);
  // app 的 boot 自检只看 `~/.grok/auth.json` 是否存在（server/routes.mjs 的 /api/auth）；真登录由 GROK_HOME 负责
  writeFileSync(path.join(home, ".grok", "auth.json"), "{}\n");
  // PATH 垫片：临时 HOME 的 ~/.grok/bin/grok → exec 真身（放别处会被本机真 grok 盖掉）
  const shim = path.join(shimDir, "grok");
  writeFileSync(shim, `#!/bin/sh\nexec '${REAL_GROK}' "$@"\n`);
  chmodSync(shim, 0o755);

  /** 目标资产目录（打包态 GAME_ROOT 内）——运行后收尾只动这里 */
  let assetsDir = "";
  /** 出图前快照 + 目标文件原字节（收尾恢复用） */
  let before: Record<string, { size: number; mtimeMs: number }> | null = null;
  let targetAbs = "";
  let targetRel = "";
  let targetBackup: Buffer | null = null;

  let app: ElectronApplication | null = null;
  const appLogs: string[] = [];

  try {
    app = await electron.launch({
      executablePath: APP_BIN as string,
      env: {
        ...process.env,
        HOME: home, // 临时 HOME：凭据 / 会话目录隔离，都在里面
        PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`, // 垫片目录前置（main.js 也会再前置一次）
        BUNKITEN_DISABLE_UPDATE: "1", // 打包态会查更新：出图测试不该联网查更新
        GROK_HOME: REAL_GROK_HOME, // 真 CLI 的配置目录 → 真实登录态（HOME 被改写后，默认会指向空临时目录）
      },
    });
    app.process().stdout?.on("data", (d) => appLogs.push(String(d)));
    app.process().stderr?.on("data", (d) => appLogs.push(String(d)));

    const win: Page = await app.firstWindow();

    // 标题屏渲染（剧本来自打包态 resources/game/presets）
    await expect(win.getByTestId("title-wordmark")).toBeVisible({ timeout: 60_000 });
    await expect(win.getByTestId("title-card-center")).toBeVisible({ timeout: 60_000 });

    // 引擎握手：acp-server 的 `[acp] grok session ready:` 走主进程 stdout（与 tests/helpers/stack.mjs 同一条线）。
    // 就绪前点「重新生成」会撞 /prompt 409；boot 失败要连日志一起报出来（真 grok 在临时 HOME 下跑不通时就看这里）。
    const ready = () => appLogs.join("");
    await expect
      .poll(() => ready().includes("grok session ready") || ready().includes("boot failed"), {
        timeout: 180_000,
        message: () => `引擎未就绪；app logs=${ready().slice(-1500)}`,
      })
      .toBe(true);
    expect(ready(), `引擎 boot 失败（真 grok 未跑起来）：\n${ready().slice(-2000)}`).not.toContain("boot failed");

    // 当前剧本 id：标题屏导出链接的 testid 就带着它（比按标题反查稳）。画廊「素材」入口用的正是这张中央卡。
    const exportLoc = win.locator('[data-testid^="preset-export-"]');
    await expect(exportLoc).toHaveCount(1);
    const presetId = (await exportLoc.getAttribute("data-testid"))!.slice("preset-export-".length);

    // 目标：该剧本 assets 里的一张**基础立绘**（文件名 `立绘-<名>.jpg`，无差分后缀）。
    // 重绘它 → 引擎必按 SKILL 覆盖同名文件，名字完全可确定。
    assetsDir = path.join(APP_GAME_ROOT as string, "presets", presetId, "assets");
    const basePortraits = existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => /^立绘-[^-]+\.jpg$/.test(f)) : [];
    if (!existsSync(assetsDir) || basePortraits.length === 0) {
      console.log(`[real-image] 剧本 ${presetId} 的 assets 目录没有可重绘的基础立绘：${assetsDir}`);
      test.skip(true, `打包态剧本 ${presetId} 的 assets 里没有可重绘的基础立绘（${assetsDir}）`);
      return;
    }
    const targetFile = basePortraits[0];
    const targetName = targetFile.replace(/^立绘-/, "").replace(/\.jpg$/, "");
    const cardTestId = `asset-card-${targetName}`;
    targetRel = `presets/${presetId}/assets/${targetFile}`;
    targetAbs = path.join(assetsDir, targetFile);

    before = snapshotDir(assetsDir);
    targetBackup = readFileSync(targetAbs); // 收尾恢复用（内容逐字还原，别把包里自带的图留成重绘版）
    const beforeMtime = before[targetFile]?.mtimeMs ?? 0;
    console.log(`[real-image] 目标：${targetRel}（${before[targetFile]?.size ?? 0}B）→ 画廊重绘一次`);

    // 标题屏「素材」→ 画廊（openAssets(current)：selected 落到当前剧本）
    await win.getByRole("button", { name: "素材", exact: true }).click();
    const card = win.getByTestId(cardTestId);
    await expect(card, `画廊里没有目标立绘卡（testid=${cardTestId}）`).toBeVisible({ timeout: 30_000 });
    await card.click();
    await expect(win.getByTestId("assets-preview")).toBeVisible({ timeout: 15_000 });

    // 「重新生成」= 发 `美术：重绘 立绘 <名>`，一次引擎回合（SKILL【素材重绘】唯一绕过缓存的路径）
    await win.getByTestId("assets-preview-regen").click();

    // 关键断言：目标 jpg 的 mtime 前进且字节数 > 0（真出了一张、真落了盘）。
    // 驱动是引擎回合（写剧情树/出图都不由我们控制时序），一律用 expect.poll，绝不写死 sleep。
    await expect
      .poll(
        () => {
          try {
            const st = statSync(targetAbs);
            return st.mtimeMs > beforeMtime && st.size > 0;
          } catch {
            return false;
          }
        },
        {
          timeout: 700_000,
          message: async () => {
            const notice = await win.getByTestId("assets-regen-notice").textContent().catch(() => null);
            return (
              `重绘后目标 jpg 未更新：${targetRel}\n` +
              `目录现状=${JSON.stringify(snapshotDir(assetsDir))}\n` +
              `画廊提示=${notice ?? "(无)"}\n` +
              `app logs=${ready().slice(-1200)}`
            );
          },
        },
      )
      .toBe(true);

    // 收尾强断言：新文件确实非空（poll 已含 size>0，这里再读一次做「字节数」的显式证据）
    const after = statSync(targetAbs);
    expect(after.size, `重绘后的 ${targetFile} 应有正字节数`).toBeGreaterThan(0);

    // 可选：/img 直服也 200（落盘契约的另一半——画廊/预载都靠它把这张图取回）
    const port = new URL(win.url()).port;
    const res = await fetch(`http://127.0.0.1:${port}/img?p=${encodeURIComponent(targetRel)}`);
    expect(res.status, `/img 直服 ${targetRel} 应 200`).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length, `/img 直服 ${targetRel} 应回非空字节`).toBeGreaterThan(0);
  } finally {
    if (app) await closeApp(app);
    // 收尾：① 恢复被重绘覆盖的那张 jpg（内容与运行前逐字一致）；② 只删本次新增的 jpg（绝不动包里自带的）
    if (assetsDir && existsSync(assetsDir)) {
      if (targetAbs && targetBackup) {
        try {
          writeFileSync(targetAbs, targetBackup);
        } catch {
          /* 恢复失败也不该盖住真正的断言结果 */
        }
      }
      if (before) {
        for (const f of readdirSync(assetsDir)) {
          if (!(f in before)) {
            try {
              rmSync(path.join(assetsDir, f));
            } catch {
              /* 删不掉就留着，已在报告里说明 */
            }
          }
        }
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
