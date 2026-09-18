// 文本协议解析纯函数：行为迁移自 shell/index.html（旧版是交互事实源），不依赖 React/DOM。
// 可被 node 直接 import 做冒烟测试，勿引入副作用。
import { ART_KINDS, ASSET_KINDS, AUDIO_KINDS, CHAPTER_MARK_RE, PROTOCOL_HEADS } from "../../shared/protocol.mjs";

// 协议常量唯一真源（v1.7，docs/adr/0012）：PROTOCOL_HEADS / AUDIO_KINDS / ART_KINDS / ASSET_KINDS 的值住在
// shared/protocol.mjs（server 也 import 同一份）。这里 re-export 维持公共 API 逐字不变——store 与测试仍从
// src/lib/parser import。顺序即契约声明顺序（CONTRACTS §6）；改真源前先同步 SKILL.md / ARCHITECTURE.md 的
// 备忘与表格，以及 server 侧对应的各 parse*（协议是四处一致的字符串契约，不是各自实现的巧合）。
export { AUDIO_KINDS, PROTOCOL_HEADS };

/** 【图】标记（立绘/背景/封面） */
export interface Marker {
  kind: "portrait" | "background" | "cover";
  /** 标记里的名字：立绘=角色名[-变体]，背景=地点名，封面=剧本标题 */
  name: string;
  /** 标记里的原始图片路径：新生成 = `images/N.jpg`；缓存命中 = `presets/<剧本 id>/assets/…`；封面 = `presets/<id>/cover.jpg` */
  path: string;
  /** true=带第四段「重绘」的覆盖标记（仅【素材重绘】输出） */
  regen?: boolean;
}

/** 制作清单（【清单】行）的一项：立绘=角色名，背景=地点名 */
export interface ManifestEntry {
  kind: "portrait" | "background";
  name: string;
}

/** **行动** 选项段解析出的一条选项 */
export interface GameOption {
  /** 编号，无法解析编号时为空串 */
  n: string;
  /** 选项正文 */
  t: string;
}

/** protagonist_card 的一问 */
export interface CardQuestion {
  /** 原始问题文本（含「（选一）」「（选 1-2）」等括注） */
  label: string;
  /** 字段简名：去掉尾部括注，用于开局指令的 key */
  shortName: string;
  /** 问题标注「选 1-2」时允许多选（最多 2） */
  multi: boolean;
  options: string[];
}

/** 主角卡一问的作答（开局指令用） */
export interface CardAnswer {
  shortName: string;
  values: string[];
}

const KIND_MAP: Record<string, Marker["kind"]> = { 立绘: "portrait", 背景: "background", 封面: "cover" };

function toMarker(kind: string, name: string, path: string, regen?: string): Marker {
  return { kind: KIND_MAP[kind] ?? "portrait", name: name.trim(), path: path.trim(), ...(regen ? { regen: true } : {}) };
}

/** 【图】标记行的段体：类型|名|路径[|重绘]（重绘段存在=覆盖旧图的重新生成）；类型集合取 shared 真源 */
const ART_LINE_BODY = `(${ART_KINDS.join("|")})\\|([^|\\n]+)\\|([^|\\n]+?)(?:\\|(重绘))?`;

/**
 * 流式扫描【图】标记：只匹配以换行结束的完整标记行。
 * 半行（还在流式补齐、没有换行）不匹配，避免半截路径提前闪图。
 * @param {string} text 当前段累计文本
 * @returns {Marker[]} 本次文本里出现的全部标记（去重由调用方负责）
 */
export function scanMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const m of text.matchAll(new RegExp(`【图】${ART_LINE_BODY}\\n`, "g"))) {
    out.push(toMarker(m[1], m[2], m[3], m[4]));
  }
  return out;
}

/**
 * 终态扫描（turn_end 用）：行尾锚定，兜底正文最后一行没有换行符的标记。
 * @param {string} text 定稿的当前段全文
 * @returns {Marker[]} 全部标记，不做去重（回到旧背景等场景需要重放）
 */
export function finalMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const m of text.matchAll(new RegExp(`【图】${ART_LINE_BODY}\\s*$`, "gm"))) {
    out.push(toMarker(m[1], m[2], m[3], m[4]));
  }
  return out;
}

