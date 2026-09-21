// 假引擎 UI e2e 的共用屏幕流（tests/e2e-ui/ 内部复用）：从空白页走到「捏人屏」/「game 屏」。
// 前提：stack 只 seed 一个剧本（单卡轮播，插卡即中）；boot 屏 /api/auth 通过后自动进 title。
import { expect, type Page } from "@playwright/test";

/**
 * 「进标题屏」这一跳的等待上限（ms）：**本 spec 自起栈的冷启动预算**，不是「慢就多给点」。
 * 每个 spec 各起一套 vite dev + acp-server + 假引擎（满载连跑、串行），冷启动的那几秒（首次
 * 模块图编译、代理转发预热、SSE 握手）都付在首个 goto 上——全局 10s（playwright.ui.config.ts 的
 * expect.timeout）够看「屏间动作」，不足以覆盖冷启动。这里显式给 30s，且**只给这一步**：
 * 屏立起来之后的断言照旧走全局 10s，把冷启动预算与交互预算分开记（调大全局 timeout 会把
 * 真正的慢一起藏起来）。本文件导出给 focus.spec 等自起栈的 spec 复用，避免数字各写一份。
 *
 * 分工（其余 spec 的同跳仍吃全局 10s 是**有意的**，别顺手统一）：冷代理那一层已经由起栈探活兜住
 * （fake-stack.mjs 在交栈前先探一次**经 Vite 代理**的 /api/auth，把转发路径捂热），所以
 * 「首个 goto 撞冷代理」的概率已经很低；这里给的 30s 只是给「已捂热的栈仍然首屏偏慢」留余量。
 * 若将来真的定位到冷启动 >10s（探活之后仍复现），再统一换用本常量，而不是逐个 spec 加 timeout。
 */
export const BOOT_TO_TITLE_MS = 30_000;

/** 标题屏插卡 → 世界线屏开新世界线 → 等捏人屏标题出现（每次调用都会新开一条世界线） */
export async function enterProtagonist(page: Page, title: string): Promise<void> {
  // 标题屏：中央卡出现即 /api/presets 已就绪（boot 自检通过后自动到这里）；冷启动预算见 BOOT_TO_TITLE_MS
  const centerCard = page.getByTestId("title-card-center");
  await expect(centerCard).toBeVisible({ timeout: BOOT_TO_TITLE_MS });
  // 单卡轮播：直接插卡（约 1s 插卡动画）进世界线屏
  await centerCard.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 开一条全新世界线（POST /api/worlds create → 分配 id → 进捏人屏）
  await page.getByTestId("worlds-new").click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

/** 捏人屏快速开局（quick_start 预设主角）→ 跳过美术 → 等 game 屏首个回合「就绪」 */
export async function quickStartToGame(page: Page): Promise<void> {
  await page.getByTestId("quick-start").click();
  await page.getByTestId("skip-preload").click();
  await expect(page.getByTestId("status")).toHaveText("就绪");
}

/**
 * 「把焦点从就绪态的自动聚焦手里收回来」：点一下画面角落（不可聚焦的常驻底图）把焦点还给 body，
 * 并**等到焦点真的在 body 上**才返回——调用方紧接着发键盘（Tab/数字键/空格）时才不会落错地方。
 *
 * 为什么要先等 `free-input-field` 聚焦（而不是只等 status 行「就绪」）：game 屏就绪后 FreeInput 会
 * 自动聚焦输入框，那次 `input.focus()` 挂在 `status` 上、是**回合收尾之后才跑的被动 effect**——
 * React 先把「就绪」写进 DOM，随后才执行它。于是 status 行读到「就绪」的那一刻，App 手里还欠一次
 * 聚焦动作：此刻点画面角落把焦点还给 body，那次自动聚焦会晚一步落下来，把焦点从我们要发键盘的地方抢走。
 * 后果正是 post-merge CI 上偶发红的那条：Tab 的起点从 body 变成输入框——首个焦点跑到面板的
 * 麦克风/发送上（不是命令轨「设置」），空格与数字键也会被输入框吃掉（`isTypingTarget` 让路）。
 *
 * 判据是**事件**不是时长：等到输入框真的拿到焦点，就说明那次欠下的聚焦已经落地，之后不再有任何
 * 程序化 focus 会抢焦点（没有玩家输入就不会有新回合、也就没有新的 status 变化 → FreeInput 的 effect
 * 不会再触发）。桌面/CI 一样成立，也不吃「机器多慢」——等待没有时长参数可调。
 * 前置：game 屏已达就绪（enterProtagonist/quickStartToGame/continueWorld 等过 status 行之后）。
 */
export async function handFocusBackToBody(page: Page): Promise<void> {
  // 就绪态的自动聚焦（一次性）已落地：此后没有任何 pending 的 focus 会跟我们的键盘抢焦点
  await expect(page.getByTestId("free-input-field")).toBeFocused();
  // 走 mouse.click 发原始指针事件而不是 locator.click：全屏都是 fixed 定位，<body> 自身没有布局盒，
  // 后者会卡在 actionability 检查（element is not visible）超时
  await page.mouse.click(4, 4);
  await expect
    .poll(() => page.evaluate(() => document.activeElement === document.body), {
      message: "点击画面角落后焦点没回到 body（document.activeElement 另有其人）——后续键盘会从这里起步",
    })
    .toBe(true);
}
