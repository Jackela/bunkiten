// 集成测试（CONTRACTS §7/§8）：假 ACP 引擎（PATH 垫片 bin/grok）+ 真 server/acp-server.mjs 子进程。
// 全程离线、可重复：临时 GROK_GAME_ROOT/HOME + 随机高位端口，整文件秒级跑完。
//
// 覆盖 §8 的 8 条：
//   ①【图】标记（images/N.jpg）→ /img?preset= 落盘进 presets/<id>/assets 并直服、内容正确、未命中 404
//   ②/img 目录穿越（编码后的 ../）不得直服
//   ③旧档路径 assets/<类型>-<名>.jpg 只在当前剧本目录探测（不跨剧本扫描）
//   ④【立绘】→expression、【新剧本】→presetAdded（且占位项按新 id 补落盘）
//   ⑤【树】→treeEdited（v1.6 修复点：此前漏接线，SSE 必须收到）
//   ⑥sniffPreset：继续世界：w1。→ 后续美术落进 w1 的 preset 目录
//   ⑦/api/presets、/api/assets?preset=（缺/非法 400）、/api/worlds CRUD 冒烟
//   ⑧引擎回 JSON-RPC error response：POST /prompt 409 + SSE error 事件 + 不写逐轮快照
//
// 扩展点见 tests/integration/harness.mjs 顶部注释（wave2 加音频/快照断言时复用 stack 句柄）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startStack } from "./harness.mjs";
import { waitFor } from "../helpers/poll.mjs";

// 可辨识的假 JPEG 字节（内容断言用）：JPEG SOI 前缀 + 可读标记
const fakeJpeg = (tag: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`BUNKITEN-${tag}`)]);
// /img 查询串构造：URLSearchParams 会把 chinese 与 `/` 正确百分号编码（穿越用例依赖这个）
const imgUrl = (params: Record<string, string>) => "/img?" + new URLSearchParams(params).toString();

