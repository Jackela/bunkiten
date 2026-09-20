// 假引擎确定性 UI e2e ②：设置屏读写与持久化。
// 路径：快速开局进 game 屏 → TopBar 齿轮（RailButton aria-label=设置）→ settings overlay →
// 改主音量滑杆（受控 input：原生 value setter + dispatch input 事件，React onChange 才会吃到）
// 与文本速度档位按钮 → 断言 localStorage `bunkiten.settings.v1` 即时落盘 → reload 后再进设置屏，
// 断言改动被 loadSettings 读回并渲染（设置是本机偏好，不进世界线，生命周期就是 localStorage）。
// v1.10 起另有两条「引擎与密钥」用例（各自起一套 auth:"missing" 的栈，从 boot 屏的「填自备密钥」入口进设置屏）：
//   ① 对话组全流程：填 key → 掩码 → 刷新后仍可开玩 → 重启引擎 → 清空回落，末尾带响应体明文哨兵；
//   ② 图片组与「测试连接」：本机假服务商给一条**确定性成功**路径（GET /models），图片组则指向必然拒连的端口
//      拿**确定性失败**，两条探活结果都要在屏上读到（三态的第三态「测试中」由点击到结果出现之间的短暂窗口承担，
//      不额外断言——它是过渡态，钉它只会引入时序脆弱）。
import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, quickStartToGame } from "./flow";

const SETTINGS_KEY = "bunkiten.settings.v1";

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    // 两条开局回合：首局与 reload 后的第二局各消费一条（fake-engine 的 match 命中不重复用）
    turns: [
      { match: "开局：", ops: ["夜色落定，走廊尽头的灯还亮着。\n\n**行动**\n1. 走过去\n2. 先回房\n"] },
      { match: "开局：", ops: ["灯灭了。\n\n**行动**\n1. 摸黑前进\n2. 点亮手机\n"] },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
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

test("引擎与密钥：填 key → 掩码 → 刷新后仍在 → 重启引擎生效 → 清空回落，且响应里从无明文", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, {
    presets: ["demo"],
    turns: [{ match: "开局：", ops: ["夜色落定。\n\n**行动**\n1. 走过去\n2. 先回房\n"] }],
    auth: "missing",
  });
  const key = "sk-e2e-mask-key-4f2a";
  // 明文泄漏哨兵：任何 /api/credentials* 的响应体里都不许出现这串 key
  const leaked: string[] = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/credentials")) return;
    try {
      if ((await res.text()).includes(key)) leaked.push(res.url());
    } catch {
      /* 无体响应：忽略 */
    }
  });
  try {
    // 从 boot 屏的「填自备密钥」进设置屏（也顺带覆盖未登录态的这个入口）
    await page.goto(stack.pageUrl);
    await page.getByTestId("boot-credentials").click();
    await expect(page.getByTestId("engine-keys")).toBeVisible();

    // 切「自备密钥」→ 表单展开；换服务 → 地址按目录预填
    await page.getByTestId("engine-llm-mode-byok").click();
    await expect(page.getByTestId("engine-llm-baseurl")).toBeVisible();
    await page.getByTestId("engine-llm-provider").selectOption("deepseek");
    await expect(page.getByTestId("engine-llm-baseurl")).toHaveValue("https://api.deepseek.com");

    // 填 key → 失焦即提交并回掩码（输入框清空，占位显示服务端掩码）
    await page.getByTestId("engine-llm-apikey").fill(key);
    await page.getByTestId("engine-llm-apikey").blur();
    await expect(page.getByTestId("engine-llm-apikey")).toHaveValue("");
    await expect(page.getByTestId("engine-llm-apikey")).toHaveAttribute("placeholder", "sk-…4f2a（已保存）");
    await expect(page.getByText("已配置")).toBeVisible();
    await expect(page.getByTestId("engine-llm-apikey-clear")).toBeVisible();

    // 刷新：配置在服务端，boot 自检直接放行（未登录也能开玩），掩码与地址原样回显
    await page.goto(stack.pageUrl);
    await expect(page.getByTestId("title-card-center")).toBeVisible();
    await expect(page.getByTestId("boot-login")).toHaveCount(0);
    await enterProtagonist(page, "示例剧本");
    await quickStartToGame(page);
    await page.getByTestId("settings").click();
    await expect(page.getByTestId("engine-keys")).toBeVisible();
    await expect(page.getByTestId("engine-llm-baseurl")).toHaveValue("https://api.deepseek.com");
    await expect(page.getByTestId("engine-llm-apikey")).toHaveAttribute("placeholder", "sk-…4f2a（已保存）");
    await expect(page.getByText("已配置")).toBeVisible();

    // 「立刻重启引擎」：假引擎被重 spawn（重启后 HTTP 侧照常可用）
    await page.getByTestId("engine-restart").click();
    await expect(page.getByTestId("engine-restart-note")).toHaveText("引擎已重启，新配置已生效");
    await expect.poll(async () => (await page.request.get(`${stack.pageUrl}/api/auth`)).status()).toBe(200);

    // 清空 key：回落「未配置完整」，占位回到提示语；服务端视图里也没了
    await page.getByTestId("engine-llm-apikey-clear").click();
    await expect(page.getByTestId("engine-llm-apikey")).toHaveAttribute("placeholder", "粘贴服务商给的密钥");
    await expect(page.getByTestId("engine-llm-apikey-clear")).toHaveCount(0);
    const view = await (await page.request.get(`${stack.pageUrl}/api/credentials`)).json();
    expect(view.llm.hasKey).toBe(false);

    expect(leaked).toEqual([]);
  } finally {
    await stopUiStack(page, stack);
  }
});

