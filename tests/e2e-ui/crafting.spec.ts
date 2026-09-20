// 假引擎确定性 UI e2e（章节循环：规划 → 制作美术 → 开演 → 第 2 章）。
// 覆盖 tests/e2e-ui/ 此前零覆盖的「制作中」屏整条流水线：捏人屏「制作美术并开演」→ 待命（init，
// 大纲槽位「排队中」）→ 规划（「撰写大纲与剧情树…」）→ 按清单逐项美术（两张槽位「生成中/排队中」→
// 「就绪」，进度「美术 N / 2 就绪」）→「开演。」→ game 屏正文/选项 → 点选项打出终章回合
// （【章】第 1 章 完）→ **第二次**进制作中屏（标题「第 2 章 · 制作中」，同一次提交里已进 planning）
// → 第 2 章规划+美术+开演 → 回 game 屏（新正文/新选项）。被测流水线在 src/store/context.ts
// （advancePreload / beginPlanning / runNextPending / sendStart）与 gameplay 的 turn_end。
//
// ① 引擎脚本按命令字面命中（{match} 子串；命中即消费、**只消费一次**——见 fake-engine.mjs 头）：
//    两章的美术指令因此用不同字面（第 1 章 薇拉/教堂，第 2 章 薇拉-微笑/酒馆）——两条同字面的 match
//    会让第二条永远选不中。「薇拉-微笑」以「薇拉」为前缀，安全依据是**消费顺序**：第 1 章那条 match
//    先被判中并消费（第 1 章的美术指令必然先于第 2 章发出），第 2 章才落到自己那条上。
//    开局指令里也含「开演。」（待命后缀「…等待分项美术指令与「开演。」」），但那条 match 在脚本里排在
//    「开局：」之后，而 pickOps 从 0 号开始扫「第一条未消费的命中项」⇒ 开局只会吃掉开局那条。
//
// ② 为什么把每跳 /prompt **挂住**（既不是 waitForTimeout、也不是固定延迟；手法与 boot.spec.ts 的
//    checking 态、creation.spec.ts 的装配清单同源：先挂住 → 断言 → 再放行）：
//    实测假引擎一回合只花 2–6ms，而屏转场是 AnimatePresence mode="wait" 的 450ms exit（ScreenShell）——
//    制作中屏要等上一屏退场完毕才挂载，而 init/planning/queue 这些中间帧在 store 里各只活一两个回合
//    （2–6ms 级别），根本来不及上屏（这正是「制作中」屏在 e2e-ui 里一次都没出现过的原因）。把这一跳拦在
//    浏览器侧（server 还没看到这一回合），每个阶段都停在「指令已发出、回合还没跑」的确定稳态：断言窗口无限长，
//    放行时机全由本文件决定——页面与测试进程里都没有计时器，也就没有「机器快慢」这个变量。
//    每段的顺序固定：先断言本阶段稳态 → 再 open() 放行 → 下一阶段的 POST 立刻又被挂住。
//
// 观察面声明：只断言文案与槽位状态。进度行「美术 N / M 就绪」没有自己的 testid，按整页 toContainText
// 断言（该文案只由它产出）；seed 的会话图片只让【图】标记的 /img 命中真实文件，字节不参与断言
// （图的事归 opening.spec.ts / preload.spec.ts）。终章回合那句「你向前一步。」只在转场窗口里一闪而过，
// 不在此断言——章标记的**效果**（第 2 章制作中屏）才是这条 spec 的落点。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist } from "./flow";

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    // 单卡轮播（flow.ts 的前提）。不写 protagonist_card：本用例走「快速开局」，不填主角卡
    presets: [{ id: "demo", title: "示例剧本" }],
    // 会话图片：让【图】标记的 /img 命中真实文件（覆盖两章 images/1..4）；内容不参与断言
    sessionImages: { "1.jpg": "placeholder", "2.jpg": "placeholder", "3.jpg": "placeholder", "4.jpg": "placeholder" },
    // 命令字面 → 回放（每条 match 在整轮里唯一，见文件头 ①）：
    //   待命开局 → 规划第 1 章（回制作清单）→ 两条分项美术（各回一张【图】）→「开演。」（回正文+选项）
    //   → 玩家点「上前」的回合（回终章正文 + 【章】第 1 章 完）→ 第 2 章同样四步
    turns: [
      { match: "开局：", ops: ["已就位。\n"] },
      { match: "规划：第 1 章。", ops: ["【清单】立绘|薇拉\n【清单】背景|教堂\n"] },
      { match: "美术：立绘 薇拉", ops: ["【图】立绘|薇拉|images/1.jpg\n薇拉 · 完成\n"] },
      { match: "美术：背景 教堂", ops: ["【图】背景|教堂|images/2.jpg\n教堂 · 完成\n"] },
      { match: "开演。", ops: ["烛火在石墙上抖了一下。\n\n**行动**\n1. 上前\n2. 退后\n"] },
      { match: "上前", ops: ["你向前一步。\n\n【章】第 1 章 完\n\n**行动**\n1. 继续\n2. 停下\n"] },
      { match: "规划：第 2 章。", ops: ["【清单】立绘|薇拉-微笑\n【清单】背景|酒馆\n"] },
      { match: "美术：立绘 薇拉-微笑", ops: ["【图】立绘|薇拉-微笑|images/3.jpg\n薇拉 · 微笑 · 完成\n"] },
      { match: "美术：背景 酒馆", ops: ["【图】背景|酒馆|images/4.jpg\n酒馆 · 完成\n"] },
      { match: "开演。", ops: ["第二章的开场段落。\n\n**行动**\n1. 坐下\n2. 站着\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** /prompt 闸的句柄（见 {@link installPromptGate}） */
interface PromptGate {
  /** 放行被挂住的那一跳；还没有请求被挂住就先等它（10s 内没等到即断言失败，不会把用例挂死） */
  open(): Promise<void>;
}

/**
 * 装一道 /prompt 闸：每一跳都拦在浏览器侧挂住（server 还没看到这一回合），直到测试放行——
 * 理由与必要性见文件头 ②。只拦 /prompt：SSE /events 与其余 HTTP 一律不动。
 * @returns {{open: () => Promise<void>}} 放行句柄（FIFO；每个阶段恰好一拍，靠调用方成对使用）
 */
async function installPromptGate(target: Page): Promise<PromptGate> {
  /** 已被挂住的请求（按到达顺序）的放行函数 */
  const held: Array<() => void> = [];
  await target.route("**/prompt", async (route) => {
    await new Promise<void>((resolve) => held.push(resolve));
    await route.continue();
  });
  return {
    async open() {
      await expect
        .poll(() => held.length, { message: "没有可放行的 /prompt：这一跳没被挂住（闸没装上或上一跳没放行）" })
        .toBeGreaterThan(0);
      held.shift()?.();
    },
  };
}

/** 点选项：选项按钮的可见名是「◇ + 序号 + 正文」（OptionList），按正文筛出唯一一个再点 */
async function clickOption(label: string): Promise<void> {
  const btn = page.getByTestId("options").locator("button").filter({ hasText: label });
  await expect(btn).toHaveCount(1);
  await btn.click();
}

test("章节循环：制作美术并开演 → 第 1 章正文 → 章标记 → 第 2 章制作中屏 → 回到 game 屏", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await page.getByTestId("quick-start").click(); // 快速开局（用剧本预设主角）→ 解锁「制作美术并开演」

  const craftStatus = page.getByTestId("crafting-status");
  const planSlot = page.getByTestId("crafting-plan-slot");
  // 进度行「美术 N / M 就绪」没有 testid（CraftingScreen 里紧跟 crafting-status 的那个 <p>），
  // 而该整句只由它产出，所以按整页 toContainText 断言；其余断言一律精确到 testid。
  const craftPage = page.getByTestId("shell-page");
  const gate = await installPromptGate(page);

  // —————————————— 第 1 章 · 待命（preloadPhase=init，开局指令挂在半路）——————————————
  // 「制作美术并开演」= startGame(quick, preload=true)：同步切 screen=crafting 并发出带「待命：」后缀的
  // 开局指令。屏转场（mode="wait"，450ms）走完制作中屏才挂载；回合被闸住 ⇒ init 是确定稳态。
  await page.getByTestId("protagonist-start").click();
  await expect(craftStatus).toBeVisible();
  await expect(page.getByRole("heading", { name: "制 作 中" })).toBeVisible(); // 第 1 章标题
  await expect(craftStatus).toContainText("故事展开中…"); // 引擎口吻「引擎演绎中…」走 playerStatus 落到玩家侧
  await expect(planSlot).toHaveText("排队中"); // init：规划指令还没发，大纲槽位是排队态

  // —————————————— 放行待命回合 → 发出「规划：第 1 章。」（planning）——————————————
  // turn_end → advancePreload(init) → beginPlanning(1)：槽位转「撰写大纲与剧情树…」，状态行「章节筹备中…」
  await gate.open();
  await expect(planSlot).toHaveText("撰写大纲与剧情树…");
  await expect(craftStatus).toContainText("章节筹备中…");

  // —————————————— 放行规划回合 → 回清单、建队列、「美术：立绘 薇拉」在途（queue）——————————————
  // 【清单】立绘|薇拉 / 【清单】背景|教堂 → 两张槽位；清单顺序即队列顺序（立绘先跑，背景排队）
  const ch1Portrait = page.getByTestId("crafting-slot-portrait-薇拉");
  const ch1Background = page.getByTestId("crafting-slot-background-教堂");
  await gate.open();
  await expect(ch1Portrait).toBeVisible();
  await expect(ch1Background).toBeVisible();
  await expect(ch1Portrait).toContainText("生成中");
  await expect(ch1Background).toContainText("排队中");
  await expect(craftPage).toContainText("美术 0 / 2 就绪");

  // 放行立绘回合 → 该项 done → 才发下一条（背景）：「美术 1 / 2 就绪」
  await gate.open();
  await expect(ch1Portrait).toContainText("就绪");
  await expect(ch1Background).toContainText("生成中");
  await expect(craftPage).toContainText("美术 1 / 2 就绪");

  // 放行背景回合 → 队列跑空 → 发「开演。」：「美术 2 / 2 就绪」
  await gate.open();
  await expect(ch1Background).toContainText("就绪");
  await expect(craftPage).toContainText("美术 2 / 2 就绪");

  // —————————————— 放行「开演。」→ game 屏 ——————————————
  // status 只在 game 屏顶栏：它出现即证明 preloadPhase 已 finished、屏已切到 game
  await gate.open();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("烛火在石墙上抖了一下。");
  await expect(page.getByTestId("options")).toContainText("上前");

  // —————————————— 点「上前」→ 放行章标记回合 → 第 2 章制作中屏 ——————————————
  // 玩家回合；fake 回「【章】第 1 章 完」。turn_end 的章标记分支与 beginPlanning(2) 在**同一次提交**里
  // （同步发出「规划：第 2 章。」），所以制作中屏一挂载就是 planning 态：标题「第 2 章 · 制作中」与
  // 槽位「撰写大纲与剧情树…」必须落在同一帧——这正是「第二次进制作中屏」的判据（第 1 章已离开过）。
  await clickOption("上前");
  await gate.open();
  await expect(page.getByRole("heading", { name: "第 2 章 · 制作中" })).toBeVisible();
  await expect(planSlot).toHaveText("撰写大纲与剧情树…");
  await expect(craftStatus).toContainText("章节筹备中…");

  // —————————————— 第 2 章规划+美术+开演 → 回 game 屏 ——————————————
  // 第 2 章清单换了名字（含差分清单项 薇拉-微笑）：槽位 testid 带原始清单名，标签走变体展示名
  const ch2Portrait = page.getByTestId("crafting-slot-portrait-薇拉-微笑");
  const ch2Background = page.getByTestId("crafting-slot-background-酒馆");
  await gate.open();
  await expect(ch2Portrait).toBeVisible();
  await expect(ch2Background).toBeVisible();
  await expect(ch2Portrait).toContainText("薇拉 · 微笑");
  await expect(ch2Background).toContainText("排队中");
  await expect(craftPage).toContainText("美术 0 / 2 就绪");

  await gate.open();
  await expect(ch2Portrait).toContainText("就绪");
  await expect(ch2Background).toContainText("生成中");
  await expect(craftPage).toContainText("美术 1 / 2 就绪");

  await gate.open();
  await expect(ch2Background).toContainText("就绪");
  await expect(craftPage).toContainText("美术 2 / 2 就绪");

  // 第 2 章「开演。」收尾 → 回 game 屏：新正文与新选项上屏
  await gate.open();
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expect(page.getByTestId("dialogue-text")).toContainText("第二章的开场段落。");
  await expect(page.getByTestId("options")).toContainText("坐下");
});
