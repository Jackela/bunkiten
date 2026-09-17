// 集成测试（CONTRACTS §1/§2/§3）：音频协议、逐轮快照与精确回退、世界线导出/导入、素材批量删除。
// 与 pipeline.test.ts 同栈形态：假 ACP 引擎（PATH 垫片 bin/grok）+ 真 server/acp-server.mjs 子进程，全程离线。
//
// 覆盖：
//   【曲】/【环境】/【音效】→ SSE audio 事件
//   /api/audio 列表（preset 必填/非法 400）
//   /audio?p= 直服（各扩展名 MIME）+ 目录穿越 404
//   正戏回合落盘 history/NNNN.json 且 nodeId 正确、规划回合不落盘、内容相同去重
//   fork 带 seq → 新世界三文件与快照逐字一致
//   restore → 生成 backup 条目
//   export → import 往返一致（含重名后缀）
//   素材 delete 后 /api/assets 不再列出
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startStack } from "./harness.mjs";

// URL 查询串构造：中文文件名与 `/` 会被正确百分号编码（服务器侧 searchParams 再解回）
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const w1Dir = (stack: any) => path.join(stack.root, "state", "worlds", "w1");
const readWorldFile = (dir: string, name: string) => readFileSync(path.join(dir, name), "utf8");

// 轮询等待 stdout 断言出现（server 的日志行异步刷出）
async function until(pred: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

describe("集成：音频协议（CONTRACTS §1）", () => {
  let stack: any;

  beforeAll(async () => {
    stack = await startStack({
      turns: [{ match: "音乐", ops: ["雨夜，教堂檐下。\n\n【曲】雨夜\n【环境】旅店大堂\n【音效】门响\n"] }],
    });
    // 作者手放的音频：5 种扩展名各一 + 两个应被忽略的文件
    const audioDir = path.join(stack.root, "presets", "demo", "audio");
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(path.join(audioDir, "曲-雨夜.mp3"), Buffer.from("ID3-BGM-RAIN"));
    writeFileSync(path.join(audioDir, "环境-旅店大堂.ogg"), Buffer.from("OggS-AMBIENT"));
    writeFileSync(path.join(audioDir, "音效-门响.wav"), Buffer.from("RIFF-SFX"));
    writeFileSync(path.join(audioDir, "曲-主题.m4a"), Buffer.from("M4A-THEME"));
    writeFileSync(path.join(audioDir, "环境-风声.flac"), Buffer.from("FLAC-WIND"));
    writeFileSync(path.join(audioDir, "readme.txt"), "not audio");
    writeFileSync(path.join(audioDir, "未知-噪声.mp3"), "bad kind");
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("① 【曲】/【环境】/【音效】逐行 → SSE audio 事件（kind/name 原样）", async () => {
    const from = stack.events.length;
    const r = await stack.prompt("放点音乐吧。");
    expect(r.status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(audio)" });
    const got = stack.events.slice(from).filter((e: any) => e.type === "audio");
    expect(got).toEqual([
      { type: "audio", kind: "曲", name: "雨夜" },
      { type: "audio", kind: "环境", name: "旅店大堂" },
      { type: "audio", kind: "音效", name: "门响" },
    ]);
  }, 15000);

  it("② /api/audio：preset 必填且过白名单；列出 <类型>-<名>.<ext>（url 指向 /audio?p=）", async () => {
    expect((await stack.getJSON("/api/audio")).status).toBe(400); // 缺 preset
    expect((await stack.getJSON("/api/audio?preset=" + encodeURIComponent("../etc"))).status).toBe(400); // 非法 preset
    expect((await stack.getJSON("/api/audio?preset=" + encodeURIComponent("a/b"))).status).toBe(400);

    const r = await stack.getJSON("/api/audio?preset=demo");
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ kind: string; name: string; file: string; url: string }>;
    // 只列 5 个合规文件（readme.txt / 未知-噪声.mp3 被忽略）
    expect(items).toHaveLength(5);
    // url 里的文件名百分号编码（文件名可含 &/?/#/空格）；fetch 该 url 时服务端解回原值直服
    expect(items.find((i) => i.name === "雨夜")).toEqual({
      kind: "曲",
      name: "雨夜",
      file: "曲-雨夜.mp3",
      url: "/audio?p=presets/demo/audio/%E6%9B%B2-%E9%9B%A8%E5%A4%9C.mp3",
    });
    expect(items.some((i) => i.file === "readme.txt")).toBe(false);
    expect(items.some((i) => i.name === "噪声")).toBe(false);

    // 无 audio 目录的剧本 → 空清单（不报错）
    const other = await stack.getJSON("/api/audio?preset=other");
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
  }, 15000);

  it("③ /audio?p=：整文件直服 + 各扩展名 MIME + 长缓存；目录穿越/非法扩展名 404", async () => {
    const cases: Array<[string, string, string]> = [
      ["曲-雨夜.mp3", "ID3-BGM-RAIN", "audio/mpeg"],
      ["环境-旅店大堂.ogg", "OggS-AMBIENT", "audio/ogg"],
      ["音效-门响.wav", "RIFF-SFX", "audio/wav"],
      ["曲-主题.m4a", "M4A-THEME", "audio/mp4"],
      ["环境-风声.flac", "FLAC-WIND", "audio/flac"],
    ];
    for (const [file, body, mime] of cases) {
      const r = await stack.getBytes("/audio?" + q({ p: `presets/demo/audio/${file}` }));
      expect(r.status).toBe(200);
      expect(r.type).toBe(mime);
      expect(r.bytes.toString()).toBe(body);
    }
    // 缓存头（与 /img 同款长缓存）
    const one = await stack.getText("/audio?" + q({ p: "presets/demo/audio/曲-雨夜.mp3" }));
    expect(one.headers.get("cache-control")).toBe("public, max-age=86400");

    // 目录穿越 / 非法形态一律 404
    const bad = [
      { p: "presets/demo/audio/../../../etc/passwd" },
      { p: "presets/../server/acp-server.mjs" },
      { p: "presets/demo/assets/立绘-薇拉.jpg" }, // 不在 audio/ 下
      { p: "presets/demo/audio/x.txt" }, // 扩展名不在白名单
      { p: "" },
    ];
    for (const params of bad) {
      const r = await stack.getBytes("/audio?" + q(params));
      expect(r.status).toBe(404);
    }

    // 用 /api/audio 给出的 url 直接播放（中文文件名原样可直服）
    const items = (await stack.getJSON("/api/audio?preset=demo")).body.items as Array<{ url: string; file: string }>;
    const bgm = items.find((i) => i.file === "曲-雨夜.mp3")!;
    const played = await stack.getBytes(bgm.url);
    expect(played.status).toBe(200);
    expect(played.bytes.toString()).toBe("ID3-BGM-RAIN");
  }, 15000);
});

describe("集成：逐轮快照 + 世界线精确回退/导出导入（CONTRACTS §2/§3）", () => {
  let stack: any;

  beforeAll(async () => {
    // 无脚本回合：提示词回放空通知即可（快照/分叉/导入都不依赖引擎输出）
    stack = await startStack({ turns: [] });
  }, 30000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("④ 正戏回合落盘 history/0001.json（nodeId 正确）；规划回合不落盘；内容相同去重", async () => {
    const histDir = path.join(w1Dir(stack), "history");
    expect(existsSync(histDir)).toBe(false); // 开局前没有快照

    // 续玩指令 → sniffPreset 记下 currentWorldId=w1（该指令本身是正戏回合）
    let from = stack.events.length;
    expect((await stack.prompt("继续世界：w1。")).status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(history-1)" });
    expect(readdirSync(histDir)).toEqual(["0001.json"]);
    const snap = JSON.parse(readFileSync(path.join(histDir, "0001.json"), "utf8"));
    expect(snap).toMatchObject({ seq: 1, kind: "turn", nodeId: "1-1", chapterNo: 1 });
    expect(snap.files.tree).toContain("节点 1-1"); // 与世界磁盘一致
    expect(snap.files.state).toBe(readWorldFile(w1Dir(stack), "state.md"));

    // 自由输入：世界段缺失 → 保持 currentWorldId=w1；三文件没变 → 内容全等去重
    from = stack.events.length;
    expect((await stack.prompt("看看四周。")).status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(history-2)" });
    expect(readdirSync(histDir)).toEqual(["0001.json"]); // 不产生重复条目

    // /api/history：升序元信息；带 seq 附 files
    const meta = await stack.getJSON("/api/history?worldId=w1");
    expect(meta.status).toBe(200);
    expect(meta.body.snapshots.map((s: any) => s.seq)).toEqual([1]);
    expect(meta.body.snapshots[0].files).toBeUndefined();
    const one = await stack.getJSON("/api/history?worldId=w1&seq=1");
    expect(one.body.snapshots[0].files.state).toBe(readWorldFile(w1Dir(stack), "state.md"));
    expect((await stack.getJSON("/api/history?worldId=" + encodeURIComponent("../etc"))).status).toBe(400);

    // 规划回合 → 判定为非正戏，不落盘
    from = stack.events.length;
    expect((await stack.prompt("规划：第 2 章。")).status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(history-3)" });
    expect(readdirSync(histDir)).toEqual(["0001.json"]);

    // 档位分档（CONTRACTS §4）：规划回合切到 EFFORT_PLANNING（默认 low），正戏回合不动档
    expect(await until(() => stack.stdout().includes("reasoning_effort -> low"))).toBe(true);
  }, 20000);

  it("⑤ fork 带 seq → 新世界三文件与快照逐字一致，索引标「精确快照」", async () => {
    const snapFiles = {
      state: readWorldFile(w1Dir(stack), "state.md"),
      summary: readWorldFile(w1Dir(stack), "summary.md"),
      tree: readWorldFile(w1Dir(stack), "story-tree.md"),
    };
    const r = await stack.postJSON("/api/worlds", { action: "fork", worldId: "w1", nodeId: "1-1", seq: 1 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.worldId).toMatch(/^demo-\d+$/);
    expect(r.body.entry.forkedFrom).toEqual({ worldId: "w1", nodeId: "1-1", seq: 1 });
    expect(r.body.entry.note).toContain("精确快照");

    const fdir = path.join(stack.root, "state", "worlds", r.body.worldId);
    expect(readWorldFile(fdir, "state.md")).toBe(snapFiles.state); // 逐字一致
    expect(readWorldFile(fdir, "summary.md")).toBe(snapFiles.summary);
    expect(readWorldFile(fdir, "story-tree.md")).toBe(snapFiles.tree); // 精确路径不改树
    expect(existsSync(path.join(fdir, "fork.md"))).toBe(true);
  }, 15000);

  it("⑥ restore：先写 kind:backup 条目再覆盖为目标快照，返回 backupSeq", async () => {
    const histDir = path.join(w1Dir(stack), "history");
    const before = readWorldFile(w1Dir(stack), "state.md");
    const r = await stack.postJSON("/api/worlds", { action: "restore", worldId: "w1", seq: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, backupSeq: 2 });

    const files = readdirSync(histDir).sort();
    expect(files).toEqual(["0001.json", "0002.json"]);
    const backup = JSON.parse(readFileSync(path.join(histDir, "0002.json"), "utf8"));
    expect(backup).toMatchObject({ seq: 2, kind: "backup" });
    expect(backup.files.state).toBe(before);
    expect(readWorldFile(w1Dir(stack), "state.md")).toBe(before); // 内容本就一致（覆盖无副作用）

    // 不存在的快照 → 400
    expect((await stack.postJSON("/api/worlds", { action: "restore", worldId: "w1", seq: 99 })).status).toBe(400);
  }, 15000);

  it("⑦ export → import 往返一致（含重名后缀）", async () => {
    const exp = await stack.getJSON("/api/worlds/export?worldId=w1");
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toBe('attachment; filename="w1.world.json"');
    const bundle = exp.body;
    expect(bundle.format).toBe("bunkiten-world");
    expect(bundle.version).toBe(1);
    expect(bundle.world.worldId).toBe("w1");
    expect(bundle.world.snapshots.map((s: any) => s.seq)).toEqual([1, 2]); // 含 ⑥ 的 backup

    const imp = await stack.postJSON("/api/worlds", { action: "import", bundle });
    expect(imp.status).toBe(200);
    expect(imp.body.worldId).toBe("w1-2"); // 重名后缀
    const idir = path.join(stack.root, "state", "worlds", "w1-2");
    expect(readWorldFile(idir, "state.md")).toBe(bundle.world.files.state);
    expect(readWorldFile(idir, "story-tree.md")).toBe(bundle.world.files.tree);
    expect(readdirSync(path.join(idir, "history")).sort()).toEqual(["0001.json", "0002.json"]);
    // 索引：note 追加「（导入）」
    const worlds = await stack.getJSON("/api/worlds");
    const entry = worlds.body.worlds.find((w: any) => w.worldId === "w1-2");
    expect(entry.note.endsWith("（导入）")).toBe(true);

    // 二次导入 → w1-3
    expect((await stack.postJSON("/api/worlds", { action: "import", bundle })).body.worldId).toBe("w1-3");

    // 非法 bundle → 400
    expect((await stack.postJSON("/api/worlds", { action: "import", bundle: { format: "x", version: 1, world: { worldId: "w1" } } })).status).toBe(400);
    expect((await stack.postJSON("/api/worlds", { action: "import", bundle: { format: "bunkiten-world", version: 1, world: { worldId: "../etc" } } })).status).toBe(400);
  }, 15000);

  it("⑧ update（label/note 校验）与素材 delete（/api/assets 不再列出）", async () => {
    // update：label 写入、note 空串清除、越界 400
    const upd = await stack.postJSON("/api/worlds", { action: "update", worldId: "w1", label: "第一周目", note: "雨夜开场" });
    expect(upd.status).toBe(200);
    expect(upd.body.entry).toMatchObject({ label: "第一周目", note: "雨夜开场" });
    const worlds = await stack.getJSON("/api/worlds");
    expect(worlds.body.worlds.find((w: any) => w.worldId === "w1").label).toBe("第一周目");
    expect((await stack.postJSON("/api/worlds", { action: "update", worldId: "w1", label: "字".repeat(61) })).status).toBe(400);
    expect((await stack.postJSON("/api/worlds", { action: "update", worldId: "w1", note: "字".repeat(201) })).status).toBe(400);

    // 素材 delete：先落一个立绘
    const file = path.join(stack.root, "presets", "demo", "assets", "立绘-可删.jpg");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const before = await stack.getJSON("/api/assets?preset=demo");
    expect(before.body.some((a: any) => a.file === "presets/demo/assets/立绘-可删.jpg")).toBe(true);

    const del = await stack.postJSON("/api/assets", { action: "delete", preset: "demo", file: "立绘-可删.jpg" });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    expect(del.body.trashed).toBe(true); // v1.7：删除进回收站（EXDEV 回退直删时才是 false）
    expect(existsSync(file)).toBe(false);
    // 回收站：state/trash/<ts>-<rand4>-立绘-可删.jpg 还在（不自动清理），但扫描面看不到它
    const trashDir = path.join(stack.root, "state", "trash");
    const trashedItems = readdirSync(trashDir).filter((f) => f.endsWith("-立绘-可删.jpg"));
    expect(trashedItems.length).toBe(1);
    expect(existsSync(path.join(trashDir, trashedItems[0]))).toBe(true);
    const after = await stack.getJSON("/api/assets?preset=demo");
    expect(after.body.some((a: any) => a.file === "presets/demo/assets/立绘-可删.jpg")).toBe(false);

    // 404 / 400 语义
    expect((await stack.postJSON("/api/assets", { action: "delete", preset: "demo", file: "立绘-不存在.jpg" })).status).toBe(404);
    expect((await stack.postJSON("/api/assets", { action: "delete", preset: "demo", file: "cover.jpg" })).status).toBe(400); // 封面不可删
    expect((await stack.postJSON("/api/assets", { action: "delete", preset: "demo", file: "../x.jpg" })).status).toBe(400); // 穿越
    expect((await stack.postJSON("/api/assets", { action: "delete", preset: "../etc", file: "a.jpg" })).status).toBe(400); // preset 非法
    expect((await stack.postJSON("/api/assets", { action: "nope", preset: "demo", file: "a.jpg" })).status).toBe(400);
  }, 15000);
});
