// 假引擎确定性 UI e2e ⑪：mock 出图链路——画廊重绘 → 引擎经 MCP 出图 → app 落盘 → UI 反映，**全离线**。
//
// 这一跳覆盖的是：标题屏「素材」（openAssets(current)）→ 画廊里点开一张**已有**的基础立绘 →
// 「重新生成」（发 `美术：重绘 立绘 <名>`）→ 假引擎按 FAKE_ENGINE_CALL_MCP=1 真的对挂在会话上的
// MCP 连接发 tools/call（catalog 全名 bunkiten-media__generate_image）→ server/media-mcp.mjs 打
// **本 spec 进程内起的假图片服务**（tests/helpers/mock-image-server.mjs）→ 字节落盘覆盖
// `presets/<剧本 id>/assets/<类型>-<名>.jpg` → 补一条【图|重绘】协议行 → 画廊收尾换图。
//
// 与另外两条同链路用例的分工（三层各测各的，谁也替不了谁——本条就是那条真链路的离线替身）：
//   · tests/integration/media-mock.test.ts：同一替身链路的**协议层**版（不起浏览器、不点 UI，
//     断言的是事件流 + 引擎探针）；
//   · tests/e2e-packaged/real-image.spec.ts（opt-in、**不进 CI**）：**真链路**——真 grok CLI + 真图片服务，
//     要凭据、要出网、真花一次对话与一张图，落盘进 .app 内的 resources/game；
//     本条与它走**同一个 UI 走法**（标题屏「素材」→ 立绘卡 → 重新生成），只是把驱动全换成假的：
//     假服务收几次、回什么字节、页面变成什么样，都是可断言的确定值。
//
// 为什么 seed 一张「已有基础立绘」：重绘的目标按定义已经存在（SKILL【素材重绘】是唯一绕过出图缓存的
// 路径，缓存检查不会跳过它），假引擎也正是靠这个既有文件定出剧本 id 与落盘路径 —— 两侧的前提是同一个。
//
// 目标：秒级、无网络、可反复跑（`npx playwright test -c playwright.ui.config.ts tests/e2e-ui/media-mock.spec.ts`）。
import { readFileSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startMockImageServer } from "../helpers/mock-image-server.mjs";
import { BOOT_TO_TITLE_MS } from "./flow";
import { startUiStack, stopUiStack } from "./stack";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 重绘目标：基础立绘「薇拉」。卡片 testid、落盘路径、指令里的名全由它推（种子剧本的角色表里就有薇拉） */
const ART_NAME = "薇拉";
const TARGET_REL = `presets/demo/assets/立绘-${ART_NAME}.jpg`;
/** seed 进剧本目录的「旧图」：仓库里现成的真 jpg——与假服务会返回的那张 160B 夹具必然不同内容 */
const seedBytes = (): Buffer => readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", `立绘-${ART_NAME}.jpg`));

/** 图片凭据（假 key / 假模型；baseUrl 指到本 spec 进程内的假图片服务——媒体 MCP 自己读这份凭据） */
const IMAGE_KEY = "sk-e2e-mock-image-1234";
const IMAGE_MODEL = "mock-image";

