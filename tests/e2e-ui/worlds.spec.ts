// 假引擎确定性 UI e2e ⑥：世界线屏管理动作——行内改名（label）、导出 .world.json（浏览器下载）、
// 导入同一文件（server 重名加 -2 后缀）、两段确认删除副本。
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
    worlds: [{ id: "w2" }], // w1 默认存在；管理动作不推演，无需 turns
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
