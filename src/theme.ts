// 剧本主题：accent/accent2 十六进制色 + motif 氛围图案 + font 字体族 + dialog 对话框质感。
// preset.theme 由 /api/presets 提供（D 侧配置）；非法或缺省一律兜底 aurora 默认主题。
//
// v1.13：取值（三个白名单 + 兜底主题）搬去 **shared/theme.mjs** —— 此前 server 一份、这里又抄一份，
// 两份之间靠契约 lint 刮源码比对；现在两边 import 同一份，客户端侧的三份拷贝也随之消失。
// 本文件保留的是**客户端特有的更严校验口径**（6 位 hex 的 HEX_RE、字体栈、质感 → 类名映射）。
import type { CSSProperties } from "react";
import type { Preset } from "./lib/acp";
import { DIALOG_TEXTURES, FALLBACK_THEME, FONT_PRESETS, MOTIFS } from "../shared/theme.mjs";

export { FALLBACK_THEME, MOTIFS };

/** 氛围母题：由真源的字面元组派生（新增母题只改 shared/theme.mjs） */
export type Motif = (typeof MOTIFS)[number];

/** 字体族档位：serif=西文衬线兜底、song=宋、kai=楷、hei=黑（无衬线） */
export type FontPreset = (typeof FONT_PRESETS)[number];

/** 对话框质感档位：plain=现状不加处理、silk=缎面高光、paper=纸纹、glass=毛玻璃高光 */
export type DialogTexture = (typeof DIALOG_TEXTURES)[number];

export interface Theme {
  accent: string;
  accent2: string;
  motif: Motif;
  /** 字体族档位（缺省 serif；themeVars 展开为 --font-preset 系统字体栈） */
  font?: FontPreset;
  /** 对话框质感档位（缺省 plain；dialogClass 映射为 global.css 的 dialog-* 类） */
  dialog?: DialogTexture;
}

// HEX_RE 导出给 scripts/doctor.mjs 复用：体检查 theme 时要叠加客户端这层更严的回退判定
//（server 的 isColor 放行 3-8 位 hex —— 落到客户端才会被这里拦下）。这是客户端口径，不属于共享真源。
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 白名单成员判定：运行时值来自 preset frontmatter（`string`），而真源是**字面元组**——
 * 元组的 `includes` 只收字面联合，所以先宽化成 `readonly string[]` 再查。
 * 刻意不 trim：与 shared 真源落定后的既有语义逐字一致（trim 发生在 server 侧 normalizeTheme）。
 * @param {readonly string[]} list 白名单 @param {string|undefined} v 待判定的值
 * @returns {string|null} 命中时原样返回，否则 null
 */
function oneOf<T extends string>(list: readonly T[], v: string | undefined): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * 系统字体栈（离线应用，不引任何 webfont）：每档都是「mac 名 → Windows 名 → Linux Noto 兜底」
 * 的降级链，浏览器取第一个本机可用的字面；中文字面必须整体加引号（含空格的字体名不加引号会被
 * CSS 解析成多个字体名）。与 server/acp-server.mjs 的 FONT_PRESETS 白名单同集。
 */
export const FONT_STACKS: Record<FontPreset, string> = {
  serif: 'Georgia, "Times New Roman", "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif',
  song: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif CJK SC", serif',
  hei: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
};

/**
 * 从 preset 提取主题，字段逐一校验，任何不合法都回退兜底值。
 * @param {Preset | null | undefined} preset 当前选中剧本（标题屏可为 null）
 * @returns {Theme} 可直接使用的主题
 */
export function getTheme(preset: Preset | null | undefined): Theme {
  const t = preset?.theme;
  if (!t) return FALLBACK_THEME;
  return {
    accent: HEX_RE.test(t.accent) ? t.accent : FALLBACK_THEME.accent,
    accent2: HEX_RE.test(t.accent2) ? t.accent2 : FALLBACK_THEME.accent2,
    motif: oneOf(MOTIFS, t.motif) ?? "aurora",
    font: oneOf(FONT_PRESETS, t.font) ?? "serif",
    dialog: oneOf(DIALOG_TEXTURES, t.dialog) ?? "plain",
  };
}

/**
 * 主题 → 容器 CSS 变量（--accent/--accent2/--font-preset），挂到 stage 根或子树即可让
 * --gold 派生类、新组件与字体族全部跟随当前剧本主题；字体族由根容器以
 * `fontFamily: "var(--font-preset)"` 消费（见 App.tsx）。
 * @param {Theme} theme 目标主题
 * @returns {CSSProperties} 展开进 style 的变量集
 */
export function themeVars(theme: Theme): CSSProperties {
  return {
    "--accent": theme.accent,
    "--accent2": theme.accent2,
    "--font-preset": FONT_STACKS[theme.font ?? "serif"],
  } as CSSProperties;
}

/**
 * 对话框质感 → global.css 类名（dialog-plain/silk/paper/glass）。plain 也在 CSS 里
 * 对应「无规则」——返回类名是为了让映射可测、组件侧不必分叉。
 * @param {string | undefined} dialog getTheme 归一前的原始档位（非法/缺省 → plain）
 * @returns {string} dialog-* 类名
 */
export function dialogClass(dialog: string | undefined): string {
  const d = oneOf(DIALOG_TEXTURES, dialog);
  return d ? `dialog-${d}` : "dialog-plain";
}
