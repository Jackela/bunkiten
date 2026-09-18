// 假引擎确定性 UI e2e ①：开局全链路 boot→title→worlds→新世界线→捏人填主角卡→开局→game 屏。
// 全程对 fake 栈（假 ACP 引擎 + 真 acp-server + vite dev，tests/helpers/fake-stack.mjs），无长等待。
// fake 回放一条贴近真引擎顺序的开局回合：【曲】→ 正文 → 【图】立绘/背景 → 【立绘】表情切换 →
// `**行动**` 选项段；断言正文进打字机、选项化身为按钮（选项段不进正文）、立绘上屏、TopBar 回「就绪」。
// 音频链路（【曲】→ /api/audio → /audio 直服 → AudioManager 播放）无 DOM 挂点，此处只保证协议行
// 真实流经全栈不破坏回合（seed 了对应 wav 让索引命中、代理通路被真实走到）。
// v1.8 追加第二回合（点第一个选项触发）：换一张【图】背景，端到端验证背景**交叉淡化**——
// 过渡期 DOM 里新旧两图并存两层、BG_FADE_MS 后新图晋级、旧图退出（只剩一层）。这一条只能在这里验：
// jsdom 里 CSS 动画/过渡不推进，「两层并存 → 晋级」的状态机在浏览器里才跑得出来。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
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

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
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
        { name: "背景-街道.jpg", bytes: readFileSync(path.join(ROOT, "presets", "rift-mark", "assets", "背景-灰雀镇旅店客房.jpg")) },
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
      {
        // 第二回合（点第一项触发）：换背景。这是双层交叉淡化唯一的可观测入口——
        // 第一回合只来一张背景（底图为空 → 全程只有一层），看不出「两层并存 → 晋级」。
        match: "撑伞迎上去",
        ops: ["【图】背景|街道|images/3.jpg\n", "街灯一盏一盏亮起来，雨幕里多出一条湿亮的石板路。\n"],
      },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
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

  // 【图】标记链路断言：立绘 img 挂载、真实解码（marker→URL→/img 命中 seed 资产→naturalWidth>0）
  // 且**真的占了版面**——立绘层用 grid 单格堆叠（差分交叉淡化要同格重叠），容器因此拿到立绘宽度。
  // 此处刻意断言渲染尺寸：曾经写成 absolute + shrink-to-fit，img 布局宽恒为 0（视觉靠 intrinsic 绘制），
  // 只断言 attached/naturalWidth 会漏掉「立绘根本没上屏」的整类回归。
  const portrait = page.getByRole("img", { name: "薇拉" });
  await expect(portrait).toBeVisible();
  const portraitBox = await portrait.boundingBox();
  expect(portraitBox, "立绘 boundingBox 为 null：img 挂载了但没参与布局").not.toBeNull();
  expect(portraitBox!.width, "立绘渲染宽为 0：img 没拿到真实布局盒").toBeGreaterThan(0);
  expect(portraitBox!.height, "立绘渲染高为 0：img 没拿到真实布局盒").toBeGreaterThan(0);
  expect(await portrait.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // 右侧让位：立绘上屏时对话区不再压住立绘（GameStage 的 .portrait-reserve，≥lg 生效；1280×720 满足）
  const dialogueBox = await page.getByTestId("dialogue-box").boundingBox();
  expect(dialogueBox, "对话框没有布局盒（data-testid=dialogue-box 挂了但没渲染）").not.toBeNull();
  expect(
    dialogueBox!.x + dialogueBox!.width,
    `对话区右缘 ${dialogueBox!.x + dialogueBox!.width} 压住了立绘左缘 ${portraitBox!.x}（立绘 ${portraitBox!.width}×${portraitBox!.height}）：右侧预留没生效`,
  ).toBeLessThan(portraitBox!.x);
  // 让位是「整体左移」而不是「把对话面板挤窄」：1280 宽下 max-w-[800px] 扣掉 px-3.5 后应 ≈772，
  // 只有把预留 padding 加在对话面板自身上才会缩到 ~350（可用宽度被面板自己吃掉）。
  expect(dialogueBox!.width, "对话面板被右侧预留挤窄了：预留应加在满宽外层而不是面板自身").toBeGreaterThan(700);

  // 【图】背景标记 → BgLayer 离屏预载 onload 后上屏（style.backgroundImage 已设置，URL 即 marker 直服目标）。
  // v1.8 起上屏是**双层交叉淡化**：新图先挂在上层（底图仍留在下层不透明），BG_FADE_MS（600ms）后才晋级为
  // 底图、上层卸载——稳态只有一层，过渡期有两层。所以这里查**所有** bg-cover 层，断言新图确实落在其中某一层
  // 上（旧写法只读第一个 div[class*="bg-cover"]：晋级后新图挪到另一个节点上，断言就查不到了）。
  // 与过渡进度无关（新图挂上那一刻 URL 就在 style 里），因此是确定性的、不依赖采样时机。
  const bg = await page.evaluate(() => {
    const layers = Array.from(document.querySelectorAll('div[class*="bg-cover"]')).map((el) => {
      const box = el.getBoundingClientRect();
      return { url: decodeURIComponent((el as HTMLElement).style.backgroundImage), w: box.width, h: box.height };
    });
    return { viewport: { w: window.innerWidth, h: window.innerHeight }, layers };
  });
  expect(bg.layers.length, "背景层没挂上：BgLayer 结构里没有任何承载 backgroundImage 的层").toBeGreaterThan(0);
  // 每个在 DOM 里的背景层都必须带真图（空层 = 背景没应用），且都铺满视口（inset-0 回归即红）
  for (const layer of bg.layers) {
    expect(layer.url, "背景层挂着 bg-cover 却没有 backgroundImage").not.toBe("");
    expect(layer.w, `背景层没有铺满视口（宽 ${layer.w} < ${bg.viewport.w}）：inset-0/bg-cover 掉了`).toBeGreaterThanOrEqual(bg.viewport.w);
    expect(layer.h, `背景层没有铺满视口（高 ${layer.h} < ${bg.viewport.h}）：inset-0/bg-cover 掉了`).toBeGreaterThanOrEqual(bg.viewport.h);
  }
  // 新图落在**某一层**上，且只在一层上（URL 即 marker 直服目标：/img?p=images%2F2.jpg&t=背景&n=教堂&preset=demo）
  expect(
    bg.layers.filter((l) => l.url.includes("背景") && l.url.includes("教堂")).length,
    `没有任何背景层带上新图（现有层：${JSON.stringify(bg.layers.map((l) => l.url))}）`,
  ).toBe(1);

  // 主题深化（v1.7）：demo 剧本没配 theme → 兜底 serif 栈注入 --font-preset 且根容器实际消费，
  // 对话框质感落到 dialog-plain 类（CSS 里 plain 无规则=现状）
  const root = page.getByTestId("sr-status").locator("..");
  await expect(root).toHaveCSS("font-family", /Georgia/);
  expect(await root.evaluate((el) => el.style.getPropertyValue("--font-preset"))).toContain('"Songti SC"');
  await expect(page.getByTestId("dialogue-text").locator("..")).toHaveClass(/dialog-plain/);

  // ———————————— 背景换图：双层交叉淡化（v1.8）————————————
  // 第一回合只来一张背景（底图为空 → 全程只有一层），看不出交叉淡化；这里再走一回合换张背景（教堂 → 街道）。
  // 过渡只有 BG_FADE_MS=600ms，测试进程此刻去采样会抖，所以**在页面里**挂一个 MutationObserver，
  // 每次 BgLayer 子树变动就记一帧快照（每层 = 图的 URL + 该层正在跑的 stage-bg-fade 动画时长；相邻重复去重）：
  //   · 插入新图那一下（旧底图还在）必然落进过渡期 → 快照里出现「两图两层并存、其中一层正在淡入」；
  //   · 600ms 后晋级（移除上层）必然再变动一次 → 快照里出现「只剩新图一层、没有动画」。
  // 两次变动相隔 600ms，观察者不可能漏掉中间那帧——与机器快慢无关（确定性）。
  // 顺带把「淡入真的在跑、时长就是 BG_FADE_MS」钉在这里：只断言「两层并存」的话，把动画删掉的
  // 回归照样绿（两层都在，只是瞬时叠上去）。
  const recorder = await page.evaluate(() => {
    type Snap = { url: string; fade: number | null }[];
    const w = window as unknown as { __bgSnapshots: Snap[]; __bgObserved: boolean };
    w.__bgSnapshots = [];
    const snapshot = () => {
      const state: Snap = Array.from(document.querySelectorAll('div[class*="bg-cover"]')).map((el) => {
        const anim = (el.getAnimations?.() ?? []).find((a) => (a as CSSAnimation).animationName === "stage-bg-fade");
        return { url: decodeURIComponent((el as HTMLElement).style.backgroundImage), fade: anim ? Number(anim.effect?.getTiming().duration ?? 0) : null };
      });
      const key = state.map((l) => `${l.url}#${l.fade}`).join("|");
      const last = w.__bgSnapshots[w.__bgSnapshots.length - 1];
      if (!last || last.map((l) => `${l.url}#${l.fade}`).join("|") !== key) w.__bgSnapshots.push(state);
    };
    // 只看 BgLayer 子树（App 根常驻）：既能抓住层的增删与 backgroundImage 改写，又不受别处动画干扰
    const layer = document.querySelector('[data-testid="bg-layer"]');
    w.__bgObserved = !!layer;
    snapshot();
    if (layer) new MutationObserver(snapshot).observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    return { observed: w.__bgObserved, first: w.__bgSnapshots[0] ?? [] };
  });
  expect(recorder.observed, "App 根没有 [data-testid=bg-layer]：背景层结构变了，观察者没挂上去").toBe(true);
  expect(recorder.first.filter((l) => l.url.includes("教堂")).length, "第一回合的背景没在底图上（观察者起手就该看到它）").toBe(1);

  // 第二回合：点第一项选项 → 引擎换背景（教堂 → 街道）
  await page.getByTestId("options").locator("button").first().click();
  await expect(page.getByTestId("dialogue-text")).toContainText("街灯一盏一盏亮起来");
  await expect(page.getByTestId("status")).toHaveText("就绪");

  // 收尾态：**只剩一层**，且带的是新图——新图晋级、旧图退出 DOM（严格：层数与 URL 一起判，
  // 「两层都留着」「只剩旧图」「没有层」三种回归都会红），轮询到位（过渡 600ms 内自然收敛）
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('div[class*="bg-cover"]')).map((el) =>
            decodeURIComponent((el as HTMLElement).style.backgroundImage),
          ),
        ),
      { message: "过渡结束后背景层没有收敛成「只剩新图一层」" },
    )
    .toEqual([expect.stringContaining("街道")]);

  // 过渡期快照：新旧两图必须真的并存过两层，且**只有新图那层在跑淡入**（旧底图常驻不透明，靠被盖掉淡出）
  const snapshots: { url: string; fade: number | null }[][] = await page.evaluate(
    () => (window as unknown as { __bgSnapshots: { url: string; fade: number | null }[][] }).__bgSnapshots,
  );
  const crossfade = snapshots.find((s) => s.some((l) => l.url.includes("教堂")) && s.some((l) => l.url.includes("街道")));
  expect(
    crossfade,
    `换背景时没有出现「旧图 + 新图」两层并存的快照——退化成了硬切（记录到的快照：${JSON.stringify(snapshots)}）`,
  ).toBeDefined();
  expect(crossfade!.length, `过渡期应正好两层（旧底图 + 淡入中的新图），实际 ${JSON.stringify(crossfade)}`).toBe(2);
  const fading = crossfade!.filter((l) => l.fade !== null);
  expect(fading.length, `过渡期应有且只有一层在淡入，实际 ${JSON.stringify(crossfade)}`).toBe(1);
  expect(fading[0].url, "在淡入的应该是新图（旧图不淡出，被新图盖掉）").toContain("街道");
  // 时长 = BG_FADE_MS。字面量写在这里是有意的契约断言：改淡入时长就得同时改这条（别让规格与实现悄悄漂开）
  expect(fading[0].fade, "淡入动画的时长不是 BG_FADE_MS(600ms)：时长被改动了（或 CSS 动画没挂上）").toBe(600);
});
