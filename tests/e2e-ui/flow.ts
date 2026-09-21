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
