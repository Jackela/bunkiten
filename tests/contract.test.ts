// 契约 lint（v1.6 起防漂移门禁）：文本协议是一组逐字字符串，散在多处——
// 引擎提示词（.grok/skills/bunkiten/SKILL.md）、服务端（server/acp-server.mjs）、
// 客户端（src/lib/parser.ts、src/lib/settings.ts）、共享真源（shared/protocol.mjs，v1.7 起）、
// 文档（docs/ARCHITECTURE.md、README.md、AGENTS.md）。
// 任何单点改动都会让引擎与客户端对不上，所以这里把「谁必须和谁一字不差」收进一个文件，
// 失败信息一律写明「谁和谁不一致、现在各是什么」，而不是只说 toBe 失败。
//
// 覆盖六组断言（与 docs/ARCHITECTURE.md「文本协议契约」开头那段声明同源）：
//   ① 协议头集合唯一真源：shared/protocol.mjs 的 PROTOCOL_HEADS ↔ isProtocolLine 正则（parser.ts 构造）↔ server/parser 解析出口 ↔ SKILL 备忘 ↔ 文档
//   ② RULES 逐字副本：server 常量 ↔ ARCHITECTURE 的 RULES 代码块（6 句，第 6 句音频纪律；引擎只读 .grok/ 不 import 代码，这份天然双份）
//   ③ 指令字符串双处存在：src/lib/parser.ts 源码 ↔ SKILL.md
//   ④ 用例数下限：CASE_GROUPS 的分组下限 ↔ 各测试文件实际用例数（**唯一维护点**；三份文档只留一句粗口径、
//     不再逐分组抄数字——v1.9 减税：加用例不用改任何文档，删用例这里会红）
//   ⑤ 设置键与音频扩展名：settings.ts / shared 真源 / 文档三处一致
//   ⑥ 指令前缀、章标记与主题白名单（v1.7）：DIRECTIVE_PREFIX_RE / CHAPTER_MARK_RE 单一真源（pickEffort/isMainTurn、
//     parseChapterMark/质量守卫豁免都消费）；server 与 theme.ts 的字体/对话框白名单与兜底主题同集
//   ⑦ 引擎凭据（v1.10）：服务目录 shared/providers.mjs ↔ 设置屏渲染面（不许第二份 id 表）、MCP 出图工具名
//     （media-mcp.mjs 常量 ↔ SKILL.md 的 `bunkiten-media__generate_image`）、凭据落点与环境变量名 ↔ 文档
//
// 纯 node：只读文件 + import 已导出的模块（不 spawn、不联网、不写盘），整体 <1s。
// 注意：本文件自身也被 `npm test` 收录，但**不计入**文档声明的合计口径（数字以 CASE_TOTAL 为准；tests/e2e/** 同样不在口径内），见第 ④ 组。

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIO_KINDS, PROTOCOL_HEADS, isProtocolLine, parseChapterMark, parseManifest } from "../src/lib/parser";
import { DIRECTIVE_PREFIX_RE as SHARED_DIRECTIVE_RE, PROTOCOL_HEADS as SHARED_HEADS, CHAPTER_MARK_RE as SHARED_CHAPTER_RE } from "../shared/protocol.mjs";
import { PROVIDERS, PROVIDER_IDS, providersFor } from "../shared/providers.mjs";
import { SETTINGS_STORAGE_KEY } from "../src/lib/settings";

