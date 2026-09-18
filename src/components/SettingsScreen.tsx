// 设置屏（settings overlay，TopBar 齿轮进入）：音频（主音量/静音/BGM/环境/音效）与文本（速度/自动前进）。
// 只改设置：改动即时生效（store.updateSettings → localStorage + AudioManager）并持久化，没有「保存」按钮。
// 关屏走 closeOverlay（Esc 由 App 的关闭链接管），与画廊/剧情图同构。
// v1.8：换成 ShellPage 壳层页框（宽栏 + 统一表头 + 页脚提示），≥lg 两栏并排（音 频 | 文 本），每块一块 .shell-panel；
// 字号只取 global.css 的 text-* 阶梯档位；静音由「看着像标签的按钮」改成真开关（role="switch" + aria-checked）。
// 文案面向玩家：不出现 presets/ 路径、毫秒读数这类开发者文档口径。
import { motion } from "framer-motion";
import { Volume2, VolumeX } from "lucide-react";
import {
  AUTO_ADVANCE_LABELS,
  AUTO_ADVANCE_OPTIONS,
  TEXT_SPEED_OPTIONS,
  type AutoAdvance,
  type TextSpeed,
} from "../lib/settings";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { ShellPage } from "./ShellPage";

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
      <span className="w-16 flex-none text-ui tracking-[.2em] text-ink-body">{label}</span>
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
        className="w-9 flex-none text-right text-meta tabular-nums text-ink-hint"
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
            className={`rounded-lg border px-4 py-1.5 text-ui tracking-[.1em] transition-colors duration-200 ${
              on
                ? "border-gold/40 bg-gold/15 text-gold"
                : "border-white/10 text-ink-hint hover:border-gold/25 hover:text-ink"
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
  return <h3 className="text-ui tracking-[.35em] text-gold/85">{children}</h3>;
}

export default function SettingsScreen() {
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const closeOverlay = useGameStore((s) => s.closeOverlay);

  return (
    <ScreenShell className="overflow-y-auto shell-backdrop">
      <ShellPage
        eyebrow="本机偏好"
        title="设 置"
        actions={
          <button
            type="button"
            data-testid="settings-back"
            onClick={closeOverlay}
            className="rounded-md border border-white/10 px-3 py-1.5 text-meta tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            返回
          </button>
        }
        footer="改动即时生效并保存在本机"
      >
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          data-testid="settings-screen"
          className="grid gap-8 lg:grid-cols-2"
        >
          {/* 音频 */}
          <section className="shell-panel rounded-2xl p-6">
            <div className="flex items-center">
              <SectionTitle>音 频</SectionTitle>
              {/* 静音开关：真开关语义（role=switch + aria-checked），整块可点；轨道 h-5 w-9、滑块 h-4 w-4 平移 14px 对齐内沿 */}
              <button
                type="button"
                role="switch"
                aria-checked={settings.muted}
                aria-label="静音"
                data-testid="settings-muted"
                onClick={() => updateSettings({ muted: !settings.muted })}
                className="ml-auto -mr-2 flex min-h-7 items-center gap-2.5 rounded-lg py-1 pl-2 pr-2 text-meta tracking-[.15em] text-ink-hint transition-colors hover:bg-white/[.05] hover:text-ink"
              >
                <span className="flex items-center gap-1.5">
                  {settings.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  {settings.muted ? "已静音" : "静音"}
                </span>
                <span
                  className={`flex h-5 w-9 flex-none items-center rounded-full border px-0.5 transition-colors duration-200 ${
                    settings.muted ? "border-gold/45 bg-gold/35" : "border-white/15 bg-white/10"
                  }`}
                >
                  <span
                    className={`h-4 w-4 rounded-full transition-transform duration-200 ${
                      settings.muted ? "translate-x-3.5 bg-gold" : "translate-x-0 bg-ink-faint"
                    }`}
                  />
                </span>
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
            <p className="mt-4 text-meta leading-relaxed text-ink-hint">
              配乐与音效随剧本而来；剧本没有准备的部分会安静地略过，不影响剧情。
            </p>
          </section>

          {/* 文本 */}
          <section className="shell-panel rounded-2xl p-6">
            <SectionTitle>文 本</SectionTitle>

            <div className="mt-4">
              <p className="mb-2 text-ui tracking-[.2em] text-ink-body">文字速度</p>
              <Segmented
                options={TEXT_SPEED_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={settings.textSpeed}
                prefix="settings-textspeed"
                onSelect={(v) => updateSettings({ textSpeed: v as TextSpeed })}
              />
              <p className="mt-2.5 text-meta leading-relaxed text-ink-hint">
                {settings.textSpeed === "instant"
                  ? "瞬间：正文直接整段显示（点击对话框补全文的行为保留）"
                  : "逐字浮现的速度；点击对话框可立即显示全文"}
              </p>
            </div>

            <div className="mt-6">
              <p className="mb-2 text-ui tracking-[.2em] text-ink-body">自动前进</p>
              <Segmented
                options={AUTO_ADVANCE_OPTIONS.map((v) => ({ value: String(v), label: AUTO_ADVANCE_LABELS[v] }))}
                value={String(settings.autoAdvance)}
                prefix="settings-auto"
                onSelect={(v) => updateSettings({ autoAdvance: Number(v) as AutoAdvance })}
              />
              <p className="mt-2.5 text-meta leading-relaxed text-ink-hint">正文读完后，自动继续下一段的等待时长。</p>
            </div>
          </section>
        </motion.div>
      </ShellPage>
    </ScreenShell>
  );
}
