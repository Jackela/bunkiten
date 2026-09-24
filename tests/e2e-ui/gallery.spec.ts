// 假引擎确定性 UI e2e ④：画廊（AssetsScreen overlay）——分组清单、选择模式批量删除（两段确认）、单项重绘。
// seed 6 个资产（3 立绘含 1 差分 + 3 背景，bytes 复用 presets/rift-mark 现成 jpg）；批量删除 2 背景 →
// 剩余 4 项；再对基础立绘「薇拉」走预览重绘：fake-engine 以 {match:"美术：重绘"} 回带 |重绘 第四段的
// 【图】标记回合。标记的 srcRel 用 presets/demo/assets/… 形态（resolvePersistPreset 能解出剧本 id，
// server 真实覆盖落盘——images/N.jpg 形态走 B1「拿不到剧本不落盘」是死路径），并断言磁盘上该文件
// 已被重绘回合的会话图字节覆盖。批次提示为 ok、状态回就绪、无 error。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, openRailGroup, quickStartToGame } from "./flow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rift = (name: string): Buffer => readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", name));

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    assets: {
      demo: [
        { name: "立绘-薇拉.jpg", bytes: rift("立绘-薇拉.jpg") },
        { name: "立绘-薇拉-微笑.jpg", bytes: rift("立绘-薇拉-微笑.jpg") },
        { name: "立绘-阿澈.jpg", bytes: rift("立绘-阿澈.jpg") },
        { name: "背景-教堂.jpg", bytes: rift("背景-灰雀镇教堂.jpg") },
        { name: "背景-旅店.jpg", bytes: rift("背景-灰雀镇旅店大堂.jpg") },
        { name: "背景-林地.jpg", bytes: rift("背景-围猎林地.jpg") },
      ],
    },
    // 重绘回合的覆盖源：会话图按 basename 命中（resolveImage("立绘-薇拉.jpg")），
    // 内容用差分「雨夜」——与 seed 进剧本目录的基础版字节可区分，供覆盖断言
    sessionImages: { "立绘-薇拉.jpg": rift("立绘-薇拉-雨夜.jpg") },
    turns: [
      { match: "开局：", ops: ["教堂的钟声停在半空，画廊的门却开着。\n\n**行动**\n1. 走进去\n2. 退回来\n"] },
      { match: "美术：重绘", ops: ["已重绘。\n\n【图】立绘|薇拉|presets/demo/assets/立绘-薇拉.jpg|重绘\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** 画廊素材卡总数（[data-testid^="asset-card-"]） */
const cardCount = (): Promise<number> => page.locator('[data-testid^="asset-card-"]').count();

test("画廊：分组清单→选择模式勾 2 项批量删除（两段确认）→剩余 4 项→单项重绘回就绪", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // TopBar 命令轨「图鉴 ▾ → 画廊」进画廊 overlay（v1.12：画廊收在「图鉴」菜单里）
  await openRailGroup(page, "图鉴");
  await page.getByTestId("assets").click();

  // 清单：6 项（立绘组 薇拉×2 + 阿澈×1、背景×3），按 testid 点名存在
  await expect.poll(cardCount).toBe(6);
  await expect(page.getByTestId("asset-card-薇拉")).toBeVisible();
  await expect(page.getByTestId("asset-card-薇拉-微笑")).toBeVisible();
  await expect(page.getByTestId("asset-card-阿澈")).toBeVisible();
  await expect(page.getByTestId("asset-card-教堂")).toBeVisible();
  await expect(page.getByTestId("asset-card-旅店")).toBeVisible();
  await expect(page.getByTestId("asset-card-林地")).toBeVisible();

  // 选择模式：工具栏出现，勾 2 个背景（点卡片即勾选，label htmlFor 指向 checkbox）
  await page.getByTestId("assets-select-toggle").click();
  await expect(page.getByTestId("assets-toolbar")).toBeVisible();
  await page.getByTestId("asset-card-教堂").click();
  await page.getByTestId("asset-card-林地").click();
  await expect(page.getByTestId("assets-delete-selected")).toContainText("2");

  // 批量删除两段确认：首点「删除选中」变确认态，二点才真删
  await page.getByTestId("assets-delete-selected").click();
  await page.getByTestId("assets-delete-confirm").click();
  await expect(page.getByTestId("assets-notice")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("assets-notice")).toContainText("已删除 2 项");
  await expect(page.getByTestId("asset-card-教堂")).toHaveCount(0);
  await expect(page.getByTestId("asset-card-林地")).toHaveCount(0);
  await expect.poll(cardCount).toBe(4);

  // 退出选择模式 → 浏览模式点开基础立绘「薇拉」预览 → 重新生成。
  // 屏障：卡片在两种模式下都存在、点击语义随 selectMode 翻转——等工具栏卸载（可重试）再点，
  // 否则重渲染完成前的点击会被当成勾选，后续断言偶发 10s 超时不可恢复
  await page.getByTestId("assets-exit-select").click();
  await expect(page.getByTestId("assets-toolbar")).toHaveCount(0);
  await page.getByTestId("asset-card-薇拉").click();
  await expect(page.getByTestId("assets-preview")).toBeVisible();

  // 素材级自然语言重绘（v1.12）：在预览里写一句要求，它必须**原样**到引擎（探针里那条 prompt 是铁证）
  await page.getByTestId("assets-regen-note").fill("头发改成短发");
  await page.getByTestId("assets-preview-regen").click();
  await expect
    .poll(() =>
      stack.stack
        .engineProbeEntries()
        .filter((e) => e.kind === "prompt")
        .map((e) => e.text),
    )
    .toContain("美术：重绘 立绘 薇拉：头发改成短发");

  // 重绘回合完成：批次提示 ok（|重绘 标记命中挂起项 → finishRegen(true)），画廊经 stamp 刷新
  await expect(page.getByTestId("assets-regen-notice")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("assets-regen-notice")).toContainText("重绘完成");

  // 落盘真实发生：磁盘上的基础立绘已被重绘回合的会话图字节覆盖（seed 时是基础版字节）
  const onDisk = readFileSync(path.join(stack.stack.root, "presets", "demo", "assets", "立绘-薇拉.jpg"));
  expect(onDisk.equals(rift("立绘-薇拉-雨夜.jpg"))).toBe(true);

  // 关预览、返回 game 屏：状态回就绪、无错误提示
  await page.getByTestId("assets-preview-close").click();
  await page.getByTestId("assets-back").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("assets-error")).toHaveCount(0);
});