describe("集成：假 ACP 引擎 + 真 acp-server（CONTRACTS §8 1–5、7–8）", () => {
  let stack: any;

  beforeAll(async () => {
    // 脚本按 prompt 子串匹配（序无关）；每个回合先流式 chunk 再收尾
    stack = await startStack({
      sessionImages: { "1.jpg": fakeJpeg("one"), "2.jpg": fakeJpeg("two") },
      turns: [
        { match: "开门", ops: ["薇拉站在门口，雨声很密。\n\n【图】立绘|薇拉|images/1.jpg\n"] },
        { match: "表情", ops: ["【立绘】薇拉|微笑\n【图】立绘|沈屿|images/2.jpg\n【新剧本】demo\n"] },
        { match: "改树", ops: ["已把通往教堂的岔路改成通往酒馆。\n\n【树】\n"] },
        { match: "继续世界", ops: ["（再入场）教堂檐下。\n"] },
        // ⑧ 的进场回合（继续世界）正文缺 **行动** → 质量守卫会自动追问一次；不给这条应答的话，
        // 追问会按顺次消费把「引擎坏」条目吃掉，⑧ 的 error 传播用例就测不到了
        { match: "补充：", ops: ["**行动**\n1. 跟上\n"] },
        // ⑧ 的前置正戏回合（重同步回合不写快照，得先有一条真快照才能验「失败回合不落快照」）
        { match: "看看四周", ops: ["四周空无一人。\n\n**行动**\n1. 往前走\n"] },
        { match: "引擎坏", ops: [{ error: "引擎坏了" }] },
      ],
    });
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("① 【图】标记（images/1.jpg）经 /img?preset= 落盘进 presets/demo/assets 并直服、内容正确、未命中 404", async () => {
    const r = await stack.prompt("推开门看看。");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.some((e) => e.type === "turn_end"), { label: "turn_end(①)" });

    // 流式识别到完整【图】行（只有完整行才生效）
    expect(
      stack.events.some((e: any) => e.type === "chunk" && String(e.text).includes("【图】立绘|薇拉|images/1.jpg")),
    ).toBe(true);

    const target = path.join(stack.root, "presets", "demo", "assets", "立绘-薇拉.jpg");
    expect(existsSync(target)).toBe(false); // 标记自身拿不到剧本 id → 不落盘（B1 落盘纪律）

    // 客户端按当前剧本请求：/img?p=images/1.jpg&t=立绘&n=薇拉&preset=demo → 从会话图片落盘到永久层 + 直服
    const direct = await stack.getBytes(imgUrl({ p: "images/1.jpg", t: "立绘", n: "薇拉", preset: "demo" }));
    expect(direct.status).toBe(200);
    expect(direct.type).toContain("image/jpeg");
    expect(direct.bytes.equals(fakeJpeg("one"))).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).equals(fakeJpeg("one"))).toBe(true);

    // 永久层命中优先：不带 p 也直服
    const perm = await stack.getBytes(imgUrl({ t: "立绘", n: "薇拉", preset: "demo" }));
    expect(perm.status).toBe(200);
    expect(perm.bytes.equals(fakeJpeg("one"))).toBe(true);

    // 未命中 → 404
    const miss = await stack.getBytes(imgUrl({ t: "立绘", n: "不存在的角色", preset: "demo" }));
    expect(miss.status).toBe(404);
  }, 15000);

  it("② /img 目录穿越（编码后的 ../）不得直服", async () => {
    // 显式标注成 Record<string,string>：不标的话字面量数组会推成「可选键各不相同」的联合，
    // 与 imgUrl 的入参对不上（值本身全是字符串）
    const payloads: Record<string, string>[] = [
      { p: "presets/demo/assets/../../../etc/passwd" },
      { p: "presets/demo/assets/../../../server/acp-server.mjs" },
      { p: "../../etc/passwd" },
      { p: "../../etc/passwd", t: "立绘", n: "x", preset: "demo" },
      { p: "presets/../server/acp-server.mjs" },
    ];
    for (const params of payloads) {
      const r = await stack.getBytes(imgUrl(params));
      expect(r.status).toBe(404);
    }

    // 白名单内的合法文件仍直服（守门不误伤）
    mkdirSync(path.join(stack.root, "presets", "demo", "assets"), { recursive: true });
    writeFileSync(path.join(stack.root, "presets", "demo", "assets", "背景-安全.jpg"), fakeJpeg("safe"));
    const ok = await stack.getBytes(imgUrl({ p: "presets/demo/assets/背景-安全.jpg" }));
    expect(ok.status).toBe(200);
    expect(ok.bytes.equals(fakeJpeg("safe"))).toBe(true);
  }, 15000);

  it("③ 旧档路径 assets/<类型>-<名>.jpg 只在当前剧本目录探测（不跨剧本扫描）", async () => {
    const demoFile = path.join(stack.root, "presets", "demo", "assets", "背景-教堂.jpg");
    mkdirSync(path.dirname(demoFile), { recursive: true });
    writeFileSync(demoFile, fakeJpeg("demo-church"));
    const decoy = path.join(stack.root, "presets", "other", "assets", "立绘-诱饵.jpg");
    mkdirSync(path.dirname(decoy), { recursive: true });
    writeFileSync(decoy, fakeJpeg("decoy"));

    // 命中当前剧本目录 → 直服
    const hit = await stack.getBytes(imgUrl({ p: "assets/背景-教堂.jpg", preset: "demo" }));
    expect(hit.status).toBe(200);
    expect(hit.bytes.equals(fakeJpeg("demo-church"))).toBe(true);

    // 只在 other 存在的同名文件：demo 下探测不到 → 404（不跨剧本串味）
    const cross = await stack.getBytes(imgUrl({ p: "assets/立绘-诱饵.jpg", preset: "demo" }));
    expect(cross.status).toBe(404);
    // other 自己请求仍能命中（证明确实落在那）
    const inOther = await stack.getBytes(imgUrl({ p: "assets/立绘-诱饵.jpg", preset: "other" }));
    expect(inOther.status).toBe(200);
    expect(inOther.bytes.equals(fakeJpeg("decoy"))).toBe(true);
  }, 15000);

  it("④ 【立绘】→expression 事件；【新剧本】→presetAdded 事件且占位项按新 id 补落盘", async () => {
    const from = stack.events.length;
    const r = await stack.prompt("换个表情。");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(④)" });
    const got = stack.events.slice(from);

    const expr = got.find((e: any) => e.type === "expression");
    expect(expr).toMatchObject({ character: "薇拉", variant: "微笑" });
    expect(got.some((e: any) => e.type === "presetAdded" && e.id === "demo")).toBe(true);

    // 【图】立绘|沈屿|images/2.jpg 先到（装配期还不知剧本 id，占位 ready:false），
    // 【新剧本】demo 后到 → 用新 id 重试整批占位项 → 落进 presets/demo/assets/
    const target = path.join(stack.root, "presets", "demo", "assets", "立绘-沈屿.jpg");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).equals(fakeJpeg("two"))).toBe(true);
  }, 15000);

  it("⑤ 【树】→ treeEdited 事件（v1.6 修复点：SSE 必须收到，且在 turn_end 之前派发）", async () => {
    const from = stack.events.length;
    const r = await stack.prompt("改树：把通往教堂的岔路改成通往酒馆。");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "treeEdited"), { label: "treeEdited(⑤)" });
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(⑤)" });

    const got = stack.events.slice(from);
    expect(got.filter((e: any) => e.type === "treeEdited")).toHaveLength(1);
    expect(got.findIndex((e: any) => e.type === "treeEdited")).toBeLessThan(
      got.findIndex((e: any) => e.type === "turn_end"),
    );
  }, 15000);

  it("⑦ API 冒烟：/api/presets、/api/assets（preset 必填，缺/非法 400）、/api/worlds CRUD", async () => {
    // /api/presets 实时扫描临时 root 的 presets/*/preset.md
    const presets = await stack.getJSON("/api/presets");
    expect(presets.status).toBe(200);
    expect(presets.body.errors).toEqual([]);
    const demo = presets.body.presets.find((p: any) => p.id === "demo");
    expect(demo).toMatchObject({ id: "demo", title: "示例剧本" });
    expect(demo.characters).toEqual(["薇拉", "沈屿"]);

    // /api/assets：preset 必填且过白名单
    expect((await stack.getJSON("/api/assets")).status).toBe(400);
    expect((await stack.getJSON("/api/assets?preset=" + encodeURIComponent("../etc"))).status).toBe(400);
    const assets = await stack.getJSON("/api/assets?preset=demo");
    expect(assets.status).toBe(200);
    expect(Array.isArray(assets.body)).toBe(true);
    // ① 已落盘的立绘在清单里：ready + 指向 presets/demo/assets（资产随剧本站）
    const portrait = assets.body.find((a: any) => a.type === "立绘" && a.name === "薇拉");
    expect(portrait).toMatchObject({ ready: true, preset: "demo", file: "presets/demo/assets/立绘-薇拉.jpg" });

    // /api/worlds：预置 w1（磁盘自愈出 chapterNo）
    const worlds = await stack.getJSON("/api/worlds");
    expect(worlds.status).toBe(200);
    const w1 = worlds.body.worlds.find((w: any) => w.worldId === "w1");
    expect(w1).toMatchObject({ preset: "demo", exists: true });
    expect(typeof w1.chapterNo).toBe("number");

    // create → fork → delete 冒烟
    const created = await stack.postJSON("/api/worlds", { action: "create", preset: "demo" });
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect(created.body.worldId).toMatch(/^demo-\d+$/);

    const forked = await stack.postJSON("/api/worlds", { action: "fork", worldId: "w1", nodeId: "1-1" });
    expect(forked.status).toBe(200);
    expect(forked.body.ok).toBe(true);
    expect(forked.body.entry.forkedFrom).toEqual({ worldId: "w1", nodeId: "1-1" });
    const forkedDir = path.join(stack.root, "state", "worlds", forked.body.worldId);
    expect(readFileSync(path.join(forkedDir, "story-tree.md"), "utf8")).toContain("节点 1-1（已走 0 轮）");
    expect(existsSync(path.join(forkedDir, "fork.md"))).toBe(true);

    // 未知世界 fork → 400
    expect((await stack.postJSON("/api/worlds", { action: "fork", worldId: "nope-1", nodeId: "1-1" })).status).toBe(
      400,
    );

    // delete 冒烟（删掉 create 出来的那个）
    const deleted = await stack.postJSON("/api/worlds", { action: "delete", worldId: created.body.worldId });
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
    expect(existsSync(path.join(stack.root, "state", "worlds", created.body.worldId))).toBe(false);
  }, 15000);

  it("⑧ 引擎回 JSON-RPC error response：POST /prompt 409、SSE 广播 error（带 stale）、不写逐轮快照", async () => {
    // 先把当前世界定下来（否则 sendPrompt 本就不会写快照，负向断言没有意义）。
    // v1.14：重同步回合（继续世界：）**不写快照**——它只重读档，不推进状态。
    const fromEnter = stack.events.length;
    const enter = await stack.prompt("继续世界：w1。");
    expect(enter.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(fromEnter).some((e) => e.type === "turn_end"), {
      label: "turn_end(⑧-enter)",
    });
    const enterEnd = stack.events.slice(fromEnter).find((e: any) => e.type === "turn_end");
    expect(enterEnd).toMatchObject({ main: false, seq: null }); // 重同步回合：不占幕号、不进 history
    const histDir = path.join(stack.root, "state", "worlds", "w1", "history");
    const countSnapshots = () => (existsSync(histDir) ? readdirSync(histDir).length : 0);
    expect(countSnapshots()).toBe(0);

    // 再跑一个真·正戏回合落一条快照：下面「失败回合不落快照」才有真前置（0 == 0 是空断言）
    const fromMain = stack.events.length;
    expect((await stack.prompt("看看四周。")).status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(fromMain).some((e) => e.type === "turn_end"), {
      label: "turn_end(⑧-main)",
    });
    const before = countSnapshots();
    expect(before).toBe(1);

    const from = stack.events.length;
    const r = await stack.prompt("让引擎坏掉的一轮。");
    // sendPrompt 必须把引擎的 error response 当失败回合：HTTP 409 + error 语义（此前被当成功 200）
    expect(r.status).toBe(409);
    expect(String(r.body?.error)).toContain("引擎坏了");
    await stack.waitFor(
      (ev: any[]) => ev.slice(from).some((e: any) => e.type === "error" && String(e.error).includes("引擎坏了")),
      { label: "error(⑧)" },
    );
    const got = stack.events.slice(from);
    // v1.14：失败事件带 stale（引擎可能写了一半盘，客户端该先重同步）+ 本回合序号
    const errEv = got.find((e: any) => e.type === "error");
    expect(errEv.stale).toBe(true);
    expect(typeof errEv.turn).toBe("number");
    expect(got.some((e: any) => e.type === "turn_end")).toBe(false); // 失败回合不许走成功收尾
    expect(countSnapshots()).toBe(before); // 也不落快照：失败回合不产生「这一轮」的档
  }, 15000);

  it("resolveImage 会话图索引：当前会话没有时跨会话同名取 mtime 最新（v1.7 读路径索引化）", async () => {
    // 在临时 HOME 的会话根下造两个「历史会话」目录，放同名 9.jpg、不同 mtime 与内容；
    // 当前会话目录（harness 已建）没有 9.jpg → /img 走 resolveImage 的跨会话路径
    const sessionsRoot = path.join(stack.home, ".grok", "sessions", encodeURIComponent(stack.root));
    const oldDir = path.join(sessionsRoot, "old-session", "images");
    const newDir = path.join(sessionsRoot, "new-session", "images");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(path.join(oldDir, "9.jpg"), fakeJpeg("stale"));
    writeFileSync(path.join(newDir, "9.jpg"), fakeJpeg("fresh"));
    const older = new Date(Date.now() - 60_000);
    utimesSync(path.join(oldDir, "9.jpg"), older, older); // 显式回拨：避免两次写入同毫秒让「最新」判定抖动

    // 第一次请求：索引未建 → 全量扫描重建 → 同名取 mtime 新的那份
    const r = await stack.getBytes(imgUrl({ p: "images/9.jpg" }));
    expect(r.status).toBe(200);
    expect(r.bytes.equals(fakeJpeg("fresh"))).toBe(true);
    // 第二次请求：索引已建 → 命中缓存路径，结果一致
    const again = await stack.getBytes(imgUrl({ p: "images/9.jpg" }));
    expect(again.status).toBe(200);
    expect(again.bytes.equals(fakeJpeg("fresh"))).toBe(true);
  }, 15000);
});

