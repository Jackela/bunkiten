// 界面截图（作者侧，`npm run shots`，**不进 CI**）：把 README / QUICKSTART 里要用的六张界面图重出一遍。
//
// 数据来源是仓库真货：两个真剧本（`rift-mark` 与 `twilight-throne` 的 preset.md / cover.jpg）+
// rift-mark 的真立绘与背景（`presets/rift-mark/assets/`）——所以主题配色、字体、对话框质感、卡带
// 封面都是玩家实际看到的那一套，而不是合成占位图。
//
// 确定性来自三件事：
//   ① 假引擎栈（零 token、零网络）：剧本/世界/快照/树全是 seed 进去的固定内容，回合对白写在下面；
//   ② 浏览器上下文钉 `reducedMotion: "reduce"`：打字机整段上屏、位移类动效瞬时化，不会截到半截动画；
//   ③ 视口固定 1440×900（README 里按 ~880px 宽显示，够清晰又不至于让仓库多出几 MB）。
//
// 为什么不用 tests/e2e-ui 的 flow.ts / stack.ts：那是 CI 门禁那套 spec 的内部样板（改它要连带看
// 21 个 spec），截图是作者按需跑的工具，刻意各自独立；共用的只有 tests/helpers/fake-stack.mjs 这个
// 「起栈」入口本身。
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { startFakeStack } from "../helpers/fake-stack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "docs", "images");

/** 真剧本/真素材的读取（相对 `presets/`） */
const bytes = (...rel: string[]) => readFileSync(path.join(ROOT, "presets", ...rel));
const text = (...rel: string[]) => readFileSync(path.join(ROOT, "presets", ...rel), "utf8");

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0); // 固定时间轴：世界线行的「相对时间」不会随跑的时刻变

/** 第 2 章树（rift-mark 的世界：灰雀镇线），进度指针在 2-2，带归档章示例 */
function storyTree(): string {
  return [
    "# 剧情树",
    "## 第 1 章：雨夜的账册",
    "- 目标: 弄清账册缺页的秘密",
    "",
    "### 节点 1-1（教堂门口）",
    "- 地点: 灰雀镇教堂",
    "- 在场: 薇拉",
    "- 梗概: 雨夜初遇，薇拉抱着账册站在铜灯下。",
    "- 出边: 迎上去 → 1-2；绕开 → 1-3",
    "- 状态: 已走过",
    "",
    "### 节点 1-2（中殿对话）",
    "- 地点: 教堂中殿",
    "- 在场: 薇拉、告解神父",
    "- 梗概: 从神父口中得知账册缺了一页。",
    "- 出边: 追问 → 1-3",
    "- 状态: 已走过",
    "",
    "### 节点 1-3（告解室）",
    "- 地点: 告解室",
    "- 在场: 告解神父",
    "- 梗概: 后墙的砖缝里塞着几封旧信。",
    "- 状态: 已走过",
    "",
    "## 第 2 章：围猎场的雾",
    "- 目标: 在围猎场找到刻着纹章的那块石碑",
    "- 当前进度: 节点 2-2（已走 2 轮）",
    "",
    "### 节点 2-1（镇外荒路）",
    "- 地点: 镇外荒路",
    "- 在场: 薇拉、布洛克",
    "- 梗概: 布洛克在路口等着，说要带你去个地方。",
    "- 出边: 跟上 → 2-2；拒绝 → 2-4",
    "- 状态: 已走过",
    "",
    "### 节点 2-2（林缘围猎场）",
    "- 地点: 林缘围猎场",
    "- 在场: 薇拉、布洛克、莫先生",
    "- 梗概: 雾里的脚印通向林深处，莫先生已经在等。",
    "- 出边: 追问莫先生 → 2-3",
    "- 状态: 可达",
    "",
    "### 节点 2-3（荒路营地）",
    "- 地点: 荒路营地",
    "- 在场: 莫先生",
    "- 梗概: 篝火边的交易，价码是你手腕上的印记。",
    "- 状态: 可达",
    "",
    "### 节点 2-4（废弃驿站）",
    "- 地点: 废弃驿站",
    "- 在场: 布洛克",
    "- 梗概: 独自折返的夜晚，驿站里有人留了灯。",
    "- 状态: 已剪枝",
    "",
    "## 归档",
    "- 第 0 章：序章（只保留目录信息）",
    "",
  ].join("\n");
}

/**
 * 两拍「正戏」的脚本对白（假引擎按 match 命中后逐条吐出来）。
 * 为什么拆两拍：表情切换（【立绘】<角色>|<变体>）要等这个角色**已经在场上**才生效——首现与切差分
 * 挤在同一拍里，切差分那一下会被丢掉（「先上屏、再换表情」的时序，与游戏本身无关）。
 * 第二拍让薇拉切到「微笑」并成为发言者，画面正好是「两人同屏 + 发言者带名牌」的常态。
 */
