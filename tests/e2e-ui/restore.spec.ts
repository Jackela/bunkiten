// 假引擎确定性 UI e2e ⑦：快照原地回退后的画面重建，与回退后重同步的失败/恢复路径。
// seed w1 两条 kind:"turn" 快照（seq 1/2，state 场景与树文各不相同，nodeId 与树文一致），当前树文含快照 1
// 的节点 1-1。流程：世界线屏继续 w1 → game 就绪 → 进剧情图 → 点节点 1-1 → 详情见快照标注 →
// 「回退到此节点（原地）」两段确认 → server 覆盖三文件（先备份）→ store 补发「继续世界：w1。」→
// fake-engine 以 {match:"继续世界："} 回续演正文。断言（宽松 contains）：
// tree-notice 出现「已回退」、返回 game 屏后状态就绪、正文区出现续演文本；
// 第二个 test 让回退后的第一条「继续世界：」在**浏览器侧被掐断**（POST /prompt 被 route.abort，没到引擎）→
// 图屏提示「重同步失败」、返回 game 屏后 TopBar 亮待重同步徽章 + 再同步按钮 → 点再同步，同 match 的 turn 回
// 成功正文 → 徽章消失（match 条目不重复消费，天然按序）。
// 为什么掐在浏览器侧、不用假引擎 {error}：v1.14 失败回合的 SSE error 带 `stale:true`（ADR-0026），客户端的
// error 处理把它当「迟到/失焦」——不复位 `currentTurn`，于是**再同步那一回合的事件被 staleEvent 整条丢弃**、
// 徽章再也清不掉（详见收尾报告）。这里改用代码同样明确支持的失败模式「重同步指令没发出去」
//（server/routes 的 409 / 网络异常，见 gameplay send 的错误路径）来守「徽章 + 再同步 → 重试成功清除」的契约。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openRailGroup } from "./flow";

/** w1 当前三节点树（进度指针 1-2；含快照 1 的节点 1-1，供点选回退） */
function currentTree(): string {
  return [
    "# 剧情树",
    "## 第 1 章：雨夜教堂",
    "- 目标: 弄清账册缺页的秘密",
    "- 当前进度: 节点 1-2（已走 2 轮）",
    "",
    "### 节点 1-1（门口初遇）",
    "- 地点: 教堂门口",
    "- 在场: 薇拉",
    "- 梗概: 雨夜初遇，薇拉抱着账册站在灯下。",
    "- 出边: 迎上去 → 1-2；绕开 → 1-3",
    "- 状态: 已走过",
    "",
    "### 节点 1-2（中殿对话）",
    "- 地点: 教堂中殿",
    "- 在场: 薇拉、告解神父",
    "- 梗概: 对话中得知账册缺了一页。",
    "- 出边: 追问 → 1-3",
    "- 状态: 可达",
    "",
    "### 节点 1-3（告解室）",
    "- 地点: 告解室",
    "- 在场: 告解神父",
    "- 梗概: 告解室后墙藏着旧信。",
    "- 状态: 已剪枝",
    "",
  ].join("\n");
}

/** 快照 1 的树：只到 1-1，进度指针也在 1-1（回退后树屏重取到的就是它） */
function treeOfSnapshot1(): string {
  return [
    "# 剧情树",
    "## 第 1 章：雨夜教堂",
    "- 目标: 弄清账册缺页的秘密",
    "- 当前进度: 节点 1-1（已走 1 轮）",
    "",
    "### 节点 1-1（门口初遇）",
    "- 地点: 教堂门口",
    "- 在场: 薇拉",
    "- 梗概: 雨夜初遇，薇拉抱着账册站在灯下。",
    "- 出边: 迎上去 → 1-2",
    "- 状态: 已走过",
    "",
  ].join("\n");
}

