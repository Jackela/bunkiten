// 协议常量的单一真源（v1.7，docs/adr/0012）：server（acp-server.mjs）与客户端（src/lib/parser.ts，
// 经 re-export 维持公共 API 不变）共用的零依赖纯常量模块。此前这些字符串双侧各一份、只靠契约 lint
// 比对两份源码文本，谁先改谁就分叉；现在值只有这一份，lint 从「双侧比对」改为「真源断言」
//（读本文件源码 + import 值，双向钉住；tests/contract.test.ts ①⑤⑥组）。
//
// 为什么 RULES 不在这里收编：RULES 是 server 常量 ↔ .grok/skills/bunkiten/SKILL.md 的逐字副本——
// 引擎（grok agent）只读 .grok/ 下的提示词文件、不会 import 本模块，双份天然必须存在，
// lint 对它们做逐字比对仍是正确机制（tests/contract.test.ts ②组）。

/**
 * 协议头集合（**唯一真源**）：`isProtocolLine` 的正则由它构造（构造点在 src/lib/parser.ts，
 * 消费点也在客户端；server 侧对应各 parse* 出口）。顺序即契约声明顺序（CONTRACTS §6），
 * 改这里前先同步 SKILL.md / ARCHITECTURE.md 的备忘与表格，以及 server 侧对应的各 parse*。
 */
export const PROTOCOL_HEADS = Object.freeze(["图", "清单", "章", "立绘", "新剧本", "树", "曲", "环境", "音效"]);

/**
 * 音频协议行的三种类型字面（v1.6）：【曲】切 BGM、【环境】切环境音、【音效】一次性音效。
 * server（scanPresetAudio/AUDIO_FILE_RE）与客户端（parser re-export → AudioKind 类型）共用。
 */
export const AUDIO_KINDS = Object.freeze(["曲", "环境", "音效"]);

/** 音频文件扩展名白名单（直服 /audio 与剧本导入包共用；客户端不设第二份，只认 /api/audio 索引给的 url） */
export const AUDIO_EXTS = Object.freeze(["mp3", "ogg", "m4a", "wav", "flac"]);

/** 音频文件名 `<类型>-<名>.<ext>`：类型与扩展名都过白名单（名可含中文，不含路径分隔符） */
export const AUDIO_FILE_RE = new RegExp(`^(${AUDIO_KINDS.join("|")})-(.+)\\.(${AUDIO_EXTS.join("|")})$`);

/** /audio 直服白名单（与 /img 同款思路）：相对路径形态 + 无子目录 + 扩展名合法——resolve 前缀校验是第二道闸 */
export const AUDIO_REL_RE = new RegExp(`^presets/[A-Za-z0-9_-]+/audio/[^/]+\\.(${AUDIO_EXTS.join("|")})$`);

/** 扩展名 → Content-Type（键必须与 AUDIO_EXTS 同集，漏一个直服就回落 octet-stream） */
export const AUDIO_MIME = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
};

/**
 * 美术类型字面（**唯一真源**，v1.7 收尾）：【图】标记与【清单】行的类型段（立绘/背景/封面）。
 * 资产文件名（`<类型>-<名>.jpe?g`，落盘与 /img 直服白名单）只认立绘/背景（ASSET_KINDS 子集）——
 * 封面走 `presets/<id>/cover.jpg`，不进 assets/。消费方：src/lib/parser.ts（ART_LINE_BODY / parseManifest /
 * ArtKind 类型）、server/protocol-lines.mjs（parseArtLine）、server/assets.mjs（ASSET_FILE_RE 构造与 re-export）、
 * scripts/doctor.mjs（资产命名契约）。RULES 的【图】句仍是逐字文本（引擎只读 .grok/、不 import 代码）——
 * 改这里要同步那句，以及 SKILL.md【美术】小节。
 */
export const ART_KINDS = Object.freeze(["立绘", "背景", "封面"]);

/** 资产文件名的类型子集（立绘/背景；封面走 cover.jpg 不进 assets/） */
export const ASSET_KINDS = Object.freeze(["立绘", "背景"]);

/** 资产文件名 `<类型>-<名>.jpe?g`（由 ASSET_KINDS 构造）：落盘与 /img 直服白名单共用一份 */
export const ASSET_FILE_RE = new RegExp(`^(${ASSET_KINDS.join("|")})-(.+)\\.jpe?g$`);

/**
 * 客户端指令前缀正则（**单一真源**，v1.7 收编）：以这些前缀开头的提示词是「建档/规划类回合」——
 * `pickEffort` 走 planning 推理档（CONTRACTS §4）、`isMainTurn` 判定不产生逐轮快照（CONTRACTS §2）。
 * 两者此前各持一份手写正则（集合相同、仅交替顺序不同，语义等价），现共用本正则。
 * 注意边界：「待命：」是开局指令的**后缀**判定，留在 isMainTurn 原地，不属前缀集合；
 * 「开局：」「继续世界：」前缀属 isDirectivePrompt（世界落盘嗅探），刻意不在本集合——
 * 开局/续玩本身是正戏回合（无待命后缀时要推进剧情与快照），收进来会改变档位与快照语义。
 */
export const DIRECTIVE_PREFIX_RE = /^(规划：|美术：|剧情：|装配。|创作模式：)/;

/**
 * 终章回合的章标记行（**单一真源**，v1.7 收编）：`【章】第 N 章 完`（整行，允许行尾空白，`m` 多行锚定）。
 * 此前这份正则只活在 src/lib/parser.ts 的 `parseChapterMark`（取捕获组给章号）；
 * server 质量守卫 `supplementMissingOptions` 豁免章末回合也用它（`test` 整段回合文本）。
 * 章末回合是每轮协议「以选项结束」的唯一合法例外——SKILL.md「章节与剧情树」与 RULES 第 3 句
 * （协议行枚举句里的「终章回合输出【章】第 N 章 完」）双处声明，缺 `**行动**` 不是引擎忘写。
 * 刻意不带 `g` 标记：`.test()` 无 lastIndex 隐态，双侧（parser 的 match / server 的 test）消费都安全。
 */
export const CHAPTER_MARK_RE = /^【章】第 (\d+) 章 完\s*$/m;
