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
// v1.11 续：③ 在线服务目录（docs/adr/0020）。这一条**真的**给服务端喂一份「在线目录」（本地 mock 发布源
//   + BUNKITEN_PROVIDERS_URL），所以浏览器读到的候选与 POST 保存时服务端校验看到的是**同一份目录**：
//   候选换成远端那份（含改名条目与新增条目）、地址按远端预填、屏上出现「在线目录」标注，并且**真的保存一个
//   只存在于这份 mock 目录里的 provider**（旧实现只在浏览器侧替掉读接口，会掩盖「服务端白名单不认远程 id → 400」
//   这个把目录核心收益挡死的问题）。服务端的抓取/缓存/校验通道另有单测与集成测试，不在这里重复。
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
    // 假栈离线（harness 默认 BUNKITEN_DISABLE_UPDATE=1）→ /api/providers 回内置表 → 不出现「在线目录」标注，
    // 下面的下拉走的就是内置那份候选（v1.11 的在线目录分支见本文件第 ③ 条用例）
    await expect(page.getByTestId("engine-catalog-online")).toHaveCount(0);

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

test("引擎与密钥 · 在线目录：候选换成远端那份、地址按远端预填，并真的保存一个 mock 目录独有的 provider", async ({ browser }) => {
  // 一份「在线目录」（形状与 GET /api/providers 的响应体一致）：一条已有 id 改名并换地址、一条全新 id、一条只在出图侧。
  // 用本地 mock 发布源真的喂给服务端——这样保存时服务端校验看到的目录与浏览器读到的完全一致。
  const mockCatalog = {
    version: 1,
    updatedAt: "2026-01-02T03:04:05.000Z",
    providers: [
      { id: "deepseek", label: "深海探路者", kind: "llm", baseUrl: "https://api.deepseek.com/online", models: ["deepseek-chat"] },
      { id: "newcomer-llm", label: "新来的服务", kind: "llm", baseUrl: "https://newcomer.example/v1", models: [] },
      { id: "newcomer-image", label: "新来的出图服务", kind: "image", baseUrl: "https://newcomer.example/img", models: [], imageModels: ["new-image-1"] },
    ],
  };
  const catalog = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(mockCatalog));
  });
  await new Promise<void>((r) => catalog.listen(0, "127.0.0.1", () => r()));
  const catalogUrl = `http://127.0.0.1:${(catalog.address() as { port: number }).port}/providers.json`;

  const { stack, page } = await startUiStack(browser, {
    presets: ["demo"],
    turns: [],
    auth: "missing",
    extraEnv: { BUNKITEN_DISABLE_UPDATE: "0", BUNKITEN_PROVIDERS_URL: catalogUrl },
  });
  try {
    // 启动期抓取是异步的：先等 /api/providers 变成 remote（GUI 挂载时读到的才是这份远端目录）。
    // 这不只是「屏上标注」的前置——保存走的是同一个服务端进程，它校验用的也是这份目录。
    await expect
      .poll(async () => (await (await page.request.get(`${stack.pageUrl}/api/providers`)).json()).source, { timeout: 10_000 })
      .toBe("remote");

    await page.goto(stack.pageUrl);
    await page.getByTestId("boot-credentials").click();
    await expect(page.getByTestId("engine-keys")).toBeVisible();

    // 标注：来源不是内置表时才出现（一句玩家话，不带 env / 内部标识）
    await expect(page.getByTestId("engine-catalog-online")).toContainText("在线目录");

    await page.getByTestId("engine-llm-mode-byok").click();
    const llm = page.getByTestId("engine-llm-provider");
    // 下拉确实换成了远端那份：同名 id 显示远端给的新名字，内置表里别的服务（这里拿 Mistral 当探针）不在候选里
    await expect(llm.locator('option[value="deepseek"]')).toHaveText("深海探路者");
    await expect(llm.locator('option[value="mistral"]')).toHaveCount(0);

    // 选改名那条 → 地址按**远端**预填（内置表那份是 https://api.deepseek.com）→ 真的存到服务端
    await llm.selectOption("deepseek");
    await expect(page.getByTestId("engine-llm-baseurl")).toHaveValue("https://api.deepseek.com/online");
    await expect
      .poll(async () => {
        const view = await (await page.request.get(`${stack.pageUrl}/api/credentials`)).json();
        return `${view.llm.provider}|${view.llm.baseUrl}`;
      })
      .toBe("deepseek|https://api.deepseek.com/online");

    // 核心收益：选一个**只存在于这份在线目录里**的服务并真的保存成功（服务端写路径认得目录里的新 id）；
    // 旧实现这里会被 400「不在服务目录里」挡住——正是那条通道存在的意义不可达。
    await llm.selectOption("newcomer-llm");
    await expect(page.getByTestId("engine-llm-baseurl")).toHaveValue("https://newcomer.example/v1");
    await expect
      .poll(async () => (await (await page.request.get(`${stack.pageUrl}/api/credentials`)).json()).llm.provider)
      .toBe("newcomer-llm");
    await expect(page.getByText("不在服务目录里")).toHaveCount(0); // 没有那条拒绝提示

    // 出图组同样吃远端候选（新增的出图服务出现在它的下拉里）
    await page.getByTestId("engine-image-mode-byok").click();
    await expect(page.getByTestId("engine-image-provider").locator('option[value="newcomer-image"]')).toHaveText("新来的出图服务");
  } finally {
    await new Promise<void>((r) => catalog.close(() => r()));
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
