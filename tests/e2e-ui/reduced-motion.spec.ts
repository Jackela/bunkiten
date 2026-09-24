// 假引擎确定性 UI e2e ⑧：动效降级（prefers-reduced-motion，v1.7）。
// Playwright 的 context 级 reducedMotion:"reduce" 让页面里的 matchMedia("(prefers-reduced-motion: reduce)")
// 命中——走一遍开局回合断言三件事：
//   1. 长正文（≥80 字）**整段立现**，没有逐字打字过程：turn_end（status=就绪）与 finalText 同批落 store，
//      降级路径下打字 effect 直接 setShown(全文)，所以 status 一到「就绪」后的**立即一次读取**就该有末句；
//      而打字路径（标准档 24ms/字）此刻还在开头，百字正文要 >1s 才打完——末句必然缺席，探针可靠。
//   2. MotionConfig reducedMotion="user" 不破坏屏切换：crafting→game 转场后的 game 屏可用，选项照常浮出。
//   3. **换背景不做交叉淡化**（v1.8 补）：第二张【图】背景上屏那一刻就是硬切——新图层没有
//      stage-bg-fade 动画（global.css 的 reduce 段把 .stage-bg-fade 设成 animation:none）、
//      computed opacity 已经是 1，且过渡窗口内逐帧采样全在 1（没有「先透明再爬到不透明」的中间态）。
//      正常档的对照在 opening.spec.ts：那里两层并存、淡入时长 = BG_FADE_MS（600ms）。
//      口径说明（信号别取错）：**不能**断言「reduce 下两层不同时存在」——实现里「新图晋级为底图」的时刻由
//      setTimeout(BG_FADE_MS) 钉死、与动画是否播放无关（见 BgLayer 文件头），所以 reduce 下旧底图仍在 DOM 里
//      待满 600ms，只是被不透明的新图整个盖住、看不到。reduce 真正改的是**新层带不带淡入**，所以断言取
//      CSS 侧的真源（animation:none）加上屏即不透明的计算样式，而不是去数层数。
// 反向（默认 no-preference 下「先见前缀再补全」）刻意不做：那要断言一个真实定时器的中间进度，
// 快慢机上窗口都会抖，无法与 reduce 侧保持同一确定性口径——该路径由 tests/ui.test.tsx 的
// matchMedia 缺失用例（不降级、照常逐字）在 jsdom 里确定性覆盖。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, quickStartToGame } from "./flow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** ≥80 字长正文；末句放最后，当「打字进度」探针（打字路径下它最后才轮到） */
const BODY =
  "蝉鸣把旧教学楼叫成一锅白粥，她抱着书包站在教室后门，指尖还捏着那张没写完的转学介绍信。" +
  "走廊尽头的窗开着，风把公告栏上的纸页掀得哗啦作响，像是有人在一页页翻她的来路。" +
  "她深吸一口气，终于伸手推向那扇虚掩的门。";
const LAST_SENTENCE = "她深吸一口气，终于伸手推向那扇虚掩的门。";

/** 开局回合的 op 序列：长正文 + 第一张背景（教堂）+ 两个选项（换背景由点第一项触发） */
const OPENING_OPS = [`${BODY}\n\n`, "【图】背景|教堂|images/2.jpg\n", "**行动**\n1. 推门进去\n2. 转身先去天台\n"];
/** 点第一项后的应答回合：换第二张背景（教堂 → 街道）——reduce 下这一下必须是硬切，不能有淡入 */
const SWAP_BG_OPS = ["【图】背景|街道|images/3.jpg\n", "街灯一盏一盏亮起来，雨幕里多出一条湿亮的石板路。\n"];

/**
 * 一层背景的现场读数（页面内取样，全是计算样式——「有没有淡入」只有计算样式说了算）：
 * 层身份（bg-current 底图 / bg-incoming 淡入中的上层）+ 图 URL + animation-name + 正在跑的动画数 + opacity。
 */
interface LayerState {
  /** data-testid 读出的层身份 */
  layer: string | null;
  /** backgroundImage 解码后的 URL */
  url: string;
  /** computed animation-name：reduce 下 .stage-bg-fade 应为 "none" */
  anim: string;
  /** el.getAnimations() 数量（CSS 动画 + 过渡） */
  anims: number;
  /** computed opacity（原字面，reduce 下上屏即 "1"） */
  opacity: string;
}