describe("集成 §8-6：sniffPreset 世界→剧本（继续世界：w1。→ 后续美术落进 w1 的 preset 目录）", () => {
  let stack: any;

  beforeAll(async () => {
    // 独立一套栈：本用例依赖「初始无 currentPresetId」这一前置状态，与上面的栈隔离
    stack = await startStack({
      sessionImages: { "6.jpg": fakeJpeg("six") },
      turns: [{ match: "继续世界", ops: ["（再入场）雨夜，教堂檐下。\n\n【图】立绘|薇拉|images/6.jpg\n"] }],
    });
    // 旧档命中文件只放 demo（= w1 的 preset）；other 放另一份同名诱饵证明 sniff 后仍不跨剧本
    mkdirSync(path.join(stack.root, "presets", "demo", "assets"), { recursive: true });
    writeFileSync(path.join(stack.root, "presets", "demo", "assets", "立绘-林夏.jpg"), fakeJpeg("linxia-demo"));
    mkdirSync(path.join(stack.root, "presets", "other", "assets"), { recursive: true });
    writeFileSync(path.join(stack.root, "presets", "other", "assets", "立绘-苏晚.jpg"), fakeJpeg("suwan-other"));
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("继续世界：w1。→ sniffPreset 把当前剧本设为 w1 的 preset（demo），后续 images/N.jpg 落进 presets/demo", async () => {
    // w1 的 preset 由索引给出（客户端即按此拼 &preset=）
    const worlds = await stack.getJSON("/api/worlds");
    const w1 = worlds.body.worlds.find((w: any) => w.worldId === "w1");
    expect(w1.preset).toBe("demo");

    // 续玩前：无 currentPresetId → 旧档路径不带 &preset= 时拿不到剧本 → 404
    expect((await stack.getBytes(imgUrl({ p: "assets/立绘-林夏.jpg" }))).status).toBe(404);

    // 发续玩指令：isDirectivePrompt + parseWorldRef → sniffPreset 设 currentPresetId=demo
    const r = await stack.prompt("继续世界：w1。");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.some((e) => e.type === "turn_end"), { label: "turn_end(⑥)" });
    await waitFor(() => stack.stdout().includes("current preset: demo (world w1)"), {
      timeoutMs: 2000,
      intervalMs: 20,
      label: "stdout: current preset: demo (world w1)",
    });

    // 续玩后：旧档直服按 currentPresetId=demo 命中 demo 目录（证明「当前剧本」换成 w1 的剧本）
    const hit = await stack.getBytes(imgUrl({ p: "assets/立绘-林夏.jpg" }));
    expect(hit.status).toBe(200);
    expect(hit.bytes.equals(fakeJpeg("linxia-demo"))).toBe(true);
    // 只在 other 的文件仍探测不到（sniff 指向 demo，不跨剧本）
    expect((await stack.getBytes(imgUrl({ p: "assets/立绘-苏晚.jpg" }))).status).toBe(404);

    // 该回合的【图】标记（images/6.jpg）按 w1 的 preset 落盘进 presets/demo/assets/
    const persisted = await stack.getBytes(imgUrl({ p: "images/6.jpg", t: "立绘", n: "薇拉", preset: w1.preset }));
    expect(persisted.status).toBe(200);
    const target = path.join(stack.root, "presets", "demo", "assets", "立绘-薇拉.jpg");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).equals(fakeJpeg("six"))).toBe(true);

    // 自由输入里的「世界：other。」不得改落盘目录（isDirectivePrompt 闸）
    const from = stack.events.length;
    const free = await stack.prompt("世界：other。");
    expect(free.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), {
      label: "turn_end(⑥-free)",
    });
    const still = await stack.getBytes(imgUrl({ p: "assets/立绘-林夏.jpg" }));
    expect(still.status).toBe(200);
    expect(still.bytes.equals(fakeJpeg("linxia-demo"))).toBe(true);
  }, 15000);
});

