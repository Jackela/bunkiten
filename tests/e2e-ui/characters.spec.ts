// 假引擎确定性 UI e2e：角色面板（CharactersDrawer，v1.7）。
// harness 的 stateFiles 给 w1 预置一份带完整角色卡的 state.md → 继续世界线进 game →
// 命令轨「角色」开面板 → 断言：面板可见、角色名/好感度数字/表情徽章/导演手记渲染、
// 秘密默认折叠（aria-expanded=false 且正文不可见）→ 点击展开可见原文。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openRailGroup } from "./flow";


/** w1 的完整 state.md（SKILL「状态文件格式」样例形态；角色面板 /api/state 的数据源） */
function fullStateMd(): string {
  return [
    "# 剧情状态",
    "- preset: demo",
    "- 周目: 2",
    "- 时间: 第三夜 · 雨停后",
    "- 场景: 灰雀镇廉价旅店 202 房",
    "",
    "# 主角",
    "- 姓名: 顾迟",
    "- 身份: 自由调查员",
    "",
    "# 导演手记",
    "- 张力: 7",
    "- 下一节拍: 旅店停电",
    "",
    "# 角色卡",
    "## 薇拉",
    "- 身份: 沉默的书记官",
    "- 性格关键词: 克制 · 观察型",
    "- 好感度: 62",
    "- 表情: 微笑",
    "- 秘密: 缺页是她自己撕的",
    "- 最近互动: 把账册推过来半寸",
    "",
    "## 沈屿",
    "- 身份: 谜之少年",
    "- 好感度: 很高",
    "- 秘密: 无",
    "",
    "# Flags",
    "- 已读旧信: true",
    "",
    "# 未回收伏笔",
    "- 教堂地窖的旧信还没打开（埋于第 3 轮）",
  ].join("\n");
}

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    stateFiles: { w1: fullStateMd() },
    turns: [{ match: "继续世界：w1", ops: ["雨停了，教堂门口的石阶泛着冷光。\n\n**行动**\n1. 推门进去\n2. 原地等待\n"] }],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("角色面板：开抽屉渲染角色卡与好感度，秘密默认折叠、点击展开", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await page.getByTestId("world-continue-w1").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");

  // 命令轨「图鉴 ▾ → 角色」开面板（v1.12：10 项收成 5 个顶层，角色在「图鉴」菜单里）
  await openRailGroup(page, "图鉴");
  await page.getByTestId("characters").click();
  const panel = page.getByTestId("characters-panel");
  await expect(panel).toBeVisible();

  // 剧情状态 / 导演手记分块可见
  await expect(page.getByTestId("characters-status")).toContainText("第三夜 · 雨停后");
  await expect(page.getByTestId("characters-director")).toContainText("旅店停电");

  // 角色卡：名字 + 好感度数字 + 表情徽章；好感度解析不出的角色（「很高」）显示 —
  const vera = page.getByTestId("character-card-薇拉");
  await expect(vera).toBeVisible();
  await expect(vera.getByTestId("character-expression-薇拉")).toHaveText("微笑");
  await expect(vera.getByText("62")).toBeVisible();
  const shen = page.getByTestId("character-card-沈屿");
  await expect(shen).toBeVisible();
  await expect(shen.getByText("—")).toBeVisible();

  // 秘密剧透折叠：默认收起（aria-expanded=false、正文不可见），点击展开可见原文
  const secretBtn = page.getByTestId("character-secret-薇拉");
  await expect(secretBtn).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("character-secret-text-薇拉")).toHaveCount(0);
  await secretBtn.click();
  await expect(secretBtn).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("character-secret-text-薇拉")).toContainText("缺页是她自己撕的");

  // Esc 关闭抽屉（App 的 Esc 关闭链）
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("characters-panel")).toHaveCount(0);
});