const turns = [
  {
    match: "继续世界：",
    ops: [
      "雨丝斜着扫过灰雀镇的青石板。薇拉抱着账册站在教堂前的铜灯下，布洛克把伞往她那边偏了偏，自己半边肩膀已经湿透。\n",
      "【图】背景|教堂|images/1.jpg\n",
      "【图】立绘|薇拉|images/2.jpg\n",
      "【图】立绘|布洛克|images/3.jpg\n",
      "**行动**\n1. 迎上去，问她账册缺的那一页\n2. 先看布洛克的表情，再开口\n3. 把信放在两人中间的石阶上\n",
    ],
  },
  {
    match: "迎上去",
    ops: [
      "「你来得比信上写的早了两天。」薇拉抬眼看你，指节在账册封皮上敲了一下，「那就趁雨还没停，我们把那件事说清楚。」\n",
      "【立绘】薇拉|微笑\n",
      "**行动**\n1. 把账册接过来翻到缺页那一处\n2. 先问布洛克为什么会在镇上\n",
    ],
  },
];

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
});

test("六张界面图：标题屏 / 世界线屏 / 家谱 / 游戏屏 / 剧情图 / 设置屏", async ({ browser }) => {
  const stack = await startFakeStack({
    // 两张真卡带：rift-mark 在索引 0（初始居中的那张，也是下面所有对局用的剧本），
    // twilight-throne 在右侧露出半张——把「卡带轮播」这件事本身截进画面。
    presets: ["rift-mark", "twilight-throne"],
    presetMd: {
      "rift-mark": text("rift-mark", "preset.md"),
      "twilight-throne": text("twilight-throne", "preset.md"),
    },
    covers: {
      "rift-mark": bytes("rift-mark", "cover.jpg"),
      "twilight-throne": bytes("twilight-throne", "cover.jpg"),
    },
    assets: {
      "rift-mark": [
        { name: "立绘-薇拉.jpg", bytes: bytes("rift-mark", "assets", "立绘-薇拉.jpg") },
        { name: "立绘-薇拉-微笑.jpg", bytes: bytes("rift-mark", "assets", "立绘-薇拉-微笑.jpg") },
        { name: "立绘-布洛克.jpg", bytes: bytes("rift-mark", "assets", "立绘-布洛克.jpg") },
        { name: "背景-教堂.jpg", bytes: bytes("rift-mark", "assets", "背景-灰雀镇教堂.jpg") },
        { name: "背景-围猎场.jpg", bytes: bytes("rift-mark", "assets", "背景-林缘围猎场.jpg") },
      ],
    },
    // 四条世界线：一个有血缘的家谱（两条从 1 分出、一条从 2 分出）+ 各自不同的最近游玩时间
    worlds: [
      { id: "rift-mark-1", preset: "rift-mark", label: "雨夜账册线", chapterNo: 2, lastPlayed: NOW - HOUR },
      { id: "rift-mark-2", preset: "rift-mark", label: "围猎前夜", chapterNo: 1, lastPlayed: NOW - 26 * HOUR, forkedFrom: { worldId: "rift-mark-1", nodeId: "2-1" } },
      { id: "rift-mark-3", preset: "rift-mark", label: "折返驿站", chapterNo: 1, lastPlayed: NOW - 3 * 24 * HOUR, forkedFrom: { worldId: "rift-mark-1", nodeId: "2-2" } },
      { id: "rift-mark-4", preset: "rift-mark", label: "神父的信", chapterNo: 1, lastPlayed: NOW - 5 * 24 * HOUR, forkedFrom: { worldId: "rift-mark-2", nodeId: "2-4" } },
    ],
    trees: { "rift-mark-1": storyTree(), "rift-mark-2": storyTree(), "rift-mark-3": storyTree(), "rift-mark-4": storyTree() },
    // 存档点（剧情图上的「存档点 · 第 N 幕」标注与节点详情的回退/重演入口都靠它）
    stateFiles: {
      "rift-mark-1": "# 剧情状态\n- preset: rift-mark\n- 场景: 林缘围猎场\n\n## 角色卡\n\n### 薇拉\n- 好感度: 62\n- 表情: 微笑\n- 秘密: 账册缺的那一页是她自己撕的\n\n### 布洛克\n- 好感度: 41\n- 表情: 动容\n",
    },
    snapshots: {
      "rift-mark-1": [1, 2, 3].map((seq) => ({
        seq,
        at: new Date(NOW - (4 - seq) * HOUR).toISOString(),
        kind: "turn" as const,
        nodeId: `2-${seq}`,
        chapterNo: 2,
        prompt: ["跟上他，走进雾里。", "问他石碑上刻的是什么。", "把那几封旧信拿出来。"][seq - 1],
        files: {
          state: `# 剧情状态\n- preset: rift-mark\n- 场景: 围猎场（第 ${seq} 幕）\n`,
          summary: `# 前情摘要（滚动）\n\n- 第 ${seq} 幕：雾里的脚印通向林深处。\n`,
          tree: storyTree(),
        },
      })),
    },
    turns,
  });

  const page = await (
    await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // 打字机整段上屏、位移类动效瞬时化：截图不追动画
      reducedMotion: "reduce",
    })
  ).newPage();
  const shot = (name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: "jpeg", quality: 82 });

  try {
    await page.goto(stack.pageUrl);

    // ① 标题屏：卡带轮播（左手边那张是 twilight-throne 的半张卡，右边被中心卡压着）
    await expect(page.getByTestId("title-card-center")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("title-card-center")).toContainText("裂痕纹章");
    await shot("title");

    // ② 世界线屏（列表视图：封面缩略图 + 主行动「继续」+ ⋯ 菜单）
    await page.getByTestId("title-card-center").click();
    await expect(page.getByTestId("worlds-screen")).toBeVisible();
    await expect(page.getByTestId("worlds-screen")).toContainText("雨夜账册线");
    await shot("worlds");

    // ③ 家谱视图（forkedFrom 森林 + 吸底详情条）
    await page.getByTestId("worlds-view-genealogy").click();
    await expect(page.getByTestId("genealogy-canvas")).toBeVisible();
    await page.getByTestId("genealogy-node-rift-mark-2").click();
    await shot("genealogy");

    // ④ 游戏屏：继续那条世界线 → 假引擎演一回合（背景 + 两张立绘 + 【行动】选项）
    await page.getByTestId("worlds-view-list").click();
    await page.getByTestId("worlds-resume-continue").click();
    await expect(page.getByTestId("dialogue-text")).toContainText("雨丝斜着扫过灰雀镇", { timeout: 30_000 });
    await expect(page.getByTestId("status")).toHaveText("就绪");
    await expect(page.getByTestId("portrait-figure")).toHaveCount(2);
    // 第二拍：薇拉切「微笑」差分并成为发言者（名牌归她）
    await page.getByTestId("options").locator("button").first().click();
    await expect(page.getByTestId("dialogue-text")).toContainText("你来得比信上写的早了两天");
    await expect(page.getByTestId("status")).toHaveText("就绪");
    await expect(page.getByTestId("portrait-nameplate")).toHaveText("薇拉");
    await expect(page.getByTestId("options").locator("button")).toHaveCount(2);
    // 章号过场卡（进这条世界线时亮一次，约 2.2s + 淡出）：等它散场，别让它的压暗盖住立绘
    await expect(page.getByTestId("chapter-card")).toHaveCount(0, { timeout: 10_000 });
    // 图要真的解码（否则截出来是空框）：逐张等 naturalWidth > 0
    await expect
      .poll(
        () =>
          page
            .getByTestId("portrait-figure")
            .locator("img")
            .evaluateAll((els) => els.every((el) => (el as HTMLImageElement).naturalWidth > 0)),
        { message: "立绘没有全部解码（截图会是空框）" },
      )
      .toBe(true);
    await shot("game");

    // ⑤ 剧情图：图鉴 ▾ → 剧情图，选中一个带存档点的节点（右栏详情 + 「存档点 · 第 N 幕」）
    await page.getByTestId("rail-collection").click();
    await page.getByTestId("tree").click();
    await expect(page.getByTestId("tree-canvas")).toBeVisible();
    await expect(page.getByTestId("tree-chapters")).toBeVisible();
    await page.getByTestId("tree-canvas").getByRole("button", { name: /2-2/ }).first().click();
    await expect(page.getByTestId("tree-detail")).toBeVisible();
    await shot("tree");

    // ⑥ 设置屏：引擎与密钥（引擎选择 + 服务目录 + 两组密钥表单）
    await page.getByTestId("tree-back").click();
    await page.getByTestId("settings").click();
    await expect(page.getByTestId("settings-screen")).toBeVisible();
    if ((await page.getByTestId("settings-advanced-toggle").getAttribute("aria-expanded")) !== "true") {
      await page.getByTestId("settings-advanced-toggle").click();
    }
    await expect(page.getByTestId("engine-keys")).toBeVisible();
    // 等凭据视图真回来：先出现的是「引擎选择 + 登录状态」，那时两组密钥表单才在（否则截到加载态）
    await expect(page.getByTestId("engine-backend-grok")).toBeVisible();
    await expect(page.getByTestId("engine-llm-mode-session")).toBeVisible();
    await shot("settings");
  } finally {
    await page.close().catch(() => {});
    await stack.stop();
  }
});
