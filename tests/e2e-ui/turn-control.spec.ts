// 假引擎确定性 UI e2e（v1.14，ADR-0026 回合取消与失败隔离）：用假引擎的 `__HOLD__` 挂起闸把**一个回合**
// 挂住（含 `__HOLD__` 的 prompt 不回任何 session/update、也不回 result，直到收到 session/cancel；触发方式
// 冻结在 tests/integration/fake-engine.mjs 文件头）。流程：
//   继续 w1 进 game → 自由输入一句含 `__HOLD__` 的话 → 顶栏出现 turn-cancel、忙态可读 →
//   忙碌期「进度」菜单里的「重开」「换剧本」禁用且 title 给出原因 → 点「停止」→ busy 清除、状态「已停止」、
//   亮「待重同步」徽章、**不产生新快照**（/api/history 条数不变）→ 再发一句普通输入 → 引擎照常回应
//   （挂起只对含 `__HOLD__` 的那回合生效；取消后客户端会先补发「继续世界：」重同步，再重发玩家那句）。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openRailGroup } from "./flow";

/** 触发挂起闸的自由输入（含 __HOLD__ 子串即挂起；刻意不含脚本里的任何 match 子串） */
const HOLD_LINE = "站着不动，听雨（__HOLD__）";
/** 取消之后玩家再发的那句话（脚本按「看看四周」子串命中） */
const NEXT_LINE = "看看四周。";

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
            summary: "# 前情摘要（滚动）\n- 门口初遇\n",
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
            summary: "# 前情摘要（滚动）\n- 中殿对话\n",
            tree: "# 剧情树\n## 第 1 章\n- 当前进度: 节点 1-2（已走 2 轮）\n",
          },
        },
      ],
    },
    turns: [
      { match: "继续世界：", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n"] },
      // 取消后客户端补发的「继续世界：」重同步回合
      { match: "继续世界：", ops: ["重读档：画面回到烛火边。\n\n**行动**\n1. 继续\n"] },
      { match: "看看四周", ops: ["四周静得很，只有雨声。\n\n**行动**\n1. 停下\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** w1 的逐轮快照条数（取消不写快照的负向判据） */
async function snapshotCount(): Promise<number> {
  const r = await stack.stack.getJSON("/api/history?worldId=w1");
  return ((r.body as { snapshots?: unknown[] }).snapshots ?? []).length;
}

test("停止本回合：__HOLD__ 挂起 → 停止清忙态、不写快照；随后普通输入照常回应", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");

  const snapsBefore = await snapshotCount();

  // —— 发一句含 __HOLD__ 的话：引擎挂住不回，顶栏忙态 + 「停止」按钮出现 ——
  const input = page.getByTestId("free-input-field");
  await input.fill(HOLD_LINE);
  await page.getByTestId("free-input-send").click();
  await expect(page.getByTestId("status")).toContainText("故事展开中");
  const stop = page.getByTestId("turn-cancel");
  await expect(stop).toBeVisible();

  // 忙碌期「进度」菜单：「重开」「换剧本」禁用且 title 说明原因（别让玩家点了没反应）
  await openRailGroup(page, "进度");
  await expect(page.getByTestId("new-game")).toBeDisabled();
  await expect(page.getByTestId("new-game")).toHaveAttribute("title", /忙碌中/);
  await expect(page.getByTestId("presets")).toBeDisabled();
  await expect(page.getByTestId("presets")).toHaveAttribute("title", /忙碌中/);
  await page.keyboard.press("Escape"); // 只收菜单（swallowEscape）
  await expect(page.getByTestId("rail-progress-menu")).toHaveCount(0);

  // 挂起的回合不落快照
  expect(await snapshotCount()).toBe(snapsBefore);

  // —— 停止：busy 清除、状态「已停止」、亮「待重同步」（引擎可能停在半完成处，下一句先重同步）——
  await stop.click();
  await expect(page.getByTestId("status")).toHaveText("已停止");
  await expect(page.getByTestId("turn-cancel")).toHaveCount(0);
  await expect(page.getByTestId("resync-badge")).toBeVisible();
  expect(await snapshotCount()).toBe(snapsBefore); // 取消也不写快照

  // —— 挂起只对含 __HOLD__ 的那回合生效：再发一句普通输入 → 先重同步、再重发这句，引擎照常回应 ——
  await input.fill(NEXT_LINE);
  await page.getByTestId("free-input-send").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("四周静得很");
  await expect(page.getByTestId("resync-badge")).toHaveCount(0); // 重同步成功清徽章
  expect(await snapshotCount()).toBe(snapsBefore + 1); // 这句是正戏回合 → 落一条快照
});