/**
 * 音频协议行的三种类型字面（v1.6）：【曲】切 BGM、【环境】切环境音、【音效】一次性音效。
 * 名必须与 `presets/<剧本 id>/audio/<类型>-<名>.<ext>` 的文件名一致；客户端不做路径拼接解析（走 /api/audio 索引）。
 */
export type AudioKind = (typeof AUDIO_KINDS)[number];

/** 协议行正则：由 {@link PROTOCOL_HEADS} 构造（新增协议头只改那一个数组，别手写第二份） */
const PROTOCOL_LINE_RE = new RegExp(`^【(${PROTOCOL_HEADS.join("|")})】`);

/**
 * 整行是否协议行（{@link PROTOCOL_HEADS} 开头）：这些行不进对话正文与历史。
 * 【立绘】是表情切换指令、【新剧本】是装配完成通知、【树】是剧情图编辑完成通知、
 * 【曲】/【环境】/【音效】是音频演出指令，同为引擎协议行，对玩家不可见。
 * @param {string} line 单行文本
 * @returns {boolean} true 表示该行是引擎协议行，对玩家不可见
 */
export function isProtocolLine(line: string): boolean {
  return PROTOCOL_LINE_RE.test(line.trim());
}

/** 【清单】行：类型只认立绘/背景（shared 的 ASSET_KINDS 真源）——封面不走制作清单 */
const MANIFEST_LINE_RE = new RegExp(`^【清单】(${ASSET_KINDS.join("|")})\\|([^\\n]+)$`, "gm");

/**
 * 解析规划回合输出的制作清单：整行匹配 `【清单】立绘|<名>` / `【清单】背景|<地点>`。
 * @param {string} text 规划回合的定稿全文
 * @returns {ManifestEntry[]} 清单项（保持输出顺序）；没有清单行返回空数组
 */
export function parseManifest(text: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const m of text.matchAll(MANIFEST_LINE_RE)) {
    out.push({ kind: m[1] === "背景" ? "background" : "portrait", name: m[2].trim() });
  }
  return out;
}

/**
 * 解析终章回合输出的章标记 `【章】第 N 章 完`。
 * @param {string} text 该回合的定稿全文
 * @returns {number | null} 命中的章号 N；没有章标记返回 null
 */
export function parseChapterMark(text: string): number | null {
  const m = text.match(CHAPTER_MARK_RE);
  return m ? Number(m[1]) : null;
}

// —— 剧情树（story-tree.md）解析：容错第一，任何怪格式都不抛错，解析不出结构就返回 null（屏内回退显示原文）——

export type TreeNodeStatus = "可达" | "已走过" | "已剪枝" | "嫁接";

/** 节点的一条出边：意图描述 → 目标节点 id */
export interface TreeEdge {
  label: string;
  target: string;
}

export interface TreeNode {
  /** 节点 id（`### 节点 3-1（…）` 里的 3-1） */
  id: string;
  /** 拍点：节点标题括注里的一句话 */
  beat: string;
  location: string;
  present: string;
  synopsis: string;
  edges: TreeEdge[];
  status: TreeNodeStatus;
}

export interface TreeChapter {
  /** 章节标题（`## 第 N 章：<标题>` 的标题部分；缺省时回退「第 N 章」） */
  title: string;
  goal: string;
  outline: string;
  /** 当前进度指针指向的节点 id（`- 当前进度: 节点 3-2（已走 4 轮）`），没有则为 null */
  current: string | null;
  nodes: TreeNode[];
}

export interface StoryTree {
  /** 归档区原文行（每章一行：大纲 + 已走节点链） */
  archive: string[];
  chapters: TreeChapter[];
}

const TREE_CHAPTER_RE = /^##\s+第\s*([0-9一二三四五六七八九十百]+)\s*章\s*[：:]\s*(.*)$/;
const TREE_NODE_RE = /^###\s+节点\s+([^\s（(]+)\s*(?:[（(](.*?)[）)])?\s*$/;
const TREE_FIELD_RE = /^-\s*([^:：]+?)\s*[:：]\s*(.*)$/;
const TREE_STATUS_RE = /^(可达|已走过|已剪枝|嫁接)$/;

/** 出边字段拆分：`意图 → id；意图 → id`（分号中英文皆可；容忍 -> 箭头） */
function parseTreeEdges(raw: string): TreeEdge[] {
  const out: TreeEdge[] = [];
  for (const part of raw.split(/[；;]/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)\s*(?:→|->)\s*([^\s→]+)\s*$/);
    if (m && m[2]) out.push({ label: m[1].trim(), target: m[2].trim() });
  }
  return out;
}

