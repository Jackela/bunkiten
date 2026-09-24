// 假引擎确定性 UI e2e ⑥：世界线屏管理动作——改名（label，入口在行的 ⋯ 菜单）、导出 .world.json（浏览器下载）、
// 导入同一文件（server 重名加 -2 后缀）、两段确认删除副本；v1.7 家谱视图（forkedFrom 森林）。
// 导出内容断言 format:"bunkiten-world" / worldId / title / label；导入文件落在 test-results-ui/ 下。
// v1.8 补三条：① 家谱画布的缩放/适应读数与 viewBox（工具条提示行的可见性一并钉住——它当初就是为了
// 不被画布顶到屏脚才挪进工具条的）；② 行 ⋯ 菜单的**纯键盘**路径（Enter 开 → Tab 走项 → Esc 只收菜单、
// 不退屏 → 重开时半截删除确认已复位）；③ 导出包的血缘（forkedFrom + fork.md 随包走，导入回来的
// 分叉线在家谱里仍是子节点）——**两次导入都走应用内的「导入」按钮**（v1.13 起客户端 parseWorldBundle
// 的版本闸只要求正整数，v2/v3 包不再被本地挡下；以前 v2 包得绕真服务端 HTTP，见 docs/adr/0023）。
// v1.9 补一条：行缩略图（ROADMAP §5）——两个剧本把两态摆在一起：demo 有 cover.jpg（手写真 jpg）、
// no-cover 没有（本仓多数 preset 的常态）。断言「有封面时图真的解码上屏、src 是封面契约路径」、
// 「缩略图不吃行的点击」、「没封面时图被 404 摘掉、只剩同尺寸占位块、行高逐像素不变」。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** w3 的分叉说明（与 server 的 forkNote 同形状；引擎首个回合处理完才会删掉这个文件） */
const FORK_MD_W3 = "# 分叉说明\n- 来源世界: w2\n- 分叉节点: 1-1\n- 分叉时间: 2026-01-01T00:00:00.000Z\n";

/** 导出包的读取形状（用例只点名它断言的字段；两个血缘键在 v1 包里不存在，所以可选） */
interface Bundle {
  format: string;
  version: number;
  world: {
    worldId: string;
    title: string;
    label: string;
    forkedFrom?: unknown;
    forkMd?: string | null;
  };
}

let stack: StartedStack;
let page: Page;

