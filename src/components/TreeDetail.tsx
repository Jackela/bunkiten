// 剧情图屏的「节点详情」面板（v1.13 从 StoryTreeScreen 抽出）：地点/在场/梗概/出边/状态 + 存档点标注
// + 在此分叉 / 回退到此节点 / 回到这一幕并重演（两段确认）。它自带两件事的状态：快照对比的取数
// （当前 + 基线两条快照 → 三 tab diff）与存档点命名（草稿 + 保存中 + 错误位）。
//
// 为什么单独成文件：StoryTreeScreen 已 1400+ 行，详情面板的 ~12 个 prop、两套两段确认与一条 diff
// 取数链自成一块；抽出来后画布/列表与详情各管各的，读起来不必在两种心智之间来回切。
// 详情是**详情区内嵌展开**（不是浮层）：剧情图 overlay 本身已是一层浮层、App 的 Esc 链只管关 overlay——
// 再叠一层浮层要另接 Esc 与遮罩层级；内嵌面板换节点自动收起，链路更短。
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fetchSnapshot } from "../lib/acp";
import { diffLines, diffStats, type DiffRow } from "../lib/diff";
import type { TreeNode } from "../lib/parser";
import type { SnapshotRef } from "../lib/tree-view";

/** 详情冒号行：地点/在场 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="flex-none text-meta tracking-[.2em] text-ink-hint">{label}</dt>
      <dd className="min-w-0 flex-1 text-ui text-ink-body">{value || "（暂无）"}</dd>
    </div>
  );
}

/** diff 面板的三个 tab（与快照三文件一一对应；顺序即渲染顺序） */
const DIFF_TABS: { key: DiffTabKey; label: string }[] = [
  { key: "state", label: "当前状态" },
  { key: "summary", label: "前情提要" },
  { key: "tree", label: "剧情图" },
];

/** diff 的 tab 键（state/summary/tree ↔ 快照三文件） */
type DiffTabKey = "state" | "summary" | "tree";

/** diff 折叠视图里 add/remove 前后各保留几行 equal（上下文） */
const DIFF_CONTEXT = 2;

/** 折叠视图的一段：rows=保留的行；gap=被折叠的连续 equal（count 行） */
type DiffPart = { kind: "rows"; rows: DiffRow[] } | { kind: "gap"; count: number };

/**
 * diff 行数组 → 「保留段 + 折叠段」分区（快照对比面板的默认视图）：add/remove 行与其
 * 前后 {@link DIFF_CONTEXT} 行 equal 保留，其余连续 equal 折成 gap（「…共 N 行未变」，可展开）。
 * 纯函数：面板测试与渲染共用同一规则。
 * @param {DiffRow[]} rows diffLines 的输出
 * @returns {DiffPart[]} 交替的保留段与折叠段（首尾可为 gap；无改动时整段一个 gap）
 */
function partitionDiff(rows: DiffRow[]): DiffPart[] {
  // 先标记：每个 add/remove 位置把 [p-ctx, p+ctx] 的 equal 也点亮
  const keep = rows.map((r) => r.type !== "equal");
  rows.forEach((r, p) => {
    if (r.type === "equal") return;
    for (let k = Math.max(0, p - DIFF_CONTEXT); k <= Math.min(rows.length - 1, p + DIFF_CONTEXT); k++) keep[k] = true;
  });
  // 再把连续 keep 段收集成 parts，被裁掉的连续 equal 合并成 gap
  const parts: DiffPart[] = [];
  let gap = 0;
  rows.forEach((r, i) => {
    if (!keep[i]) {
      gap += 1;
      return;
    }
    if (gap > 0) {
      parts.push({ kind: "gap", count: gap });
      gap = 0;
    }
    const last = parts[parts.length - 1];
    if (last?.kind === "rows") last.rows.push(r);
    else parts.push({ kind: "rows", rows: [r] });
  });
  if (gap > 0) parts.push({ kind: "gap", count: gap });
  return parts;
}

/** 一行 diff：remove=红（a 独有）、add=绿（b 新增）、equal=ink-hint——颜色只用 tailwind 内置档，不引新 token；
    equal 行是玩家要读的上下文正文，按对比度阶梯用 hint 档（faint 只留给禁用/装饰），remove/add 用 <del>/<ins> 让屏幕阅读器可辨 */
