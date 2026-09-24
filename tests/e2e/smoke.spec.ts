// 真引擎冒烟 ×3（**会花真 token / 真图片额度**，一律不进 CI；跑之前先看前置，缺了就是 skip 而不是失败）：
// 1) Grok · 快速开局（跳过美术，无树路径）→ 首回合就绪 → 点选项 → 次回合就绪；
// 2) Grok · 章节制作（制作美术路径）：待命 → 「规划：第 1 章。」→ 立即跳过 → 「开演。」→ 就绪；
// 3) Codex · 快速开局（v1.11）：真随包 codex-acp + 真 ChatGPT 登录态，临时 HOME 里跑一个真实回合
//    ——不碰本机 ~/.codex 与 ~/.bunkiten（登录态是拷进临时 HOME 的副本）。
// 两/三条均断言对话窗正文不含「**行动**」选项段（v1.3 起选项段只由按钮呈现，不进打字机）。
// 回合预算：Grok 两条合计约 5 个真实回合；Codex 一条 1 个回合（省 token，够证明链路通）。
// 前置（缺哪条就 skip 哪条）：Grok 要 PATH 上有 grok CLI + ~/.grok/auth.json；Codex 要 ~/.codex/auth.json。
// @slow 标记便于 grep 过滤。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startStack } from "../helpers/stack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** 本 spec 只玩《盛夏偏差值》：开局前删掉该剧本的世界线（不动其它剧本的存档），结束再清一次 */
const E2E_PRESET = "campus-summer";
const WORLDS_INDEX = path.join(ROOT, "state", "worlds", "index.json");

/** PATH 上找一个可执行文件（与 server/engines.mjs 的 spawn 口径一致：真引擎就是按 PATH 找的） */
function resolveOnPath(name: string): string | null {
  for (const dir of String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)) {
    if (existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** Grok 冒烟的前置：CLI 在 PATH + 本机登录态。缺一条**那两条 Grok 用例**就 skip（Codex 用例有自己的前置）
 *  ——「没登录的人跑 e2e」不该变成 120s 后的失败 */
const GROK_SKIP_REASON = !resolveOnPath("grok")
  ? "本机 PATH 上没有 grok CLI（真引擎冒烟需要它）：装好后重跑"
  : !existsSync(path.join(os.homedir(), ".grok", "auth.json"))
    ? "本机没有 grok 登录态（~/.grok/auth.json）：终端 `grok login` 后重跑"
    : "";

/** Codex 冒烟的前置：真 ChatGPT 登录态（随包运行时随 npm ci 就有，玩家不必装 CLI） */
const CODEX_SKIP_REASON = existsSync(path.join(os.homedir(), ".codex", "auth.json"))
  ? ""
  : "本机没有 Codex 登录态（~/.codex/auth.json）：终端 `codex login`（或游戏里一键登录）后重跑";

function dropPresetWorlds() {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(WORLDS_INDEX, "utf8"));
  } catch {
    return; // 无索引 = 无世界线
  }
  // 索引的两种顶层形态都认（与 server 的 readWorldsIndex 同口径）：v1.8 及以前的裸数组，
  // 或 v1.9 起的版本化对象 `{ schema, worlds }`——本机跑 e2e 用的真实 game root 两种都可能存在。
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { worlds?: unknown }) : null;
  const index = (Array.isArray(raw) ? raw : envelope?.worlds) as { worldId?: string; preset?: string }[] | undefined;
  if (!Array.isArray(index)) return;
  const keep = index.filter((e) => e?.preset !== E2E_PRESET);
  for (const e of index) {
    if (e?.preset === E2E_PRESET && typeof e.worldId === "string") {
      rmSync(path.join(ROOT, "state", "worlds", e.worldId), { recursive: true, force: true });
    }
  }
  if (keep.length === index.length) return;
  // 写回当前形态；磁盘上原本是版本化对象时保留它的顶层其它键（同 server writeWorldsIndex 的读改写口径）
  writeFileSync(
    WORLDS_INDEX,
    JSON.stringify(envelope ? { ...envelope, worlds: keep } : { schema: 1, worlds: keep }, null, 2) + "\n",
  );
}

function cleanArtifacts() {
  dropPresetWorlds();
  const session = path.join(ROOT, ".shell-session.json");
  if (existsSync(session)) rmSync(session);
}

let stack: Awaited<ReturnType<typeof startStack>>;
let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  if (GROK_SKIP_REASON) return; // 整组已 skip：不启动任何进程（否则会白等 120s 再失败）
  cleanArtifacts();
  stack = await startStack();
  page = await (await browser.newContext()).newPage();
});

test.afterAll(async () => {
  cleanArtifacts();
  if (page) await page.close().catch(() => {});
  await stack?.stop();
});

/**
 * 两 test 共用的开局前半：轮播切到《盛夏偏差值》插卡，点「快速开局」预设主角（停在开局入口按钮前）。
 * @param p 目标页（缺省 = 文件级真 Grok 页；Codex 用例把自己的页传进来）
 */
