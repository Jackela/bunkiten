// 假引擎确定性 UI e2e（v1.7）：剧本分享闭环——标题屏当前卡「导出」下载 .preset.json
// （Content-Disposition attachment，包含封面/立绘/音频）、角落「导入剧本」把包导回来（改 id 避免撞名），
// 成功提示带实际落地 id，轮播刷新出新卡带、切到它可再导出（id 联动闭环）。导出文件落在 test-results-ui/。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { openTitleMore } from "./flow";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let stack: StartedStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: "demo", title: "示例剧本" }],
    assets: { demo: [{ name: "立绘-薇拉.jpg", bytes: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("E2E-VERA")]) }] },
    audioFiles: { demo: [{ name: "曲-夜灯谣.wav", bytes: Buffer.from("E2E-WAV") }] },
    turns: [], // 导出/导入不推演，无需回合脚本
  }));
  // 封面按契约在 preset 根（harness 的 assets 落 assets/ 子目录），单独手放
  writeFileSync(
    path.join(stack.stack.root, "presets", "demo", "cover.jpg"),
    Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("E2E-COVER")]),
  );
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
});

test("剧本分享：导出下载 .preset.json → 导入成新卡带（demo-copy）→ 新卡可再导出", async () => {
  await page.goto(stack.pageUrl);
  await expect(page.getByTestId("title-card-center")).toBeVisible();

  // —— 导出：anchor 触发浏览器下载，存到 test-results-ui/ ——
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await openTitleMore(page);
      await page.getByTestId("preset-export-demo").click();
    })(),
  ]);
  const outDir = path.join(ROOT, "test-results-ui");
  mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, "demo-export.preset.json");
  await download.saveAs(bundlePath);

  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
    format: string;
    version: number;
    id: string;
    title: string;
    presetMd: string;
    assets: Record<string, string>;
    audio: Record<string, string>;
  };
  expect(bundle.format).toBe("bunkiten-preset");
  expect(bundle.version).toBe(1);
  expect(bundle.id).toBe("demo");
  expect(bundle.title).toBe("示例剧本");
  expect(Object.keys(bundle.assets).sort()).toEqual(["cover.jpg", "立绘-薇拉.jpg"].sort());
  expect(Object.keys(bundle.audio)).toEqual(["曲-夜灯谣.wav"]);
  expect(Buffer.from(bundle.assets["立绘-薇拉.jpg"], "base64").toString()).toContain("E2E-VERA");
  expect(bundle.presetMd).toContain("id: demo");

  // —— 导入：改 id 避免撞名（拿到别人的包原样导回时由服务端加 -2）→ 提示带实际落地 id ——
  bundle.id = "demo-copy";
  writeFileSync(bundlePath, JSON.stringify(bundle));
  await page.getByTestId("preset-import-input").setInputFiles(bundlePath);
  await expect(page.getByTestId("title-notice")).toContainText("已导入为 demo-copy");

  // —— 轮播刷新出新卡（目录名排序 demo → demo-copy）：导出的 id 跟着中心卡走 ——
  // 这一段的起点正是 v1.12 修掉的那条：Radix 关菜单时会把焦点送回触发器，触发器若**无条件**吞 keydown，
  // 「刚用完一次菜单」之后的 ← → 就再也切不动卡（本屏的切卡挂在 window 上）。现在它只吞菜单开着时、
  // 以及它自己会吃的那几个键（Enter/Space/↑/↓）——所以下面这条 ArrowRight 必须在菜单收掉后仍然有效。
  await openTitleMore(page);
  await expect(page.getByTestId("preset-export-demo")).toBeVisible(); // 导入不改中心卡：还是旧卡
  await page.getByTestId("title-more").click(); // 收菜单 → 焦点回触发器（要验的就是从这个起点继续按）
  await page.keyboard.press("ArrowRight"); // → 新卡上台
  await openTitleMore(page);
  await expect(page.getByTestId("preset-export-demo-copy")).toBeVisible(); // 导出换成新 id
  await expect(page.getByTestId("title-card-center")).toHaveAttribute("aria-label", /示例剧本/);
});

