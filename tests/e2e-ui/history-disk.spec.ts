// 假引擎确定性 UI e2e（v1.14，ADR-0027 的「回想接磁盘」）：内存幕只活本会话，跨刷新的是
// `state/worlds/<worldId>/logs/NNNN.json`（append-only）。本文件两条：
//   ① 分页：给 w1 预写 60 条日志文件（node 侧直接落盘，与 writeTurnLog 的条目形状一致）→ 继续世界线
//      （再写一条日志）→「回顾 ▾ → 历史」→ 第一页 50 条 `history-disk-act` + 分界 `history-disk-divider`
//      +「加载更多」`history-load-more` 真能翻出更早的一页（60 条全在，按钮随即消失）。
//   ② 空态：把「继续世界线」的 POST 挂在浏览器侧（没到引擎 → 不写任何日志）→ 打开回想 →
//      `history-empty-disk`（本局与硬盘都空）出现，且不冒充 `history-empty-memory`。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openRailGroup } from "./flow";

/** 预写的日志条数（> 一页 50，才能让「加载更多」真的出现） */
const SEEDED_LOGS = 60;

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    // w2 不带任何日志（空态用例用它；w1 在下面手写 60 条）
    worlds: [{ id: "w2" }],
    turns: [{ match: "继续世界：", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n"] }],
  }));
  // 直接落 60 条日志（形状与 server writeTurnLog 一致：{seq,at,prompt,text}）。continue 那一跳会再写第 61 条。
  const logsDir = path.join(stack.stack.root, "state", "worlds", "w1", "logs");
  mkdirSync(logsDir, { recursive: true });
  for (let i = 1; i <= SEEDED_LOGS; i++) {
    writeFileSync(
      path.join(logsDir, `${String(i).padStart(4, "0")}.json`),
      JSON.stringify(
        {
          seq: i,
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          prompt: `第 ${i} 句`,
          text: `第 ${i} 幕的正文。\n`,
        },
        null,
        2,
      ) + "\n",
    );
  }
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("回想接磁盘：内存为空也列出硬盘记录，分页「加载更多」翻出更早一页", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");

  await openRailGroup(page, "回顾");
  await page.getByTestId("history").click();
  await expect(page.getByTestId("history-panel")).toBeVisible();

  // 内存态为空（continue 是重同步回合、不进 history）：列表是纯硬盘记录，第一页 50 条（DISK_HISTORY_PAGE）
  const rows = page.getByTestId("history-disk-act");
  await expect(rows).toHaveCount(50);
  await expect(page.getByTestId("history-disk-divider")).toBeVisible();
  // continue 那条（最新）在最前；更早的一页还没来，所以第 1 条日志此刻不在屏上
  await expect(rows.first()).toContainText("第 61 幕 · 硬盘记录");
  await expect(rows.filter({ hasText: "第 1 幕 · 硬盘记录" })).toHaveCount(0);

  // 「加载更多」翻下一段：60 条全在（60 预写 + 1 continue），按钮随之消失
  const more = page.getByTestId("history-load-more");
  await expect(more).toBeVisible();
  await more.click();
  await expect(rows).toHaveCount(SEEDED_LOGS + 1);
  await expect(rows.filter({ hasText: "第 1 幕的正文。" })).toHaveCount(1);
  await expect(page.getByTestId("history-load-more")).toHaveCount(0);
});

test("回想空态：本局与硬盘都没有内容时给「硬盘上也没有留下记录」", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 把「继续世界线」的 POST 挂在浏览器侧（没到引擎 → 不写日志 → 该世界硬盘上也空）
  await page.route("**/prompt", () => new Promise<void>(() => {}));
  await page.getByTestId("world-continue-w2").click();
  await expect(page.getByTestId("status")).toContainText("故事展开中");

  await openRailGroup(page, "回顾");
  await page.getByTestId("history").click();
  await expect(page.getByTestId("history-panel")).toBeVisible();

  // 空态是「硬盘也没有」那一支，不是 memory 那一支
  await expect(page.getByTestId("history-empty-disk")).toBeVisible();
  await expect(page.getByTestId("history-empty-disk")).toContainText("硬盘上也没有留下记录");
  await expect(page.getByTestId("history-empty-memory")).toHaveCount(0);
  await expect(page.getByTestId("history-disk-act")).toHaveCount(0);

  await page.unroute("**/prompt");
});
