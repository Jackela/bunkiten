// 数据根准备（server/data-root.mjs）的单测：一次性迁移、seed-sync、幂等。
// 为什么专门测它：打包态首启把玩家数据从「产物内 resources/game」搬到 userData/game，且以后每次启动
// 都跑 seed-sync——迁移是唯一会碰玩家数据的不可逆面（只复制不删源），seed-sync 的「改过就不碰」是数据安全线。
// 这里用 tmp 目录自己搭 bundle/dataRoot，不依赖 Electron（迁移/记账全是纯文件系统逻辑）。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEEDED_FILE, isSeededPreset, prepareDataRoot, readSeedManifest } from "../server/data-root.mjs";

/** 临时根目录 @returns {string} */
function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-data-root-"));
}

/** 写一个文件（含父目录） @param {string} file 绝对路径 @param {string|Buffer} content 内容 */
function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 读文本 @param {string} file 绝对路径 @returns {string} */
function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]); // 假的 jpg 字节（只验二进制逐字节复制）

/**
 * 搭一个「产物 bundle」：presets（两个剧本 + 素材）、state（README + 一条世界线）、.shell-session.json。
 * @param {string} root 临时根目录
 * @returns {string} bundleRoot
 */
function makeBundle(root: string): string {
  const bundleRoot = path.join(root, "bundle");
  write(path.join(bundleRoot, "presets", "demo", "preset.md"), "# demo v1\n");
  write(path.join(bundleRoot, "presets", "demo", "assets", "立绘-薇拉.jpg"), JPG);
  write(path.join(bundleRoot, "presets", "other", "preset.md"), "# other v1\n");
  write(path.join(bundleRoot, "state", "README.md"), "state 说明\n");
  write(path.join(bundleRoot, "state", "worlds", "main", "state.md"), "# 状态\n- preset: demo\n");
  write(path.join(bundleRoot, ".shell-session.json"), '{"engine":"grok","sessionId":"s1"}\n');
  return bundleRoot;
}

describe("prepareDataRoot：一次性迁移（复制不删源 + 种子记账）", () => {
  it("全新数据根：复制 state/presets/.shell-session.json，登记种子哈希，源文件仍在", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");

    const r = prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    expect(r.migrated).toBe(true);
    // 整树复制（文本逐字、二进制逐字节）
    expect(read(path.join(dataRoot, "presets", "demo", "preset.md"))).toBe("# demo v1\n");
    expect(fs.readFileSync(path.join(dataRoot, "presets", "demo", "assets", "立绘-薇拉.jpg")).equals(JPG)).toBe(true);
    expect(read(path.join(dataRoot, "presets", "other", "preset.md"))).toBe("# other v1\n");
    expect(read(path.join(dataRoot, "state", "README.md"))).toBe("state 说明\n");
    expect(read(path.join(dataRoot, "state", "worlds", "main", "state.md"))).toContain("- preset: demo");
    expect(read(path.join(dataRoot, ".shell-session.json"))).toContain("sessionId");
    // `.seeded.json` 记账：bundle 里每个 preset 文件都登记了哈希（否则升级不更新 / 内置剧本被误判可删）
    expect(Object.keys(readSeedManifest(dataRoot)).sort()).toEqual(
      ["presets/demo/assets/立绘-薇拉.jpg", "presets/demo/preset.md", "presets/other/preset.md"].sort(),
    );
    // 迁移是**复制**：bundle 里的源文件一个都不能少（失败保底 / 回退靠它）
    expect(read(path.join(bundleRoot, "presets", "demo", "preset.md"))).toBe("# demo v1\n");
    expect(fs.existsSync(path.join(bundleRoot, "state", "worlds", "main", "state.md"))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, ".shell-session.json"))).toBe(true);
  });

  it("迁移后 isSeededPreset 认内置剧本、不认玩家自有剧本", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");
    prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    expect(isSeededPreset(dataRoot, "demo")).toBe(true);
    expect(isSeededPreset(dataRoot, "other")).toBe(true);
    expect(isSeededPreset(dataRoot, "player-made")).toBe(false);
  });

  it("state 与 presets 各自独立判定：只有 presets 缺时不重复搬 state", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");
    prepareDataRoot({ dataRoot, bundleRoot, migrate: true });
    // 世界线被玩家删过之后 state/ 仍在（目录还在），只剩 presets 空着 → 只有 presets 那一次判定为「空」
    fs.rmSync(path.join(dataRoot, "presets"), { recursive: true, force: true });
    const r = prepareDataRoot({ dataRoot, bundleRoot, migrate: true });
    expect(r.migrated).toBe(true);
    expect(read(path.join(dataRoot, "presets", "demo", "preset.md"))).toBe("# demo v1\n");
  });
});

