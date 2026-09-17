// 假引擎确定性 UI e2e ②：设置屏读写与持久化。
// 路径：快速开局进 game 屏 → TopBar 齿轮（RailButton aria-label=设置）→ settings overlay →
// 改主音量滑杆（受控 input：原生 value setter + dispatch input 事件，React onChange 才会吃到）
// 与文本速度档位按钮 → 断言 localStorage `bunkiten.settings.v1` 即时落盘 → reload 后再进设置屏，
// 断言改动被 loadSettings 读回并渲染（设置是本机偏好，不进世界线，生命周期就是 localStorage）。
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startFakeStack } from "../helpers/fake-stack.mjs";
import { enterProtagonist, quickStartToGame } from "./flow";

const SETTINGS_KEY = "bunkiten.settings.v1";

let stack: Awaited<ReturnType<typeof startFakeStack>>;
let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  stack = await startFakeStack({
    presets: [{ id: "demo", title: "示例剧本" }],
    // 两条开局回合：首局与 reload 后的第二局各消费一条（fake-engine 的 match 命中不重复用）
    turns: [
      { match: "开局：", ops: ["夜色落定，走廊尽头的灯还亮着。\n\n**行动**\n1. 走过去\n2. 先回房\n"] },
      { match: "开局：", ops: ["灯灭了。\n\n**行动**\n1. 摸黑前进\n2. 点亮手机\n"] },
    ],
  });
  page = await (await browser.newContext()).newPage();
});

test.afterAll(async () => {
  if (page) await page.close().catch(() => {});
  await stack?.stop();
});

/** 读页面 localStorage 里的设置并 parse（无存档时给 null，便于断言区分） */
async function storedSettings(p: Page): Promise<Record<string, unknown> | null> {
  const raw = await p.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** 受控 range input 设值（React 会拦截直接赋值，须走原型 setter 再派发 input 事件） */
async function setRangeValue(p: Page, testId: string, value: number): Promise<void> {
  await p
    .getByTestId(testId)
    .evaluate(
      (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      value,
    );
}

test("设置屏：改主音量与文本速度→localStorage 落盘→刷新后保持", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // TopBar 右侧竖排命令轨的「设置」进 overlay
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();

  // 默认值渲染：主音量 100（DEFAULT_SETTINGS.master = 1）
  await expect(page.getByTestId("settings-master-value")).toHaveText("100");

  // 改主音量 0.3：滑杆读数、store、localStorage 三处同步
  await setRangeValue(page, "settings-master", 0.3);
  await expect(page.getByTestId("settings-master-value")).toHaveText("30");
  await expect(await storedSettings(page)).toMatchObject({ master: 0.3 });

  // 文本速度切「瞬间」档（Segmented 按钮组，点击即生效）
  await page.getByTestId("settings-textspeed-instant").click();
  await expect(page.getByTestId("settings-textspeed-instant")).toHaveAttribute("aria-pressed", "true");
  await expect(await storedSettings(page)).toMatchObject({ master: 0.3, textSpeed: "instant" });

  // 刷新（同 origin 重新 goto = reload）：localStorage 是唯一持久层，值必须原样读回
  await page.goto(stack.pageUrl);
  await expect(await storedSettings(page)).toMatchObject({ master: 0.3, textSpeed: "instant" });

  // 刷新后重走开局进 game 屏，再开设置屏：改动被 loadSettings 应用并渲染
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await expect(page.getByTestId("settings-master")).toHaveValue("0.3");
  await expect(page.getByTestId("settings-textspeed-instant")).toHaveAttribute("aria-pressed", "true");
});
