// 剧本体检（doctor）纯函数单测（v1.7）：tmp 根造 preset，覆盖 checkPreset 的七组判定与
// checkAllPresets 的汇总口径。引用面（孤儿判定）与退出码语义都在内。
// 断言一律用 match 检索 message，不用正则断言方法调用——契约计数的字面口径见 tests/contract.test.ts 第 ④ 组。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAllPresets, checkPreset } from "../scripts/doctor.mjs";

/** 造一个 tmp 游戏根：presets/ 与 state/worlds/ 就位（checkPreset 的 root 参数吃它） */
function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bunkiten-doctor-"));
  mkdirSync(path.join(root, "presets"), { recursive: true });
  mkdirSync(path.join(root, "state", "worlds"), { recursive: true });
  return root;
}

const GOOD_FM = `---
id: demo
title: 演示剧本
tagline: 一句话简介
genre: 演示
rating: 全年龄
art_style: anime illustration
theme:
  accent: "#c9a86a"
  accent2: "#e8e4da"
  motif: aurora
  font: serif
  dialog: plain
---`;

const GOOD_BODY = `
# 世界观

演示剧本，发生在演示教室。

# quick_start（快速开局预设主角）

- 姓名: 阿演

# 主要角色

## 阿明（男，20）
- 身份：挚友
- art_prompt: anime boy
- agenda：睡觉

# protagonist_card（自定义主角卡，新开局逐问询问）

- 性别: 男 / 女

# opening（第一幕指令）

开场。
`;

/** 完整合法的 preset.md（id 可参数化；assets 里「阿明」「演示」都会被正文提及，用于孤儿判定的解救面） */
function goodMd(id = "demo"): string {
  return GOOD_FM.replace("id: demo", `id: ${id}`) + GOOD_BODY;
}

