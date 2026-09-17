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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startStack } from "./harness.mjs";

// 可辨识的假 JPEG 字节（内容断言用）：JPEG SOI 前缀 + 可读标记
const fakeJpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`BUNKITEN-${tag}`)]);
// /img 查询串构造：URLSearchParams 会把 chinese 与 `/` 正确百分号编码（穿越用例依赖这个）
const imgUrl = (params: Record<string, string>) => "/img?" + new URLSearchParams(params).toString();
// 轮询等待（stdout 断言用；events 用 stack.waitFor）
async function until(pred: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

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
    expect(stack.events.some((e: any) => e.type === "chunk" && String(e.text).includes("【图】立绘|薇拉|images/1.jpg"))).toBe(true);

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
    const payloads = [
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
    expect(got.findIndex((e: any) => e.type === "treeEdited")).toBeLessThan(got.findIndex((e: any) => e.type === "turn_end"));
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
    expect((await stack.postJSON("/api/worlds", { action: "fork", worldId: "nope-1", nodeId: "1-1" })).status).toBe(400);

    // delete 冒烟（删掉 create 出来的那个）
    const deleted = await stack.postJSON("/api/worlds", { action: "delete", worldId: created.body.worldId });
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
    expect(existsSync(path.join(stack.root, "state", "worlds", created.body.worldId))).toBe(false);
  }, 15000);

  it("⑧ 引擎回 JSON-RPC error response：POST /prompt 409、SSE 广播 error、不写逐轮快照", async () => {
    // 先把当前世界定下来（否则 sendPrompt 本就不会写快照，负向断言没有意义）
    const fromEnter = stack.events.length;
    const enter = await stack.prompt("继续世界：w1。");
    expect(enter.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(fromEnter).some((e) => e.type === "turn_end"), { label: "turn_end(⑧-enter)" });
    const histDir = path.join(stack.root, "state", "worlds", "w1", "history");
    const countSnapshots = () => (existsSync(histDir) ? readdirSync(histDir).length : 0);
    const before = countSnapshots();
    expect(before).toBeGreaterThan(0); // 入场是正戏回合：已落一条快照

    const from = stack.events.length;
    const r = await stack.prompt("让引擎坏掉的一轮。");
    // sendPrompt 必须把引擎的 error response 当失败回合：HTTP 409 + error 语义（此前被当成功 200）
    expect(r.status).toBe(409);
    expect(String(r.body?.error)).toContain("引擎坏了");
    await stack.waitFor(
      (ev: any[]) => ev.slice(from).some((e: any) => e.type === "error" && String(e.message).includes("引擎坏了")),
      { label: "error(⑧)" },
    );
    const got = stack.events.slice(from);
    expect(got.some((e: any) => e.type === "turn_end")).toBe(false); // 失败回合不许走成功收尾
    expect(countSnapshots()).toBe(before); // 也不落快照：失败回合不产生「这一轮」的档
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
    expect(await until(() => stack.stdout().includes("current preset: demo (world w1)"))).toBe(true);

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
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(⑥-free)" });
    const still = await stack.getBytes(imgUrl({ p: "assets/立绘-林夏.jpg" }));
    expect(still.status).toBe(200);
    expect(still.bytes.equals(fakeJpeg("linxia-demo"))).toBe(true);
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
      (await stack.postJSON("/api/presets", { action: "import", bundle: { format: "x", version: 1, id: "x", presetMd: "# y" } })).status,
    ).toBe(400);
    expect((await stack.postJSON("/api/presets", { action: "other" })).status).toBe(400);
    // 拒绝后不落盘
    expect(existsSync(path.join(stack.root, "presets", "x"))).toBe(false);

    // 首页导览把两个新端点列上（curl 排查入口与文档同源）
    const home = await stack.getText("/");
    expect(home.body).toContain("/api/presets(GET,POST:import)");
    expect(home.body).toContain("/api/presets/export?id=");
  }, 15000);
});
