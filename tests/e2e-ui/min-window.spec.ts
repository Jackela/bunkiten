// 假引擎确定性 UI e2e ㉒：**最小窗口 1024×640**（v1.13）。
//
// 为什么单开一条：其余 spec 一律跑 1440×900，而应用声明的最小窗口过去是 960×640——**落在全站
// 唯二断点（1024 / 1280）之下**，于是「立绘让位」这类只在 ≥1024 生效的规则，在最窄的合法窗口里
// 整个是关掉的（`GameStage` 自己的注释写着「否则对话区会压在立绘上」）。把最小窗口提到 1024 之后，
// lg 档在任何合法窗口下恒真——这条用例就是把这句话钉在浏览器里：视口取 1024×640，逐条量几何。
//
// 覆盖四面（每面都是「在 1024 下必须成立」的契约）：
//   ① 游戏屏：立绘有真实布局盒、且对话面板不压在立绘上（让位生效）；
//   ② 捏人屏：两个开局入口在**不滚动**时可见（<xl 走固定底栏的事实）；
//   ③ 设置屏：lg 档两栏并排（音频/文本两块同一行）；
//   ④ 剧情图：lg 档两栏（节点详情在右侧栏，不与画布重叠）。
// 说明：这里量的是「布局契约」，不是像素级快照——断点或窗口尺寸改了就该重看这一条。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist } from "./flow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rift = (name: string) => readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", name));

/** 应用声明的最小窗口（`electron/main.js` 的 minWidth/minHeight）——改它就要改这里 */
const MIN_VIEWPORT = { width: 1024, height: 640 };

/** 剧情树：三节点小树（够画出画布与右栏详情） */
function smallTree(): string {
  return [
    "# 剧情树",
    "## 第 1 章：雨夜教堂",
    "- 目标: 弄清账册缺页的秘密",
    "- 当前进度: 节点 1-2（已走 1 轮）",
    "",
    "### 节点 1-1（门口初遇）",
    "- 地点: 教堂门口",
    "- 在场: 薇拉",
    "- 梗概: 雨夜初遇。",
    "- 出边: 迎上去 → 1-2",
    "- 状态: 已走过",
    "",
    "### 节点 1-2（中殿对话）",
    "- 地点: 教堂中殿",
    "- 在场: 薇拉",
    "- 梗概: 对话中得知账册缺了一页。",
    "- 状态: 可达",
    "",
  ].join("\n");
}

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [
      { id: "demo", title: "示例剧本", body: "# protagonist_card\n\n- 性别: 男 / 女\n- 身份: 转学插班生 / 重考生\n" },
    ],
    assets: {
      demo: [
        { name: "立绘-薇拉.jpg", bytes: rift("立绘-薇拉.jpg") },
        { name: "背景-教堂.jpg", bytes: rift("背景-灰雀镇教堂.jpg") },
      ],
    },
    trees: { w1: smallTree() },
    turns: [
      {
        match: "开局：",
        ops: [
          "雨声漫过教堂的尖顶，薇拉抱着账册站在门口。\n",
          "【图】立绘|薇拉|images/1.jpg\n",
          "【图】背景|教堂|images/2.jpg\n",
          "**行动**\n1. 撑伞迎上去\n2. 停在原地\n",
        ],
      },
    ],
    // 视口 = 应用声明的最小窗口（本 spec 的全部意义所在）
    contextOptions: { viewport: MIN_VIEWPORT },
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** 元素是否完整落在视口内（不滚动就看得见？） */
async function inViewport(loc: ReturnType<Page["getByTestId"]>): Promise<boolean> {
  const box = await loc.boundingBox();
  if (!box) return false;
  return box.y >= 0 && box.x >= 0 && box.y + box.height <= MIN_VIEWPORT.height + 1;
}

