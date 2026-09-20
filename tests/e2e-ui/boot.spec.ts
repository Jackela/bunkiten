// 假引擎确定性 UI e2e（v1.9）：首启（boot）屏三态——checking / 未登录 / 连不上叙事服务。
// 为什么单独一个 spec：fake 栈过去**永远** seed 好 ~/.grok/auth.json（harness 里写死），boot 屏的
// 失败态在浏览器层零覆盖；jsdom 也测不了这条路径（要真打 /api/auth 并等真实网络结果）。
// 两个前置各一条：
//   · 未登录态用 harness 的 seed 开关 `auth: "missing"`（不写 ~/.grok/auth.json），
//     用例中途把文件补上再点「重试」——验的是重试**真的走通**，不是只换个文案；
//   · 连不上态用 page.route 把 /api/auth 拦下来（先挂住 → 落 502 → 再撤拦截），
//     checking 态因此是确定可观测的中间态（不是抢时序），三态全覆盖。
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startUiStack, stopUiStack } from "./stack";

test("未登录：出「还没连上叙事引擎」提示；补上登录态后点重试进标题屏", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, { presets: ["demo"], turns: [], auth: "missing" });
  try {
    await page.goto(stack.pageUrl);
    await expect(page.getByText("还没连上叙事引擎。")).toBeVisible();
    await expect(page.getByText("grok login")).toBeVisible();
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();

    // 模拟玩家在终端里 `grok login` 完成：server 的 /api/auth 只看这个文件在不在
    writeFileSync(path.join(stack.stack.home, ".grok", "auth.json"), "{}\n");
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByTestId("title-card-center")).toBeVisible();
  } finally {
    await stopUiStack(page, stack);
  }
});

test("未登录：给两个入口——「填自备密钥」进设置屏的引擎与密钥节", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, { presets: ["demo"], turns: [], auth: "missing" });
  try {
    await page.goto(stack.pageUrl);
    await expect(page.getByTestId("boot-login")).toBeVisible();
    await expect(page.getByTestId("boot-retry")).toBeVisible();
    await page.getByTestId("boot-credentials").click();
    await expect(page.getByTestId("engine-keys")).toBeVisible();
    await expect(page.getByTestId("engine-llm-mode-byok")).toBeVisible();
    await expect(page.getByTestId("engine-image-mode-byok")).toBeVisible();
  } finally {
    await stopUiStack(page, stack);
  }
});

test("未登录但已配好自备 key：不必终端登录，直接进标题屏", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, {
    presets: ["demo"],
    turns: [],
    auth: "missing",
    credentials: {
      version: 1,
      llm: { mode: "byok", provider: "custom", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-boot-e2e-key-4f2a", model: "m" },
      image: { mode: "off", provider: "openai", baseUrl: "", apiKey: "", model: "", size: "" },
    },
  });
  try {
    await page.goto(stack.pageUrl);
    await expect(page.getByTestId("title-card-center")).toBeVisible();
    await expect(page.getByTestId("boot-login")).toHaveCount(0);
  } finally {
    await stopUiStack(page, stack);
  }
});

test("连不上叙事服务：checking → 错误提示 → 服务恢复后重试进标题屏", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, { presets: ["demo"], turns: [] });
  try {
    // 拦下 /api/auth 并把它挂在半途（既不响应也不失败）：checking 态在这段时间里是稳定画面
    const gate: { armed: boolean; open: () => void } = { armed: false, open: () => {} };
    await page.route("**/api/auth", async (route) => {
      gate.armed = true;
      await new Promise<void>((resolve) => {
        gate.open = resolve;
      });
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });
    await page.goto(stack.pageUrl);
    await expect(page.getByText("正在确认登录状态…")).toBeVisible();
    // 拦下（armed）才放行——避免「请求还没发出就 open」的空放行
    await expect.poll(() => gate.armed, { message: "GET /api/auth 未被拦截到" }).toBe(true);

    gate.open(); // 502 → fetchAuth 抛错 → 错误态
    await expect(page.getByText("连不上叙事服务。")).toBeVisible();
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();

    // 服务恢复（撤掉拦截）后重试：自检通过 → 标题屏
    await page.unroute("**/api/auth");
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByTestId("title-card-center")).toBeVisible();
  } finally {
    await stopUiStack(page, stack);
  }
});