function DiffLine({ row }: { row: DiffRow }) {
  const tone =
    row.type === "remove"
      ? "bg-rose-400/10 text-rose-300"
      : row.type === "add"
        ? "bg-emerald-400/10 text-emerald-300"
        : "text-ink-hint";
  const sign = row.type === "remove" ? "−" : row.type === "add" ? "+" : " ";
  const body = (
    <>
      <span aria-hidden className="mr-1.5 inline-block w-2.5 select-none text-center">
        {sign}
      </span>
      {row.text || "\u00a0"}
    </>
  );
  return (
    <div
      data-testid={`diff-row-${row.type}`}
      className={`whitespace-pre-wrap px-1.5 font-mono text-meta leading-relaxed ${tone}`}
    >
      {row.type === "remove" ? (
        <del className="no-underline">{body}</del>
      ) : row.type === "add" ? (
        <ins className="no-underline">{body}</ins>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * 选中节点的详情面板：地点/在场/梗概/出边/状态 + 存档点标注 + 在此分叉 / 回退到此节点。
 * 回退是破坏性动作（覆盖世界线三份文件）：两段确认，第一段只进确认态。
 * ≥lg 时它住在屏体右栏（StickyRail 包着，自滚），<lg 时回到画布下方的一条卡。
 * v1.7 快照对比是**详情区内嵌展开**（不是浮层，见文件头）。
 */
export function TreeDetail({
  node,
  engineBusy,
  snapshot,
  worldId,
  prevSeq,
  canReplay,
  onFork,
  onRestore,
  onReplay,
  onEdit,
  onLabel,
  onClose,
}: {
  node: TreeNode;
  engineBusy: boolean;
  snapshot: SnapshotRef | null;
  /** 快照对比拉取用的世界 id（fetchSnapshot 直连 /api/history?seq=） */
  worldId: string;
  /** 对比基线的 seq（seq 更小的最近一条，kind 不限）；没有更早快照时 null（不显示按钮） */
  prevSeq: number | null;
  /** 这条快照能不能重演（是 turn 条目、且之前还有 turn 条目）；prompt 有无由 store 点击时判定 */
  canReplay: boolean;
  onFork: (id: string, seq?: number) => void;
  onRestore: (seq: number) => void;
  /** 回到这一条快照开演前、重发当时的输入（store 的 rerollAt；缺输入/无处可退会给降级提示） */
  onReplay: (seq: number) => void;
  /** 只改这个节点：把一句话（带节点作用域）发给引擎（v1.12） */
  onEdit: (text: string) => void;
  /** 给这个存档点起名（v1.12）：返回错误文案，成功返回 null（父层负责落库与刷新） */
  onLabel: (seq: number, label: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const canFork = node.status === "已走过";
  const [confirming, setConfirming] = useState(false);
  // 重演的两段确认（与回退的 confirming 互斥：一条动作行上不给两组确认同时开着）
  const [confirmingReplay, setConfirmingReplay] = useState(false);
  /** 节点级就地编辑的那句话（换节点时清空——写了一半的话是针对上一个节点说的） */
  const [nodeNote, setNodeNote] = useState("");
  useEffect(() => {
    setNodeNote("");
  }, [node.id]);

  // 存档点命名（v1.12）：草稿跟着当前节点的那条快照走（换节点/名字被刷回来都重置）
  const [labelDraft, setLabelDraft] = useState(snapshot?.label ?? "");
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelError, setLabelError] = useState("");
  useEffect(() => {
    setLabelDraft(snapshot?.label ?? "");
    setLabelError("");
  }, [node.id, snapshot?.seq, snapshot?.label]);

  /** 保存名字：成功即清错误、父层刷新后 label 会变（按钮随之回到禁用态） */
  const sendLabel = () => {
    if (!snapshot || labelBusy) return;
    if (labelDraft === snapshot.label) return;
    setLabelBusy(true);
    setLabelError("");
    void onLabel(snapshot.seq, labelDraft).then((err) => {
      setLabelBusy(false);
      if (err) setLabelError(err);
    });
  };

  // 快照对比面板的状态：rows 按 tab 键分桶；diffReqRef 让换节点/重开后的过期应答作废
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffTab, setDiffTab] = useState<DiffTabKey>("state");
  const [diffRows, setDiffRows] = useState<Record<DiffTabKey, DiffRow[]> | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffShowAll, setDiffShowAll] = useState(false);
  const diffReqRef = useRef(0);

  /**
   * 三个 diff tab 的方向键走位（ARIA tabs 惯例，自动激活）：←→ 循环、Home/End 跳首尾。
   * 焦点靠 DOM 顺序取（tablist 里只有这三个 role="tab"），激活与点击走同一条路（切 tab 回到折叠视图）。
   */
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = DIFF_TABS.map((t) => t.key);
    const i = keys.indexOf(diffTab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % keys.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + keys.length) % keys.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = keys.length - 1;
    if (next < 0 || next === i) return;
    e.preventDefault();
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    setDiffTab(keys[next]);
    setDiffShowAll(false);
  };

  // 换节点就把确认态与对比面板一起收掉：不该带着上一个节点的状态去点下一个
  useEffect(() => {
    setConfirming(false);
    diffReqRef.current += 1; // 在途的对比请求作废（应答回来也不许写进新节点的面板）
    setDiffOpen(false);
    setDiffTab("state");
    setDiffRows(null);
    setDiffLoading(false);
    setDiffError("");
    setDiffShowAll(false);
  }, [node.id]);

  /** 把「只改这个节点」的那句话发出去（作用域由上层拼进指令；发完清空输入框） */
  const sendNode = () => {
    const text = nodeNote.trim();
    if (!text) return;
    setNodeNote("");
    onEdit(text);
  };

  /** 拉当前 + 基线两条快照全文并 diff 三文件（失败落在面板内的错误位，不打扰树本体） */
  const openDiff = () => {
    if (!snapshot || prevSeq === null) return;
    const req = diffReqRef.current + 1;
    diffReqRef.current = req;
    setDiffOpen(true);
    setDiffLoading(true);
    setDiffError("");
    setDiffRows(null);
    setDiffTab("state");
    setDiffShowAll(false);
    Promise.all([fetchSnapshot(worldId, snapshot.seq), fetchSnapshot(worldId, prevSeq)])
      .then(([cur, prev]) => {
        if (diffReqRef.current !== req) return;
        setDiffRows({
          state: diffLines(prev.files.state ?? "", cur.files.state ?? ""),
          summary: diffLines(prev.files.summary ?? "", cur.files.summary ?? ""),
          tree: diffLines(prev.files.tree ?? "", cur.files.tree ?? ""),
        });
      })
      .catch((e: unknown) => {
        if (diffReqRef.current !== req) return;
        setDiffError((e as Error).message || String(e));
      })
      .finally(() => {
        if (diffReqRef.current !== req) return;
        setDiffLoading(false);
      });
  };

  return (
    <div data-testid="tree-detail" className="shell-panel mt-4 rounded-xl p-4 lg:mt-0">
      <div className="flex items-center gap-3">
        <h3 className="text-body tracking-[.1em] text-ink">节点 {node.id}</h3>
        <span className="rounded-sm border border-white/15 px-1.5 py-0.5 text-micro text-ink-hint">{node.status}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md border border-white/10 px-3 py-1 text-ui tracking-[.15em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
        >
          关闭
        </button>
      </div>

      {snapshot && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p data-testid={`tree-snapshot-${node.id}`} className="text-ui tracking-[.08em] text-gold/85">
            存档点 · 第 {snapshot.seq} 幕{snapshot.label ? ` · ${snapshot.label}` : ""}
          </p>
          {/* 命名：一句话给这个时间点起个名字（存在世界索引里，快照文件不动） */}
          <div className="flex items-center gap-1.5">
            <input
              data-testid="snapshot-label-input"
              value={labelDraft}
              maxLength={40}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendLabel();
                }
              }}
              placeholder="给这一刻起个名字…"
              autoComplete="off"
              className="w-40 rounded-md border border-white/10 bg-panel-sunken px-2 py-1 text-meta transition-colors focus:border-gold/35"
            />
            <button
              type="button"
              data-testid="snapshot-label-save"
              disabled={labelBusy || labelDraft === snapshot.label}
              onClick={sendLabel}
              className="rounded-md border border-white/15 px-2.5 py-1 text-meta text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
            >
              {labelBusy ? "保存中…" : "命名"}
            </button>
          </div>
        </div>
      )}
      {labelError ? (
        <p role="status" className="mt-1 text-meta text-ink-hint">
          {labelError}
        </p>
      ) : null}

      {/* 有基线（seq 更小的最近一条）才给对比入口；全局最小的快照没有可比的对象 */}
      {snapshot && prevSeq !== null && !diffOpen && (
        <button
          type="button"
          data-testid="snapshot-diff-open"
          onClick={openDiff}
          className="mt-2 rounded-lg border border-white/15 px-3 py-1.5 text-ui tracking-[.1em] text-ink-body transition-colors hover:border-gold/40 hover:text-ink"
        >
          与上一个存档点对比（第 {prevSeq} 幕 → 第 {snapshot.seq} 幕）
        </button>
      )}

      {diffOpen && snapshot && prevSeq !== null && (
        <div data-testid="snapshot-diff" className="mt-3 rounded-lg border border-white/10 bg-panel-soft p-3">
          {/* 标题行允许换行：右栏只有 380px，一行放不下「第 N 幕 → 第 M 幕（…）+ 关闭对比」 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-meta tracking-[.08em] text-ink-body">
              第 {prevSeq} 幕 → 第 {snapshot.seq} 幕（红=旧档独有，绿=新档新增）
            </p>
            <button
              type="button"
              data-testid="snapshot-diff-close"
              onClick={() => {
                diffReqRef.current += 1;
                setDiffOpen(false);
              }}
              className="ml-auto rounded-md border border-white/10 px-2.5 py-0.5 text-meta tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              关闭对比
            </button>
          </div>

          {diffLoading && (
            <p data-testid="snapshot-diff-loading" className="mt-2 animate-pulse text-ui text-ink-hint">
              载入存档点对比…
            </p>
          )}

          {diffError && (
            <p data-testid="snapshot-diff-error" className="mt-2 text-ui text-red-400">
              存档点对比加载失败：{diffError}
            </p>
          )}

          {diffRows && (
            <div className="mt-2">
              <div role="tablist" aria-label="存档点对比" onKeyDown={onTabKeyDown} className="flex flex-wrap gap-1.5">
                {DIFF_TABS.map((t) => {
                  const stats = diffStats(diffRows[t.key]);
                  const active = diffTab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      id={`snapshot-diff-tab-${t.key}`}
                      aria-selected={active}
                      aria-controls="snapshot-diff-panel"
                      tabIndex={active ? 0 : -1}
                      data-testid={`snapshot-diff-tab-${t.key}`}
                      onClick={() => {
                        setDiffTab(t.key);
                        setDiffShowAll(false); // 切 tab 回到折叠视图：每个 tab 独立展开
                      }}
                      className={`rounded-md border px-2.5 py-1 text-meta tracking-[.08em] transition-colors ${
                        active
                          ? "border-gold/45 bg-gold/15 text-gold"
                          : "border-white/10 text-ink-hint hover:border-gold/40"
                      }`}
                    >
                      {t.label}
                      <span className="ml-1.5 text-micro">
                        {stats.added === 0 && stats.removed === 0 ? "无变化" : `+${stats.added} −${stats.removed}`}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div
                id="snapshot-diff-panel"
                role="tabpanel"
                aria-labelledby={`snapshot-diff-tab-${diffTab}`}
                className="mt-2 max-h-72 overflow-y-auto rounded-md border border-white/[.06] bg-panel-soft p-2"
              >
                {(
                  (diffShowAll
                    ? [{ kind: "rows", rows: diffRows[diffTab] }]
                    : partitionDiff(diffRows[diffTab])) as DiffPart[]
                ).map((part, i) =>
                  part.kind === "gap" ? (
                    <button
                      key={i}
                      type="button"
                      data-testid="snapshot-diff-gap"
                      onClick={() => setDiffShowAll(true)}
                      className="my-0.5 block w-full rounded-sm border border-dashed border-white/10 px-2 py-0.5 text-left text-meta tracking-[.05em] text-ink-hint transition-colors hover:border-gold/30 hover:text-ink"
                    >
                      …共 {part.count} 行未变（点击展开）
                    </button>
                  ) : (
                    <div key={i}>
                      {part.rows.map((r, ri) => (
                        <DiffLine key={ri} row={r} />
                      ))}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DetailRow label="地点" value={node.location} />
        <DetailRow label="在场" value={node.present} />
      </dl>

      <div className="mt-3">
        <p className="text-meta tracking-[.2em] text-ink-hint">梗概</p>
        <p className="mt-1 whitespace-pre-wrap text-ui leading-relaxed text-ink-body">{node.synopsis || "（暂无）"}</p>
      </div>

      <div className="mt-3">
        <p className="text-meta tracking-[.2em] text-ink-hint">出边</p>
        {node.edges.length === 0 ? (
          <p className="mt-1 text-ui text-ink-hint">（无出边，本章末端）</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {node.edges.map((e, i) => (
              <li key={i} className="text-ui text-ink-body">
                <span className="text-ink-hint">{e.label || "（未命名）"}</span>
                <span className="mx-1.5 text-ink-faint">→</span>
                <span className="text-gold">{e.target}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 只改这个节点（v1.12）：底部那条是全树范围，这里的一句话**带着节点 id**发给引擎——
          引擎按 SKILL【剧情编辑指令】的作用域规则只动这个节点，不再自行判断改哪儿 */}
      <div className="mt-3 rounded-lg border border-white/[.06] bg-panel-soft p-3">
        <label htmlFor="tree-node-note" className="block text-meta tracking-[.15em] text-ink-hint">
          只改这个节点（例：把这里写得更紧张、加一段追逐）
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="tree-node-note"
            data-testid="tree-node-note"
            value={nodeNote}
            onChange={(e) => setNodeNote(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法选词的 Enter 不算发送（与底部那条同款）
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendNode();
              }
            }}
            placeholder={`针对节点 ${node.id}…`}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-panel-sunken px-3 py-2 text-ui tracking-[.02em] transition-colors focus:border-gold/35"
          />
          <button
            type="button"
            data-testid="tree-node-send"
            disabled={nodeNote.trim().length === 0}
            onClick={sendNode}
            className="rounded-lg border border-gold/35 bg-gold/15 px-4 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
          >
            改这里
          </button>
        </div>
        {engineBusy ? <p className="mt-1.5 text-meta text-ink-hint">忙碌中，就绪后自动发送</p> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {canFork && (
          <button
            type="button"
            data-testid={`tree-fork-${node.id}`}
            disabled={engineBusy}
            // 有快照 = 精确分叉（以该快照建新世界）；无快照不带 seq，走 server 的兼容路径
            onClick={() => onFork(node.id, snapshot?.seq)}
            className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
              engineBusy
                ? "cursor-not-allowed border-white/10 text-ink-hint"
                : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
            }`}
          >
            在此分叉
          </button>
        )}

        {/* 无快照的旧世界：这里什么都不渲染（一切按现状降级，不报错、不显示新按钮） */}
        {snapshot &&
          (confirming ? (
            <>
              <button
                type="button"
                data-testid={`tree-restore-confirm-${node.id}`}
                disabled={engineBusy}
                onClick={() => {
                  setConfirming(false);
                  onRestore(snapshot.seq);
                }}
                className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                  engineBusy
                    ? "cursor-not-allowed border-white/10 text-ink-hint"
                    : "border-red-400/50 bg-red-400/15 text-red-300 hover:bg-red-400/25"
                }`}
              >
                确认回退（先备份当前）
              </button>
              <button
                type="button"
                data-testid={`tree-restore-cancel-${node.id}`}
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-white/10 px-3 py-2 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid={`tree-restore-${node.id}`}
              disabled={engineBusy}
              onClick={() => {
                setConfirmingReplay(false);
                setConfirming(true);
              }}
              className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                engineBusy
                  ? "cursor-not-allowed border-white/10 text-ink-hint"
                  : "border-white/15 text-ink-body hover:border-gold/40 hover:text-ink"
              }`}
            >
              回退到此节点（原地）
            </button>
          ))}

        {/* 回到这一幕并重演（v1.13）：与回退同一纪律（两段确认、忙碌禁用）；输入在盘上，
            旧档那几幕点击后由 store 给降级提示，不静默（见 docs/adr/0023） */}
        {snapshot &&
          canReplay &&
          (confirmingReplay ? (
            <>
              <button
                type="button"
                data-testid={`tree-replay-confirm-${node.id}`}
                disabled={engineBusy}
                onClick={() => {
                  setConfirmingReplay(false);
                  onReplay(snapshot.seq);
                }}
                className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                  engineBusy
                    ? "cursor-not-allowed border-white/10 text-ink-hint"
                    : "border-red-400/50 bg-red-400/15 text-red-300 hover:bg-red-400/25"
                }`}
              >
                确认重演（退到这一幕开演前）
              </button>
              <button
                type="button"
                data-testid={`tree-replay-cancel-${node.id}`}
                onClick={() => setConfirmingReplay(false)}
                className="rounded-lg border border-white/10 px-3 py-2 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid={`tree-replay-${node.id}`}
              disabled={engineBusy}
              onClick={() => {
                setConfirming(false);
                setConfirmingReplay(true);
              }}
              className={`rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                engineBusy
                  ? "cursor-not-allowed border-white/10 text-ink-hint"
                  : "border-white/15 text-ink-body hover:border-gold/40 hover:text-ink"
              }`}
            >
              回到这一幕并重演
            </button>
          ))}

        <span className="text-meta tracking-[.05em] text-ink-hint">
          {!snapshot
            ? "分叉会新建一条世界线，从这一幕继续"
            : canReplay
              ? "回退会先备份当前进度，再从这一刻重新开演；重演会退到这一幕开演前并重发当时的输入"
              : "回退会先备份当前进度，再从这一刻重新开演"}
        </span>
      </div>
    </div>
  );
}
