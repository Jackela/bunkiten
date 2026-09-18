// 假引擎确定性 UI e2e ①：开局全链路 boot→title→worlds→新世界线→捏人填主角卡→开局→game 屏。
// 全程对 fake 栈（假 ACP 引擎 + 真 acp-server + vite dev，tests/helpers/fake-stack.mjs），无长等待。
// fake 回放一条贴近真引擎顺序的开局回合：【曲】→ 正文 → 【图】立绘/背景 → 【立绘】表情切换 →
// `**行动**` 选项段；断言正文进打字机、选项化身为按钮（选项段不进正文）、立绘上屏、TopBar 回「就绪」。
// 音频链路（【曲】→ /api/audio → /audio 直服 → AudioManager 播放）无 DOM 挂点，此处只保证协议行
// 真实流经全栈不破坏回合（seed 了对应 wav 让索引命中、代理通路被真实走到）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startFakeStack } from "../helpers/fake-stack.mjs";
import { enterProtagonist } from "./flow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 0.1s 无声 WAV（8kHz 16bit mono）：seed 进 presets/demo/audio/，让【曲】序幕 真的命中索引并播放
function silentWav(): Buffer {
  const rate = 8000;
  const samples = Math.floor(rate * 0.1);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

let stack: Awaited<ReturnType<typeof startFakeStack>>;
let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  stack = await startFakeStack({
    // 单剧本轮播（flow.ts 的前提）；body 追加 protagonist_card 小节供捏人屏出题
    presets: [
      {
        id: "demo",
        title: "示例剧本",
        body: "# protagonist_card\n\n- 性别: 男 / 女\n- 身份: 转学插班生 / 重考生\n",
      },
    ],
    // 预置立绘/背景（复用仓库现成素材）：【图】标记驱动画面时，/img 的 t&n&preset 契约
    // 优先命中 presets/<id>/assets/ 已落盘文件直服（缓存权威路径），真实尺寸、无需生成
    assets: {
      demo: [
        { name: "立绘-薇拉.jpg", bytes: readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", "立绘-薇拉.jpg")) },
        { name: "背景-教堂.jpg", bytes: readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", "背景-灰雀镇旅店客房.jpg")) },
      ],
    },
    audioFiles: { demo: [{ name: "曲-序幕.wav", bytes: silentWav() }] },
    turns: [
      {
        match: "开局：",
        ops: [
          "【曲】序幕\n",
          "雨声漫过教堂的尖顶，薇拉抱着账册站在门口，没有看你。\n",
          "【图】立绘|薇拉|images/1.jpg\n",
          "【图】背景|教堂|images/2.jpg\n",
          "【立绘】薇拉|微笑\n",
          "**行动**\n1. 撑伞迎上去\n2. 停在原地等她开口\n",
        ],
      },
    ],
  });
  page = await (await browser.newContext()).newPage();
});

test.afterAll(async () => {
  if (page) await page.close().catch(() => {});
  await stack?.stop();
});

test("开局全链路：捏人填卡→跳过美术开演→正文/选项/立绘、状态就绪", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");

  // 填主角卡：两问各选一项（chips 按钮文本即选项词），「开演」按钮随之解锁
  await page.getByRole("button", { name: "女", exact: true }).click();
  await page.getByRole("button", { name: "转学插班生", exact: true }).click();
  await page.getByTestId("skip-preload").click();

  // fake 回合秒回：TopBar 状态回到「就绪」
  await expect(page.getByTestId("status")).toHaveText("就绪");

  // 正文进打字机；`**行动**` 选项段被截断、不进正文（选项只由按钮呈现）
  await expect(page.getByTestId("dialogue-text")).toContainText("雨声漫过教堂的尖顶");
  await expect(page.getByTestId("dialogue-text")).not.toContainText("**行动**");

  // 选项化身为按钮（打字机完成后浮入，轮询数量），首项文本来自协议选项行
  await expect
    .poll(async () => page.getByTestId("options").locator("button").count())
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("options").locator("button").first()).toContainText("撑伞迎上去");

  // 【图】标记链路断言：立绘 img 挂载且真实解码（marker→URL→/img 命中 seed 资产→naturalWidth>0）。
  // 注：PortraitFigure 的 img 是 absolute + max-w-full 于 shrink-to-fit 容器——布局宽度为 0、视觉按
  // intrinsic 宽绘制（Chromium 实测：删掉 img 立绘消失，但 rect.width 恒 0），toBeVisible 会误报 hidden。
  const portrait = page.getByRole("img", { name: "薇拉" });
  await expect(portrait).toBeAttached();
  expect(await portrait.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // 【图】背景标记 → BgLayer 离屏预载 onload 后上屏（style.backgroundImage 已设置，URL 即 marker 直服目标）
  const bg = await page.evaluate(() => document.querySelector('div[class*="bg-cover"]')?.style.backgroundImage ?? "");
  expect(decodeURIComponent(bg)).toContain("背景");
  expect(decodeURIComponent(bg)).toContain("教堂");

  // 主题深化（v1.7）：demo 剧本没配 theme → 兜底 serif 栈注入 --font-preset 且根容器实际消费，
  // 对话框质感落到 dialog-plain 类（CSS 里 plain 无规则=现状）
  const root = page.getByTestId("sr-status").locator("..");
  await expect(root).toHaveCSS("font-family", /Georgia/);
  expect(await root.evaluate((el) => el.style.getPropertyValue("--font-preset"))).toContain('"Songti SC"');
  await expect(page.getByTestId("dialogue-text").locator("..")).toHaveClass(/dialog-plain/);
});
