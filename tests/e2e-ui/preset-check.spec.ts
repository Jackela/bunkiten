// 假引擎确定性 UI e2e ⑪：剧本体检屏（check overlay，v1.8）。
// 路径：boot → 标题屏角落「剧本体检」（对象 = 当前中央卡）→ 屏上拿到 doctor 的报告 →「返回」回标题屏，
// 再进一次用 Esc 走同一条关闭链（overlay 屏的 screenReturn）。
// 断言只钉**形状**、不钉条数与级别：命中哪些检查由 scripts/doctor.mjs 说了算（假栈 seed 的是极简剧本，
// 必然被判出若干条警告），把「几项通过 / 第几组有几行」写死等于把用例绑在体检口径上，改判定就红一片。
// 这里要证明的是「屏真的把 doctor 的报告渲染出来了」：摘要行是 doctor 的小结口径、至少一个分组块、
// 块里至少一行条目（严重度 chip + 行原文）。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openTitleMore } from "./flow";

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    // 单剧本轮播（标题屏中央卡恒有卡可检）；不推演，无需回合脚本
    presets: [{ id: "demo", title: "示例剧本" }],
    turns: [],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("剧本体检：标题屏入口进屏 → 摘要 + 至少一组条目 → 返回/Esc 回到标题屏", async () => {
  await page.goto(stack.pageUrl);
  await expect(page.getByTestId("title-card-center")).toBeVisible();

  // 角落入口（store 的 selected 此刻还是空，体检对象由这一击自己带进去）
  await openTitleMore(page);
  await page.getByTestId("preset-check").click();
  await expect(page.getByTestId("preset-check-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: /剧\s*本\s*体\s*检/ })).toBeVisible();
  // 眉标是体检对象（当前卡的标题），不是空行
  await expect(page.getByTestId("shell-page")).toContainText("示例剧本");

  // 摘要行：doctor 的小结口径「N 项通过 · M 警告 · K 错误」（数字不写死）；下面还有一句结论口径
  await expect(page.getByTestId("preset-check-summary")).toContainText(/项通过/);
  await expect(page.getByTestId("preset-check-verdict")).toBeVisible();

  // 至少一个分组块，块里有组名与至少一行条目（条目 = 级别 chip + 行原文）
  const groups = page.locator('[data-testid^="preset-check-group-"]');
  await expect.poll(async () => groups.count()).toBeGreaterThanOrEqual(1);
  await expect(groups.first().getByRole("heading")).not.toHaveText(/^\s*$/);
  await expect.poll(async () => groups.first().locator("li").count()).toBeGreaterThanOrEqual(1);

  // 「返回」回标题屏（overlay 关闭链：screenReturn=title），轮播卡重新上屏
  await page.getByTestId("preset-check-back").click();
  await expect(page.getByTestId("title-card-center")).toBeVisible();
  await expect(page.getByTestId("preset-check-screen")).toHaveCount(0);

  // 再进一次：Esc 走同一条关闭链（App 的 Esc 链里 screen === "check" → closeOverlay）
  await openTitleMore(page);
  await page.getByTestId("preset-check").click();
  await expect(page.getByTestId("preset-check-screen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("title-card-center")).toBeVisible();
  await expect(page.getByTestId("preset-check-screen")).toHaveCount(0);
});
