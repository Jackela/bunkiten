import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion } from "framer-motion";
import { fetchWorlds, postWorld, worldExportUrl, type WorldEntry } from "../lib/acp";
import { genealogyStep, layoutGenealogy, type GenealogyLayout } from "../lib/genealogy";
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

/** 家谱节点绘制尺寸：须与 layoutGenealogy 的缺省几何一致（布局定坐标、SVG 画矩形） */
const GEN_NODE_W = 210;
const GEN_NODE_H = 64;

/** 显示名超长时截断（SVG text 不会自动省略） */
function truncateName(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * 家谱画布（v1.7）：把 forkedFrom 血缘的森林画成 SVG——节点 = 圆角矩形卡（显示名/章数/
 * 分叉节点徽章），边 = 父底边中点 → 子顶边中点的圆角拐弯。整图一个可 Tab 的节点
 * （roving tabIndex），方向键走节点（`genealogyStep` 的确定性规则）、Enter/点击选中；
 * 家谱规模小，fit-view 全量展示，不做缩放平移。焦点环走全局 :focus-visible（同 TreeCanvas）。
 */
function GenealogyCanvas({
  layout,
  focusId,
  onFocus,
}: {
  layout: GenealogyLayout;
  focusId: string | null;
  onFocus: (id: string) => void;
}) {
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const ids = useMemo(() => layout.nodes.map((n) => n.worldId), [layout.nodes]);
  // roving tabIndex：没选中时落在第一个节点
  const tabbableId = focusId && ids.includes(focusId) ? focusId : ids[0];

  /** 方向键步进：换选中并把 DOM 焦点一起搬过去（不是只换描边） */
  const step = (id: string, dir: "up" | "down" | "left" | "right") => {
    const next = genealogyStep(layout, id, dir);
    if (!next) return;
    onFocus(next);
    nodeRefs.current.get(next)?.focus();
  };

  const onNodeKey = (id: string) => (e: ReactKeyboardEvent<SVGGElement>) => {
    if (e.nativeEvent.isComposing) return; // 中文输入法组字中的按键不算导航
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        step(id, "up");
        return;
      case "ArrowDown":
        e.preventDefault();
        step(id, "down");
        return;
      case "ArrowLeft":
        e.preventDefault();
        step(id, "left");
        return;
      case "ArrowRight":
        e.preventDefault();
        step(id, "right");
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        onFocus(id);
        return;
      default:
        return;
    }
  };

  return (
    <svg
      data-testid="genealogy-canvas"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="w-full rounded-xl border border-white/[.06] bg-[rgba(12,14,20,.5)]"
      style={{ height: "auto", aspectRatio: `${layout.width} / ${layout.height}` }}
    >
      {layout.edges.map((e, i) => (
        <path
          key={`${e.from}->${e.to}-${i}`}
          className="genealogy-edge"
          d={e.d}
          fill="none"
          style={{ stroke: "rgba(236,231,219,.25)" }}
          strokeWidth={1.4}
          strokeDasharray={e.dashed ? "4 4" : undefined}
        />
      ))}

      {layout.nodes.map((n) => {
        const focused = focusId === n.worldId;
        const missing = !n.entry.exists;
        const fork = n.entry.forkedFrom;
        const name = worldDisplayName(n.entry);
        return (
          <g
            key={n.worldId}
            data-testid={`genealogy-node-${n.worldId}`}
            role="button"
            tabIndex={n.worldId === tabbableId ? 0 : -1}
            aria-label={`世界线 ${name} · 第 ${n.entry.chapterNo} 章${fork ? ` · 分叉自 ${fork.worldId} @ ${fork.nodeId}` : ""}${
              n.missingParent ? " · 父线已删" : ""
            }${missing ? " · 目录缺失" : ""}`}
            onClick={() => onFocus(n.worldId)}
            onKeyDown={onNodeKey(n.worldId)}
            ref={(el) => {
              if (el) nodeRefs.current.set(n.worldId, el);
              else nodeRefs.current.delete(n.worldId);
            }}
            className="cursor-pointer"
            opacity={missing ? 0.55 : 1}
          >
            <rect
              x={n.x}
              y={n.y}
              width={GEN_NODE_W}
              height={GEN_NODE_H}
              rx={10}
              style={{
                fill: "rgba(236,231,219,.05)",
                stroke: focused ? "var(--accent2)" : "rgba(236,231,219,.4)",
                ...(missing && !focused ? { strokeDasharray: "5 4" } : {}),
              }}
              strokeWidth={focused ? 2.6 : 1.5}
            />
            <text x={n.x + 12} y={n.y + 25} style={{ fill: "var(--ink)" }} fontSize={13} fontWeight={600} letterSpacing="0.06em">
              {truncateName(name, 12)}
            </text>
            <text x={n.x + 12} y={n.y + 46} style={{ fill: "var(--ink)", opacity: 0.55 }} fontSize={10.5}>
              第 {n.entry.chapterNo} 章
            </text>
            {/* 分叉节点徽章（nodeId 缩写）；父线已删的孤儿前面加 ⌫ */}
            {(fork || n.missingParent) && (
              <text
                data-testid={n.missingParent ? `genealogy-orphan-${n.worldId}` : undefined}
                x={n.x + GEN_NODE_W - 12}
                y={n.y + 25}
                textAnchor="end"
                style={{ fill: n.missingParent ? "rgba(248,113,113,.9)" : "var(--accent)", opacity: 0.9 }}
                fontSize={10}
                letterSpacing="0.08em"
              >
                {`${n.missingParent ? "⌫ " : ""}@${fork?.nodeId ?? "?"}`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 世界线屏：选卡之后的第二环——继续某条世界线（读档续演）或开一条全新的（去捏人）。
 * 数据自己拉（fetchWorlds/preset 过滤），删除/新建/改名/导入走 POST /api/worlds；屏内不做任何推演。
 * v1.6：行内改名（label/note，空串=清除）、单条导出（浏览器下载）、打包导入（含成功/失败提示位），
 * 列表补 listbox/option 语义与 roving tabIndex，行内按钮带含世界名的 aria-label。
 * v1.7：列表/家谱视图切换——家谱把 forkedFrom 血缘画成 SVG 森林（`lib/genealogy` 纯函数布局，
 * 孤儿标「⌫ 父线已删」、fork 环容错），节点方向键走位 + Enter 选中，选中后的快捷条复用
 * `continueWorld` 继续；「查看」跳回列表并聚焦对应行。
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
  /** 行内动作的成功提示（v1.7：删除进回收站后的去向说明），与错误同一位展示 */
  const [actionNotice, setActionNotice] = useState("");
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
  /** 视图（v1.7 家谱）：平铺列表 / forkedFrom 血缘森林；屏内状态，不持久化 */
  const [view, setView] = useState<"list" | "genealogy">("list");
  /** 家谱里选中的世界 id（选中 = 高亮 + 下方快捷信息条；null=未选中） */
  const [genFocus, setGenFocus] = useState<string | null>(null);
  /** 「查看」跳回列表后要聚焦的行（世界 id；effect 里消费一次即清） */
  const [listJumpId, setListJumpId] = useState<string | null>(null);

  /** 行元素引用：↑↓ 把 DOM 焦点一起搬到光标行（roving tabIndex 的完整语义，不是只换个描边） */
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /** 隐藏 file input（导入入口按钮点它） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 打开编辑器时把光标送进「显示名」输入框 */
  const labelRef = useRef<HTMLInputElement | null>(null);

  const list = useMemo(() => worlds ?? [], [worlds]);

  // 家谱布局（纯函数）：worlds 变化（删除/导入/改名重取）时重算
  const genealogy = useMemo(
    // 画布常量显式传进布局（StoryTreeScreen 的惯例）：单侧改尺寸不会让 rect 与坐标静默错位
    () => layoutGenealogy(list, { nodeW: GEN_NODE_W, nodeH: GEN_NODE_H }),
    [list],
  );

  // 「查看」收尾：切回列表后把 DOM 焦点送到对应行（键盘用户从那里继续 ↑↓/Enter）
  useEffect(() => {
    if (view !== "list" || !listJumpId) return;
    rowRefs.current.get(listJumpId)?.focus();
    setListJumpId(null);
  }, [view, listJumpId]);

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

  // 键盘：↑↓ 移动高亮，Enter 继续高亮的世界线；确认态/编辑态下全部让位给按钮与输入框。
  // 家谱视图下让位（方向键由家谱节点自己接，Enter 只选中不清档续演）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return; // 中文输入法组字中的按键不算导航
      if (view !== "list") return; // 家谱视图：节点级键盘，不做屏级列表导航
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
  }, [confirmId, editId, engineBusy, focus, list, resumeWorld, view]);

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
    setActionNotice("");
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

  /** 删除（第二段确认触发）：成功即重取清单并提示去向（回收站可手工找回），失败在列表上方行内报错 */
  const removeWorld = (entry: WorldEntry) => {
    if (deleting) return;
    setDeleting(entry.worldId);
    setActionError("");
    setActionNotice("");
    postWorld({ action: "delete", worldId: entry.worldId })
      .then((r) => {
        if (!r.ok) {
          setActionError(`删除失败：${r.error ?? "未知错误"}`);
          setDeleting(null);
          return;
        }
        setConfirmId(null);
        setDeleting(null);
        // trashed:false = 回收站 rename 失败、服务端已回退直删——文案不能再说「可手工找回」
        setActionNotice(r.trashed === false ? "已删除（未能进回收站，无法找回）" : "已移入回收站（state/trash/ 可手工找回）");
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
    setActionNotice("");
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
    setActionNotice("");
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
            className="ml-auto flex-none rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-[color:var(--accent)]"
          >
            返回
          </button>
        </header>

        {/* 工具栏：视图切换（列表/家谱）、导入（收 .world.json）与主行动「新世界线」（空态下也用它） */}
        <div className="mt-7 flex items-center gap-3">
          <h3 className="text-[13px] tracking-[.35em] text-gold/80">世 界 线</h3>
          {/* 视图切换（v1.7）：平铺列表 ↔ forkedFrom 家谱森林（分段按钮） */}
          <div role="group" aria-label="世界线视图" className="flex items-center rounded-lg border border-white/10 p-0.5">
            <button
              type="button"
              data-testid="worlds-view-list"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              className={`rounded-md px-3 py-1 text-[12px] tracking-[.15em] transition-colors ${
                view === "list" ? "bg-gold/15 text-gold" : "text-ink-hint hover:text-ink"
              }`}
            >
              列表
            </button>
            <button
              type="button"
              data-testid="worlds-view-genealogy"
              aria-pressed={view === "genealogy"}
              onClick={() => setView("genealogy")}
              className={`rounded-md px-3 py-1 text-[12px] tracking-[.15em] transition-colors ${
                view === "genealogy" ? "bg-gold/15 text-gold" : "text-ink-hint hover:text-ink"
              }`}
            >
              家谱
            </button>
          </div>
          <button
            type="button"
            data-testid="worlds-import"
            disabled={importing || worldBusy}
            onClick={() => fileRef.current?.click()}
            className="ml-auto rounded-lg border border-white/10 px-4 py-2 text-[13px] tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
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

        {/* 提示位：导入/改名的成功与失败（删除/新建的行内提示在下面） */}
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

        {/* 行内动作提示：错误（红）与删除成功的回收站去向（金）各一行 */}
        {actionError && <p className="mt-3 text-sm text-red-400">{actionError}</p>}
        {actionNotice && <p className="mt-3 text-sm text-gold/80">{actionNotice}</p>}

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
            <p className="text-[14px] tracking-[.12em] text-ink-hint">还没有世界线——开始新的吧</p>
            <p className="text-[11.5px] tracking-[.2em] text-ink-hint">新世界线从捏人开始</p>
          </div>
        )}

        {/* 世界列表（列表视图）：listbox + option，光标行独占 tabIndex 0（roving tabIndex）。
            家谱视图下整块卸载：行的存在与否就是视图状态本身（测试与读屏都以此为准） */}
        {view === "list" && (
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
                          setActionNotice("");
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

        )}

        {/* 家谱视图（v1.7）：SVG 森林 + 选中节点的快捷信息条（继续复用 continueWorld，不另起一份逻辑） */}
        {view === "genealogy" && list.length > 0 && (
          <div className="mt-4">
            <GenealogyCanvas layout={genealogy} focusId={genFocus} onFocus={setGenFocus} />
            {(() => {
              const entry = list.find((w) => w.worldId === genFocus);
              if (!entry) return null;
              const name = worldDisplayName(entry);
              const missing = !entry.exists;
              return (
                <div
                  data-testid="genealogy-detail"
                  className="mt-3 rounded-xl border border-white/10 bg-[rgba(12,14,20,.72)] px-4 py-3 backdrop-blur-md"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`text-[15px] ${missing ? "text-ink-hint" : "text-ink"}`}>{name}</span>
                    <span className="text-[11.5px] tracking-[.12em] text-ink-hint">
                      第 {entry.chapterNo} 章 · {relativeTime(entry.lastPlayed)}
                      {missing && <span className="ml-2 text-red-400/90">目录缺失</span>}
                    </span>
                    {entry.forkedFrom && !genealogy.nodes.find((n) => n.worldId === entry.worldId)?.missingParent && (
                      <span className="rounded-sm border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-[10px] tracking-[.12em] text-ink-hint">
                        分叉自 {entry.forkedFrom.worldId} @ {entry.forkedFrom.nodeId}
                      </span>
                    )}
                    {genealogy.nodes.find((n) => n.worldId === entry.worldId)?.missingParent && (
                      <span className="rounded-sm border border-red-400/30 px-1.5 py-0.5 text-[10px] tracking-[.12em] text-red-300/90">
                        ⌫ 父线已删
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`genealogy-continue-${entry.worldId}`}
                        aria-label={`继续世界线 ${name}`}
                        disabled={missing || engineBusy}
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
                        data-testid={`genealogy-view-${entry.worldId}`}
                        aria-label={`在列表中查看世界线 ${name}`}
                        onClick={() => {
                          const idx = list.findIndex((w) => w.worldId === entry.worldId);
                          setView("list");
                          if (idx >= 0) {
                            setFocus(idx);
                            setListJumpId(entry.worldId);
                          }
                        }}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
                      >
                        查看
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        <p className="mt-8 text-center text-[12px] tracking-[.35em] text-ink-hint">
          {view === "list" ? "↑ ↓ 选择 · Enter 继续" : "方向键走节点 · Enter 选中 · 继续读档续演"}
        </p>
      </div>
    </ScreenShell>
  );
}
