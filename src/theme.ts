// 剧本主题：accent/accent2 十六进制色 + motif 氛围图案。
// preset.theme 由 /api/presets 提供（D 侧配置）；非法或缺省一律兜底 aurora 默认主题。
import type { CSSProperties } from "react";
import type { Preset } from "./lib/acp";

export type Motif = "summer" | "rune" | "imperial" | "aurora";

export interface Theme {
  accent: string;
  accent2: string;
  motif: Motif;
}

/** 兜底主题（aurora）：所有 preset 未配 theme 或字段非法时使用 */
export const FALLBACK_THEME: Theme = { accent: "#c9a86a", accent2: "#e7d5ae", motif: "aurora" };

const MOTIFS: readonly string[] = ["summer", "rune", "imperial", "aurora"];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

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
  };
}

/**
 * 主题 → 容器 CSS 变量（--accent/--accent2），挂到 stage 根或子树即可让
 * --gold 派生类与新组件全部跟随当前剧本主题。
 * @param {Theme} theme 目标主题
 * @returns {CSSProperties} 展开进 style 的变量集
 */
export function themeVars(theme: Theme): CSSProperties {
  return { "--accent": theme.accent, "--accent2": theme.accent2 } as CSSProperties;
}
