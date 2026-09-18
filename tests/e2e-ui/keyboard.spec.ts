// 假引擎确定性 UI e2e ③：game 屏键盘交互——数字键选选项、空格补全打字机。
// 数字键：OptionList 的 window keydown（1-9/Numpad，焦点在输入框时让路）→ send(选项文本) →
// fake-engine 用 match 命中该文本回下一回合正文。空格：DialogueBox 的 completeNow 走点击同一条路，
// 打字未完成时立即补全文——断言用「按键后单次读取即含末句」证明瞬时补全（不打轮询硬等）。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, quickStartToGame } from "./flow";

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    turns: [
      // 测试 1 的开局回合：三个选项（数字键 2 = 第二项「推开侧门走进回廊」）
      { match: "开局：", ops: ["雨声漫过教堂的尖顶，薇拉抱着账册站在门口，没有看你。\n\n**行动**\n1. 撑伞迎上去\n2. 推开侧门走进回廊\n3. 停在原地等她开口\n"] },
      // 测试 1 按下 2 后的应答回合（match 命中选项文本本身）
      { match: "推开侧门", ops: ["侧门虚掩着，回廊里只有你自己的脚步声。墙上的烛台次第亮起，照出一道狭长的影子。\n\n**行动**\n1. 沿回廊深入\n2. 折返正厅\n"] },
      // 测试 2 的开局回合：长正文让标准档打字机持续数秒，留出「打字中按空格」的窗口
      {
        match: "开局：",
        ops: [
          "夜色沉进长廊，两侧的灯一盏接一盏亮起来，把石地板上的水痕照成细碎的银线。" +
            "你数着自己的脚步往前走，到第三十七步的时候，风从尽头的门缝里挤进来，带着旧纸和灰尘的气味。" +
            "没有人告诉过你门后是什么，你只知道，回廊尽头的灯已经灭了三次，而每一次熄灭，都恰好落在你心跳的间隙上。\n\n**行动**\n1. 推门\n2. 转身\n",
        ],
      },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("数字键 2 选中第二项：prompt 带选项文本、下一回合正文上屏", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // 打字完成后选项浮入（≥3 个按钮）；此时 window keydown 已挂上
  await expect
    .poll(async () => page.getByTestId("options").locator("button").count())
    .toBeGreaterThanOrEqual(3);

  // FreeInput 在就绪时自动聚焦，而数字键对输入框让路（在打字不是在选选项）——
  // 先点一下对话框把焦点还给 body（打字已完成，completeNow 空转），再按数字键
  await page.getByTestId("dialogue-text").click();
  await page.keyboard.press("2");
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("侧门虚掩着，回廊里只有你自己的脚步声");
});

test("打字中按空格：正文立即完整（dialogue-text 含末句）", async () => {
  // 再开一条世界线消费第三条开局回合（match 命中不重复消费）
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page); // status 就绪 = 回合定稿，打字机开始追赶长正文

  // 打字中的证据链：正文已出现首句 + 「空格补全」提示可见（提示只在不打完时渲染）
  await expect(page.getByTestId("dialogue-text")).toContainText("夜色沉进长廊");
  await expect(page.getByTestId("dialogue-hint")).toBeVisible();

  // 空格同样对聚焦的输入框让路：点一下画面角落（不可聚焦的常驻底图，真实手势）把焦点移回 body——
  // 就绪态的状态簇走 sr-only 点不到（见 TopBar 文件头）；这里绝不能点 dialogue-box：
  // 那一击会 completeNow 补全文，打字中的证据链就没了。
  // mouse.click 直接落到视口坐标：<body> 在 fixed 布局下没有布局盒，locator.click 过不了 actionability
  await page.mouse.click(4, 4);

  // 空格 → completeNow 立即 setShown(target)。按键后单次读取 DOM：若未补全，此刻必然只有前缀
  await page.keyboard.press(" ");
  const text = await page.getByTestId("dialogue-text").textContent();
  expect(text).toContain("都恰好落在你心跳的间隙上");
  // 补全即打完：提示条随 typingDone 消失
  await expect(page.getByTestId("dialogue-hint")).toHaveCount(0);
});