/** 封面 URL（`/img?p=<相对路径>` 的 p 参数，已解码）→ 最近一次响应状态；行缩略图用例读它钉 200/404 */
const coverStatuses = new Map<string, number>();

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    // 两个剧本：demo 有 cover.jpg（下面手写）、no-cover 没有——行缩略图的两态就摆在这两张卡上。
    // id 刻意排在 demo 之后：scanPresets 按目录名排序，本文件其余用例「直接点 title-card-center」的
    // 假设仍是 demo 在中央（no-cover 的用例自己用方向键切过去）
    presets: [
      { id: "demo", title: "示例剧本" },
      { id: "no-cover", title: "无封面剧本" },
    ],
    // w1 默认存在；w3 分叉自 w2（父子连线），w4 指向不存在的 ghost（孤儿 ⌫）；管理动作不推演，无需 turns。
    // w5 属 no-cover 剧本（世界线屏的清单按 selected 过滤，它只在那张卡的屏上出现）
    worlds: [
      { id: "w2" },
      { id: "w3", forkedFrom: { worldId: "w2", nodeId: "1-1" } },
      { id: "w4", forkedFrom: { worldId: "ghost", nodeId: "9-9" } },
      { id: "w5", preset: "no-cover", title: "无封面剧本", lastPlayed: 1_600_000_000_000 },
    ],
  }));
  // w3 补一份 fork.md（forkWorld 落盘的同名文件）：导出包要能把它带走、导入侧要原样落回来
  writeFileSync(path.join(stack.stack.root, "state", "worlds", "w3", "fork.md"), FORK_MD_W3);
  // demo 的封面按契约在 preset 根（harness 的 assets 落在 assets/ 子目录），单独手放一份**真 jpg**：
  // 行缩略图靠 onError 兜 404，而 presets.spec 那种手造字节（0xFFD8 + 文本）本身就不是能解码的图，
  // 会被判成加载失败——本用例要断言的正是「有封面时图真的解码上屏」，故字节复用仓内现成封面
  // （tests/e2e-ui/gallery.spec.ts 的 rift() 同法）
  writeFileSync(
    path.join(stack.stack.root, "presets", "demo", "cover.jpg"),
    readFileSync(path.join(ROOT, "presets", "rift-mark", "cover.jpg")),
  );
  // 封面请求的状态记录：标题屏卡面与行缩略图打的是同一条 `/img?p=presets/<id>/cover.jpg`，
  // 缩略图用例据此断言「有封面 = 200、没封面 = 404」——否则「DOM 里没有 <img>」也可能只是图从没请求过
  page.on("response", (r) => {
    const url = new URL(r.url());
    const p = url.pathname === "/img" ? (url.searchParams.get("p") ?? "") : "";
    if (p.endsWith("cover.jpg")) coverStatuses.set(p, r.status());
  });
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("世界线管理：行内改名→导出→导入出重名副本 w2-2→两段确认删除副本", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 初始两条世界线（w1 默认 + seed 的 w2），行按 worldId 点名
  await expect(page.getByTestId("world-row-w1")).toBeVisible();
  await expect(page.getByTestId("world-row-w2")).toBeVisible();

  // —— 改名：行尾 ⋯ 菜单 →「改名」→ 行内编辑器展开 → 填显示名 → 保存 → 列表以服务端落定值回显 ——
  // v1.7：改名/导出/删除都收进了行尾的 world-menu-* 菜单，菜单项在菜单打开前不在 DOM 里
  await page.getByTestId("world-menu-w2").click();
  await page.getByTestId("world-edit-w2").click();
  await expect(page.getByTestId("world-editor-w2")).toBeVisible();
  await page.getByTestId("world-edit-label-w2").fill("回廊之影");
  await page.getByTestId("world-edit-save-w2").click();
  await expect(page.getByTestId("world-editor-w2")).toHaveCount(0);
  await expect(page.getByTestId("world-row-w2")).toContainText("回廊之影");

  // —— 导出：⋯ 菜单里的 anchor 触发浏览器下载（Content-Disposition attachment），存到 test-results-ui/ ——
  await page.getByTestId("world-menu-w2").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("world-export-w2").click()]);
  const outDir = path.join(ROOT, "test-results-ui");
  mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, "w2-export.world.json");
  await download.saveAs(bundlePath);

  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Bundle;
  expect(bundle.format).toBe("bunkiten-world");
  expect(bundle.version).toBe(3); // v1.13：v3 包（v2 多两个血缘键之外，快照条目多一个 prompt）
  expect(bundle.world.worldId).toBe("w2");
  expect(bundle.world.title).toBe("示例剧本");
  expect(bundle.world.label).toBe("回廊之影");
  // w2 是根世界：两个血缘键都在、值都是 null（缺键与 null 是两种意思，v1 包才是「缺键」）
  expect(bundle.world.forkedFrom).toBe(null);
  expect(bundle.world.forkMd).toBe(null);

  // —— 导入：刚导出的包直接走应用内的「导入」按钮（v1.13 起版本闸只要求正整数，v3 包不被本地挡下）——
  await page.getByTestId("worlds-import-input").setInputFiles(bundlePath);
  await expect(page.getByTestId("worlds-notice")).toContainText("w2-2"); // w2 已被占用 → server 落成 w2-2
  await expect(page.getByTestId("world-row-w2-2")).toBeVisible();
  await expect(page.getByTestId("world-row-w2-2")).toContainText("回廊之影"); // label 随包迁移
  // w2 是根世界（forkMd = null）：导入侧不许凭空造一份 fork.md（否则引擎首个回合会读到一份空指令）
  expect(existsSync(path.join(stack.stack.root, "state", "worlds", "w2-2", "fork.md"))).toBe(false);

  // —— 两段确认删除副本：⋯ 菜单首点「删除」变确认按钮，二点才发；删除后原件仍在 ——
  await page.getByTestId("world-menu-w2-2").click();
  await page.getByTestId("world-delete-w2-2").click();
  await page.getByTestId("world-confirm-w2-2").click();
  await expect(page.getByTestId("world-row-w2-2")).toHaveCount(0);
  await expect(page.getByTestId("world-row-w2")).toBeVisible();
  await expect(page.getByTestId("world-row-w1")).toBeVisible();

  // v1.7 回收站：删除的世界整体进了 state/trash/<ts>-<rand4>-w2-2/（node 侧点验临时 game root）
  const trashDir = path.join(stack.stack.root, "state", "trash");
  expect(readdirSync(trashDir).filter((f) => f.endsWith("-w2-2")).length).toBe(1);

  // —— 分叉世界的包：血缘与 fork.md 随包走 ——（w3 分叉自 w2@1-1，磁盘上有一份 fork.md）
  // 包从导出端点取（node 侧 HTTP，与浏览器里那个 `<a download>` 打的是同一个路由——下载路径本身
  // 已由 w2 那一步钉住）。刻意不做第二次浏览器下载：这条断言要证的是「血缘与 fork.md 活过导出→导入，
  // 且家谱把导入回来的分叉线画在父线下面」，那半段只有浏览器能证；再叠一个下载只增加等待面。
  const forkExport = await stack.stack.getJSON("/api/worlds/export?worldId=w3");
  expect(forkExport.status).toBe(200);
  expect(forkExport.headers.get("content-disposition")).toBe('attachment; filename="w3.world.json"'); // 下载文件名行为不变
  const forkBundle = forkExport.body as Bundle;
  expect(forkBundle.format).toBe("bunkiten-world");
  expect(forkBundle.version).toBe(3);
  expect(forkBundle.world.worldId).toBe("w3");
  expect(forkBundle.world.forkedFrom).toEqual({ worldId: "w2", nodeId: "1-1" }); // v1 包在这里是 null（= 根）
  expect(forkBundle.world.forkMd).toBe(FORK_MD_W3); // 逐字（含分叉时间那一行）

  // —— 导入 v3 包（分叉世界）：同样走应用内的「导入」按钮，浏览器自己走完整条路 ——
  const forkPath = path.join(outDir, "w3-export.world.json");
  writeFileSync(forkPath, JSON.stringify(forkBundle, null, 2));
  await page.getByTestId("worlds-import-input").setInputFiles(forkPath);
  await expect(page.getByTestId("worlds-notice")).toContainText("w3-2"); // 重名后缀
  expect(readFileSync(path.join(stack.stack.root, "state", "worlds", "w3-2", "fork.md"), "utf8")).toBe(FORK_MD_W3); // 原样落盘

  // 家谱面：导入回来的 w3-2 仍挂在 w2 下（家谱只认 forkedFrom——v1 包的病灶就是这条线丢了）
  await page.reload();
  await expect(page.getByTestId("title-card-center")).toBeVisible();
  await page.getByTestId("title-card-center").click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await page.getByTestId("worlds-view-genealogy").click();
  await expect(page.getByTestId("genealogy-canvas")).toBeVisible();
  await expect(page.getByTestId("genealogy-node-w3-2")).toBeVisible();
  await expect(page.getByTestId("genealogy-node-w3-2")).not.toContainText("⌫"); // 不是孤儿：父线找得到
  // 两条连线：w2→w3 与 w2→w3-2（v1 包在这里会变成两条根 + 一条连线）
  await expect(page.getByTestId("genealogy-canvas").locator(".genealogy-edge")).toHaveCount(2);

  // 收尾：删掉副本，后续用例的家谱计数（4 节点 / 1 连线）才成立
  expect((await stack.stack.postJSON("/api/worlds", { action: "delete", worldId: "w3-2" })).status).toBe(200);

  // 捏人屏不是死路：「新世界线」进去后「返回」回世界线屏，世界牌面（列表）照旧还在
  await page.getByTestId("worlds-view-list").click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await page.getByTestId("worlds-new").click();
  await expect(page.getByTestId("protagonist-screen")).toBeVisible();
  await page.getByTestId("protagonist-back").click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await expect(page.getByTestId("world-row-w2")).toBeVisible();
});

