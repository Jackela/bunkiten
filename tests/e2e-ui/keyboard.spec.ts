// 假引擎确定性 UI e2e ③：game 屏键盘/面板交互——数字键选选项、空格补全打字机、面板「自动 / 快进」。
// 数字键：OptionList 的 window keydown（1-9/Numpad，焦点在输入框时让路）→ send(选项文本) →
// fake-engine 用 match 命中该文本回下一回合正文。空格：DialogueBox 的 completeNow 走点击同一条路，
// 打字未完成时立即补全文——断言用「按键后单次读取即含末句」证明瞬时补全（不打轮询硬等）。
// v1.8 追加第三条（面板控件）：右上「快进」= 同一个 completeNow（补全后自报 disabled），
// 「自动」= 切换设置里的 autoAdvance 并立刻武装/撤销倒计时——断言只取 store 在屏上的可视效果
// （aria-pressed + OptionList 的 auto-advance 行），不碰内部状态：点击与倒计时都是浏览器里真的在跑。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, handFocusBackToBody, quickStartToGame } from "./flow";

/** 第三条用例的开局正文（≈190 字）：标准档打字机（24ms/字、落后较多时按追赶步长补齐）要走 2s 以上，
 *  留出「打字中手点快进」的确定窗口；末句当「是否补全」的探针（打字路径下它最后才轮到）。 */
const LONG_BODY =
  "长廊尽头的灯又灭了一盏，你数着墙上的裂纹往前走，第三十七块砖下面压着一封没有署名的信，" +
  "信封上的火漆碎了一半，碎掉的那一半刚好缺了写信人的姓氏。" +
  "你把信纸抽出来的时候，风从门缝里钻进来，纸页忽然变得很轻，像随时会从指缝里溜走。" +
  "读完最后一行，身后的门无声地合上了。";
const LONG_LAST = "读完最后一行，身后的门无声地合上了。";

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    turns: [
      // 测试 1 的开局回合：三个选项（数字键 2 = 第二项「推开侧门走进回廊」）
      {
        match: "开局：",
        ops: [
          "雨声漫过教堂的尖顶，薇拉抱着账册站在门口，没有看你。\n\n**行动**\n1. 撑伞迎上去\n2. 推开侧门走进回廊\n3. 停在原地等她开口\n",
        ],
      },
      // 测试 1 按下 2 后的应答回合（match 命中选项文本本身）
      {
        match: "推开侧门",
        ops: [
          "侧门虚掩着，回廊里只有你自己的脚步声。墙上的烛台次第亮起，照出一道狭长的影子。\n\n**行动**\n1. 沿回廊深入\n2. 折返正厅\n",
        ],
      },
      // 测试 2 的开局回合：长正文让标准档打字机持续数秒，留出「打字中按空格」的窗口
      {
        match: "开局：",
        ops: [
          "夜色沉进长廊，两侧的灯一盏接一盏亮起来，把石地板上的水痕照成细碎的银线。" +
            "你数着自己的脚步往前走，到第三十七步的时候，风从尽头的门缝里挤进来，带着旧纸和灰尘的气味。" +
            "没有人告诉过你门后是什么，你只知道，回廊尽头的灯已经灭了三次，而每一次熄灭，都恰好落在你心跳的间隙上。\n\n**行动**\n1. 推门\n2. 转身\n",
        ],
      },
      // 测试 3 的开局回合：正文同样够长（打字中够手点「快进」），末尾带选项——选项要打完才浮出，
      // 「自动」的倒计时行也只在选项上屏后才起（armAutoAdvance 的判据）
      {
        match: "开局：",
        ops: [`${LONG_BODY}\n\n**行动**\n1. 拆开火漆\n2. 把信塞回去\n`],
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
  await expect.poll(async () => page.getByTestId("options").locator("button").count()).toBeGreaterThanOrEqual(3);

  // FreeInput 在就绪时自动聚焦，而数字键对输入框让路（在打字不是在选选项）——
  // 先点一下把焦点还给 body（等自动聚焦落过地、并确认焦点真的在 body 上，见 flow.handFocusBackToBody），
  // 再按数字键。用画面角落而不是点对话框：两条路都把焦点还给 body，但前者不碰对话框，
  // 不会顺带触发一次 completeNow（本用例此刻打字已完成，那一击本来就是空转，换个更纯的点法）
  await handFocusBackToBody(page);
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

  // 空格同样对聚焦的输入框让路：把焦点移回 body——就绪态的状态簇走 sr-only 点不到（见 TopBar 文件头）；
  // 这里绝不能点 dialogue-box：那一击会 completeNow 补全文，打字中的证据链就没了。
  // handFocusBackToBody 点的正是画面角落（不可聚焦的常驻底图），并会先等就绪态自动聚焦落过地、
  // 再确认焦点真的在 body 上，才让下面的空格按下去（否则这一击会落进那个刚被自动聚焦的输入框）
  await handFocusBackToBody(page);

  // 空格 → completeNow 立即 setShown(target)。按键后单次读取 DOM：若未补全，此刻必然只有前缀
  await page.keyboard.press(" ");
  const text = await page.getByTestId("dialogue-text").textContent();
  expect(text).toContain("都恰好落在你心跳的间隙上");
  // 补全即打完：提示条随 typingDone 消失
  await expect(page.getByTestId("dialogue-hint")).toHaveCount(0);
});

test("面板控件：快进一次补全文并随即禁用，自动切 aria-pressed 并起倒计时行", async () => {
  // 再开一条世界线消费第三条开局回合（match 命中不重复消费）
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page); // status 就绪 = 回合定稿，打字机开始追赶长正文

  // 打字中的证据链（同空格那条）：首句已上屏 + 「空格补全」提示还在（提示只在不打完时渲染）
  await expect(page.getByTestId("dialogue-text")).toContainText("长廊尽头的灯又灭了一盏");
  await expect(page.getByTestId("dialogue-hint")).toBeVisible();
  // 「快进」此刻自报可用（canComplete = 未打完且还有没追上的字）
  await expect(page.getByTestId("dialogue-skip")).toBeEnabled();

  // 快进 = 面板上的那一击，走与空格/点对话框同一个 completeNow。点击后**单次读取** DOM：
  // 若没补全，此刻必然只有前缀（打字路径离末句还差 2s 以上）
  await page.getByTestId("dialogue-skip").click();
  const text = (await page.getByTestId("dialogue-text").textContent()) ?? "";
  expect(text).toContain(LONG_LAST);
  // 补全即打完：按钮的可用性判据与 completeNow 第一道判断同源，随即变成 disabled（不再谎称点了有用）
  await expect(page.getByTestId("dialogue-skip")).toBeDisabled();

  // 打完 → 选项浮入；这时才谈「自动前进」（倒计时只在选项可见时武装）
  await expect.poll(async () => page.getByTestId("options").locator("button").count()).toBeGreaterThanOrEqual(2);
  const auto = page.getByTestId("dialogue-auto");
  await expect(auto).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("auto-advance")).toHaveCount(0);

  // 打开：aria-pressed 翻真，且立刻起倒计时（面板上这一下是「玩家明确要求自动」，解 muted 再武装）
  await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("auto-advance")).toBeVisible();
  await expect(page.getByTestId("auto-advance")).toContainText("自动前进");

  // 关闭：设置落回 0 且当前倒计时被撤销——关掉了却还在自己往前走就是 bug
  await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("auto-advance")).toHaveCount(0);
});
