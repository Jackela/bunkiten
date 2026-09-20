// 假引擎确定性 UI e2e（规模）：耐久/规模覆盖——回想抽屉的 60 回合长历史、剧情图 600 节点大树的大图降级与
// 图形态交互、200+ 条逐轮快照驱动的「存档点」标注与快照对比。
// 为什么单独一条 spec：ROADMAP §6 的结论是「当前规模不需要虚拟化」（画廊 300 张真实素材与剧情图 600 节点已在
// 同一时间地板），所以这里**不测性能数字**，只测「规模下功能仍然工作」——长历史照样逐条渲染且最新一幕在最上、
// 大章照样降级成可读列表且能切回图形并点得动任意节点、200 条快照索引照样驱动节点标注与 diff。
//
// 世界线的分工（三段用例共用一套栈，**必须按声明顺序跑**：workers=1 且 fullyParallel=false）：
//   · 用例一在**新世界线**上跑 60 个真回合——回想抽屉的内容来自客户端逐回合累积的 store.history
//     （不是磁盘快照，见 store/slices/gameplay.ts 的 turn_end），所以「长历史」只能靠真跑回合堆出来；
//   · 用例二/三在 seed 的 w1 上（世界线屏「继续」）——大树立在 w1：3 章 × 200 节点 = 600 节点，
//     另 seed 200 条逐轮快照（kind 混合 turn/backup，nodeId 与树第 1 章的节点 1-N 一一对应）。
//
// fake-engine 的脚本队列按「match 子串优先命中且不重复 → 否则按声明顺序顺次消费」取用
// （tests/integration/fake-engine.mjs 文件头），所以队列的排布是硬约束：
//   · 前 60 条是**纯字符串**（顺次消费）：第 1 条就是开局回合（quick_start 的开局指令），其余 59 条是玩家点
//     「继续前进」推进的回合；用例一的回合正文都带幕号，循环里拿它当「本回合收尾」的同步点；
//   · 后两条是 {match:"继续世界：w1"}：用例二/三各消费一条。纯字符串必须排在 match 条目**之前**——
//     否则用例一顺次消费的游标会先吃掉续玩应答。
//   每回合正文都带 `**行动**` 段：server 的正戏回合质量守卫在缺选项段时会补发一次内部追问
//   （server/acp-server.mjs 的 supplementMissingOptions），那会额外吃掉一条脚本、打乱上面这张账。
//
// 规模取值与取舍（N=60）：60 回合 × 假引擎秒级往返 ≈ 十几秒，60s 的 per-test timeout 留了数倍余量；不再往上加
// 是因为抽屉要验的只有「逐轮累积 + 最新在上 + 容器真能滚」三件事——60 幕（约 4560px）已经把 671px 高的滚动区
// 撑出 6 倍以上，再加回合只是线性加时间、不加覆盖。若 CI 机器更慢，把 TURNS 降到 50 仍满足同一条覆盖。
//
// 为什么推进回合用 click({ force: true })：选项按钮是 framer-motion 浮入动画（duration 0.5s，见 OptionList 的
// `transition={{ duration: 0.5, delay: min(i*0.08, 0.32) }}`），严格点击每一步都要等按钮「稳定」= 白等动画收尾，
// 58 × 0.5s ≈ 30s，60s 预算会被这堆纯等待吃满（CI 更慢就是超时）。所以：**首个回合仍走严格点击**（预检一遍
// 可见/稳定/可命中，钉住「这个按钮在这条流程里严格可点」），其余 58 次只跳过预检——force 派发的仍是同一次真实
// 鼠标点击、走的仍是同一个 onClick + sendPlayerTurn 路径，目标按钮就在 fixed 的对话坞里（不必滚动、没有遮罩）。
// 真点空了/被吞了照样会红：下一回合的正文断言（10s expect 超时）就是这次点击的判定。
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack, type UiStackOptions } from "./stack";
import { enterProtagonist, quickStartToGame } from "./flow";

/** 用例一跑多少个回合 = 回想抽屉里应该有几条 history-act（取舍见文件头） */
const TURNS = 60;
/** 推进回合点的选项文本（每回合脚本里 `**行动**` 的第一项） */
const OPTION = "继续前进";

