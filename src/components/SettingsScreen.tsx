// 设置屏（settings overlay，TopBar 齿轮进入）：音频（主音量/静音/BGM/环境/音效）与文本（速度/自动前进）。
// 只改设置：改动即时生效（store.updateSettings → localStorage + AudioManager）并持久化，没有「保存」按钮。
// 关屏走 closeOverlay（Esc 由 App 的关闭链接管），与画廊/剧情图同构。
import { motion } from "framer-motion";
import { Volume2, VolumeX } from "lucide-react";
import {
  AUTO_ADVANCE_LABELS,
  AUTO_ADVANCE_OPTIONS,
  TEXT_SPEED_MS,
  TEXT_SPEED_OPTIONS,
  type AutoAdvance,
  type TextSpeed,
} from "../lib/settings";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 音量行：滑杆 + 百分比读数（0-100，滑杆步进 0.05） */
function VolumeRow({
  label,
  value,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  testId: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 py-1.5">
      <span className="w-16 flex-none text-[12.5px] tracking-[.2em] text-ink/60">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-[color:var(--accent)]"
      />
      <span
        data-testid={`${testId}-value`}
        className="w-9 flex-none text-right text-[12px] tabular-nums text-ink-hint"
      >
        {Math.round(value * 100)}
      </span>
    </label>
  );
}

/** 档位选择组（文本速度/自动前进共用）：选中项高亮，点击即生效 */
function Segmented({
  options,
  value,
  prefix,
  onSelect,
}: {
  options: { value: string; label: string }[];
  value: string;
  prefix: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-testid={`${prefix}-${o.value}`}
            aria-pressed={on}
            onClick={() => onSelect(o.value)}
            className={`rounded-lg border px-4 py-1.5 text-[13px] tracking-[.1em] transition-colors duration-200 ${
              on
                ? "border-gold/40 bg-gold/15 text-gold"
                : "border-white/10 text-ink/60 hover:border-gold/25 hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 小节标题 */
function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-[13px] tracking-[.35em] text-gold/80">{children}</h3>;
}

export default function SettingsScreen() {
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const closeOverlay = useGameStore((s) => s.closeOverlay);

  return (
    <ScreenShell className="overflow-y-auto bg-bg/70">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        data-testid="settings-screen"
        className="mx-auto w-full max-w-2xl px-6 py-10"
      >
        <header className="flex items-center">
          <h2 className="text-xl tracking-[.6em] [text-indent:.6em]">设 置</h2>
          <button
            type="button"
            data-testid="settings-back"
            onClick={closeOverlay}
            className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
          >
            返回
          </button>
        </header>
        <p className="mt-2 text-[11px] tracking-[.2em] text-ink-hint">改动即时生效并保存在本机</p>

        {/* 音频 */}
        <section className="mt-8 rounded-xl border border-white/10 bg-[rgba(10,12,18,.5)] p-5 backdrop-blur-md">
          <div className="flex items-center">
            <SectionTitle>音 频</SectionTitle>
            <button
              type="button"
              data-testid="settings-muted"
              aria-label="静音"
              aria-pressed={settings.muted}
              onClick={() => updateSettings({ muted: !settings.muted })}
              className={`ml-auto flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] tracking-[.15em] transition-colors ${
                settings.muted
                  ? "border-gold/40 bg-gold/15 text-gold"
                  : "border-white/10 text-ink/60 hover:border-gold/30 hover:text-ink"
              }`}
            >
              {settings.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              {settings.muted ? "已静音" : "静音"}
            </button>
          </div>

          <div className="mt-3 divide-y divide-white/[.06]">
            <VolumeRow
              label="主音量"
              value={settings.master}
              testId="settings-master"
              onChange={(v) => updateSettings({ master: v })}
            />
            <VolumeRow label="曲" value={settings.bgm} testId="settings-bgm" onChange={(v) => updateSettings({ bgm: v })} />
            <VolumeRow
              label="环境"
              value={settings.ambient}
              testId="settings-ambient"
              onChange={(v) => updateSettings({ ambient: v })}
            />
            <VolumeRow label="音效" value={settings.sfx} testId="settings-sfx" onChange={(v) => updateSettings({ sfx: v })} />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed tracking-[.05em] text-ink-hint">
            音频文件由作者放在 presets/&lt;剧本 id&gt;/audio/ 下（命名 曲-名.mp3 / 环境-名.mp3 / 音效-名.wav）；
            剧本没放文件时静默不播，不影响剧情。
          </p>
        </section>

        {/* 文本 */}
        <section className="mt-6 rounded-xl border border-white/10 bg-[rgba(10,12,18,.5)] p-5 backdrop-blur-md">
          <SectionTitle>文 本</SectionTitle>

          <div className="mt-3">
            <p className="mb-2 text-[12px] tracking-[.2em] text-ink-hint">文字速度</p>
            <Segmented
              options={TEXT_SPEED_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={settings.textSpeed}
              prefix="settings-textspeed"
              onSelect={(v) => updateSettings({ textSpeed: v as TextSpeed })}
            />
            <p className="mt-2 text-[11px] tracking-[.05em] text-ink-hint">
              {settings.textSpeed === "instant"
                ? "瞬间：正文直接整段显示（点击对话框补全文的行为保留）"
                : `每字 ${TEXT_SPEED_MS[settings.textSpeed]}ms；点击对话框可立即补完全文`}
            </p>
          </div>

          <div className="mt-5">
            <p className="mb-2 text-[12px] tracking-[.2em] text-ink-hint">自动前进</p>
            <Segmented
              options={AUTO_ADVANCE_OPTIONS.map((v) => ({ value: String(v), label: AUTO_ADVANCE_LABELS[v] }))}
              value={String(settings.autoAdvance)}
              prefix="settings-auto"
              onSelect={(v) => updateSettings({ autoAdvance: Number(v) as AutoAdvance })}
            />
            <p className="mt-2 text-[11px] tracking-[.05em] text-ink-hint">
              正文打完、选项出现前的停顿时长（v1.6 先记录偏好，触发由后续版本接入）
            </p>
          </div>
        </section>
      </motion.div>
    </ScreenShell>
  );
}
