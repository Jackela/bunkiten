// 前情提要面板（v1.14，ADR-0027 元命令本地化）：/recap 不再经引擎，提要由 store 在打开时本地合成
// （fetchLogs 最近几回合 + fetchState 的时间地点 + 最新快照 summary），**零引擎回合**。
// 由 store 的 recapOpen 控制显隐（TopBar 命令轨「回顾 → 前情」→ openRecap），closeRecap 关闭；
// Esc 由 App 的关闭链接管（面板开着时它是第一环）。照既有 overlay 范式：role=dialog + aria-modal +
// useFocusTrap。数据三态：加载中 / 出错 / 有内容（当前章 + 时间地点 + 最近的几条一行式回顾）。

import { useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useGameStore } from "../store/game";

/**
 * 前情提要面板：浮在当前屏之上的模态（role=dialog + aria-modal）；开关与数据全走 store
 * （recapOpen/closeRecap 与打开时合成好的 recapData）。这里只渲染三态，不发任何请求。
 */
export default function RecapPanel() {
  const open = useGameStore((s) => s.recapOpen);
  const data = useGameStore((s) => s.recapData);
  const closeRecap = useGameStore((s) => s.closeRecap);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, panelRef);

  // 一行式的时间地点：有哪几项写哪几项，都没有就不画这一行（不提空字段）
  const meta: string[] = [];
  if (data && data.chapterNo !== null) meta.push(`第 ${data.chapterNo} 章`);
  if (data?.time) meta.push(data.time);
  if (data?.scene) meta.push(data.scene);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          onClick={closeRecap}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="前情提要"
            data-testid="recap-panel"
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
            className="relative flex max-h-[80vh] w-[min(600px,94vw)] flex-col gap-4 overflow-y-auto rounded-2xl border border-white/10 bg-panel-strong p-6"
          >
            <button
              type="button"
              data-testid="recap-close"
              aria-label="关闭前情"
              onClick={closeRecap}
              className="absolute top-3 right-3 rounded-md p-1 text-ink-hint transition-colors hover:text-ink"
            >
              <X size={16} />
            </button>

            <header>
              <h2 className="text-title tracking-[.3em] text-ink">前 情</h2>
              <p className="mt-1.5 text-meta leading-relaxed text-ink-hint">把最近发生的事，按顺序再说一遍。</p>
            </header>

            {!data || !data.loaded ? (
              <p data-testid="recap-loading" role="status" className="py-6 text-center text-meta text-ink-hint">
                正在整理前情…
              </p>
            ) : data.error ? (
              <p data-testid="recap-error" className="py-6 text-center text-meta text-[#d98b8b]">
                {data.error}
              </p>
            ) : (
              <>
                {meta.length > 0 && (
                  <p data-testid="recap-meta" className="text-meta tracking-[.15em] text-ink-hint">
                    {meta.join(" · ")}
                  </p>
                )}
                {data.entries.length === 0 ? (
                  <p data-testid="recap-empty" className="py-6 text-center text-meta text-ink-hint">
                    还没有可回顾的内容，故事展开后这里会有。
                  </p>
                ) : (
                  <ol data-testid="recap-entries" className="space-y-2.5">
                    {data.entries.map((e, i) => (
                      <li
                        key={`${e.n ?? "intro"}-${i}`}
                        data-testid="recap-entry"
                        className="flex gap-3 border-b border-dashed border-white/10 pb-2.5 text-ui leading-[1.9] text-ink-body last:border-b-0 last:pb-0"
                      >
                        {e.n != null && (
                          <span className="w-12 flex-none text-meta tracking-[.12em] text-gold">第 {e.n} 幕</span>
                        )}
                        <span className="min-w-0 flex-1">{e.t}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