// 回合原文日志 + 质量守卫（v1.7）：正戏回合把 {seq,at,prompt,text} 落进 state/worlds/<w>/logs/NNNN.json
//（与 history/ 平级、append-only、不进导出包）；正戏回合缺 **行动** 选项段时 server 在同一 busy 窗口内
// 自动补发一次「补充：」追问（只补回合尾、追问属于同一回合不另立条目）。
describe("集成：回合原文日志 + 质量守卫（v1.7）", () => {
  let stack: any;

  beforeAll(async () => {
    stack = await startStack({
      turns: [
        // 进场：带 **行动** 的正戏回合（守卫不触发）
        { match: "继续世界：w1", ops: ["雨停了，石阶泛着冷光。\n\n**行动**\n1. 推门进去\n2. 原地等待\n"] },
        // 自由输入回合：正文故意缺 **行动** → 触发守卫
        { match: "自由回合", ops: ["你走近她两步，雨声忽然大了。\n"] },
        // 守卫追问（SUPPLEMENT_PROMPT 以「补充：」开头）的应答：只补回合尾
        { match: "补充：", ops: ["**行动**\n1. 递伞\n2. 开口\n"] },
        // 指令回合（美术：…）的应答
        { match: "美术：", ops: ["（立绘已就绪）\n"] },
        // 章末回合的应答：只有章标记 + 正文，无 **行动**（每轮协议唯一合法例外 → 守卫必须豁免）
        { match: "终章", ops: ["【章】第 1 章 完\n（终章正文）\n"] },
      ],
    });
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("⑪ 重同步回合（继续世界：）落 logs/0001.json 但**不写快照**，turn_end 带 main:false / seq:null", async () => {
    const from = stack.events.length;
    const r = await stack.prompt("继续世界：w1。");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e: any) => e.type === "turn_end"), {
      label: "turn_end(logs-⑪)",
    });

    // 日志照写（v1.14 的判定：正戏 + 重同步都写）——重读档的正文是玩家真看到的当前场景，回溯面不该缺它
    const logsDir = path.join(stack.root, "state", "worlds", "w1", "logs");
    expect(readdirSync(logsDir)).toEqual(["0001.json"]);
    const entry = JSON.parse(readFileSync(path.join(logsDir, "0001.json"), "utf8"));
    expect(entry.seq).toBe(1);
    expect(entry.prompt).toBe("继续世界：w1。");
    expect(entry.text).toContain("雨停了，石阶泛着冷光。");
    expect(entry.text).toContain("**行动**");
    expect(typeof entry.at).toBe("string");
    expect(entry.cancelled).toBeUndefined(); // 正常回合不带留痕字段（cancelled/error 只出现在取消/失败回合）

    // **不写快照**：重同步回合不推进状态 → history/ 目录压根不建（也不占幕号）
    const histDir = path.join(stack.root, "state", "worlds", "w1", "history");
    expect(existsSync(histDir)).toBe(false);
    const end = stack.events.slice(from).find((e: any) => e.type === "turn_end");
    expect(end).toMatchObject({ turn: 1, main: false, seq: null });

    // 回合自带 **行动** → 守卫不触发：先等日志行刷出（它写在守卫点之后、stdout 有序），
    // 此时仍未出现追问日志，才能证明这一轮没有补发
    await waitFor(() => stack.stdout().includes("turn log written: w1/logs/0001.json"), {
      timeoutMs: 2000,
      intervalMs: 20,
      label: "stdout: turn log written w1/logs/0001.json",
    });
    expect(stack.stdout().includes("自动追问一次")).toBe(false);
  }, 15000);

  it("⑫ 缺 **行动** 的正戏回合：同一 busy 窗口内自动追问一次补齐回合尾，log 记补全后全文；快照与日志各自独立成群", async () => {
    const from = stack.events.length;
    const r = await stack.prompt("自由回合：凑近看她。");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e: any) => e.type === "turn_end"), {
      label: "turn_end(logs-⑫)",
    });
    const got = stack.events.slice(from);

    // 追问属于同一回合：追问补的选项段以 chunk 流进同一回合，且整个窗口只有一次 turn_end
    expect(got.some((e: any) => e.type === "chunk" && String(e.text).includes("雨声忽然大了"))).toBe(true);
    expect(got.some((e: any) => e.type === "chunk" && String(e.text).includes("递伞"))).toBe(true);
    expect(got.filter((e: any) => e.type === "turn_end")).toHaveLength(1);

    // 只追问了一次（若实现成了循环，第二次追问会把「美术：」条目按顺次消费掉，且追问日志会打两遍）
    await waitFor(() => stack.stdout().split("自动追问一次").length - 1 === 1, {
      timeoutMs: 2000,
      intervalMs: 20,
      label: "stdout: 自动追问恰好一次",
    });

    // log 条目：prompt 是玩家输入、text 是补全后的全文（正文 + 追问补的选项段）
    const logsDir = path.join(stack.root, "state", "worlds", "w1", "logs");
    expect(readdirSync(logsDir)).toEqual(["0001.json", "0002.json"]);
    const entry = JSON.parse(readFileSync(path.join(logsDir, "0002.json"), "utf8"));
    expect(entry.prompt).toBe("自由回合：凑近看她。");
    expect(entry.text).toContain("雨声忽然大了");
    expect(entry.text).toContain("**行动**");
    expect(entry.text).toContain("递伞");

    // 快照侧：这是本栈的**第一条真快照**（⑪ 的重同步回合没占号），输入是这一轮的自由输入。
    // 日志与快照的序号从这里开始错位（logs 0002 ↔ history 0001）——append-only 视角下这是对的：
    // 重同步回合有日志没快照，两边各按自己的进度递增，谁都不许回头覆盖。
    const histDir = path.join(stack.root, "state", "worlds", "w1", "history");
    expect(readdirSync(histDir)).toEqual(["0001.json"]);
    expect(JSON.parse(readFileSync(path.join(histDir, "0001.json"), "utf8")).prompt).toBe("自由回合：凑近看她。");
  }, 15000);

  it("⑬ 指令回合（美术：…待命）不写 log；追问守卫也不触发", async () => {
    const logsDir = path.join(stack.root, "state", "worlds", "w1", "logs");
    const histDir = path.join(stack.root, "state", "worlds", "w1", "history");
    const logsBefore = readdirSync(logsDir).length;
    const histBefore = readdirSync(histDir).length;

    const from = stack.events.length;
    const r = await stack.prompt("美术：立绘 新角色。待命：");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), {
      label: "turn_end(logs-⑬)",
    });

    expect(readdirSync(logsDir).length).toBe(logsBefore); // 非正戏回合不产生日志条目
    expect(readdirSync(histDir).length).toBe(histBefore);
    // 仍是 ⑫ 那一次追问，没有新增（轮询等 ⑫ 的日志行落定后再读，避免 pipe 时序抖动）
    await waitFor(() => stack.stdout().split("自动追问一次").length - 1 === 1, {
      timeoutMs: 2000,
      intervalMs: 20,
      label: "stdout: 自动追问恰好一次",
    });
  }, 15000);

  it("⑭ 章末回合（【章】第 1 章 完，每轮协议「以选项结束」的唯一合法例外）不触发追问：log 照写含章标记全文、HTTP 200", async () => {
    const from = stack.events.length;
    const r = await stack.prompt("终章：走进最后一扇门。");
    expect(r.status).toBe(200); // 守卫豁免不产生任何失败路径
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), {
      label: "turn_end(logs-⑭)",
    });

    // 回合缺 **行动** 但带章标记 → 守卫不追问：先等本回合日志行刷出（它在守卫点之后落定），
    // 追问计数仍是 ⑫ 那一次；若误追问，fake 引擎会按顺次消费吃掉后续条目并把「自动追问一次」打成第二遍
    await waitFor(() => stack.stdout().includes("turn log written: w1/logs/0003.json"), {
      timeoutMs: 2000,
      intervalMs: 20,
      label: "stdout: turn log written w1/logs/0003.json",
    });
    expect(stack.stdout().split("自动追问一次").length - 1).toBe(1);

    // log 条目照写（豁免只免追问，不免留痕）：text 是章标记全文的原文回溯
    const logsDir = path.join(stack.root, "state", "worlds", "w1", "logs");
    expect(readdirSync(logsDir)).toEqual(["0001.json", "0002.json", "0003.json"]);
    const entry = JSON.parse(readFileSync(path.join(logsDir, "0003.json"), "utf8"));
    expect(entry.prompt).toBe("终章：走进最后一扇门。");
    expect(entry.text).toContain("【章】第 1 章 完");
    expect(entry.text).toContain("（终章正文）");
  }, 15000);
});

