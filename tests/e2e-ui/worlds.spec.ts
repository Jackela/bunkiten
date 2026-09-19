// 假引擎确定性 UI e2e ⑥：世界线屏管理动作——改名（label，入口在行的 ⋯ 菜单）、导出 .world.json（浏览器下载）、
// 导入同一文件（server 重名加 -2 后缀）、两段确认删除副本；v1.7 家谱视图（forkedFrom 森林）。
// 导出内容断言 format:"bunkiten-world" / worldId / title / label；导入文件落在 test-results-ui/ 下。
// v1.8 补两条：① 家谱画布的缩放/适应读数与 viewBox（工具条提示行的可见性一并钉住——它当初就是为了
// 不被画布顶到屏脚才挪进工具条的）；② 行 ⋯ 菜单的**纯键盘**路径（Enter 开 → Tab 走项 → Esc 只收菜单、
// 不退屏 → 重开时半截删除确认已复位）。
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    // w1 默认存在；w3 分叉自 w2（父子连线），w4 指向不存在的 ghost（孤儿 ⌫）；管理动作不推演，无需 turns
    worlds: [
      { id: "w2" },
      { id: "w3", forkedFrom: { worldId: "w2", nodeId: "1-1" } },
      { id: "w4", forkedFrom: { worldId: "ghost", nodeId: "9-9" } },
    ],
  }));
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
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("world-export-w2").click(),
  ]);
  const outDir = path.join(ROOT, "test-results-ui");
  mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, "w2-export.world.json");
  await download.saveAs(bundlePath);

  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
    format: string;
    version: number;
    world: { worldId: string; title: string; label: string };
  };
  expect(bundle.format).toBe("bunkiten-world");
  expect(bundle.version).toBe(1);
  expect(bundle.world.worldId).toBe("w2");
  expect(bundle.world.title).toBe("示例剧本");
  expect(bundle.world.label).toBe("回廊之影");

  // —— 导入同一文件：w2 已被占用 → server 落成 w2-2，提示与列表都可见 ——
  await page.getByTestId("worlds-import-input").setInputFiles(bundlePath);
  await expect(page.getByTestId("worlds-notice")).toContainText("w2-2");
  await expect(page.getByTestId("world-row-w2-2")).toBeVisible();
  await expect(page.getByTestId("world-row-w2-2")).toContainText("回廊之影"); // label 随包迁移

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

  // 捏人屏不是死路：「新世界线」进去后「返回」回世界线屏，世界牌面（列表）照旧还在
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
  expect(
    Number(zoomedVb.split(/\s+/)[2]),
    `放大后 viewBox 视野没变窄（${fitVb} → ${zoomedVb}）`,
  ).toBeLessThan(fitW);

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
