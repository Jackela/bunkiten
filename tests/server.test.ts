// server 协议行解析单测（v1.4 起入 vitest；此前只有临时 node -e 断言）。
// import 不触发 startServer/spawn（模块以 invokedDirectly 守卫自启）。
// 注意：行完整性（半行不生效）由上游 flushArtLines 的换行累积保证，不在这些函数的职责内——
// 这里只测「给定一行」的解析契约。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assetRelPath,
  assetTargetFile,
  buildPresetBundle,
  createWorld,
  deleteWorld,
  exportWorld,
  forkNote,
  forkTreeMarkdown,
  forkWorld,
  importPresetBundle,
  importWorld,
  isDirectivePrompt,
  isSnapshotEntry,
  legacyAssetCandidates,
  listWorlds,
  migrateLegacyState,
  migrateWorldsSchema,
  moveToTrash,
  normalizeSnapshot,
  normalizeTheme,
  parseArtLine,
  parseAudioLine,
  parseExpressionLine,
  parsePresetAddedLine,
  parseStateFile,
  parseTreePointer,
  parseTreeLine,
  parseWorldRef,
  pickEffort,
  presetAssetsDir,
  presetCheckResult,
  presetCheckView,
  presetFromStateFile,
  presetIdFromPath,
  readSnapshots,
  readWorldFiles,
  readWorldsIndex,
  resolvePersistPreset,
  restoreWorld,
  scanPresetAudio,
  stateViewFor,
  scanPresets,
  selectSnapshotForNode,
  updateWorld,
  worldChapterNo,
  writeSnapshot,
  writeTurnLog,
  SUPPLEMENT_PROMPT,
  __snapshotCacheStats,
  WORLD_FILES,
} from "../server/acp-server.mjs";
// migrateWorldsSchema 与索引写形态（ROADMAP §1 / ADR-0018）：从**入口** import——迁移已接启动路径、
// 写路径已翻成 `{schema:1, worlds}`，两者都在本批改动里落地，入口的 re-export 面就是外部对该能力的唯一门面。
// WORLD_BUNDLE_VERSION 另起一行直连模块：入口的 re-export 面还没有它，那是导出包那一族的账。
import { WORLD_BUNDLE_VERSION } from "../server/worlds.mjs";
// 剧本体检的判定真源（server 只做 id 校验/目录存在性/归组，检查逻辑一份都不重写）：测试直接用真函数
import { checkPreset } from "../scripts/doctor.mjs";

describe("server parseArtLine：【图】三段 + 可选第四段「重绘」", () => {
  it("标准三段（立绘/背景），字段为 type/name/srcRel/regen", () => {
    expect(parseArtLine("【图】立绘|薇拉|images/3.jpg")).toEqual({
      type: "立绘",
      name: "薇拉",
      srcRel: "images/3.jpg",
      regen: false,
    });
    expect(parseArtLine("【图】背景|灰雀镇廉价旅店|assets/背景-灰雀镇廉价旅店.jpg").type).toBe("背景");
  });

  it("封面类型", () => {
    expect(parseArtLine("【图】封面|末代天子|presets/twilight-throne/cover.jpg")).toMatchObject({
      type: "封面",
      name: "末代天子",
      regen: false,
    });
  });

  it("第四段=重绘（覆盖语义）", () => {
    expect(parseArtLine("【图】立绘|薇拉-微笑|images/7.jpg|重绘")).toMatchObject({
      name: "薇拉-微笑",
      regen: true,
    });
  });

  it("非法第四段（非「重绘」）整行拒绝", () => {
    expect(parseArtLine("【图】立绘|薇拉|images/3.jpg|别的")).toBeNull();
  });

  it("尾随换行与空白被容忍", () => {
    expect(parseArtLine("  【图】立绘|薇拉|images/3.jpg\n").srcRel).toBe("images/3.jpg");
  });
});

describe("server parseExpressionLine：【立绘】切换行", () => {
  it("完整行（带变体）", () => {
    expect(parseExpressionLine("【立绘】薇拉|微笑\n")).toEqual({ character: "薇拉", variant: "微笑" });
  });

  it("空变体回基础立绘", () => {
    expect(parseExpressionLine("【立绘】薇拉|\n")).toEqual({ character: "薇拉", variant: "" });
  });

  it("缺竖线不成行", () => {
    expect(parseExpressionLine("【立绘】薇拉 微笑")).toBeNull();
  });
});

describe("server parsePresetAddedLine：【新剧本】标记", () => {
  it("完整行", () => {
    expect(parsePresetAddedLine("【新剧本】rain-rejection\n")).toEqual({ id: "rain-rejection" });
  });

  it("普通文本不误报", () => {
    expect(parsePresetAddedLine("新剧本还没好")).toBeNull();
  });
});

describe("server parseTreeLine：【树】协议行（v1.5 剧情图编辑完成）", () => {
  it("裸标记行（SKILL 约定：摘要单独成句、标记单独成段）", () => {
    expect(parseTreeLine("【树】\n")).toEqual({ note: "" });
    expect(parseTreeLine("  【树】  ")).toEqual({ note: "" });
  });

  it("行尾带摘要时按 note 透传（容错）", () => {
    expect(parseTreeLine("【树】 已新增节点 3-4：雨夜遇袭")).toEqual({ note: "已新增节点 3-4：雨夜遇袭" });
  });

  it("普通文本不误报", () => {
    expect(parseTreeLine("树倒了")).toBeNull();
    expect(parseTreeLine("这棵树【树】")).toBeNull();
  });
});

describe("server 世界线纯函数：章号与分叉回退", () => {
  it("worldChapterNo：取最后一个 `## 第 N 章`；读不到回退 1", () => {
    expect(worldChapterNo("# 剧情树\n## 第 1 章：相遇\n")).toBe(1);
    expect(worldChapterNo("## 第 1 章：相遇\n## 第 4 章：雨夜\n")).toBe(4);
    expect(worldChapterNo("# 剧情树\n（未规划）")).toBe(1);
    expect(worldChapterNo("")).toBe(1);
  });

  it("forkTreeMarkdown：当前进度指向分叉节点、轮次清零、已剪枝恢复可达，其它状态原样保留", () => {
    const md = [
      "# 剧情树",
      "## 第 2 章：雨夜",
      "- 当前进度: 节点 2-4（已走 6 轮）",
      "### 节点 2-2（门外）",
      "- 状态: 已走过",
      "### 节点 2-3（假装睡着）",
      "- 状态: 已剪枝",
      "### 节点 2-5（嫁接的岔路）",
      "- 状态: 嫁接",
    ].join("\n");
    const out = forkTreeMarkdown(md, "2-2");
    expect(out).toContain("- 当前进度: 节点 2-2（已走 0 轮）");
    expect(out).not.toContain("已剪枝");
    expect(out).toContain("- 状态: 可达"); // 已剪枝 → 可达（新世界从分叉点重选）
    expect(out).toContain("- 状态: 已走过"); // 其余状态不动
    expect(out).toContain("- 状态: 嫁接");
  });

  it("forkNote：写明来源世界与节点，并要求引擎静默回退后删除本文件", () => {
    const note = forkNote("campus-summer-1", "2-2", new Date("2026-09-16T00:00:00Z"));
    expect(note).toContain("来源世界: campus-summer-1");
    expect(note).toContain("分叉节点: 2-2");
    expect(note).toContain("2026-09-16T00:00:00.000Z");
    expect(note).toContain("删除本文件");
    expect(note).toContain("尚未发生");
  });
});