/**
 * 解析剧情树文件（`state/worlds/<id>/story-tree.md`）。容错优先：字段缺失留空、坏行跳过；
 * 完全没有章节/节点结构（未规划、文件损坏）返回 null，由剧情图屏回退显示原文。
 * @param {string} md 树文件全文
 * @returns {StoryTree | null} 章节（含归档）与节点结构；无可解析结构返回 null
 */
export function parseStoryTree(md: string): StoryTree | null {
  if (!md || !md.trim()) return null;
  const out: StoryTree = { archive: [], chapters: [] };
  let chapter: TreeChapter | null = null;
  let node: TreeNode | null = null;
  let inArchive = false;
  let sawStructure = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^##\s+归档\s*$/.test(line)) {
      inArchive = true;
      chapter = null;
      node = null;
      continue;
    }
    const ch = line.match(TREE_CHAPTER_RE);
    if (ch) {
      inArchive = false;
      chapter = { title: (ch[2] || `第 ${ch[1]} 章`).trim(), goal: "", outline: "", current: null, nodes: [] };
      out.chapters.push(chapter);
      node = null;
      sawStructure = true;
      continue;
    }
    const nd = line.match(TREE_NODE_RE);
    if (nd && chapter) {
      node = { id: nd[1], beat: (nd[2] ?? "").trim(), location: "", present: "", synopsis: "", edges: [], status: "可达" };
      chapter.nodes.push(node);
      sawStructure = true;
      continue;
    }
    const f = line.match(TREE_FIELD_RE);
    if (!f) continue;
    if (inArchive) {
      if (/^\s*-\s+/.test(line)) out.archive.push(line.replace(/^\s*-\s+/, "").trim());
      continue;
    }
    const key = f[1].trim();
    const value = f[2].trim();
    if (node) {
      if (key === "地点") node.location = value;
      else if (key === "在场") node.present = value;
      else if (key === "梗概") node.synopsis = value;
      else if (key === "出边") node.edges = parseTreeEdges(value);
      else if (key === "状态" && TREE_STATUS_RE.test(value)) node.status = value as TreeNodeStatus;
    } else if (chapter) {
      if (key === "目标") chapter.goal = value;
      else if (key === "大纲") chapter.outline = value;
      else if (key === "当前进度") chapter.current = value.match(/节点\s*([^\s（(]+)/)?.[1] ?? null;
    }
  }
  return sawStructure ? out : null;
}

/**
 * 截断「**行动**」选项段：从 `**行动**` 行（含）起连同其后的全部选项行一并去掉，
 * 只留正文。用于对话窗与历史（选项由按钮呈现，不重复打进字机）；半截的 `**行` 不算。
 * @param {string} text 当前文本
 * @returns {string} 去掉选项段（含尾部空白行）的正文
 */
export function stripOptionsBlock(text: string): string {
  const i = text.search(/\*\*行动\*\*/);
  return i === -1 ? text : text.slice(0, i).replace(/\s+$/, "");
}

/**
 * 打字机目标文本：按行保持——流式期间丢弃最后一行（可能是半截标记），
 * finalText 落定后保留全部行；协议行（{@link PROTOCOL_HEADS}：图/清单/章/立绘/新剧本/树/曲/环境/音效）始终过滤；
 * 「**行动**」行出现即截断（流式打出该行后正文不再增长，选项交给按钮渲染）。
 * 截断放在行保持之后：选项段之前的正文行必已完整，不被行保持误丢。
 * @param {string} received 当前段累计文本
 * @param {string} finalText 非空表示回合已定稿
 * @returns {string} 当前应显示的文本（追加式增长，供打字机逐字追）
 */
export function visibleTarget(received: string, finalText: string): string {
  const lines = received.split("\n").filter((l) => !isProtocolLine(l));
  const keep = finalText ? lines : lines.slice(0, Math.max(0, lines.length - 1));
  return stripOptionsBlock(keep.join("\n"));
}

/**
 * 解析正文末尾的「**行动**」选项段。
 * @param {string} text 定稿的当前段全文
 * @returns {GameOption[] | null} 选项列表；没有选项段返回 null
 */
