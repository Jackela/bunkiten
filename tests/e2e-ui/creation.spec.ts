// 假引擎确定性 UI e2e（v1.10）：创作模式（src/components/CreationScreen.tsx）的浏览器级闭环——此前零覆盖。
// 两条用例各起一套栈（boot.spec.ts 同款：fake-engine 的脚本队列「每条只消费一次」，两套栈让脚本互不串味）：
//   ① 成功路径：标题屏角落簇「创作新剧本」→ 创作屏（openCreation 立刻发「创作模式：进入剧本创作。」）
//      → 对话流聊一句（引擎回复 + **行动** chip；chip 点击只填输入框）→「开始装配」→ 装配回合点亮清单
//      →【新剧本】neo →「新剧本已就绪」+《雨夜侦探》→「去选它」回标题屏 → 轮播多出新卡、ArrowRight
//      切到它、点中央卡进世界线屏（那张屏的名册是 neo 的：空态、demo 的 w1 不在）。
//   ② 失败重试：装配中途引擎回 {error}（→ SSE error）→「这次装配没能完成，可能超时了。」+「重试装配」
//      → 重试的装配回合点亮清单 →【新剧本】neo →「新剧本已就绪」。
//
// 两处非显然的设计，先说清（依据都在源码里，写在文件头免得后来人误改）：
//
// ① 装配清单的中间态为什么要用 page.route「闸」住（不是 sleep/waitForTimeout；手法与 boot.spec.ts 的
//    checking 态同源：先挂住 → 断言 → 再放行）：
//    「装 配 中」清单只在 store.assembling 为真时渲染，而 assembling 会被两条路清掉——
//      · presetAdded（src/store/slices/gameplay.ts）：【新剧本】事件同一拍置 assembling=false 并写 creationResult；
//      · 装配回合的 turn_end（同文件）：回合结束仍 assembling → assembling=false + assemblyStalled=true。
//    假引擎一个回合 = 几行 stdout 一次性写完（ops 只有 string/{tool}/{error}，没有 delay 语义），因此
//    「【图】标记点亮某项」与「上面两条清场」之间只隔一次广播——在浏览器里是毫秒级瞬态，web-first 轮询
//    断言根本追不上（要么恒红、要么靠抢时序）。所以用例把「装配。」的 POST 拦在浏览器侧**挂住**
//    （server 还没看到这回合）：面板停成确定稳态，断言全部通过后放行——放行由测试控制，不依赖任何时长
//    （测试进程与页面里都没有计时器，也就没有「机器快慢」这个变量）。
//
// ② 「剧本就绪 ✓」这一项**不可断言**（写了会恒红）：它要求 assembling 为真且 creationResult 非空，而
//    creationResult 只由 presetAdded 写入、那次 set() 同一拍就把 assembling 置 false——清单整块卸载，
//    这一行永远渲染不出来；另外两条路也进不去：装配按钮 disabled={engineBusy || !!result}、
//    重试按钮只在 stalled && !result 时渲染。本文件因此断言它的**替代态**（成功卡「新剧本已就绪」
//    +《雨夜侦探》），并把「封面 ✓ / 角色立绘 ✓（薇拉）」钉在重试那次闸住的窗口里。
//
// 观察面声明：装配清单管的是「标记到没到」（客户端 applyMarkers 点亮的布尔位），封面/立绘的**图片字节**
// 不在创作屏上（这屏不渲染任何图），所以 seed 不给 neo 备图；neo 的 preset.md 由用例在放行前补写，
// 模拟真引擎装配期落盘 presets/<id>/preset.md 的那一步——轮播里的新卡才是真的新（boot 时只有 demo 一张）。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack } from "./stack";
import { openTitleMore } from "./flow";

