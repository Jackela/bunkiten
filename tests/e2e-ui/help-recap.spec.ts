// 假引擎确定性 UI e2e（v1.14，ADR-0027 元命令本地化）：帮助面板与前情提要都是**本地合成、零引擎回合**。
// 命令轨「帮助」→ help-panel（命令轨说明卡 + 键盘卡 + 「打开日志目录」按钮）→ Esc 先关面板、不退屏；
// 「回顾 ▾ → 前情」→ recap-panel（recap-meta 的章号/时间/地点 + recap-entries 的本地提要）。
// 「零回合」的判据：假引擎探针里 kind:"prompt" 的条数在开关这两个面板前后不变——本地面板若误发指令，
// 这里会当场红（比「status 恰好没变」稳）。
// 前置：seed 一份带时间/地点的 state.md 与一条带 summary 的快照；继续世界线跑一个真实回合（写一条
// logs/NNNN.json，供 recap 的 entries 取用）。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openRailGroup } from "./flow";

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    stateFiles: { w1: "# 剧情状态\n- preset: demo\n- 时间: 第三夜 · 雨停后\n- 场景: 灰雀镇廉价旅店 202 房\n" },
    snapshots: {
      w1: [
        {
          seq: 1,
          kind: "turn",
          nodeId: "1-1",
          chapterNo: 1,
          prompt: "走向门口。",
          files: {
            state: "# 剧情状态\n- preset: demo\n- 场景: 教堂门口（快照一）\n",
            summary: "# 前情摘要（滚动）\n- 门口初遇\n",
            tree: "# 剧情树\n## 第 1 章\n- 当前进度: 节点 1-1（已走 1 轮）\n",
          },
        },
      ],
    },
    turns: [{ match: "继续世界：", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n"] }],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** 探针里已到达引擎的 prompt 条数（本地面板「零回合」的判据） */
function promptCount(): number {
  return stack.stack.engineProbeEntries().filter((e) => e.kind === "prompt").length;
}

test("帮助与前情：命令轨本地打开、Esc 关面板不退屏，且都不发引擎回合", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");

  const promptsBefore = promptCount();

  // —— 命令轨「帮助」：本地面板（零回合）——
  await page.getByTestId("help").click();
  const help = page.getByTestId("help-panel");
  await expect(help).toBeVisible();
  await expect(page.getByTestId("help-rail")).toBeVisible();
  await expect(page.getByTestId("help-keys-card")).toBeVisible();
  await expect(page.getByTestId("help-open-logs")).toBeVisible();

  // Esc 先关面板（关闭链第一环），不误把游戏屏也退了
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(page.getByTestId("dialogue-text")).toBeVisible();
  await expect(page.getByTestId("worlds-screen")).toHaveCount(0);

  // —— 「回顾 ▾ → 前情」：本地合成（零回合）——
  await openRailGroup(page, "回顾");
  await page.getByTestId("recap").click();
  const recap = page.getByTestId("recap-panel");
  await expect(recap).toBeVisible();
  // 数据落定后：meta 有当前时间/地点、entries 有最近回合 + 最新快照的摘要
  await expect(page.getByTestId("recap-loading")).toHaveCount(0);
  await expect(page.getByTestId("recap-meta")).toContainText("第三夜");
  await expect(page.getByTestId("recap-meta")).toContainText("灰雀镇");
  await expect(page.getByTestId("recap-entries")).toContainText("门口初遇");
  await expect(page.getByTestId("recap-entries")).toContainText("雨停了");

  await page.keyboard.press("Escape");
  await expect(recap).toHaveCount(0);
  await expect(page.getByTestId("worlds-screen")).toHaveCount(0);

  // 零引擎回合：开关这两个面板不往引擎发任何 prompt
  expect(promptCount()).toBe(promptsBefore);
});