/** 大树的规模：3 章 × 200 节点 = 600（ROADMAP §6 测过的地板），每章 10 层 × 20 列 */
const CHAPTERS = 3;
const NODES_PER_CHAPTER = 200;
/** 每层多少节点（= 每列竖链长度）：10 层 × 20 列 → 布局 2892×2008（1.44:1），1280 宽下节点约 89×32px——点得中 */
const COL_WIDTH = 20;

/** 用例三打开哪个节点：它挂着 seed 的第 57 条快照（kind=backup），基线是第 56 条（kind=turn） */
const SNAPSHOT_NODE = "1-57";
const SNAPSHOT_SEQ = 57;
const SNAPSHOT_PREV_SEQ = 56;
/** 快照条数（>200 条是这条用例的前提） */
const SNAPSHOT_COUNT = 200;
/** 快照 at 的起点：只为让时间戳递增可读（服务端排序按 seq，不看 at） */
const SNAPSHOT_EPOCH = Date.UTC(2024, 0, 1);

/**
 * 一章 200 节点：节点 id 用 `章号-序号`（`parseStoryTree` 与屏上的章号都从 id 前缀取），
 * 出边只连下一层的同列节点 —— 10 层 × 20 列的井字拓扑，分层结果确定（每列一条竖链），
 * 画布尺寸接近方屏而不是 200 层的一根细线（细线的 SVG 在 1280 宽下只有几像素高，节点点不中）。
 * @param {number} no 章号
 * @param {string} title 章标题
 * @param {{current?: boolean}} [opts] 是否写 `- 当前进度` 指针（默认章 = 带指针的那一章）
 * @returns {string[]} 树文行（`\n` 拼接交给调用方）
 */
function bigChapter(no: number, title: string, opts: { current?: boolean } = {}): string[] {
  const lines = [`## 第 ${no} 章：${title}`, `- 目标: 走完第 ${no} 章的长廊`];
  if (opts.current) lines.push(`- 当前进度: 节点 ${no}-1（已走 1 轮）`);
  lines.push("");
  const layers = NODES_PER_CHAPTER / COL_WIDTH;
  for (let i = 0; i < NODES_PER_CHAPTER; i++) {
    const id = `${no}-${i + 1}`;
    lines.push(`### 节点 ${id}（第 ${i + 1} 拍）`);
    lines.push(`- 地点: 长廊第 ${i + 1} 段`);
    lines.push("- 在场: 薇拉");
    lines.push(`- 梗概: 第 ${i + 1} 段的遭遇与抉择。`);
    if (Math.floor(i / COL_WIDTH) < layers - 1) lines.push(`- 出边: 前进 → ${no}-${i + 1 + COL_WIDTH}`);
    lines.push(`- 状态: ${i === 0 ? "已走过" : "可达"}`);
    lines.push("");
  }
  return lines;
}

/** w1 的大树：3 章 × 200 节点，进度指针在第 1 章（默认章就是它，200 > 40 → 默认降级列表） */
function bigTree(): string {
  const lines = ["# 剧情树"];
  lines.push(...bigChapter(1, "长夜回廊", { current: true }));
  lines.push(...bigChapter(2, "白昼街市"));
  lines.push(...bigChapter(3, "终章回响"));
  return lines.join("\n");
}

/**
 * 快照里的 tree 字段（200 条**全等**）：故意不放整棵大树——200 份 600 节点全文会把 seed 撑到十几 MB，
 * 而这里要钉的只是「三个文件各自独立 diff」里的「无变化」那一路。内容与大树第 1 章的开头一致（不是凭空捏的树）。
 * @returns {string} story-tree.md 全文
 */
function snapshotTree(): string {
  return [
    "# 剧情树",
    "## 第 1 章：长夜回廊",
    "- 目标: 走完第 1 章的长廊",
    "- 当前进度: 节点 1-1（已走 1 轮）",
    "",
    "### 节点 1-1（第 1 拍）",
    "- 地点: 长廊第 1 段",
    "- 状态: 已走过",
    "",
  ].join("\n");
}

/** 快照 seed 条目的类型（与 harness 的 snapshots 选项同源，避免手抄一份形状） */
type SnapshotSeedEntry = NonNullable<UiStackOptions["snapshots"]>[string][number];