/** 当前底图（bg-current）的 backgroundImage（解码后）；没有底图时为空串 */
const currentBg = (): Promise<string> =>
  page.evaluate(() =>
    decodeURIComponent(
      (document.querySelector('[data-testid="bg-current"]') as HTMLElement | null)?.style.backgroundImage ?? "",
    ),
  );

/** 所有背景层的图 URL（DOM 顺序）——稳态应恰好一层 */
const layerUrls = (): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="bg-layer"] > div')).map((node) =>
      decodeURIComponent((node as HTMLElement).style.backgroundImage),
    ),
  );

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    // 两张背景图都要真的能解码（复用仓库现成素材）：BgLayer 是「离屏 new Image() onload 之后才上屏」，
    // 资产缺失时 onload 永不触发、画面里根本没有背景层，「换图」也就无从断言。
    // /img 的 t&n&preset 契约会命中 presets/<id>/assets/ 的落盘文件直服（与 opening.spec.ts 同款）。
    assets: {
      demo: [
        {
          name: "背景-教堂.jpg",
          bytes: readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", "背景-灰雀镇教堂.jpg")),
        },
        {
          name: "背景-街道.jpg",
          bytes: readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", "背景-灰雀镇后巷.jpg")),
        },
      ],
    },
    // fake-engine 的「已消费」标记是**进程级**的（同一条目不会被两条用例共用），所以两条用例各要一份
    // 自己的开局条目 + 换背景条目（与 keyboard.spec.ts 的多条目写法同款）。条目内容逐字相同，
    // 命中顺序：用例一的开局 → 第 1 条；用例二的开局 → 第 3 条；点第一项后的换背景 → 第 2/4 条。
    turns: [
      { match: "开局：", ops: OPENING_OPS },
      { match: "推门进去", ops: SWAP_BG_OPS },
      { match: "开局：", ops: OPENING_OPS },
      { match: "推门进去", ops: SWAP_BG_OPS },
    ],
    // context 级模拟系统「减少动态效果」：页面内 prefers-reduced-motion 查询命中 reduce
    contextOptions: { reducedMotion: "reduce" },
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
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
  await expect.poll(async () => page.getByTestId("options").locator("button").count()).toBeGreaterThanOrEqual(2);
});

