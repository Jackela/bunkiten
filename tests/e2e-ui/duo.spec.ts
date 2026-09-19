// 假引擎确定性 UI e2e ⑭：同屏多立绘（v1.9，上限 2）。
// 走「开局 → 第二人上屏 → 发言者换人（队列重排）→ 第三人上屏淘汰最早出场者」四个回合，
// 每回合都量几何：**对话面板宽 > 700px**，且屏上每张立绘的左缘都在面板右缘之外（两人时也不许压上去）。
// 这条只能在真浏览器里验：jsdom 不排版（没有行盒、vh 不解析），立绘的宽度来自「h-[46vh] + 图片固有
// 比例 0.75」这条链，只有真排版才量得出；让位档（.portrait-reserve-duo）与并排宽度是同一道算术的两半，
// 任何一半被改（高度档、间距、预留配额、max-w 上限）都会在这里红。
// 另钉住「亮/暗与名牌归属」：发言者（队列末位）全亮带名牌，非发言者压暗（computed opacity 0.55）无名牌，
// 且名牌的**结构归属**正确（挂在那个人形 figure 里，不是随便挂在层上）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, quickStartToGame } from "./flow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 现成的真实立绘素材（864×1152，3:4——立绘宽度 = 高度 × 0.75 的前提） */
const rift = (name: string) => readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", name));

/** 让位硬约束：面板宽 > 700px，且屏上每一张立绘都不与面板重叠（逐张量，不是只量最左那张） */
async function expectStageFits(page: Page, where: string) {
  const dialogue = await page.getByTestId("dialogue-box").boundingBox();
  expect(dialogue, `${where}：对话框没有布局盒`).not.toBeNull();
  expect(dialogue!.width, `${where}：对话面板被立绘让位挤窄了（硬约束 > 700px）`).toBeGreaterThan(700);

  const figures = page.getByTestId("portrait-figure");
  const n = await figures.count();
  expect(n, `${where}：屏上人形数量不对`).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const fig = figures.nth(i);
    const img = fig.locator("img").first();
    const who = await img.getAttribute("alt");
    const box = await fig.boundingBox();
    expect(box, `${where}：立绘 ${who} 的 boundingBox 为 null（挂了但没有布局盒）`).not.toBeNull();
    expect(box!.width, `${where}：立绘 ${who} 渲染宽为 0`).toBeGreaterThan(0);
    expect(box!.height, `${where}：立绘 ${who} 渲染高为 0`).toBeGreaterThan(0);
    expect(
      await img.evaluate((el) => (el as HTMLImageElement).naturalWidth),
      `${where}：立绘 ${who} 没有解码（naturalWidth=0）`,
    ).toBeGreaterThan(0);
    expect(
      dialogue!.x + dialogue!.width,
      `${where}：对话区右缘 ${(dialogue!.x + dialogue!.width).toFixed(1)} 压住了立绘 ${who} 左缘 ${box!.x.toFixed(1)}（立绘 ${box!.width.toFixed(1)}×${box!.height.toFixed(1)}）`,
    ).toBeLessThan(box!.x);
  }
}

/** 人形 figure 的按名取用（figure 是布局盒的载体，img 只是它里面的画） */
const figureOf = (page: Page, name: string): Locator => page.locator(`[data-testid="portrait-figure"]:has(img[alt="${name}"])`);

