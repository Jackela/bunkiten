// shared/theme.mjs 的手写类型声明（v1.13）：机制与 shared/protocol.d.mts 同款——
// tsc -b（moduleResolution: bundler）按 `.mjs` → `.d.mts` 解析，运行时真体是同目录的 theme.mjs
//（零依赖纯常量，vite/vitest/electron 直接吃 .mjs，不经本文件）。
// 三个白名单用**字面元组**钉类型：src/theme.ts 的 Motif / FontPreset / DialogTexture 三个字面联合
// 都由这里 (typeof X)[number] 派生，值只活在 .mjs 里，本声明不重复第二份。
// tests/declarations.test.ts 断言本文件的导出名与 theme.mjs 的运行时导出双向对齐。

/** 氛围母题闭集 */
export const MOTIFS: readonly ["summer", "rune", "imperial", "aurora"];

/** 字体族档位 */
export const FONT_PRESETS: readonly ["serif", "song", "kai", "hei"];

/** 对话框质感档位 */
export const DIALOG_TEXTURES: readonly ["plain", "silk", "paper", "glass"];

/** 兜底主题（aurora）：preset 未配 theme 或字段非法时使用 */
export const FALLBACK_THEME: Readonly<{
  accent: string;
  accent2: string;
  motif: "summer" | "rune" | "imperial" | "aurora";
  font: "serif" | "song" | "kai" | "hei";
  dialog: "plain" | "silk" | "paper" | "glass";
}>;
