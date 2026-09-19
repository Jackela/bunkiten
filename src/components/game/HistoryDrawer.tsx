import { useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useGameStore } from "../../store/game";

/** 回想抽屉：右滑入，最新一幕在最上（对齐旧版 #drawer）。标题带上当前章号（顶栏已不再显示章号）。
 * 回溯是非破坏式的：分割线（—— 已回溯到第 N 幕 ——／重演时「—— 第 N 幕已重演 ——」）
 * 之前的幕原样保留、只降不透明度。
 * 抽屉语义（v1.8）：role=dialog + aria-modal + 标题作名字，焦点进抽屉、Tab 在抽屉里循环、关时归还；
 * Esc 仍归 App 的关闭链（这里刻意不碰键盘的 Esc）。 */
export default function HistoryDrawer() {
  const open = useGameStore((s) => s.drawerOpen);
  const history = useGameStore((s) => s.history);
  const chapterNo = useGameStore((s) => s.chapterNo);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, panelRef);

  // 倒序条目 + 逐条置灰标记：倒序遍历时先见过分割线 = 该幕在分割线之前 = 已被回溯覆盖（现行时间线之外）
  let seenRollback = false;
  const rows = history
    .slice()
    .reverse()
    .map((h, i) => {
      if (h.kind === "rollback") {
        seenRollback = true;
        return (
          <p
            // 同一幕可能被回溯多次：幕名之外再拼序号，保证 key 唯一
            key={`rollback-${h.seq}-${i}`}
            data-testid="history-rollback"
            className="border-y border-white/[.08] py-2 text-center text-meta tracking-[.25em] text-ink-hint"
          >
            —— {h.reason === "reroll" ? `第 ${h.seq} 幕已重演` : `已回溯到第 ${h.seq} 幕`} ——
          </p>
        );
      }
      const stale = seenRollback;
      return (
        <div
          key={h.n}
          data-testid="history-act"
          className={`border-b border-dashed border-white/10 py-3 text-ui leading-[1.9] whitespace-pre-wrap ${
            stale ? "opacity-50" : ""
          }`}
        >
          <span className="mb-1 block text-micro tracking-[.2em] text-gold">{h.n}</span>
          {h.t}
        </div>
      );
    });

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          ref={panelRef}
          initial={{ x: "105%" }}
          animate={{ x: 0 }}
          exit={{ x: "105%" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          role="dialog"
          aria-modal="true"
          // 名字用读得出来的形态：标题在屏上是「回 想 · 第 2 章」（字距靠空格撑），读屏不该逐个念空格
          aria-label={`回想 · 第 ${chapterNo} 章`}
          data-testid="history-panel"
          className="fixed inset-y-0 right-0 z-50 flex w-[min(420px,92vw)] flex-col border-l border-white/10 bg-panel-strong"
        >
          <header className="flex items-center border-b border-white/10 px-4 py-3.5 text-meta tracking-[.2em] text-ink-hint">
            回 想 · 第 {chapterNo} 章
            <button
              type="button"
              onClick={toggleDrawer}
              aria-label="关闭回想"
              className="ml-auto rounded-md p-1 text-ink-hint transition-colors hover:text-ink"
            >
              <X size={16} />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-3.5">
            {rows.length === 0 ? (
              <p className="py-5 text-center text-meta text-ink-hint">还没有可以回想的内容</p>
            ) : (
              rows
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