/**
 * 200 条逐轮快照：seq N 挂在节点 1-N（与大树第 1 章的节点一一对应），kind 每 3 条夹一条 backup
 * （回退前的自动备份也是合法基线）。state/summary 逐条改「场景/好感度/幕号」各一行，
 * 于是第 56 → 57 条的 diff 是**算得出来的确定值**：state 换 2 行、summary 换 1 行、tree 全等。
 * @returns {SnapshotSeedEntry[]} 升序条目（harness 逐条写成 history/NNNN.json）
 */
function snapshotSeed(): SnapshotSeedEntry[] {
  const out: SnapshotSeedEntry[] = [];
  for (let seq = 1; seq <= SNAPSHOT_COUNT; seq++) {
    out.push({
      seq,
      at: new Date(SNAPSHOT_EPOCH + seq * 60_000).toISOString(),
      kind: seq % 3 === 0 ? "backup" : "turn",
      nodeId: `1-${seq}`,
      chapterNo: 1,
      files: {
        state: `# 剧情状态\n- preset: demo\n- 场景: 长廊第 ${seq} 段\n- 好感度: ${40 + seq}\n`,
        summary: `# 前情摘要（滚动）\n- 第 ${seq} 幕：走到长廊第 ${seq} 段。\n`,
        tree: snapshotTree(),
      },
    });
  }
  return out;
}

/**
 * 第 n 个回合的正文：带幕号（循环拿它当本回合的同步点）+ `**行动**` 段（缺了会被 server 的质量守卫补发追问）。
 * @param {number} n 幕号（1 起）
 * @returns {string} 引擎回放的整段文本
 */
function turnText(n: number): string {
  return `第 ${n} 幕的正文。\n\n**行动**\n1. ${OPTION}\n2. 停下\n`;
}

/** 用例二/三各一条「继续世界：w1。」的应答（正文同样必须带 `**行动**` 段） */
const RESUME_TURNS = ["续演一：雨停了，长廊尽头的灯还亮着。", "续演二：雨停了，长廊尽头的灯还亮着。"];

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    trees: { w1: bigTree() },
    snapshots: { w1: snapshotSeed() },
    turns: [
      // 用例一：纯字符串顺次消费——第 1 条就是开局回合，其余 59 条是「继续前进」的回合
      ...Array.from({ length: TURNS }, (_, i) => turnText(i + 1)),
      // 用例二/三：各一条「继续世界：w1。」（match 条目一次性消费，按需取用）
      ...RESUME_TURNS.map((body) => ({ match: "继续世界：w1", ops: [`${body}\n\n**行动**\n1. 往前走\n2. 回房\n`] })),
    ],
  }));
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

/**
 * 回想抽屉**滚动容器**的几何读数（真实浏览器才有的布局量，jsdom/单测拿不到）。
 * 抽屉里只有 header + 一个滚动区，那个滚动区没有自己的 testid——按计算样式找 overflow auto/scroll 的 div，
 * 找不到返回 null，让断言给出可读的失败信息（而不是静默拿到 0/0 假装通过）。
 * @param {Page} p 页面
 * @returns {Promise<{scrollHeight: number, clientHeight: number} | null>} 几何读数；没有滚动容器时 null
 */
async function drawerScrollMetrics(p: Page): Promise<{ scrollHeight: number; clientHeight: number } | null> {
  return p.getByTestId("history-panel").evaluate((panel) => {
    const scroller = Array.from(panel.querySelectorAll<HTMLElement>("div")).find((d) => {
      const oy = getComputedStyle(d).overflowY;
      return oy === "auto" || oy === "scroll";
    });
    return scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null;
  });
}

/** 标题屏插卡 → 世界线屏「继续」w1（大树 + 200 条快照都在它身上）→ 等 game 屏首个回合就绪 */
async function openW1(p: Page): Promise<void> {
  await p.goto(stack.pageUrl);
  const card = p.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(p.getByTestId("worlds-screen")).toBeVisible();
  await p.getByTestId("world-continue-w1").click();
  await expect(p.getByTestId("status")).toHaveText("就绪");
}

