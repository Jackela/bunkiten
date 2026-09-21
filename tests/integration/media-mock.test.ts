// 集成：mock 出图链路（真 acp-server 子进程 + 假引擎垫片 + 本地假图片服务）。
//
// 覆盖 v1.10 出图链路的**确定性替身**版本：假引擎收到「美术：重绘 立绘 <名>」→ 真的对挂在会话上的
// MCP 连接发 `tools/call`（工具名 = catalog 全名 bunkiten-media__generate_image）→ server/media-mcp.mjs
// 打**玩家自备的 OpenAI 兼容图片服务**（这里换成 tests/helpers/mock-image-server.mjs）→ 落盘
// `presets/<剧本 id>/assets/<类型>-<名>.jpg` → 假引擎补一条【图】协议行。
//
// 为什么不做真跑：真链路（tests/e2e-packaged/real-image.spec.ts）要真凭据、真花一次对话与一张图、还要出网；
// MCP 握手冒烟只验「命令跑得起来 + tools/list」。本用例把两者之间那段（tools/call → 出图 → 落盘 → 标记）
// 用本地假服务端**离线、秒级、确定性**地测穿。
//
// 前置（全在临时 HOME / 临时 GAME_ROOT 里，不发真网络）：
//   · 临时 HOME 写 image byok 凭据（baseUrl 指到 mock 图片服务）；
//   · 临时 GAME_ROOT seed 一个剧本 campus-summer + 一张已有立绘（重绘的目标，先验它存在）；
//   · 假引擎以 FAKE_ENGINE_SPAWN_MCP=1 + FAKE_ENGINE_CALL_MCP=1 起。
//
// 跑法：`npx vitest run tests/integration/media-mock.test.ts`（也会随 `npm test` 一起跑——无网络依赖）。
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { startStack } from "./harness.mjs";
import { startMockImageServer } from "../helpers/mock-image-server.mjs";

/** @type {Array<{stop: () => Promise<void>}>} 本文件起过的栈（afterEach 统一收尾） */
const started: any[] = [];
/** @type {Array<{close: () => Promise<void>}>} 本文件起过的假图片服务 */
const mocks: any[] = [];

afterEach(async () => {
  while (started.length) await started.pop().stop();
  while (mocks.length) await mocks.pop().close();
});

/** 与 mock 服务不同的旧图（seed 进 assets，证明重绘真的把内容换成了 mock 的图） */
const seedJpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`BUNKITEN-${tag}`)]);

/** image.mode=byok 且 baseUrl 指到本地假图片服务的凭据文档 */
const imageByok = (base: string) => ({
  version: 1,
  llm: { mode: "session", provider: "openai", baseUrl: "", apiKey: "", model: "" },
  image: { mode: "byok", provider: "custom", baseUrl: base, apiKey: "sk-mock-image-key-1234", model: "mock-image", size: "" },
});

describe("集成：mock 出图链路（假引擎 tools/call → media-mcp → 假图片服务 → 落盘）", () => {
  it("「美术：重绘 立绘 薇拉」：mock 收到 1 次请求、同名 jpg 落盘且字节 == mock 图、事件流有【图】行", async () => {
    const mock = await startMockImageServer();
    mocks.push(mock);
    const stack = await startStack({
      presets: ["campus-summer"],
      assets: { "campus-summer": [{ name: "立绘-薇拉.jpg", bytes: seedJpeg("seed-vera") }] },
      credentials: imageByok(mock.base),
      extraEnv: { FAKE_ENGINE_SPAWN_MCP: "1", FAKE_ENGINE_CALL_MCP: "1" },
      turns: [],
    });
    started.push(stack);

    const rel = "presets/campus-summer/assets/立绘-薇拉.jpg";
    const target = path.join(stack.root, rel);
    // 前置核对：seed 的旧立绘真的在（重绘的目标按定义已存在，假引擎据此定剧本 id）
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).equals(seedJpeg("seed-vera"))).toBe(true);

    const from = stack.events.length;
    const r = await stack.prompt("美术：重绘 立绘 薇拉");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(regen-1)" });

    // ① mock 图片服务恰好收到 1 次生成请求，参数合理（模型/尺寸/提示词/鉴权都来自凭据与指令）
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.url).toBe("/v1/images/generations");
    expect(call.method).toBe("POST");
    expect(call.model).toBe("mock-image");
    expect(call.size).toBe("1024x1536"); // 立绘默认竖构图（DEFAULT_SIZES）
    expect(call.response_format).toBe("b64_json"); // media-mcp 缺省回包形态，且被 mock 真接下（无退让重试）
    expect(call.prompt).toContain("薇拉");
    expect(call.headers.authorization).toBe("Bearer sk-mock-image-key-1234");

    // ② 目标 jpg 落盘，且字节与 mock 返回的图逐字相等（真的走了服务端 → 字节 → 落盘）
    expect(readFileSync(target).equals(mock.imageBytes)).toBe(true);

    // ③ 事件流里有对应的【图】行（app 侧据此 finishRegen / 换图破缓存）
    expect(stack.events.some((e: any) => e.type === "chunk" && String(e.text).includes(`【图】立绘|薇拉|${rel}|重绘`))).toBe(true);

    // ④ 落盘契约的另一半：/img 直服这张图 200 且字节一致
    const served = await stack.getBytes("/img?" + new URLSearchParams({ p: rel }));
    expect(served.status).toBe(200);
    expect(served.bytes.equals(mock.imageBytes)).toBe(true);

    // ⑤ 探针记下了 tools/call 的请求与结果（工具名 = catalog 全名，参数按指令推出）
    const callEntry = stack.engineProbeEntries().find((e: any) => e.kind === "mcp-call");
    expect(callEntry, "假引擎没写下 mcp-call 探针（FAKE_ENGINE_CALL_MCP 没生效？）").toBeTruthy();
    expect(callEntry.tool).toBe("bunkiten-media__generate_image");
    expect(callEntry.ok).toBe(true);
    expect(callEntry.args).toMatchObject({ kind: "立绘", name: "薇拉", outRelPath: rel });
    expect(callEntry.result).toMatchObject({ ok: true, relPath: rel });

    // ⑥ 二次重绘覆盖同名文件：mtime 前进（把 mtime 回拨 60s 让「前进」确定可判，不用 sleep）
    const past = new Date(Date.now() - 60_000);
    utimesSync(target, past, past);
    const before = statSync(target).mtimeMs;
    const r2 = await stack.prompt("美术：重绘 立绘 薇拉");
    expect(r2.status).toBe(200);
    await expect.poll(() => statSync(target).mtimeMs, { timeout: 5000 }).toBeGreaterThan(before);
    expect(mock.calls).toHaveLength(2); // 又打了一次服务端（重绘是唯一绕过缓存的路径）
    expect(readFileSync(target).equals(mock.imageBytes)).toBe(true);
  }, 20000);
});
