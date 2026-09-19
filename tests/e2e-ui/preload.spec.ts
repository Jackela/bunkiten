// 假引擎确定性 UI e2e ⑨（v1.8 补）：立绘差分预载（src/lib/preload.ts）的浏览器级可观测面。
// node 侧（tests/preload.test.ts）验的是「模块内按 preset 记忆 promise」，浏览器里能观测到的是**网络**，
// 所以本用例只钉两条可观测契约：
//   1. **同一会话内 /api/assets 只拉一次**（preset 级缓存）：开局第一张立绘上屏后恰好 1 条；
//      同一角色连切两次差分（微笑 → 伤感）仍 1 条；**再让第二个角色上场**还是 1 条。
//      最后这一步是承重断言：换差分只改 portraits[i].variant，PortraitLayer 预热 effect 的依赖
//      （presetId + 角色名指纹）不变、**根本不会重跑**，所以单靠「同角色两次上屏」测不出清单缓存；
//      第二个角色让指纹从「薇拉」变成「薇拉␀沈屿」→ effect 真的重跑 → 对既有角色再调一次
//      warmPortraitVariants（外加新角色一次），此时还只有 1 条请求，才说明缓存拦住了重复拉取
//      （去掉 preload.ts 的 assetIndex，这两次调用会各自再发一条 → 计数立刻变 3）。
//   2. **预热真的发生**（否则「没有第二次请求」也可能只是预热路径压根没跑）：
//      · 第一张立绘上屏后（任何【立绘】标记之前）就该有 /img?p=presets/demo/assets/立绘-薇拉-微笑.jpg
//        与 …立绘-薇拉-伤感.jpg 的 200——这两张图此刻画面上没人引用，请求只可能来自预载；
//      · 第二个角色上场后同理出现 …立绘-沈屿.jpg（该 URL 与【图】标记的 /img?p=images/4.jpg 不同，
//        同样只可能来自预载——「这个角色的全部立绘都进缓存」这条语义的证据）。
//      并且在切差分后立绘仍要 naturalWidth>0（真解码，不是回退基础图/404）。
// 夹具：假引擎 + 真 acp-server + vite（tests/e2e-ui/stack.ts），assets seed 四张图（字节复用仓库现成素材）；
// 不点画廊：AssetsScreen 自己会 fetchAssets（另一条路径、另一个家），本用例只覆盖演出路径的清单缓存。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, quickStartToGame } from "./flow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_ASSETS = path.join(ROOT, "presets", "rift-mark", "assets");
/** 复用仓库现成素材的字节（内容不参与断言，但必须是真图：naturalWidth>0 才算「真的画出来了」） */
const asset = (file: string): Buffer => readFileSync(path.join(SRC_ASSETS, file));

/** 立绘层里的一张图：角色名（alt）+ 解码后的 src + 真实解码宽度 */
interface PortraitImg {
  alt: string;
  src: string;
  w: number;
}

/** GET /api/assets 的调用（`METHOD path?query`，按发生顺序）；监听器在 page.goto 之前挂 */
let assetCalls: string[] = [];
/** /img 请求的 ?p= 落盘路径（解码后）→ 响应状态；预载（new Image）发起的请求同样落在这里 */
let imgStatus = new Map<string, number>();

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    // 基础图 + 两个差分（微笑/伤感）都必须**已落盘**：/api/assets 只列磁盘上真实存在的文件，
    // 预载正是按这份清单把该角色的全部差分塞进缓存；缺一张，那条 /img 就不会出现。
    assets: {
      demo: [
        { name: "立绘-薇拉.jpg", bytes: asset("立绘-薇拉.jpg") },
        { name: "立绘-薇拉-微笑.jpg", bytes: asset("立绘-薇拉-微笑.jpg") },
        { name: "立绘-薇拉-伤感.jpg", bytes: asset("立绘-薇拉-伤感.jpg") },
        { name: "立绘-沈屿.jpg", bytes: asset("立绘-阿澈.jpg") },
      ],
    },
    turns: [
      {
        // 开局：薇拉上场（基础立绘）——预热 effect 首次跑，拉清单 + 预热她的全部差分
        match: "开局：",
        ops: [
          "雨声漫过教堂的尖顶，薇拉抱着账册站在门口，没有看你。\n",
          "【图】立绘|薇拉|images/1.jpg\n",
          "**行动**\n1. 让她笑一下\n2. 让她别过脸去\n3. 招呼沈屿进来\n",
        ],
      },
      {
        // 同一角色第一次换差分（微笑）：PortraitLayer 的指纹没变 → 预热 effect 不重跑
        match: "让她笑一下",
        ops: ["薇拉弯了弯眼睛。\n", "【立绘】薇拉|微笑\n", "**行动**\n1. 让她别过脸去\n2. 招呼沈屿进来\n"],
      },
      {
        // 同一角色第二次换差分（伤感）
        match: "让她别过脸去",
        ops: ["她把脸转向雨幕。\n", "【立绘】薇拉|伤感\n", "**行动**\n1. 招呼沈屿进来\n"],
      },
      {
        // 第二个角色上场：角色名指纹变化 → 预热 effect **真的重跑**（承重断言那一步，见文件头）
        match: "招呼沈屿进来",
        ops: ["门口的伞收了。\n", "【图】立绘|沈屿|images/4.jpg\n"],
      },
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/** 立绘层里所有 <img>：解码后 src + 真实解码宽度（naturalWidth>0 = 真解码，不是 404/回退基础图） */
const portraitImgs = (): Promise<PortraitImg[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="portrait-figure"] img')).map((node) => {
      const el = node as HTMLImageElement;
      return {
        alt: el.getAttribute("alt") ?? "",
        src: decodeURIComponent(el.getAttribute("src") ?? ""),
        w: el.naturalWidth,
      };
    }),
  );

