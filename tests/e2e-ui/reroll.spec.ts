// 假引擎确定性 UI e2e ⑩：重掷本回合（reroll）全链。
// seed w1 两条 kind:"turn" 快照（seq 1/2，files 与磁盘三文件不同——继续世界的回合因此会落一条实时
// 快照 seq 3）。流程：世界线屏继续 w1 → game 就绪（开局回合选项含「推门进去」）→ 点选项消费回合甲 →
// 点「重掷」→ store 取次新 turn 快照（= 2）POST restore → 补发「继续世界：w1。」（fake-engine 第二条
// 同 match 应答回短正文）→ 重同步回合收尾后自动重发「推门进去」（第二条同 match 应笔回合乙，
// match 条目按序不重复消费）。断言：分割线文案是「—— 第 2 幕已重演 ——」、正文区出现回合乙、
// 抽屉里回合甲在分割线之前已置灰（回合乙正常）。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    snapshots: {
      w1: [
        {
          seq: 1,
          kind: "turn",
          nodeId: "1-1",
          chapterNo: 1,
          files: {
            state: "# 剧情状态\n- preset: demo\n- 场景: 教堂门口（快照一）\n",
            summary: "# 前情摘要（滚动）\n- 快照一：门口初遇\n",
            tree: "# 剧情树\n## 第 1 章\n- 当前进度: 节点 1-1（已走 1 轮）\n",
          },
        },
        {
          seq: 2,
          kind: "turn",
          nodeId: "1-2",
          chapterNo: 1,
          files: {
            state: "# 剧情状态\n- preset: demo\n- 场景: 教堂中殿（快照二）\n",
            summary: "# 前情摘要（滚动）\n- 快照二：中殿对话\n",
            tree: "# 剧情树\n## 第 1 章\n- 当前进度: 节点 1-2（已走 2 轮）\n",
          },
        },
      ],
    },
    turns: [
      // 进屏时的「继续世界：w1。」——开局回合，选项含「推门进去」
      { match: "继续世界：", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n2. 原地等待\n"] },
      // 点选项后的回合甲（第一次「推门进去」）
      { match: "推门进去", ops: ["回合甲：门轴一声闷响，中殿的烛火晃了晃。\n\n**行动**\n1. 往里走\n"] },
      // 重掷后 store 补发的「继续世界：w1。」——重同步短回合（正文故意不出选项段）
      { match: "继续世界：", ops: ["重读档：画面回到快照二的教堂中殿。\n"] },
      // 上一条缺 **行动** → 质量守卫自动追问一次；不给这条应答，追问会按顺次把「回合乙」条目吃掉
      { match: "补充：", ops: ["**行动**\n1. 检视四周\n"] },
      // 重同步收尾后自动重发的「推门进去」（第二次，内容与上一掷不同）
      { match: "推门进去", ops: ["回合乙：这次门后传来脚步声，烛火没有晃。\n\n**行动**\n1. 停步\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("重掷本回合：退回次新快照 → 重同步 → 自动重发同一输入；分割线与置灰可见", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 继续 w1 → game 就绪（开局回合）；点选项「推门进去」消费回合甲
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await page.getByRole("button", { name: /推门进去/ }).click();
  await expect(page.getByTestId("dialogue-text")).toContainText("回合甲");

  // 就绪 + 有上一回合输入 → 重掷入口出现；点击后退回次新 turn 快照并让引擎重读档
  const reroll = page.getByTestId("reroll");
  await expect(reroll).toBeVisible();
  await reroll.click();

  // 重同步短回合收尾后自动重发「推门进去」→ 回合乙上屏（整条链自动推进，等终态即可）
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("回合乙");
  expect(await page.getByTestId("reroll").isVisible()).toBe(true); // 连掷入口还在

  // 抽屉：分割线是 reroll 措辞（退到的是次新 turn 快照 seq=2 = 刚结束那一幕的重演位）；
  // v1.7 文案不再带快照 # 序号——reroll 走「第 N 幕已重演」，restore 走「已回溯到第 N 幕」
  await page.getByTestId("history").click();
  const rollback = page.getByTestId("history-rollback");
  await expect(rollback).toBeVisible();
  await expect(rollback).toHaveText("—— 第 2 幕已重演 ——");
  await expect(rollback).not.toContainText("#");
  const acts = page.getByTestId("history-act");
  await expect(acts.filter({ hasText: "回合甲" })).toHaveClass(/opacity-50/);
  await expect(acts.filter({ hasText: "回合乙" })).not.toHaveClass(/opacity-50/);
});