/** 装配产出的新剧本：id 必须与目录名一致（【新剧本】<id> → server 按它补落盘、客户端重拉 /api/presets） */
const NEO_ID = "neo";
const NEO_TITLE = "雨夜侦探";
/** 「角色立绘 ✓（…）」里的角色名 = 装配回合【图】立绘标记的名字 */
const PORTRAIT = "薇拉";
/** 玩家在创作对话里说的那句（fake-engine 按子串命中，故用整句避免误配） */
const PLAYER_LINE = "写一个雨夜的侦探故事";
/** 创作屏输入框无 testid：按 placeholder 定位（文案就是 CreationScreen 里那一行） */
const INPUT_PLACEHOLDER = "描述你想要的故事（题材、角色、基调…）";

/** 成功路径的脚本（每条 match 只消费一次，故两套栈各写一份） */
const SUCCESS_TURNS = [
  // 进创作屏的确认回合（openCreation 首发「创作模式：进入剧本创作。」）
  { match: "创作模式：", ops: ["先定题材和世界。\n", "**行动**\n1. 雨夜的侦探\n2. 深海的观测站\n"] },
  // 玩家聊一句 → 引擎回一句 + 两个 chip（chip 文案刻意不含「开始装配」，免得与那个按钮的按名定位撞车）
  {
    match: PLAYER_LINE,
    ops: ["那就雨夜。侦探得有个不肯开口的证人。\n", "**行动**\n1. 加一个不肯开口的证人\n2. 先这样，动手\n"],
  },
  // 装配回合：正文一行 + 三项协议行各占一行（一行 = 一次广播：标记点亮与【新剧本】之间才有先后可言）
  {
    match: "装配。",
    ops: [
      "剧本骨架 · 写入中\n",
      `【图】封面|${NEO_TITLE}|presets/${NEO_ID}/cover.jpg\n`,
      `【图】立绘|${PORTRAIT}|images/9.jpg\n`,
      `【新剧本】${NEO_ID}\n`,
    ],
  },
];

/** 失败重试的脚本：第一次装配「标记先到、回合后报错」，第二条「装配。」给重试回合 */
const RETRY_TURNS = [
  { match: "创作模式：", ops: ["先定题材和世界。\n"] },
  {
    match: "装配。",
    ops: [
      "剧本骨架 · 写入中\n",
      `【图】封面|${NEO_TITLE}|presets/${NEO_ID}/cover.jpg\n`,
      `【图】立绘|${PORTRAIT}|images/9.jpg\n`,
      { error: "装配超时" },
    ],
  },
  { match: "装配。", ops: [`【新剧本】${NEO_ID}\n`] },
];

/**
 * 把下一个 POST /prompt 拦在半路（既不继续也不失败）：装配面板的中间态因此是确定可观测的稳态
 * （理由见文件头 ①；手法与 tests/e2e-ui/boot.spec.ts 的 checking 态一致：先挂住 → 断言 → 再放行）。
 * @param {Page} page 目标页面
 * @returns armed()=请求真的被拦到了（避免「请求还没发出就 open」的空放行）；open()=放行。闸是一次性的：
 *   放行之后同 URL 的请求直通，免得后续回合（续玩/自由输入）也被挂住。
 */
async function holdNextPrompt(page: Page): Promise<{ armed: () => boolean; open: () => void }> {
  let armed = false;
  let released = false;
  let openNow: () => void = () => {};
  await page.route("**/prompt", async (route) => {
    if (released) {
      await route.continue();
      return;
    }
    armed = true;
    await new Promise<void>((resolve) => {
      openNow = () => resolve();
    });
    released = true;
    await route.continue();
  });
  return { armed: () => armed, open: () => openNow() };
}

/**
 * 真引擎在装配期会把新剧本落盘成 `presets/<id>/preset.md`（server 的 scanPresets 只认这个文件，
 * 缺 id/title 即丢弃、不进轮播）；假引擎不做文件系统动作，所以用例按同一形状补上这一步。
 * 写法与 tests/integration/harness.mjs 的 presetMarkdown 同形（frontmatter + 一个角色小节）。
 * @param {string} root 临时 game root（stack.stack.root）
 * @param {string} id 剧本 id（须与目录名、【新剧本】<id> 一致）
 * @param {string} title 剧本标题（进眉标/成功卡/卡带 aria-label）
 */