// 剧本导出包（v1.7，bunkiten-preset）：真 HTTP 一条往返——seed 剧本（带 jpg/wav）→ GET export 拿包 →
// POST import（改 id 避免撞名）→ /api/presets 含新 id、/img 与 /audio 直服新剧本文件 200。
const fakeWav = (tag: string) => Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.from(`WAV-${tag}`)]);

describe("集成：剧本导出包导出/导入（bunkiten-preset v1.7）", () => {
  let stack: any;

  beforeAll(async () => {
    stack = await startStack({
      turns: [],
      assets: { demo: [{ name: "立绘-薇拉.jpg", bytes: fakeJpeg("preset-vera") }] },
      audioFiles: { demo: [{ name: "曲-夜灯谣.wav", bytes: fakeWav("preset-bgm") }] },
    });
    // 封面在 preset 根（harness 的 assets 落 assets/ 子目录），按契约手放 presets/demo/cover.jpg
    writeFileSync(path.join(stack.root, "presets", "demo", "cover.jpg"), fakeJpeg("preset-cover"));
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("⑨ GET export 给包与附件名 → POST import（改 id）→ 轮播含新 id、/img 与 /audio 直服新剧本文件", async () => {
    const exp = await stack.getJSON("/api/presets/export?id=demo");
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toBe('attachment; filename="demo.preset.json"');
    expect(exp.body.format).toBe("bunkiten-preset");
    expect(exp.body.version).toBe(1);
    expect(exp.body.id).toBe("demo");
    expect(Object.keys(exp.body.assets).sort()).toEqual(["cover.jpg", "立绘-薇拉.jpg"].sort());
    expect(Object.keys(exp.body.audio)).toEqual(["曲-夜灯谣.wav"]);

    // 导入：改 id 避免撞名（真实分享流程：拿到别人的包原样导回，撞名才让服务端改 -2）
    exp.body.id = "demo-copy";
    const imp = await stack.postJSON("/api/presets", { action: "import", bundle: exp.body });
    expect(imp.status).toBe(200);
    expect(imp.body).toEqual({ ok: true, id: "demo-copy" });

    // 轮播出现新剧本（frontmatter id 行已随落地 id 改写，否则会撞回 demo）
    const list = await stack.getJSON("/api/presets");
    expect(list.body.presets.find((p: any) => p.id === "demo-copy")).toMatchObject({ title: "示例剧本" });

    // /img 与 /audio 直服新剧本落盘的文件，字节与种子一致（往返不损内容）
    const img = await stack.getBytes(imgUrl({ p: "presets/demo-copy/assets/立绘-薇拉.jpg" }));
    expect(img.status).toBe(200);
    expect(img.bytes.equals(fakeJpeg("preset-vera"))).toBe(true);
    const cover = await stack.getBytes(imgUrl({ p: "presets/demo-copy/cover.jpg" }));
    expect(cover.status).toBe(200);
    expect(cover.bytes.equals(fakeJpeg("preset-cover"))).toBe(true);
    const au = await stack.getBytes("/audio?" + new URLSearchParams({ p: "presets/demo-copy/audio/曲-夜灯谣.wav" }));
    expect(au.status).toBe(200);
    expect(au.type).toContain("audio/wav");
    expect(au.bytes.equals(fakeWav("preset-bgm"))).toBe(true);
  }, 15000);

  it("⑩ 错误路径与导览：非法 id 400、不存在 404、非法 bundle 400、未知动作 400、GET / 列出新端点", async () => {
    expect((await stack.getJSON("/api/presets/export?id=" + encodeURIComponent("../etc"))).status).toBe(400);
    expect((await stack.getJSON("/api/presets/export?id=nope")).status).toBe(404);
    expect(
      (
        await stack.postJSON("/api/presets", {
          action: "import",
          bundle: { format: "x", version: 1, id: "x", presetMd: "# y" },
        })
      ).status,
    ).toBe(400);
    expect((await stack.postJSON("/api/presets", { action: "other" })).status).toBe(400);
    // 拒绝后不落盘
    expect(existsSync(path.join(stack.root, "presets", "x"))).toBe(false);

    // 首页导览把新端点列上（curl 排查入口与文档同源）；串以 routes.mjs 的导览行为准，逐条钉住契约
    const home = await stack.getText("/");
    for (const token of [
      "/api/presets(GET,POST:import|delete)", // v1.14：剧本删除也上了同一条
      "/api/presets/export?id=",
      "/api/presets/check?id=",
      "/api/worlds/export?worldId=|?all=1", // v1.14：全量导出
      // v1.14 的一批（取消/状态/日志/回收站/打开目录）
      "/api/engine/cancel",
      "/api/engine/status",
      "/api/logs?worldId=",
      "/api/trash(GET,POST:restore)",
      "/api/open-dir",
    ]) {
      expect(home.body, `导览串缺 ${token}`).toContain(token);
    }
  }, 15000);
});

// 「停止本回合」与迟到隔离（v1.14，P0；docs/adr/0026）：回合序号把取消之后到达的一切挡在门外——
// 迟到的 chunk 不累加也不上屏、迟到的响应不给一个作废的回合补 turn_end。
// 挂起闸的触发方式见 fake-engine.mjs 顶部（prompt 含 `__HOLD__` → 什么都不回、脚本条目不消费；
// 收到 session/cancel 才补一条迟到的正文再回 result，让「迟到要丢弃」有料可测）。
describe("集成：停止本回合 + 迟到隔离 + 失败留痕 + 强制重启（v1.14）", () => {
  let stack: any;

  beforeAll(async () => {
    stack = await startStack({
      turns: [
        { match: "继续世界：w1", ops: ["雨停了，石阶泛着冷光。\n\n**行动**\n1. 推门进去\n"] },
        { match: "取消前正常", ops: ["取消前的正文。\n\n**行动**\n1. 继续\n"] },
        { match: "取消后正常", ops: ["取消后的正文。\n\n**行动**\n1. 继续\n"] },
        { match: "引擎坏", ops: [{ error: "引擎坏了" }] },
        { match: "重启后正常", ops: ["重启后的正文。\n\n**行动**\n1. 继续\n"] },
      ],
    });
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  /** 等自 from 起出现 turn_end（回合收尾的唯一判据） */
  const turnEndAfter = (from: number) =>
    stack.waitFor((ev: any[]) => ev.slice(from).some((e: any) => e.type === "turn_end"), { label: "turn_end" });
  /** 某世界 logs 目录里序号最大的一条（append-only，文件名的 4 位数字排序即序号排序） */
  const lastLog = (worldId: string) => {
    const dir = path.join(stack.root, "state", "worlds", worldId, "logs");
    const names = readdirSync(dir).sort();
    return JSON.parse(readFileSync(path.join(dir, names[names.length - 1]), "utf8"));
  };

  it("停止本回合：cancel → turn_cancelled + busy 复位 + 不写快照；迟到正文丢弃；空闲时 cancelled:false", async () => {
    // 前置：定世界（重同步回合，不落快照）+ 一条真快照，让「取消不落新快照」有真前置
    let from = stack.events.length;
    expect((await stack.prompt("继续世界：w1。")).status).toBe(200);
    await turnEndAfter(from);
    from = stack.events.length;
    expect((await stack.prompt("取消前正常：看看四周。")).status).toBe(200);
    await turnEndAfter(from);

    const histDir = path.join(stack.root, "state", "worlds", "w1", "history");
    const logsDir = path.join(stack.root, "state", "worlds", "w1", "logs");
    const histBefore = readdirSync(histDir).length;
    const logsBefore = readdirSync(logsDir).length;
    expect(histBefore).toBe(1);

    // 挂起回合：引擎收到含 __HOLD__ 的 prompt 后什么都不回 → 这条 /prompt 不会立刻 resolve，
    // 所以**不能 await**（它由下面的取消释放）
    from = stack.events.length;
    const held = stack.prompt("__HOLD__ 这一轮永远回不来。");
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e: any) => e.type === "turn_start"), {
      label: "turn_start(hold)",
    });
    // 忙碌中：「停止」按钮的判据（busy）与对账面（turn）都看得见
    expect((await stack.getJSON("/api/engine/status")).body).toEqual({ busy: true, turn: 3 });

    const cancelled = await stack.postJSON("/api/engine/cancel", {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ ok: true, cancelled: true });
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e: any) => e.type === "turn_cancelled"), {
      label: "turn_cancelled",
    });
    expect(stack.events.slice(from).find((e: any) => e.type === "turn_cancelled").turn).toBe(3);

    // 挂起的那条 /prompt 由取消释放（假引擎补迟到正文 + 回 result）→ 被取消的回合回 ok、HTTP 200
    //（玩家自己要停的，不是失败回合）
    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    expect(heldRes.body.ok).toBe(true);

    // busy 复位：状态面直接可见
    expect((await stack.getJSON("/api/engine/status")).body.busy).toBe(false);

    // 迟到的一切都被回合序号丢弃：没有 turn_end、没有那条「迟到的正文」
    const after = stack.events.slice(from);
    expect(after.some((e: any) => e.type === "turn_end")).toBe(false);
    expect(after.some((e: any) => e.type === "chunk" && String(e.text).includes("迟到的正文"))).toBe(false);

    // 不写快照；日志留痕（cancelled:true、prompt = 这一轮的输入、text = 已产出片段（空））
    expect(readdirSync(histDir).length).toBe(histBefore);
    expect(readdirSync(logsDir).length).toBe(logsBefore + 1);
    const log = lastLog("w1");
    expect(log.cancelled).toBe(true);
    expect(log.prompt).toBe("__HOLD__ 这一轮永远回不来。");
    expect(log.text).toBe("");

    // 空闲时再取消：cancelled:false（幂等，不是错误——客户端可能比服务端先知道回合收尾了）
    expect((await stack.postJSON("/api/engine/cancel", {})).body).toEqual({ ok: true, cancelled: false });

    // 取消之后一切照旧：下一回合照常跑完并落快照（迟到隔离没有把流水线卡住）
    from = stack.events.length;
    expect((await stack.prompt("取消后正常：再看看四周。")).status).toBe(200);
    await turnEndAfter(from);
    expect(readdirSync(histDir).length).toBe(histBefore + 1);
  }, 20000);

  it("失败回合（引擎 error）：error 事件带 stale + turn，logs 留 error 字段，busy 复位", async () => {
    const from = stack.events.length;
    const r = await stack.prompt("引擎坏：这一轮必失败。");
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("引擎坏了");

    // SSE 与 HTTP 走两条连接：409 已经回来不代表事件帧也到了测试端的 events 数组——显式等一次
    //（与 ⑧ 同款；直接读 slice 会偶发撞上「响应先到、事件帧还在路上」的时序）
    await stack.waitFor(
      (ev: any[]) => ev.slice(from).some((e: any) => e.type === "error" && String(e.error).includes("引擎坏了")),
      { label: "error(失败回合)" },
    );
    const got = stack.events.slice(from);
    const err = got.find((e: any) => e.type === "error");
    expect(String(err.error)).toContain("引擎坏了"); // 冻结事件面里的字段名
    expect(err.message).toBe(err.error); // 既有客户端字段暂时并存（AcpEvent 还在读 message）
    expect(err.stale).toBe(true); // 引擎可能写了一半盘 → 客户端该先重同步
    expect(typeof err.turn).toBe("number");
    expect(got.some((e: any) => e.type === "turn_end")).toBe(false); // 失败回合不走成功收尾

    // 失败留痕：log 条目带 error 字段（prompt 原文 + 已产出的 text 都在）
    const log = lastLog("w1");
    expect(String(log.error)).toContain("引擎坏了");
    expect(log.prompt).toBe("引擎坏：这一轮必失败。");
    expect(log.cancelled).toBeUndefined();

    expect((await stack.getJSON("/api/engine/status")).body).toEqual({ busy: false, turn: 5 });
  }, 15000);

  it("忙碌中强制重启：不带 force 仍 409；force:true 先停本回合再换会话（探针多一条 start，新会话可用）", async () => {
    const from = stack.events.length;
    const held = stack.prompt("__HOLD__ 挂住等重启。");
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e: any) => e.type === "turn_start"), {
      label: "turn_start(restart-hold)",
    });
    expect((await stack.getJSON("/api/engine/status")).body).toEqual({ busy: true, turn: 6 });

    // 老语义：忙碌中重启被拒（宁可让玩家等这一回合结束）
    const denied = await stack.postJSON("/api/engine/restart", {});
    expect(denied.status).toBe(409);
    expect(String(denied.body.error)).toContain("正在演绎");

    // force：停本回合（turn_cancelled）→ 杀旧进程 → 拉新会话并握手 → 真重 spawn
    const startsBefore = stack.engineProbeEntries().filter((e: any) => e.kind === "start").length;
    const forced = await stack.postJSON("/api/engine/restart", { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.ok).toBe(true);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e: any) => e.type === "turn_cancelled"), {
      label: "turn_cancelled(force)",
    });
    expect(stack.engineProbeEntries().filter((e: any) => e.kind === "start").length).toBe(startsBefore + 1);

    // 挂住的那条 /prompt 由「旧进程被杀」收尾（acp.mjs 在 exit 时把在途请求就地失败）→ 已取消的回合回 ok
    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    expect(heldRes.body.ok).toBe(true);
    expect((await stack.getJSON("/api/engine/status")).body.busy).toBe(false);

    // 新会话可用：下一个正戏回合照常跑完
    const from2 = stack.events.length;
    expect((await stack.prompt("重启后正常：继续演。")).status).toBe(200);
    await turnEndAfter(from2);
  }, 30000);
});
