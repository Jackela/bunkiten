// shared/protocol.mjs 的手写类型声明（v1.7）：tsc -b（moduleResolution: bundler）按 `.mjs` → `.d.mts`
// 解析，让 src/lib/parser.ts 能 import 这些常量；运行时真体是同目录的 protocol.mjs（零依赖纯常量，
// vite/vitest/electron 直接吃 .mjs，不经本文件）。
// PROTOCOL_HEADS/AUDIO_KINDS 用字面元组钉住类型——parser 的 `AudioKind` 字面联合与原 `as const`
// 语义都由这里承接；AUDIO_EXTS 的字面白名单刻意只活在 .mjs 运行时真源里，本声明不重复第二份
//（契约 lint ⑤ 只认 shared/protocol.mjs 源码那一份）。

/** 协议头集合（唯一真源）：`isProtocolLine` 的正则由它构造（构造点在 src/lib/parser.ts） */
export const PROTOCOL_HEADS: readonly ["图", "清单", "章", "立绘", "新剧本", "树", "曲", "环境", "音效"];

/** 音频协议行三类型：【曲】BGM、【环境】环境音、【音效】一次性音效 */
export const AUDIO_KINDS: readonly ["曲", "环境", "音效"];

/** 音频文件扩展名白名单（/audio 直服与剧本导入包共用；客户端不设第二份） */
export const AUDIO_EXTS: readonly string[];

/** 音频文件名 `<类型>-<名>.<ext>`（由 AUDIO_KINDS/AUDIO_EXTS 构造，见 protocol.mjs 源码） */
export const AUDIO_FILE_RE: RegExp;

/** /audio 直服相对路径白名单（由 AUDIO_EXTS 构造） */
export const AUDIO_REL_RE: RegExp;

/** 扩展名 → Content-Type（键与 AUDIO_EXTS 同集） */
export const AUDIO_MIME: Readonly<Record<string, string>>;

/** 客户端指令前缀（pickEffort 推理分档与 isMainTurn 正戏回合判定共用；「待命：」后缀判定不在此） */
export const DIRECTIVE_PREFIX_RE: RegExp;

/** 终章回合章标记行（【章】第 N 章 完，多行锚定）：parseChapterMark 取捕获组，server 质量守卫据此豁免章末回合 */
export const CHAPTER_MARK_RE: RegExp;
