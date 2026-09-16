// server 协议行解析单测（v1.4 起入 vitest；此前只有临时 node -e 断言）。
// import 不触发 startServer/spawn（模块以 invokedDirectly 守卫自启）。
// 注意：行完整性（半行不生效）由上游 flushArtLines 的换行累积保证，不在这些函数的职责内——
// 这里只测「给定一行」的解析契约。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assetRelPath,
  assetTargetFile,
  createWorld,
  deleteWorld,
  forkNote,
  forkTreeMarkdown,
  forkWorld,
  isDirectivePrompt,
  legacyAssetCandidates,
  listWorlds,
  migrateLegacyState,
  parseArtLine,
  parseExpressionLine,
  parsePresetAddedLine,
  parseTreeLine,
  parseWorldRef,
  presetAssetsDir,
  presetFromStateFile,
  presetIdFromPath,
  readWorldsIndex,
  resolvePersistPreset,
  scanPresets,
  worldChapterNo,
} from "../server/acp-server.mjs";

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
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "worlds-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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

  it("forkWorld：复制三文件 + fork.md + 索引 forkedFrom/note，进度回退；来源世界不受影响", () => {
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
    expect(entry.note).toBe("分叉自 campus-summer-1 @ 2-2");
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

  it("deleteWorld：删目录并同步索引；未知世界返回 error", () => {
    const a = createWorld(root, "campus-summer", "盛夏偏差值");
    expect(deleteWorld(root, a.worldId)).toEqual({ ok: true });
    expect(existsSync(path.join(root, a.worldId))).toBe(false);
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