/** 等到「某张立绘满足 hit 且真的解码出宽」——上屏与真解码的双重断言 */
async function expectPortrait(why: string, hit: (i: PortraitImg) => boolean): Promise<void> {
  await expect.poll(async () => (await portraitImgs()).filter(hit).length, { message: why }).toBeGreaterThan(0);
}

/** 预载发起的 /img 请求（落盘路径 → 状态）；只有 200 才算「真的塞进了缓存」 */
const imgStatusOf = (file: string): number => imgStatus.get(`presets/demo/assets/${file}`) ?? 0;

test("立绘预载：同角色第二次上屏不再拉清单（会话内 /api/assets 只 1 次），差分照常上屏", async () => {
  assetCalls = [];
  imgStatus = new Map();
  page.on("request", (req) => {
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return; // data:/blob: 之类，与本用例无关
    }
    if (url.pathname === "/api/assets") assetCalls.push(`${req.method()} ${url.pathname}${url.search}`);
  });
  page.on("response", (res) => {
    let url: URL;
    try {
      url = new URL(res.url());
    } catch {
      return;
    }
    if (url.pathname !== "/img") return;
    imgStatus.set(decodeURIComponent(url.searchParams.get("p") ?? ""), res.status());
  });

  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // ① 薇拉上屏（基础立绘）：/img?p=images/1.jpg 走标记 URL，真实解码
  await expectPortrait("薇拉的基础立绘没有上屏/解码", (i) => i.alt === "薇拉" && i.w > 0);

  // ② 预热已经发生，且清单只拉了一次——此刻**任何【立绘】标记都还没发**，两张差分图的 200
  //    只能在预载路径上产生（画面上没人引用它们）
  await expect.poll(() => imgStatusOf("立绘-薇拉-微笑.jpg"), {
    message: "第一张立绘上屏后，预载没有把 薇拉·微笑 的差分塞进缓存（/img 200）",
  }).toBe(200);
  await expect.poll(() => imgStatusOf("立绘-薇拉-伤感.jpg"), {
    message: "第一张立绘上屏后，预载没有把 薇拉·伤感 的差分塞进缓存（/img 200）",
  }).toBe(200);
  expect(assetCalls, "第一张立绘上屏后清单应当正好被拉过一次").toHaveLength(1);
  expect(assetCalls[0], "清单请求没带当前剧本（preload 按 preset 记账，preset 必须随请求带上）").toBe(
    "GET /api/assets?preset=demo",
  );

  // —— 同一角色第二次上屏（换差分）：不再拉清单，且差分照常上屏 ——
  await page.getByTestId("options").locator("button").first().click(); // 让她笑一下 → 【立绘】薇拉|微笑
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expectPortrait("薇拉·微笑 差分没有上屏/解码", (i) => i.src.includes("立绘-薇拉-微笑.jpg") && i.w > 0);
  expect(assetCalls, "第二次显示同一角色（换差分到微笑）又拉了一次清单").toHaveLength(1);

  // —— 同一角色第三次上屏（再换一次差分）——
  await page.getByTestId("options").locator("button").first().click(); // 让她别过脸去 → 【立绘】薇拉|伤感
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expectPortrait("薇拉·伤感 差分没有上屏/解码", (i) => i.src.includes("立绘-薇拉-伤感.jpg") && i.w > 0);
  expect(assetCalls, "第三次显示同一角色（换差分到伤感）又拉了一次清单").toHaveLength(1);

  // —— 第二个角色上场：角色名指纹变化 → 预热 effect 真的重跑（对薇拉再调一次 warmPortraitVariants）——
  await page.getByTestId("options").locator("button").first().click(); // 招呼沈屿进来 → 【图】立绘|沈屿
  await expect(page.getByTestId("status")).toHaveText("就绪");
  await expectPortrait("沈屿的立绘没有上屏/解码", (i) => i.alt === "沈屿" && i.w > 0);
  // 新角色的差分预热同样发生（这条 /img 与【图】标记的 images/4.jpg 是两个 URL，只能来自预载）
  await expect.poll(() => imgStatusOf("立绘-沈屿.jpg"), {
    message: "第二个角色上场后，预载没有预热他的立绘（/img 200）",
  }).toBe(200);

  // 收口：整个会话（三次同角色上屏 + 一次新角色上屏）只有开局那一次清单请求
  expect(
    assetCalls,
    `同一会话里 /api/assets 只该被拉一次（preload.ts 的 preset 级 promise 缓存），实际：${JSON.stringify(assetCalls)}`,
  ).toHaveLength(1);
});