test("家谱视图：forkedFrom 链画成森林，点节点出快捷条，孤儿标 ⌫", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  // 切到家谱：四个节点（w1/w2 根、w3 分叉自 w2、w4 孤儿），一条父子连线（w2→w3）
  await page.getByTestId("worlds-view-genealogy").click();
  const canvas = page.getByTestId("genealogy-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("genealogy-node-w1")).toBeVisible();
  await expect(page.getByTestId("genealogy-node-w2")).toBeVisible();
  await expect(page.getByTestId("genealogy-node-w3")).toBeVisible();
  await expect(page.getByTestId("genealogy-node-w4")).toBeVisible();
  await expect(canvas.locator(".genealogy-edge")).toHaveCount(1);

  // 孤儿：父线已删徽章在节点上
  await expect(page.getByTestId("genealogy-node-w4")).toContainText("⌫");

  // 点节点出快捷条（含分叉血缘），「继续」按钮在快捷条里
  await page.getByTestId("genealogy-node-w3").click();
  const detail = page.getByTestId("genealogy-detail");
  await expect(detail).toBeVisible();
  // 血缘说明换成「自《父线显示名》延伸」——父线 w2 在本文件的前一用例里已改名为「回廊之影」，
  // 这里显示的正是那个显示名（label 优先于剧本名；单独跑本用例时父线还没改名，会是「示例剧本」）。
  // 旧的「分叉自 w2 @ 1-1」把裸 worldId/节点号摊给玩家，现在一个字都不该出现
  await expect(detail).toContainText("自《回廊之影》延伸");
  await expect(detail).not.toContainText("分叉自");
  await expect(page.getByTestId("genealogy-continue-w3")).toBeVisible();

  // 「查看」跳回列表视图并聚焦对应行
  await page.getByTestId("genealogy-view-w3").click();
  await expect(page.getByTestId("genealogy-canvas")).toHaveCount(0);
  await expect(page.getByTestId("world-row-w3")).toBeVisible();
  await expect(page.getByTestId("world-row-w3")).toBeFocused();
});

