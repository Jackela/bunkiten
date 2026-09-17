// 假引擎确定性 UI e2e ⑧：动效降级（prefers-reduced-motion，v1.7）。
// Playwright 的 context 级 reducedMotion:"reduce" 让页面里的 matchMedia("(prefers-reduced-motion: reduce)")
// 命中——走一遍开局回合断言两件事：
//   1. 长正文（≥80 字）**整段立现**，没有逐字打字过程：turn_end（status=就绪）与 finalText 同批落 store，
//      降级路径下打字 effect 直接 setShown(全文)，所以 status 一到「就绪」后的**立即一次读取**就该有末句；
//      而打字路径（标准档 24ms/字）此刻还在开头，百字正文要 >1s 才打完——末句必然缺席，探针可靠。
//   2. MotionConfig reducedMotion="user" 不破坏屏切换：crafting→game 转场后的 game 屏可用，选项照常浮出。
// 反向（默认 no-preference 下「先见前缀再补全」）刻意不做：那要断言一个真实定时器的中间进度，
// 快慢机上窗口都会抖，无法与 reduce 侧保持同一确定性口径——该路径由 tests/ui.test.tsx 的
// matchMedia 缺失用例（不降级、照常逐字）在 jsdom 里确定性覆盖。
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startFakeStack } from "../helpers/fake-stack.mjs";
import { enterProtagonist, quickStartToGame } from "./flow";

/** ≥80 字长正文；末句放最后，当「打字进度」探针（打字路径下它最后才轮到） */
const BODY =
  "蝉鸣把旧教学楼叫成一锅白粥，她抱着书包站在教室后门，指尖还捏着那张没写完的转学介绍信。" +
  "走廊尽头的窗开着，风把公告栏上的纸页掀得哗啦作响，像是有人在一页页翻她的来路。" +
  "她深吸一口气，终于伸手推向那扇虚掩的门。";
const LAST_SENTENCE = "她深吸一口气，终于伸手推向那扇虚掩的门。";

let stack: Awaited<ReturnType<typeof startFakeStack>>;
let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  stack = await startFakeStack({
    presets: [{ id: "demo", title: "示例剧本" }],
    turns: [
      {
        match: "开局：",
        ops: [`${BODY}\n\n**行动**\n1. 推门进去\n2. 转身先去天台\n`],
      },
    ],
  });
  // context 级模拟系统「减少动态效果」：页面内 prefers-reduced-motion 查询命中 reduce
  page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
});

test.afterAll(async () => {
  if (page) await page.close().catch(() => {});
  await stack?.stop();
});

test("reduce 下开局：正文整段立现（无打字过程），game 屏照常可用", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // 立即一次读取（不轮询等待）：降级路径应已含末句；打字路径此刻仍在开头
  const text = (await page.getByTestId("dialogue-text").textContent()) ?? "";
  expect(text).toContain(LAST_SENTENCE);

  // 动效降级不破坏 ScreenShell 转场：crafting→game 切换后的 game 屏可用，选项按钮照常浮出
  await expect(page.getByTestId("dialogue-text")).toBeVisible();
  await expect
    .poll(async () => page.getByTestId("options").locator("button").count())
    .toBeGreaterThanOrEqual(2);
});
