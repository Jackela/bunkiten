// 假引擎确定性 UI e2e ⑥：世界线屏管理动作——改名（label，入口在行的 ⋯ 菜单）、导出 .world.json（浏览器下载）、
// 导入同一文件（server 重名加 -2 后缀）、两段确认删除副本；v1.7 家谱视图（forkedFrom 森林）。
// 导出内容断言 format:"bunkiten-world" / worldId / title / label；导入文件落在 test-results-ui/ 下。
// v1.8 补三条：① 家谱画布的缩放/适应读数与 viewBox（工具条提示行的可见性一并钉住——它当初就是为了
// 不被画布顶到屏脚才挪进工具条的）；② 行 ⋯ 菜单的**纯键盘**路径（Enter 开 → Tab 走项 → Esc 只收菜单、
// 不退屏 → 重开时半截删除确认已复位）；③ 导出包 v2 的血缘（forkedFrom + fork.md 随包走，导入回来的
// 分叉线在家谱里仍是子节点）——老包（v1）那条路走应用内的「导入」按钮，v2 包那条走真服务端的 HTTP 面
// （客户端 parseWorldBundle 的版本闸本轮冻结未动，见下面「导入」段的注释）。
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
  // w3 补一份 fork.md（forkWorld 落盘的同名文件）：导出包要能把它带走、导入侧要原样落回来
  writeFileSync(path.join(stack.stack.root, "state", "worlds", "w3", "fork.md"), FORK_MD_W3);
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

  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Bundle;
  expect(bundle.format).toBe("bunkiten-world");
  expect(bundle.version).toBe(2); // v1.8：v2 包（world 多两个血缘键）
  expect(bundle.world.worldId).toBe("w2");
  expect(bundle.world.title).toBe("示例剧本");
  expect(bundle.world.label).toBe("回廊之影");
  // w2 是根世界：两个血缘键都在、值都是 null（缺键与 null 是两种意思，v1 包才是「缺键」）
  expect(bundle.world.forkedFrom).toBe(null);
  expect(bundle.world.forkMd).toBe(null);

  // —— 导入：**v1 形状**的副本走应用内的「导入」按钮 ——
  // 客户端 parseWorldBundle 的版本闸（src/store/slices/world.ts）此刻只认 v1，本轮按约束没动 src/**：
  // 直接把 v2 包喂给「导入」会被本地挡下（提示「不是有效的世界线导出包」）。所以这里拆两半——
  // UI 走 v1 副本（钉住「老包仍能被导入」这条不许被顺手收紧），v2 包的导入走真服务端 HTTP（下一步），
  // 家谱渲染两边都看。客户端闸落地后，这一步可以并回下面那个 v2 包。
  const v1Bundle = { ...bundle, version: 1, world: { ...bundle.world } };
  delete v1Bundle.world.forkedFrom;
  delete v1Bundle.world.forkMd;
  const v1Path = path.join(outDir, "w2-export-v1.world.json");
  writeFileSync(v1Path, JSON.stringify(v1Bundle, null, 2));

  // w2 已被占用 → server 落成 w2-2，提示与列表都可见
  await page.getByTestId("worlds-import-input").setInputFiles(v1Path);
  await expect(page.getByTestId("worlds-notice")).toContainText("w2-2");
  await expect(page.getByTestId("world-row-w2-2")).toBeVisible();
  await expect(page.getByTestId("world-row-w2-2")).toContainText("回廊之影"); // label 随包迁移
  // v1 包不带分叉说明：导入侧不许凭血缘凭空造一份 fork.md（否则引擎首个回合会读到一份空指令）
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

  // —— 分叉世界的包：v2 的血缘与 fork.md 随包走 ——（w3 分叉自 w2@1-1，磁盘上有一份 fork.md）
  // 包从同一个导出端点取（node 侧 HTTP，与浏览器里那个 `<a download>` 打的是同一个路由——下载路径本身
  // 已由 w2 那一步钉住）。刻意不做第二次浏览器下载：这条断言要证的是「血缘与 fork.md 活过导出→导入，
  // 且家谱把导入回来的分叉线画在父线下面」，那半段只有浏览器能证；再叠一个下载只增加等待面。
  const forkExport = await stack.stack.getJSON("/api/worlds/export?worldId=w3");
  expect(forkExport.status).toBe(200);
  expect(forkExport.headers.get("content-disposition")).toBe('attachment; filename="w3.world.json"'); // 下载文件名行为不变
  const forkBundle = forkExport.body as Bundle;
  expect(forkBundle.format).toBe("bunkiten-world");
  expect(forkBundle.version).toBe(2);
  expect(forkBundle.world.worldId).toBe("w3");
  expect(forkBundle.world.forkedFrom).toEqual({ worldId: "w2", nodeId: "1-1" }); // v1 包在这里是 null（= 根）
  expect(forkBundle.world.forkMd).toBe(FORK_MD_W3); // 逐字（含分叉时间那一行）

  // —— 导入 v2 包：走真服务端的 HTTP 面（浏览器侧只负责渲染结果）——
  // 应用内「导入」按钮走 v2 要等客户端版本闸落地（见上面「导入」段的注释）。
  const forkImport = await stack.stack.postJSON("/api/worlds", { action: "import", bundle: forkBundle });
  expect(forkImport.status).toBe(200);
  expect(forkImport.body.worldId).toBe("w3-2"); // 重名后缀
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