export function parseOptions(text: string): GameOption[] | null {
  const m = text.match(/\*\*行动\*\*\s*\n([\s\S]+)$/);
  if (!m) return null;
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isProtocolLine(l))
    .map((l) => {
      const mm = l.match(/^(\d+)[.、]\s*(.+)$/);
      return mm ? { n: mm[1], t: mm[2] } : { n: "", t: l };
    });
}

/** 历史记录用正文：过滤协议行（{@link PROTOCOL_HEADS}）、去掉选项段并去除首尾空白 */
export function cleanForHistory(finalText: string): string {
  return stripOptionsBlock(finalText)
    .split("\n")
    .filter((l) => !isProtocolLine(l))
    .join("\n")
    .trim();
}

/** 工具段标题映射状态栏文字（作画段单独提示） */
export function segStatusLabel(label: string): string {
  return /图|imag|paint|draw/i.test(label) ? "作画中…" : "引擎演绎中…";
}

const CARD_LINE_RE = /^-\s*(.+?)[：:]\s*(.+)$/;
const MULTI_HINT_RE = /选\s*1-2/;

/**
 * protagonist_card 逐问解析：每行 `- 问题: 选项A / 选项B` → label + options。
 * @param {string[]} lines preset 的 protagonist_card 小节正文行
 * @returns {CardQuestion[]} 无法解析的行跳过
 */