/** 量一次给报告用的数：面板宽 / 各立绘左右缘（真机数值，避免「注释里的数字」与实况漂开） */
async function measure(page: Page) {
  const dialogue = await page.getByTestId("dialogue-box").boundingBox();
  const figures = await page.getByTestId("portrait-figure").evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return {
        who: (el.querySelector("img") as HTMLImageElement | null)?.alt ?? "?",
        speaker: el.getAttribute("data-speaker") === "true",
        left: Math.round(box.left * 10) / 10,
        right: Math.round(box.right * 10) / 10,
        w: Math.round(box.width * 10) / 10,
        h: Math.round(box.height * 10) / 10,
      };
    }),
  );
  return { panelW: Math.round((dialogue?.width ?? 0) * 10) / 10, panelRight: Math.round(((dialogue?.x ?? 0) + (dialogue?.width ?? 0)) * 10) / 10, figures };
}

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    // 单剧本轮播（flow.ts 的前提）；快速开局不需要 protagonist_card 小节
    presets: [{ id: "demo", title: "示例剧本" }],
    assets: {
      demo: [
        { name: "立绘-薇拉.jpg", bytes: rift("立绘-薇拉.jpg") },
        { name: "立绘-薇拉-微笑.jpg", bytes: rift("立绘-薇拉-微笑.jpg") },
        { name: "立绘-阿澈.jpg", bytes: rift("立绘-阿澈.jpg") },
        { name: "立绘-布洛克.jpg", bytes: rift("立绘-布洛克.jpg") },
        { name: "背景-教堂.jpg", bytes: rift("背景-灰雀镇教堂.jpg") },
      ],
    },
    turns: [
      {
        // 回合 1：薇拉独自上屏（单人的让位档照旧）
        match: "开局：",
        ops: [
          "雨声漫过教堂的尖顶，薇拉抱着账册站在门口。\n",
          "【图】立绘|薇拉|images/1.jpg\n",
          "【图】背景|教堂|images/2.jpg\n",
          "**行动**\n1. 迎上去\n2. 停在原地\n",
        ],
      },
      {
        // 回合 2：阿澈上屏 → 同屏 2 人（薇拉压暗留场，阿澈是发言者）
        match: "迎上去",
        ops: [
          "阿澈从雨幕里探出半个身子，把伞递了过来。\n",
          "【图】立绘|阿澈|images/4.jpg\n",
          "**行动**\n1. 递伞给她\n2. 继续站着\n",
        ],
      },
      {
        // 回合 3：薇拉切差分（她自己那张图 0.4s 交叉淡入，与她在场序里的移动互不依赖）→ 她移到队列末位
        // 成为发言者，两人左右换位；阿澈的基础图原样不动（每张图各自的淡入/回退链在并排时照旧）
        match: "递伞给她",
        ops: [
          "薇拉没有接伞，只把账册往怀里收了收，嘴角动了一下。\n",
          "【立绘】薇拉|微笑\n",
          "**行动**\n1. 朝石阶上喊一声\n2. 转身离开\n",
        ],
      },
      {
        // 回合 4：第三人（布洛克）上屏 → 从队首淘汰最早出场的那位（此时是阿澈），屏上仍是 2 人
        match: "朝石阶上喊一声",
        ops: ["布洛克撑着伞从石阶上走下来。\n", "【图】立绘|布洛克|images/5.jpg\n"],
      },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("同屏 2 立绘：两人都有真实布局盒、名牌只归发言者、对话面板 > 700px 且不被任何一张压住", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // ——— 回合 1：单人（回归基线：单人档照旧）———
  await expect(page.getByTestId("dialogue-text")).toContainText("薇拉抱着账册");
  await expect(page.getByRole("img", { name: "薇拉" })).toBeVisible();
  await expect(page.getByTestId("portrait-figure")).toHaveCount(1);
  await expect(page.getByTestId("portrait-nameplate")).toHaveText("薇拉");
  await expectStageFits(page, "单人（薇拉）");
  const solo = await measure(page);
  // 单人档：58vh/720 = 417.6 高、×0.75 ≈ 313 宽——与 global.css 里那句注释同源
  expect(solo.figures[0].h).toBeCloseTo(417.6, 0);
  expect(solo.panelW).toBeGreaterThan(700);
  expect(solo.panelRight).toBeLessThan(solo.figures[0].left);

  // ——— 回合 2：第二位上屏 → 同屏 2 人 ———
  await page.getByTestId("options").locator("button").first().click();
  await expect(page.getByTestId("dialogue-text")).toContainText("阿澈从雨幕里探出半个身子");
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("portrait-figure")).toHaveCount(2);
  await expect(page.getByRole("img", { name: "薇拉" })).toBeVisible();
  await expect(page.getByRole("img", { name: "阿澈" })).toBeVisible();

  // 队列左→右 = 出场到发言：薇拉（先上屏）在左、阿澈（后上屏=发言者）在右
  const duo = await measure(page);
  expect(duo.figures.map((f) => f.who)).toEqual(["薇拉", "阿澈"]);
  expect(duo.figures.map((f) => f.speaker)).toEqual([false, true]);
  expect(duo.figures[1].right, "发言者应是最右边那位（队列末位）").toBeGreaterThan(duo.figures[0].right);

  // 名牌只归发言者，且**挂在她自己的 figure 里**（结构归属，不是只看文本在不在）
  await expect(page.getByTestId("portrait-nameplate")).toHaveCount(1);
  await expect(figureOf(page, "阿澈").getByTestId("portrait-nameplate")).toHaveText("阿澈");
  await expect(figureOf(page, "薇拉").getByTestId("portrait-nameplate")).toHaveCount(0);

  // 亮/暗：非发言者压暗（VN 的 dim 约定），发言者全亮。压暗档落在图那一层
  // （外层是 framer 的 motion 元素，内联 opacity 会盖掉类）
  const dimOpacity = await figureOf(page, "薇拉").locator("div").first().evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(dimOpacity), "非发言者没有被压暗（opacity 不是 .55）").toBeCloseTo(0.55, 2);
  const leadOpacity = await figureOf(page, "阿澈").locator("div").first().evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(leadOpacity), "发言者被压暗了（应该全亮）").toBeCloseTo(1, 2);
  const leadFilter = await figureOf(page, "阿澈").locator("div").first().evaluate((el) => getComputedStyle(el).filter);
  expect(leadFilter, "发言者不该带降饱和滤镜").not.toContain("saturate");

  // 同屏 2 人的双硬约束：面板 > 700px，两张立绘都不压面板
  await expectStageFits(page, "同屏 2 人（薇拉+阿澈）");

  // ——— 回合 3：【立绘】薇拉|微笑 → 她切差分（图自己交叉淡入）**且**移到队尾成为发言者 ———
  await page.getByTestId("options").locator("button").first().click();
  await expect(page.getByTestId("dialogue-text")).toContainText("薇拉没有接伞");
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("portrait-nameplate")).toHaveText("薇拉");
  await expect(figureOf(page, "薇拉")).toHaveAttribute("data-speaker", "true");
  await expect(figureOf(page, "阿澈")).toHaveAttribute("data-speaker", "false");
  await expect(page.getByTestId("portrait-figure")).toHaveCount(2); // 重排不新增人形
  // 差分交叉淡入收尾：那张 figure 里只剩新差分一张图（旧基础图 0.4s 后卸载），且新图真解码
  const veraImgs = figureOf(page, "薇拉").locator("img");
  await expect(veraImgs).toHaveCount(1);
  await expect(veraImgs).toHaveAttribute("src", /立绘-薇拉-微笑|%E7%AC%91/);
  expect(await veraImgs.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expectStageFits(page, "换发言者后（阿澈+薇拉）");
  const swapped = await measure(page);
  expect(swapped.figures.map((f) => f.speaker)).toEqual([false, true]);
  expect(swapped.figures[1].who, "发言者换人后仍是最右边那位").toBe("薇拉");

  // ——— 回合 4：第三人上屏 → 淘汰最早出场者，屏上仍是 2 人 ———
  await page.getByTestId("options").locator("button").first().click();
  await expect(page.getByTestId("dialogue-text")).toContainText("布洛克撑着伞");
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("portrait-figure")).toHaveCount(2);
  await expect(page.getByTestId("portrait-nameplate")).toHaveText("布洛克");
  // 被淘汰的那位人形与她的图都退出 DOM（退场淡出结束后不残留）
  await expect(figureOf(page, "阿澈")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "阿澈" })).toHaveCount(0);
  const trio = await measure(page);
  expect(trio.figures.map((f) => f.who)).toEqual(["薇拉", "布洛克"]);
  expect(trio.figures.map((f) => f.speaker)).toEqual([false, true]);
  await expectStageFits(page, "第三人上屏后（薇拉+布洛克）");

  // 报告用数值（真机实测；断言本身不依赖这段，删掉不影响门禁）
  console.log(`[duo] solo=${JSON.stringify(solo)}\n[duo] duo=${JSON.stringify(duo)}\n[duo] swapped=${JSON.stringify(swapped)}\n[duo] trio=${JSON.stringify(trio)}`);
});