test("家谱缩放：100% 起手 → 放大 125%（viewBox 变窄）→ 适应回 fit，提示行在画布工具条里", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();

  await page.getByTestId("worlds-view-genealogy").click();
  const canvas = page.getByTestId("genealogy-canvas");
  await expect(canvas).toBeVisible();
  const level = page.getByTestId("genealogy-zoom-level");
  // 起手 = 适应档（fitView 的 zoom 1 → 100%）
  await expect(level).toHaveText("100%");
  const fitVb = (await canvas.getAttribute("viewBox"))!;
  const fitW = Number(fitVb.split(/\s+/)[2]);

  // 放大一档（GEN_ZOOM_STEP=1.25）：读数与视图一起变——viewBox 是布局坐标，视野必须变窄
  await page.getByTestId("genealogy-zoom-in").click();
  await expect(level).toHaveText("125%");
  const zoomedVb = (await canvas.getAttribute("viewBox"))!;
  expect(Number(zoomedVb.split(/\s+/)[2]), `放大后 viewBox 视野没变窄（${fitVb} → ${zoomedVb}）`).toBeLessThan(fitW);

  // 适应：回到起手那一档——逐字同一个 viewBox（不是「随便一个小一点的值」）
  await page.getByTestId("genealogy-zoom-fit").click();
  await expect(level).toHaveText("100%");
  await expect.poll(async () => canvas.getAttribute("viewBox")).toBe(fitVb);

  // 工具条按钮与 `+ / 0` 键等价：焦点还在刚点过的「适应」按钮上（在画布包裹层内），按键冒泡到容器处理
  await page.keyboard.press("+");
  await expect(level).toHaveText("125%");
  await page.keyboard.press("0");
  await expect(level).toHaveText("100%");

  // 提示行落在画布工具条内：是 genealogy-canvas-wrap 的后代、排在画布**之上**（不是被顶到屏脚），
  // 且 1280×720 下不滚动就完整可见——「画布高时提示被顶到折叠线以下」正是它挪进工具条的原因
  const hint = page.getByTestId("genealogy-canvas-wrap").getByText("滚轮缩放");
  await expect(hint).toBeVisible();
  const viewport = page.viewportSize()!;
  const hintBox = (await hint.boundingBox())!;
  const canvasBox = (await canvas.boundingBox())!;
  expect(hintBox.y + hintBox.height, "提示行不在画布之上：被排到了画布下方").toBeLessThanOrEqual(canvasBox.y);
  expect(hintBox.y, `提示行顶边 ${hintBox.y} 在视口上沿之外`).toBeGreaterThanOrEqual(0);
  expect(
    hintBox.y + hintBox.height,
    `提示行底边 ${hintBox.y + hintBox.height} 越过视口下沿 ${viewport.height}（要滚动才看得到）`,
  ).toBeLessThanOrEqual(viewport.height);
});

