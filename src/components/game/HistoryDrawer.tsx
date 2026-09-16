import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useGameStore } from "../../store/game";

/** 历史抽屉：右滑入，最新一幕在最上（对齐旧版 #drawer） */
export default function HistoryDrawer() {
  const open = useGameStore((s) => s.drawerOpen);
  const history = useGameStore((s) => s.history);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: "105%" }}
          animate={{ x: 0 }}
          exit={{ x: "105%" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(420px,92vw)] flex-col border-l border-white/10 bg-[rgba(9,11,16,.96)]"
        >
          <header className="flex items-center border-b border-white/10 px-4 py-3.5 text-[13px] tracking-[.2em] text-ink/60">
            回 合 记 录
            <button
              type="button"
              onClick={toggleDrawer}
              className="ml-auto rounded-md p-1 text-ink/60 transition-colors hover:text-ink"
            >
              <X size={16} />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-3.5">
            {history.length === 0 ? (
              <p className="py-5 text-center text-[13px] text-ink/50">还没有历史</p>
            ) : (
              history
                .slice()
                .reverse()
                .map((h) => (
                  <div key={h.n} className="border-b border-dashed border-white/10 py-3 text-sm leading-[1.9] whitespace-pre-wrap">
                    <span className="mb-1 block text-[11px] tracking-[.2em] text-gold">{h.n}</span>
                    {h.t}
                  </div>
                ))
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
