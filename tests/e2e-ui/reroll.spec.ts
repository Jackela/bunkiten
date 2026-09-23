// 假引擎确定性 UI e2e ⑩：重演这一幕（reroll）全链。
// seed w1 两条 kind:"turn" 快照（seq 1/2，带 prompt 字段；files 与磁盘三文件不同——继续世界的回合因此会落一条
// 实时快照 seq 3，见 docs/adr/0023 的条目形状）。流程：世界线屏继续 w1 → game 就绪（开局回合选项含「推门进去」）
// → 点选项消费回合甲（v1.13 起玩家输入永远落条目，files 没变也落 seq 4）→ 点「重演」→ store 解析目标幕
// （= 最近一条带输入的 turn 条目）与回退点（= 它之前最近的 turn 条目）POST restore → 补发「继续世界：w1。」
// （fake-engine 第二条同 match 应答回短正文）→ 重同步回合收尾后自动重发「推门进去」（脚本第三条同 match
// 应笔回合乙，match 条目按序不重复消费）。断言：分割线文案是「—— 第 3 幕已重演 ——」（回退点 seq=3，
// 即重演回合开演前的那一份）、正文区出现回合乙、抽屉里回合甲在分割线之前已置灰（回合乙正常）。
// v1.13 追加收尾段：整页刷新（内存态全灭）+ 继续世界线后**仍可重演**——目标幕是刷新前最后演过的那一幕。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openRailGroup } from "./flow";


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
          prompt: "走向门口。",
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
          prompt: "推开教堂的门。",
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
      // 重演后 store 补发的「继续世界：w1。」——重同步短回合（正文故意不出选项段）
      { match: "继续世界：", ops: ["重读档：画面回到快照二的教堂中殿。\n"] },
      // 上一条缺 **行动** → 质量守卫自动追问一次；不给这条应答，追问会按顺次把「回合乙」条目吃掉
      { match: "补充：", ops: ["**行动**\n1. 检视四周\n"] },
      // 重同步收尾后自动重发的「推门进去」（第二次，内容与上一掷不同）
      { match: "推门进去", ops: ["回合乙：这次门后传来脚步声，烛火没有晃。\n\n**行动**\n1. 停步\n"] },
      // —— 刷新段（v1.13）：重载后的「继续世界线」与它的重演各一套 ——
      { match: "继续世界：", ops: ["又回到中殿，烛火重新亮起。\n\n**行动**\n1. 往侧门看\n"] },
      { match: "继续世界：", ops: ["重读档：烛火停在上一幕结束的位置。\n"] },
      { match: "补充：", ops: ["**行动**\n1. 环顾\n"] },
      { match: "推门进去", ops: ["回合丙：同一扇门后，这回是纸页翻动的声音。\n\n**行动**\n1. 靠近\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("重演这一幕：退回目标幕开演前 → 重同步 → 自动重发同一输入；刷新后仍可重演", async () => {
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

  // 就绪且快照数够 → 重演入口出现；点击后按盘上条目解析（目标幕 = 回合甲、回退点 = 它前面那条续玩条目）
  await openRailGroup(page, "进度");
  const reroll = page.getByTestId("reroll");
  await expect(reroll).toBeVisible();
  await reroll.click();

  // 重同步短回合收尾后自动重发「推门进去」→ 回合乙上屏（整条链自动推进，等终态即可）
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("回合乙");
  await openRailGroup(page, "进度");
  expect(await page.getByTestId("reroll").isVisible()).toBe(true); // 连掷入口还在

  // 抽屉：分割线是 reroll 措辞；回退点是重演那一幕开演前的那一份（seq 3 = 进屏时的续玩条目），
  // 文案不带快照 # 序号——reroll 走「第 N 幕已重演」，restore 走「已回溯到第 N 幕」
  await openRailGroup(page, "回顾");
  await page.getByTestId("history").click();
  const rollback = page.getByTestId("history-rollback");
  await expect(rollback).toBeVisible();
  await expect(rollback).toHaveText("—— 第 3 幕已重演 ——");
  await expect(rollback).not.toContainText("#");
  const acts = page.getByTestId("history-act");
  await expect(acts.filter({ hasText: "回合甲" })).toHaveClass(/opacity-50/);
  await expect(acts.filter({ hasText: "回合乙" })).not.toHaveClass(/opacity-50/);

  // —— 刷新后仍可重演（v1.13：输入在盘上，不再依赖内存账本）——
  // 整页重载 = 内存全灭；「继续世界线」本身会跑一个续玩回合（prompt 空、三文件没变 → 不落条目），
  // 重演入口照旧在，点它重演的是刷新前最后演过的那一幕（回合乙）——脚本最后一条「推门进去」→ 回合丙
  await page.reload();
  const card2 = page.getByTestId("title-card-center");
  await expect(card2).toBeVisible();
  await card2.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await openRailGroup(page, "进度");
  const reroll2 = page.getByTestId("reroll");
  await expect(reroll2).toBeVisible(); // 刷新前没做的事：以前刷新后这个入口直接消失
  await reroll2.click();
  await expect(page.getByTestId("dialogue-text")).toContainText("回合丙");
});