test("回想抽屉 · 60 回合长历史：逐条渲染、最新一幕在最上、滚动容器真的能滚", async () => {
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, "示例剧本");
  await quickStartToGame(page);

  // 跑满 60 个正戏回合：每回合等**该回合唯一的正文**出现（正文里带着幕号，天然区分第几回合）再点选项推进。
  // 不用 sleep、不用固定毫秒轮询：正文出现 = 该回合 turn_end 已收尾，而 store 的 history 正是在 turn_end 追加的。
  const dialogue = page.getByTestId("dialogue-text");
  const option = page.getByRole("button", { name: OPTION });
  for (let i = 1; i <= TURNS; i++) {
    await expect(dialogue).toContainText(`第 ${i} 幕的正文。`);
    if (i === TURNS) break; // 第 60 幕不用再点：这一轮只为把历史堆到 60 条
    // 首个回合走**完整 actionability 预检**（可见 + 稳定 + 可命中都真过一遍 = 选项按钮在这个流程里严格可点），
    // 其余 58 次用 force 换吞吐（理由见文件头）：点的是同一个按钮、同一条 onClick → sendPlayerTurn 路径。
    if (i === 1) await option.click();
    else await option.click({ force: true });
  }

  // 命令轨「历史」开抽屉
  await page.getByTestId("history").click();
  const panel = page.getByTestId("history-panel");
  await expect(panel).toBeVisible();

  // 一幕一条：60 回合 = 60 条（没回溯/重演，所以不会夹 history-rollback 分割行）
  await expect(panel.getByTestId("history-act")).toHaveCount(TURNS);
  await expect(panel.getByTestId("history-rollback")).toHaveCount(0);

  // 最新一幕在最上、最早一幕在底：两端都点名——只查一端的话「渲染顺序整个反了」照样绿
  await expect(panel.getByTestId("history-act").first()).toContainText(`第 ${TURNS} 幕的正文。`);
  await expect(panel.getByTestId("history-act").last()).toContainText("第 1 幕的正文。");

  // 几何断言必须真浏览器：60 条幕文把抽屉撑出视口，滚动容器 scrollHeight > clientHeight（真的能滚）
  const metrics = await drawerScrollMetrics(page);
  expect(metrics, "回想抽屉里找不到 overflow-y 容器：抽屉的滚动区没了（布局改了）").not.toBeNull();
  expect(metrics!.clientHeight, "抽屉滚动容器高度为 0：抽屉没铺满视口（inset-y-0 掉了）").toBeGreaterThan(0);
  expect(
    metrics!.scrollHeight,
    `60 幕没有把抽屉撑出可滚高度（scrollHeight ${metrics!.scrollHeight} <= clientHeight ${metrics!.clientHeight}）：` +
      "要么条目没逐条渲染，要么容器丢了 overflow-y-auto",
  ).toBeGreaterThan(metrics!.clientHeight);
});

test("剧情图 · 600 节点大树：大章默认降级列表、切图形后 200 节点全可点、缩放读数跟着走", async () => {
  await openW1(page);
  await page.getByTestId("tree").click();

  // 章节切换器列出全部 3 章；进度指针在第 1 章 → 第 1 章是选中章且带「当前」徽章，第 2 章两者都不是
  const bar = page.getByTestId("tree-chapters");
  await expect(bar).toBeVisible();
  await expect(bar.locator("button")).toHaveCount(CHAPTERS);
  const ch1 = page.getByTestId("tree-chapter-1-0");
  const ch2 = page.getByTestId("tree-chapter-2-1");
  await expect(ch1).toContainText("第 1 章 · 长夜回廊");
  await expect(ch1).toContainText("当前");
  await expect(ch1).toHaveAttribute("aria-pressed", "true");
  await expect(ch2).toHaveAttribute("aria-pressed", "false");

  // 当前章 200 节点 > 40 → 默认列表：降级提示带节点数、列表可见、SVG 画布不渲染
  await expect(page.getByTestId("tree-view-toggle")).toContainText(String(NODES_PER_CHAPTER));
  await expect(page.getByTestId("tree-view-list")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tree-list")).toBeVisible();
  await expect(page.getByTestId("tree-canvas")).toHaveCount(0);
  await expect(page.locator('[data-testid^="tree-row-"]')).toHaveCount(NODES_PER_CHAPTER);

  // 切图形：同一份节点集合换个形态画出来——数量一致 = 没被裁掉、也没重复画
  await page.getByTestId("tree-view-graph").click();
  await expect(page.getByTestId("tree-canvas")).toBeVisible();
  await expect(page.getByTestId("tree-view-graph")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tree-list")).toHaveCount(0);
  await expect(page.locator('[data-testid^="tree-node-"]')).toHaveCount(NODES_PER_CHAPTER);

  // 缩放：起手「适应」= 100%，放大一档（ZOOM_STEP 1.25）= 125%——读数跟着视图走
  await expect(page.getByTestId("tree-zoom-level")).toHaveText("100%");
  await page.getByTestId("tree-zoom-in").click();
  await expect(page.getByTestId("tree-zoom-level")).toHaveText("125%");

  // 交互不退化：选中图**中段**的节点（第 5 层最后一个，默认视口外）——只有首节点可点的话这条就红；
  // 详情里是它自己的 id 与梗概（不是邻居的数据）。
  // 走键盘路径（节点 roving tabIndex + Enter，StoryTreeScreen 文件头文档化的操作面）而不是鼠标点击：
  // 这棵树在 1280×720 下把节点滚进视口后，屏底那条输入行（tree-input）正好压住滚到底的节点——
  // 鼠标点击会被输入行吃掉（Playwright 的 hit-target 检查当场报「subtree intercepts pointer events」）。
  // 鼠标点在图形上由 story-tree.spec.ts 覆盖（小树、视口内）；这里要证的是「大图里远处节点照样到得了」，
  // 键盘路径正是为这种规模存在的入口。
  const detail = page.getByTestId("tree-detail");
  const far = page.getByTestId("tree-node-1-100");
  await far.focus();
  await page.keyboard.press("Enter");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("节点 1-100");
  await expect(detail).toContainText("第 100 段的遭遇与抉择。");

  // 切到第 2 章：模式回到自动判定（200 > 40 → 又降级列表），画布换成第 2 章的节点集合（旧章整个卸载）
  await ch2.click();
  await expect(ch2).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tree-view-list")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tree-list")).toBeVisible();
  await expect(page.getByTestId("tree-canvas")).toHaveCount(0);
  await expect(page.getByTestId("tree-row-2-1")).toBeVisible();
  await expect(page.getByTestId("tree-row-1-1")).toHaveCount(0);
  await expect(page.locator('[data-testid^="tree-row-"]')).toHaveCount(NODES_PER_CHAPTER);
});