export function parseCardLines(lines: string[]): CardQuestion[] {
  const out: CardQuestion[] = [];
  for (const raw of lines) {
    const m = raw.match(CARD_LINE_RE);
    if (!m) continue;
    const label = m[1].trim();
    out.push({
      label,
      shortName: label.replace(/（[^）]*）\s*$|\([^)]*\)\s*$/, "").trim(),
      multi: MULTI_HINT_RE.test(label),
      options: m[2]
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return out;
}

// —— 开局指令构造：与引擎 SKILL 的字符串契约一字不差，勿改句式 ——

/** 待命后缀：引擎只初始化，不开始剧情；美术由前端逐项发 {@link buildArtCommand}，最后发 {@link BUILD_START} */
const STANDBY_SUFFIX = "待命：只初始化，不开始剧情，等待分项美术指令与「开演。」";
const SKIP_SUFFIX = "跳过美术预载，直接开演。";

/** 分项美术指令的种类（与引擎【图】标记的种类字面对齐；类型源 = shared 的 ART_KINDS；封面只出现在重绘指令） */
export type ArtKind = (typeof ART_KINDS)[number];

/**
 * 分项美术指令（待命模式下逐项发送）。
 * @param {ArtKind} kind 立绘或背景
 * @param {string} name 角色名或地点名（v1.2 起来自制作清单）
 * @returns {string} 形如「美术：立绘 沈屿」的指令原文
 */
export function buildArtCommand(kind: ArtKind, name: string): string {
  return `美术：${kind} ${name}`;
}

/** 全部美术完成后开始剧情的指令原文 */
export const BUILD_START = "开演。";

/**
 * 续玩已有世界线的指令（v1.5 世界线屏「继续」）：引擎读该世界三文件续演，跳过一切初始化与开场卡。
 * @param {string} worldId 世界 id（`state/worlds/<worldId>/`）
 * @returns {string} 形如「继续世界：twilight-throne-2。」的指令原文
 */
export function buildResumeCommand(worldId: string): string {
  return `继续世界：${worldId}。`;
}

/**
 * 剧情图自然语言编辑指令（v1.5 剧情图屏）：引擎改故事树、静默写回，回一句摘要 +【树】标记。
 * @param {string} text 玩家的一句话改动说明
 * @returns {string} 形如「剧情：把节点 3-1 的教堂分支改成酒馆。」的指令原文
 */
export function buildTreeEditCommand(text: string): string {
  return `剧情：${text.trim()}`;
}

/**
 * 差分名拆分：`<名>[-<变体>]` 按第一个连字符分隔（与 server splitAssetVariant 同源）。
 * 无连字符即基础版（variant 为空串），如 `薇拉` / `薇拉-微笑`。
 * @param {string} name 清单项或资产名
 * @returns {{base: string, variant: string}} 拆分出的角色名与变体名
 */
export function splitAssetVariant(name: string): { base: string; variant: string } {
  const i = name.indexOf("-");
  return i === -1 ? { base: name, variant: "" } : { base: name.slice(0, i), variant: name.slice(i + 1) };
}

/**
 * 资产显示名的变体后缀：有变体拼成「<名> · <变体>」（画廊卡片与制作槽位共用这一处格式），
 * 基础版/背景/封面原样返回。
 * @param {string} base 基础名（角色名或地点名）
 * @param {string | null} [variant] 变体名（空/缺省 = 基础版）
 * @returns {string} 展示用名
 */
export function variantLabel(base: string, variant?: string | null): string {
  return variant ? `${base} · ${variant}` : base;
}

/** 资产名归一化：去掉全部空白（引擎措辞与落盘名之间的唯一稳定等价关系） */
export function normalizeAssetKey(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

/**
 * 制作清单项是否已有对应落盘资产——缓存兜底过滤的判定核心（纯函数）。
 * 规则：**差分变体必须一致**（基础项只认基础资产、变体项只认同名变体文件——否则基础立绘会把
 * 差分项「吸收」掉，差分永不生成且 URL 指向不存在的文件）；名字空白归一后完全一致或互为包含即命中。
 * 引擎侧规划已做缓存感知，这里是第二道闸：命中即跳过生成、直服落盘文件。
 * @param {{name: string; variant: string}} asset 落盘资产（variant 为空串=基础版）
 * @param {{name: string; variant: string}} item 清单项
 * @returns {boolean} true=资产已存在，无需生成
 */
export function assetNameMatches(
  asset: { name: string; variant: string },
  item: { name: string; variant: string },
): boolean {
  if (asset.variant !== item.variant) return false;
  const a = normalizeAssetKey(asset.name);
  const b = normalizeAssetKey(item.name);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * 素材重绘指令（画廊对单个已有素材的重新生成，管理操作）。
 * @param {ArtKind} type 立绘 / 背景 / 封面
 * @param {string} key 立绘=`角色名[-变体]`（如 `薇拉-微笑`）；背景=地点名；封面=preset id
 * @returns {string} 形如「美术：重绘 立绘 薇拉-微笑」的指令原文
 */
export function buildRegenCommand(type: ArtKind, key: string): string {
  return `美术：重绘 ${type} ${key}`;
}

/** 创作模式进入指令原文（引擎 SKILL【剧本创作】入口，一字不差） */
export const ENTER_CREATION = "创作模式：进入剧本创作。";

/** 创作模式装配指令原文（玩家点「开始装配」时发送） */
export const BUILD_ASSEMBLE = "装配。";

/**
 * 章节规划指令（v1.2 章间制作流程入口）：引擎据此写剧情树并回制作清单。
 * @param {number} n 章号（从 1 起）
 * @returns {string} 形如「规划：第 1 章。」的指令原文
 */
export function buildPlanCommand(n: number): string {
  return `规划：第 ${n} 章。`;
}

/**
 * 自定义开局指令。多值字段（特质等）用 + 连接，字段间用「；」。
 * 世界段 `世界：<worldId>。` 位于主角卡段之后、美术结尾后缀之前（后缀必须保持在指令末尾，
 * 引擎按「指令以 …结尾」识别待命/跳过变体）。
 * @param {string} title 剧本标题（书名号内原文）
 * @param {CardAnswer[]} answers 已作答的主角卡
 * @param {boolean} preload true=待命模式（前端随后逐项发美术指令），false=跳过美术直接开演
 * @param {string} worldId 世界 id（新世界线；调用方缺省传 "main"）
 * @returns {string} 发给 /prompt 的完整指令
 */
export function buildCustomOpening(title: string, answers: CardAnswer[], preload: boolean, worldId: string): string {
  const card = answers.map((a) => `${a.shortName}=${a.values.join("+")}`).join("；");
  const suffix = preload ? STANDBY_SUFFIX : SKIP_SUFFIX;
  return `开局：《${title}》。主角卡：${card}。世界：${worldId}。${suffix}`;
}

/**
 * 快速开局指令（用剧本 quick_start 预设主角）。
 * @param {string} title 剧本标题
 * @param {boolean} preload 同 {@link buildCustomOpening}
 * @param {string} worldId 世界 id（新世界线；调用方缺省传 "main"）
 * @returns {string} 发给 /prompt 的完整指令
 */
export function buildQuickOpening(title: string, preload: boolean, worldId: string): string {
  const suffix = preload ? STANDBY_SUFFIX : SKIP_SUFFIX;
  return `开局：《${title}》。快速开局：用剧本 quick_start 预设主角。世界：${worldId}。${suffix}`;
}