async function openMidsummerQuickStart(p: Page = page) {
  // 标题屏：卡带轮播加载完成（中央卡出现即 /api/presets 已就绪）
  const centerCard = p.getByTestId("title-card-center");
  await expect(centerCard).toBeVisible();

  // 轮播切卡契约：→ 切下一张中央卡换人，← 切回（步进是瞬时状态，spring 动画只影响位置）
  await p.keyboard.press("ArrowRight");
  await expect(centerCard).not.toContainText("盛夏偏差值");
  await p.keyboard.press("ArrowLeft");
  await expect(centerCard).toContainText("盛夏偏差值");

  // 点中央卡「插卡」：插入动画（约 1s）后进世界线屏（v1.5 起选卡不再直接到捏人屏）
  await centerCard.click();
  await expect(p.getByTestId("worlds-screen")).toBeVisible();

  // 开一条全新世界线（POST /api/worlds create → 分配 id → 进捏人屏）
  await p.getByTestId("worlds-new").click();
  await expect(p.getByRole("heading", { name: "盛夏偏差值" })).toBeVisible();

  // 快速开局：用剧本 quick_start 预设主角
  await p.getByRole("button", { name: /快速开局/ }).click();
}

test("快速开局冒烟：两个真实引擎回合 @slow", async () => {
  test.skip(Boolean(GROK_SKIP_REASON), GROK_SKIP_REASON);
  // 实测回合受 image_gen 失败重试影响可超 240s（server 的 /prompt 超时为 600s），放宽单测预算
  test.setTimeout(900_000);
  await page.goto(stack.pageUrl);

  await openMidsummerQuickStart();

  // 跳过美术（不经过制作中屏）→ 直接进游戏；引擎按 preset opening 开场（无树、无【章】标记）
  await page.getByRole("button", { name: "跳过美术，直接开演" }).click();

  // 首回合：等引擎演完（server /prompt 超时 600s，回合必在此前终结为就绪或出错）
  await expect(page.getByTestId("status")).toHaveText("就绪", { timeout: 600_000 });

  // 正文出现（打字机追赶中，轮询长度）
  await expect
    .poll(async () => (await page.getByTestId("dialogue-text").innerText()).length, { timeout: 90_000 })
    .toBeGreaterThan(50);
  // 选项 ≥2：选项在打字机完成后才浮入（OptionList 依赖 typingDone），必须轮询等待。
  // 诊断并进**被轮询的值**：Playwright 的 `message` 只收字符串，传函数会被当成普通值拼进报错
  // （拿到的是函数源码文本，「对话区内容」其实一次都没渲染过——v1.13 修正）。
  await expect
    .poll(
      async () => {
        const count = await page.getByTestId("options").locator("button").count();
        if (count >= 2) return "就绪";
        const seen = (await page.getByTestId("dialogue-text").innerText()).slice(0, 300);
        return `options 只有 ${count} 个；对话区内容：${seen}`;
      },
      { timeout: 90_000 },
    )
    .toBe("就绪");
  // 选项段不进对话窗：正文只留剧情文本，「**行动**」与选项行由按钮呈现（显示层截断的回归断言。
  // options ≥2 时打字机已完成，若截断回归，纯文本渲染的 dialogue-text 里必含字面量「**行动**」）
  await expect(page.getByTestId("dialogue-text")).not.toContainText("**行动**");
  const firstText = await page.getByTestId("dialogue-text").innerText();

  // 点第一个选项 → 次回合演完，正文换新
  await page.getByTestId("options").locator("button").first().click();
  await expect(page.getByTestId("status")).toHaveText("就绪", { timeout: 600_000 });
  await expect
    .poll(
      async () => {
        const t = await page.getByTestId("dialogue-text").innerText();
        return t.length > 50 ? t : "";
      },
      { timeout: 90_000 },
    )
    .not.toBe(firstText);
});

