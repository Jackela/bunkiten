// 玩家设置（v1.6）：音频（主音量/静音/BGM/环境/音效）与文本（打字速度/自动前进）。
// 纯逻辑 + 逐键校验，不依赖 React/DOM——localStorage 缺失或写入失败都不抛（隐私模式、配额满、node 单测）。
// 存储键固定 `bunkiten.settings.v1`；字段值非法一律回该键的默认值（版本内不做迁移，换 key 才升版本号）。

/** 打字机速度档（DialogueBox 读 {@link TEXT_SPEED_MS} 换算间隔；instant=立即全文） */
export type TextSpeed = "slow" | "standard" | "fast" | "instant";

/** 自动前进可选间隔（毫秒；0=关） */
export const AUTO_ADVANCE_OPTIONS = [0, 3000, 5000] as const;

export type AutoAdvance = (typeof AUTO_ADVANCE_OPTIONS)[number];

export interface GameSettings {
  /** 主音量（0-1）：乘到三个通道上，静音时归 0 */
  master: number;
  /** BGM 通道音量（0-1，再乘主音量） */
  bgm: number;
  /** 环境音通道音量（0-1，再乘主音量） */
  ambient: number;
  /** 音效通道音量（0-1，再乘主音量） */
  sfx: number;
  /** 静音开关：勾上后所有通道按 0 播放（不改各通道自身音量值） */
  muted: boolean;
  textSpeed: TextSpeed;
  /** 正文打完后的自动前进间隔（毫秒；0=关。实际触发由后续 wave 接入，本轮只存偏好） */
  autoAdvance: AutoAdvance;
}

/** 出厂默认（CONTRACTS §1 逐字）：没有存档、存档损坏、单键非法都回落到这里 */
export const DEFAULT_SETTINGS: GameSettings = {
  master: 1,
  bgm: 0.8,
  ambient: 0.6,
  sfx: 0.9,
  muted: false,
  textSpeed: "standard",
  autoAdvance: 0,
};

/** localStorage 键（v1 设置；结构变更才改版本号，不做就地迁移） */
export const SETTINGS_STORAGE_KEY = "bunkiten.settings.v1";

/** 档位 → 打字机间隔（毫秒；0=立即全文，不做逐字动画） */
export const TEXT_SPEED_MS: Record<TextSpeed, number> = { slow: 40, standard: 24, fast: 12, instant: 0 };

/** 文本速度档位的展示序（设置屏四档按钮） */
export const TEXT_SPEED_OPTIONS: { value: TextSpeed; label: string }[] = [
  { value: "slow", label: "慢" },
  { value: "standard", label: "标准" },
  { value: "fast", label: "快" },
  { value: "instant", label: "瞬间" },
];

/** 自动前进档位的展示文案（键为毫秒数） */
export const AUTO_ADVANCE_LABELS: Record<AutoAdvance, string> = { 0: "关", 3000: "3 秒", 5000: "5 秒" };

/** 音量收敛到 [0,1]（滑杆步进 0.05，但存档/补丁可能塞进任意数） */
export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** 音量字段逐键校验：非数字/NaN/Infinity → 默认值，合法则收敛进 [0,1] */
function volumeOf(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : fallback;
}

/**
 * 任意输入 → 合法设置：逐键校验，坏键回默认、好键保留（存档只被部分写坏时不整份丢弃）。
 * @param {unknown} raw 候选（通常是 JSON.parse 的结果）
 * @returns {GameSettings} 可直接使用的设置
 */
export function normalizeSettings(raw: unknown): GameSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const o = raw as Partial<Record<keyof GameSettings, unknown>>;
  const textSpeed = TEXT_SPEED_OPTIONS.some((o2) => o2.value === o.textSpeed)
    ? (o.textSpeed as TextSpeed)
    : DEFAULT_SETTINGS.textSpeed;
  // autoAdvance 单独判（0 是合法值，不能用真值判断）
  const autoAdvance = AUTO_ADVANCE_OPTIONS.some((v) => v === o.autoAdvance)
    ? (o.autoAdvance as AutoAdvance)
    : DEFAULT_SETTINGS.autoAdvance;
  return {
    master: volumeOf(o.master, DEFAULT_SETTINGS.master),
    bgm: volumeOf(o.bgm, DEFAULT_SETTINGS.bgm),
    ambient: volumeOf(o.ambient, DEFAULT_SETTINGS.ambient),
    sfx: volumeOf(o.sfx, DEFAULT_SETTINGS.sfx),
    muted: typeof o.muted === "boolean" ? o.muted : DEFAULT_SETTINGS.muted,
    textSpeed,
    autoAdvance,
  };
}

/**
 * 读设置：没有存档、JSON 损坏、localStorage 不可用一律回默认（永不抛错——启动路径不能因设置挂掉）。
 * @returns {GameSettings} 合法设置
 */
export function loadSettings(): GameSettings {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 写设置（每次改动即时落盘；页面刷新后自动生效）。
 * @param {GameSettings} settings 待写入的完整设置
 */
export function saveSettings(settings: GameSettings): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式/配额满：静默（本次会话内仍然生效，只是不持久化）
  }
}