test("reduce 下换背景：新图瞬时上屏（无 stage-bg-fade 动画、上屏即不透明）", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // 第一张背景（教堂）先晋级成底图：晋级时刻由 setTimeout(BG_FADE_MS) 钉死、与动画无关，
  // reduce 下照常发生——这条也顺带证明背景链路是活的（后面断言的不是一个死功能）
  await expect.poll(currentBg, { message: "第一张背景没有落成底图（bg-current）" }).toContain("教堂");

  // 记录器（页面内装）：MutationObserver 盯 BgLayer 子树（层增删 / backgroundImage 改写），
  // 每次变动记一帧「计算样式快照」；rAF 循环再逐帧采样同一组读数——「过渡窗口里有没有中间态」
  // 由页面自己回答，测试进程不掐表（不用 waitForTimeout，也不依赖采样时机）。
  const recorder = await page.evaluate(() => {
    const w = window as unknown as { __bgSnaps: LayerState[][]; __bgFrames: LayerState[]; __bgObserved: boolean };
    const read = (): LayerState[] =>
      Array.from(document.querySelectorAll('[data-testid="bg-layer"] > div')).map((node) => {
        const el = node as HTMLElement;
        const cs = getComputedStyle(el);
        return {
          layer: el.getAttribute("data-testid"),
          url: decodeURIComponent(el.style.backgroundImage),
          anim: cs.animationName,
          anims: el.getAnimations ? el.getAnimations().length : 0,
          opacity: cs.opacity,
        };
      });
    const key = (s: LayerState[]): string =>
      s.map((l) => `${l.layer}#${l.url}#${l.anim}#${l.anims}#${l.opacity}`).join("|");
    w.__bgSnaps = [];
    w.__bgFrames = [];
    const snapshot = (): void => {
      const s = read();
      const last = w.__bgSnaps[w.__bgSnaps.length - 1];
      if (!last || key(last) !== key(s)) w.__bgSnaps.push(s); // 相邻重复去重，只留状态真的变了的帧
    };
    const layer = document.querySelector('[data-testid="bg-layer"]');
    w.__bgObserved = !!layer;
    snapshot();
    if (layer) {
      new MutationObserver(snapshot).observe(layer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    }
    const tick = (): void => {
      for (const l of read()) w.__bgFrames.push(l);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return { observed: w.__bgObserved, first: w.__bgSnaps[0] ?? [] };
  });
  expect(recorder.observed, "App 根没有 [data-testid=bg-layer]：背景层结构变了，观察者没挂上去").toBe(true);
  expect(
    recorder.first.some((l) => l.url.includes("教堂")),
    "换图前底图上就该是教堂",
  ).toBe(true);

  // 换背景：点第一项选项 → 引擎发第二张【图】背景（教堂 → 街道）
  await page.getByTestId("options").locator("button").first().click();
  await expect(page.getByTestId("dialogue-text")).toContainText("街灯一盏一盏亮起来");
  await expect(page.getByTestId("status")).toHaveText("就绪");

  // 收尾态：稳态仍是「只剩一层底图带新图」——reduce 只关淡入，不改「新图晋级为底图、上层卸载」这条状态机
  await expect
    .poll(layerUrls, { message: "换图后背景层没有收敛成「只剩新图一层」" })
    .toEqual([expect.stringContaining("街道")]);

  const log: { snaps: LayerState[][]; frames: LayerState[] } = await page.evaluate(() => {
    const w = window as unknown as { __bgSnaps: LayerState[][]; __bgFrames: LayerState[] };
    return { snaps: w.__bgSnaps, frames: w.__bgFrames };
  });

  // —— 核心断言：新图上屏那一刻就是「不可见过渡」——
  // 找「新图刚进 DOM」的那一帧快照（第一次出现街道的那一帧）
  const insert = log.snaps.find((s) => s.some((l) => l.url.includes("街道")));
  expect(
    insert,
    `没有记录到新图上屏的快照（bg-layer 子树没有任何变动）——快照：${JSON.stringify(log.snaps)}`,
  ).toBeDefined();
  const incoming = insert!.filter((l) => l.url.includes("街道"));
  expect(incoming.length, `新图应恰好占一层，实际 ${JSON.stringify(insert)}`).toBe(1);
  expect(incoming[0].layer, "上屏的新图不在 bg-incoming 层上：层结构变了").toBe("bg-incoming");
  // ① 没有淡入动画：reduce 段把 .stage-bg-fade 设成 animation:none（这一条是 CSS 契约的真源）
  expect(incoming[0].anim, "新图层仍挂着 stage-bg-fade：global.css 的 reduce 段没生效（还在淡入）").toBe("none");
  expect(incoming[0].anims, "新图层上有正在跑的动画（淡入没被关掉）").toBe(0);
  // ② 上屏即不透明 = 硬切。正常档这一刻是 0、600ms 内爬到 1（opening.spec.ts 的过渡期快照）
  expect(incoming[0].opacity, "新图层上屏时不是不透明的：仍在做交叉淡化（旧图会被逐渐盖掉）").toBe("1");
  // ③ 逐帧采样：新图层**还在场**（bg-incoming）期间每一帧都是不透明的
  //（排除「插入那刻恰好 1、随后被拉进淡入」的假瞬时；晋级成底图之后的帧不算过渡窗口，只用来证明采样循环活着）
  const incomingFrames = log.frames.filter((l) => l.layer === "bg-incoming" && l.url.includes("街道"));
  expect(log.frames.length, "rAF 采样循环一帧都没记到：页面没画帧（探针没跑起来）").toBeGreaterThan(1);
  expect(
    incomingFrames.length,
    "rAF 没有采到「新图层在场」的任何一帧——无法证明过渡窗口内没有中间态（页面在这 600ms 里没画帧？）",
  ).toBeGreaterThan(0);
  for (const f of incomingFrames) {
    expect(f.opacity, `新图层在场期间出现非不透明帧（淡入中间态）：${JSON.stringify(f)}`).toBe("1");
    expect(f.anims, `新图层在场期间有动画在跑：${JSON.stringify(f)}`).toBe(0);
  }
});
