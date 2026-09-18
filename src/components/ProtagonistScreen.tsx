import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { parseCardLines } from "../lib/parser";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { ShellPage } from "./ShellPage";

/**
 * 右栏摘要里一问的作答 chip 组：已有作答 = 实心金 chip；未作答 = 虚线「待定」占位。
 * 两种态共用同一行位（摘要卡逐问行高稳定，填卡时不会整块跳动）。
 */
function AnswerChips({ values }: { values: string[] }) {
  if (values.length === 0) {
    return (
      <span className="rounded-full border border-dashed border-white/20 px-2.5 py-0.5 text-meta text-ink-hint">待定</span>
    );
  }
  return (
    <>
      {values.map((v) => (
        <span key={v} className="rounded-full border border-gold/30 bg-gold/10 px-2.5 py-0.5 text-meta text-gold">
          {v}
        </span>
      ))}
    </>
  );
}

/**
 * 捏人屏：protagonist_card 逐问选 chip，确认后选择开局入口。
 * 版式（v1.8）：ShellPage 宽栏 + ≥xl 右栏——右栏 = 「主角卡」活体摘要（逐问作答 chip，未答「待定」）
 * 与两个开局入口（右栏即动作归宿；<xl 时随 ShellPage 顺序落到问题之后）；正文列只放
 * 「快速开局」开关与逐问 chip 区，收在 46rem 内不铺满宽栏。字号一律取 global.css 的字号阶梯档位。
 */
export default function ProtagonistScreen() {
  const selected = useGameStore((s) => s.selected);
  const cardAnswers = useGameStore((s) => s.cardAnswers);
  const toggleCardAnswer = useGameStore((s) => s.toggleCardAnswer);
  const startGame = useGameStore((s) => s.startGame);
  const toWorlds = useGameStore((s) => s.toWorlds);
  const [quick, setQuick] = useState(false);

  const questions = useMemo(() => parseCardLines(selected?.protagonist_card ?? []), [selected]);
  const allAnswered = questions.every((q) => (cardAnswers[q.shortName] ?? []).length > 0);
  const filledCount = questions.filter((q) => (cardAnswers[q.shortName] ?? []).length > 0).length;
  const canStart = quick || allAnswered;

  if (!selected) return null;

  /** 右栏：主角卡活体摘要 + 开局入口（canStart 与正文列同源，快速开局下同样解锁） */
  const aside = (
    <div data-testid="protagonist-card-summary" className="shell-panel rounded-2xl p-5 xl:sticky xl:top-8">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-ui tracking-[.2em] text-gold/85">主 角 卡</h2>
        {questions.length > 0 && (
          <span className="ml-auto text-meta tracking-[.1em] text-ink-hint">
            已填 {filledCount} / {questions.length}
          </span>
        )}
      </div>

      {questions.length === 0 ? (
        <p className="mt-3 text-meta leading-relaxed text-ink-hint">剧本未预设问题，直接开演即可。</p>
      ) : (
        <dl className="mt-4 space-y-3.5">
          {questions.map((q) => {
            const sel = cardAnswers[q.shortName] ?? [];
            return (
              <div key={q.shortName} data-testid={`protagonist-summary-${q.shortName}`}>
                <dt className="text-meta text-ink-hint">{q.label}</dt>
                <dd className="mt-1.5 flex flex-wrap gap-1.5">
                  <AnswerChips values={sel} />
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      <div className="mt-5 flex flex-col gap-2.5 border-t border-white/10 pt-5">
        <button
          type="button"
          data-testid="protagonist-start"
          disabled={!canStart}
          onClick={() => startGame(quick, true)}
          className="rounded-lg border border-gold/50 bg-gold/15 px-5 py-2.5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/25 disabled:pointer-events-none disabled:opacity-40"
        >
          制作美术并开演
        </button>
        <button
          type="button"
          data-testid="skip-preload"
          disabled={!canStart}
          onClick={() => startGame(quick, false)}
          className="rounded-lg border border-dashed border-white/20 px-5 py-2.5 text-ui tracking-[.1em] text-ink-body transition-colors hover:border-gold/40 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          跳过美术，直接开演
        </button>
      </div>
    </div>
  );

  return (
    <ScreenShell className="overflow-y-auto shell-backdrop">
      <div data-testid="protagonist-screen" className="min-h-full">
        <ShellPage
          eyebrow={selected.genre}
          title={selected.title}
          actions={
            <button
              type="button"
              data-testid="protagonist-back"
              aria-label="返回世界线"
              onClick={toWorlds}
              className="rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-[color:var(--accent)]"
            >
              返回
            </button>
          }
          aside={aside}
          footer="Esc 返回世界线"
        >
          <div className="max-w-[46rem]">
            <button
              type="button"
              data-testid="quick-start"
              onClick={() => setQuick(true)}
              className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-ui tracking-[.15em] transition-colors ${
                quick
                  ? "border-gold/50 bg-gold/15 text-gold"
                  : "border-dashed border-white/20 text-ink-hint hover:border-gold/40 hover:text-ink"
              }`}
            >
              <Sparkles size={16} /> 快速开局 · 用剧本预设的主角
            </button>

            {quick ? (
              <section
                data-testid="quick-start-notice"
                className="mt-6 rounded-xl border border-white/10 bg-white/5 p-5 text-body leading-relaxed text-ink-body"
              >
                将直接采用剧本预设的主角开始。
                <button
                  type="button"
                  data-testid="protagonist-regenerate"
                  onClick={() => setQuick(false)}
                  className="ml-2 text-gold underline-offset-4 hover:underline"
                >
                  重新捏人
                </button>
              </section>
            ) : (
              <div className="mt-7">
                {questions.map((q) => {
                  const sel = cardAnswers[q.shortName] ?? [];
                  return (
                    <section key={q.shortName} data-testid={`protagonist-question-${q.shortName}`} className="mb-7">
                      <h3 className="mb-2.5 text-body tracking-[.05em]">
                        {q.label}
                        {q.multi && (
                          <span className="ml-2 align-middle text-micro tracking-[.08em] text-gold/75">可选 2 项</span>
                        )}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {q.options.map((opt) => {
                          const on = sel.includes(opt);
                          return (
                            <button
                              key={opt}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleCardAnswer(q.shortName, opt, q.multi)}
                              className={`rounded-full border px-4 py-2 text-body transition-colors ${
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
                {!allAnswered && <p className="text-meta text-ink-hint">每项都选好之后才能开演。</p>}
              </div>
            )}
          </div>
        </ShellPage>
      </div>
    </ScreenShell>
  );
}