function writePreset(root: string, id: string, title: string): void {
  const dir = path.join(root, "presets", id);
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(
    path.join(dir, "preset.md"),
    [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      "tagline: 集成测试用剧本",
      "genre: 测试",
      "rating: 全年龄",
      "---",
      "",
      "# 主要角色",
      "",
      "## 薇拉（沉默的书记官）",
      "",
      "沉默寡言。",
      "",
    ].join("\n"),
  );
}

test("创作模式成功路径：标题屏「创作新剧本」→ 对话流与 chip → 开始装配 →【新剧本】neo 进轮播并选中", async ({
  browser,
}) => {
  const { stack, page } = await startUiStack(browser, {
    // boot 只 seed demo 一张卡：neo 是装配回合之后才进轮播的新卡（切卡器 n>1 才出现，正是下面要断言的）
    presets: [{ id: "demo", title: "示例剧本" }],
    turns: SUCCESS_TURNS,
  });
  try {
    await page.goto(stack.pageUrl);

    // —— 标题屏：/api/presets 就绪（demo 一张卡、无切卡器）、角落簇有「创作新剧本」——
    await expect(page.getByTestId("title-card-center")).toBeVisible();
    await openTitleMore(page);
    await expect(page.getByTestId("preset-export-demo")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "下一张" }),
      "轮播只有一个剧本时不该出现左右切卡按钮（n>1 才渲染）",
    ).toHaveCount(0);

    await page.getByRole("button", { name: "创作新剧本" }).click();
    await expect(page.getByTestId("creation-flow")).toBeVisible();

    // 进屏首发指令的回复进对话流（引擎气泡正文去掉选项段，「**行动**」两项渲染成 chip）
    await expect(page.getByText("先定题材和世界。")).toBeVisible();
    await expect(page.getByRole("button", { name: "雨夜的侦探" })).toBeVisible();
    await expect(page.getByRole("button", { name: "深海的观测站" })).toBeVisible();

    // —— 聊一句：Enter 发送 → 玩家气泡 + 引擎回复 + chip ——
    const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
    await input.fill(PLAYER_LINE);
    await input.press("Enter");
    await expect(page.getByText(PLAYER_LINE)).toBeVisible();
    await expect(page.getByText("那就雨夜。侦探得有个不肯开口的证人。")).toBeVisible();
    // chip 点击只把文本填进输入框、不发送（jsdom 那条契约的浏览器侧同款）
    await page.getByRole("button", { name: "加一个不肯开口的证人" }).click();
    await expect(input).toHaveValue("加一个不肯开口的证人");
    await input.fill(""); // 清掉，下一步只点「开始装配」（按钮不看输入框）

    // —— 开始装配：闸住 POST，清单停成稳态（见文件头 ①）——
    const gate = await holdNextPrompt(page);
    await page.getByRole("button", { name: "开始装配", exact: true }).click();
    await expect.poll(gate.armed, { message: "「装配。」的 POST 没被拦到（闸挂晚了？）" }).toBe(true);
    await expect(page.getByText("装 配 中")).toBeVisible();
    await expect(page.getByText("封面 · 生成中…")).toBeVisible();
    await expect(page.getByText("角色立绘 · 生成中…")).toBeVisible();
    await expect(page.getByText("剧本文件 · 写入中…")).toBeVisible();
    await expect(page.getByRole("button", { name: "装配中…" })).toBeVisible(); // 常驻按钮的文案跟着 assembling 走

    // 真引擎在这一拍把新剧本落盘（假引擎不做文件系统动作）：写好再放行，presetAdded 触发的 /api/presets
    // 重取才能把新卡带进轮播、成功卡才有《雨夜侦探》可显示
    writePreset(stack.stack.root, NEO_ID, NEO_TITLE);
    gate.open();

    // —— 装配回合：【图】标记点亮清单 →【新剧本】neo 转成功态（清单在同一拍交接给成功卡）——
    await expect(page.getByText("新剧本已就绪")).toBeVisible();
    await expect(page.getByText(`《${NEO_TITLE}》`)).toBeVisible();
    // 回合收尾：三条协议行不进对话流，非协议正文进（这一行出现即回合已结束，随后的「去选它」
    // 不会撞上回合尾巴——否则收尾那拍屏已切走，turn_end 会把这段正文当成 game 历史记一笔）
    await expect(page.getByText("剧本骨架 · 写入中")).toBeVisible();
    await page.getByRole("button", { name: "去选它" }).click();

    // —— 回标题屏：轮播多出新卡（切卡器出现 = 两张卡），ArrowRight 切过去 → 当前中央卡就是 neo ——
    await expect(page.getByTestId("title-card-center")).toBeVisible();
    await expect(page.getByTestId("title-card-center")).toHaveAttribute("aria-label", /^示例剧本 /);
    await expect(page.getByRole("button", { name: "下一张" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("title-card-center")).toHaveAttribute("aria-label", /^雨夜侦探 /);
    // 导出锚点恒指向当前中央卡：换成 neo 的 id 才说明 store.presets 真的被 presetAdded 重取刷新过
    await openTitleMore(page);
    await expect(page.getByTestId("preset-export-neo")).toBeVisible();

    // —— 能选中：点中央卡（插卡动画 ≈1s）→ 世界线屏，名册是 neo 的（空态、demo 的 w1 不在这里）——
    await page.getByTestId("title-card-center").click();
    await expect(page.getByTestId("worlds-screen")).toBeVisible();
    await expect(page.getByTestId("worlds-empty")).toBeVisible();
    await expect(page.getByTestId("world-row-w1"), "新剧本的世界线屏不该带上别的剧本的世界线").toHaveCount(0);
    await expect(page.getByTestId("shell-page")).toContainText(NEO_TITLE); // 眉标 = 新剧本标题
  } finally {
    await stopUiStack(page, stack);
  }
});

