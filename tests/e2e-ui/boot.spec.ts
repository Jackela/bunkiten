// 假引擎确定性 UI e2e（v1.9）：首启（boot）屏三态——checking / 未登录 / 连不上叙事服务。
// 为什么单独一个 spec：fake 栈过去**永远** seed 好 ~/.grok/auth.json（harness 里写死），boot 屏的
// 失败态在浏览器层零覆盖；jsdom 也测不了这条路径（要真打 /api/auth 并等真实网络结果）。
// 两个前置各一条：
//   · 未登录态用 harness 的 seed 开关 `auth: "missing"`（不写 ~/.grok/auth.json），
//     用例中途把文件补上再点「重试」——验的是重试**真的走通**，不是只换个文案；
//   · 连不上态用 page.route 把 /api/auth 拦下来（先挂住 → 落 502 → 再撤拦截），
//     checking 态因此是确定可观测的中间态（不是抢时序），三态全覆盖。
// 注意（15s 上限之后）：checking 不再是「想挂多久就挂多久」——`/api/auth` 之上有
// BOOT_FETCH_TIMEOUT_MS 的启动链上限，挂过点也会进同一个「连不上叙事服务。」错误态。所以那条用例
// 必须把「502 分支」钉死（放行前仍是 checking、且断言 502 已落地才看错误态），否则它会悄悄
// 退化成「超时 → 错误态」还在装绿。
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { BOOT_FETCH_TIMEOUT_MS } from "../../src/lib/acp";
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
      llm: {
        mode: "byok",
        provider: "custom",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "sk-boot-e2e-key-4f2a",
        model: "m",
      },
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

test("未登录（Codex 后端，v1.11）：指引写 `codex login`、设置入口换成「打开设置」；补上登录态后重试进标题屏", async ({
  browser,
}) => {
  const { stack, page } = await startUiStack(browser, {
    presets: ["demo"],
    turns: [],
    codexAuth: "missing",
    credentials: {
      version: 1,
      engine: "codex",
      llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
      image: { mode: "off", provider: "openai", baseUrl: "", apiKey: "", model: "", size: "" },
    },
  });
  try {
    await page.goto(stack.pageUrl);
    await expect(page.getByText("还没连上叙事引擎。")).toBeVisible();
    // 文案按引擎分支：codex 走 `codex login`，且因为不支持自备密钥，措辞是「打开设置」而不是「填自备密钥」
    await expect(page.getByText("codex login")).toBeVisible();
    await expect(page.getByTestId("boot-credentials")).toHaveText(/打开设置/);
    await expect(page.getByTestId("boot-retry")).toBeVisible();

    // 模拟玩家在终端里 `codex login` 完成：server 的 /api/auth 看的是 ~/.codex/auth.json（登录态复用的来源）
    writeFileSync(path.join(stack.stack.home, ".codex", "auth.json"), "{}\n");
    await page.getByTestId("boot-retry").click();
    await expect(page.getByTestId("title-card-center")).toBeVisible();
  } finally {
    await stopUiStack(page, stack);
  }
});

test("未登录（Codex）：一键登录把 CLI 登录流程拉起来 → 自动进标题屏（不必再点一次）", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, {
    presets: ["demo"],
    turns: [],
    codexAuth: "missing",
    credentials: {
      version: 1,
      engine: "codex",
      llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
      image: { mode: "off", provider: "openai", baseUrl: "", apiKey: "", model: "", size: "" },
    },
  });
  try {
    await page.goto(stack.pageUrl);
    await expect(page.getByTestId("boot-login")).toBeVisible();
    // 点「登录 Codex」→ 服务端 spawn（垫片扮演的）CLI → 它写下 ~/.codex/auth.json → 客户端轮询到就自动继续
    await page.getByTestId("boot-login-start").click();
    await expect(page.getByTestId("boot-login-waiting")).toBeVisible();
    await expect(page.getByTestId("title-card-center")).toBeVisible({ timeout: 20_000 });
    // 登录产物在**玩家自己的** home 里（游戏侧只有那份隔离用的副本）
    expect(existsSync(path.join(stack.stack.home, ".codex", "auth.json"))).toBe(true);
  } finally {
    await stopUiStack(page, stack);
  }
});

test("连不上叙事服务：checking → 错误提示 → 服务恢复后重试进标题屏", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, { presets: ["demo"], turns: [] });
  try {
    // 拦下 /api/auth 并把它挂在半途（既不响应也不失败）：checking 态在这段时间里是稳定画面。
    // 三个时间点都记下来，用来把「502 分支」和「超时分支」分开（两者落到同一个错误文案，看症状分不出来）：
    // armedAt=拦到请求、servedAt=502 真的写回浏览器、open()=我们放行。
    const gate: { armed: boolean; armedAt: number; servedAt: number; open: () => void } = {
      armed: false,
      armedAt: 0,
      servedAt: 0,
      open: () => {},
    };
    await page.route("**/api/auth", async (route) => {
      gate.armed = true;
      gate.armedAt = Date.now();
      await new Promise<void>((resolve) => {
        gate.open = resolve;
      });
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      gate.servedAt = Date.now(); // 502 已交回浏览器：此后才允许出现错误态
    });
    await page.goto(stack.pageUrl);
    await expect(page.getByText("正在确认登录状态…")).toBeVisible();
    // 拦下（armed）才放行——避免「请求还没发出就 open」的空放行
    await expect.poll(() => gate.armed, { message: "GET /api/auth 未被拦截到" }).toBe(true);

    // 放行前仍是 checking（还没有错误态）：这是「没踩到 15s 上限」的现场证据——若这一跳已经挂过点，
    // 启动链上限会先落地成同一个错误态，后面那条断言就不再能证明走的是 502 分支了
    expect(Date.now() - gate.armedAt, "挂住时长已逼近启动链上限，这条用例正在退化成「超时 → 错误态」").toBeLessThan(
      BOOT_FETCH_TIMEOUT_MS,
    );
    await expect(page.getByText("连不上叙事服务。")).toHaveCount(0);

    gate.open(); // 502 → fetchAuth 抛错 → 错误态
    // 只在 502 分支成立的顺序与时限：① 502 真的落回浏览器（route.fulfill 完成）才可能出错误态；
    // ② 错误态在 5s 内出现——超时分支此刻还差大半截（放行前挂住时长 + 5s < 上限），出不来。
    await expect.poll(() => gate.servedAt, { message: "502 未被写回浏览器" }).toBeGreaterThan(0);
    await expect(page.getByText("连不上叙事服务。")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();

    // 服务恢复（撤掉拦截）后重试：自检通过 → 标题屏
    await page.unroute("**/api/auth");
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByTestId("title-card-center")).toBeVisible();
  } finally {
    await stopUiStack(page, stack);
  }
});