describe("server 世界线索引与建 / 分叉 / 删（临时目录）", () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    // 嵌套 <tmp>/state/worlds 布局：deleteWorld 从 worlds 根推导游戏根（<gameRoot>/state/worlds），
    // 回收站落在 <tmp>/state/trash（与生产一致），整个临时目录由 afterEach 收掉
    tmp = mkdtempSync(path.join(os.tmpdir(), "worlds-"));
    root = path.join(tmp, "state", "worlds");
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("createWorld：分配 <preset>-N 递增 id、建目录、写索引", () => {
    const a = createWorld(root, "campus-summer", "盛夏偏差值");
    expect(a.worldId).toBe("campus-summer-1");
    expect(a.chapterNo).toBe(1);
    expect(existsSync(path.join(root, "campus-summer-1"))).toBe(true);

    const b = createWorld(root, "campus-summer", "盛夏偏差值");
    expect(b.worldId).toBe("campus-summer-2");

    const other = createWorld(root, "rift-mark", "裂痕标记");
    expect(other.worldId).toBe("rift-mark-1"); // 每个剧本各自计数
    expect(readWorldsIndex(root).map((e) => e.worldId)).toEqual([
      "campus-summer-1",
      "campus-summer-2",
      "rift-mark-1",
    ]);
  });

  it("forkWorld：复制三文件 + fork.md + 索引 forkedFrom（note 不再自动写），进度回退；来源世界不受影响", () => {
    const origin = createWorld(root, "campus-summer", "盛夏偏差值");
    const dir = path.join(root, origin.worldId);
    writeFileSync(path.join(dir, "state.md"), "# 剧情状态\n- preset: campus-summer\n- 场景: 天台\n");
    writeFileSync(path.join(dir, "summary.md"), "# 前情摘要（滚动）\n");
    writeFileSync(
      path.join(dir, "story-tree.md"),
      "# 剧情树\n## 第 2 章：雨夜\n- 当前进度: 节点 2-4（已走 6 轮）\n### 节点 2-2（门外）\n- 状态: 已走过\n### 节点 2-3（假装睡着）\n- 状态: 已剪枝\n",
    );

    const f = forkWorld(root, origin.worldId, "2-2");
    expect(f.worldId).toBe("campus-summer-2");
    const fdir = path.join(root, f.worldId);
    expect(readFileSync(path.join(fdir, "state.md"), "utf8")).toContain("天台"); // 三文件已复制
    expect(existsSync(path.join(fdir, "summary.md"))).toBe(true);
    const tree = readFileSync(path.join(fdir, "story-tree.md"), "utf8");
    expect(tree).toContain("- 当前进度: 节点 2-2（已走 0 轮）");
    expect(tree).toContain("- 状态: 可达");
    expect(tree).not.toContain("已剪枝");
    expect(readFileSync(path.join(fdir, "fork.md"), "utf8")).toContain("分叉节点: 2-2");

    const entry = readWorldsIndex(root).find((e) => e.worldId === f.worldId)!;
    expect(entry.forkedFrom).toEqual({ worldId: origin.worldId, nodeId: "2-2" });
    // v1.8：血缘只走 forkedFrom/fork.md，索引 note 不再兜底写裸 id（玩家可见处不出现 slug）
    expect(entry.note).toBe("");
    expect(entry.chapterNo).toBe(2); // 从回退后的树读章号

    // 来源世界原样：进度与状态都没被分叉改动
    expect(readFileSync(path.join(dir, "story-tree.md"), "utf8")).toContain("节点 2-4（已走 6 轮）");
    expect(readFileSync(path.join(dir, "story-tree.md"), "utf8")).toContain("已剪枝");
  });

  it("forkWorld：未知世界返回 error 且不产生新世界", () => {
    expect(forkWorld(root, "nope-1", "1-1")).toEqual({ error: "来源世界不存在" });
    expect(readWorldsIndex(root)).toEqual([]);
  });

  it("listWorlds：磁盘自愈（chapterNo 读树、lastPlayed 取文件 mtime）、按最近游玩倒序、可按 preset 过滤", () => {
    const a = createWorld(root, "campus-summer", "盛夏偏差值");
    const b = createWorld(root, "rift-mark", "裂痕标记");
    writeFileSync(path.join(root, a.worldId, "story-tree.md"), "## 第 3 章：天台\n");
    writeFileSync(path.join(root, b.worldId, "story-tree.md"), "## 第 1 章：起点\n");

    const all = listWorlds(root);
    expect(all.map((e) => e.worldId).sort()).toEqual([a.worldId, b.worldId]);
    expect(all.find((e) => e.worldId === a.worldId)?.chapterNo).toBe(3);
    expect(all.find((e) => e.worldId === a.worldId)?.exists).toBe(true);
    expect(all.find((e) => e.worldId === b.worldId)?.chapterNo).toBe(1);
    expect(all.every((e) => e.lastPlayed > 0)).toBe(true);

    const only = listWorlds(root, "rift-mark");
    expect(only.map((e) => e.worldId)).toEqual([b.worldId]);
  });

  it("deleteWorld：目录整体移入回收站并同步索引；未知世界返回 error", () => {
    const a = createWorld(root, "campus-summer", "盛夏偏差值");
    // createWorld 只建空目录（三文件由引擎写）：先手写三文件，删完才能在回收站里点验
    for (const f of WORLD_FILES) writeFileSync(path.join(root, a.worldId, f), "# x\n");
    expect(deleteWorld(root, a.worldId)).toEqual({ ok: true, trashed: true });
    expect(existsSync(path.join(root, a.worldId))).toBe(false); // 原位消失
    // 回收站：state/trash/ 下出现 <ts>-<rand4>-<worldId>/ 且三文件都在（断言用 match：RegExp 的 test 方法名会被契约 lint 的用例计数误数）
    const trash = path.join(tmp, "state", "trash");
    const items = readdirSync(trash).filter((f) => f.endsWith(`-${a.worldId}`) && f.match(/^\d+-[0-9a-z]{4}-/));
    expect(items.length).toBe(1);
    for (const f of WORLD_FILES) expect(existsSync(path.join(trash, items[0], f))).toBe(true);
    expect(readWorldsIndex(root)).toEqual([]);
    expect(deleteWorld(root, a.worldId)).toEqual({ error: "世界不存在" });
  });

  it("migrateLegacyState：旧扁平 state/*.md 一次性迁入 main/ 并建索引（保留 README；幂等）", () => {
    const stateDir = path.join(root, "state");
    const worldsRoot = path.join(stateDir, "worlds");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "README.md"), "# state/\n");
    writeFileSync(path.join(stateDir, "state.md"), "# 剧情状态\n- preset: campus-summer\n- 场景: 天台\n");
    writeFileSync(path.join(stateDir, "summary.md"), "# 前情摘要（滚动）\n");
    writeFileSync(path.join(stateDir, "story-tree.md"), "## 第 2 章：雨夜\n");
    writeFileSync(path.join(stateDir, "state.bak.md"), "# 上一周目\n");

    expect(migrateLegacyState(stateDir, worldsRoot)).toBe(true);
    expect(existsSync(path.join(stateDir, "state.md"))).toBe(false);
    expect(existsSync(path.join(stateDir, "README.md"))).toBe(true); // 说明文件原地保留
    expect(readFileSync(path.join(worldsRoot, "main", "state.md"), "utf8")).toContain("天台");
    expect(existsSync(path.join(worldsRoot, "main", "state.bak.md"))).toBe(true); // 备份一并搬
    const entry = readWorldsIndex(worldsRoot)[0];
    expect(entry.worldId).toBe("main");
    expect(entry.preset).toBe("campus-summer");
    expect(entry.chapterNo).toBe(2);
    // 索引由 writeWorldsIndex 落盘 → 今天写出来就是版本化形态，启动期紧随其后的 schema 迁移对它是 no-op
    expect(JSON.parse(readFileSync(path.join(worldsRoot, "index.json"), "utf8")).schema).toBe(1);

    expect(migrateLegacyState(stateDir, worldsRoot)).toBe(false); // 幂等：索引已存在即跳过
  });

  it("migrateLegacyState：无旧数据不建索引（全新安装不产生空世界）", () => {
    const stateDir = path.join(root, "state2");
    const worldsRoot = path.join(stateDir, "worlds");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "README.md"), "# state/\n");
    expect(migrateLegacyState(stateDir, worldsRoot)).toBe(false);
    expect(existsSync(path.join(worldsRoot, "index.json"))).toBe(false);
  });

  // 索引 schema 迁移（ROADMAP §1 / ADR-0018）：骨架四条行为（缺文件 / 旧裸数组 / 已版本化 / 坏 JSON）
  // 与**已翻过来的写形态**一起钉在这里——迁移的判据是「顶层是不是数组」，写路径的判据是 indexDocumentFor；
  // 这两半必须始终配对（只改一半就会出现「读到一半的世界」）。
  it("migrateWorldsSchema：旧裸数组升成 {schema:1, worlds}（条目原样）；缺文件 / 已升级都不动笔", () => {
    const file = path.join(root, "index.json");

    // (a) 缺索引：既不迁、也不创建文件（全新安装不该被迁移顺手造出一个空索引）
    expect(migrateWorldsSchema(root)).toBe(false);
    expect(existsSync(file)).toBe(false);

    // (b) 旧裸数组 → {schema: 1, worlds}：只包一层，条目逐条原样（不补字段、不过滤，第二个条目故意少 note）
    const legacy = [
      { worldId: "campus-summer-1", preset: "campus-summer", title: "盛夏偏差值", chapterNo: 2, lastPlayed: 1, note: "", forkedFrom: null },
      { worldId: "rift-mark-1", preset: "rift-mark", title: "裂痕标记", chapterNo: 1, lastPlayed: 2 },
    ];
    writeFileSync(file, JSON.stringify(legacy, null, 2) + "\n");
    expect(migrateWorldsSchema(root)).toBe(true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.schema).toBe(1);
    // 条目原样：键序与值逐个一致（第二个条目故意少 note，迁移**不补**字段——补字段是读路径的事）
    expect(JSON.stringify(after.worlds)).toBe(JSON.stringify(legacy));
    expect(readWorldsIndex(root).map((e) => e.worldId)).toEqual(["campus-summer-1", "rift-mark-1"]);

    // (c) 再调一次：已是版本化对象 → false，且文件一个字节都没被碰
    const bytes = readFileSync(file, "utf8");
    expect(migrateWorldsSchema(root)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("migrateWorldsSchema 与宽读：坏 JSON 不覆写；版本化对象（多出顶层键）读得到 worlds；写路径已是版本化形态", () => {
    const file = path.join(root, "index.json");

    // 坏 JSON：不抛错、也不覆写（覆写等于把玩家的世界线列表写没了），文件留给下次启动再试
    writeFileSync(file, "{ 这不是 JSON");
    expect(migrateWorldsSchema(root)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{ 这不是 JSON");
    expect(readWorldsIndex(root)).toEqual([]);

    // (d) 版本化对象 + 多出来的顶层键（updatedAt）：迁移 no-op，读路径照读 worlds、忽略多余的键
    const versioned = {
      schema: 1,
      worlds: [{ worldId: "w1", preset: "campus-summer", title: "盛夏偏差值", chapterNo: 1, lastPlayed: 0 }],
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeFileSync(file, JSON.stringify(versioned, null, 2) + "\n");
    expect(migrateWorldsSchema(root)).toBe(false);
    expect(readWorldsIndex(root).map((e) => e.worldId)).toEqual(["w1"]);

    // 结构不认识的形态仍是 fail-soft 成空数组（不是「读到一半」）：worlds 非数组 / 根本没有 worlds
    writeFileSync(file, JSON.stringify({ schema: 1, worlds: "w1" }));
    expect(readWorldsIndex(root)).toEqual([]);
    writeFileSync(file, JSON.stringify({ schema: 1 }));
    expect(readWorldsIndex(root)).toEqual([]);

    // 写路径已翻成版本化形态（与接上启动路径同一批）：createWorld 写出来的就是 {schema:1, worlds}，
    // 于是启动期迁移对「今天真实产生的索引」是 no-op——不再是「写裸数组 → 每次启动都要升一次」那种来回。
    createWorld(root, "campus-summer");
    const fresh = JSON.parse(readFileSync(file, "utf8"));
    expect(fresh.schema).toBe(1);
    expect(fresh.worlds.map((e: any) => e.worldId)).toEqual(["campus-summer-1"]);
    const bytes = readFileSync(file, "utf8");
    expect(migrateWorldsSchema(root)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("writeWorldsIndex：落盘 {schema:1, worlds}（建/改/删共用同一形态）；裸数组在迁移前照读", () => {
    const file = path.join(root, "index.json");
    const a = createWorld(root, "campus-summer", "盛夏偏差值");

    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(Array.isArray(doc)).toBe(false); // 翻转的正是这一条：v1.8 及以前这里是个数组
    expect(doc.schema).toBe(1);
    expect(doc.worlds.map((e: any) => e.worldId)).toEqual([a.worldId]);
    expect(readWorldsIndex(root).map((e) => e.worldId)).toEqual([a.worldId]); // 写出来的形态读得回来

    // 同族的两个写点（update / delete）落盘形态一致——它们都只经 writeWorldsIndex 一处
    updateWorld(root, a.worldId, { label: "第一周目" });
    expect(JSON.parse(readFileSync(file, "utf8")).worlds[0].label).toBe("第一周目");
    deleteWorld(root, a.worldId);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ schema: 1, worlds: [] });

    // 旧裸数组（v1.8 及以前的档）：读路径照认（启动迁移之外的单测环境也走同一条判定点），
    // 谁都没调用迁移——两种形态的读等价，迁移只负责「写到盘上的那一份换形态」。
    writeFileSync(file, JSON.stringify([{ worldId: "legacy-1", preset: "campus-summer", title: "旧档", chapterNo: 1, lastPlayed: 1 }], null, 2) + "\n");
    expect(readWorldsIndex(root).map((e) => e.worldId)).toEqual(["legacy-1"]);
  });

  it("未来 schema（schema:2）：读得到，且任何写回都保留 schema 与未知顶层键（降级安装不丢档）", () => {
    const file = path.join(root, "index.json");
    const future = {
      schema: 2,
      worlds: [{ worldId: "w1", preset: "campus-summer", title: "盛夏偏差值", chapterNo: 4, lastPlayed: 7 }],
      futureField: { someDay: ["新版本才认识的数据"] },
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeFileSync(file, JSON.stringify(future, null, 2) + "\n");

    // 读：宽读照旧（schema 号只记录、不做闸门——「永不拒绝」的前提是读得进来）
    expect(readWorldsIndex(root).map((e) => e.worldId)).toEqual(["w1"]);
    // 迁移：已是版本化对象 → no-op，schema 与未知键一个字节都不动
    expect(migrateWorldsSchema(root)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(future);

    // 写：读改写——只换 worlds，schema:2 与未知顶层键原样保留（**绝不降级成 schema:1**：
    // 玩家降级安装后旧版本再写一次，不能替未来版本宣布「这就是 schema 1 的结构」）
    const b = createWorld(root, "campus-summer");
    const afterCreate = JSON.parse(readFileSync(file, "utf8"));
    expect(afterCreate.schema).toBe(2);
    expect(afterCreate.updatedAt).toBe(future.updatedAt);
    expect(afterCreate.futureField).toEqual(future.futureField);
    expect(afterCreate.worlds.map((e: any) => e.worldId)).toEqual(["w1", b.worldId]);

    // 三个写点共用同一形态判定：update / delete 之后未知键与 schema 照样活着
    updateWorld(root, b.worldId, { note: "备注" });
    deleteWorld(root, b.worldId);
    const last = JSON.parse(readFileSync(file, "utf8"));
    expect(last.schema).toBe(2);
    expect(last.futureField).toEqual(future.futureField);
    expect(last.worlds.map((e: any) => e.worldId)).toEqual(["w1"]);
  });
});

describe("server 回收站 moveToTrash（v1.7：删除不直删，ADR-0014）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "trash-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("文件挪进 state/trash/<ts>-<rand4>[-<label>]-<原名>；源不存在时不谎报", () => {
    mkdirSync(path.join(root, "presets", "demo", "assets"), { recursive: true });
    writeFileSync(path.join(root, "presets", "demo", "assets", "立绘-薇拉.jpg"), "x");
    const r = moveToTrash(root, ["presets", "demo", "assets", "立绘-薇拉.jpg"], "demo");
    expect(r).toEqual({ trashed: true });
    expect(existsSync(path.join(root, "presets", "demo", "assets", "立绘-薇拉.jpg"))).toBe(false);
    const items = readdirSync(path.join(root, "state", "trash")).filter((f) => f.endsWith("-立绘-薇拉.jpg"));
    expect(items.length).toBe(1);
    expect(items[0].match(/^\d+-[0-9a-z]{4}-demo-/)).toBeTruthy(); // <ts>-<rand4>-<label(presetId)>- 前缀：跨剧本同名文件靠它区分归属

    // 源本来就不在：trashed:false 且不占位、不谎报 fallback
    expect(moveToTrash(root, ["presets", "demo", "assets", "不存在.jpg"])).toEqual({ trashed: false });
  });

  it("trash 建不出来（如路径被文件占住）→ 回退直删并标 fallback:\"purged\"", () => {
    mkdirSync(path.join(root, "state"), { recursive: true });
    writeFileSync(path.join(root, "state", "trash"), "占住回收站路径的普通文件"); // mkdirSync 会失败
    mkdirSync(path.join(root, "state", "worlds", "w-1"), { recursive: true });
    writeFileSync(path.join(root, "state", "worlds", "w-1", "state.md"), "# 剧情状态\n");
    const r = moveToTrash(root, ["state", "worlds", "w-1"]);
    expect(r).toEqual({ trashed: false, fallback: "purged" }); // 删除不能因 trash 失败而失败
    expect(existsSync(path.join(root, "state", "worlds", "w-1"))).toBe(false); // 直删兜底生效
  });
});

describe("server 资产路径契约（v1.5.1：资产随故事走，不写全局 assets/ 池）", () => {
  it("assetRelPath：presets/<剧本 id>/assets/<类型>-<名>.jpg", () => {
    expect(assetRelPath("立绘", "薇拉", "rift-mark")).toBe("presets/rift-mark/assets/立绘-薇拉.jpg");
    expect(assetRelPath("立绘", "薇拉-微笑", "rift-mark")).toBe("presets/rift-mark/assets/立绘-薇拉-微笑.jpg");
    expect(assetRelPath("背景", "灰雀镇旅店", "rift-mark")).toBe("presets/rift-mark/assets/背景-灰雀镇旅店.jpg");
  });

  it("assetRelPath：始终用 posix 分隔符（要原样写进 state.md 与【图】标记）", () => {
    const rel = assetRelPath("立绘", "沈屿", "campus-summer");
    expect(rel.startsWith("presets/campus-summer/assets/")).toBe(true);
    expect(rel).not.toContain("\\");
  });

  it("presetAssetsDir：GAME_ROOT/presets/<id>/assets（绝对路径）", () => {
    const dir = presetAssetsDir("rift-mark");
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.endsWith(path.join("presets", "rift-mark", "assets"))).toBe(true);
  });
});

describe("server 旧档资产路径解析（I1：只认当前剧本目录，不再跨剧本扫描）", () => {
  it("legacyAssetCandidates：只给当前剧本一个候选", () => {
    expect(legacyAssetCandidates("assets/背景-灰雀镇旅店.jpg", "rift-mark")).toEqual([
      "presets/rift-mark/assets/背景-灰雀镇旅店.jpg",
    ]);
  });

  it("legacyAssetCandidates：拿不到合法剧本 id 时没有候选（不再靠剧本列表兜底）", () => {
    expect(legacyAssetCandidates("assets/立绘-薇拉.jpg", "")).toEqual([]);
    expect(legacyAssetCandidates("assets/立绘-薇拉.jpg", "../etc")).toEqual([]);
    expect(legacyAssetCandidates("assets/立绘-薇拉.jpg", "a/b")).toEqual([]);
    expect(legacyAssetCandidates("assets/立绘-薇拉.jpg", "中文")).toEqual([]);
  });

  it("legacyAssetCandidates：只认旧格式的旧串（单层文件名 + .jpg/.jpeg）", () => {
    expect(legacyAssetCandidates("assets/背景-教堂.jpeg", "rift-mark")).toEqual([
      "presets/rift-mark/assets/背景-教堂.jpeg",
    ]);
    expect(legacyAssetCandidates("assets/sub/背景-教堂.jpg", "rift-mark")).toEqual([]); // 不认子目录
    expect(legacyAssetCandidates("assets/背景-教堂.png", "rift-mark")).toEqual([]);
    expect(legacyAssetCandidates("presets/rift-mark/assets/背景-教堂.jpg", "rift-mark")).toEqual([]); // 新契约路径无需兼容
    expect(legacyAssetCandidates("images/3.jpg", "rift-mark")).toEqual([]);
    expect(legacyAssetCandidates("", "rift-mark")).toEqual([]);
  });

  it("presetIdFromPath：从标记/state 的 presets/<id>/… 路径容错解析剧本 id", () => {
    expect(presetIdFromPath("presets/rift-mark/assets/立绘-薇拉.jpg")).toBe("rift-mark");
    expect(presetIdFromPath("presets/twilight-throne/cover.jpg")).toBe("twilight-throne");
    expect(presetIdFromPath("  presets/rain-rejection/assets/立绘-苏晚.jpeg ")).toBe("rain-rejection");
    expect(presetIdFromPath("images/3.jpg")).toBeNull();
    expect(presetIdFromPath("assets/立绘-薇拉.jpg")).toBeNull();
    expect(presetIdFromPath("presets/rift-mark/assets/../secret.jpg")).toBeNull();
    expect(presetIdFromPath("presets/a/b/cover.jpg")).toBeNull();
    expect(presetIdFromPath("")).toBeNull();
  });
});

describe("server resolvePersistPreset：落盘/直服的目标剧本判定（B1 的单一判定点）", () => {
  it("合法显式 id 最优先（/img 的 &preset= 或调用方传入的 id）", () => {
    expect(
      resolvePersistPreset({ queryPreset: "campus-summer", srcRel: "presets/rift-mark/assets/立绘-薇拉.jpg" }),
    ).toEqual({ presetId: "campus-summer", reason: "query" });
  });

  it("没有显式 id 时从来源路径解析 presets/<id>/…（引擎缓存命中会把路径写进标记）", () => {
    expect(resolvePersistPreset({ srcRel: "presets/rift-mark/assets/立绘-薇拉.jpg" })).toEqual({
      presetId: "rift-mark",
      reason: "path",
    });
    expect(resolvePersistPreset({ queryPreset: "", srcRel: "presets/twilight-throne/cover.jpg" })).toEqual({
      presetId: "twilight-throne",
      reason: "path",
    });
  });

  it("非法显式 id 被忽略（调用方负责 console.warn），继续按路径解析", () => {
    expect(
      resolvePersistPreset({ queryPreset: "../etc", srcRel: "presets/rift-mark/assets/立绘-薇拉.jpg" }),
    ).toEqual({ presetId: "rift-mark", reason: "path" });
    expect(resolvePersistPreset({ queryPreset: "../etc", srcRel: "images/3.jpg" })).toEqual({
      presetId: null,
      reason: "query-illegal",
    });
    expect(resolvePersistPreset({ queryPreset: "a/b", srcRel: "images/3.jpg" })).toEqual({
      presetId: null,
      reason: "query-illegal",
    });
    expect(resolvePersistPreset({ queryPreset: "中文剧本", srcRel: "images/3.jpg" })).toEqual({
      presetId: null,
      reason: "query-illegal",
    });
  });

  it("currentPresetId 只在调用方声明本场景可信（validPreset=true）时兜底；兜底值照样过白名单", () => {
    expect(
      resolvePersistPreset({ srcRel: "images/3.jpg", currentPresetId: "rift-mark", validPreset: true }),
    ).toEqual({ presetId: "rift-mark", reason: "current" });
    expect(
      resolvePersistPreset({ queryPreset: "campus-summer", srcRel: "images/3.jpg", currentPresetId: "rift-mark", validPreset: true }),
    ).toEqual({ presetId: "campus-summer", reason: "query" });
    expect(
      resolvePersistPreset({ srcRel: "images/3.jpg", currentPresetId: "../etc", validPreset: true }),
    ).toEqual({ presetId: null, reason: "none" });
  });

  it("B1：标记流与 /img 不走兜底（validPreset 缺省 false）——装配期拿不到新剧本 id 就必须 null", () => {
    // 此时 currentPresetId 还是上一局的剧本，一旦回退就把新剧本的立绘写进旧剧本目录
    expect(resolvePersistPreset({ srcRel: "images/3.jpg", currentPresetId: "rift-mark" })).toEqual({
      presetId: null,
      reason: "none",
    });
    expect(
      resolvePersistPreset({ srcRel: "images/3.jpg", currentPresetId: "rift-mark", validPreset: false }),
    ).toEqual({ presetId: null, reason: "none" });
    // 会话路径 + 没有显式 id = 无上下文
    expect(resolvePersistPreset({ queryPreset: "", srcRel: "images/12.jpg" })).toEqual({ presetId: null, reason: "none" });
  });

  it("无任何上下文 → null（调用方不落盘）", () => {
    expect(resolvePersistPreset()).toEqual({ presetId: null, reason: "none" });
    expect(resolvePersistPreset({})).toEqual({ presetId: null, reason: "none" });
    expect(resolvePersistPreset({ queryPreset: "  ", srcRel: "" })).toEqual({ presetId: null, reason: "none" });
    expect(resolvePersistPreset({ queryPreset: null, srcRel: null } as never)).toEqual({ presetId: null, reason: "none" });
  });
});

describe("server assetTargetFile：落盘目标（I2：最终 id 再校验一次白名单）", () => {
  it("立绘/背景：presets/<剧本 id>/assets/<类型>-<名>.jpg", () => {
    expect(assetTargetFile("立绘", "薇拉", "rift-mark")).toBe("presets/rift-mark/assets/立绘-薇拉.jpg");
    expect(assetTargetFile("背景", "灰雀镇旅店", "rift-mark")).toBe("presets/rift-mark/assets/背景-灰雀镇旅店.jpg");
  });

  it("非法/缺失剧本 id → null（调用方不写盘）", () => {
    expect(assetTargetFile("立绘", "薇拉", "")).toBeNull();
    expect(assetTargetFile("立绘", "薇拉", "../etc")).toBeNull();
    expect(assetTargetFile("立绘", "薇拉", "a/b")).toBeNull();
    expect(assetTargetFile("立绘", "薇拉", "中文")).toBeNull();
    expect(assetTargetFile("背景", "教堂", "../rift-mark")).toBeNull();
  });

  it("封面：presets/<id>/cover.jpg（不是 assets/封面-X.jpg 那条死路径），非法 id → null", () => {
    expect(assetTargetFile("封面", "仓库里没有的标题-zzz", "rift-mark")).toBe("presets/rift-mark/cover.jpg");
    expect(assetTargetFile("封面", "仓库里没有的标题-zzz", "")).toBeNull();
    expect(assetTargetFile("封面", "仓库里没有的标题-zzz", "../etc")).toBeNull();
  });

  it("封面：先按「剧本标题」反查 id（封面标记第二段就是标题），查不到才用传入 id", () => {
    const first = scanPresets().presets[0] as { id: string; title: string } | undefined;
    if (!first) return; // 该分支需要真实 presets/ 数据，仓库里没有就跳过
    expect(assetTargetFile("封面", first.title, "")).toBe(`presets/${first.id}/cover.jpg`);
    expect(assetTargetFile("封面", first.title, "other-script")).toBe(`presets/${first.id}/cover.jpg`); // 标题命中优先
  });

  it("名字里的路径分隔符被 sanitize：拼不出 assets/ 目录外的路径", () => {
    expect(assetTargetFile("立绘", "../../etc/passwd", "rift-mark")).toBe(
      "presets/rift-mark/assets/立绘-.._.._etc_passwd.jpg",
    );
  });
});

describe("server scanPresets：preset id 白名单（I2，临时目录注入 root）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "presets-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writePreset = (dir: string, id: string, title = "裂痕标记") => {
    const d = path.join(root, "presets", dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "preset.md"),
      `---\nid: ${id}\ntitle: ${title}\n---\n# 主要角色\n\n## 薇拉（沉默的书记官）\n`,
    );
  };

  it("合法 id 正常解析（角色表一并解析）", () => {
    writePreset("rift-mark", "rift-mark");
    const r = scanPresets(root) as { presets: Array<{ id: string; title: string; characters: string[] }>; errors: unknown[] };
    expect(r.presets.map((p) => p.id)).toEqual(["rift-mark"]);
    expect(r.presets[0].title).toBe("裂痕标记");
    expect(r.presets[0].characters).toEqual(["薇拉"]);
    expect(r.errors).toEqual([]);
  });

  it("id 非法的 preset 直接丢弃（进 errors，不进轮播/不参与落盘）", () => {
    writePreset("evil", "../etc");
    writePreset("chinese", "中文剧本");
    writePreset("slash", "a/b");
    writePreset("good", "campus-summer");
    const r = scanPresets(root) as { presets: Array<{ id: string }>; errors: Array<{ dir: string; error: string }> };
    expect(r.presets.map((p) => p.id)).toEqual(["campus-summer"]);
    expect(r.errors.map((e) => e.dir).sort()).toEqual(["chinese", "evil", "slash"]);
    expect(r.errors.every((e) => e.error.includes("非法"))).toBe(true);
  });

  it("frontmatter 缺 id/title 同样只进 errors", () => {
    writePreset("no-id", "");
    writePreset("good", "rift-mark");
    const r = scanPresets(root) as { presets: Array<{ id: string }>; errors: Array<{ dir: string }> };
    expect(r.presets.map((p) => p.id)).toEqual(["rift-mark"]);
    expect(r.errors.map((e) => e.dir)).toEqual(["no-id"]);
  });

  it("presets 目录不存在：不抛异常，报一行 errors（默认 root 仍是 GAME_ROOT）", () => {
    const r = scanPresets(root) as { presets: unknown[]; errors: Array<{ dir: string }> };
    expect(r.presets).toEqual([]);
    expect(r.errors).toEqual([{ dir: "presets", error: "presets 目录不存在" }]);
  });
});

describe("server presetFromStateFile / isDirectivePrompt：当前剧本来源的两条闸", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "worlds-state-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("presetFromStateFile：读 state/worlds/<id>/state.md 的 `- preset: <id>`（索引缺失时自愈）", () => {
    const dir = path.join(root, "rift-mark-2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "state.md"), "# 剧情状态\n- preset: rift-mark\n- 场景: 教堂\n");
    expect(presetFromStateFile("rift-mark-2", root)).toBe("rift-mark");
  });

  it("presetFromStateFile：文件缺失、无该行、值不合法都返回空串", () => {
    expect(presetFromStateFile("nope", root)).toBe("");
    const dir = path.join(root, "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "state.md"), "# 剧情状态\n- 场景: 天台\n");
    expect(presetFromStateFile("main", root)).toBe("");
    writeFileSync(path.join(dir, "state.md"), "# 剧情状态\n- preset: ../etc\n");
    expect(presetFromStateFile("main", root)).toBe(""); // 白名单外一律不认
  });

  it("isDirectivePrompt：只认客户端指令前缀（玩家自由输入不算）", () => {
    expect(isDirectivePrompt("开局：《盛夏偏差值》。主角卡：姓名=顾迟。世界：campus-summer-1。待命：只初始化。")).toBe(true);
    expect(isDirectivePrompt("继续世界：rift-mark-2。")).toBe(true);
    expect(isDirectivePrompt("  \n开局：《裂痕标记》。")).toBe(true);
    expect(isDirectivePrompt("世界：rift-mark。")).toBe(false); // 自由输入不得改落盘目录
    expect(isDirectivePrompt("开演。")).toBe(false);
    expect(isDirectivePrompt("创作模式：进入剧本创作。")).toBe(false);
    expect(isDirectivePrompt("")).toBe(false);
  });
});

describe("server parseWorldRef：开局/续玩指令里的世界段（资产落盘的剧本来源）", () => {
  it("开局指令中段的世界段（不在行首）", () => {
    expect(
      parseWorldRef("开局：《盛夏偏差值》。主角卡：姓名=顾迟；特质=毒舌防御。世界：campus-summer-1。待命：只初始化，不开始剧情。"),
    ).toBe("campus-summer-1");
  });

  it("继续世界：<id>。（续玩指令）", () => {
    expect(parseWorldRef("继续世界：rift-mark-2。")).toBe("rift-mark-2");
    expect(parseWorldRef("继续世界：main。")).toBe("main");
  });

  it("无世界段或 id 不合法时返回 null", () => {
    expect(parseWorldRef("开演。")).toBeNull();
    expect(parseWorldRef("")).toBeNull();
    expect(parseWorldRef("世界：中文 id 不合法。")).toBeNull();
  });
});

describe("server parseAudioLine：【曲】/【环境】/【音效】协议行（CONTRACTS §1）", () => {
  it("三种类型都解析出 {kind,name}", () => {
    expect(parseAudioLine("【曲】雨夜")).toEqual({ kind: "曲", name: "雨夜" });
    expect(parseAudioLine("【环境】旅店大堂")).toEqual({ kind: "环境", name: "旅店大堂" });
    expect(parseAudioLine("【音效】门响")).toEqual({ kind: "音效", name: "门响" });
  });

  it("「停」是普通名字（停止语义由客户端处理），不特殊解析", () => {
    expect(parseAudioLine("【曲】停")).toEqual({ kind: "曲", name: "停" });
    expect(parseAudioLine("【环境】停")).toEqual({ kind: "环境", name: "停" });
  });

  it("首尾空白（含尾随换行）被容忍——行首 trim 后匹配", () => {
    expect(parseAudioLine("  【曲】雨夜\n")).toEqual({ kind: "曲", name: "雨夜" });
    expect(parseAudioLine("\t【音效】门响  ")).toEqual({ kind: "音效", name: "门响" });
  });

  it("非音频行不误报（【图】/【立绘】/【树】/自由文本）", () => {
    expect(parseAudioLine("【图】立绘|薇拉|images/1.jpg")).toBeNull();
    expect(parseAudioLine("【立绘】薇拉|微笑")).toBeNull();
    expect(parseAudioLine("【树】")).toBeNull();
    expect(parseAudioLine("雨夜")).toBeNull();
    expect(parseAudioLine("【曲】")).toMatchObject({ kind: "曲", name: "" }); // 空名也成行（文件缺失即静默）
    expect(parseAudioLine("")).toBeNull();
  });
});

describe("server scanPresetAudio：presets/<id>/audio/ 扫描（CONTRACTS §1，临时 root）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "audio-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeAudio = (file: string) => {
    const dir = path.join(root, "presets", "demo", "audio");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, file), "x");
  };

  it("只认 <类型>-<名>.<ext>（类型/扩展名白名单），url 指向 /audio?p=", () => {
    writeAudio("曲-雨夜.mp3");
    writeAudio("环境-旅店大堂.ogg");
    writeAudio("音效-门响.wav");
    writeAudio("曲-主题.m4a");
    writeAudio("环境-风声.flac");
    writeAudio("readme.txt"); // 非 <类型>- 前缀 → 忽略
    writeAudio("未知-噪声.mp3"); // 类型不合法 → 忽略
    writeAudio("曲-无扩展"); // 无扩展名 → 忽略
    const items = scanPresetAudio("demo", root) as Array<{ kind: string; name: string; file: string; url: string }>;
    expect(items).toHaveLength(5);
    // url 里的文件名百分号编码（文件名可能含 &/?/#/空格）：服务端 searchParams 解回原值再直服
    expect(items.find((i) => i.name === "雨夜")).toEqual({
      kind: "曲",
      name: "雨夜",
      file: "曲-雨夜.mp3",
      url: "/audio?p=presets/demo/audio/%E6%9B%B2-%E9%9B%A8%E5%A4%9C.mp3",
    });
    expect(items.find((i) => i.name === "风声")).toMatchObject({ kind: "环境", file: "环境-风声.flac" });
  });

  it("无 audio 目录 = 空数组（不报错）；非法 preset id 也为空（不拼目录外路径）", () => {
    expect(scanPresetAudio("demo", root)).toEqual([]);
    mkdirSync(path.join(root, "presets", "demo"), { recursive: true });
    expect(scanPresetAudio("demo", root)).toEqual([]);
    expect(scanPresetAudio("../etc", root)).toEqual([]);
    expect(scanPresetAudio("a/b", root)).toEqual([]);
    expect(scanPresetAudio("", root)).toEqual([]);
  });
});

