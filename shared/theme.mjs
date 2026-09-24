// 主题取值的唯一真源（v1.13）：字体族/对话框质感白名单、氛围母题集合、兜底主题。
//
// 为什么值得单独一个 shared 模块（此前是三份拷贝 + 一条环）：
//   · server/acp-server.mjs 定义过一份（normalizeTheme 的逐键兜底真值），server/presets.mjs
//     为了拿它**反向 import 入口**——于是 acp-server ↔ presets 成了环，只靠「跨环引用都在函数体内」
//     这条约定活着（ESM 环形安全的代价是：谁在模块顶层用一次就变成静默 undefined）。
//   · src/theme.ts 自己又抄了一份（getTheme/dialogClass 的兜底），三份之间靠契约 lint 的源码刮取比对。
// 现在两边都 import 这一份：环没有了，客户端那份拷贝也没有了，契约 lint 从「比对三份」退化成
// 「确认只有一份 + CSS 初始值同批」（CSS 没法 import，那一份仍然只能靠 lint 钉）。
//
// 零依赖纯常量（与 shared/protocol.mjs 同款）：vite/vitest/electron 运行时直接吃 .mjs，
// tsc -b 按同目录的 theme.d.mts 解析类型；tests/declarations.test.ts 断言两者导出名对齐。

/** 氛围母题闭集（motifs/ 下四款图案的分发键；preset.theme.motif 落在这里面才算合法） */
export const MOTIFS = ["summer", "rune", "imperial", "aurora"];

/** 字体族档位：serif=西文衬线兜底、song=宋、kai=楷、hei=黑（无衬线） */
export const FONT_PRESETS = ["serif", "song", "kai", "hei"];

/** 对话框质感档位：plain=不加处理、silk=缎面高光、paper=纸纹、glass=毛玻璃高光 */
export const DIALOG_TEXTURES = ["plain", "silk", "paper", "glass"];

/**
 * 兜底主题（aurora）：preset 未配 theme、或字段非法时使用。
 * 消费方三处：`/api/presets` 出口的填值（server/presets.mjs 的 normalizeTheme）、
 * 客户端 getTheme 的回退（src/theme.ts）、以及 `src/styles/global.css` 的 `--accent`/`--accent2`
 * 初始变量（CSS 无法 import，那一份由契约 lint ⑥ 逐字比对）。
 */
export const FALLBACK_THEME = Object.freeze({
  accent: "#c9a86a",
  accent2: "#e8e4da",
  motif: "aurora",
  font: "serif",
  dialog: "plain",
});