/** 仓库根（本文件在 tests/ 下） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 读仓库内文件原文（utf8，不做任何规范化/裁剪）：契约要比的就是字面量本身 */
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** server/ 全目录源码（v1.7 拆模块后防「第二真源」的断言必须扫全目录，不能只盯入口） */
function serverSources(): { rel: string; src: string }[] {
  return readdirSync(path.join(ROOT, "server"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => ({ rel: `server/${f}`, src: read(`server/${f}`) }));
}

/** `文件:行`：失败信息里能直接指到出处（比「某个文件里找不到」有用得多） */
function at(rel: string, text: string, index: number): string {
  return `${rel}:${text.slice(0, Math.max(0, index)).split("\n").length}`;
}

/** server 模块（懒加载；模块以 invokedDirectly 守卫自启，import 不会起服务也不会 spawn 引擎） */
function loadServer(): Promise<Record<string, unknown>> {
  return import("../server/acp-server.mjs") as unknown as Promise<Record<string, unknown>>;
}

/** 递归列出 src/ 下的 .ts/.tsx 源码（相对路径） */
function srcFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// ——————————————————————— ① 协议头集合唯一真源 ———————————————————————

/** 契约真源（逐字；顺序即声明顺序）：改这里必须同步 server/parser 的解析出口、SKILL 备忘、文档表格 */
const HEADS = ["图", "清单", "章", "立绘", "新剧本", "树", "曲", "环境", "音效"];

/**
 * 每个协议头 → 解析出口 + 样例行 + 结果判定。
 * 图/立绘/新剧本/树/曲/环境/音效 在 server（acp-server.mjs），清单/章 在 parser.ts——
 * 「一个头没有任何解析出口」就是漂移（引擎发了、客户端认不出来）。
 */
const HEAD_PROBES: { head: string; from: string; name: string; sample: string; ok: (out: unknown) => boolean }[] = [
  { head: "图", from: "server/acp-server.mjs", name: "parseArtLine", sample: "【图】立绘|薇拉|images/1.jpg", ok: (o) => (o as { name?: string } | null)?.name === "薇拉" },
  { head: "清单", from: "src/lib/parser.ts", name: "parseManifest", sample: "【清单】立绘|薇拉", ok: (o) => Array.isArray(o) && o.length === 1 },
  { head: "章", from: "src/lib/parser.ts", name: "parseChapterMark", sample: "【章】第 3 章 完", ok: (o) => o === 3 },
  { head: "立绘", from: "server/acp-server.mjs", name: "parseExpressionLine", sample: "【立绘】薇拉|微笑", ok: (o) => (o as { variant?: string } | null)?.variant === "微笑" },
  { head: "新剧本", from: "server/acp-server.mjs", name: "parsePresetAddedLine", sample: "【新剧本】rift-mark", ok: (o) => (o as { id?: string } | null)?.id === "rift-mark" },
  { head: "树", from: "server/acp-server.mjs", name: "parseTreeLine", sample: "【树】", ok: (o) => o !== null && typeof o === "object" },
  { head: "曲", from: "server/acp-server.mjs", name: "parseAudioLine", sample: "【曲】雨夜", ok: (o) => (o as { kind?: string } | null)?.kind === "曲" },
  { head: "环境", from: "server/acp-server.mjs", name: "parseAudioLine", sample: "【环境】旅店大堂", ok: (o) => (o as { kind?: string } | null)?.kind === "环境" },
  { head: "音效", from: "server/acp-server.mjs", name: "parseAudioLine", sample: "【音效】门响", ok: (o) => (o as { kind?: string } | null)?.kind === "音效" },
];

/** 9 个头在文档/备忘里的逐字写法（【图】【清单】…），错误信息里直接铺出来对照 */
const headsText = (): string => HEADS.map((h) => `【${h}】`).join("");

describe("① 协议头集合唯一真源：PROTOCOL_HEADS ↔ isProtocolLine ↔ 解析出口 ↔ SKILL 备忘 ↔ 文档", () => {
  it("PROTOCOL_HEADS 逐字等于契约清单（9 项；shared 真源经 parser re-export 双侧钉住）", () => {
    expect(
      [...PROTOCOL_HEADS],
      `协议头集合不一致：src/lib/parser.ts 的 PROTOCOL_HEADS 现在是 [${[...PROTOCOL_HEADS].join("、")}]（${PROTOCOL_HEADS.length} 项），契约声明是 [${HEADS.join("、")}]（9 项）`,
    ).toEqual(HEADS);
    expect(
      [...SHARED_HEADS],
      `协议头集合不一致：shared/protocol.mjs 的 PROTOCOL_HEADS 现在是 [${[...SHARED_HEADS].join("、")}]（${SHARED_HEADS.length} 项），契约声明是 [${HEADS.join("、")}]（9 项）——真源与 parser 的 re-export 已分叉`,
    ).toEqual(HEADS);
  });

  it("isProtocolLine 的正则由 PROTOCOL_HEADS 构造（真源在 shared，没有第二份手写头表）", () => {
    const parserSrc = read("src/lib/parser.ts");
    const FROM_HEADS = '${PROTOCOL_HEADS.join("|")}';
    expect(
      parserSrc,
      `isProtocolLine 的正则不再由 PROTOCOL_HEADS 构造：src/lib/parser.ts 里找不到 ${FROM_HEADS}——现在正则与真源是两份独立的东西，头集合 [${HEADS.join("、")}] 就管不住过滤清单了`,
    ).toContain(FROM_HEADS);
    const uses = parserSrc.split(FROM_HEADS).length - 1;
    expect(uses, `PROTOCOL_HEADS 的 join 在 src/lib/parser.ts 里出现 ${uses} 次（应为 1 次）：多出来的那份就是第二真源，两边一分叉就说不清哪个才对`).toBe(1);
    // v1.7 真源搬家：parser 只许 import + re-export，不许再留数组字面量（第二真源）
    expect(
      parserSrc,
      `src/lib/parser.ts 应从 shared/protocol.mjs import PROTOCOL_HEADS（v1.7 起真源在那）：找不到对应的 import 语句`,
    ).toContain('from "../../shared/protocol.mjs"');
    expect(parserSrc, `src/lib/parser.ts 里出现了 PROTOCOL_HEADS 的数组字面量：真源已在 shared/protocol.mjs，这里再写一份就是第二真源`).not.toContain("PROTOCOL_HEADS = [");
    // 真源本体：shared 的数组字面量逐字等于契约清单（源码级钉住）
    const sharedRel = "shared/protocol.mjs";
    const sharedSrc = read(sharedRel);
    const decl = /export const PROTOCOL_HEADS = (?:Object\.freeze\()?\[([^\]]+)\]/.exec(sharedSrc);
    if (!decl) throw new Error(`${sharedRel} 里找不到 \`export const PROTOCOL_HEADS = [...]\`：协议头集合没有真源（v1.7 起从 src/lib/parser.ts 搬来），无法与文档/解析出口比对`);
    const sharedHeads = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(
      sharedHeads,
      `${sharedRel} 的 PROTOCOL_HEADS 与契约清单不一致：现在是 [${sharedHeads.join("、")}]（${sharedHeads.length} 项），契约声明是 [${HEADS.join("、")}]（谁和谁不一致：shared 真源 ↔ 契约清单）`,
    ).toEqual(HEADS);
    // 行为层再复述一遍：9 个头都认，「前缀像但头不同」的不认
    for (const head of HEADS) {
      expect(isProtocolLine(`【${head}】…`), `isProtocolLine("【${head}】…") 应为 true（【${head}】是真源里的协议头，过滤清单漏了它）`).toBe(true);
    }
    expect(isProtocolLine("【图鉴】不是协议行"), "非协议头「【图鉴】」被 isProtocolLine 认下了：正则失之过宽，会把正文误当协议行过滤掉").toBe(false);
  });

  it("9 个头各有解析出口，且能解析出样例行", async () => {
    const server = await loadServer();
    const exportsByName: Record<string, { from: string; fn: unknown }> = {
      parseArtLine: { from: "server/acp-server.mjs", fn: server.parseArtLine },
      parseExpressionLine: { from: "server/acp-server.mjs", fn: server.parseExpressionLine },
      parsePresetAddedLine: { from: "server/acp-server.mjs", fn: server.parsePresetAddedLine },
      parseTreeLine: { from: "server/acp-server.mjs", fn: server.parseTreeLine },
      parseAudioLine: { from: "server/acp-server.mjs", fn: server.parseAudioLine },
      parseManifest: { from: "src/lib/parser.ts", fn: parseManifest },
      parseChapterMark: { from: "src/lib/parser.ts", fn: parseChapterMark },
    };
    for (const probe of HEAD_PROBES) {
      const slot = exportsByName[probe.name];
      expect(
        typeof slot?.fn,
        `协议头「${probe.head}」没有解析出口：${probe.from} 没导出 ${probe.name}（现在 typeof 是 ${typeof slot?.fn}）——真源 9 头 ${headsText()} 与解析出口对不上`,
      ).toBe("function");
      const out = (slot.fn as (line: string) => unknown)(probe.sample);
      expect(
        probe.ok(out),
        `协议头「${probe.head}」的解析出口 ${probe.name} 对样例行「${probe.sample}」给出 ${JSON.stringify(out)}：认不出来（头集合与解析出口对不上）`,
      ).toBe(true);
    }
  });

  it("SKILL.md「标记格式备忘」提到全部 9 个头", () => {
    const rel = ".grok/skills/bunkiten/SKILL.md";
    const skill = read(rel);
    const anchor = skill.indexOf("标记格式备忘");
    if (anchor === -1) throw new Error(`${rel} 里找不到「标记格式备忘」小节：契约 lint 的锚点（引擎侧协议行清单）被改名或删掉了`);
    const memo = skill.slice(anchor);
    const missing = HEADS.filter((head) => !memo.includes(`【${head}】`));
    expect(
      missing,
      `${rel}「标记格式备忘」小节缺这些协议头（谁和谁不一致：SKILL 备忘 ↔ PROTOCOL_HEADS 真源）：${missing.map((h) => `【${h}】`).join("")}；真源 9 头是 ${headsText()}`,
    ).toEqual([]);
  });

  it("docs/ARCHITECTURE.md 逐字写出 PROTOCOL_HEADS 声明并提到全部 9 个头", () => {
    const rel = "docs/ARCHITECTURE.md";
    const doc = read(rel);
    const declared = `PROTOCOL_HEADS = [${HEADS.map((h) => `"${h}"`).join(", ")}]`;
    expect(
      doc,
      `${rel} 里的协议头声明与真源不一致：文档应逐字写出 ${declared}，现在找不到这段（正确写法见 src/lib/parser.ts 的 PROTOCOL_HEADS）`,
    ).toContain(declared);
    const missing = HEADS.filter((head) => !doc.includes(`【${head}】`));
    expect(missing, `${rel} 提到这些协议头（谁和谁不一致：文档 ↔ PROTOCOL_HEADS 真源）：缺 ${missing.map((h) => `【${h}】`).join("")}；真源 9 头是 ${headsText()}`).toEqual([]);
  });
});

// ——————————————————————— ② RULES 逐字副本 ———————————————————————

/** 取文档里的围栏代码块正文（``` 包起来的部分） */
function fencedBlocks(md: string): string[] {
  return [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * RULES 的 6 句真源 + 注入用的拼接串。
 * 为什么读 `RULES_SENTENCES` 而不是切 `RULES`：句子内部本身含句号（如「世界：<id>。」），
 * 从长串反推句子边界会数出 10 段——句子条数只有数组能说清。
 */
async function rulesOrThrow(): Promise<{ sentences: string[]; joined: string }> {
  const server = await loadServer();
  const sentences = server.RULES_SENTENCES;
  if (!Array.isArray(sentences) || typeof server.RULES !== "string") {
    throw new Error(
      `server/acp-server.mjs 没导出 RULES_SENTENCES/RULES（现在 typeof RULES_SENTENCES = ${typeof sentences}、typeof RULES = ${typeof server.RULES}）——docs/ARCHITECTURE.md 的「rules 原文」代码块就没有可比对的副本了`,
    );
  }
  return { sentences: sentences as string[], joined: server.RULES };
}

describe("② RULES 逐字副本：server 常量 ↔ ARCHITECTURE 的 RULES 代码块", () => {
  it("server 的 RULES 是 6 句（RULES_SENTENCES），拼接串与它逐字相等，第 6 句是音频纪律句", async () => {
    const { sentences, joined } = await rulesOrThrow();
    expect(
      sentences,
      `RULES 句数不符：server/acp-server.mjs 的 RULES_SENTENCES 现在是 ${sentences.length} 句，契约是 6 句——\n${sentences.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    ).toHaveLength(6);
    expect(joined, "注入 agent 的 RULES 不再是 RULES_SENTENCES.join(\"\")：两个视图分叉后，lint 比对的就不再是真正注入给引擎的那条串").toBe(sentences.join(""));
    expect(sentences[5], `RULES 第 6 句不是音频纪律句：现在是「${sentences[5]}」，应以「音频纪律：」开头（v1.6 音频三行全靠它约束）`).toMatch(/^音频纪律：/);
    expect(sentences[0], `RULES 第 1 句不再是【行动】文本选项句：现在是「${sentences[0]}」，应含 **行动** 字样`).toContain("**行动**");
  });

  it("docs/ARCHITECTURE.md 的 RULES 代码块逐句包含这 6 句（逐字）", async () => {
    const rel = "docs/ARCHITECTURE.md";
    const { sentences } = await rulesOrThrow();
    const doc = read(rel);
    const block = fencedBlocks(doc).find((b) => b.includes("本会话运行在自定义游戏客户端下"));
    if (!block) throw new Error(`${rel} 里找不到 RULES 代码块（应有一段以「本会话运行在自定义游戏客户端下：…」开头的围栏块）——文档与 server 的 RULES 常量已经对不上`);
    const docLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const missing = sentences.filter((s) => !docLines.includes(s));
    expect(
      missing,
      `${rel} 的 RULES 代码块缺这些句子（谁和谁不一致：文档块 ↔ server/acp-server.mjs 的 RULES_SENTENCES）：\n${missing.map((s) => `  - 「${s}」`).join("\n")}\n现在文档块 ${docLines.length} 行、常量 ${sentences.length} 句`,
    ).toEqual([]);
    expect(
      docLines,
      `${rel} 的 RULES 代码块有 ${docLines.length} 行，server 常量是 ${sentences.length} 句：多出来的行是第三份措辞（改 RULES 必须两处同批改）`,
    ).toHaveLength(sentences.length);
  });

  it("RULES 第 3 句枚举了全部 9 个协议头（新增协议行要同时进 isProtocolLine 与 RULES 枚举）", async () => {
    const { sentences } = await rulesOrThrow();
    const enumSentence = sentences[2] ?? "";
    const missing = HEADS.filter((head) => !enumSentence.includes(`【${head}】`));
    expect(
      missing,
      `RULES 第 3 句（协议行枚举）缺这些头：${missing.map((h) => `【${h}】`).join("")}——新增协议头只改 PROTOCOL_HEADS 会让引擎根本不知道自己该输出什么；真源 9 头是 ${headsText()}`,
    ).toEqual([]);
  });
});

// ——————————————————————— ③ 指令字符串双处存在 ———————————————————————

/** 必须同时活在客户端源码与引擎提示词里的指令字符串（对不上 = 玩家发出去的指令引擎不认） */
const DIRECTIVES = ["开演。", "规划：第 N 章。", "剧情：", "美术：重绘", "创作模式：进入剧本创作。", "装配。", "世界：", "继续世界："];

/**
 * 客户端源码里是否有这条指令：章号这类参数在客户端是模板插值（`规划：第 ${n} 章。`），
 * 契约/文档写的是占位符 N，所以只把 N 放宽成任意 `${…}` 插值，其余字符仍逐字比对（多一个空格就红）。
 */
function hasDirective(source: string, literal: string): boolean {
  if (source.includes(literal)) return true;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/N/g, "\\$\\{[^}]+\\}")).test(source);
}

describe("③ 指令字符串双处存在：src/lib/parser.ts 源码 ↔ SKILL.md", () => {
  it("SKILL.md 逐字含全部指令字符串", () => {
    const rel = ".grok/skills/bunkiten/SKILL.md";
    const skill = read(rel);
    const missing = DIRECTIVES.filter((s) => !skill.includes(s));
    expect(
      missing,
      `${rel} 里找不到这些指令字符串（谁和谁不一致：引擎提示词 ↔ 客户端指令契约）：\n${missing.map((s) => `  - 「${s}」`).join("\n")}`,
    ).toEqual([]);
  });

  it("src/lib/parser.ts 源码含同一批指令（参数化指令比对模板形态）", () => {
    const rel = "src/lib/parser.ts";
    const parserSrc = read(rel);
    const missing = DIRECTIVES.filter((s) => !hasDirective(parserSrc, s));
    expect(
      missing,
      `${rel} 源码里找不到这些指令字符串（谁和谁不一致：客户端构造 ↔ SKILL.md 的指令契约；参数化指令放行 \${…} 插值形态）：\n${missing.map((s) => `  - 「${s}」`).join("\n")}`,
    ).toEqual([]);
  });
});

// ——————————————————————— ⑦ 引擎凭据（v1.10，ADR-0019） ———————————————————————

/** 设置屏里渲染服务目录的那个组件（GUI 的渲染面就是它；契约 lint 从它的源码抓「是否吃真源」） */
const GUI_PROVIDERS_FILE = "src/components/EngineKeysSection.tsx";

/** 引擎凭据的文档面（凭据落点、环境变量名、MCP 工具名的说明都在 ARCHITECTURE 的新节里） */
const CREDENTIALS_DOC = "docs/ARCHITECTURE.md";

/** 凭据落点（server/credentials.mjs 的两个常量；lint 断言文档逐字写出，玩家问「key 存哪」有文档答案） */
const CREDENTIALS_DIRNAME = ".bunkiten";
const CREDENTIALS_FILENAME = "credentials.json";

/**
 * LLM BYOK 注入引擎子进程的环境变量名（grok CLI 的文档口径：11-custom-models.md 的「Custom Models Endpoint」段；
 * GROK_CONFIG 见 05-configuration.md 的「Injecting config with GROK_CONFIG」）。
 * 名字写错 = 引擎收不到自备 key 却又不报错（CLI 会静默沿用登录态），所以这里与文档双向钉死。
 */
const ENV_NAMES = ["GROK_MODELS_BASE_URL", "XAI_API_KEY", "GROK_DEFAULT_MODEL", "GROK_CONFIG"];

describe("⑦ 引擎凭据：服务目录 ↔ 设置屏 / MCP 工具名 ↔ SKILL / 凭据落点 ↔ 文档", () => {
  it("服务目录表结构完整：id 唯一、kind 合法、地址合法或留空带 note、两种用途都有可选项", () => {
    const ids = [...PROVIDER_IDS];
    expect(new Set(ids).size, `shared/providers.mjs 的 id 有重复：${ids.join("、")}`).toBe(ids.length);
    for (const p of PROVIDERS) {
      expect(p.id, `目录条目 id 不合规：${p.id}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(typeof p.label === "string" && p.label.length > 0, `目录条目 ${p.id} 缺 label`).toBe(true);
      expect(["llm", "image", "both"], `目录条目 ${p.id} 的 kind 非法：${p.kind}`).toContain(p.kind);
      if (p.baseUrl === "") {
        expect(Boolean(p.note), `目录条目 ${p.id} 地址留空却没写 note（玩家不知道该填什么形态）`).toBe(true);
      } else {
        expect(() => new URL(p.baseUrl), `目录条目 ${p.id} 的 baseUrl 不是合法 URL：${p.baseUrl}`).not.toThrow();
      }
    }
    expect(providersFor("llm").length, "对话侧没有任何可选服务").toBeGreaterThan(5);
    expect(providersFor("image").length, "出图侧没有任何可选服务").toBeGreaterThan(2);
  });

  it("服务目录是唯一真源：PROVIDER_IDS 由 PROVIDERS 派生，GUI 吃真源而不是自带第二份 id 表", () => {
    const rel = "shared/providers.mjs";
    const src = read(rel);
    expect(
      src,
      `${rel} 的 PROVIDER_IDS 不再由 PROVIDERS 派生：GUI 下拉与服务端校验会分成两份清单（谁先加一个服务，另一边就漏一个）`,
    ).toMatch(/export const PROVIDER_IDS = Object\.freeze\(PROVIDERS\.map\(/);
    const gui = read(GUI_PROVIDERS_FILE);
    expect(
      gui,
      `${GUI_PROVIDERS_FILE} 没有从 ${rel} import 服务目录：下拉会退化成另一份手写清单`,
    ).toContain('from "../../shared/providers.mjs"');
    expect(gui, `${GUI_PROVIDERS_FILE} 没有消费 providersFor（目录过滤在真源里，GUI 只渲染）`).toContain("providersFor(");
    expect(src, `${rel} 应导出 providersFor（GUI 与测试都消费它）`).toContain("export function providersFor(");
    // 第二份 id 表的防漂移：目录 id 不许在 src/ 下以字符串字面量出现（`"deepseek"` 这种）
    const quotedIds = [`"deepseek"`, `"dashscope"`, `"siliconflow"`, `"volcengine"`, `"moonshot"`, `"zhipu"`, `"openrouter"`, `"lmstudio"`];
    const offenders = srcFiles().filter((file) => {
      const text = read(file);
      return quotedIds.some((q) => text.includes(q));
    });
    expect(
      offenders,
      `src/ 下出现了服务目录 id 的字符串字面量（谁和谁不一致：${rel} 的真源 ↔ 客户端 GUI）：${offenders.join("、")}——` +
        `下拉的选项必须来自真源，别处手写一份就等着漂移`,
    ).toEqual([]);
  });

  it("设置屏的两组模式字面与 server 的 LLM_MODES/IMAGE_MODES 对得上（byok/session/off 三词不许各写各的）", () => {
    const gui = read(GUI_PROVIDERS_FILE);
    const creds = read("server/credentials.mjs");
    expect(creds, "server/credentials.mjs 里 LLM_MODES 不再是 [session, byok]").toMatch(/export const LLM_MODES = Object\.freeze\(\["session", "byok"\]\)/);
    expect(creds, "server/credentials.mjs 里 IMAGE_MODES 不再是 [off, byok]").toMatch(/export const IMAGE_MODES = Object\.freeze\(\["off", "byok"\]\)/);
    for (const mode of ['"session"', '"byok"', '"off"']) {
      expect(gui, `${GUI_PROVIDERS_FILE} 里没有模式字面量 ${mode}（设置屏的模式开关必须与服务端同一套词）`).toContain(mode);
    }
  });

  it("MCP 出图工具名：media-mcp.mjs 的两个常量拼出 SKILL.md 里写的那把 catalog 键", async () => {
    const serverMod = await loadServer();
    const name = String(serverMod.MEDIA_MCP_NAME);
    const tool = String(serverMod.MEDIA_TOOL_NAME);
    expect(name, `server/media-mcp.mjs 的 MEDIA_MCP_NAME 变了：${name}（改名要同批改 SKILL 与本文档节）`).toBe("bunkiten-media");
    expect(tool, `server/media-mcp.mjs 的 MEDIA_TOOL_NAME 变了：${tool}`).toBe("generate_image");
    const qualified = `${name}__${tool}`;
    const skill = read(".grok/skills/bunkiten/SKILL.md");
    expect(
      skill,
      `SKILL.md 里找不到出图工具的 catalog 键「${qualified}」：引擎要靠 search_tool 找它（改 server/media-mcp.mjs 的名字时同批改 SKILL 的「出图工具优先」句）`,
    ).toContain(qualified);
    // 工具定义本身也用常量（不是手写第二份字面量）
    const src = read("server/media-mcp.mjs");
    expect(src, "server/media-mcp.mjs 的 TOOL_DEFINITION 没有引用 MEDIA_TOOL_NAME：工具名有了第二份字面量").toContain("name: MEDIA_TOOL_NAME");
  });

  it("凭据落点与环境变量名：server 常量 ↔ 文档逐字一致（key 存哪、怎么注入引擎）", () => {
    const rel = "server/credentials.mjs";
    const src = read(rel);
    expect(src, `${rel} 的 CREDENTIALS_DIRNAME 变了：${CREDENTIALS_DIRNAME}`).toContain(`export const CREDENTIALS_DIRNAME = "${CREDENTIALS_DIRNAME}"`);
    expect(src, `${rel} 的 CREDENTIALS_FILENAME 变了：${CREDENTIALS_FILENAME}`).toContain(`export const CREDENTIALS_FILENAME = "${CREDENTIALS_FILENAME}"`);
    const doc = read(CREDENTIALS_DOC);
    expect(
      doc,
      `${CREDENTIALS_DOC} 里没有逐字写出凭据落点「${CREDENTIALS_DIRNAME}/${CREDENTIALS_FILENAME}」：玩家问「key 存哪」时文档答不上来`,
    ).toContain(`${CREDENTIALS_DIRNAME}/${CREDENTIALS_FILENAME}`);
    for (const env of ENV_NAMES) {
      expect(src, `${rel} 里没有生成环境变量 ${env}（LLM BYOK 的注入面）`).toContain(env);
      expect(doc, `${CREDENTIALS_DOC} 的「引擎凭据与自备 key」一节没有写 ${env}：引擎侧注入面没有文档锚点`).toContain(env);
    }
    expect(doc, `${CREDENTIALS_DOC} 里没有两条出图途径的说明（MCP 工具与内置 image_gen 的优先级）`).toContain("bunkiten-media__generate_image");
  });

  it("发布源 docs/providers.json 与 shared/providers.mjs 的 PROVIDERS 深等（v1.11，ADR-0020；由 npm run providers:export 生成）", () => {
    const rel = "docs/providers.json";
    const doc = JSON.parse(read(rel)) as { version?: unknown; updatedAt?: unknown; providers?: unknown };
    expect(doc.version, `${rel} 的 version 变了：${String(doc.version)}（服务端只认 version 1，见 server/providers-catalog.mjs 的 CATALOG_VERSION）`).toBe(1);
    expect(
      doc.providers,
      `${rel} 的 providers 与 shared/providers.mjs 的 PROVIDERS 不一致（谁和谁不一致：发布源 ↔ 目录真源）——别手改 JSON，跑 \`npm run providers:export\` 重新生成`,
    ).toEqual(JSON.parse(JSON.stringify(PROVIDERS)));
    expect(typeof doc.updatedAt, `${rel} 缺 updatedAt（发布时刻）：跑 \`npm run providers:export\` 会补上`).toBe("string");
  });
});

// ——————————————————————— ④ 用例数 ———————————————————————

/**
 * 用例数口径是**下限语义**（v1.9 减税后）：数字说的是「不少于」，不是精确值。
 *
 * 为什么改：精确相等时加一个用例要同步四处——本文件、README、AGENTS、ARCHITECTURE 里每一处分组数字。
 * 现在唯一维护点就是这个数组：文档只留一句粗口径（`单测 + 集成全量 N 例`，那个 N 同样是下限声明）。
 * 代价是文档里的数字停在抬升那天；收益是「加用例」这个每天都在发生的动作不再有文档税。
 *
 * 三档规则：
 *   · 加用例 —— 什么都不用改（实际 ≥ 下限自然成立）；
 *   · 删用例 —— 这里会红（防静默砍测试；确实要删就先在本文件压低对应 floor，一处）；
 *   · 抬高口径 —— 可选，只改这里的 floor 与 CASE_TOTAL（不抬高不会红）。
 */
const CASE_GROUPS = [
  { name: "parser", files: ["tests/parser.test.ts"], floor: 65 },
  { name: "server", files: ["tests/server.test.ts"], floor: 118 },
  { name: "crafting", files: ["tests/crafting.test.ts"], floor: 56 },
  { name: "treeLayout", files: ["tests/treeLayout.test.ts"], floor: 7 },
  { name: "genealogy", files: ["tests/genealogy.test.ts"], floor: 8 },
  { name: "diff", files: ["tests/diff.test.ts"], floor: 8 },
  { name: "doctor", files: ["tests/doctor.test.ts"], floor: 12 },
  { name: "preload", files: ["tests/preload.test.ts"], floor: 8 },
  { name: "credentials", files: ["tests/credentials.test.ts"], floor: 30 },
  { name: "ui", files: ["tests/ui.test.tsx"], floor: 145 },
  {
    name: "integration",
    files: ["tests/integration/pipeline.test.ts", "tests/integration/audio-history.test.ts", "tests/integration/http-guard.test.ts"],
    floor: 29,
  },
  { name: "credentials-integration", files: ["tests/integration/credentials.test.ts"], floor: 18 },
  // 服务目录更新通道（v1.11，ADR-0020）：纯函数层 + 集成层两个文件。
  // 各分组 floor 之和的上限被三份文档的粗口径声明（`共/全量 502+ 例`）钉住，而文档同步是另一波次——
  // 所以这里把两个文件并成一组、floor 取到不越上限的最大值（删文件或删到空仍会红）。
  { name: "providers-catalog", files: ["tests/providers-catalog.test.ts", "tests/integration/providers-catalog.test.ts"], floor: 2 },
];

/** integration 的子分组下限（文档不再单独声明；留着是为了「砍的是哪个文件」能直接指出来） */
const CASE_SUB_GROUPS = [
  { name: "pipeline", file: "tests/integration/pipeline.test.ts", floor: 15 },
  { name: "audio-history", file: "tests/integration/audio-history.test.ts", floor: 11 },
  { name: "http-guard", file: "tests/integration/http-guard.test.ts", floor: 3 },
];

/** 契约 lint 自己（也被 npm test 收录，但不计入下限口径：它断言的就是这些数字，自指会让门禁自我循环） */
const CONTRACT_FILE = "tests/contract.test.ts";

/** 单测 + 集成的合计下限（抬高它要同批抬齐分组 floor——自洽断言会拦） */
const CASE_TOTAL = 506;

/** 三份带粗口径下限声明的文档 */
const DOCS = ["README.md", "AGENTS.md", "docs/ARCHITECTURE.md"];

/**
 * 一个文件里的用例数：用例声明函数（vitest 的两种写法）的出现次数——与 vitest 的收集口径同源，做防漂移够用。
 * 正则用 `\b` 卡词边界：`sendTreeEdit(` 这类调用不会误命中，本文件自己的计数正则（带反斜杠）也不会自匹配；
 * 但注释/字符串里写出同样的字样照样会数进来——所以别在注释里写用例字面量。
 */
function countCases(rel: string): number {
  return (read(rel).match(/\b(it|test)\(/g) ?? []).length;
}

/**
 * 文档侧的粗口径下限声明（README「单测 + 集成全量 447 例」、AGENTS「**共 447 例**」；
 * `447+` 的加号形态照认）：每份文档各需一句。数字是**下限声明**——不高于实际（不许吹）、
 * 不低于 CASE_TOTAL（不许小到失去意义）；加用例时它自然停在旧值，不必同批改。
 */
const DOC_TOTAL_RE = /(?:共|全量)\s*\*{0,2}(\d+)\+?\*{0,2}\s*例/g;

/**
 * 文档里**不该再出现**的逐分组数字（撤掉的税不要长回来）：命中即红并报行号——
 * 加号列 `parser 65 + server 118`、目录树注 `ui.test.tsx … 136 例`、散句「集成测试 29 例」、
 * 子分组 ``  `pipeline` 15 `` 都算。三组模式各自独立，报错时列出全部命中。
 */
const DOC_GROUP_RES: RegExp[] = [
  // 分组名（可跟 `.test.ts`/目录注）→ 数字 → 近处出现「例」或加号列（`server 600s` 这类不含例/加号的不算）
  /\b(parser|crafting|server|treeLayout|genealogy|diff|doctor|preload|ui|integration)\b[\s`|.]{0,6}(?:[a-z-]+\.test\.tsx?[^\n]{0,40}?)?\d+[^\n]{0,24}?(?:例|\+)/g,
  /集成测试\s*\d+/g,
  /(pipeline|audio-history|http-guard)`?\s+\d+[^\n]{0,24}?(?:例|\+)/g,
];

describe("④ 用例数下限：CASE_GROUPS 的 floor ↔ 各文件实际用例数（唯一维护点）", () => {
  it("十个分组的实际用例数都不低于下限（加用例不用改这里；删用例先压低 floor）", () => {
    for (const group of CASE_GROUPS) {
      const actual = group.files.reduce((n, file) => n + countCases(file), 0);
      expect(
        actual,
        `「${group.name}」用例数跌破下限：${group.files.join(" + ")} 现在实际 ${actual} 例、下限 ${group.floor} 例（少了 ${group.floor - actual} 例）——若不是有意删除，先看是不是误删了用例；确实要删就在本文件把这个分组的 floor 压低`,
      ).toBeGreaterThanOrEqual(group.floor);
    }
  });

  it("integration 三个子分组不低于各自下限，且下限自洽（子项之和 ≤ 分组 ≤ 合计）", () => {
    for (const sub of CASE_SUB_GROUPS) {
      const actual = countCases(sub.file);
      expect(actual, `integration 子分组「${sub.name}」跌破下限：${sub.file} 现在实际 ${actual} 例、下限 ${sub.floor} 例`).toBeGreaterThanOrEqual(sub.floor);
    }
    const subSum = CASE_SUB_GROUPS.reduce((n, s) => n + s.floor, 0);
    const integration = CASE_GROUPS.find((g) => g.name === "integration");
    expect(
      subSum,
      `integration 的分组下限自相矛盾：三个子文件下限相加 ${subSum} 例，分组下限写的是 ${integration?.floor} 例（子项之和不能超过分组下限）`,
    ).toBeLessThanOrEqual(integration?.floor ?? 0);
    const floorSum = CASE_GROUPS.reduce((n, g) => n + g.floor, 0);
    expect(
      floorSum,
      `合计下限自相矛盾：十个分组 floor 相加 ${floorSum} 例，CASE_TOTAL 写的是 ${CASE_TOTAL} 例（CASE_TOTAL 不得低于分组下限之和）`,
    ).toBeLessThanOrEqual(CASE_TOTAL);
  });

  it("实际合计不低于 CASE_TOTAL，且本文件不计入其中", () => {
    const actual = CASE_GROUPS.reduce((n, g) => n + g.files.reduce((m, file) => m + countCases(file), 0), 0);
    expect(
      actual,
      `单测 + 集成实际合计 ${actual} 例，跌破 CASE_TOTAL 下限 ${CASE_TOTAL} 例——整批用例被砍会先在这里红（有意削减就先在本文件压低分组 floor 与 CASE_TOTAL）`,
    ).toBeGreaterThanOrEqual(CASE_TOTAL);
    const self = countCases(CONTRACT_FILE);
    expect(self, `本文件 ${CONTRACT_FILE} 一个用例都没数到（${self} 例）：契约 lint 空跑等于没有门禁`).toBeGreaterThan(0);
    for (const group of CASE_GROUPS) {
      expect(
        group.files,
        `下限口径里混进了本文件（${CONTRACT_FILE}，现在数到 ${self} 个用例）：它自己也被 npm test 收录，算进合计会让门禁自我循环（改断言就要改数字）`,
      ).not.toContain(CONTRACT_FILE);
    }
  });

  it("三份文档各有一句粗口径下限声明（`共/全量 N 例`）：不吹、不低于 CASE_TOTAL", () => {
    const actual = CASE_GROUPS.reduce((n, g) => n + g.files.reduce((m, file) => m + countCases(file), 0), 0);
    for (const doc of DOCS) {
      const text = read(doc);
      const hits = [...text.matchAll(DOC_TOTAL_RE)];
      expect(
        hits.length,
        `${doc} 里找不到「共 N 例」/「全量 N 例」形态的粗口径声明（每份文档各需一句；数字口径的唯一维护点是 ${CONTRACT_FILE} 的 CASE_GROUPS）：现在数到 ${hits.length} 处——文档可以说得比实际旧，但不能一句都不说`,
      ).toBeGreaterThan(0);
      for (const m of hits) {
        const declared = Number(m[1]);
        expect(
          declared,
          `${at(doc, text, m.index)} 的合计声明是 ${declared} 例，低于 CASE_TOTAL 下限 ${CASE_TOTAL} 例（谁和谁不一致：文档粗口径 ↔ ${CONTRACT_FILE} 的 CASE_TOTAL）`,
        ).toBeGreaterThanOrEqual(CASE_TOTAL);
        expect(
          declared,
          `${at(doc, text, m.index)} 声称合计 ${declared} 例，实际只有 ${actual} 例——下限语义允许文档停在旧数字，但不许吹（谁和谁不一致：文档粗口径 ↔ 实际用例数）`,
        ).toBeLessThanOrEqual(actual);
      }
    }
  });

  it("三份文档不再逐分组钉数字（撤掉的税不要长回来；要查数字看 CASE_GROUPS）", () => {
    for (const doc of DOCS) {
      const text = read(doc);
      const offenders = DOC_GROUP_RES.flatMap((re) => [...text.matchAll(re)].map((m) => `${at(doc, text, m.index)}「${m[0].replace(/\s+/g, " ").trim()}」`));
      expect(
        offenders,
        `${doc} 里又出现了逐分组的用例数字（谁和谁不一致：文档 ↔ ${CONTRACT_FILE} 的 CASE_GROUPS）：\n${offenders.map((o) => `  - ${o}`).join("\n")}\n分组数字的唯一维护点是 ${CONTRACT_FILE}，文档只留一句「单测 + 集成全量 N 例」的粗口径`,
      ).toEqual([]);
    }
  });
});

// ——————————————————————— ⑤ 设置键与协议类型集合（音频/美术） ———————————————————————

/** 契约集合（逐字）：设置键与音频扩展名 */
const SETTINGS_KEY = "bunkiten.settings.v1";
const EXTS = ["mp3", "ogg", "m4a", "wav", "flac"];

/** 一行里出现的音频扩展名（整词匹配，别把 wave/mp3player 之类算进来） */
function extTokens(line: string): string[] {
  return [...new Set([...line.matchAll(/\b(mp3|ogg|m4a|wav|flac)\b/g)].map((m) => m[1]))].sort();
}

describe("⑤ 设置键与协议类型集合（音频/美术）：settings.ts / shared 真源 / 文档一致", () => {
  it("设置键 bunkiten.settings.v1 在 settings.ts 与文档里一致", () => {
    expect(SETTINGS_STORAGE_KEY, `src/lib/settings.ts 的 SETTINGS_STORAGE_KEY 是「${SETTINGS_STORAGE_KEY}」，契约键是「${SETTINGS_KEY}」`).toBe(SETTINGS_KEY);
    for (const doc of ["docs/ARCHITECTURE.md", "README.md"]) {
      expect(read(doc), `${doc} 里没有设置键「${SETTINGS_KEY}」（src/lib/settings.ts 用的就是它：${SETTINGS_STORAGE_KEY}）`).toContain(SETTINGS_KEY);
    }
  });

  it("音频扩展名：shared 的 AUDIO_EXTS / AUDIO_MIME / 直服白名单同集，且文档逐字写全", () => {
    const rel = "shared/protocol.mjs";
    const shared = read(rel);
    // 真源一：扩展名数组
    const decl = /const AUDIO_EXTS = (?:Object\.freeze\()?\[([^\]]+)\]/.exec(shared);
    if (!decl) throw new Error(`${rel} 里找不到 \`const AUDIO_EXTS = [...]\`：音频扩展名没有真源（v1.7 起从 server/acp-server.mjs 搬来），无法与文档/客户端比对`);
    const sharedExts = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(sharedExts, `${rel} 的 AUDIO_EXTS 与契约集合不一致：现在是 [${sharedExts.join(", ")}]，契约是 [${EXTS.join(", ")}]`).toEqual(EXTS);
    // 真源二：MIME 表的键必须与扩展名同集（漏一个 = 直服时回落到 octet-stream）
    const mimeDecl = /const AUDIO_MIME = \{([^}]+)\}/.exec(shared);
    if (!mimeDecl) throw new Error(`${rel} 里找不到 \`const AUDIO_MIME = {...}\`：直服的 MIME 表没了`);
    const mimeKeys = [...mimeDecl[1].matchAll(/([a-z0-9]+)\s*:/g)].map((m) => m[1]).sort();
    expect(mimeKeys, `${rel} 的 AUDIO_MIME 键与 AUDIO_EXTS 不同集：MIME 表 [${mimeKeys.join(", ")}]、扩展名 [${sharedExts.join(", ")}]`).toEqual([...sharedExts].sort());
    // 白名单/文件名正则都由真源构造（不是手写第二份）
    expect(shared, `${rel} 的 AUDIO_REL_RE 不再由 AUDIO_EXTS 构造：直服白名单会与扩展名真源脱钩`).toMatch(/const AUDIO_REL_RE = new RegExp\(`[^`]*\$\{AUDIO_EXTS\.join\("\|"\)\}/);
    const fileRe = /const AUDIO_FILE_RE = new RegExp\(`[^`]*`\)/.exec(shared)?.[0] ?? "";
    expect(fileRe, `${rel} 的 AUDIO_FILE_RE 不再由 AUDIO_KINDS 构造：现在是「${fileRe}」`).toContain('${AUDIO_KINDS.join("|")}');
    expect(fileRe, `${rel} 的 AUDIO_FILE_RE 不再由 AUDIO_EXTS 构造：现在是「${fileRe}」`).toContain('${AUDIO_EXTS.join("|")}');
    // server 消费真源：音频常量/正则的消费方是 server/audio.mjs（入口只从它 re-export 给 doctor/tests）。
    // 断言钉在 audio.mjs 的那条 import 上——入口 v1.7 起自己也 import shared（DIRECTIVE_PREFIX_RE/CHAPTER_MARK_RE），
    // 只对入口源码 toContain('from "../shared/protocol.mjs"') 会被那两条 import 满足，音频这条实际空转。
    const audioRel = "server/audio.mjs";
    expect(read(audioRel), `${audioRel} 应从 shared/protocol.mjs import 音频真源（AUDIO_KINDS/EXTS/FILE_RE）：找不到对应的 import 语句`).toMatch(/import \{[^}]*\bAUDIO_(?:FILE_RE|KINDS|EXTS)\b[^}]*\} from "\.\.\/shared\/protocol\.mjs"/);
    // 不得再自持第二份扩展名/MIME 声明——v1.7 拆模块后 server/ 有 10 个文件，防第二真源的扫描必须覆盖全目录而不只入口
    for (const file of serverSources()) {
      expect(file.src, `${file.rel} 里出现了第二份 AUDIO_EXTS 声明：真源已在 ${rel}`).not.toMatch(/const AUDIO_EXTS = \[/);
      expect(file.src, `${file.rel} 里出现了第二份 AUDIO_MIME 声明：真源已在 ${rel}`).not.toMatch(/const AUDIO_MIME = \{/);
    }
    // 文档：每份文档都要有一行把同一集合逐字写全（README/ARCHITECTURE 各有一处）
    const want = [...EXTS].sort().join("/");
    for (const doc of ["docs/ARCHITECTURE.md", "README.md"]) {
      const hits = read(doc)
        .split("\n")
        .map((line, i) => ({ line: i + 1, tokens: extTokens(line) }))
        .filter((hit) => hit.tokens.length >= 3);
      expect(
        hits.map((hit) => hit.tokens.join("/")),
        `${doc} 里没有一行写全音频扩展名集合：契约是 [${EXTS.join(", ")}]（比对时按字典序，无关书写顺序），现在含 ≥3 个扩展名的行是 ${hits.map((hit) => `${hit.line}: [${hit.tokens.join("/")}]`).join(" ")}`,
      ).toContain(want);
    }
    // 客户端刻意不设第二份白名单（只认 /api/audio 索引给的 url）：src/** 任何一行列出 ≥3 个扩展名都是新真源
    const offenders = srcFiles().flatMap((file) =>
      read(file)
        .split("\n")
        .map((line, i) => ({ file, line: i + 1, tokens: extTokens(line) }))
        .filter((hit) => hit.tokens.length >= 3)
        .map((hit) => `${hit.file}:${hit.line} [${hit.tokens.join("/")}]`),
    );
    expect(
      offenders,
      `客户端不该自己维护音频扩展名白名单（shared/protocol.mjs 的 AUDIO_EXTS 是唯一真源，客户端只认 /api/audio 索引里的 url，缺失即静默）：现在这些行列了 ≥3 个扩展名 —— ${offenders.join("、")}`,
    ).toEqual([]);
  });

  it("音频类型集合（曲/环境/音效）shared 与 parser 同序同字面", () => {
    const rel = "shared/protocol.mjs";
    const decl = /const AUDIO_KINDS = (?:Object\.freeze\()?\[([^\]]+)\]/.exec(read(rel));
    if (!decl) throw new Error(`${rel} 里找不到 \`const AUDIO_KINDS = [...]\`：音频类型字面没有真源（v1.7 起从 server/acp-server.mjs 搬来）`);
    const sharedKinds = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(sharedKinds, `${rel} 的 AUDIO_KINDS 与 src/lib/parser.ts 的 AUDIO_KINDS 不一致：shared [${sharedKinds.join("、")}]、parser [${[...AUDIO_KINDS].join("、")}]（parser 应 re-export 真源，分叉即第二真源）`).toEqual([...AUDIO_KINDS]);
  });

  it("美术类型集合（立绘/背景/封面）与资产文件名正则：shared 真源、双侧构造、无第二份字面", async () => {
    const rel = "shared/protocol.mjs";
    const src = read(rel);
    const kinds = /const ART_KINDS = Object\.freeze\(\[([^\]]+)\]\)/.exec(src) ?? /const ART_KINDS = \[([^\]]+)\]/.exec(src);
    if (!kinds) throw new Error(`${rel} 里找不到 \`const ART_KINDS = [...]\`：美术类型字面没有真源（v1.7 收尾收编）`);
    expect(
      [...kinds[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
      `${rel} 的 ART_KINDS 不是 [立绘、背景、封面]：parser.ts 的 ArtKind 字面联合与 server 的 parseArtLine 都以它为真源`,
    ).toEqual(["立绘", "背景", "封面"]);
    expect(src, `${rel} 的 ASSET_FILE_RE 不再由 ASSET_KINDS 构造：落盘/直服白名单会与类型真源脱钩`).toMatch(/const ASSET_FILE_RE = new RegExp\(`[^`]*\$\{ASSET_KINDS\.join\("\|"\)\}/);
    // 双侧构造（源码级）：parser.ts 的 ART_LINE_BODY/制作清单正则、protocol-lines.mjs 的 parseArtLine
    for (const [file, marker] of [
      ["src/lib/parser.ts", "ART_KINDS.join"],
      ["src/lib/parser.ts", "ASSET_KINDS.join"],
      ["server/protocol-lines.mjs", "ART_KINDS.join"],
    ]) {
      expect(read(file), `${file} 没有用 ${marker} 从 shared 真源构造类型交替组：手写字面会与真源分叉`).toContain(marker);
    }
    // 无第二份手写字面：server/ 与 scripts/ 里不许再出现「立绘|背景」/「背景|立绘」形态的类型交替组
    //（注释也不行——注释里写死就还是会被人抄；两种顺序都查，防换个写法绕过）
    const offenders = [...serverSources(), { rel: "scripts/doctor.mjs", src: read("scripts/doctor.mjs") }]
      .filter((f) => /立绘\|背景|背景\|立绘/.test(f.src))
      .map((f) => f.rel);
    expect(offenders, `这些文件手写了 立绘|背景 形态的类型交替组：类型真源在 ${rel} 的 ART_KINDS/ASSET_KINDS，落盘白名单走 ASSET_FILE_RE`).toEqual([]);
    // RULES 第 3 句（发给引擎的提示词）与真源同集：改 ART_KINDS 忘了同步那句就是静默漂移
    const { RULES_SENTENCES } = await loadServer();
    const rules = (RULES_SENTENCES as string[]).join("");
    for (const kind of ["立绘", "背景", "封面"]) {
      expect(rules, `RULES 的【图】句没有枚举美术类型「${kind}」：改 ${rel} 的 ART_KINDS 要同步 RULES 第 3 句（以及 SKILL.md【美术】）`).toContain(kind);
    }
  });
});

// ——————————————————————— ⑥ 指令前缀与主题白名单（v1.7） ———————————————————————

describe("⑥ 指令前缀、章标记与主题白名单：shared 真源 ↔ server 消费点；server ↔ theme.ts 同集", () => {
  it("DIRECTIVE_PREFIX_RE 单一真源：pickEffort 与 isMainTurn 都消费它，server 源码无第二份前缀字面", () => {
    const sharedRel = "shared/protocol.mjs";
    const sharedSrc = read(sharedRel);
    expect(
      sharedSrc,
      `${sharedRel} 里找不到 DIRECTIVE_PREFIX_RE 的正则字面：指令前缀（推理分档 pickEffort 与正戏回合判定 isMainTurn 共用）没有真源`,
    ).toContain("export const DIRECTIVE_PREFIX_RE = /^(规划：|美术：|剧情：|装配。|创作模式：)/");
    // 行为层：5 个前缀命中；开局/续玩/自由输入不命中（前缀集若被扩进来，档位与快照语义就变了）
    for (const hit of ["规划：第 1 章。", "美术：立绘 薇拉", "剧情：把这段改冷一点。", "装配。", "创作模式：进入剧本创作。"]) {
      expect(SHARED_DIRECTIVE_RE.test(hit), `DIRECTIVE_PREFIX_RE 应命中「${hit}」：分档/快照判定漏了这个前缀`).toBe(true);
    }
    for (const miss of ["推开门看看。", "开局：《雨巷》。", "继续世界：w1。"]) {
      expect(SHARED_DIRECTIVE_RE.test(miss), `DIRECTIVE_PREFIX_RE 不该命中「${miss}」：开局/续玩是正戏回合（「待命：」才是非正戏的后缀判定），前缀集合失之过宽`).toBe(false);
    }
    // server：两个消费点都在函数体内引用真源
    const serverRel = "server/acp-server.mjs";
    const serverSrc = read(serverRel);
    const pickBody = /export function pickEffort\([\s\S]*?\n\}/.exec(serverSrc)?.[0] ?? "";
    expect(
      pickBody,
      `${serverRel} 的 pickEffort 函数体没有引用 DIRECTIVE_PREFIX_RE：推理分档脱离了真源（现在函数体是「${pickBody.trim().split("\n").join(" ")}」）`,
    ).toContain("DIRECTIVE_PREFIX_RE");
    const mainBody = /function isMainTurn\([\s\S]*?\n {2}\}/.exec(serverSrc)?.[0] ?? "";
    expect(
      mainBody,
      `${serverRel} 的 isMainTurn 函数体没有引用 DIRECTIVE_PREFIX_RE：正戏回合判定脱离了真源（现在函数体是「${mainBody.trim().split("\n").join(" ")}」）`,
    ).toContain("DIRECTIVE_PREFIX_RE");
    const literal = "规划：|美术：";
    for (const file of serverSources()) {
      const copies = file.src.split(literal).length - 1;
      expect(
        copies,
        `${file.rel} 里前缀字面「${literal}」出现 ${copies} 次（应为 0 次）：第二份手写正则回来了，pickEffort 与 isMainTurn 两处分叉就说不清哪个才对`,
      ).toBe(0);
    }
  });

  it("CHAPTER_MARK_RE 单一真源：parseChapterMark 消费它，server 质量守卫豁免也消费它，且无第二份章标记正则字面", () => {
    const sharedRel = "shared/protocol.mjs";
    const sharedSrc = read(sharedRel);
    expect(
      sharedSrc,
      `${sharedRel} 里找不到 CHAPTER_MARK_RE 的正则字面：章标记行（【章】第 N 章 完）没有真源，parseChapterMark 与质量守卫豁免就管不住同一行`,
    ).toContain("export const CHAPTER_MARK_RE = /^【章】第 (\\d+) 章 完\\s*$/m");
    // 行为层：照 parser 现有语义——「【章】第 3 章 完」命中（含混在多行回合文本中的形态）、「【章】」单独不命中
    expect(SHARED_CHAPTER_RE.test("【章】第 3 章 完"), `CHAPTER_MARK_RE 应命中「【章】第 3 章 完」：章末回合豁免漏了正常形态就会误追问`).toBe(true);
    expect(SHARED_CHAPTER_RE.test("（终章正文）\n\n【章】第 3 章 完\n"), "CHAPTER_MARK_RE 应命中回合文本中间的章标记行（m 多行锚定）").toBe(true);
    expect(SHARED_CHAPTER_RE.test("【章】"), "CHAPTER_MARK_RE 不该命中单独的「【章】」：残缺行不是章末回合，失之过宽会把豁免当挡箭牌").toBe(false);
    expect(parseChapterMark("【章】第 3 章 完"), "parseChapterMark 对样例章标记应给章号 3（消费真源后公共 API 语义不变）").toBe(3);
    // parser：函数体引用真源（match 消费），import 语句存在；源码不再有第二份章标记正则字面
    const parserRel = "src/lib/parser.ts";
    const parserSrc = read(parserRel);
    const chapterBody = /export function parseChapterMark\([\s\S]*?\n\}/.exec(parserSrc)?.[0] ?? "";
    expect(
      chapterBody,
      `${parserRel} 的 parseChapterMark 函数体没有引用 CHAPTER_MARK_RE：章号解析脱离了真源（现在函数体是「${chapterBody.trim().split("\n").join(" ")}」）`,
    ).toContain("CHAPTER_MARK_RE");
    expect(parserSrc, `${parserRel} 应从 shared/protocol.mjs import CHAPTER_MARK_RE（v1.7 起真源在那）：找不到对应的 import 语句`).toMatch(/import \{[^}]*CHAPTER_MARK_RE[^}]*\} from "\.\.\/\.\.\/shared\/protocol\.mjs"/);
    const chapterLiteral = "【章】第 (\\d+)";
    for (const file of [{ rel: parserRel, src: parserSrc }, ...serverSources()]) {
      const copies = file.src.split(chapterLiteral).length - 1;
      expect(
        copies,
        `${file.rel} 里章标记正则字面「${chapterLiteral}」出现 ${copies} 次（应为 0 次）：真源已在 ${sharedRel}，第二份手写正则与 parseChapterMark/守卫豁免分叉就说不清哪个才对`,
      ).toBe(0);
    }
    // server：质量守卫（supplementMissingOptions）的豁免判定引用真源
    const serverRel = "server/acp-server.mjs";
    const serverSrc = read(serverRel);
    const guardBody = /async function supplementMissingOptions\([\s\S]*?\n {2}\}/.exec(serverSrc)?.[0] ?? "";
    expect(
      guardBody,
      `${serverRel} 的 supplementMissingOptions 函数体没有引用 CHAPTER_MARK_RE：章末回合豁免脱离了真源（现在函数体是「${guardBody.trim().split("\n").join(" ")}」）`,
    ).toContain("CHAPTER_MARK_RE");
  });

  it("主题白名单：server 与 theme.ts 的 font/dialog 白名单同集，两份兜底主题逐键一致", () => {
    const serverRel = "server/acp-server.mjs";
    const themeRel = "src/theme.ts";
    const serverSrc = read(serverRel);
    const themeSrc = read(themeRel);
    // 白名单数组：两侧源码各抽数组字面量（server 的 normalizeTheme 与 theme.ts 的 getTheme/dialogClass 都按它兜底）
    const arrayLiterals = (src: string, name: string, from: string): string[] => {
      const decl = new RegExp(`const ${name}[^\\n]*= \\[([^\\]]+)\\]`).exec(src);
      if (!decl) throw new Error(`${from} 里找不到 \`const ${name} = [...]\`：字体/对话框白名单没有可比对的字面量`);
      return [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    for (const name of ["FONT_PRESETS", "DIALOG_TEXTURES"]) {
      const serverList = arrayLiterals(serverSrc, name, serverRel);
      const clientList = arrayLiterals(themeSrc, name, themeRel);
      expect(
        [...serverList].sort(),
        `${name} 白名单不一致：${serverRel} 是 [${serverList.join(", ")}]、${themeRel} 是 [${clientList.join(", ")}]（谁和谁不一致：server normalizeTheme ↔ 客户端 getTheme/dialogClass 的兜底集合）`,
      ).toEqual([...clientList].sort());
      // 防第二份：server/ 全目录（v1.7 拆模块后 10 个文件）里白名单字面量只许入口那一份
      for (const file of serverSources()) {
        const copies = file.src.split(`const ${name}`).length - 1;
        expect(
          copies,
          `${file.rel} 里出现了第二份 ${name} 声明（${copies} 处）：白名单真源钉在 ${serverRel}，别处在声明就是漂移`,
        ).toBe(file.rel === serverRel ? 1 : 0);
      }
    }
    // 兜底主题：server DEFAULT_THEME（normalizeTheme 逐键兜底，/api/presets 出口填的就是它）
    // ↔ theme.ts FALLBACK_THEME（客户端更严一层校验的回退值）逐键一致——分叉时同一个非法 theme 会渲染成两种颜色
    const objOf = (text: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of text.matchAll(/([a-z0-9]+):\s*"([^"]+)"/g)) out[m[1]] = m[2];
      return out;
    };
    const serverSlice = serverSrc.slice(serverSrc.indexOf("const DEFAULT_THEME"));
    const serverObj = serverSlice.slice(0, serverSlice.indexOf("})"));
    if (!serverObj.includes("accent2")) throw new Error(`${serverRel} 里找不到完整的 DEFAULT_THEME 对象字面量：兜底主题没有可比对的副本`);
    const themeSlice = themeSrc.slice(themeSrc.indexOf("export const FALLBACK_THEME"));
    const clientObj = themeSlice.slice(0, themeSlice.indexOf("};"));
    if (!clientObj.includes("accent2")) throw new Error(`${themeRel} 里找不到完整的 FALLBACK_THEME 对象字面量：兜底主题没有可比对的副本`);
    expect(
      objOf(serverObj),
      `兜底主题不一致：${serverRel} 的 DEFAULT_THEME 是 ${JSON.stringify(objOf(serverObj))}、${themeRel} 的 FALLBACK_THEME 是 ${JSON.stringify(objOf(clientObj))}（server 填进 /api/presets 的兜底值必须与客户端回退值同色）`,
    ).toEqual(objOf(clientObj));
    // 第三份字面：global.css 的 CSS 初始变量（首帧/无注入态的兜底色）——改兜底色时三处必须同批改
    const cssSrc = read("src/styles/global.css");
    for (const key of ["accent", "accent2"]) {
      const expected = objOf(serverObj)[key];
      expect(
        cssSrc,
        `src/styles/global.css 的 --${key} 初始值与兜底主题分叉：DEFAULT_THEME/${key} 是 ${expected}，CSS 初始变量应写同值（改兜底色时 server · theme.ts · global.css 三处同批改）`,
      ).toContain(`--${key}: ${expected};`);
    }
  });
});