describe("server 快照子系统纯函数（CONTRACTS §2）", () => {
  it("parseTreePointer：从 story-tree.md 的进度指针取节点 id", () => {
    expect(parseTreePointer("# 剧情树\n- 当前进度: 节点 2-2（已走 6 轮）\n")).toBe("2-2");
    expect(parseTreePointer("- 当前进度：节点 3-4（已走 0 轮）")).toBe("3-4"); // 全角冒号
    expect(parseTreePointer("### 节点 1-1（门口）\n- 状态: 可达\n")).toBeNull();
    expect(parseTreePointer("")).toBeNull();
    expect(parseTreePointer(null)).toBeNull();
  });

  it("selectSnapshotForNode：取最早（seq 最小）的匹配快照；无匹配为 null", () => {
    const snaps = [
      { seq: 3, nodeId: "a" },
      { seq: 1, nodeId: "a" },
      { seq: 2, nodeId: "b" },
    ];
    expect(selectSnapshotForNode(snaps, "a")).toEqual({ seq: 1, nodeId: "a" });
    expect(selectSnapshotForNode(snaps, "b")).toEqual({ seq: 2, nodeId: "b" });
    expect(selectSnapshotForNode(snaps, "zzz")).toBeNull();
    expect(selectSnapshotForNode([], "a")).toBeNull();
    expect(selectSnapshotForNode(null, "a")).toBeNull();
  });

  it("normalizeSnapshot：统一字段类型与 files 三键（缺失 = null）", () => {
    const e = normalizeSnapshot({ seq: "2", kind: "backup", nodeId: "1-1", chapterNo: "3", files: { state: "s" } }) as any;
    expect(e).toMatchObject({ seq: 2, kind: "backup", nodeId: "1-1", chapterNo: 3 });
    expect(e.files).toEqual({ state: "s", summary: null, tree: null });
    expect(typeof e.at).toBe("string");
    expect(e.at.length).toBeGreaterThan(0);
  });

  it("isSnapshotEntry：结构校验（seq/kind/files 类型与取值域）", () => {
    expect(isSnapshotEntry(normalizeSnapshot({ seq: 1, kind: "turn", nodeId: null, chapterNo: 1, files: {} }))).toBe(true);
    expect(isSnapshotEntry({ ...normalizeSnapshot({ seq: 1 }), files: { state: null, summary: null, tree: "t" } })).toBe(true);
    expect(isSnapshotEntry({ seq: 0, at: "x", kind: "turn", nodeId: null, chapterNo: null, files: {} })).toBe(false);
    expect(isSnapshotEntry({ seq: 1, at: "x", kind: "weird", nodeId: null, chapterNo: null, files: {} })).toBe(false);
    expect(isSnapshotEntry({ seq: 1, at: "", kind: "turn", nodeId: null, chapterNo: null, files: {} })).toBe(false);
    expect(isSnapshotEntry({ seq: 1, at: "x", kind: "turn", nodeId: null, chapterNo: null, files: { state: 1 } })).toBe(false);
    expect(isSnapshotEntry(null)).toBe(false);
  });

  it("writeSnapshot / readSnapshots：seq 从 1 递增、内容全等去重、dedupe=false 强制落盘", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "snap-"));
    try {
      mkdirSync(path.join(root, "w1"), { recursive: true });
      const files = { state: "s", summary: "m", tree: "- 当前进度: 节点 1-1（已走 0 轮）\n" };
      const a = writeSnapshot(root, "w1", { kind: "turn", nodeId: "1-1", chapterNo: 1, files }) as any;
      expect(a).toMatchObject({ ok: true, seq: 1 });
      // 内容全等 → 跳过（不产生重复条目）
      const dup = writeSnapshot(root, "w1", { kind: "turn", nodeId: "1-1", chapterNo: 1, files }) as any;
      expect(dup.skipped).toBe(true);
      // backup 必须能落盘（dedupe=false）
      const b = writeSnapshot(root, "w1", { kind: "backup", nodeId: "1-1", chapterNo: 1, files }, { dedupe: false }) as any;
      expect(b).toMatchObject({ ok: true, seq: 2 });
      const snaps = readSnapshots("w1", root) as any[];
      expect(snaps.map((s) => s.seq)).toEqual([1, 2]);
      expect(snaps[1].kind).toBe("backup");
      expect(snaps[0].files.state).toBe("s");
      expect(existsSync(path.join(root, "w1", "history", "0001.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readWorldFiles / readSnapshots：缺失文件 = null、非法世界 id 为空", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rf-"));
    try {
      mkdirSync(path.join(root, "w1"), { recursive: true });
      writeFileSync(path.join(root, "w1", "state.md"), "# 剧情状态\n");
      const files = readWorldFiles(path.join(root, "w1")) as any;
      expect(files.state).toBe("# 剧情状态\n");
      expect(files.summary).toBeNull();
      expect(files.tree).toBeNull();
      expect(readSnapshots("../etc", root)).toEqual([]);
      expect(readSnapshots("no-such", root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeSnapshot：存在更大 seq 文件时仍取最大 +1（last.seq 由文件名推出，不受内容 seq 影响）", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "seqmax-"));
    try {
      const hdir = path.join(root, "w1", "history");
      mkdirSync(hdir, { recursive: true });
      // 手工放一条 0003.json（内容 seq=3）——下一次必须落在 0004，而不是 0002
      writeFileSync(
        path.join(hdir, "0003.json"),
        JSON.stringify({ seq: 3, at: "2026-01-01T00:00:00.000Z", kind: "turn", nodeId: "1-1", chapterNo: 1, files: { state: "old", summary: null, tree: null } }) + "\n",
      );
      const res = writeSnapshot(root, "w1", { kind: "turn", nodeId: "1-2", chapterNo: 2, files: { state: "new", summary: null, tree: null } }) as any;
      expect(res).toMatchObject({ ok: true, seq: 4 });
      expect(existsSync(path.join(hdir, "0004.json"))).toBe(true);
      expect((readSnapshots("w1", root) as any[]).map((s) => s.seq)).toEqual([3, 4]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeTurnLog（v1.7）：seq 与快照对齐、追不上 logs 进度时独立递增（append-only 不覆盖）、溢出截断", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tlog-"));
    try {
      // 非法世界 id 直接拒（与 writeSnapshot 同款第一道闸）
      expect((writeTurnLog(root, "../etc", { seq: 1, prompt: "p", text: "t" }) as any).skipped).toBe(true);

      // 空目录：对齐值 3 落 0003（restore 的 backup 只进 history，快照 seq 可能领先——对齐优先，允许空号）
      const a = writeTurnLog(root, "w1", { seq: 3, at: "2026-01-01T00:00:00.000Z", prompt: "推门。", text: "正文\n**行动**\n1. 进去\n" }) as any;
      expect(a).toMatchObject({ ok: true, seq: 3 });
      expect(JSON.parse(readFileSync(path.join(root, "w1", "logs", "0003.json"), "utf8"))).toEqual({
        seq: 3, at: "2026-01-01T00:00:00.000Z", prompt: "推门。", text: "正文\n**行动**\n1. 进去\n",
      });

      // 对齐值追不上 logs 进度（快照去重的回合：res.seq 落后）→ 独立递增到 4，绝不覆盖 0003、不回填空号
      const b = writeTurnLog(root, "w1", { seq: 3, prompt: "p2", text: "t2" }) as any;
      expect(b).toMatchObject({ ok: true, seq: 4 });
      expect(existsSync(path.join(root, "w1", "logs", "0004.json"))).toBe(true);
      expect(existsSync(path.join(root, "w1", "logs", "0002.json"))).toBe(false);

      // 不给 seq 也独立递增；at/prompt 缺省有兜底（text 同理）
      const c = writeTurnLog(root, "w1", { text: "t3" }) as any;
      expect(c).toMatchObject({ ok: true, seq: 5 });
      const entry = JSON.parse(readFileSync(path.join(root, "w1", "logs", "0005.json"), "utf8"));
      expect(entry.prompt).toBe("");
      expect(typeof entry.at).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    // 溢出：seq > 9999 不再写（与 writeSnapshot 的 SNAPSHOT_SEQ_MAX 同款截断）
    const root2 = mkdtempSync(path.join(os.tmpdir(), "tlog-of-"));
    try {
      const dir = path.join(root2, "w1", "logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "9999.json"), JSON.stringify({ seq: 9999, at: "x", prompt: "", text: "" }));
      // 对齐值直接越界，或独立递增到 10000，都不写
      expect((writeTurnLog(root2, "w1", { seq: 12000, prompt: "p", text: "t" }) as any)).toMatchObject({ skipped: true, reason: "overflow" });
      expect((writeTurnLog(root2, "w1", { seq: 9999, prompt: "p", text: "t" }) as any)).toMatchObject({ skipped: true, reason: "overflow" });
      expect(readdirSync(dir)).toEqual(["9999.json"]);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("SUPPLEMENT_PROMPT 常量（v1.7）：以「补充：」开头、含 **行动** 字面（质量守卫的追问指令，防手滑改坏）", () => {
    expect(SUPPLEMENT_PROMPT.startsWith("补充：")).toBe(true);
    expect(SUPPLEMENT_PROMPT).toContain("**行动**");
    expect(SUPPLEMENT_PROMPT).toContain("不要重述正文");
  });

  it("writeWorldFiles（经 restore）：快照里为 null 的文件回退后必须被删除（不留「未来」内容）", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nullfiles-"));
    try {
      const w = createWorld(root, "demo", "示例");
      const dir = path.join(root, w.worldId);
      // 落快照时 summary.md 尚不存在（引擎还没生成）→ 快照里的 summary = null
      writeFileSync(path.join(dir, "state.md"), "# 状态 v1\n");
      writeFileSync(path.join(dir, "story-tree.md"), "- 当前进度: 节点 1-1（已走 0 轮）\n");
      const files = readWorldFiles(dir) as any;
      expect(files.summary).toBeNull();
      expect((writeSnapshot(root, w.worldId, { kind: "turn", nodeId: "1-1", chapterNo: 1, files }) as any)).toMatchObject({ ok: true, seq: 1 });

      // 之后引擎才生成 summary.md（快照里并没有它）
      writeFileSync(path.join(dir, "summary.md"), "# 后来的摘要\n");
      expect(existsSync(path.join(dir, "summary.md"))).toBe(true);

      // 精确回退到 #1：当时 summary 尚不存在 → 回退后 summary.md 必须被删除，state 恢复 v1
      const r = restoreWorld(root, w.worldId, 1) as any;
      expect(r.backupSeq).toBe(2);
      expect(existsSync(path.join(dir, "summary.md"))).toBe(false);
      expect(readFileSync(path.join(dir, "state.md"), "utf8")).toBe("# 状态 v1\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("server readSnapshots 列表缓存（v1.7 读路径索引化：逐文件名字+mtime 复用）", () => {
  // 缓存是模块级（key = history 目录绝对路径），计数探针只看**每次调用前后的增量**，
  // 不依赖其他用例有没有碰过 readSnapshots（每个用例各自 mkdtemp 出独立目录，互不串）。
  const seedSnap = (root: string, seq: number, state: string) => {
    const hdir = path.join(root, "w1", "history");
    mkdirSync(hdir, { recursive: true });
    writeFileSync(
      path.join(hdir, `${String(seq).padStart(4, "0")}.json`),
      JSON.stringify({ seq, at: `2026-01-01T00:00:0${seq}.000Z`, kind: "turn", nodeId: `1-${seq}`, chapterNo: 1, files: { state, summary: null, tree: null } }) + "\n",
    );
  };

  it("文件与 mtime 都没变 → 第二次读命中缓存：不再 JSON.parse（parses 不变、hits +1）", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "snapcache-"));
    try {
      seedSnap(root, 1, "s1");
      const before = __snapshotCacheStats();
      expect((readSnapshots("w1", root) as any[]).map((s) => s.seq)).toEqual([1]); // 第一次：解析这一个文件
      const mid = __snapshotCacheStats();
      expect(mid.parses).toBe(before.parses + 1);
      expect(mid.hits).toBe(before.hits);
      expect((readSnapshots("w1", root) as any[]).map((s) => s.seq)).toEqual([1]); // 第二次：命中缓存
      const after = __snapshotCacheStats();
      expect(after.parses).toBe(mid.parses);
      expect(after.hits).toBe(mid.hits + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("目录新增快照文件（外部写入，不经 writeSnapshot）→ 只补解析新文件，旧条目复用", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "snapcache-add-"));
    try {
      seedSnap(root, 1, "s1");
      expect((readSnapshots("w1", root) as any[]).map((s) => s.seq)).toEqual([1]); // 先填缓存
      const before = __snapshotCacheStats();
      seedSnap(root, 2, "s2"); // 新文件名不在 byFile 里 → 只解析它
      const snaps = readSnapshots("w1", root) as any[];
      const after = __snapshotCacheStats();
      expect(snaps.map((s) => s.seq)).toEqual([1, 2]);
      expect(snaps[1].files.state).toBe("s2");
      // 逐文件解析计数：parses 只 +1——若走了全量重解析会是 +2（旧条目也重新读盘）
      expect(after.parses).toBe(before.parses + 1);
      expect(after.hits).toBe(before.hits);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("出口浅拷贝：调用方改返回条目的顶层字段（seq）后再读不脏缓存", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "snapcache-copy-"));
    try {
      seedSnap(root, 1, "s1");
      const first = readSnapshots("w1", root) as any[];
      first[0].seq = 999; // 污染返回值
      expect((readSnapshots("w1", root) as any[])[0].seq).toBe(1); // 缓存条目不受影响
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("同名覆盖写（文件名不变、mtime 变）→ 该文件重解析，其余条目照常复用", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "snapcache-mtime-"));
    try {
      seedSnap(root, 1, "s1");
      expect((readSnapshots("w1", root) as any[])[0].files.state).toBe("s1"); // 先填缓存
      const before = __snapshotCacheStats();
      // 外部覆盖同一文件名、内容不同，并显式回拨 mtime 保证跨平台确定性（否则同秒覆盖可能漏判）
      const file = path.join(root, "w1", "history", "0001.json");
      writeFileSync(file, JSON.stringify({ seq: 1, at: "2026-01-02T00:00:00.000Z", kind: "turn", nodeId: "1-1", chapterNo: 1, files: { state: "s1-改", summary: null, tree: null } }) + "\n");
      const t = new Date(Date.now() - 60_000);
      utimesSync(file, t, t);
      const snaps = readSnapshots("w1", root) as any[];
      const after = __snapshotCacheStats();
      expect(snaps[0].files.state).toBe("s1-改"); // 逐文件 mtime 比对兜住了「只看文件名」抓不到的覆盖写
      expect(after.parses).toBe(before.parses + 1);
      expect(after.hits).toBe(before.hits);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeSnapshot 写盘后无需失效：新文件名即缓存未命中，旧条目复用、只解析新文件", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "snapcache-write-"));
    try {
      seedSnap(root, 1, "s1");
      expect((readSnapshots("w1", root) as any[]).map((s) => s.seq)).toEqual([1]); // 先填缓存
      const before = __snapshotCacheStats();
      // writeSnapshot（与正戏回合落盘同一条路径）写入 seq=2：seq 递增**永远写新文件名**，
      // 名字比对必然未命中 → 只解析它、旧条目照常复用（若走整体失效，parses 会是 +2）
      const w = writeSnapshot(root, "w1", { kind: "turn", nodeId: "1-2", chapterNo: 1, files: { state: "s2", summary: null, tree: null } }) as any;
      expect(w.seq).toBe(2);
      const snaps = readSnapshots("w1", root) as any[];
      const after = __snapshotCacheStats();
      expect(snaps.map((s) => s.seq)).toEqual([1, 2]);
      expect(after.parses).toBe(before.parses + 1); // 只解析新写入的那一个文件
      expect(after.hits).toBe(before.hits);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("server pickEffort：推理档位分档（CONTRACTS §4）", () => {
  it("规划/美术/剧情/装配/创作模式 → planning 档；其余 → 正戏档", () => {
    expect(pickEffort("规划：第 2 章。", "medium", "low")).toBe("low");
    expect(pickEffort("美术：重绘 立绘 薇拉", "medium", "low")).toBe("low");
    expect(pickEffort("剧情：把这段改冷一点。", "medium", "low")).toBe("low");
    expect(pickEffort("装配。", "medium", "low")).toBe("low");
    expect(pickEffort("创作模式：进入剧本创作。", "medium", "low")).toBe("low");
    expect(pickEffort("推开门看看。", "medium", "low")).toBe("medium");
    expect(pickEffort("继续世界：w1。", "medium", "low")).toBe("medium");
    expect(pickEffort("", "medium", "low")).toBe("medium");
  });
});

describe("server updateWorld：label/note 参数校验（CONTRACTS §2，临时 root）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "update-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("写 label(≤60)/note(≤200)，空串清除；listWorlds 返回 label", () => {
    const w = createWorld(root, "demo", "示例");
    const r = updateWorld(root, w.worldId, { label: " 我的存档 ", note: "第一章结束" }) as any;
    expect(r.entry.label).toBe("我的存档"); // 首尾空格被 trim
    expect(r.entry.note).toBe("第一章结束");
    const cleared = updateWorld(root, w.worldId, { note: "" }) as any;
    expect(cleared.entry.note).toBe("");
    expect(cleared.entry.label).toBe("我的存档"); // 未出现的键保持原值
    const worlds = listWorlds(root) as any[];
    expect(worlds.find((e) => e.worldId === w.worldId).label).toBe("我的存档");
  });

  it("越界长度、未知世界、非法 id 都返回 error（不落盘）", () => {
    const w = createWorld(root, "demo", "示例");
    expect(updateWorld(root, w.worldId, { label: "字".repeat(61) })).toMatchObject({ error: expect.stringContaining("label") });
    expect(updateWorld(root, w.worldId, { note: "字".repeat(201) })).toMatchObject({ error: expect.stringContaining("note") });
    expect(updateWorld(root, "nope-1", { label: "x" })).toMatchObject({ error: "世界不存在" });
    expect(updateWorld(root, "../etc", { label: "x" })).toMatchObject({ error: "参数不合法" });
    // 越界长度不落盘：索引里的原值不变
    expect((readWorldsIndex(root)[0] as any).label).toBeUndefined();
  });
});

describe("server importWorld：bundle 校验 / 重名后缀 / 快照与文件落盘（CONTRACTS §2）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "import-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const bundleFor = (over: Record<string, unknown> = {}) => ({
    format: "bunkiten-world",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    world: {
      worldId: "w1",
      preset: "demo",
      title: "示例",
      label: "存档",
      note: "原注",
      chapterNo: 1,
      files: { state: "# 状态\n", summary: "# 摘要\n", tree: "## 第 1 章：起点\n- 当前进度: 节点 1-1（已走 0 轮）\n" },
      snapshots: [
        {
          seq: 1,
          at: "2026-01-01T00:00:00.000Z",
          kind: "turn",
          nodeId: "1-1",
          chapterNo: 1,
          files: { state: "# 状态\n", summary: "# 摘要\n", tree: "## 第 1 章：起点\n- 当前进度: 节点 1-1（已走 0 轮）\n" },
        },
      ],
      ...over,
    },
  });

  it("非法 bundle（format/version/worldId）一律拒绝", () => {
    expect(importWorld(root, null)).toMatchObject({ error: expect.any(String) });
    expect(importWorld(root, {})).toMatchObject({ error: expect.any(String) });
    expect(importWorld(root, { format: "x", version: 1, world: { worldId: "w1" } })).toMatchObject({ error: expect.any(String) });
    // 版本闸是区间不是等值（接受 1..WORLD_BUNDLE_VERSION）：区间外的、以及「1」这种字符串形态都拒
    expect(importWorld(root, { format: "bunkiten-world", version: WORLD_BUNDLE_VERSION + 1, world: { worldId: "w1" } })).toMatchObject({ error: expect.any(String) });
    expect(importWorld(root, { format: "bunkiten-world", version: "1", world: { worldId: "w1" } })).toMatchObject({ error: expect.any(String) });
    expect(importWorld(root, { format: "bunkiten-world", version: 1, world: { worldId: "../etc" } })).toMatchObject({ error: expect.any(String) });
    expect(readWorldsIndex(root)).toEqual([]); // 拒绝后不产生半个世界
  });

  it("写入文件 + 快照 + 索引，note 追加「（导入）」；重名自动 -2 / -3", () => {
    const first = importWorld(root, bundleFor()) as any;
    expect(first.worldId).toBe("w1");
    const dir = path.join(root, "w1");
    expect(readFileSync(path.join(dir, "state.md"), "utf8")).toBe("# 状态\n");
    expect(existsSync(path.join(dir, "history", "0001.json"))).toBe(true);
    const entry = readWorldsIndex(root).find((e: any) => e.worldId === "w1") as any;
    expect(entry.note).toBe("原注（导入）");

    // 重名：-2、-3…
    expect((importWorld(root, bundleFor()) as any).worldId).toBe("w1-2");
    expect((importWorld(root, bundleFor()) as any).worldId).toBe("w1-3");
    expect(existsSync(path.join(root, "w1-2"))).toBe(true);
  });

  it("import：磁盘上已存在但索引缺失的世界目录也算被占用（分配 -2，原目录内容不变）", () => {
    // 磁盘上有个 w1 目录，但索引里没有它（手建世界 / 索引被删）——旧实现只看索引，会静默顶替它
    mkdirSync(path.join(root, "w1"), { recursive: true });
    writeFileSync(path.join(root, "w1", "state.md"), "# 原世界状态\n");
    const out = importWorld(root, bundleFor()) as any;
    expect(out.worldId).toBe("w1-2"); // 不顶替磁盘上的 w1
    expect(readFileSync(path.join(root, "w1", "state.md"), "utf8")).toBe("# 原世界状态\n"); // 原目录内容原样
    expect(readFileSync(path.join(root, "w1-2", "state.md"), "utf8")).toBe("# 状态\n"); // 导入落到 -2
    expect(readWorldsIndex(root).map((e: any) => e.worldId)).toEqual(["w1-2"]);
  });

  it("import：files.state 缺失/null/空串 → 400（不写半个世界）", () => {
    const bad = (files: unknown) => importWorld(root, bundleFor({ files }));
    expect(bad(undefined)).toMatchObject({ error: expect.stringContaining("files.state") });
    expect(bad(null)).toMatchObject({ error: expect.stringContaining("files.state") });
    expect(bad({ state: null, summary: null, tree: null })).toMatchObject({ error: expect.stringContaining("files.state") });
    expect(bad({ state: "   " })).toMatchObject({ error: expect.stringContaining("files.state") });
    expect(readWorldsIndex(root)).toEqual([]);
    expect(existsSync(path.join(root, "w1"))).toBe(false);
  });

  it("import：label(≤60)/note(≤200) 超长 → 400（不静默截断）", () => {
    expect(importWorld(root, bundleFor({ label: "字".repeat(61) }))).toMatchObject({ error: expect.stringContaining("label") });
    expect(importWorld(root, bundleFor({ note: "字".repeat(201) }))).toMatchObject({ error: expect.stringContaining("note") });
    // 边界内照常通过，超出才拒
    expect((importWorld(root, bundleFor({ label: "字".repeat(60), note: "字".repeat(200) })) as any).worldId).toBe("w1");
  });

  it("exportWorld：缺 worldId/不存在返回 error；合法世界给出 bundle 头与三文件", () => {
    const w = createWorld(root, "demo", "示例");
    writeFileSync(path.join(root, w.worldId, "state.md"), "# 状态\n- preset: demo\n");
    const out = exportWorld(root, w.worldId) as any;
    expect(out.bundle.format).toBe("bunkiten-world");
    expect(out.bundle.version).toBe(WORLD_BUNDLE_VERSION);
    expect(out.bundle.world.worldId).toBe(w.worldId);
    expect(out.bundle.world.files.state).toBe("# 状态\n- preset: demo\n");
    expect(out.bundle.world.snapshots).toEqual([]);
    // v2 的两个血缘键对根世界也在（都是 null）：缺键与 null 是两种意思，导入侧只认后者
    expect(out.bundle.world.forkedFrom).toBe(null);
    expect(out.bundle.world.forkMd).toBe(null);
    expect(exportWorld(root, "../etc")).toMatchObject({ error: expect.any(String) });
    expect(exportWorld(root, "nope-1")).toMatchObject({ error: expect.any(String) });
  });

  it("exportWorld v2：分叉世界带 forkedFrom（含 seq）与 fork.md 全文，键序只追加两处", () => {
    const origin = createWorld(root, "demo", "示例");
    const dir = path.join(root, origin.worldId);
    const snapFiles = { state: "# 状态\n", summary: "# 摘要\n", tree: "## 第 1 章：起点\n- 当前进度: 节点 1-1（已走 0 轮）\n" };
    writeFileSync(path.join(dir, "state.md"), "# 状态\n");
    writeSnapshot(root, origin.worldId, { kind: "turn", nodeId: "1-1", chapterNo: 1, files: snapFiles });
    const f = forkWorld(root, origin.worldId, "1-1", 1) as any;
    const forkMd = readFileSync(path.join(root, f.worldId, "fork.md"), "utf8");

    expect(WORLD_BUNDLE_VERSION).toBe(2); // 版本号本身是契约：v2 才保证下面两个键在
    const bundle = (exportWorld(root, f.worldId) as any).bundle;
    expect(bundle.version).toBe(WORLD_BUNDLE_VERSION);
    expect(bundle.world.forkedFrom).toEqual({ worldId: origin.worldId, nodeId: "1-1", seq: 1 });
    expect(bundle.world.forkMd).toBe(forkMd); // 逐字（含「分叉时间」那一行的时间戳）
    // 键序：v1 的九个键一个不动、两个新键插在血缘该在的位置（forkedFrom 归元数据、forkMd 归文件全文）
    expect(
      Object.keys(bundle.world),
      `v2 的 world 键序变了：现在是 ${Object.keys(bundle.world).join(",")}——导出包体是跨机格式，键序与形状要稳住（老包只认 v1 那九个键）`,
    ).toEqual(["worldId", "preset", "title", "label", "note", "chapterNo", "forkedFrom", "files", "snapshots", "forkMd"]);
  });

  it("export↔import v2 往返：血缘（含 seq）与 fork.md 逐字回到索引与磁盘", () => {
    const origin = createWorld(root, "demo", "示例");
    const snapFiles = { state: "# 状态\n", summary: "# 摘要\n", tree: "## 第 1 章：起点\n- 当前进度: 节点 1-1（已走 0 轮）\n" };
    writeFileSync(path.join(root, origin.worldId, "state.md"), "# 状态\n");
    writeSnapshot(root, origin.worldId, { kind: "turn", nodeId: "1-1", chapterNo: 1, files: snapFiles });
    const forked = forkWorld(root, origin.worldId, "1-1", 1) as any;
    const forkMd = readFileSync(path.join(root, forked.worldId, "fork.md"), "utf8");
    const bundle = (exportWorld(root, forked.worldId) as any).bundle;

    const imp = importWorld(root, bundle) as any;
    expect(imp.worldId).toBe(`${forked.worldId}-2`); // 重名后缀：来源世界还在
    expect(readFileSync(path.join(root, imp.worldId, "fork.md"), "utf8")).toBe(forkMd); // 逐字落盘
    expect(readFileSync(path.join(root, imp.worldId, "state.md"), "utf8")).toBe("# 状态\n");
    const entry = readWorldsIndex(root).find((e: any) => e.worldId === imp.worldId) as any;
    // 家谱只读 forkedFrom：seq 一起回来才算「血缘活过了往返」
    expect(entry.forkedFrom).toEqual({ worldId: origin.worldId, nodeId: "1-1", seq: 1 });
    expect(entry.note).toBe("（导入）"); // 分叉世界 note 本就为空 → 追加来源标注

    // forkMd 空串 = 「没有这个文件」：不落 0 字节 fork.md（否则引擎首个回合会读到一份空指令）
    const empty = importWorld(root, { ...bundle, world: { ...bundle.world, forkMd: "" } }) as any;
    expect(existsSync(path.join(root, empty.worldId, "fork.md"))).toBe(false);
    expect(readWorldsIndex(root).find((e: any) => e.worldId === empty.worldId)?.forkedFrom).toEqual({ worldId: origin.worldId, nodeId: "1-1", seq: 1 });
  });

  it("import v1：老包照收（forkedFrom null、不落 fork.md）——「接受旧版本」单独钉住", () => {
    const v1 = bundleFor(); // 老包形状：没有 forkedFrom / forkMd 这两个键
    expect(v1.version).toBe(1);
    expect("forkedFrom" in v1.world).toBe(false);
    const imp = importWorld(root, v1) as any;
    expect(imp.worldId).toBe("w1");
    expect(existsSync(path.join(root, "w1", "fork.md"))).toBe(false);
    expect(readWorldsIndex(root).find((e: any) => e.worldId === "w1")?.forkedFrom).toBe(null); // = 家谱里的根（v1 包的语义）
  });

  it("import v2：forkedFrom 形态不合法 → 降级成 null（不整包拒绝、不半留）", () => {
    const bad: unknown[] = [
      { worldId: "../etc", nodeId: "1-1" }, // 白名单不过
      { worldId: 7, nodeId: "1-1" }, // worldId 非字符串
      { worldId: "w1" }, // 缺 nodeId
      { worldId: "w1", nodeId: "" },
      { worldId: "w1", nodeId: "   " },
      { worldId: "w1", nodeId: 11 }, // nodeId 非字符串
      { worldId: "w1", nodeId: "1-1", seq: "1" }, // seq 必须是数字（「精确分叉自第 1 条」不许靠猜）
      { worldId: "w1", nodeId: "1-1", seq: 0 },
      { worldId: "w1", nodeId: "1-1", seq: 1.5 },
      "w1@1-1", // 整条不是对象
      {},
    ];
    for (const forkedFrom of bad) {
      const imp = importWorld(root, { ...bundleFor({ forkedFrom }), version: 2 }) as any;
      expect(imp.error, `forkedFrom=${JSON.stringify(forkedFrom)} 不该整包拒绝（血缘是展示面信息，坏了也只该降级）`).toBeUndefined();
      const entry = readWorldsIndex(root).find((e: any) => e.worldId === imp.worldId) as any;
      expect(entry.forkedFrom, `forkedFrom=${JSON.stringify(forkedFrom)} 应整条降级为 null`).toBe(null);
    }
    // 合法的最小形态（只有 worldId/nodeId）照收
    const ok = importWorld(root, { ...bundleFor({ forkedFrom: { worldId: "w1", nodeId: "1-1" } }), version: 2 }) as any;
    expect(readWorldsIndex(root).find((e: any) => e.worldId === ok.worldId)?.forkedFrom).toEqual({ worldId: "w1", nodeId: "1-1" });
  });
});

describe("server 剧本导出包：buildPresetBundle / importPresetBundle（bunkiten-preset v1.7，临时 root）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "preset-bundle-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // 可辨识的假字节（内容断言用）：JPEG SOI 前缀 + 标记 / 裸文本当 wav
  const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`J:${tag}`)]);
  const WAV = (tag: string) => Buffer.from(`W:${tag}`);

  /** 造一个剧本目录：preset.md + 封面 + .jpeg/.jpg 立绘背景 + 两个音频，外加干扰项（子目录/未知扩展名/0 字节/assets 死路径封面） */
  const seedPreset = (id: string) => {
    const dir = path.join(root, "presets", id);
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    mkdirSync(path.join(dir, "audio"), { recursive: true });
    writeFileSync(path.join(dir, "preset.md"), `---\nid: ${id}\ntitle: 演示剧本\n---\n\n# 主要角色\n`);
    writeFileSync(path.join(dir, "cover.jpg"), JPEG("cover"));
    writeFileSync(path.join(dir, "assets", "立绘-薇拉.jpeg"), JPEG("vera"));
    writeFileSync(path.join(dir, "assets", "背景-教堂.jpg"), JPEG("church"));
    writeFileSync(path.join(dir, "audio", "曲-夜灯谣.wav"), WAV("bgm"));
    writeFileSync(path.join(dir, "audio", "环境-雨夜.ogg"), WAV("rain"));
    mkdirSync(path.join(dir, "assets", "nested"));
    writeFileSync(path.join(dir, "assets", "note.txt"), "not an image");
    writeFileSync(path.join(dir, "assets", "empty.jpg"), "");
    writeFileSync(path.join(dir, "assets", "cover.jpg"), JPEG("dead-path"));
  };

  it("buildPresetBundle：非法 id/目录不存在 error；包体收 preset.md/封面/jpe?g/合法音频，跳过子目录、未知扩展名、0 字节与 assets 里的死路径封面", () => {
    seedPreset("demo");
    const out = buildPresetBundle(root, "demo") as any;
    expect(out.error).toBeUndefined();
    expect(out.bundle.format).toBe("bunkiten-preset");
    expect(out.bundle.version).toBe(1);
    expect(out.bundle.id).toBe("demo");
    expect(out.bundle.title).toBe("演示剧本"); // 取 frontmatter title
    expect(out.bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.bundle.presetMd).toContain("id: demo");
    expect(Object.keys(out.bundle.assets).sort()).toEqual(["cover.jpg", "立绘-薇拉.jpeg", "背景-教堂.jpg"].sort());
    expect(Buffer.from(out.bundle.assets["cover.jpg"], "base64").equals(JPEG("cover"))).toBe(true); // 封面键 = preset 根的 cover.jpg
    expect(out.bundle.assets["cover.jpg"]).not.toBe(Buffer.from(JPEG("dead-path")).toString("base64")); // assets/cover.jpg 是死路径，不进包
    expect(Object.keys(out.bundle.audio).sort()).toEqual(["曲-夜灯谣.wav", "环境-雨夜.ogg"].sort());
    expect(Buffer.from(out.bundle.audio["曲-夜灯谣.wav"], "base64").equals(WAV("bgm"))).toBe(true);
    expect(buildPresetBundle(root, "../etc")).toMatchObject({ error: expect.any(String) });
    expect(buildPresetBundle(root, "nope")).toMatchObject({ error: expect.any(String) });
  });

  it("完整往返：导出 → 导入进全新 root（id 不变）→ preset.md 原文与资产/音频字节级还原，进轮播", () => {
    seedPreset("demo");
    const bundle = (buildPresetBundle(root, "demo") as any).bundle;
    const root2 = mkdtempSync(path.join(os.tmpdir(), "preset-bundle-2-"));
    try {
      expect(importPresetBundle(root2, bundle)).toEqual({ ok: true, id: "demo" }); // 无撞名：id 原样
      const dir = path.join(root2, "presets", "demo");
      expect(readFileSync(path.join(dir, "preset.md"), "utf8")).toBe(bundle.presetMd); // 原文落地（id 行无需改写）
      expect(readFileSync(path.join(dir, "cover.jpg")).equals(JPEG("cover"))).toBe(true); // 封面键落 preset 根
      expect(readFileSync(path.join(dir, "assets", "立绘-薇拉.jpeg")).equals(JPEG("vera"))).toBe(true);
      expect(readFileSync(path.join(dir, "assets", "背景-教堂.jpg")).equals(JPEG("church"))).toBe(true);
      expect(readFileSync(path.join(dir, "audio", "曲-夜灯谣.wav")).equals(WAV("bgm"))).toBe(true);
      expect(readFileSync(path.join(dir, "audio", "环境-雨夜.ogg")).equals(WAV("rain"))).toBe(true);
      expect(scanPresets(root2).presets.find((p: any) => p.id === "demo")).toMatchObject({ title: "演示剧本" });
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("重名 -2/-3：目标目录被占用时后缀递增（与 importWorld 同款循环），原目录内容不动；frontmatter id 行随落地 id 改写", () => {
    seedPreset("demo");
    const bundle = (buildPresetBundle(root, "demo") as any).bundle; // bundle.id = demo，撞 seed 目录
    expect(importPresetBundle(root, bundle)).toEqual({ ok: true, id: "demo-2" });
    expect(importPresetBundle(root, bundle)).toEqual({ ok: true, id: "demo-3" });
    // 原目录内容原样（不覆盖既有剧本）
    expect(readFileSync(path.join(root, "presets", "demo", "cover.jpg")).equals(JPEG("cover"))).toBe(true);
    // 轮播按 frontmatter id 认卡：不改写会出现两张「demo」卡带（美术/音频随之落错目录）
    const md = readFileSync(path.join(root, "presets", "demo-2", "preset.md"), "utf8");
    expect(md).toContain("id: demo-2");
    expect(md).toContain("title: 演示剧本"); // 其余原文不动
    expect(scanPresets(root).presets.map((p: any) => p.id).sort()).toEqual(["demo", "demo-2", "demo-3"]);
  });

  it("非法 bundle（format/version/id/presetMd 空白）一律拒绝且不落盘", () => {
    const base = () => ({ format: "bunkiten-preset", version: 1, id: "x1", presetMd: "---\nid: x1\n---\n", assets: {}, audio: {} });
    expect(importPresetBundle(root, null as any)).toMatchObject({ error: expect.any(String) });
    expect(importPresetBundle(root, {} as any)).toMatchObject({ error: expect.any(String) });
    expect(importPresetBundle(root, { ...base(), format: "x" })).toMatchObject({ error: expect.any(String) });
    expect(importPresetBundle(root, { ...base(), version: 2 })).toMatchObject({ error: expect.any(String) });
    expect(importPresetBundle(root, { ...base(), id: "../etc" })).toMatchObject({ error: expect.stringContaining("id") });
    expect(importPresetBundle(root, { ...base(), presetMd: "   " })).toMatchObject({ error: expect.stringContaining("presetMd") });
    expect(existsSync(path.join(root, "presets"))).toBe(false); // 拒绝后不写半个剧本（连 presets 根都不建）
  });

  it("危险文件名（../、子目录、反斜杠、.. 片段）→ error，不落盘", () => {
    const bundle = () =>
      ({ format: "bunkiten-preset", version: 1, id: "evil", presetMd: "# x\n", assets: {} as Record<string, string>, audio: {} as Record<string, string> });
    const b64 = Buffer.from("aa").toString("base64");
    for (const name of ["../x.jpg", "sub/x.jpg", "..\\x.jpg", "a..b.jpg", "x.jpg/"]) {
      expect(importPresetBundle(root, { ...bundle(), assets: { [name]: b64 } })).toMatchObject({ error: expect.stringContaining("素材文件名") });
    }
    for (const name of ["../曲.mp3", "sub/曲.ogg", "a..b.wav"]) {
      expect(importPresetBundle(root, { ...bundle(), audio: { [name]: b64 } })).toMatchObject({ error: expect.stringContaining("音频文件名") });
    }
    expect(existsSync(path.join(root, "presets", "evil"))).toBe(false);
  });

  it("非法扩展名（assets 非 jpe?g / audio 不在白名单）→ error；缺 assets/audio 键的最小包照常导入", () => {
    const bundle = (over: Record<string, unknown> = {}) =>
      ({ format: "bunkiten-preset", version: 1, id: "ext", presetMd: "# x\n", assets: {}, audio: {}, ...over });
    const b64 = Buffer.from("aa").toString("base64");
    expect(importPresetBundle(root, bundle({ assets: { "a.png": b64 } }))).toMatchObject({ error: expect.stringContaining("素材文件名") });
    expect(importPresetBundle(root, bundle({ assets: { noext: b64 } }))).toMatchObject({ error: expect.any(String) });
    expect(importPresetBundle(root, bundle({ audio: { "曲-x.mp4": b64 } }))).toMatchObject({ error: expect.stringContaining("音频文件名") });
    expect(importPresetBundle(root, bundle({ audio: { "no-ext": b64 } }))).toMatchObject({ error: expect.any(String) });
    // 手写的最小包（只有 preset.md）照常导入：assets/audio 目录按需建
    expect(importPresetBundle(root, { format: "bunkiten-preset", version: 1, id: "bare", presetMd: "# x\n" } as any)).toEqual({
      ok: true,
      id: "bare",
    });
    expect(existsSync(path.join(root, "presets", "bare", "preset.md"))).toBe(true);
  });

  it("内容校验：非字符串 / 非 base64 / 解码为空 / 截断形态（Node 静默丢字符）→ error，不落盘", () => {
    const bundle = (assets: Record<string, unknown>, audio: Record<string, unknown> = {}) =>
      ({ format: "bunkiten-preset", version: 1, id: "b64", presetMd: "# x\n", assets, audio }) as any;
    expect(importPresetBundle(root, bundle({ "a.jpg": "AA!A" }))).toMatchObject({ error: expect.stringContaining("base64") });
    expect(importPresetBundle(root, bundle({ "a.jpg": 123 }))).toMatchObject({ error: expect.stringContaining("base64") });
    expect(importPresetBundle(root, bundle({ "a.jpg": "" }))).toMatchObject({ error: expect.stringContaining("base64") });
    // "AB" 是合法字母但不是完整 base64 词：Node 解码会静默丢位，round-trip 比对把它拦下
    expect(importPresetBundle(root, bundle({ "a.jpg": "AB" }))).toMatchObject({ error: expect.stringContaining("base64") });
    expect(importPresetBundle(root, bundle({}, { "曲-x.mp3": "??" }))).toMatchObject({ error: expect.stringContaining("base64") });
    expect(existsSync(path.join(root, "presets", "b64"))).toBe(false);
  });

  it("超长名与 Windows 保留名拒绝，presets 下无任何残留（临时目录也不留）——写盘异常防护", () => {
    seedPreset("demo");
    const b64 = Buffer.from("aa").toString("base64");
    const bundle = (assets: Record<string, string>, audio: Record<string, string> = {}) =>
      ({ format: "bunkiten-preset", version: 1, id: "long", presetMd: "# x\n", assets, audio }) as any;
    // 超长名在写盘前就该被拒（文件系统单名 255 字节上限，writeFileSync 抛 ENAMETOOLONG 的异常若
    // 冒出函数，Electron 主进程同进程 import server = 整应用闪退；端点侧该 error 映射 400）
    expect(importPresetBundle(root, bundle({ ["A".repeat(300) + ".jpg"]: b64 }))).toMatchObject({
      error: expect.stringContaining("素材文件名"),
    });
    // Windows 保留设备名：判去扩展名的 stem（大小写不敏感），`CON.jpg`/`com1.wav` 一样拒收
    expect(importPresetBundle(root, bundle({ "CON.jpg": b64 }))).toMatchObject({ error: expect.stringContaining("素材文件名") });
    expect(importPresetBundle(root, bundle({}, { "com1.wav": b64 }))).toMatchObject({ error: expect.stringContaining("音频文件名") });
    // presets 下只剩 seed 的 demo：无半个剧本、无 .tmp-* 临时目录
    expect(readdirSync(path.join(root, "presets"))).toEqual(["demo"]);
  });
});

describe("server restoreWorld：先备份再覆盖（CONTRACTS §2，临时 root）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "restore-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("写一条 backup（当前三文件）再覆盖为目标快照，返回 backupSeq", () => {
    const w = createWorld(root, "demo", "示例");
    const dir = path.join(root, w.worldId);
    const snapFiles = { state: "# 状态 v1\n", summary: "# 摘要 v1\n", tree: "- 当前进度: 节点 1-1（已走 0 轮）\n" };
    const s1 = writeSnapshot(root, w.worldId, { kind: "turn", nodeId: "1-1", chapterNo: 1, files: snapFiles }) as any;
    expect(s1.seq).toBe(1);
    // 剧情推进：磁盘文件更新（与快照不同）
    writeFileSync(path.join(dir, "state.md"), "# 状态 v2\n");
    writeFileSync(path.join(dir, "story-tree.md"), "- 当前进度: 节点 1-2（已走 3 轮）\n");

    const r = restoreWorld(root, w.worldId, 1) as any;
    expect(r.backupSeq).toBe(2);
    const snaps = readSnapshots(w.worldId, root) as any[];
    expect(snaps.map((s) => s.kind)).toEqual(["turn", "backup"]);
    expect(snaps[1].files.state).toBe("# 状态 v2\n"); // backup 存的是恢复前的当前状态
    expect(readFileSync(path.join(dir, "state.md"), "utf8")).toBe("# 状态 v1\n"); // 已覆盖成快照
    expect(readFileSync(path.join(dir, "story-tree.md"), "utf8")).toContain("节点 1-1（已走 0 轮）");

    expect(restoreWorld(root, w.worldId, 99)).toMatchObject({ error: "快照不存在" });
    expect(restoreWorld(root, "../etc", 1)).toMatchObject({ error: "参数不合法" });
  });

  it("精确分叉：有快照时以快照三文件建新世界（索引记 forkedFrom.seq），无快照走兼容路径", () => {
    const origin = createWorld(root, "demo", "示例");
    const dir = path.join(root, origin.worldId);
    const snapFiles = { state: "# 快照状态\n", summary: "# 快照摘要\n", tree: "- 当前进度: 节点 1-1（已走 0 轮）\n" };
    writeSnapshot(root, origin.worldId, { kind: "turn", nodeId: "1-1", chapterNo: 1, files: snapFiles });
    // 当前磁盘与快照不同：精确分叉必须用快照（而不是复制当前文件）
    writeFileSync(path.join(dir, "state.md"), "# 当前状态\n");
    writeFileSync(path.join(dir, "story-tree.md"), "- 当前进度: 节点 1-5（已走 9 轮）\n");

    const f = forkWorld(root, origin.worldId, "1-1", 1) as any;
    const fdir = path.join(root, f.worldId);
    expect(readFileSync(path.join(fdir, "state.md"), "utf8")).toBe("# 快照状态\n"); // 逐字来自快照
    expect(readFileSync(path.join(fdir, "story-tree.md"), "utf8")).toBe(snapFiles.tree);
    expect(existsSync(path.join(fdir, "fork.md"))).toBe(true);
    expect(f.entry.forkedFrom).toEqual({ worldId: origin.worldId, nodeId: "1-1", seq: 1 });
    // 精确来源记在 forkedFrom.seq；note 留空（同上：血缘不进玩家可见文案）
    expect(f.entry.note).toBe("");

    // 无快照的另一个世界 → 兼容路径（复制当前文件 + 本地回退）
    const plain = createWorld(root, "other", "对照");
    writeFileSync(path.join(root, plain.worldId, "story-tree.md"), "- 当前进度: 节点 2-4（已走 6 轮）\n");
    const cf = forkWorld(root, plain.worldId, "2-2") as any;
    expect(cf.entry.forkedFrom).toEqual({ worldId: plain.worldId, nodeId: "2-2" });
    expect(readFileSync(path.join(root, cf.worldId, "story-tree.md"), "utf8")).toContain("节点 2-2（已走 0 轮）");
  });
});

// ————————————————————— theme 新键：字体族与对话框质感（v1.7） —————————————————————

describe("server normalizeTheme：theme 新键 font/dialog（v1.7）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "theme-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("font/dialog 合法值透传（白名单与 src/theme.ts 同集；首尾空白被容忍）", () => {
    const t = normalizeTheme({ theme: { accent: "#4fd8c4", accent2: "#a8f0e4", motif: "rune", font: " kai ", dialog: "paper" } }) as Record<string, string>;
    expect(t.font).toBe("kai");
    expect(t.dialog).toBe("paper");
    expect(t.accent).toBe("#4fd8c4"); // 旧键照旧
  });

  it("font/dialog 非法或缺省回退 serif/plain：旧 preset 不配这两键，返回形状向后兼容", () => {
    const old = normalizeTheme({ theme: { accent: "#f0b95a", accent2: "#f7e3b0", motif: "summer" } }) as Record<string, string>;
    expect(old.font).toBe("serif");
    expect(old.dialog).toBe("plain");
    const bad = normalizeTheme({ theme: { font: "comic-sans", dialog: "neon" } }) as Record<string, string>;
    expect(bad.font).toBe("serif");
    expect(bad.dialog).toBe("plain");
    expect(bad.accent).toBe("#c9a86a"); // 坏值逐键兜底，互不连坐
  });

  it("frontmatter theme 块的 font/dialog 子键被收进 preset.theme（scanPresets 端到端）", () => {
    const d = path.join(root, "presets", "rain-rejection");
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "preset.md"),
      '---\nid: rain-rejection\ntitle: 雨巷排异\ntheme:\n  accent: "#4fd0d8"\n  accent2: "#e8b86a"\n  motif: aurora\n  font: hei\n  dialog: silk\n---\n# 主要角色\n',
    );
    const r = scanPresets(root) as { presets: Array<{ theme: Record<string, string> }>; errors: unknown[] };
    expect(r.errors).toEqual([]);
    expect(r.presets[0].theme).toMatchObject({ font: "hei", dialog: "silk", motif: "aurora" });
  });
});

// ————————————————————— 角色面板：state.md 容错解析与 /api/state 路由（v1.7） —————————————————————

describe("server parseStateFile：state.md 容错解析（v1.7 角色面板）", () => {
  /** SKILL「状态文件格式」的完整样例（引擎模板的典型产出） */
  const fullStateMd = [
    "# 剧情状态",
    "- preset: rift-mark",
    "- 周目: 2",
    "- 时间: 第三夜 · 雨停后",
    "- 场景: 灰雀镇廉价旅店 202 房",
    "",
    "# 主角",
    "- 姓名: 顾迟",
    "- 性别: 男",
    "- 身份: 自由调查员",
    "",
    "# 导演手记",
    "- 张力: 7",
    "- 本场景目标: 让薇拉交出账册缺页",
    "- 下一节拍: 旅店停电",
    "",
    "# 角色卡",
    "## 薇拉",
    "- 身份: 沉默的书记官",
    "- 性格关键词: 克制 · 观察型",
    "- 口癖: 「……先记账。」",
    "- 好感度: 62",
    "- art_prompt: silver hair, gray eyes",
    "- art_file: presets/rift-mark/assets/立绘-薇拉.jpg",
    "- 表情: 微笑",
    "- 秘密: 缺页是她自己撕的",
    "- 最近互动: 把账册推过来半寸",
    "",
    "## 沈屿",
    "- 身份: 谜之少年",
    "- 好感度: 很高",
    "- 秘密: 无",
    "",
    "# 场景美术",
    "- 灰雀镇廉价旅店: presets/rift-mark/assets/背景-灰雀镇廉价旅店.jpg",
    "",
    "# Flags",
    "- 已读旧信: true",
    "- 停电: false",
    "",
    "# 未回收伏笔",
    "- 教堂地窖的旧信还没打开（埋于第 3 轮）",
    "- 码头工人提到的白船",
  ].join("\n");

  it("完整样例：固定键各归各位，角色卡逐字段、伏笔拆轮次、Flags 收键值", () => {
    const v = parseStateFile(fullStateMd);
    expect(v.status).toEqual({ preset: "rift-mark", playthrough: 2, time: "第三夜 · 雨停后", scene: "灰雀镇廉价旅店 202 房" });
    expect(v.protagonist).toEqual({ 姓名: "顾迟", 性别: "男", 身份: "自由调查员" });
    expect(v.director).toEqual({ 张力: "7", 本场景目标: "让薇拉交出账册缺页", 下一节拍: "旅店停电" });
    expect(v.characters).toHaveLength(2);
    expect(v.characters[0]).toEqual({
      name: "薇拉",
      role: "沉默的书记官",
      traits: "克制 · 观察型",
      catchphrase: "「……先记账。」",
      favor: 62,
      artFile: "presets/rift-mark/assets/立绘-薇拉.jpg",
      expression: "微笑",
      secret: "缺页是她自己撕的",
      recentInteraction: "把账册推过来半寸",
    });
    // 缺的字段静默缺省：空串 / favor null；「无」原样保留（是否折叠由客户端判断）
    expect(v.characters[1]).toEqual({
      name: "沈屿",
      role: "谜之少年",
      traits: "",
      catchphrase: "",
      favor: null,
      artFile: "",
      expression: "",
      secret: "无",
      recentInteraction: "",
    });
    expect(v.flags).toEqual([
      { name: "已读旧信", value: "true" },
      { name: "停电", value: "false" },
    ]);
    expect(v.foreshadowing).toEqual([
      { text: "教堂地窖的旧信还没打开", turn: 3 },
      { text: "码头工人提到的白船", turn: null },
    ]);
    // 面板用不到的小节与角色卡键（场景美术 / art_prompt）不进响应
    const json = JSON.stringify(v);
    expect(json).not.toContain("art_prompt");
    expect(json).not.toContain("背景-");
  });

  it("缺小节：只有角色卡也能解析，其余小节保持缺省（status 全 null、Record 空）", () => {
    const v = parseStateFile("# 角色卡\n## 薇拉\n- 好感度: 40\n- 身份: 书记官\n");
    expect(v.status).toEqual({ preset: null, playthrough: null, time: null, scene: null });
    expect(v.protagonist).toEqual({});
    expect(v.director).toEqual({});
    expect(v.flags).toEqual([]);
    expect(v.foreshadowing).toEqual([]);
    expect(v.characters).toEqual([
      {
        name: "薇拉",
        role: "书记官",
        traits: "",
        catchphrase: "",
        favor: 40,
        artFile: "",
        expression: "",
        secret: "",
        recentInteraction: "",
      },
    ]);
  });

  it("小节乱序：Flags/伏笔/角色卡在剧情状态之前照样各归各位", () => {
    const v = parseStateFile(
      [
        "# Flags",
        "- 信任神父: true",
        "",
        "# 未回收伏笔",
        "- 白船（埋于第 1 轮）",
        "",
        "# 角色卡",
        "## 薇拉",
        "- 好感度: 55",
        "",
        "# 剧情状态",
        "- preset: rift-mark",
        "- 周目: 1",
        "- 时间: 第一夜",
        "- 场景: 教堂",
      ].join("\n"),
    );
    expect(v.status.preset).toBe("rift-mark");
    expect(v.status.scene).toBe("教堂");
    expect(v.characters[0]).toMatchObject({ name: "薇拉", favor: 55 });
    expect(v.flags).toEqual([{ name: "信任神父", value: "true" }]);
    expect(v.foreshadowing).toEqual([{ text: "白船", turn: 1 }]);
  });

  it("越界好感度：整数夹进 [0,100]，非整数（「很高」）为 null", () => {
    const v = parseStateFile(
      ["# 角色卡", "## 甲", "- 好感度: 150", "## 乙", "- 好感度: -20", "## 丙", "- 好感度: 很高", "## 丁", "- 好感度: 约 80"].join("\n"),
    );
    expect(v.characters.map((c) => c.favor)).toEqual([100, 0, null, 80]);
  });

  it("空文本 / 纯标题：不抛错，返回全缺省形状", () => {
    const empty = parseStateFile("");
    expect(empty).toEqual({
      status: { preset: null, playthrough: null, time: null, scene: null },
      protagonist: {},
      director: {},
      characters: [],
      flags: [],
      foreshadowing: [],
    });
    expect(parseStateFile(null)).toEqual(empty);
    expect(parseStateFile("# 剧情状态\n（还没写）\n")).toEqual(empty);
  });

  it("未知小节与未知键忽略；全角冒号与半角冒号都认", () => {
    const v = parseStateFile(
      ["# 随手记", "- 杂项: 不进面板", "", "# 主角", "- 姓名：全角冒号"].join("\n"),
    );
    expect(v.protagonist).toEqual({ 姓名: "全角冒号" });
    expect(JSON.stringify(v)).not.toContain("随手记");
    expect(JSON.stringify(v)).not.toContain("杂项");
  });

  it("标题带行尾括注（拷贝模板的漂移）不丢小节：# 角色卡（每个角色一节）照常开卡", () => {
    const v = parseStateFile("# 角色卡（每个角色一节）\n## 薇拉\n- 好感度: 62\n- 秘密: 知道太多\n");
    expect(v.characters).toHaveLength(1);
    expect(v.characters[0]).toMatchObject({ name: "薇拉", favor: 62, secret: "知道太多" });
  });

  it("同名角色卡 last-wins 去重：引擎整文件重写新旧卡并存时只留最后一张", () => {
    const v = parseStateFile(
      ["# 角色卡", "## 薇拉", "- 好感度: 12", "## 沈屿", "- 好感度: 50", "## 薇拉", "- 好感度: 62"].join("\n"),
    );
    expect(v.characters.map((c) => c.name)).toEqual(["沈屿", "薇拉"]);
    expect(v.characters.find((c) => c.name === "薇拉")?.favor).toBe(62);
  });
});

describe("server stateViewFor：GET /api/state 路由判定（v1.7，临时 root）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "state-view-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("worldId 缺失或非法 → 400；合法且世界存在 → 200 + 解析视图（带 worldId 回显）", () => {
    expect(stateViewFor("")).toMatchObject({ code: 400 });
    expect(stateViewFor("../etc")).toMatchObject({ code: 400 });
    expect(stateViewFor("a/b")).toMatchObject({ code: 400 });
    mkdirSync(path.join(root, "w1"), { recursive: true });
    writeFileSync(path.join(root, "w1", "state.md"), "# 剧情状态\n- preset: demo\n");
    const ok = stateViewFor("w1", root) as { code: number; body: Record<string, unknown> };
    expect(ok.code).toBe(200);
    expect(ok.body.worldId).toBe("w1");
    expect((ok.body.status as Record<string, unknown>).preset).toBe("demo");
  });

  it("世界没有 state.md → 404（还没写过状态文件的世界）", () => {
    mkdirSync(path.join(root, "w2"), { recursive: true }); // 目录在、state.md 不在
    expect(stateViewFor("w2", root)).toMatchObject({ code: 404 });
    expect(stateViewFor("nope-1", root)).toMatchObject({ code: 404 }); // 目录都不在
  });
});

// ————————————— 剧本体检：GET /api/presets/check 的路由判定与响应形状（v1.8） —————————————

describe("server presetCheckView：GET /api/presets/check 的判定与响应形状（v1.8，临时 root）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "preset-check-"));
    mkdirSync(path.join(root, "presets"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 一份七组全绿的 preset.md：frontmatter 五键齐全（id 可参数化）、`# 主要角色` 带建议字段、protagonist_card 有行 */
  function goodMd(id = "demo"): string {
    return [
      "---",
      `id: ${id}`,
      "title: 体检样本",
      "tagline: 一句话简介",
      "genre: 演示",
      "rating: 全年龄",
      "theme:",
      '  accent: "#c9a86a"',
      '  accent2: "#e8e4da"',
      "  motif: aurora",
      "  font: serif",
      "  dialog: plain",
      "---",
      "",
      "# 主要角色",
      "",
      "## 薇拉（沉默的书记官）",
      "- art_prompt: silver hair, gray eyes",
      "- agenda: 交出账册缺页",
      "",
      "# protagonist_card",
      "",
      "- 性别: 男 / 女",
    ].join("\n");
  }

  /** 造剧本目录（写好 preset.md 与 cover.jpg；assets/audio 目录按需由用例自己建） */
  function writePreset(dir: string, md: string) {
    const d = path.join(root, "presets", dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "preset.md"), md);
    writeFileSync(path.join(d, "cover.jpg"), "x");
  }

  it("id 缺失或非法 → 400；剧本目录不存在 → 404（两者都先于模块可用性：坏请求/空目录不该报「模块不可用」）", () => {
    for (const bad of ["", "../etc", "a/b", "中文剧本"]) {
      expect(presetCheckView(bad, root, checkPreset)).toMatchObject({ code: 400 });
      expect(presetCheckView(bad, root, null)).toMatchObject({ code: 400 }); // 没有 doctor 模块也照旧 400
    }
    expect(presetCheckView("nope", root, checkPreset)).toMatchObject({ code: 404 });
    expect(presetCheckView("nope", root, null)).toMatchObject({ code: 404 });
    expect(presetCheckView("nope", root, null).body.ok).toBe(false);
  });

  it("doctor 模块不可用 → 503 + ok:false 说明（scripts/ 不在打包 layout 里，server 不能因此起不来）", () => {
    writePreset("demo", goodMd());
    const out = presetCheckView("demo", root, null) as { code: number; body: { ok: boolean; error: string } };
    expect(out.code).toBe(503);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toContain("scripts/doctor.mjs");
  });

  it("全绿剧本：200，七组各一条 ok，title 取 frontmatter、行原文逐字来自 doctor（组名与报告顺序一致）", () => {
    writePreset("demo", goodMd());
    const out = presetCheckView("demo", root, checkPreset) as {
      code: number;
      body: { ok: boolean; id: string; title: string; items: Array<{ level: string; group: string; label: string }> };
    };
    expect(out.code).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.id).toBe("demo");
    expect(out.body.title).toBe("体检样本");

    // 组名与顺序 = doctor 的七组（归组表必须认得出 doctor 的每一行——认不出的会被归到「其他」并在这里暴露）
    expect(out.body.items.map((i) => i.group)).toEqual([
      "frontmatter",
      "theme",
      "正文小节",
      "封面",
      "资产命名",
      "孤儿素材",
      "音频",
    ]);
    expect(out.body.items.map((i) => i.level)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    // 行原文与 doctor 自己的产出逐字相同（同参数再跑一次真函数对照）
    const doctorOut = checkPreset(path.join(root, "presets", "demo"), root) as { findings: Array<{ message: string }> };
    expect(out.body.items.map((i) => i.label)).toEqual(doctorOut.findings.map((f) => f.message));
    expect(out.body.items[0].label.startsWith("frontmatter：")).toBe(true);
  });

  it("id 与目录名不一致 → ok:false 且 error 落在 frontmatter 组；表外行归「其他」但不丢条目", () => {
    writePreset("demo", goodMd("demo-x"));
    const out = presetCheckView("demo", root, checkPreset) as {
      code: number;
      body: { ok: boolean; items: Array<{ level: string; group: string; label: string }> };
    };
    expect(out.code).toBe(200); // 目录在 → 200：体检结论本身是「有问题」，不是请求失败
    expect(out.body.ok).toBe(false); // ok 为 false ⟺ 至少一条 error
    const errors = out.body.items.filter((i) => i.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((i) => i.group === "frontmatter")).toBe(true);
    expect(errors.map((i) => i.label).join("\n")).toContain("≠ 目录名");
    expect(errors.map((i) => i.label).join("\n")).toContain("demo-x");

    // 归属表兜底：doctor 以后新增的行（或措辞变了）归「其他」而不是被静默丢掉——组名只是画块用，条目一条不少
    const fallback = presetCheckResult({ id: "demo", findings: [{ level: "error", message: "将来某天新增的一行" }] }, "") as {
      ok: boolean;
      id: string;
      title: string;
      items: Array<{ group: string; label: string }>;
    };
    expect(fallback.items).toEqual([{ level: "error", group: "其他", label: "将来某天新增的一行" }]);
    expect(fallback.ok).toBe(false);
    expect(fallback.title).toBe("demo"); // 没有标题就回落 id，不留空行
  });
});