test("⋯ 菜单键盘路径：Enter 开、Tab 走项、Esc 只收菜单不退屏、重开时删除确认已复位", async () => {
  await page.goto(stack.pageUrl);
  const card = page.getByTestId("title-card-center");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await expect(page.getByTestId("world-row-w1")).toBeVisible();

  // 全键盘打开：焦点落到行尾 ⋯ 上，Enter 激活（不点鼠标）
  const trigger = page.getByTestId("world-menu-w1");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByTestId("world-menu-popup-w1");
  await expect(popup).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // 打开即把焦点送进第一项（改名）
  await expect(page.getByTestId("world-edit-w1")).toBeFocused();

  // Tab 走位：改名 → 导出（role=menuitem 的 <a>）→ 删除
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("world-export-w1")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("world-delete-w1")).toBeFocused();

  // 两段确认的第一段：Enter 把「删除」换成确认按钮，焦点跟着换到确认按钮上
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("world-confirm-w1")).toBeVisible();
  await expect(page.getByTestId("world-confirm-w1")).toBeFocused();

  // Esc 只收菜单：焦点回触发器、aria-expanded 复位，世界线屏（行清单）照旧在——
  // 那一下绝不能冒到 App 的 Esc 关闭链把玩家连带送回标题屏
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await expect(page.getByTestId("world-row-w1")).toBeVisible();
  await expect(page.getByTestId("title-card-center")).toHaveCount(0);

  // 重开（焦点已在触发器上）：半截删除确认必须已复位——首项回到「改名」，确认按钮不在
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("world-confirm-w1")).toHaveCount(0);
  await expect(page.getByTestId("world-edit-w1")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

/**
 * 标题屏轮播切到指定剧本（`title-card-center` 只有中央那张卡有 testid，故按卡面 aria-label 认卡）。
 * 起点是 scanPresets 的目录名排序（本文件里 demo 在 no-cover 之前），但不假定谁在中央：
 * 两个剧本时方向键一步即到，切完断言中央卡确实是目标——认错卡当场失败，不会静默跑到别的剧本上。
 * @param {string} title 剧本标题（卡面 aria-label 的前缀）
 */
async function centerOnPreset(title: string): Promise<void> {
  const center = page.getByTestId("title-card-center");
  await expect(center).toBeVisible();
  if ((await center.getAttribute("aria-label"))?.startsWith(title)) return;
  await page.keyboard.press("ArrowRight");
  await expect(center).toHaveAttribute("aria-label", new RegExp(`^${title}`));
}

/**
 * 在页面里挂一个 MutationObserver，记录 `[data-testid^="world-cover-img-"]` 的挂载/摘除
 * （`tests/e2e-ui/opening.spec.ts` 用同款手法抓跨帧的中继态）。
 * 用途：缩略图 404 用例要证明图**挂上过**又被摘掉——只看最终 DOM 会把「压根没渲染 <img>」
 * （另一种 bug）也算通过，那是空断言。
 */
async function watchCoverImg(): Promise<void> {
  await page.evaluate(() => {
    const trace: string[] = [];
    (window as unknown as { __coverTrace: string[] }).__coverTrace = trace;
    const hits = (nodes: NodeList): HTMLElement[] =>
      Array.from(nodes).flatMap((n) => {
        if (!(n instanceof HTMLElement)) return [];
        const self = n.matches('[data-testid^="world-cover-img-"]') ? [n] : [];
        return [...self, ...Array.from(n.querySelectorAll<HTMLElement>('[data-testid^="world-cover-img-"]'))];
      });
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const el of hits(rec.addedNodes)) trace.push(`add:${el.dataset.testid}`);
        for (const el of hits(rec.removedNodes)) trace.push(`remove:${el.dataset.testid}`);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * 布局量的「同尺寸」比较：**不能用 toBe/toEqual 精确相等**——boundingBox() 来自
 * getBoundingClientRect，缩放/抗锯齿下会带 ~1e-5 的浮点抖动（CI 实测：缺封面的行高
 * 73.50001525878906 vs 有封面的 73.5，一次全量跑就红在这条上）。
 * 容差 0.01px：真实回归（少一行文字、缩略图把行撑高）至少差 1px 量级，照样能红。
 */
function expectSamePx(actual: number, expected: number, what: string): void {
  expect(
    Math.abs(actual - expected),
    `${what}：实测 ${actual}、基准 ${expected}（相差 ${Math.abs(actual - expected)}px）`,
  ).toBeLessThan(0.01);
}

// 行缩略图（ROADMAP §5）：缩略图取的是**剧本封面** `coverUrl(entry.preset)`（`/img` 白名单直服
// `presets/<id>/cover.jpg`），所以两个剧本刚好把两态摆在一起——demo 有 cover.jpg（beforeAll 手写真 jpg）、
// no-cover 没有（本仓多数 preset 的常态，/img 回真 404）。四条断言各管一件事：
// ① 有封面：图真的解码上屏（naturalWidth > 0）、src 就是封面契约路径、alt 空（装饰性）；
// ② 缩略图不吃行的点击（点它那一片 = 点行，选中与焦点都落到该行）；
// ③ 没封面：那一次 /img 确实回 404，且图**挂上过又被摘掉**（DOM 里不留 <img>，破图图标因此不可能出现）；
// ④ 缺图对布局零影响：占位块与有封面时同尺寸，两态的行高相同（浮点抖动用 expectSamePx 的 0.01px 容差吸收）。

test("行缩略图：有封面的剧本上封面图，没封面的只剩同尺寸占位块（无破图、行高不变）", async () => {
  await page.goto(stack.pageUrl);
  await expect(page.getByTestId("title-card-center")).toBeVisible();
  await centerOnPreset("示例剧本");
  await page.getByTestId("title-card-center").click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await expect(page.getByTestId("world-row-w1")).toBeVisible();

  // —— ① demo 有 cover.jpg ——
  const cover = page.getByTestId("world-cover-img-w1");
  await expect(cover).toBeVisible();
  // src 就是封面契约路径（coverUrl → /img?p=presets%2Fdemo%2Fcover.jpg）
  await expect(cover).toHaveAttribute("src", "/img?p=presets%2Fdemo%2Fcover.jpg");
  // alt=""：装饰性——显示名就在右边的文字块里，读屏不该把同一个名字念两遍
  await expect(cover).toHaveAttribute("alt", "");
  // 真的解码上屏（不是破图、也不是没加载的 lazy 占位）：naturalWidth > 0
  expect(await cover.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(coverStatuses.get("presets/demo/cover.jpg")).toBe(200);
  const coverBox = (await page.getByTestId("world-cover-w1").boundingBox())!;
  expectSamePx(coverBox.width, 56, "有封面的缩略图宽");
  expectSamePx(coverBox.height, 40, "有封面的缩略图高");

  // —— ② 缩略图不吃行的点击（pointer-events-none）：那一片的命中目标就是行自己，点下去 = 点行 ——
  // 命中目标与「点完焦点/选中落到哪一行」两样都断言：前者是机制（elementFromPoint 会跳过
  // pointer-events:none 的元素），后者是玩家可见的结果（roving tabIndex 的语义不变）
  const hitTest = (box: { x: number; y: number; width: number; height: number }): Promise<string> =>
    page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('[data-testid^="world-row-"]')?.getAttribute("data-testid") ?? "";
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
  const clickCenter = (box: { x: number; y: number; width: number; height: number }) =>
    page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  expect(await hitTest(coverBox)).toBe("world-row-w1");
  await clickCenter(coverBox);
  await expect(page.getByTestId("world-row-w1")).toBeFocused();
  await expect(page.getByTestId("world-row-w1")).toHaveAttribute("aria-selected", "true");
  // 换一行再点一次：选中确实跟着走（不是「本来就在第一行，看着对」）
  const cover2Box = (await page.getByTestId("world-cover-w2").boundingBox())!;
  expect(await hitTest(cover2Box)).toBe("world-row-w2");
  await clickCenter(cover2Box);
  await expect(page.getByTestId("world-row-w2")).toBeFocused();
  await expect(page.getByTestId("world-row-w2")).toHaveAttribute("aria-selected", "true");
  // 行高基准（w1 全文件不被任何用例改过：显示名/备注都为空 → 名字行 + 章节行两行）
  const demoRowH = (await page.getByTestId("world-row-w1").boundingBox())!.height;

  // —— ③④ no-cover 剧本：preset 目录里根本没有 cover.jpg ——
  // 先挂观察器（这一步只在世界线屏里发生，故挂在切屏之前），再 Esc 回标题屏换卡
  await watchCoverImg();
  await page.keyboard.press("Escape"); // Esc 关闭链：世界线屏 → 标题屏
  await expect(page.getByTestId("title-card-center")).toBeVisible();
  await centerOnPreset("无封面剧本");
  await page.getByTestId("title-card-center").click();
  await expect(page.getByTestId("worlds-screen")).toBeVisible();
  await expect(page.getByTestId("world-row-w5")).toBeVisible();

  // 图挂上过（缩略图确实渲染了）→ 404 之后被摘掉：DOM 里不留 <img>，只剩中性占位块。
  // 摘除发生在 404 回来那一拍，故用 poll 等它——断言的仍是「最终不留 <img>」，不是某一刻的快照
  const coverTrace = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __coverTrace: string[] }).__coverTrace);
  await expect.poll(coverTrace).toContain("remove:world-cover-img-w5");
  expect(await coverTrace()).toContain("add:world-cover-img-w5");
  expect(coverStatuses.get("presets/no-cover/cover.jpg")).toBe(404); // 封面请求确实回的是 404
  await expect(page.getByTestId("world-cover-img-w5")).toHaveCount(0);

  // 缺图不改变布局：占位块与有封面时同尺寸，行的其余部分一字未改
  const holder = page.getByTestId("world-cover-w5");
  await expect(holder).toBeVisible();
  const holderBox = (await holder.boundingBox())!;
  expectSamePx(holderBox.width, 56, "占位块宽");
  expectSamePx(holderBox.height, 40, "占位块高");
  await expect(page.getByTestId("world-row-w5")).toContainText("第 1 章");
  await expect(page.getByTestId("world-continue-w5")).toBeEnabled();
  const bareRowH = (await page.getByTestId("world-row-w5").boundingBox())!.height;
  expectSamePx(bareRowH, demoRowH, "缺封面的行高与有封面的不一致（缩略图把行撑变形了）");
});