test("mock 出图：画廊重绘 → 引擎经 MCP 打假图片服务 → 覆盖落盘 + 画廊换图", async ({ browser }) => {
  const mock = await startMockImageServer();
  const { stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    // 重绘目标：剧本目录里先有一张基础立绘（重绘的前提；也是假引擎定剧本 id 的依据）
    assets: { demo: [{ name: `立绘-${ART_NAME}.jpg`, bytes: seedBytes() }] },
    credentials: {
      version: 1,
      // 叙事侧仍走 grok 登录态（harness 已写临时 HOME 的 auth.json）：这条用例只关心图片侧自备 key
      llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
      image: { mode: "byok", provider: "custom", baseUrl: mock.base, apiKey: IMAGE_KEY, model: IMAGE_MODEL, size: "" },
    },
    // 让假引擎真的对 MCP 连接发 tools/call（隐含 FAKE_ENGINE_SPAWN_MCP）——不开它这条链路根本不存在：
    // 出图工具是 media-mcp 提供的，而它只在图片侧配了自备 key 时才挂到会话上（见 server/media-mcp.mjs）
    extraEnv: { FAKE_ENGINE_CALL_MCP: "1" },
  });
  try {
    const target = path.join(stack.stack.root, TARGET_REL);

    // 标题屏 →「素材」：openAssets(current) 顺手把 selected 落到当前卡，画廊才有确定的剧本上下文
    await page.goto(stack.pageUrl);
    await expect(page.getByTestId("title-card-center")).toBeVisible({ timeout: BOOT_TO_TITLE_MS });
    await page.getByRole("button", { name: "素材", exact: true }).click();

    // 点开那张已有立绘的预览（重绘入口在预览里，是【素材重绘】唯一的玩家入口）
    const card = page.getByTestId(`asset-card-${ART_NAME}`);
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.getByTestId("assets-preview")).toBeVisible();
    const previewImg = page.getByTestId("assets-preview").locator("img");
    const srcBefore = (await previewImg.getAttribute("src")) ?? "";
    expect(srcBefore, "预览大图的 src 应带破缓存参数 v（= assetsStamp）").toContain("v=");

    // 前置核对：目标就是 seed 的旧图，内容 != 假服务会返回的图（否则下面的「字节 == mock 图」是空断言）
    expect(readFileSync(target).equals(mock.imageBytes), "seed 的旧图不该已经等于 mock 图").toBe(false);
    // mtime 回拨 2 分钟：让「mtime 前进」与文件系统的戳粒度、以及本次运行跑多快都无关（而不是 sleep 等戳变）
    const past = new Date(Date.now() - 120_000);
    utimesSync(target, past, past);
    const beforeMtime = statSync(target).mtimeMs;

    // 「重新生成」= 发 `美术：重绘 立绘 薇拉`，一次引擎回合
    await page.getByTestId("assets-preview-regen").click();

    // ① 假图片服务恰好被调 1 次：这条链上只有 media-mcp 会打它（engine → tools/call → media-mcp → 服务端）
    await expect
      .poll(() => mock.calls.length, {
        timeout: 30_000,
        // message 只收字符串（传函数会被 stringify 成源码，等于没诊断）：把起栈时的引擎探针快照先拼进去——
        // 它一眼能看出 MCP 到底有没有挂上、握手成没成（没挂上=图片凭据没生效；握手失败=spawn 出错）
        message:
          `30s 内假图片服务没收到生成请求：${TARGET_REL} 的重绘没有走到 MCP 出图` +
          `；引擎探针=${JSON.stringify(stack.stack.engineProbeEntries().slice(-4))}`,
      })
      .toBe(1);
    const call = mock.calls[0];
    expect(call.url).toBe("/v1/images/generations"); // media-mcp 的端点拼法：<baseUrl>/images/generations
    expect(call.method).toBe("POST");
    expect(call.model).toBe(IMAGE_MODEL); // 模型来自图片凭据
    expect(call.size).toBe("1024x1536"); // 立绘默认竖构图（media-mcp 的 DEFAULT_SIZES）
    expect(call.response_format).toBe("b64_json"); // media-mcp 的缺省请求形态，被假服务直收（没有触发退让重试）
    expect(call.headers.authorization).toBe(`Bearer ${IMAGE_KEY}`); // 鉴权头来自图片凭据的 key
    expect(call.prompt).toContain(ART_NAME); // 提示词由「美术：重绘 立绘 薇拉」推出

    // ② 落盘：目标 jpg 被覆盖成假服务返回的那张（mtime 前进 + 字节逐字相等）。
    // 合成一个 poll：media-mcp 是直接 writeFileSync 覆盖同名文件（不是 tmp+rename），拆开断言会读到
    // 「已开始写、还没写完」的中间态。
    /** 目标当前 mtime（读不到给一句人话——仅仅是为了让失败消息说清楚「现在是什么」） */
    const mtimeNow = (): number | string => {
      try {
        return statSync(target).mtimeMs;
      } catch {
        return "(读不到)";
      }
    };
    await expect
      .poll(
        () => {
          try {
            const st = statSync(target);
            return st.mtimeMs > beforeMtime && readFileSync(target).equals(mock.imageBytes);
          } catch {
            return false;
          }
        },
        {
          timeout: 30_000,
          message:
            `重绘后 ${TARGET_REL} 没有换成假服务的图：期望 mtime > ${beforeMtime}（此刻 ${mtimeNow()}）` +
            `且字节 == 回包（${mock.imageBytes.length}B）`,
        },
      )
      .toBe(true);
    // 轮询通过后再各读一次，把两条证据落成断言（失败时数字与字节直接可读）
    const after = statSync(target);
    expect(after.mtimeMs, `${TARGET_REL} 的 mtime 应前进（> ${beforeMtime}）`).toBeGreaterThan(beforeMtime);
    expect(readFileSync(target).equals(mock.imageBytes), `${TARGET_REL} 的字节应等于假图片服务返回的图`).toBe(true);

    // ③ UI 反映：批次提示就位（【图|重绘】标记命中挂起项 → finishRegen → 队列跑空落提示），
    // 预览大图的 src 随 assetsStamp 自增换新（破缓存），重绘按钮随收尾恢复可用
    await expect(page.getByTestId("assets-regen-notice")).toHaveAttribute("data-kind", "ok");
    await expect(page.getByTestId("assets-regen-notice")).toContainText("重绘完成");
    await expect(previewImg).not.toHaveAttribute("src", srcBefore);
    await expect(page.getByTestId("assets-preview-regen")).toBeEnabled();

    // 收尾再钉一次「恰好 1 次」：整条链路跑完之后也没有第二次请求（退让重试只会在非 2xx 时发生）
    expect(mock.calls, "假图片服务应恰好收到 1 次生成请求").toHaveLength(1);
    await expect(page.getByTestId("assets-error")).toHaveCount(0);
  } finally {
    await stopUiStack(page, stack);
    await mock.close();
  }
});
