// 假引擎确定性 UI e2e ⑤：剧情图（StoryTreeScreen overlay）。
// 小树（w1，3 节点）：继续世界线 → 进剧情图，SVG 树图可见；滚轮在画布中心缩放（非 passive 监听
// preventDefault）→ tree-zoom-level 与 viewBox 变化；按住拖拽越过死区平移 → viewBox 再变（缩放不变）。
// 大树（w2，45 节点链）：>40 节点默认降级列表形态——tree-view-toggle 提示、tree-list 可见、SVG 画布不渲染。
// 快照对比（w3）：seed 两条内容不同的快照（#1 挂 1-1、#2 挂 1-2）→ 节点详情「与上一快照对比」→
// diff 面板渲染 add/remove 行（seed 的两条 files 可控，运行时回合只会追加更晚的 seq，不动基线）。
// 树文用 parseStoryTree 的容错格式构造（`## 第 N 章：标题` / `### 节点 N-M（拍点）` / `- 字段: 值`）。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";

/** w1 的三节点小树（1-1 → 1-2 → 1-3，进度指针在 1-2） */
function smallTree(): string {
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

/** w2 的 45 节点链（超过 BIG_GRAPH_NODES=40 → 默认列表模式） */
function bigTree(nodeCount = 45): string {
  const lines = ["# 剧情树", "## 第 1 章：长夜回廊", "- 目标: 走完长夜", `- 当前进度: 节点 1-1（已走 0 轮）`, ""];
  for (let i = 1; i <= nodeCount; i++) {
    lines.push(`### 节点 1-${i}（第 ${i} 拍）`);
    lines.push(`- 地点: 长廊第 ${i} 段`);
    lines.push("- 在场: 薇拉");
    lines.push(`- 梗概: 第 ${i} 段的遭遇与抉择。`);
    if (i < nodeCount) lines.push(`- 出边: 前进 → 1-${i + 1}`);
    lines.push(`- 状态: ${i === 1 ? "已走过" : "可达"}`);
    lines.push("");
  }
  return lines.join("\n");
}

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    worlds: [{ id: "w2" }, { id: "w3" }],
    trees: { w1: smallTree(), w2: bigTree(), w3: smallTree() },
    // 快照对比的 seed（w3）：#1 挂 1-1、#2 挂 1-2，state 各差一行好感度——节点 1-2 的
    // 最早匹配是 #2、基线是 #1，diff 内容完全由 seed 决定（运行时回合只会追加 seq ≥ 3）
    snapshots: {
      w3: [
        {
          seq: 1,
          kind: "turn",
          nodeId: "1-1",
          chapterNo: 1,
          files: { state: "# 剧情状态\n周目: 1\n好感度: 42\n", summary: "第 1 轮：门口初遇。", tree: smallTree() },
        },
        {
          seq: 2,
          kind: "turn",
          nodeId: "1-2",
          chapterNo: 1,
          files: { state: "# 剧情状态\n周目: 1\n好感度: 55\n", summary: "第 2 轮：中殿对话。", tree: smallTree() },
        },
      ],
    },
    // 三个「继续世界」各配一条应答（match 按世界 id 区分，命中不重复消费）
    turns: [
      { match: "继续世界：w1", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n2. 原地等待\n"] },
      { match: "继续世界：w2", ops: ["又是清晨，长廊尽头的灯还亮着。\n\n**行动**\n1. 往前走\n2. 回房\n"] },
      { match: "继续世界：w3", ops: ["中殿的烛火晃了一下。\n\n**行动**\n1. 追问账册\n2. 沉默\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** 标题屏插卡 → 世界线屏（不新开世界线，由调用方点「继续」） */
async function openWorlds(p: Page): Promise<void> {
  await p.goto(stack.pageUrl);
  const card = p.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(p.getByTestId("worlds-screen")).toBeVisible();
}

/** 世界线屏「继续」某世界 → 等 game 屏首个回合就绪 */
async function continueWorld(p: Page, worldId: string): Promise<void> {
  await p.getByTestId(`world-continue-${worldId}`).click();
  await expect(p.getByTestId("status")).toHaveText("就绪");
}

test("小树：SVG 树图可见，滚轮中心缩放与按住拖拽平移都改 viewBox", async () => {
  await openWorlds(page);
  await continueWorld(page, "w1");

  // 命令轨「剧情图」进 overlay：三个节点都画出来了
  await page.getByTestId("tree").click();
  const canvas = page.getByTestId("tree-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("tree-node-1-1")).toBeVisible();
  await expect(page.getByTestId("tree-node-1-2")).toBeVisible();
  await expect(page.getByTestId("tree-node-1-3")).toBeVisible();

  // 把鼠标放到画布中心，向上滚 = 放大一档（ZOOM_STEP 1.25 → 125%）
  const vb0 = await canvas.getAttribute("viewBox");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  await expect(page.getByTestId("tree-zoom-level")).toHaveText("125%");
  const vb1 = await canvas.getAttribute("viewBox");
  expect(vb1).not.toBe(vb0); // 缩放后视口（布局坐标）变窄

  // 按住拖拽（越过 4px 死区）→ 平移：viewBox 再变，缩放保持 125%
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("tree-zoom-level")).toHaveText("125%");
  await expect.poll(async () => canvas.getAttribute("viewBox")).not.toBe(vb1);
});

test("大树（45 节点）：默认降级为列表形态，SVG 画布不渲染", async () => {
  await openWorlds(page);
  await continueWorld(page, "w2");

  await page.getByTestId("tree").click();

  // 降级提示行 + 列表可见 + 图形画布缺席；行数与节点数一致
  await expect(page.getByTestId("tree-view-toggle")).toBeVisible();
  await expect(page.getByTestId("tree-view-toggle")).toContainText("45");
  await expect(page.getByTestId("tree-list")).toBeVisible();
  await expect(page.getByTestId("tree-canvas")).toHaveCount(0);
  await expect(page.getByTestId("tree-row-1-1")).toBeVisible();
  await expect.poll(async () => page.locator('[data-testid^="tree-row-"]').count()).toBe(45);

  // 列表行可点：点首行仍能打开节点详情（降级形态不丢交互）
  await page.getByTestId("tree-row-1-1").click();
  await expect(page.getByTestId("tree-detail")).toBeVisible();
});

test("快照对比：节点详情与上一快照 diff，remove/add 行可见（w3 seed 两条快照）", async () => {
  await openWorlds(page);
  await continueWorld(page, "w3");

  await page.getByTestId("tree").click();

  // 节点 1-2 的详情快照是 seed #2（最早匹配），基线是 #1 → 对比入口出现
  await page.getByTestId("tree-node-1-2").click();
  await expect(page.getByTestId("tree-snapshot-1-2")).toBeVisible();
  const open = page.getByTestId("snapshot-diff-open");
  await expect(open).toBeVisible();
  await expect(open).toContainText("第 1 幕 → 第 2 幕");

  // 打开面板：默认「剧情状态」tab，好感度一行被替换——remove（上一份独有）与 add（这一份新增）各一行
  await open.click();
  const panel = page.getByTestId("snapshot-diff");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("diff-row-remove")).toHaveCount(1);
  await expect(page.getByTestId("diff-row-add")).toHaveCount(1);
  await expect(panel.getByTestId("diff-row-remove")).toContainText("好感度: 42");
  await expect(panel.getByTestId("diff-row-add")).toContainText("好感度: 55");
  // tab 头的 +N −M 摘要（state：+1 −1；tree 两份 seed 全等 → 无变化）
  await expect(page.getByTestId("snapshot-diff-tab-state")).toContainText("+1 −1");
  await expect(page.getByTestId("snapshot-diff-tab-tree")).toContainText("无变化");
});
