import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cleanForHistory } from "../../lib/parser";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useGameStore } from "../../store/game";

/** 从内存幕名「第 N 幕」里取回快照序号（磁盘去重按它对齐；取不到返回 null） */
function actSeqOf(actName: string): number | null {
  const m = /第\s*(\d+)\s*幕/.exec(actName);
  return m ? Number(m[1]) : null;
}

/** 回想抽屉：右滑入，最新一幕在最上（对齐旧版 #drawer）。标题带上当前章号（顶栏已不再显示章号）。
 * 回溯是非破坏式的：分割线（—— 已回溯到第 N 幕 ——／重演时「—— 第 N 幕已重演 ——」）
 * 之前的幕原样保留、只降不透明度。
 * v1.14 回想接磁盘：内存幕（本会话）在**上**，磁盘回合日志（`logs/NNNN.json`，跨刷新仍在）在**下**、
 * 分页加载——抽屉打开时首翻最近一页，底部「加载更多」按 `nextBefore` 往更早翻，按 `seq` 与已渲染幕去重。
 * 抽屉语义（v1.9）：role=dialog + aria-modal + 标题作名字，焦点进抽屉、Tab 在抽屉里循环、关时归还；
 * Esc 仍归 App 的关闭链（这里刻意不碰键盘的 Esc）。 */
export default function HistoryDrawer() {
  const open = useGameStore((s) => s.drawerOpen);
  const history = useGameStore((s) => s.history);
  const chapterNo = useGameStore((s) => s.chapterNo);
  const worldId = useGameStore((s) => s.worldId);
  const diskHistory = useGameStore((s) => s.diskHistory);
  const loadHistoryPage = useGameStore((s) => s.loadHistoryPage);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, panelRef);

  // 打开时首翻最近一页磁盘记录（只翻一次：loadedOnce 之后不再自动重拉——append-only 的日志靠这个开关
  // 避免每次开关抽屉都打请求）。世界切换后 diskHistory 由 store 清零，这里自然再翻一次。
  useEffect(() => {
    if (open && worldId && !diskHistory.loadedOnce && !diskHistory.loading) void loadHistoryPage();
  }, [open, worldId, diskHistory.loadedOnce, diskHistory.loading, loadHistoryPage]);

  // 倒序条目 + 逐条置灰标记：倒序遍历时先见过分割线 = 该幕在分割线之前 = 已被回溯覆盖（现行时间线之外）
  let seenRollback = false;
  const memoryRows = history
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

  // 磁盘条目：按 seq 与已渲染的内存幕（幕名里的快照序号）去重，条目之间也顺带去重——同一回合不该出现两次。
  // 磁盘记录一律渲染在内存幕**之下**（内存是最新，磁盘往下翻更早）。
  const memorySeqs = new Set<number>();
  for (const h of history) {
    if (h.kind === "act") {
      const n = actSeqOf(h.n);
      if (n !== null) memorySeqs.add(n);
    }
  }
  const seenDisk = new Set<number>(memorySeqs);
  const diskRows = diskHistory.entries
    .filter((e) => {
      if (seenDisk.has(e.seq)) return false;
      seenDisk.add(e.seq);
      return true;
    })
    .map((e) => (
      <div
        key={`disk-${e.seq}`}
        data-testid="history-disk-act"
        className="border-b border-dashed border-white/10 py-3 text-ui leading-[1.9] whitespace-pre-wrap text-ink-body"
      >
        <span className="mb-1 block text-micro tracking-[.2em] text-gold/80">第 {e.seq} 幕 · 硬盘记录</span>
        {cleanForHistory(e.text)}
      </div>
    ));

  const nothing = memoryRows.length === 0 && diskRows.length === 0;
  // 「还在拉磁盘」：加载中，或世界已知但首翻还没落定（避免闪一下空态）
  const diskPending = diskHistory.loading || (worldId !== null && !diskHistory.loadedOnce && !diskHistory.error);
  const canLoadMore = diskHistory.nextBefore !== null;

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
            {nothing ? (
              diskPending ? (
                <p data-testid="history-disk-loading" className="py-5 text-center text-meta text-ink-hint">
                  正在读取硬盘上的回忆…
                </p>
              ) : diskHistory.error ? null : diskHistory.loadedOnce && diskHistory.entries.length === 0 ? (
                <p
                  data-testid="history-empty-disk"
                  className="py-5 text-center text-meta leading-relaxed text-ink-hint"
                >
                  本局还没有内容
                  <br />
                  硬盘上也没有留下记录
                </p>
              ) : (
                <p data-testid="history-empty-memory" className="py-5 text-center text-meta text-ink-hint">
                  本局还没有内容
                </p>
              )
            ) : (
              <>
                {memoryRows}
                {diskRows.length > 0 && (
                  <>
                    {/* 磁盘记录分界：上面是本会话的内存幕，下面才是硬盘上更早的回合 */}
                    <p
                      data-testid="history-disk-divider"
                      className="border-t border-white/[.08] pt-3 pb-1 text-center text-micro tracking-[.25em] text-ink-hint"
                    >
                      更早的回合 · 硬盘记录
                    </p>
                    {diskRows}
                  </>
                )}
                {diskHistory.loading && (
                  <p data-testid="history-disk-loading" className="py-3 text-center text-meta text-ink-hint">
                    读取更多…
                  </p>
                )}
              </>
            )}
            {diskHistory.error && (
              <p data-testid="history-disk-error" className="py-3 text-center text-meta text-[#d98b8b]">
                硬盘记录读取失败：{diskHistory.error}
              </p>
            )}
            {(canLoadMore || diskHistory.error) && !diskHistory.loading && (
              <button
                type="button"
                data-testid="history-load-more"
                onClick={() => void loadHistoryPage()}
                className="mx-auto mt-3 block rounded-lg border border-white/15 px-4 py-1.5 text-meta tracking-[.1em] text-ink-hint transition-colors hover:border-gold/35 hover:text-ink"
              >
                {canLoadMore ? "加载更多" : "重试"}
              </button>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