test("创作模式装配失败：引擎报错 →「这次装配没能完成」→ 重试装配点亮清单 → 新剧本就绪", async ({ browser }) => {
  const { stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    turns: RETRY_TURNS,
  });
  try {
    await page.goto(stack.pageUrl);
    await expect(page.getByTestId("title-card-center")).toBeVisible();
    await page.getByRole("button", { name: "创作新剧本" }).click();
    await expect(page.getByTestId("creation-flow")).toBeVisible();

    // —— 第一次装配：引擎在装配中途回 {error:"装配超时"}（server 转 SSE error）→
    //    onEngineError 清 assembling、置 assemblyStalled，屏上出「可重试」——
    await page.getByRole("button", { name: "开始装配", exact: true }).click();
    await expect(page.getByText("这次装配没能完成，可能超时了。")).toBeVisible();
    const retry = page.getByRole("button", { name: "重试装配" });
    await expect(retry).toBeVisible();
    await expect(retry, "出错后引擎已空闲：重试按钮不该还被「引擎忙」禁用").toBeEnabled();

    // —— 重试装配：闸住 POST（见文件头 ①），把「上一回合【图】标记点亮的清单」钉成稳态 ——
    const gate = await holdNextPrompt(page);
    await retry.click();
    await expect.poll(gate.armed, { message: "重试的「装配。」POST 没被拦到（闸挂晚了？）" }).toBe(true);
    await expect(page.getByText("装 配 中")).toBeVisible();
    await expect(page.getByText("封面 ✓")).toBeVisible();
    await expect(page.getByText(`角色立绘 ✓（${PORTRAIT}）`)).toBeVisible();
    // 【新剧本】还没到：第三项仍停在写入中（这也是「剧本就绪 ✓」不可断言的反证，见文件头 ②）
    await expect(page.getByText("剧本文件 · 写入中…")).toBeVisible();

    writePreset(stack.stack.root, NEO_ID, NEO_TITLE);
    gate.open();

    // —— 重试成功：【新剧本】neo → 成功态 ——
    await expect(page.getByText("新剧本已就绪")).toBeVisible();
    await expect(page.getByText(`《${NEO_TITLE}》`)).toBeVisible();
  } finally {
    await stopUiStack(page, stack);
  }
});