test("引擎与密钥 · 图片组与测试连接：两条探活路径（通过 / 失败）都能在屏上看到", async ({ browser }) => {
  // 本机假服务商：给「测试连接」一条确定性的**成功**路径（acp-server 与浏览器同机，能连到它）
  const provider = http.createServer((req, res) => {
    if ((req.url ?? "").endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  const providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

  const { stack, page } = await startUiStack(browser, { presets: ["demo"], turns: [], auth: "missing" });
  try {
    await page.goto(stack.pageUrl);
    await page.getByTestId("boot-credentials").click();
    await expect(page.getByTestId("engine-keys")).toBeVisible();

    // 对话组：指到假服务商 → 「测试连接」走 /models 那条路（不消耗生成额度）
    await page.getByTestId("engine-llm-mode-byok").click();
    await page.getByTestId("engine-llm-baseurl").fill(providerBase);
    await page.getByTestId("engine-llm-model").fill("fake-model");
    await page.getByTestId("engine-llm-apikey").fill("sk-e2e-probe-1234");
    await page.getByTestId("engine-llm-apikey").blur();
    // 掩码出现 = 那一笔保存（含防抖中的地址与模型）已经落盘，探针读到的就是这份配置
    await expect(page.getByTestId("engine-llm-apikey")).toHaveAttribute("placeholder", "sk-…1234（已保存）");
    await page.getByTestId("engine-llm-test").click();
    await expect(page.getByTestId("engine-llm-test-result")).toContainText("通过（");
    await expect(page.getByTestId("engine-llm-test-result")).toContainText("个模型");

    // 图片组：切模式 → 尺寸两格出现 → 填一组必然连不上的地址（确定性失败路径）+ 掩码
    await page.getByTestId("engine-image-mode-byok").click();
    await expect(page.getByTestId("engine-image-size")).toBeVisible();
    await expect(page.getByTestId("engine-image-size-background")).toBeVisible();
    await page.getByTestId("engine-image-size").fill("512x512");
    await page.getByTestId("engine-image-size-background").fill("1792x1024");
    await page.getByTestId("engine-image-baseurl").fill("http://127.0.0.1:9/v1");
    await page.getByTestId("engine-image-model").fill("img-model");
    await page.getByTestId("engine-image-apikey").fill("sk-e2e-image-4321");
    await page.getByTestId("engine-image-apikey").blur();
    await expect(page.getByTestId("engine-image-apikey")).toHaveAttribute("placeholder", "sk-…4321（已保存）");
    await page.getByTestId("engine-image-test").click();
    await expect(page.getByTestId("engine-image-test-result")).toContainText("失败：");

    // 两组都真的落到了服务端（尺寸两格与背景专用尺寸也是）
    const view = await (await page.request.get(`${stack.pageUrl}/api/credentials`)).json();
    expect(view.llm.apiKeyMasked).toBe("sk-…1234");
    expect(view.image).toMatchObject({
      mode: "byok",
      size: "512x512",
      sizeBackground: "1792x1024",
      hasKey: true,
      apiKeyMasked: "sk-…4321",
      model: "img-model",
    });
  } finally {
    await new Promise<void>((r) => provider.close(() => r()));
    await stopUiStack(page, stack);
  }
});

test("设置屏：改主音量与文本速度→localStorage 落盘→刷新后保持", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // TopBar 右侧竖排命令轨的「设置」进 overlay
  await page.getByTestId("settings").click();
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
  await page.getByTestId("settings").click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await expect(page.getByTestId("settings-master")).toHaveValue("0.3");
  await expect(page.getByTestId("settings-textspeed-instant")).toHaveAttribute("aria-pressed", "true");
});
