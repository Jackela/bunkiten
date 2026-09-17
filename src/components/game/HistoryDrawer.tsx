import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useGameStore } from "../../store/game";

/** 历史抽屉：右滑入，最新一幕在最上（对齐旧版 #drawer）。
 * 回退是非破坏式的：分割线（—— 已回退到快照 #N ——／重掷时「—— 重掷本回合（回到快照 #N）——」）
 * 之前的幕原样保留、只降不透明度。 */
export default function HistoryDrawer() {
  const open = useGameStore((s) => s.drawerOpen);
  const history = useGameStore((s) => s.history);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);

  // 倒序条目 + 逐条置灰标记：倒序遍历时先见过分割线 = 该幕在分割线之前 = 已被回退覆盖（现行时间线之外）
  let seenRollback = false;
  const rows = history
    .slice()
    .reverse()
    .map((h, i) => {
      if (h.kind === "rollback") {
        seenRollback = true;
        return (
          <p
            // 同一快照可能被回退多次：幕名之外再拼序号，保证 key 唯一
            key={`rollback-${h.seq}-${i}`}
            data-testid="history-rollback"
            className="border-y border-white/[.08] py-2 text-center text-[11px] tracking-[.25em] text-ink-hint"
          >
            —— {h.reason === "reroll" ? `重掷本回合（回到快照 #${h.seq}）` : `已回退到快照 #${h.seq}`} ——
          </p>
        );
      }
      const stale = seenRollback;
      return (
        <div
          key={h.n}
          data-testid="history-act"
          className={`border-b border-dashed border-white/10 py-3 text-sm leading-[1.9] whitespace-pre-wrap ${
            stale ? "opacity-50" : ""
          }`}
        >
          <span className="mb-1 block text-[11px] tracking-[.2em] text-gold">{h.n}</span>
          {h.t}
        </div>
      );
    });

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
            {rows.length === 0 ? <p className="py-5 text-center text-[13px] text-ink-hint">还没有历史</p> : rows}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