test("剧情图 · 200 条快照：列表行与节点详情都标「存档点」，与上一档对比出确定 diff", async () => {
  await openW1(page);
  await page.getByTestId("tree").click();

  // 默认列表（第 1 章 200 节点）：挂着快照的行把幕号直接印在行上——seq 来自 /api/history 索引（200 条），不是猜的
  const row = page.getByTestId(`tree-row-${SNAPSHOT_NODE}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(`存档点 · 第 ${SNAPSHOT_SEQ} 幕`);

  // 点行开详情：同一份索引在详情里给的标注一致
  await row.click();
  await expect(page.getByTestId("tree-detail")).toBeVisible();
  await expect(page.getByTestId(`tree-snapshot-${SNAPSHOT_NODE}`)).toContainText(`存档点 · 第 ${SNAPSHOT_SEQ} 幕`);

  // 对比基线 = seq 更小的最近一条（第 56 条，kind=turn；被打开的这条是 backup——基线不限 kind）；入口点名两幕
  const open = page.getByTestId("snapshot-diff-open");
  await expect(open).toContainText(`第 ${SNAPSHOT_PREV_SEQ} 幕 → 第 ${SNAPSHOT_SEQ} 幕`);
  await open.click();

  // 三个 tab 各自 diff 三个文件：state 换 2 行、summary 换 1 行、tree 两份 seed 全等（无变化）
  const panel = page.getByTestId("snapshot-diff");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("snapshot-diff-tab-state")).toContainText("+2 −2");
  await expect(page.getByTestId("snapshot-diff-tab-summary")).toContainText("+1 −1");
  await expect(page.getByTestId("snapshot-diff-tab-tree")).toContainText("无变化");

  // 默认 tab（当前状态）的 diff 行：替换块里 remove 在 add 前（git 惯例），两条改动各自成行，
  // 上下文行不折叠（±2 行内的 equal 保留）——「自己跟上一档」而不是跟别的序号比
  await expect(panel.getByTestId("diff-row-remove")).toHaveCount(2);
  await expect(panel.getByTestId("diff-row-add")).toHaveCount(2);
  await expect(panel.getByTestId("diff-row-remove").first()).toContainText(`长廊第 ${SNAPSHOT_PREV_SEQ} 段`);
  await expect(panel.getByTestId("diff-row-add").first()).toContainText(`长廊第 ${SNAPSHOT_SEQ} 段`);
});