test("最小窗口 1024×640：让位生效、捏人屏动作不滚可见、设置与剧情图按 lg 档两栏", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");

  // ② 捏人屏：两个开局入口在不滚动时可见（<xl 走固定底栏；此前它们随右栏沉到全部问题之后）
  expect(
    await inViewport(page.getByTestId("protagonist-start")),
    "「制作美术并开演」在最小窗口下要滚到底才够得着",
  ).toBe(true);
  expect(await inViewport(page.getByTestId("skip-preload")), "「跳过美术，直接开演」在最小窗口下要滚到底才够得着").toBe(
    true,
  );

  // 进游戏屏（跳过美术：本 spec 只验版面，不验制作流水线）
  await page.getByRole("button", { name: "女", exact: true }).click();
  await page.getByRole("button", { name: "转学插班生", exact: true }).click();
  await page.getByTestId("skip-preload").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");

  // ① 游戏屏：立绘真占版面，且对话面板不压立绘（让位在最小窗口下必须成立）
  const portrait = page.getByRole("img", { name: "薇拉" });
  await expect(portrait).toBeVisible();
  const portraitBox = await portrait.boundingBox();
  expect(portraitBox, "立绘没有布局盒").not.toBeNull();
  expect(portraitBox!.width, "立绘渲染宽为 0").toBeGreaterThan(0);
  expect(
    await portrait.evaluate((el) => (el as HTMLImageElement).naturalWidth),
    "立绘没有解码（naturalWidth=0：空框也能有布局盒，别让这条断言白过）",
  ).toBeGreaterThan(0);
  const dialogue = await page.getByTestId("dialogue-box").boundingBox();
  expect(dialogue, "对话面板没有布局盒").not.toBeNull();
  expect(
    dialogue!.x + dialogue!.width,
    `最小窗口下对话区右缘 ${(dialogue!.x + dialogue!.width).toFixed(1)} 压住了立绘左缘 ${portraitBox!.x.toFixed(1)}（让位没生效）`,
  ).toBeLessThan(portraitBox!.x);

  // ③ 设置屏：lg 档两栏并排（音频 / 文本同一行）
  await page.getByTestId("settings").click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  const audio = await page.getByTestId("settings-audio").boundingBox();
  const text = await page.getByTestId("settings-text").boundingBox();
  expect(audio, "音频面板没有布局盒").not.toBeNull();
  expect(text, "文本面板没有布局盒").not.toBeNull();
  expect(Math.abs(audio!.y - text!.y), "最小窗口下设置屏没有按 lg 档并排（两块不在同一行）").toBeLessThan(4);
  expect(text!.x, "文本面板没在音频面板右侧").toBeGreaterThan(audio!.x + audio!.width - 1);
  await page.getByTestId("settings-back").click();

  // ④ 剧情图：lg 档两栏（详情在右栏，不与画布重叠）
  //    树文件由服务端在「规划」回合写；本 spec 只验版面，直接把树写进临时 game root（harness 把 root 交出来了）——
  //    世界是刚在屏上新建的，id 从索引里读，不猜命名规则。
  const harness = stack.stack;
  const indexDoc = JSON.parse(readFileSync(path.join(harness.root, "state", "worlds", "index.json"), "utf8"));
  const entries = Array.isArray(indexDoc) ? indexDoc : indexDoc.worlds;
  const world = entries.find((w: { worldId: string; preset: string }) => w.preset === "demo" && w.worldId !== "w1");
  expect(world, "没找到刚新建的世界线（索引里只有 seed 的 w1？）").toBeTruthy();
  writeFileSync(path.join(harness.root, "state", "worlds", world.worldId, "story-tree.md"), smallTree());

  await page.getByTestId("rail-collection").click();
  await page.getByTestId("tree").click();
  await expect(page.getByTestId("tree-canvas")).toBeVisible();
  await page.getByTestId("tree-canvas").getByRole("button", { name: /1-2/ }).first().click();
  const canvas = await page.getByTestId("tree-canvas-wrap").boundingBox();
  const detail = await page.getByTestId("tree-detail").boundingBox();
  expect(canvas, "画布没有布局盒").not.toBeNull();
  expect(detail, "节点详情没有布局盒").not.toBeNull();
  expect(
    detail!.x,
    `最小窗口下节点详情没进右栏（详情左缘 ${detail!.x.toFixed(1)} vs 画布右缘 ${(canvas!.x + canvas!.width).toFixed(1)}）`,
  ).toBeGreaterThan(canvas!.x + canvas!.width - 1);
});