describe("prepareDataRoot：幂等", () => {
  it("第二次跑零动作、manifest 与文件内容不动", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");
    prepareDataRoot({ dataRoot, bundleRoot, migrate: true });
    const manifestBefore = readSeedManifest(dataRoot);
    const presetBefore = read(path.join(dataRoot, "presets", "demo", "preset.md"));

    const r2 = prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    expect(r2).toEqual({ migrated: false, seeded: 0, updated: 0 });
    expect(readSeedManifest(dataRoot)).toEqual(manifestBefore);
    expect(read(path.join(dataRoot, "presets", "demo", "preset.md"))).toBe(presetBefore);
  });
});

describe("prepareDataRoot：seed-sync", () => {
  it("bundle 新增文件 → 补拷并登记", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");
    prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    const audio = Buffer.from([9, 9, 9]);
    write(path.join(bundleRoot, "presets", "demo", "audio", "曲-夜灯谣.wav"), audio);
    const r = prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    expect(r.seeded).toBe(1);
    expect(fs.readFileSync(path.join(dataRoot, "presets", "demo", "audio", "曲-夜灯谣.wav")).equals(audio)).toBe(true);
    expect(readSeedManifest(dataRoot)["presets/demo/audio/曲-夜灯谣.wav"]).toBeTruthy();
  });

  it("玩家改过的种子文件：bundle 内容变更也不覆盖", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");
    prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    // 玩家把 demo 的 preset.md 改了；bundle 随后发新版
    write(path.join(dataRoot, "presets", "demo", "preset.md"), "# 玩家手改\n");
    write(path.join(bundleRoot, "presets", "demo", "preset.md"), "# demo v2\n");
    const r = prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    expect(r.updated).toBe(0);
    expect(read(path.join(dataRoot, "presets", "demo", "preset.md"))).toBe("# 玩家手改\n");
  });

  it("玩家没改过的种子：bundle 内容变更则随版本更新", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");
    prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    write(path.join(bundleRoot, "presets", "other", "preset.md"), "# other v2\n");
    const r = prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    expect(r.updated).toBe(1);
    expect(read(path.join(dataRoot, "presets", "other", "preset.md"))).toBe("# other v2\n");
  });

  it("数据根已有、但清单里没登记的玩家自有文件：一律不碰", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");
    prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    // 玩家自建剧本（bundle 里没有 → 永远不该出现在清单，也不该被覆盖）
    write(path.join(dataRoot, "presets", "mine", "preset.md"), "# 我写的\n");
    const r = prepareDataRoot({ dataRoot, bundleRoot, migrate: true });

    expect(r.seeded).toBe(0);
    expect(r.updated).toBe(0);
    expect(read(path.join(dataRoot, "presets", "mine", "preset.md"))).toBe("# 我写的\n");
    expect(readSeedManifest(dataRoot)["presets/mine/preset.md"]).toBeUndefined();
  });
});

describe("prepareDataRoot：migrate=false 或 dataRoot===bundleRoot 时零动作", () => {
  it("migrate=false（dev）：不复制、不建清单", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const dataRoot = path.join(root, "data");

    const r = prepareDataRoot({ dataRoot, bundleRoot, migrate: false });

    expect(r).toEqual({ migrated: false, seeded: 0, updated: 0 });
    expect(fs.existsSync(path.join(dataRoot, "presets"))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, "state"))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, "presets", SEEDED_FILE))).toBe(false);
  });

  it("dataRoot===bundleRoot（dev 回落）：不复制、不写清单、bundle 原样", () => {
    const root = tmpRoot();
    const bundleRoot = makeBundle(root);
    const before = read(path.join(bundleRoot, "presets", "demo", "preset.md"));

    const r = prepareDataRoot({ dataRoot: bundleRoot, bundleRoot, migrate: true });

    expect(r).toEqual({ migrated: false, seeded: 0, updated: 0 });
    expect(fs.existsSync(path.join(bundleRoot, "presets", SEEDED_FILE))).toBe(false);
    expect(read(path.join(bundleRoot, "presets", "demo", "preset.md"))).toBe(before);
  });
});

describe("readSeedManifest：缺文件 / 坏 JSON 都当「没有」", () => {
  it("文件不存在 → 空对象", () => {
    expect(readSeedManifest(tmpRoot())).toEqual({});
  });

  it("坏 JSON → 空对象（不抛）", () => {
    const root = tmpRoot();
    write(path.join(root, "presets", SEEDED_FILE), "{ 不是 JSON");
    expect(readSeedManifest(root)).toEqual({});
  });

  it("形态不对（files 不是对象）→ 空对象", () => {
    const root = tmpRoot();
    write(path.join(root, "presets", SEEDED_FILE), JSON.stringify({ version: 1, files: [1, 2] }));
    expect(readSeedManifest(root)).toEqual({});
  });
});
