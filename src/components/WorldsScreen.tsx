import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion } from "framer-motion";
import { fetchWorlds, postWorld, worldExportUrl, type WorldEntry } from "../lib/acp";
import { getTheme, themeVars } from "../theme";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 列表行进出：与创作屏气泡同款克制位移淡入 */
const ROW = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } } as const;

/** 「更早」阈值（ms）：超过 30 天不再报天数 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** 显示名/备注的字数上限（与 server POST /api/worlds update 校验一致，超了服务端会拒） */
export const LABEL_MAX = 60;
export const NOTE_MAX = 200;

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
 * 行的显示名（纯函数，供单测）：v1.6 的显示名 label 优先，其次沿用既有备注 note
 * （分叉世界自动写「分叉自 <世界> @ <节点>」，玩家一眼看出血缘），最后回退世界 id。
 * @param {WorldEntry} w 世界线条目
 * @returns {string} 行主行文案
 */
export function worldDisplayName(w: WorldEntry): string {
  return w.label?.trim() || w.note?.trim() || w.worldId;
}

/**
 * 世界线屏：选卡之后的第二环——继续某条世界线（读档续演）或开一条全新的（去捏人）。
 * 数据自己拉（fetchWorlds/preset 过滤），删除/新建/改名/导入走 POST /api/worlds；屏内不做任何推演。
 * v1.6：行内改名（label/note，空串=清除）、单条导出（浏览器下载）、打包导入（含成功/失败提示位），
 * 列表补 listbox/option 语义与 roving tabIndex，行内按钮带含世界名的 aria-label。
 */
