// 设置屏（settings overlay，TopBar 齿轮/标题屏角落/boot 屏「填自备密钥」进入）：两层信息架构（v1.12）。
// 第一层（默认可见，玩家偏好）：音 频（主音量 + 静音）+ 文 本（速度 + 自动前进），≥lg 两栏并排。
// 第二层（默认收起）：「引擎与密钥」整节收进披露区——引擎选择、登录、自备服务与密钥是**技术配置**，
//    与玩家偏好不是一个频次也不该同权重（原来两者平铺在同一层，玩家找音量得先扫过一堆服务商下拉）。
//    默认展开条件：从启动屏未登录态点「填自备密钥 / 打开设置」进来（screenReturn === "boot"）——那一趟
//    正是冲着它来的；其余入口默认收起，玩家手动切过之后听玩家的（null = 还没手动切过，跟默认走）。
// 只改设置：改动即时生效（store.updateSettings → localStorage + AudioManager）并持久化，没有「保存」按钮。
// 关屏走 closeOverlay（Esc 由 App 的关闭链接管），与画廊/剧情图同构。
// v1.8：换成 ShellPage 壳层页框（宽栏 + 统一表头 + 页脚提示），≥lg 两栏并排（音 频 | 文 本），每块一块 .shell-panel；
// 字号只取 global.css 的 text-* 阶梯档位；静音由「看着像标签的按钮」改成真开关（role="switch" + aria-checked）。
// v1.12：三条通道滑杆（曲/环境/音效）收进「细分音量」披露——顶层只留玩家最常动的主音量与静音开关，
//    但滑杆 testid 与读数原样保留（只是默认不渲染：测试与玩家的取值口径都没变，改的只是显隐）。
// 文案面向玩家：不出现 presets/ 路径、毫秒读数这类开发者文档口径。
import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Volume2, VolumeX } from "lucide-react";
import {
  AUTO_ADVANCE_LABELS,
  AUTO_ADVANCE_OPTIONS,
  TEXT_SPEED_OPTIONS,
  type AutoAdvance,
  type TextSpeed,
} from "../lib/settings";
import { useGameStore } from "../store/game";
import EngineKeysSection from "./EngineKeysSection";
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
      <span data-testid={`${testId}-value`} className="w-9 flex-none text-right text-meta tabular-nums text-ink-hint">
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

/**
 * 披露区（disclosure，v1.12）：一个按钮头（标题 + 一句玩家话 + 右侧雪佛龙）+ 展开后的内容。
 * 为什么按钮头自己吃全部文案而不是另挂一行标题：披露头的可读名就是它的可见文案，
 * `aria-expanded` 跟着开合翻——读屏听到的是「引擎与密钥，换用不同的故事引擎…，已折叠」这样一句完整的话。
 * 内容用 id + aria-controls 关联（展开时才渲染，收起时不在 DOM 里，屏幕阅读器也不会读到）。
 */
function Disclosure({
  title,
  hint,
  testId,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  testId: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const panelId = `${testId}-panel`;
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="shell-panel flex w-full items-start gap-3 rounded-2xl px-6 py-4 text-left transition-colors hover:border-gold/25"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-ui tracking-[.35em] text-gold/85">{title}</span>
          <span className="mt-1 block text-meta leading-relaxed text-ink-hint">{hint}</span>
        </span>
        <ChevronDown
          size={15}
          aria-hidden
          className={`mt-0.5 flex-none text-ink-hint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div id={panelId} data-testid={panelId} className="mt-4">
          {children}
        </div>
      )}
    </>
  );
}

/**
 * 设置屏（overlay）：两层披露——第一层是音量与文本节奏（改完即生效，存 localStorage），
 * 第二层默认收起：细分音量（曲/环境/音效）与「引擎与密钥」（v1.10 的引擎选择/登录/自备 key）。
 * 从启动屏未登录态进来时（`screenReturn === "boot"`）第二层自动展开——那一趟正是冲着它来的。
 * 设置是本机偏好，**不进世界线**（见 lib/settings.ts 的文件头）。
 */
export default function SettingsScreen() {
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const closeOverlay = useGameStore((s) => s.closeOverlay);
  // 「引擎与密钥」的默认开合：从启动屏未登录态进来（screenReturn === "boot"）时默认展开——那一趟正是
  // 冲着它来的；其余入口默认收起。手动切过之后听玩家的（null = 还没手动切过，跟默认走）
  const fromBoot = useGameStore((s) => s.screenReturn) === "boot";
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null);
  const advanced = advancedOpen ?? fromBoot;
  // 细分音量（曲/环境/音效）：默认收起——顶层只留玩家最常动的主音量与静音
  const [channelsOpen, setChannelsOpen] = useState(false);

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
          <section data-testid="settings-audio" className="shell-panel rounded-2xl p-6">
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
              {/* 细分音量：三条通道滑杆（曲/环境/音效）默认收起——顶层只留玩家最常动的「主音量 + 静音」，
                  调音台那三格留给真的想细调的人（testid 与读数原样保留，只是默认不渲染） */}
              <div className="py-1.5">
                <button
                  type="button"
                  data-testid="settings-channels-toggle"
                  aria-expanded={channelsOpen}
                  aria-controls="settings-channels-panel"
                  onClick={() => setChannelsOpen((v) => !v)}
                  className="flex items-center gap-2 text-meta tracking-[.2em] text-ink-hint transition-colors hover:text-ink"
                >
                  细分音量
                  <ChevronDown
                    size={13}
                    aria-hidden
                    className={`transition-transform duration-200 ${channelsOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {channelsOpen && (
                  <div
                    id="settings-channels-panel"
                    data-testid="settings-channels-panel"
                    className="mt-1 divide-y divide-white/[.06]"
                  >
                    <VolumeRow
                      label="曲"
                      value={settings.bgm}
                      testId="settings-bgm"
                      onChange={(v) => updateSettings({ bgm: v })}
                    />
                    <VolumeRow
                      label="环境"
                      value={settings.ambient}
                      testId="settings-ambient"
                      onChange={(v) => updateSettings({ ambient: v })}
                    />
                    <VolumeRow
                      label="音效"
                      value={settings.sfx}
                      testId="settings-sfx"
                      onChange={(v) => updateSettings({ sfx: v })}
                    />
                  </div>
                )}
              </div>
            </div>
            <p className="mt-4 text-meta leading-relaxed text-ink-hint">
              配乐与音效随剧本而来；剧本没有准备的部分会安静地略过，不影响剧情。
            </p>
          </section>

          {/* 文本 */}
          <section data-testid="settings-text" className="shell-panel rounded-2xl p-6">
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

          {/* 引擎与密钥（v1.10）：自备的对话服务与出图服务——两份表单 + 保存提示与重启按钮。
              v1.12 收进披露区（占满宽）：技术配置不该与玩家偏好同权重（见文件头）。 */}
          <section className="lg:col-span-2">
            <Disclosure
              title="引擎与密钥"
              hint="换用不同的故事引擎、登录账号，或填自己的服务与密钥。不配置也能玩。"
              testId="settings-advanced-toggle"
              open={advanced}
              onToggle={() => setAdvancedOpen(!advanced)}
            >
              <EngineKeysSection showTitle={false} />
            </Disclosure>
          </section>
        </motion.div>
      </ShellPage>
    </ScreenShell>
  );
}
