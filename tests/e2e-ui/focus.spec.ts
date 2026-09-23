// 假引擎确定性 UI e2e ⑨：统一焦点环（:focus-visible，v1.7）。
// global.css 里 unlayered 的 :where(button, a, input, select, textarea, [tabindex]):focus-visible
// 给键盘焦点画一圈 accent2 描边——这里在真浏览器里验证三件事（jsdom 不算 computed outline，只能 e2e 做）：
//   1. game 屏 Tab 落到命令轨「设置」按钮：focused 且 computed outline 生效（宽 >0、style 非 none）；
//   2. 世界线屏 ↑↓ roving：焦点跟到第二行，行（[tabindex]）同样出环——选中态 border 是另一层，两环并存；
//   3. 剧情图 SVG 节点（<g tabindex>）方向键聚焦：outline 直接画在 <g> 上（Chromium 支持 SVG outline，
//      免去 :focus-visible rect 描边的备选方案）——focused 且 outline 生效即证明选型成立。
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { BOOT_TO_TITLE_MS, handFocusBackToBody, openRailGroup } from "./flow";

/** w1 的三节点小树（进度指针 1-2，方向键可走 1-1↔1-3） */
function smallTree(): string {
  return [
    "# 剧情树",
    "## 第 1 章：雨夜教堂",
    "- 当前进度: 节点 1-2（已走 2 轮）",
    "",
    "### 节点 1-1（门口初遇）",
    "- 状态: 已走过",
    "",
    "### 节点 1-2（中殿对话）",
    "- 出边: 追问 → 1-3",
    "- 状态: 可达",
    "",
    "### 节点 1-3（告解室）",
    "- 状态: 已剪枝",
    "",
  ].join("\n");
}

/** computed outline 探针：键盘焦点环 = 宽 >0 且 style 非 none */
async function expectFocusRing(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const outline = await locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.outlineWidth, style: s.outlineStyle };
  });
  expect(parseFloat(outline.width)).toBeGreaterThan(0);
  expect(outline.style).not.toBe("none");
}

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    worlds: [{ id: "w2" }], // w1 默认存在：两行世界线，↑↓ 才有得走
    trees: { w1: smallTree() },
    turns: [
      { match: "继续世界：w1", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n2. 原地等待\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** 标题屏插卡 → 世界线屏（列表就绪） */
async function openWorlds(p: Page): Promise<void> {
  await p.goto(stack.pageUrl);
  const card = p.getByTestId("title-card-center");
  // 首个断言付冷启动：本 spec 自起栈（vite dev + acp-server + 假引擎），这一步给 BOOT_TO_TITLE_MS，
  // 其余断言仍走全局 10s（理由与分账方式见 flow.ts 的同名常量）
  await expect(card).toBeVisible({ timeout: BOOT_TO_TITLE_MS });
  await card.click();
  await expect(p.getByTestId("worlds-screen")).toBeVisible();
}

/** 继续世界线 w1 → 等 game 屏首个回合就绪 */
async function continueWorld(p: Page): Promise<void> {
  await p.getByTestId("world-continue-w1").click();
  await expect(p.getByTestId("status")).toHaveText("就绪");
}

test("世界线屏 ↑↓：焦点跟到第二行，行上出 :focus-visible 环", async () => {
  await openWorlds(page);

  // 清单是异步拉的，且按 lastPlayed 排序（两行 mtime 谁新谁排前，不写死具体 id）：
  // 先等两行都挂载——不然 ↓ 落在空列表上只会钳住光标索引、不会搬焦点（CI 上翻过车）；
  // 再按 DOM 顺序取第二行断言。焦点在 body（插卡按钮已随屏卸载）：↓ 一次 → 高亮与真实焦点都到第二行
  const rows = page.locator('[data-testid^="world-row-"]');
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await expectFocusRing(rows.nth(1));
});

test("game 屏 Tab：首个焦点是命令轨「设置」，按钮出 :focus-visible 环", async () => {
  await openWorlds(page);
  await continueWorld(page);

  // 起点必须是 body——把焦点从就绪态的自动聚焦手里收回（等自动聚焦真的落过地，再点画面角落并确认
  // 焦点已在 body；判据与理由见 flow.handFocusBackToBody，这条用例就是它修的那只 CI flake）。
  // 之后 Tab：命令轨「设置」是 game 屏 DOM 里第一个可聚焦元素（状态簇在它之前，但就绪态的簇走
  // sr-only、里面只有不可聚焦的文本；对话区/输入框那一簇排在命令轨之后）。
  // 走 mouse.click 发原始指针事件而不是 locator.click：全屏都是 fixed 定位，<body> 自身没有布局盒，
  // 后者会卡在 actionability 检查（element is not visible）超时
  await handFocusBackToBody(page);
  await page.keyboard.press("Tab");
  await expectFocusRing(page.getByTestId("settings"));
});

test("剧情图方向键：SVG 节点 <g> 聚焦，outline 画在 g 上（无需 rect 描边备选）", async () => {
  await openWorlds(page);
  await continueWorld(page);
  await openRailGroup(page, "图鉴");
  await page.getByTestId("tree").click();
  await expect(page.getByTestId("tree-canvas")).toBeVisible();

  // 剧情图是整屏切换：TopBar 卸载后焦点在 body，方向键的 onKeyDown 挂在画布包裹层上——
  // 键盘用户得先 Tab 进画布（路过头部/工具条按钮，落在 roving tabIndex 的节点 <g> 上）
  for (let i = 0; i < 10; i++) {
    const onNode = await page.evaluate(() =>
      document.activeElement?.matches('[data-testid^="tree-node-"]'),
    );
    if (onNode) break;
    await page.keyboard.press("Tab");
  }

  // 进度指针 1-2 → 方向键走一步到 1-3：roving tabIndex 把真焦点送到该 <g>
  await page.keyboard.press("ArrowRight");
  await expectFocusRing(page.getByTestId("tree-node-1-3"));
});
