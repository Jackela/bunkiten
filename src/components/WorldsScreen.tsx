import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { fetchWorlds, postWorld, type WorldEntry } from "../lib/acp";
import { getTheme, themeVars } from "../theme";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 列表行进出：与创作屏气泡同款克制位移淡入 */
const ROW = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } } as const;

/** 「更早」阈值（ms）：超过 30 天不再报天数 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 相对时间中文文案（世界线行的「最近游玩」；时钟回拨/时间戳缺失都算「更早」兜底）。
 * @param {number} ms 最近游玩时间（ms）
 * @param {number} [now] 参照时刻（默认 Date.now()，测试可注入）
 * @returns {string} 「刚刚 / N 分钟前 / N 小时前 / N 天前 / 更早」
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "更早";
  const diff = now - ms;
  if (diff <= 0) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  if (diff < STALE_MS) return `${Math.floor(hours / 24)} 天前`;
  return "更早";
}

/**
 * 世界线屏：选卡之后的第二环——继续某条世界线（读档续演）或开一条全新的（去捏人）。
 * 数据自己拉（fetchWorlds/preset 过滤），删除与新建走 POST /api/worlds；屏内不做任何推演。
 */
export default function WorldsScreen() {
  const selected = useGameStore((s) => s.selected);
  const engineBusy = useGameStore((s) => s.engineBusy);
  const toTitle = useGameStore((s) => s.toTitle);
  const beginNewWorld = useGameStore((s) => s.beginNewWorld);
  const resumeWorld = useGameStore((s) => s.resumeWorld);

  const presetId = selected?.id;

  const [worlds, setWorlds] = useState<WorldEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 行内动作（删除/新建）的错误文案：不占满屏，贴着列表展示 */
  const [actionError, setActionError] = useState("");
  /** 重取清单的信号：删除成功 / 点「重试」时自增 */
  const [stamp, setStamp] = useState(0);
  /** 键盘高亮的行下标 */
  const [focus, setFocus] = useState(0);
  /** 正在两段式确认删除的世界 id（null=无确认态，键盘导航让位于确认按钮） */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useMemo(() => worlds ?? [], [worlds]);

  // 挂载与换卡（selected.id 变）时拉清单；删除后由 stamp 触发重取
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    fetchWorlds(presetId, abort.signal)
      .then((r) => {
        setWorlds(r);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [presetId, stamp]);

  // 清单长度变化：高亮下标越界时回到第一行
  useEffect(() => {
    setFocus((i) => (i < list.length ? i : 0));
  }, [list.length]);

  // 键盘：↑↓ 移动高亮，Enter 继续高亮的世界线；确认态下全部让位给按钮
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return; // 中文输入法组字中的按键不算导航
      if (confirmId) return; // 确认删除中：不拦截
      const el = e.target instanceof HTMLElement ? e.target : null;
      // 焦点在按钮/输入框上时不做屏级导航，避免 Enter 被激活两次
      if (el && (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocus((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocus((i) => Math.min(list.length - 1, i + 1));
      } else if (e.key === "Enter") {
        const entry = list[focus];
        if (entry && entry.exists && !engineBusy) resumeWorld(entry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmId, engineBusy, focus, list, resumeWorld]);

  /** 继续：目录缺失或引擎忙时不可用（resumeWorld 会立刻发续演指令） */
  const continueWorld = (entry: WorldEntry) => {
    if (!entry.exists || engineBusy) return;
    resumeWorld(entry);
  };

  /** 新建世界线：id 由 server 分配，成功才带着 id 去捏人；失败留在本屏展示错误 */
  const createWorld = () => {
    if (!presetId || creating) return;
    setCreating(true);
    setActionError("");
    postWorld({ action: "create", preset: presetId })
      .then((r) => {
        if (!r.ok || !r.worldId) {
          setActionError(`新建世界线失败：${r.error ?? "未知错误"}`);
          setCreating(false);
          return;
        }
        beginNewWorld(r.worldId);
      })
      .catch((e: unknown) => {
        setActionError(`新建世界线失败：${String(e)}`);
        setCreating(false);
      });
  };

  /** 删除（第二段确认触发）：成功即重取清单，失败在列表上方行内报错 */
  const removeWorld = (entry: WorldEntry) => {
    if (deleting) return;
    setDeleting(entry.worldId);
    setActionError("");
    postWorld({ action: "delete", worldId: entry.worldId })
      .then((r) => {
        if (!r.ok) {
          setActionError(`删除失败：${r.error ?? "未知错误"}`);
          setDeleting(null);
          return;
        }
        setConfirmId(null);
        setDeleting(null);
        setStamp((v) => v + 1);
      })
      .catch((e: unknown) => {
        setActionError(`删除失败：${String(e)}`);
        setDeleting(null);
      });
  };

  return (
    <ScreenShell className="overflow-y-auto bg-bg/70" style={themeVars(getTheme(selected))}>
      <div data-testid="worlds-screen" className="mx-auto w-full max-w-3xl px-6 py-10">
        <header className="flex items-start gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-2xl tracking-[.18em]">{selected?.title ?? "世 界 线"}</h2>
            {selected && (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-gold/30 bg-gold/10 px-2.5 py-0.5 text-[11px] tracking-[.2em] text-gold">
                    {selected.genre}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[.03] px-2.5 py-0.5 text-[11px] tracking-[.2em] text-ink/45">
                    {selected.rating}
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink/55">{selected.tagline}</p>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={toTitle}
            className="ml-auto flex-none rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-[color:var(--accent)]"
          >
            返回
          </button>
        </header>

        {/* 工具栏：主行动「新世界线」（空态下也用它） */}
        <div className="mt-7 flex items-center gap-3">
          <h3 className="text-[13px] tracking-[.35em] text-gold/80">世 界 线</h3>
          <button
            type="button"
            data-testid="worlds-new"
            disabled={!presetId || creating}
            onClick={createWorld}
            className="ml-auto rounded-lg border border-gold/35 bg-gold/15 px-5 py-2 text-[13.5px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink/35"
          >
            {creating ? "创建中…" : "新世界线"}
          </button>
        </div>

        {/* 行内动作错误 */}
        {actionError && <p className="mt-3 text-sm text-red-400">{actionError}</p>}

        {/* 加载 / 失败态 */}
        {loading && worlds === null && !error && (
          <p className="mt-6 animate-pulse text-sm text-ink/50">清点世界线…</p>
        )}
        {error && (
          <div
            data-testid="worlds-error"
            className="mt-6 flex items-center gap-3 rounded-xl border border-red-400/25 bg-[rgba(10,12,18,.5)] px-4 py-3 backdrop-blur-md"
          >
            <p className="text-sm text-red-400">世界线加载失败：{error}</p>
            <button
              type="button"
              data-testid="worlds-retry"
              onClick={() => setStamp((v) => v + 1)}
              className="ml-auto flex-none rounded-md border border-gold/35 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-gold transition-colors hover:bg-gold/20"
            >
              重试
            </button>
          </div>
        )}

        {/* 空态 */}
        {!error && worlds !== null && list.length === 0 && (
          <div
            data-testid="worlds-empty"
            className="mt-6 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/15 bg-[rgba(10,12,18,.5)] px-6 py-10 backdrop-blur-md"
          >
            <p className="text-[14px] tracking-[.12em] text-ink/60">还没有世界线——开始新的吧</p>
            <p className="text-[11.5px] tracking-[.2em] text-ink/35">新世界线从捏人开始</p>
          </div>
        )}

        {/* 世界列表 */}
        <div className="mt-4 space-y-2.5">
          {list.map((entry, i) => {
            const missing = !entry.exists;
            const confirming = confirmId === entry.worldId;
            const busy = deleting === entry.worldId;
            return (
              <motion.div
                key={entry.worldId}
                {...ROW}
                transition={{ duration: 0.3, ease: "easeOut" }}
                data-testid={`world-row-${entry.worldId}`}
                onMouseEnter={() => setFocus(i)}
                onClick={() => setFocus(i)}
                className={`flex items-center gap-3 rounded-xl border bg-[rgba(10,12,18,.5)] px-4 py-3 backdrop-blur-md transition-colors ${
                  i === focus ? "border-gold/40" : "border-white/10 hover:border-gold/25"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-[15px] ${missing ? "text-ink/40" : "text-ink"}`}>
                      {entry.note || entry.worldId}
                    </span>
                    {entry.forkedFrom && (
                      <span className="flex-none rounded-sm border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-[10px] tracking-[.12em] text-ink/50">
                        分叉自 {entry.forkedFrom.worldId} @ {entry.forkedFrom.nodeId}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] tracking-[.12em] text-ink/40">
                    第 {entry.chapterNo} 章 · {relativeTime(entry.lastPlayed)}
                    {missing && <span className="ml-2 text-red-400/90">目录缺失</span>}
                  </p>
                </div>

                <div className="flex flex-none items-center gap-2">
                  <button
                    type="button"
                    data-testid={`world-continue-${entry.worldId}`}
                    disabled={missing || engineBusy}
                    title={missing ? "目录缺失" : engineBusy ? "引擎忙" : undefined}
                    onClick={() => continueWorld(entry)}
                    className={`rounded-lg border px-3.5 py-1.5 text-[12.5px] tracking-[.1em] transition-colors ${
                      missing || engineBusy
                        ? "cursor-not-allowed border-white/10 text-ink/35"
                        : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                    }`}
                  >
                    {engineBusy ? "引擎忙" : "继续"}
                  </button>

                  {/* 两段式确认：首点变「确认删除/取消」，二点才发删除 */}
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        data-testid={`world-confirm-${entry.worldId}`}
                        disabled={busy}
                        onClick={() => removeWorld(entry)}
                        className="rounded-lg border border-red-400/40 bg-red-500/15 px-3.5 py-1.5 text-[12.5px] tracking-[.1em] text-red-300 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink/35"
                      >
                        {busy ? "删除中…" : "确认删除"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmId(null)}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink/55 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:text-ink/30"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid={`world-delete-${entry.worldId}`}
                      onClick={() => {
                        setActionError("");
                        setConfirmId(entry.worldId);
                      }}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink/55 transition-colors hover:border-red-400/40 hover:text-red-300"
                    >
                      删除
                    </button>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>

        <p className="mt-8 text-center text-[12px] tracking-[.35em] text-ink/40">↑ ↓ 选择 · Enter 继续</p>
      </div>
    </ScreenShell>
  );
}