/** 写一个 preset 目录：preset.md + 可选 cover（默认写）/ assets / audio 文件 */
function writePreset(
  root: string,
  id: string,
  md: string,
  opts: { cover?: boolean; assets?: string[]; audio?: string[] } = {},
): string {
  const dir = path.join(root, "presets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "preset.md"), md);
  if (opts.cover !== false) writeFileSync(path.join(dir, "cover.jpg"), "x");
  if (opts.assets?.length) {
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    for (const f of opts.assets) writeFileSync(path.join(dir, "assets", f), "x");
  }
  if (opts.audio?.length) {
    mkdirSync(path.join(dir, "audio"), { recursive: true });
    for (const f of opts.audio) writeFileSync(path.join(dir, "audio", f), "x");
  }
  return dir;
}

/** 某 level 的 message 列表（结果来自无类型标注的 .mjs，这里按结构取用） */
function messagesOf(result: any, level: string): string[] {
  return result.findings.filter((f: any) => f.level === level).map((f: any) => f.message);
}

describe("doctor：剧本体检查纯函数", () => {
  it("全好剧本：七组检查全 [ok]，零警告零错误", () => {
    const root = makeRoot();
    try {
      const dir = writePreset(root, "demo", goodMd(), {
        assets: ["立绘-阿明.jpg", "背景-演示.jpg"],
        audio: ["曲-夜.mp3"],
      });
      const r = checkPreset(dir, root);
      expect(r.errors).toBe(0);
      expect(r.warnings).toBe(0);
      expect(r.passed).toBe(7);
      expect(r.id).toBe("demo");
      expect(
        r.findings.every((f: any) => f.level === "ok"),
        JSON.stringify(r.findings),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("frontmatter：缺必填键 → error；id≠目录名 → error；id 含非法字符 → error 且不叠报目录名不一致", () => {
    const root = makeRoot();
    try {
      const noTagline = writePreset(root, "a1", goodMd("a1").replace("tagline: 一句话简介\n", ""));
      const e1 = messagesOf(checkPreset(noTagline, root), "error");
      expect(e1.join("\n")).toMatch(/缺必填键：tagline（标题屏卡片的 tagline 栏位将为空/);

      const mismatch = writePreset(root, "a2", goodMd("other-id"));
      const e2 = messagesOf(checkPreset(mismatch, root), "error");
      expect(e2.join("\n")).toMatch(/id「other-id」≠ 目录名「a2」/);

      const illegal = writePreset(root, "a3", goodMd("演示剧本 id"));
      const e3 = messagesOf(checkPreset(illegal, root), "error");
      expect(e3.join("\n")).toMatch(/id「演示剧本 id」非法/);
      expect(e3.join("\n")).not.toMatch(/≠ 目录名/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("正文小节：缺 # 主要角色 → error；缺 protagonist_card / 角色缺建议字段 → warning", () => {
    const root = makeRoot();
    try {
      const noCast = writePreset(root, "b1", goodMd("b1").replace(/# 主要角色[\s\S]*?(?=# protagonist_card)/, ""));
      const r1 = checkPreset(noCast, root);
      expect(messagesOf(r1, "error").join("\n")).toMatch(/缺 `# 主要角色` 小节/);

      const noCard = writePreset(root, "b2", goodMd("b2").replace(/# protagonist_card[\s\S]*?(?=# opening)/, ""));
      const r2 = checkPreset(noCard, root);
      expect(r2.errors).toBe(0);
      expect(messagesOf(r2, "warn").join("\n")).toMatch(/缺 `# protagonist_card` 小节/);

      const noField = writePreset(root, "b3", goodMd("b3").replace("- art_prompt: anime boy\n", ""));
      const r3 = checkPreset(noField, root);
      expect(r3.errors).toBe(0);
      expect(messagesOf(r3, "warn").join("\n")).toMatch(/角色「阿明」缺建议字段 art_prompt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("资产命名：非 <立绘|背景>-<名>.jpg 形态 → error（server 落不进盘、/img 白名单不直服）", () => {
    const root = makeRoot();
    try {
      const dir = writePreset(root, "c1", goodMd("c1"), { assets: ["foo.jpg", "立绘-阿明.png", "背景-演示.jpg"] });
      const errs = messagesOf(checkPreset(dir, root), "error");
      expect(errs).toHaveLength(2);
      expect(errs.join("\n")).toMatch(/assets\/foo\.jpg/);
      expect(errs.join("\n")).toMatch(/assets\/立绘-阿明\.png/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("孤儿素材：无引用 → warning 列出；state.md 的 art_file 引用与 preset.md 名字提及都能解救", () => {
    const root = makeRoot();
    try {
      mkdirSync(path.join(root, "state", "worlds", "w1"), { recursive: true });
      writeFileSync(
        path.join(root, "state", "worlds", "w1", "state.md"),
        [
          "# 剧情状态",
          "- preset: demo",
          "",
          "# 角色卡",
          "## 路人",
          "- art_file: presets/demo/assets/立绘-路人.jpg",
          "",
        ].join("\n"),
      );
      const dir = writePreset(root, "demo", goodMd(), { assets: ["立绘-阿明.jpg", "立绘-路人.jpg", "背景-荒地.jpg"] });
      const warns = messagesOf(checkPreset(dir, root), "warn");
      expect(warns.join("\n")).toMatch(/孤儿素材 1 个[^\n]*背景-荒地\.jpg/);
      expect(warns.join("\n")).not.toMatch(/立绘-阿明|立绘-路人/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("音频：类型不在 曲/环境/音效、扩展名不合法 → error（scanPresetAudio 会静默跳过它们）", () => {
    const root = makeRoot();
    try {
      const dir = writePreset(root, "d1", goodMd("d1"), { audio: ["BGM-夜.mp3", "曲-夜.txt", "环境-雨.mp3"] });
      const errs = messagesOf(checkPreset(dir, root), "error");
      expect(errs).toHaveLength(2);
      expect(errs.join("\n")).toMatch(/audio\/BGM-夜\.mp3/);
      expect(errs.join("\n")).toMatch(/audio\/曲-夜\.txt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("音频：同名「类型-名」不同扩展名 → warning（索引按类型|名映射，只会播到一份）", () => {
    const root = makeRoot();
    try {
      const dir = writePreset(root, "d2", goodMd("d2"), { audio: ["曲-夜.mp3", "曲-夜.ogg", "音效-门.wav"] });
      const r = checkPreset(dir, root);
      expect(r.errors).toBe(0);
      const warns = messagesOf(r, "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/「曲-夜」有多份（mp3、ogg）/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("封面：缺 cover.jpg → warning（不升 error，标题屏回退主题渐变）", () => {
    const root = makeRoot();
    try {
      const dir = writePreset(root, "e1", goodMd("e1"), { cover: false });
      const r = checkPreset(dir, root);
      expect(r.errors).toBe(0);
      expect(messagesOf(r, "warn").join("\n")).toMatch(/缺封面 cover\.jpg/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("theme：非法 accent / 白名单外 font → 逐键 warning「将回退」；整块缺失 → 一条整套回退", () => {
    const root = makeRoot();
    try {
      const md1 = goodMd("f1").replace('accent: "#c9a86a"', "accent: #12").replace("font: serif", "font: gothic");
      const r1 = checkPreset(writePreset(root, "f1", md1), root);
      expect(r1.errors).toBe(0);
      const warns1 = messagesOf(r1, "warn").join("\n");
      expect(warns1).toMatch(/theme\.accent「#12」非法，将被 server 回退 #c9a86a/);
      expect(warns1).toMatch(/theme\.font「gothic」非法，将被 server 回退 serif/);

      const themeBlock =
        'theme:\n  accent: "#c9a86a"\n  accent2: "#e8e4da"\n  motif: aurora\n  font: serif\n  dialog: plain\n';
      const r2 = checkPreset(writePreset(root, "f2", goodMd("f2").replace(themeBlock, "")), root);
      expect(messagesOf(r2, "warn")).toHaveLength(1);
      expect(messagesOf(r2, "warn")[0]).toMatch(/theme 块缺失，将整套回退默认/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("theme：server 放行但客户端更严（#abc 三位 hex、白名单外 motif）→「将被客户端回退」warning", () => {
    const root = makeRoot();
    try {
      const md = goodMd("g1").replace('accent: "#c9a86a"', 'accent: "#abc"').replace("motif: aurora", "motif: winter");
      const r = checkPreset(writePreset(root, "g1", md), root);
      expect(r.errors).toBe(0);
      const warns = messagesOf(r, "warn").join("\n");
      expect(warns).toMatch(/theme\.accent「#abc」不是 6 位 hex[^\n]*将被客户端回退 #c9a86a/);
      expect(warns).toMatch(/theme\.motif「winter」不在客户端母题集[^\n]*将被客户端回退 aurora/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("封面：只有 cover.jpeg → warning 提示改名（客户端 coverUrl 只请求 cover.jpg）", () => {
    const root = makeRoot();
    try {
      const dir = writePreset(root, "g2", goodMd("g2"), { cover: false });
      writeFileSync(path.join(dir, "cover.jpeg"), "x");
      const r = checkPreset(dir, root);
      expect(r.errors).toBe(0);
      const warns = messagesOf(r, "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/只有 cover\.jpeg[^\n]*请改名为 cover\.jpg/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkAllPresets：按目录名排序、逐剧本汇总计数、缺 preset.md 的目录报 error 且不再查其他组", () => {
    const root = makeRoot();
    try {
      writePreset(root, "bbb", goodMd("bbb"));
      writePreset(root, "aaa", goodMd("aaa"), { audio: ["x.mp3"] });
      mkdirSync(path.join(root, "presets", "ccc"), { recursive: true }); // 无 preset.md
      const all = checkAllPresets(root);
      expect(all.results.map((r: any) => r.dir)).toEqual(["aaa", "bbb", "ccc"]);
      expect(all.errors).toBe(2); // aaa 音频命名 1 + ccc 缺 preset.md 1
      expect(all.warnings).toBe(0);
      expect(all.passed).toBe(13); // aaa 6 + bbb 7 + ccc 0
      const ccc = all.results[2];
      expect(ccc.errors).toBe(1);
      expect(messagesOf(ccc, "error")[0]).toMatch(/preset\.md 缺失/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
