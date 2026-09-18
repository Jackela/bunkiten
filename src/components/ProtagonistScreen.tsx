import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { parseCardLines } from "../lib/parser";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 捏人屏：protagonist_card 逐问选 chip，确认后选择开局入口 */
export default function ProtagonistScreen() {
  const selected = useGameStore((s) => s.selected);
  const cardAnswers = useGameStore((s) => s.cardAnswers);
  const toggleCardAnswer = useGameStore((s) => s.toggleCardAnswer);
  const startGame = useGameStore((s) => s.startGame);
  const [quick, setQuick] = useState(false);

  const questions = useMemo(() => parseCardLines(selected?.protagonist_card ?? []), [selected]);
  const allAnswered = questions.every((q) => (cardAnswers[q.shortName] ?? []).length > 0);
  const canStart = quick || allAnswered;

  if (!selected) return null;

  return (
    <ScreenShell className="overflow-y-auto bg-[radial-gradient(120%_90%_at_50%_0%,#131627_0%,#07080c_60%)]">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 py-10">
        <header className="mb-8">
          <div className="text-[11px] tracking-[.2em] text-gold">{selected.genre}</div>
          <h1 className="mt-1.5 text-2xl tracking-[.2em]">{selected.title}</h1>
        </header>

        <button
          type="button"
          data-testid="quick-start"
          onClick={() => setQuick(true)}
          className={`mb-8 inline-flex items-center gap-2 self-start rounded-lg border px-4 py-2 text-[13px] tracking-[.15em] transition-colors ${
            quick
              ? "border-gold/50 bg-gold/15 text-gold"
              : "border-dashed border-white/20 text-ink-hint hover:border-gold/40 hover:text-ink"
          }`}
        >
          <Sparkles size={14} /> 快速开局 · 用剧本预设主角
        </button>

        {quick ? (
          <section className="mb-10 rounded-xl border border-white/10 bg-white/5 p-5 text-sm leading-relaxed text-ink-body">
            将使用剧本 quick_start 预设主角直接开始。
            <button type="button" onClick={() => setQuick(false)} className="ml-2 text-gold underline-offset-4 hover:underline">
              重新捏人
            </button>
          </section>
        ) : (
          <div className="mb-10">
            {questions.map((q) => {
              const sel = cardAnswers[q.shortName] ?? [];
              return (
                <section key={q.shortName} className="mb-6">
                  <h3 className="mb-2.5 text-sm tracking-[.05em]">
                    {q.label}
                    {q.multi && <span className="ml-2 align-middle text-[11px] text-gold/70">可选 2 项</span>}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((opt) => {
                      const on = sel.includes(opt);
                      return (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => toggleCardAnswer(q.shortName, opt, q.multi)}
                          className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                            on
                              ? "border-gold bg-gold/20 text-gold"
                              : "border-white/15 text-ink-body hover:border-gold/40 hover:text-ink"
                          }`}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {!allAnswered && <p className="text-xs text-ink-hint">每项都选好之后才能开演。</p>}
          </div>
        )}

        <footer className="mt-auto flex flex-wrap items-center gap-3 pt-6">
          <button
            type="button"
            disabled={!canStart}
            onClick={() => startGame(quick, true)}
            className="rounded-lg border border-gold/50 bg-gold/15 px-5 py-2.5 text-sm tracking-[.1em] text-gold transition-colors hover:bg-gold/25 disabled:pointer-events-none disabled:opacity-40"
          >
            制作美术并开演
          </button>
          <button
            type="button"
            data-testid="skip-preload"
            disabled={!canStart}
            onClick={() => startGame(quick, false)}
            className="rounded-lg border border-dashed border-white/20 px-5 py-2.5 text-sm tracking-[.1em] text-ink-body transition-colors hover:border-gold/40 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            跳过美术，直接开演
          </button>
        </footer>
      </div>
    </ScreenShell>
  );
}
