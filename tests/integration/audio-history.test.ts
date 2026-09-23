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
//   export → import 往返一致（含重名后缀；v2 包带 forkedFrom/fork.md、v1 包照收）
//   素材 delete 后 /api/assets 不再列出
//   索引 schema 的启动迁移（ROADMAP §1）：旧裸数组升起、未来 schema 读得到且不被降级写回
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

  it("④ 正戏回合落盘 history/0001.json（nodeId 正确、续玩指令的 prompt 为空）；规划回合不落盘；files+prompt 全等才去重", async () => {
    const histDir = path.join(w1Dir(stack), "history");
    expect(existsSync(histDir)).toBe(false); // 开局前没有快照

    // 续玩指令 → sniffPreset 记下 currentWorldId=w1（该指令本身是正戏回合）
    let from = stack.events.length;
    expect((await stack.prompt("继续世界：w1。")).status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(history-1)" });
    expect(readdirSync(histDir)).toEqual(["0001.json"]);
    const snap = JSON.parse(readFileSync(path.join(histDir, "0001.json"), "utf8"));
    expect(snap).toMatchObject({ seq: 1, kind: "turn", nodeId: "1-1", chapterNo: 1 });
    // 续玩/开局是客户端生成的指令、不是玩家的话：prompt 回填空串（重演入口据此给降级提示，docs/adr/0023）
    expect(snap.prompt).toBe("");
    expect(snap.files.tree).toContain("节点 1-1"); // 与世界磁盘一致
    expect(snap.files.state).toBe(readWorldFile(w1Dir(stack), "state.md"));

    // 自由输入：世界段缺失 → 保持 currentWorldId=w1；三文件没变、但输入是新的 → 仍落一条
    //（v1.13 去重是 files + prompt 全等：files 相同 ≠ 同一幕——这条不变量是重演的地基）
    from = stack.events.length;
    expect((await stack.prompt("看看四周。")).status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(history-2)" });
    expect(readdirSync(histDir)).toEqual(["0001.json", "0002.json"]);
    expect(JSON.parse(readFileSync(path.join(histDir, "0002.json"), "utf8")).prompt).toBe("看看四周。");

    // /api/history：升序元信息；带 seq 附 files 与 prompt，列表形态两样都不带
    const meta = await stack.getJSON("/api/history?worldId=w1");
    expect(meta.status).toBe(200);
    expect(meta.body.snapshots.map((s: any) => s.seq)).toEqual([1, 2]);
    expect(meta.body.snapshots[0].files).toBeUndefined();
    expect(meta.body.snapshots[0].prompt).toBeUndefined();
    const one = await stack.getJSON("/api/history?worldId=w1&seq=2");
    expect(one.body.snapshots[0].files.state).toBe(readWorldFile(w1Dir(stack), "state.md"));
    expect(one.body.snapshots[0].prompt).toBe("看看四周。");

    // 存档点命名（v1.12）：名字写进世界索引（snapshotLabels），**不碰快照文件**；/api/history 两条路都带出来
    const before = readFileSync(path.join(histDir, "0001.json"), "utf8");
    expect((await stack.postJSON("/api/worlds", { action: "labelSnapshot", worldId: "w1", seq: 1, label: "雨夜遇袭前" })).status).toBe(200);
    expect(readFileSync(path.join(histDir, "0001.json"), "utf8")).toBe(before); // append-only 的引擎真相一字不动
    expect((await stack.getJSON("/api/history?worldId=w1")).body.snapshots[0].label).toBe("雨夜遇袭前");
    expect((await stack.getJSON("/api/history?worldId=w1&seq=1")).body.snapshots[0].label).toBe("雨夜遇袭前");
    // 清除：空串 → 名字没了（快照本身仍在）
    expect((await stack.postJSON("/api/worlds", { action: "labelSnapshot", worldId: "w1", seq: 1, label: "" })).status).toBe(200);
    expect((await stack.getJSON("/api/history?worldId=w1")).body.snapshots[0].label).toBe("");
    expect((await stack.getJSON("/api/history?worldId=" + encodeURIComponent("../etc"))).status).toBe(400);

    // 规划回合 → 判定为非正戏，不落盘
    from = stack.events.length;
    expect((await stack.prompt("规划：第 2 章。")).status).toBe(200);
    await stack.waitFor((ev: any[]) => ev.slice(from).some((e) => e.type === "turn_end"), { label: "turn_end(history-3)" });
    expect(readdirSync(histDir)).toEqual(["0001.json", "0002.json"]);

    // 档位分档（CONTRACTS §4）：规划回合切到 EFFORT_PLANNING（默认 low），正戏回合不动档
    expect(await until(() => stack.stdout().includes("reasoning_effort -> low"))).toBe(true);
  }, 20000);

  it("⑤ fork 带 seq → 新世界三文件与快照逐字一致，索引记 forkedFrom.seq", async () => {
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
    expect(r.body.entry.note).toBe(""); // 血缘不进 note（v1.7.1：不再写「分叉自 … @ …」裸 id 串）

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
    expect(r.body).toEqual({ ok: true, backupSeq: 3 });

    const files = readdirSync(histDir).sort();
    expect(files).toEqual(["0001.json", "0002.json", "0003.json"]);
    const backup = JSON.parse(readFileSync(path.join(histDir, "0003.json"), "utf8"));
    expect(backup).toMatchObject({ seq: 3, kind: "backup" });
    expect(backup.prompt).toBe(""); // backup 没有输入（也不该被重演入口当一幕）
    expect(backup.files.state).toBe(before);
    expect(readWorldFile(w1Dir(stack), "state.md")).toBe(before); // 内容本就一致（覆盖无副作用）

    // 不存在的快照 → 400
    expect((await stack.postJSON("/api/worlds", { action: "restore", worldId: "w1", seq: 99 })).status).toBe(400);
  }, 15000);

  it("⑦ export → import 往返一致（含重名后缀；v3 包带血缘、fork.md 与重演输入，v1 包照收）", async () => {
    const exp = await stack.getJSON("/api/worlds/export?worldId=w1");
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toBe('attachment; filename="w1.world.json"');
    const bundle = exp.body;
    expect(bundle.format).toBe("bunkiten-world");
    expect(bundle.version).toBe(3); // v3（v1.13）：快照条目多一个 prompt，其余键序不变
    expect(bundle.world.worldId).toBe("w1");
    // w1 是根世界：两个键都在、值都是 null（缺键与 null 是两种意思，v1 包才是「缺键」）
    expect(bundle.world.forkedFrom).toBe(null);
    expect(bundle.world.forkMd).toBe(null);
    expect(bundle.world.snapshots.map((s: any) => s.seq)).toEqual([1, 2, 3]); // 含 ⑥ 的 backup
    // 输入随包走（存档自洽：换台机器也能重演）；续玩条目与 backup 为空串
    expect(bundle.world.snapshots.map((s: any) => s.prompt)).toEqual(["", "看看四周。", ""]);

    const imp = await stack.postJSON("/api/worlds", { action: "import", bundle });
    expect(imp.status).toBe(200);
    expect(imp.body.worldId).toBe("w1-2"); // 重名后缀
    const idir = path.join(stack.root, "state", "worlds", "w1-2");
    expect(readWorldFile(idir, "state.md")).toBe(bundle.world.files.state);
    expect(readWorldFile(idir, "story-tree.md")).toBe(bundle.world.files.tree);
    expect(readdirSync(path.join(idir, "history")).sort()).toEqual(["0001.json", "0002.json", "0003.json"]);
    expect(JSON.parse(readFileSync(path.join(idir, "history", "0002.json"), "utf8")).prompt).toBe("看看四周。"); // prompt 活过导入
    expect(existsSync(path.join(idir, "fork.md"))).toBe(false); // 根世界没有分叉说明
    // 索引：note 追加「（导入）」
    const worlds = await stack.getJSON("/api/worlds");
    const entry = worlds.body.worlds.find((w: any) => w.worldId === "w1-2");
    expect(entry.note.endsWith("（导入）")).toBe(true);

    // 二次导入 → w1-3
    expect((await stack.postJSON("/api/worlds", { action: "import", bundle })).body.worldId).toBe("w1-3");

    // —— ⑤ 建出的分叉世界（w1@1-1 的精确快照）：血缘与 fork.md 必须活过往返 ——
    const forked = (worlds.body.worlds as any[]).find((w) => w.forkedFrom);
    expect(forked, "⑤ 的分叉世界不在索引里（本用例依赖 ⑤ 先跑）").toBeTruthy();
    const forkMd = readWorldFile(path.join(stack.root, "state", "worlds", forked.worldId), "fork.md");
    const fexp = await stack.getJSON(`/api/worlds/export?worldId=${forked.worldId}`);
    expect(fexp.status).toBe(200);
    // 下载文件名行为不变（还是 <worldId>.world.json）
    expect(fexp.headers.get("content-disposition")).toBe(`attachment; filename="${forked.worldId}.world.json"`);
    expect(fexp.body.version).toBe(3);
    expect(fexp.body.world.forkedFrom).toEqual({ worldId: "w1", nodeId: "1-1", seq: 1 });
    expect(fexp.body.world.forkMd).toBe(forkMd); // 逐字（含分叉时间戳）

    const fimp = await stack.postJSON("/api/worlds", { action: "import", bundle: fexp.body });
    expect(fimp.status).toBe(200);
    const fdir = path.join(stack.root, "state", "worlds", fimp.body.worldId);
    expect(readWorldFile(fdir, "fork.md")).toBe(forkMd);
    const after = (await stack.getJSON("/api/worlds")).body.worlds as any[];
    // 家谱只读 forkedFrom：seq 一起回来，导入回来的分叉线才不会变成根
    expect(after.find((w) => w.worldId === fimp.body.worldId).forkedFrom).toEqual({ worldId: "w1", nodeId: "1-1", seq: 1 });

    // v1 包（没有血缘键、快照条目也没有 prompt 字段）照收：forkedFrom null、不落 fork.md、
    // prompt normalize 为空串——「接受旧版本」不许在下一次重构里被顺手收紧
    const v1 = { ...fexp.body, version: 1, world: { ...fexp.body.world } };
    delete v1.world.forkedFrom;
    delete v1.world.forkMd;
    v1.world.snapshots = v1.world.snapshots.map((s: any) => ({
      seq: s.seq, at: s.at, kind: s.kind, nodeId: s.nodeId, chapterNo: s.chapterNo, files: s.files,
    }));
    const v1imp = await stack.postJSON("/api/worlds", { action: "import", bundle: v1 });
    expect(v1imp.status).toBe(200);
    expect(existsSync(path.join(stack.root, "state", "worlds", v1imp.body.worldId, "fork.md"))).toBe(false);
    expect((await stack.getJSON("/api/worlds")).body.worlds.find((w: any) => w.worldId === v1imp.body.worldId).forkedFrom).toBe(null);

    // v2 包（有快照、但条目没有 prompt 字段）同样照收：normalize 为空串（重演入口给降级提示）
    const v2 = { ...bundle, version: 2, world: { ...bundle.world, snapshots: bundle.world.snapshots.map((s: any) => ({
      seq: s.seq, at: s.at, kind: s.kind, nodeId: s.nodeId, chapterNo: s.chapterNo, files: s.files,
    })) } };
    const v2imp = await stack.postJSON("/api/worlds", { action: "import", bundle: v2 });
    expect(v2imp.status).toBe(200);
    const v2snap = JSON.parse(readFileSync(path.join(stack.root, "state", "worlds", v2imp.body.worldId, "history", "0002.json"), "utf8"));
    expect(v2snap.prompt).toBe(""); // 缺字段 → 唯一形状入口收敛为空串

    // 非法 bundle → 400
    expect((await stack.postJSON("/api/worlds", { action: "import", bundle: { format: "x", version: 1, world: { worldId: "w1" } } })).status).toBe(400);
    expect((await stack.postJSON("/api/worlds", { action: "import", bundle: { format: "bunkiten-world", version: 1, world: { worldId: "../etc" } } })).status).toBe(400);
    // 版本过新（> WORLD_BUNDLE_VERSION=3）→ 400（版本闸是唯一上限判据，客户端不许再抄一份）
    expect((await stack.postJSON("/api/worlds", { action: "import", bundle: { format: "bunkiten-world", version: 4, world: { worldId: "w1" } } })).status).toBe(400);
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

  it("⑨ /api/history 列表连读两次逐字相等（v1.7 列表缓存：命中与重解析的出口形状必须一致）", async () => {
    // 探针在集成子进程里拿不到，这里只断言可观察行为：同一 worldId 连续两次列表响应体逐字相等，
    // 且列表形态不回 files 与 prompt（缓存正确性——命中不出岔子——由 server.test.ts 的探针用例覆盖）。
    const first = await stack.getText("/api/history?worldId=w1");
    const second = await stack.getText("/api/history?worldId=w1");
    expect(first.status).toBe(200);
    expect(second.body).toBe(first.body);
    for (const r of [first, second]) {
      const meta = JSON.parse(r.body);
      expect(meta.snapshots.length).toBeGreaterThan(0); // w1 此时已有 turn + backup 数条
      expect(meta.snapshots.every((s: any) => s.files === undefined)).toBe(true);
      expect(meta.snapshots.every((s: any) => s.prompt === undefined)).toBe(true);
    }
  }, 15000);
});

// 索引 schema 的**启动**迁移（ROADMAP §1 / ADR-0018）：迁移跑在 startServer 里、listen 之前，
// 单测（tmp 根直调）证明不了「真的接上了」，只有真子进程能验。两条用例各起一套栈
// （种子形态不同：v1.8 及以前的裸数组 / schema:2 的未来版本），所以不并进上面那套共享栈。
describe("集成：索引 schema 的启动迁移（ROADMAP §1）", () => {
  it("⑩ 旧裸数组索引：启动即升成 {schema:1, worlds}，条目与世界照旧", async () => {
    const stack = await startStack({ legacyIndexArray: true });
    try {
      const indexFile = path.join(stack.root, "state", "worlds", "index.json");
      const doc = JSON.parse(readFileSync(indexFile, "utf8"));
      expect(doc.schema).toBe(1); // 裸数组已被升级（不是原地不动）
      expect(doc.worlds.map((w: any) => w.worldId)).toEqual(["w1"]);
      // 迁移只在真的动过文件时打一行日志（[acp] 约定）；此刻 HTTP 已开门，stdout 定稿
      expect(stack.stdout()).toContain("[acp] state/worlds/index.json 已升级");

      // 世界照旧可玩：升级没丢条目、没改字段
      const worlds = await stack.getJSON("/api/worlds");
      expect(worlds.status).toBe(200);
      expect(worlds.body.worlds.map((w: any) => w.worldId)).toEqual(["w1"]);
      expect(worlds.body.worlds[0]).toMatchObject({ preset: "demo", exists: true });
      expect(readWorldFile(w1Dir(stack), "state.md")).toContain("教堂");
    } finally {
      await stack.stop();
    }
  }, 30000);

  it("⑪ 未来 schema（schema:2）：读得到、迁移不动它，之后的索引写入也不降级、未知顶层键保留", async () => {
    const stack = await startStack({ indexSchema: 2, indexExtra: { futureField: { someDay: ["新版本才认识的数据"] } } });
    try {
      const indexFile = path.join(stack.root, "state", "worlds", "index.json");
      const doc = JSON.parse(readFileSync(indexFile, "utf8"));
      expect(doc.schema).toBe(2); // 迁移对它 no-op：将来版本的索引不被降级成 schema:1
      expect(doc.futureField).toEqual({ someDay: ["新版本才认识的数据"] });
      expect(stack.stdout()).not.toContain("已升级"); // no-op → 静默（不打日志）

      // 「永不拒绝」的读侧：未来 schema 的世界照样列出来
      const worlds = await stack.getJSON("/api/worlds");
      expect(worlds.status).toBe(200);
      expect(worlds.body.worlds.map((w: any) => w.worldId)).toEqual(["w1"]);

      // 写侧：改名（updateWorld → writeWorldsIndex 读改写）之后 schema 与未知键仍在
      const upd = await stack.postJSON("/api/worlds", { action: "update", worldId: "w1", label: "第一周目" });
      expect(upd.status).toBe(200);
      const after = JSON.parse(readFileSync(indexFile, "utf8"));
      expect(after.schema).toBe(2);
      expect(after.futureField).toEqual({ someDay: ["新版本才认识的数据"] });
      expect(after.worlds).toHaveLength(1);
      expect(after.worlds[0].label).toBe("第一周目");
    } finally {
      await stack.stop();
    }
  }, 30000);
});