test("章节制作冒烟：规划第 1 章后跳过并开演 @slow", async () => {
  test.skip(Boolean(GROK_SKIP_REASON), GROK_SKIP_REASON);
  // 三个引擎回合：待命确认（初始化）→ 规划（写剧情树+输出制作清单）→ 「开演。」开场。
  // 每回合 server /prompt 硬顶 600s，全程放宽单测预算。
  test.setTimeout(900_000);
  await page.goto(stack.pageUrl);

  await openMidsummerQuickStart();

  // 制作美术并开演 → 进制作中屏（v1.2 开局 = 第 1 章，init 待命阶段即见章节制作标题）
  await page.getByRole("button", { name: "制作美术并开演" }).click();
  await expect(page.getByRole("heading", { name: "制 作 中" })).toBeVisible();

  // 待命回合结束 → 自动发「规划：第 1 章。」进入 planning：大纲槽位转「撰写大纲与剧情树…」
  // （init 阶段槽位文案是「排队中」，此文案是 planning 子阶段独有；等待需覆盖整个待命回合）
  // v1.6 起状态文案同时出现在可见状态条与 sr-only 播报区（StatusAnnouncer），
  // getByText 会命中两个元素触发 strict mode——按 testid 精确锁定可见槽位
  await expect(page.getByTestId("crafting-plan-slot")).toHaveText("撰写大纲与剧情树…", { timeout: 600_000 });

  // 立即跳过，不等清单解析与真实出图：规划回合进行中点跳过 → 回合结束后自动发「开演。」
  await page.getByRole("button", { name: "跳过剩余，立即开演" }).click();

  // 跳过生效信号：规划回合终结后制作中屏 status 转「故事展开中…」（「开演。」已发出）。
  // 屏上文案走 playerStatus 映射（store 里的原串仍是「引擎演绎中…」），断言按玩家真正看到的写。
  // 规划回合要写剧情树，受引擎耗时影响，给足 600s。
  await expect(page.getByTestId("crafting-status")).toContainText("故事展开中…", { timeout: 600_000 });

  // 开场回合演完 → 制作中屏收尾切 game 屏；status 元素只在 game 屏 TopBar，出现即回合已定稿
  await expect(page.getByTestId("status")).toHaveText("就绪", { timeout: 600_000 });

  // 正文出现（打字机追赶中，轮询长度；每轮协议规格正文 150–350 字，>50 为宽松下界）
  await expect
    .poll(async () => (await page.getByTestId("dialogue-text").innerText()).length, { timeout: 90_000 })
    .toBeGreaterThan(50);
  // 选项 ≥2：树首节点的出边各化身为一个选项（规格 2–4 个）。诊断并进被轮询的值（理由同上一处）
  await expect
    .poll(
      async () => {
        const count = await page.getByTestId("options").locator("button").count();
        if (count >= 2) return "就绪";
        const seen = (await page.getByTestId("dialogue-text").innerText()).slice(0, 300);
        return `options 只有 ${count} 个；对话区内容：${seen}`;
      },
      { timeout: 90_000 },
    )
    .toBe("就绪");
});

/**
 * Codex 后端真跑一遍（v1.11）：真随包 codex-acp + 真 ChatGPT 登录态。
 * 省 token 的取舍：**只跑一个回合**（跳过美术的快速开局）——够证明「链路通 + 协议行对 + 状态落盘」，
 * 不想把每次冒烟都变成一次完整章节。
 */
test("Codex 后端冒烟：真随包 codex-acp + 真登录态，一个真实引擎回合 @slow", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(Boolean(CODEX_SKIP_REASON), CODEX_SKIP_REASON);
  test.setTimeout(900_000);

  // 临时 HOME：把真登录态**拷**一份进来 + 写 engine=codex 的凭据——只读本机 ~/.codex 与 ~/.bunkiten，
  // 绝不改写它们（与游戏里 CODEX_HOME 的隔离同一口径，见 docs/adr/0022）。
  const home = mkdtempSync(path.join(os.tmpdir(), "bunkiten-e2e-codex-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  copyFileSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(home, ".codex", "auth.json"));
  cleanArtifacts(); // 与 Grok 两条同一块地：开跑前把本剧本的旧世界线清掉
  const codexStack = await startStack({
    homeDir: home,
    credentials: {
      version: 1,
      engine: "codex",
      llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
      image: { mode: "off", provider: "openai", baseUrl: "", apiKey: "", model: "", size: "" },
    },
  });
  const codexPage = await (await browser.newContext()).newPage();
  try {
    // boot：codex 登录态在 → 直接放行进标题屏（顺带证明 /api/auth 的引擎分支与整条启动链）
    await codexPage.goto(codexStack.pageUrl);
    await expect(codexPage.getByTestId("title-card-center")).toBeVisible();

    await openMidsummerQuickStart(codexPage);
    // 跳过美术（省 token / 省出图额度）：引擎按 preset opening 开场
    await codexPage.getByRole("button", { name: "跳过美术，直接开演" }).click();
    await expect(codexPage.getByTestId("status")).toHaveText("就绪", { timeout: 600_000 });

    // 协议行契约：正文出现 + 选项 ≥2（`**行动**` 段被解析成按钮、不进打字机）
    await expect
      .poll(async () => (await codexPage.getByTestId("dialogue-text").innerText()).length, { timeout: 120_000 })
      .toBeGreaterThan(50);
    await expect
      .poll(
        async () => {
          const count = await codexPage.getByTestId("options").locator("button").count();
          if (count >= 2) return "就绪";
          const seen = (await codexPage.getByTestId("dialogue-text").innerText()).slice(0, 300);
          return `options 只有 ${count} 个；对话区内容：${seen}`;
        },
        { timeout: 120_000 },
      )
      .toBe("就绪");
    await expect(codexPage.getByTestId("dialogue-text")).not.toContainText("**行动**");

    // SKILL 的状态纪律：引擎按世界线写了 state.md（「它真的在按 bunkiten 的规则演」的硬证据）
    const worldsRoot = path.join(ROOT, "state", "worlds");
    const stateTexts = readdirSync(worldsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(worldsRoot, d.name, "state.md"))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, "utf8"));
    expect(
      stateTexts.some((t) => t.includes(`- preset: ${E2E_PRESET}`)),
      `引擎没按 SKILL 写 state.md（state/worlds/*/state.md 里没有 preset: ${E2E_PRESET}）`,
    ).toBe(true);
  } finally {
    await codexPage.close().catch(() => {});
    await codexStack.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
