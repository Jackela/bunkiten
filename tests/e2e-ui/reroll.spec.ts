// 假引擎确定性 UI e2e ⑩：重演这一幕（reroll）全链。
// seed w1 两条 kind:"turn" 快照（seq 1/2，带 prompt 字段）；v1.14 起「继续世界：」这类重同步回合不进快照
// （turn_end main:false、seq:null），所以开局续玩那一跳**不再**写快照——本文件里的 seq 编号因此与 v1.13 差一位。
// 流程：世界线屏继续 w1 → game 就绪（开局回合选项含「推门进去」）→ 点选项消费回合甲（玩家输入永远落条目 → seq 3）
// →「进度 ▾ → 重演这一幕」开**可编辑对话框**（预填该幕记下的「推门进去」）→ 改写这句再确认 → store 解析目标幕
// （= 最近一条带输入的 turn 条目）与回退点（= 它之前最近的 turn 条目 seq 2）POST restore → 补发「继续世界：w1。」
// → 重同步回合收尾后自动重发**改写后的那句**（含「推门进去」子串，假引擎按子串命中 → 应笔回合乙）。
// 断言：对话框可见且预填原句、取消即时收框；改写后的句子原样到引擎（假引擎探针 kind:"prompt"）；分割线文案是
// 「—— 第 2 幕已重演 ——」（回退点 seq=2）、正文区出现回合乙、抽屉里回合甲在分割线之前已置灰（回合乙正常）。
// v1.13 追加收尾段：整页刷新（内存态全灭）+ 继续世界线后**仍可重演**——目标幕是刷新前最后演过的那一幕；
// v1.14 起这条路也先开对话框（预填盘上那句），确认（不改写）后照旧重演。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openRailGroup } from "./flow";

/** 玩家在重演对话框里改写的句子：仍含「推门进去」子串，假引擎按子串命中 → 应笔回合乙 */
const REROLL_LINE = "推门进去，先侧耳听一听。";

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

test("重演这一幕：可编辑对话框预填原句、改写后重演；刷新后仍可重演", async () => {
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

  // 就绪且快照数够 → 重演入口出现；点击**只开对话框**（v1.14 可编辑重演），不直接重演
  await openRailGroup(page, "进度");
  const reroll = page.getByTestId("reroll");
  await expect(reroll).toBeVisible();
  await reroll.click();
  const dialog = page.getByTestId("reroll-dialog");
  await expect(dialog).toBeVisible();

  // 取消：即时收框、什么都不演（入口仍在）
  await page.getByTestId("reroll-cancel").click();
  await expect(dialog).toHaveCount(0);
  await openRailGroup(page, "进度");
  await page.getByTestId("reroll").click();
  await expect(dialog).toBeVisible();

  // 重开：预填该幕（回合甲）记下的玩家输入
  const input = page.getByTestId("reroll-input");
  await expect(input).toHaveValue("推门进去");

  // 改写这句再确认：发给引擎的是**改写后的句子**（新句仍含「推门进去」，假引擎按子串命中）
  await input.fill(REROLL_LINE);
  await page.getByTestId("reroll-confirm").click();
  await expect(dialog).toHaveCount(0); // 确认后即时收框（刻意不做退场动画）

  // 重同步短回合收尾后自动重发改写句 → 回合乙上屏（整条链自动推进，等终态即可）
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("回合乙");
  // 探针：改写后的句子原样到了引擎（不是「再说一遍同一句错话」）
  await expect
    .poll(() => stack.stack.engineProbeEntries().some((e) => e.kind === "prompt" && e.text === REROLL_LINE))
    .toBe(true);
  await openRailGroup(page, "进度");
  expect(await page.getByTestId("reroll").isVisible()).toBe(true); // 连掷入口还在

  // 抽屉：分割线是 reroll 措辞；回退点是重演那一幕开演前的那一份。
  // v1.14：续玩/重同步回合不进快照，故下限是 seed 的 seq 2（v1.13 里那条「续玩条目 seq 3」已不存在）
  await openRailGroup(page, "回顾");
  await page.getByTestId("history").click();
  const rollback = page.getByTestId("history-rollback");
  await expect(rollback).toBeVisible();
  await expect(rollback).toHaveText("—— 第 2 幕已重演 ——");
  await expect(rollback).not.toContainText("#");
  const acts = page.getByTestId("history-act");
  await expect(acts.filter({ hasText: "回合甲" })).toHaveClass(/opacity-50/);
  await expect(acts.filter({ hasText: "回合乙" })).not.toHaveClass(/opacity-50/);

  // —— 刷新后仍可重演（v1.13：输入在盘上，不再依赖内存账本）——
  // 整页重载 = 内存全灭；「继续世界线」本身会跑一个续玩回合（重同步回合、不落条目），
  // 重演入口照旧在，点它开框（预填刷新前最后演过那一幕的输入）→ 确认 → 重演的是刷新前最后那一幕
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
  await expect(page.getByTestId("reroll-dialog")).toBeVisible();
  await expect(page.getByTestId("reroll-input")).toHaveValue(REROLL_LINE); // 预填 = 刷新前最后演过那一幕的输入
  await page.getByTestId("reroll-confirm").click();
  await expect(page.getByTestId("dialogue-text")).toContainText("回合丙");
});
