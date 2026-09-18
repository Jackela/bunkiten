// 真引擎冒烟 ×2：
// 1) 快速开局（跳过美术，无树路径）→ 首回合就绪 → 点选项 → 次回合就绪；
// 2) 章节制作（制作美术路径）：待命 → 「规划：第 1 章。」→ 立即跳过 → 「开演。」→ 就绪。
// 两 test 均断言对话窗正文不含「**行动**」选项段（v1.3 起选项段只由按钮呈现，不进打字机）。
// 允许合计消耗约 5 个真实引擎回合。@slow 标记便于 grep 过滤。
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startStack } from "../helpers/stack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** 本 spec 只玩《盛夏偏差值》：开局前删掉该剧本的世界线（不动其它剧本的存档），结束再清一次 */
const E2E_PRESET = "campus-summer";
const WORLDS_INDEX = path.join(ROOT, "state", "worlds", "index.json");

function dropPresetWorlds() {
  let index: { worldId?: string; preset?: string }[] = [];
  try {
    index = JSON.parse(readFileSync(WORLDS_INDEX, "utf8"));
  } catch {
    return; // 无索引 = 无世界线
  }
  if (!Array.isArray(index)) return;
  const keep = index.filter((e) => e?.preset !== E2E_PRESET);
  for (const e of index) {
    if (e?.preset === E2E_PRESET && typeof e.worldId === "string") {
      rmSync(path.join(ROOT, "state", "worlds", e.worldId), { recursive: true, force: true });
    }
  }
  if (keep.length !== index.length) writeFileSync(WORLDS_INDEX, JSON.stringify(keep, null, 2) + "\n");
}

function cleanArtifacts() {
  dropPresetWorlds();
  const session = path.join(ROOT, ".shell-session.json");
  if (existsSync(session)) rmSync(session);
}

let stack: Awaited<ReturnType<typeof startStack>>;
let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  cleanArtifacts();
  stack = await startStack();
  page = await (await browser.newContext()).newPage();
});

test.afterAll(async () => {
  cleanArtifacts();
  if (page) await page.close().catch(() => {});
  await stack?.stop();
});

/** 两 test 共用的开局前半：轮播切到《盛夏偏差值》插卡，点「快速开局」预设主角（停在开局入口按钮前） */
async function openMidsummerQuickStart() {
  // 标题屏：卡带轮播加载完成（中央卡出现即 /api/presets 已就绪）
  const centerCard = page.getByTestId("title-card-center");
  await expect(centerCard).toBeVisible();

  // 轮播切卡契约：→ 切下一张中央卡换人，← 切回（步进是瞬时状态，spring 动画只影响位置）
  await page.keyboard.press("ArrowRight");
  await expect(centerCard).not.toContainText("盛夏偏差值");
  await page.keyboard.press("ArrowLeft");
  await expect(centerCard).toContainText("盛夏偏差值");

  // 点中央卡「插卡」：插入动画（约 1s）后进世界线屏（v1.5 起选卡不再直接到捏人屏）
  await centerCard.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 开一条全新世界线（POST /api/worlds create → 分配 id → 进捏人屏）
  await page.getByTestId("worlds-new").click();
  await expect(page.getByRole("heading", { name: "盛夏偏差值" })).toBeVisible();

  // 快速开局：用剧本 quick_start 预设主角
  await page.getByRole("button", { name: /快速开局/ }).click();
}

test("快速开局冒烟：两个真实引擎回合 @slow", async () => {
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
  // 选项 ≥2：选项在打字机完成后才浮入（OptionList 依赖 typingDone），必须轮询等待
  await expect
    .poll(async () => page.getByTestId("options").locator("button").count(), {
      timeout: 90_000,
      message: async () => `options 为 0，对话区内容：${(await page.getByTestId("dialogue-text").innerText()).slice(0, 300)}`,
    })
    .toBeGreaterThanOrEqual(2);
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
  // 选项 ≥2：树首节点的出边各化身为一个选项（规格 2–4 个）
  await expect
    .poll(async () => page.getByTestId("options").locator("button").count(), {
      timeout: 90_000,
      message: async () => `options 为 0，对话区内容：${(await page.getByTestId("dialogue-text").innerText()).slice(0, 300)}`,
    })
    .toBeGreaterThanOrEqual(2);
  // 选项段不进对话窗（同快速开局 test：显示层截断的回归断言）
  await expect(page.getByTestId("dialogue-text")).not.toContainText("**行动**");
});