export default function WorldsScreen() {
  const selected = useGameStore((s) => s.selected);
  const engineBusy = useGameStore((s) => s.engineBusy);
  const worldNotice = useGameStore((s) => s.worldNotice);
  const worldBusy = useGameStore((s) => s.worldBusy);
  const clearWorldNotice = useGameStore((s) => s.clearWorldNotice);
  const updateWorld = useGameStore((s) => s.updateWorld);
  const importWorldText = useGameStore((s) => s.importWorldText);
  const toTitle = useGameStore((s) => s.toTitle);
  const beginNewWorld = useGameStore((s) => s.beginNewWorld);
  const resumeWorld = useGameStore((s) => s.resumeWorld);
  // 回退后的会话内标记：对应世界行内亮「待重同步」（该世界档已回退、引擎等一次续玩指令重读档）
  const pendingResync = useGameStore((s) => s.pendingResync);

  const presetId = selected?.id;

  const [worlds, setWorlds] = useState<WorldEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 行内动作（删除/新建/导入文件读取）的错误文案：不占满屏，贴着列表展示 */
  const [actionError, setActionError] = useState("");
  /** 重取清单的信号：删除/改名/导入成功、点「重试」时自增 */
  const [stamp, setStamp] = useState(0);
  /** 键盘高亮的行下标 */
  const [focus, setFocus] = useState(0);
  /** 正在两段式确认删除的世界 id（null=无确认态，键盘导航让位于确认按钮） */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** 正在改名的世界 id（行内编辑器；null=无编辑器，键盘导航让位给输入框） */
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editNote, setEditNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  /** 行元素引用：↑↓ 把 DOM 焦点一起搬到光标行（roving tabIndex 的完整语义，不是只换个描边） */
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /** 隐藏 file input（导入入口按钮点它） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 打开编辑器时把光标送进「显示名」输入框 */
  const labelRef = useRef<HTMLInputElement | null>(null);

  const list = useMemo(() => worlds ?? [], [worlds]);

  // 挂载与换卡（selected.id 变）时拉清单；删除/改名/导入后由 stamp 触发重取
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

  // 进屏/换卡时清掉上一轮的提示条（否则「已导入世界线 x」会在下次进屏复读）
  useEffect(() => {
    clearWorldNotice();
  }, [presetId, clearWorldNotice]);

  // 清单长度变化：高亮下标越界时回到第一行
  useEffect(() => {
    setFocus((i) => (i < list.length ? i : 0));
  }, [list.length]);

  // 打开编辑器：把焦点送进显示名输入框（也方便键盘用户直接改）
  useEffect(() => {
    if (editId) labelRef.current?.focus();
  }, [editId]);

  // 键盘：↑↓ 移动高亮，Enter 继续高亮的世界线；确认态/编辑态下全部让位给按钮与输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return; // 中文输入法组字中的按键不算导航
      if (confirmId || editId) return; // 确认删除/行内改名中：不拦截
      const el = e.target instanceof HTMLElement ? e.target : null;
      // 焦点在按钮/输入框上时不做屏级导航，避免 Enter 被激活两次
      if (el && (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(Math.max(focus + (e.key === "ArrowUp" ? -1 : 1), 0), Math.max(list.length - 1, 0));
        setFocus(next);
        const id = list[next]?.worldId;
        if (id) rowRefs.current.get(id)?.focus(); // 焦点跟着光标走（焦点回到行上时 onFocus 再确认一次同一行）
      } else if (e.key === "Enter") {
        const entry = list[focus];
        if (entry && entry.exists && !engineBusy) resumeWorld(entry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmId, editId, engineBusy, focus, list, resumeWorld]);

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

  /** 打开行内改名编辑器：字段初值取服务端现值（缺省空串=未设置），保存时原样回传（空串=清除） */
  const openEdit = (entry: WorldEntry) => {
    setActionError("");
    clearWorldNotice();
    setEditLabel(entry.label ?? "");
    setEditNote(entry.note ?? "");
    setEditId(entry.worldId);
  };

  /** 保存改名：成功后重取清单（回显以服务端落定的值为准），失败留在编辑态由提示位说明 */
  const saveEdit = (entry: WorldEntry) => {
    if (saving) return;
    setSaving(true);
    updateWorld({ worldId: entry.worldId, label: editLabel.trim(), note: editNote.trim() })
      .then((r) => {
        setSaving(false);
        if (!r.ok) return; // 失败不关编辑器：玩家改的内容还在
        setEditId(null);
        setStamp((v) => v + 1);
      })
      .catch(() => setSaving(false)); // updateWorld 内部已兜异常，这里只是双保险
  };

  /** 编辑器键盘：Enter 保存、Esc 取消；中文输入法组字中的 Enter 不算保存 */
  const onEditKey = (e: ReactKeyboardEvent<HTMLInputElement>, entry: WorldEntry) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      saveEdit(entry);
    } else if (e.key === "Escape") {
      // 就地收尾，别冒到 App 的 Esc 关闭链（那一下会直接回标题屏）
      e.preventDefault();
      e.stopPropagation();
      setEditId(null);
    }
  };

  /** 导入：读文件原文 → store 校验+POST；成功重取清单，失败由提示位/行内错误说明 */
  const onImportPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许连续导入同一个文件（不清值浏览器不会再触发 change）
    if (!file || importing) return;
    setActionError("");
    clearWorldNotice();
    setImporting(true);
    try {
      const text = await file.text();
      const r = await importWorldText(text);
      if (r.ok) setStamp((v) => v + 1); // 导入成功：重取清单，新世界线立刻可见
    } catch (err) {
      setActionError(`导入失败：${String(err)}`);
    } finally {
      setImporting(false);
    }
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
                  <span className="rounded-full border border-white/10 bg-white/[.03] px-2.5 py-0.5 text-[11px] tracking-[.2em] text-ink-hint">
                    {selected.rating}
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-body">{selected.tagline}</p>
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

        {/* 工具栏：导入（收 .world.json）与主行动「新世界线」（空态下也用它） */}
        <div className="mt-7 flex items-center gap-3">
          <h3 className="text-[13px] tracking-[.35em] text-gold/80">世 界 线</h3>
          <button
            type="button"
            data-testid="worlds-import"
            disabled={importing || worldBusy}
            onClick={() => fileRef.current?.click()}
            className="ml-auto rounded-lg border border-white/10 px-4 py-2 text-[13px] tracking-[.1em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
          >
            {importing ? "导入中…" : "导入"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            data-testid="worlds-import-input"
            className="hidden"
            onChange={onImportPick}
          />
          <button
            type="button"
            data-testid="worlds-new"
            disabled={!presetId || creating}
            onClick={createWorld}
            className="rounded-lg border border-gold/35 bg-gold/15 px-5 py-2 text-[13.5px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
          >
            {creating ? "创建中…" : "新世界线"}
          </button>
        </div>

        {/* 提示位：导入/改名的成功与失败（删除/新建仍在下面的行内错误位） */}
        {worldNotice && (
          <p
            data-testid="worlds-notice"
            data-kind={worldNotice.kind}
            className={`mt-3 rounded-xl border px-4 py-2.5 text-[13px] leading-relaxed backdrop-blur-md ${
              worldNotice.kind === "error"
                ? "border-red-400/25 bg-[rgba(10,12,18,.5)] text-red-400"
                : "border-gold/25 bg-gold/10 text-gold/90"
            }`}
          >
            {worldNotice.text}
          </p>
        )}

        {/* 行内动作错误 */}
        {actionError && <p className="mt-3 text-sm text-red-400">{actionError}</p>}

        {/* 加载 / 失败态 */}
        {loading && worlds === null && !error && (
          <p className="mt-6 animate-pulse text-sm text-ink-hint">清点世界线…</p>
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
            <p className="text-[11.5px] tracking-[.2em] text-ink-hint">新世界线从捏人开始</p>
          </div>
        )}

        {/* 世界列表：listbox + option，光标行独占 tabIndex 0（roving tabIndex） */}
        <div role="listbox" aria-label="世界线" className="mt-4 space-y-2.5">
          {list.map((entry, i) => {
            const missing = !entry.exists;
            const confirming = confirmId === entry.worldId;
            const busy = deleting === entry.worldId;
            const editing = editId === entry.worldId;
            const name = worldDisplayName(entry);
            return (
              <motion.div
                key={entry.worldId}
                {...ROW}
                transition={{ duration: 0.3, ease: "easeOut" }}
                role="option"
                aria-selected={i === focus}
                tabIndex={i === focus ? 0 : -1}
                ref={(el) => {
                  // 取消挂载/换行时清掉引用，别把脱管元素留在 Map 里
                  if (el) rowRefs.current.set(entry.worldId, el);
                  else rowRefs.current.delete(entry.worldId);
                }}
                data-testid={`world-row-${entry.worldId}`}
                onMouseEnter={() => setFocus(i)}
                onFocus={() => setFocus(i)}
                onClick={() => setFocus(i)}
                className={`rounded-xl border bg-[rgba(10,12,18,.5)] px-4 py-3 backdrop-blur-md transition-colors ${
                  i === focus ? "border-gold/40" : "border-white/10 hover:border-gold/25"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-[15px] ${missing ? "text-ink-hint" : "text-ink"}`}>{name}</span>
                      {entry.forkedFrom && (
                        <span className="flex-none rounded-sm border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-[10px] tracking-[.12em] text-ink-hint">
                          分叉自 {entry.forkedFrom.worldId} @ {entry.forkedFrom.nodeId}
                        </span>
                      )}
                      {pendingResync?.worldId === entry.worldId && (
                        <span
                          data-testid={`world-resync-${entry.worldId}`}
                          className="flex-none rounded-sm border border-gold/40 px-1.5 py-0.5 text-[10px] tracking-[.12em] text-gold/90"
                        >
                          待重同步
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11.5px] tracking-[.12em] text-ink-hint">
                      第 {entry.chapterNo} 章 · {relativeTime(entry.lastPlayed)}
                      {missing && <span className="ml-2 text-red-400/90">目录缺失</span>}
                    </p>
                    {/* 显示名与备注都有时，备注降为次行（分叉说明这类信息不该被显示名吃掉） */}
                    {entry.label?.trim() && entry.note?.trim() && (
                      <p data-testid={`world-note-${entry.worldId}`} className="mt-1 truncate text-[11.5px] text-ink-hint">
                        {entry.note}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-none items-center gap-2">
                    <button
                      type="button"
                      data-testid={`world-continue-${entry.worldId}`}
                      aria-label={`继续世界线 ${name}`}
                      disabled={missing || engineBusy}
                      title={missing ? "目录缺失" : engineBusy ? "引擎忙" : undefined}
                      onClick={() => continueWorld(entry)}
                      className={`rounded-lg border px-3.5 py-1.5 text-[12.5px] tracking-[.1em] transition-colors ${
                        missing || engineBusy
                          ? "cursor-not-allowed border-white/10 text-ink-hint"
                          : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                      }`}
                    >
                      {engineBusy ? "引擎忙" : "继续"}
                    </button>

                    <button
                      type="button"
                      data-testid={`world-edit-${entry.worldId}`}
                      aria-label={`编辑世界线 ${name}`}
                      aria-expanded={editing}
                      onClick={() => (editing ? setEditId(null) : openEdit(entry))}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
                    >
                      {editing ? "收起" : "编辑"}
                    </button>

                    {/* 导出走浏览器下载：href 指向 /api/worlds/export（服务端带 Content-Disposition），
                        download 属性给本地落盘兜一个 <worldId>.world.json 的名字 */}
                    <a
                      href={worldExportUrl(entry.worldId)}
                      download={`${entry.worldId}.world.json`}
                      data-testid={`world-export-${entry.worldId}`}
                      aria-label={`导出世界线 ${name}`}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
                    >
                      导出
                    </a>

                    {/* 两段式确认：首点变「确认删除/取消」，二点才发删除 */}
                    {confirming ? (
                      <>
                        <button
                          type="button"
                          data-testid={`world-confirm-${entry.worldId}`}
                          aria-label={`确认删除世界线 ${name}`}
                          disabled={busy}
                          onClick={() => removeWorld(entry)}
                          className="rounded-lg border border-red-400/40 bg-red-500/15 px-3.5 py-1.5 text-[12.5px] tracking-[.1em] text-red-300 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
                        >
                          {busy ? "删除中…" : "确认删除"}
                        </button>
                        <button
                          type="button"
                          aria-label={`取消删除世界线 ${name}`}
                          disabled={busy}
                          onClick={() => setConfirmId(null)}
                          className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        data-testid={`world-delete-${entry.worldId}`}
                        aria-label={`删除世界线 ${name}`}
                        onClick={() => {
                          setActionError("");
                          setConfirmId(entry.worldId);
                        }}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:border-red-400/40 hover:text-red-300"
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>

                {/* 行内改名：显示名（≤60）+ 备注（≤200），Enter 保存 / Esc 取消，留空即清除该字段 */}
                {editing && (
                  <div
                    data-testid={`world-editor-${entry.worldId}`}
                    className="mt-3 grid gap-2 border-t border-white/[.06] pt-3"
                  >
                    <label className="flex items-center gap-2">
                      <span className="w-14 flex-none text-[11.5px] tracking-[.2em] text-ink-hint">显示名</span>
                      <input
                        ref={labelRef}
                        data-testid={`world-edit-label-${entry.worldId}`}
                        aria-label={`显示名（${name}）`}
                        maxLength={LABEL_MAX}
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        onKeyDown={(e) => onEditKey(e, entry)}
                        placeholder="留空则回退备注 / 世界 id"
                        autoComplete="off"
                        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[rgba(12,14,20,.8)] px-3 py-1.5 text-[13.5px] transition-colors focus:border-gold/35"
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <span className="w-14 flex-none text-[11.5px] tracking-[.2em] text-ink-hint">备注</span>
                      <input
                        data-testid={`world-edit-note-${entry.worldId}`}
                        aria-label={`备注（${name}）`}
                        maxLength={NOTE_MAX}
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        onKeyDown={(e) => onEditKey(e, entry)}
                        placeholder="留空则清除备注"
                        autoComplete="off"
                        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[rgba(12,14,20,.8)] px-3 py-1.5 text-[13.5px] transition-colors focus:border-gold/35"
                      />
                    </label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        data-testid={`world-edit-save-${entry.worldId}`}
                        disabled={saving || worldBusy}
                        onClick={() => saveEdit(entry)}
                        className="rounded-lg border border-gold/35 bg-gold/15 px-4 py-1.5 text-[12.5px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
                      >
                        {saving ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        data-testid={`world-edit-cancel-${entry.worldId}`}
                        disabled={saving}
                        onClick={() => setEditId(null)}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
                      >
                        取消
                      </button>
                      <span className="text-[11px] tracking-[.08em] text-ink-hint">Enter 保存 · Esc 取消 · 留空即清除</span>
                    </div>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>

        <p className="mt-8 text-center text-[12px] tracking-[.35em] text-ink-hint">↑ ↓ 选择 · Enter 继续</p>
      </div>
    </ScreenShell>
  );
}