/** 快照 2 的树：1-1 → 1-2，进度指针 1-2 */
function treeOfSnapshot2(): string {
  return [
    "# 剧情树",
    "## 第 1 章：雨夜教堂",
    "- 目标: 弄清账册缺页的秘密",
    "- 当前进度: 节点 1-2（已走 2 轮）",
    "",
    "### 节点 1-1（门口初遇）",
    "- 地点: 教堂门口",
    "- 在场: 薇拉",
    "- 梗概: 雨夜初遇，薇拉抱着账册站在灯下。",
    "- 出边: 迎上去 → 1-2",
    "- 状态: 已走过",
    "",
    "### 节点 1-2（中殿对话）",
    "- 地点: 教堂中殿",
    "- 在场: 薇拉、告解神父",
    "- 梗概: 对话中得知账册缺了一页。",
    "- 状态: 可达",
    "",
  ].join("\n");
}

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    trees: { w1: currentTree() },
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
            tree: treeOfSnapshot1(),
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
            tree: treeOfSnapshot2(),
          },
        },
      ],
    },
    turns: [
      // test1 进屏时的「继续世界：w1。」
      { match: "继续世界：", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n2. 原地等待\n"] },
      // test1 回退成功后 store 补发的「继续世界：w1。」→ 引擎按快照一的画面续演
      { match: "继续世界：", ops: ["续演正文：画面从快照一的教堂门口重新亮起。\n\n**行动**\n1. 前进\n"] },
      // test2 进屏时的「继续世界：w1。」（match 条目不重复消费，按序取这一条）
      { match: "继续世界：", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n2. 原地等待\n"] },
      // test2 点「再同步」重发的「继续世界：」→ 成功
      //（第一次补发在浏览器侧就断了、没到引擎，故不占脚本条目）
      { match: "继续世界：", ops: ["重同步正文：引擎重新读档，画面从快照一再次亮起。\n\n**行动**\n1. 继续\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("回退到快照 #1：两段确认→已回退提示→补发续玩→画面重建就绪", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 继续 w1 → game 屏就绪（消费第一条「继续世界」应答）
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");

  // 进剧情图，点快照 1 对应节点 1-1：详情出现并带快照标注
  await openRailGroup(page, "图鉴");
  await page.getByTestId("tree").click();
  await expect(page.getByTestId("tree-canvas")).toBeVisible();
  await page.getByTestId("tree-node-1-1").click();
  await expect(page.getByTestId("tree-detail")).toBeVisible();
  await expect(page.getByTestId("tree-snapshot-1-1")).toContainText("存档点 · 第 1 幕");

  // 两段确认：首点进确认态，二点触发 restoreSnapshot（POST restore → 补发「继续世界：」）
  await page.getByTestId("tree-restore-1-1").click();
  await expect(page.getByTestId("tree-restore-confirm-1-1")).toBeVisible();
  await page.getByTestId("tree-restore-confirm-1-1").click();

  // 成功路径：宽松断言「已回到第 N 幕」（具体文案与失败分支 UI 属下一票，不在此耦合）
  await expect(page.getByTestId("tree-notice")).toContainText("已回到第 1 幕");

  // 返回 game 屏：补发的续玩回合已应答——状态回就绪、正文区出现续演文本
  await page.getByTestId("tree-back").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("续演正文");
});

test("重同步失败与恢复：回退后首条续玩没发出去 → 徽章 + 再同步；重试成功后清除", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 继续 w1 → game 就绪（消费第三条「继续世界」应答：成功正文）
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("resync-badge")).toHaveCount(0); // 还没回退：无徽章

  // 回退后的第一条「继续世界：」在浏览器侧被掐断（POST /prompt 走到路由拦截就 abort，没到引擎）——
  // 与「指令发不出去（409/网络异常）」同一条错误路径，client 侧 markResyncFailed 置失败态。
  // 只掐第一条：之后的再同步补发直通（放行交给 route.continue）。
  let promptAborted = false;
  await page.route("**/prompt", async (route) => {
    if (promptAborted) return route.continue();
    promptAborted = true;
    return route.abort("failed");
  });
  await openRailGroup(page, "图鉴");
  await page.getByTestId("tree").click();
  await page.getByTestId("tree-node-1-1").click();
  await page.getByTestId("tree-restore-1-1").click();
  await page.getByTestId("tree-restore-confirm-1-1").click();

  // 失败态：图屏提示条说重同步失败（status 与 treeNotice 同说失败，不再互相矛盾）
  await expect(page.getByTestId("tree-notice")).toContainText("重同步失败");
  await expect(page.getByTestId("tree-notice")).toContainText("再同步");

  // 返回 game 屏（tree 屏不挂 TopBar）：徽章 + 「再同步」入口出现
  await page.getByTestId("tree-back").click();
  await expect(page.getByTestId("resync-badge")).toBeVisible();
  const retry = page.getByTestId("resync-retry");
  await expect(retry).toBeVisible();

  // 点再同步：最后一条「继续世界」应答成功正文 → 徽章消失、回合就绪、正文可见
  await expect.poll(() => promptAborted, { message: "退回后的第一条「继续世界」没被拦到（闸挂晚了？）" }).toBe(true);
  await retry.click();
  await expect(page.getByTestId("resync-badge")).toHaveCount(0);
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("重同步正文");
  await page.unroute("**/prompt");
});
