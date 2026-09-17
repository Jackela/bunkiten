// 剧本主题：accent/accent2 十六进制色 + motif 氛围图案 + font 字体族 + dialog 对话框质感。
// preset.theme 由 /api/presets 提供（D 侧配置）；非法或缺省一律兜底 aurora 默认主题。
import type { CSSProperties } from "react";
import type { Preset } from "./lib/acp";

export type Motif = "summer" | "rune" | "imperial" | "aurora";

/** 字体族档位：serif=西文衬线兜底、song=宋、kai=楷、hei=黑（无衬线） */
export type FontPreset = "serif" | "song" | "kai" | "hei";

/** 对话框质感档位：plain=现状不加处理、silk=缎面高光、paper=纸纹、glass=毛玻璃高光 */
export type DialogTexture = "plain" | "silk" | "paper" | "glass";

export interface Theme {
  accent: string;
  accent2: string;
  motif: Motif;
  /** 字体族档位（缺省 serif；themeVars 展开为 --font-preset 系统字体栈） */
  font?: FontPreset;
  /** 对话框质感档位（缺省 plain；dialogClass 映射为 global.css 的 dialog-* 类） */
  dialog?: DialogTexture;
}

/** 兜底主题（aurora）：所有 preset 未配 theme 或字段非法时使用（与 server/acp-server.mjs 的 DEFAULT_THEME 逐字一致，契约 lint 钉住） */
export const FALLBACK_THEME: Theme = {
  accent: "#c9a86a",
  accent2: "#e8e4da",
  motif: "aurora",
  font: "serif",
  dialog: "plain",
};

// MOTIFS/HEX_RE 导出给 scripts/doctor.mjs 复用：体检查 theme 时要叠加客户端这层更严的回退判定
//（server 的 isColor 放行 3-8 位 hex、motif 只要求非空——落到客户端才会被这里拦下），不抄第二份。
export const MOTIFS: readonly string[] = ["summer", "rune", "imperial", "aurora"];
const FONT_PRESETS: readonly string[] = ["serif", "song", "kai", "hei"];
const DIALOG_TEXTURES: readonly string[] = ["plain", "silk", "paper", "glass"];
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

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
    motif: MOTIFS.includes(t.motif) ? (t.motif as Motif) : "aurora",
    font: FONT_PRESETS.includes(t.font ?? "") ? (t.font as FontPreset) : "serif",
    dialog: DIALOG_TEXTURES.includes(t.dialog ?? "") ? (t.dialog as DialogTexture) : "plain",
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
  return DIALOG_TEXTURES.includes(dialog ?? "") ? `dialog-${dialog}` : "dialog-plain";
}
