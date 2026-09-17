// 假引擎确定性 UI e2e ⑥：世界线屏管理动作——行内改名（label）、导出 .world.json（浏览器下载）、
// 导入同一文件（server 重名加 -2 后缀）、两段确认删除副本；v1.7 家谱视图（forkedFrom 森林）。
// 导出内容断言 format:"bunkiten-world" / worldId / title / label；导入文件落在 test-results-ui/ 下。
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startFakeStack } from "../helpers/fake-stack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let stack: Awaited<ReturnType<typeof startFakeStack>>;
let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  stack = await startFakeStack({
    presets: [{ id: "demo", title: "示例剧本" }],
    // w1 默认存在；w3 分叉自 w2（父子连线），w4 指向不存在的 ghost（孤儿 ⌫）；管理动作不推演，无需 turns
    worlds: [
      { id: "w2" },
      { id: "w3", forkedFrom: { worldId: "w2", nodeId: "1-1" } },
      { id: "w4", forkedFrom: { worldId: "ghost", nodeId: "9-9" } },
    ],
  });
  page = await (await browser.newContext()).newPage();
});

test.afterAll(async () => {
  if (page) await page.close().catch(() => {});
  await stack?.stop();
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

  // —— 行内改名：编辑器展开 → 填显示名 → 保存 → 列表以服务端落定值回显 ——
  await page.getByTestId("world-edit-w2").click();
  await expect(page.getByTestId("world-editor-w2")).toBeVisible();
  await page.getByTestId("world-edit-label-w2").fill("回廊之影");
  await page.getByTestId("world-edit-save-w2").click();
  await expect(page.getByTestId("world-editor-w2")).toHaveCount(0);
  await expect(page.getByTestId("world-row-w2")).toContainText("回廊之影");

  // —— 导出：anchor 触发浏览器下载（Content-Disposition attachment），存到 test-results-ui/ ——
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

  // —— 两段确认删除副本：首点变确认按钮，二点才发；删除后原件仍在 ——
  await page.getByTestId("world-delete-w2-2").click();
  await page.getByTestId("world-confirm-w2-2").click();
  await expect(page.getByTestId("world-row-w2-2")).toHaveCount(0);
  await expect(page.getByTestId("world-row-w2")).toBeVisible();
  await expect(page.getByTestId("world-row-w1")).toBeVisible();
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
  await expect(detail).toContainText("分叉自 w2 @ 1-1");
  await expect(page.getByTestId("genealogy-continue-w3")).toBeVisible();

  // 「查看」跳回列表视图并聚焦对应行
  await page.getByTestId("genealogy-view-w3").click();
  await expect(page.getByTestId("genealogy-canvas")).toHaveCount(0);
  await expect(page.getByTestId("world-row-w3")).toBeVisible();
  await expect(page.getByTestId("world-row-w3")).toBeFocused();
});
