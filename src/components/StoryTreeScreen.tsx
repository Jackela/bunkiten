// 剧情图屏（tree overlay）：读世界线的 story-tree.md → 布局成 SVG 节点图，支持选点看详情、
// 在此分叉、一句话自然语言改树（引擎改完静默写回，屏内重取）。解析不出结构时回退显示原文。
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import { fetchTree } from "../lib/acp";
import {
  parseStoryTree,
  type StoryTree,
  type TreeChapter,
  type TreeNode,
  type TreeNodeStatus,
} from "../lib/parser";
import { layoutTree, type TreeLayout } from "../lib/treeLayout";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 节点绘制尺寸：须与传给 layoutTree 的参数一致（布局定坐标、SVG 画矩形） */
const NODE_W = 210;
const NODE_H = 74;

/** beat 太长时截断（SVG 文字不会自动省略） */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 节点状态 → 配色：已走过=主题金、可达=中性水墨、已剪枝=暗+虚线、嫁接=紫 */
function nodePaint(status: TreeNodeStatus): { fill: string; stroke: string; dash?: string; dim: boolean } {
  switch (status) {
    case "已走过":
      return { fill: "color-mix(in oklab, var(--accent) 26%, transparent)", stroke: "var(--accent)", dim: false };
    case "已剪枝":
      return { fill: "rgba(236,231,219,.02)", stroke: "rgba(236,231,219,.22)", dash: "5 4", dim: true };
    case "嫁接":
      return { fill: "rgba(167,139,250,.18)", stroke: "#a78bfa", dim: false };
    case "可达":
    default:
      return { fill: "rgba(236,231,219,.05)", stroke: "rgba(236,231,219,.4)", dim: false };
  }
}

/** 图例顺序（与节点状态字面一致） */
const STATUS_ORDER: TreeNodeStatus[] = ["已走过", "可达", "已剪枝", "嫁接"];

/**
 * SVG 画布：按 viewBox 自适应宽度，渲染边与节点。
 * 节点用 <g role="button" tabIndex> 语义，可 Tab 聚焦、Enter/Space 选中。
 */
function TreeCanvas({
  chapter,
  layout,
  treeFocus,
  onFocus,
}: {
  chapter: TreeChapter;
  layout: TreeLayout;
  treeFocus: string | null;
  onFocus: (id: string) => void;
}) {
  const activate = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onFocus(id);
    }
  };

  return (
    <div className="mt-3">
      {/* 图例 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] tracking-[.1em] text-ink/45">
        {STATUS_ORDER.map((st) => {
          const paint = nodePaint(st);
          return (
            <span key={st} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-[3px] border"
                style={{
                  background: paint.fill,
                  borderColor: paint.stroke,
                  borderStyle: paint.dash ? "dashed" : "solid",
                }}
              />
              {st}
            </span>
          );
        })}
      </div>

      <svg
        data-testid="tree-canvas"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full rounded-xl border border-white/[.06] bg-[rgba(12,14,20,.5)]"
        style={{ height: "auto", aspectRatio: `${layout.width} / ${layout.height}` }}
      >
        <defs>
          <marker
            id="tree-arrow"
            viewBox="0 0 8 8"
            refX="7.5"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" fill="rgba(236,231,219,.35)" />
          </marker>
        </defs>

        {layout.edges.map((e, i) => (
          <path
            key={`${e.from}->${e.to}-${i}`}
            d={e.d}
            fill="none"
            style={{ stroke: "rgba(236,231,219,.25)" }}
            strokeWidth={1.4}
            markerEnd="url(#tree-arrow)"
          />
        ))}

        {layout.nodes.map((ln) => {
          const paint = nodePaint(ln.node.status);
          const focused = treeFocus === ln.id;
          const isCurrent = chapter.current === ln.id;
          const stroke = focused ? "var(--accent2)" : paint.stroke;
          const strokeWidth = focused ? 2.6 : isCurrent ? 2 : 1.5;
          return (
            <g
              key={ln.id}
              data-testid={`tree-node-${ln.id}`}
              role="button"
              tabIndex={0}
              aria-label={`节点 ${ln.id} · ${ln.node.status}`}
              onClick={() => onFocus(ln.id)}
              onKeyDown={activate(ln.id)}
              className="cursor-pointer outline-none"
              opacity={paint.dim ? 0.55 : 1}
            >
              {/* 当前进度节点：外圈亮环（accent2） */}
              {isCurrent && (
                <rect
                  x={ln.x - 4}
                  y={ln.y - 4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  rx={12}
                  fill="none"
                  style={{ stroke: "var(--accent2)" }}
                  strokeWidth={2}
                />
              )}
              <rect
                x={ln.x}
                y={ln.y}
                width={NODE_W}
                height={NODE_H}
                rx={10}
                style={{
                  fill: paint.fill,
                  stroke,
                  ...(paint.dash && !focused ? { strokeDasharray: paint.dash } : {}),
                }}
                strokeWidth={strokeWidth}
              />
              <text x={ln.x + 12} y={ln.y + 24} style={{ fill: "var(--ink)" }} fontSize={13} fontWeight={600} letterSpacing="0.06em">
                节点 {ln.id}
              </text>
              <text x={ln.x + 12} y={ln.y + 46} style={{ fill: "var(--ink)", opacity: 0.62 }} fontSize={11.5}>
                {truncate(ln.node.beat || ln.node.synopsis || "（无拍点）", 16)}
              </text>
              <text x={ln.x + 12} y={ln.y + 63} style={{ fill: "var(--ink)", opacity: 0.4 }} fontSize={10}>
                {ln.node.status}
                {ln.node.location ? ` · ${truncate(ln.node.location, 8)}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 详情冒号行：地点/在场 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="flex-none text-[11px] tracking-[.2em] text-ink/45">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13.5px] text-ink/85">{value || "（暂无）"}</dd>
    </div>
  );
}

/** 选中节点的详情侧栏：地点/在场/梗概/出边/状态 + 在此分叉 */
function TreeDetail({
  node,
  engineBusy,
  onFork,
  onClose,
}: {
  node: TreeNode;
  engineBusy: boolean;
  onFork: (id: string) => void;
  onClose: () => void;
}) {
  const canFork = node.status === "已走过";
  return (
    <div data-testid="tree-detail" className="mt-4 rounded-xl border border-white/10 bg-[rgba(12,14,20,.72)] p-4">
      <div className="flex items-center gap-3">
        <h3 className="text-[15px] tracking-[.1em] text-ink">节点 {node.id}</h3>
        <span className="rounded-sm border border-white/15 px-1.5 py-0.5 text-[11px] text-ink/60">{node.status}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md border border-white/10 px-3 py-1 text-[12px] tracking-[.15em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
        >
          关闭
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DetailRow label="地点" value={node.location} />
        <DetailRow label="在场" value={node.present} />
      </dl>

      <div className="mt-3">
        <p className="text-[11px] tracking-[.2em] text-ink/45">梗概</p>
        <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink/85">{node.synopsis || "（暂无）"}</p>
      </div>

      <div className="mt-3">
        <p className="text-[11px] tracking-[.2em] text-ink/45">出边</p>
        {node.edges.length === 0 ? (
          <p className="mt-1 text-[13px] text-ink/50">（无出边，本章末端）</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {node.edges.map((e, i) => (
              <li key={i} className="text-[13px] text-ink/75">
                <span className="text-ink/50">{e.label || "（未命名）"}</span>
                <span className="mx-1.5 text-ink/30">→</span>
                <span className="text-gold">{e.target}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {canFork && (
          <button
            type="button"
            data-testid={`tree-fork-${node.id}`}
            disabled={engineBusy}
            onClick={() => onFork(node.id)}
            className={`rounded-lg border px-4 py-2 text-[13px] tracking-[.1em] transition-colors ${
              engineBusy
                ? "cursor-not-allowed border-white/10 text-ink/35"
                : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
            }`}
          >
            在此分叉
          </button>
        )}
        <span className="text-[11px] tracking-[.05em] text-ink/40">分叉不推演，切换后从该节点续演</span>
      </div>
    </div>
  );
}

/** 剧情图：世界线剧情树的图形化查看 / 编辑 / 分叉 */
export default function StoryTreeScreen() {
  const worldId = useGameStore((s) => s.worldId);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const treeStamp = useGameStore((s) => s.treeStamp);
  const treeNotice = useGameStore((s) => s.treeNotice);
  const treeFocus = useGameStore((s) => s.treeFocus);
  const forkResult = useGameStore((s) => s.forkResult);
  const engineBusy = useGameStore((s) => s.engineBusy);
  const pendingTreeMessage = useGameStore((s) => s.pendingTreeMessage);
  const closeOverlay = useGameStore((s) => s.closeOverlay);
  const refreshTree = useGameStore((s) => s.refreshTree);
  const setTreeFocus = useGameStore((s) => s.setTreeFocus);
  const sendTreeEdit = useGameStore((s) => s.sendTreeEdit);
  const forkAt = useGameStore((s) => s.forkAt);
  const switchToFork = useGameStore((s) => s.switchToFork);

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [value, setValue] = useState("");

  // 世界切换 / 编辑完成（treeStamp 自增）/ 手动刷新时重取树
  useEffect(() => {
    if (!worldId) {
      setMarkdown(null);
      setError("");
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setMarkdown(null);
    fetchTree(worldId, abort.signal)
      .then((r) => {
        if (!abort.signal.aborted) setMarkdown(r.markdown);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError" || abort.signal.aborted) return;
        const msg = (e as Error).message || String(e);
        // 404 = 本章尚未规划出树：给玩家一句人话
        setError(msg.includes("404") ? "本章还没有剧情树（开演前规划后出现）" : `剧情树加载失败：${msg}`);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [worldId, treeStamp]);

  // 解析失败（返回 null）时屏内回退显示原文
  const tree: StoryTree | null = useMemo(() => (markdown ? parseStoryTree(markdown) : null), [markdown]);

  // 当前章：优先带「当前进度」指针的章，否则取最后一章
  const chapter: TreeChapter | null = useMemo(() => {
    if (!tree || tree.chapters.length === 0) return null;
    const withCurrent = [...tree.chapters].reverse().find((c) => c.current);
    return withCurrent ?? tree.chapters[tree.chapters.length - 1];
  }, [tree]);

  // 布局（纯净函数）：节点矩形尺寸与画布尺寸一并定下
  const layout = useMemo(() => layoutTree(chapter, { nodeW: NODE_W, nodeH: NODE_H }), [chapter]);

  // 侧栏节点：treeFocus 命中当前章节点才显示
  const focusNode: TreeNode | null = useMemo(() => {
    if (!chapter || !treeFocus) return null;
    return chapter.nodes.find((n) => n.id === treeFocus) ?? null;
  }, [chapter, treeFocus]);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    setValue("");
    sendTreeEdit(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法选词的 Enter 不算发送
    if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
  };

  // 引擎忙或已有排队编辑：发送按钮禁用并提示（排队指令由 store 在 turn_end 后补发）
  const inputBlocked = engineBusy || pendingTreeMessage !== null;

  // 无世界线：不开图，给一句引导
  if (!worldId) {
    return (
      <ScreenShell className="bg-bg/70">
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="text-sm tracking-[.1em] text-ink/50">先开始或继续一条世界线，再来看剧情图</p>
        </div>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell className="bg-bg/70">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="absolute inset-0 flex flex-col"
      >
        {/* 头部：标题 + 刷新/返回 */}
        <header className="flex items-center px-6 pt-7">
          <h2 className="text-xl tracking-[.4em] [text-indent:.4em]">剧情图 · {worldLabel || worldId}</h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={refreshTree}
              className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
            >
              <RefreshCw size={12} /> 刷新
            </button>
            <button
              type="button"
              onClick={closeOverlay}
              className="rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
            >
              返回
            </button>
          </div>
        </header>

        {/* 提示条：编辑摘要 / 分叉结果 / 排队 */}
        {treeNotice && (
          <p
            data-testid="tree-notice"
            className="mx-6 mt-3 rounded-md border border-gold/25 bg-gold/10 px-3 py-1.5 text-[12px] tracking-[.05em] text-gold/90"
          >
            {treeNotice}
          </p>
        )}

        {/* 归档区：每章一行，横向滚动的紧凑药丸链 */}
        {tree && tree.archive.length > 0 && (
          <div data-testid="tree-archive" className="mx-6 mt-3 flex gap-2 overflow-x-auto pb-1">
            {tree.archive.map((line, i) => (
              <span
                key={i}
                className="whitespace-nowrap rounded-full border border-white/10 bg-white/[.03] px-3 py-1 text-[11.5px] text-ink/60"
              >
                {line}
              </span>
            ))}
          </div>
        )}

        {/* 分叉结果：可切到新世界线 */}
        {forkResult && (
          <div
            data-testid="tree-fork-result"
            className="mx-6 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2.5"
          >
            <p className="text-[13px] text-gold">
              已创建世界线 <span className="tracking-wide">{forkResult.worldId}</span>
            </p>
            <button
              type="button"
              data-testid="tree-switch"
              onClick={switchToFork}
              className="rounded-md border border-gold/35 bg-gold/15 px-3 py-1 text-[12.5px] text-gold transition-colors hover:bg-gold/30"
            >
              切到此世界线
            </button>
            <span className="text-[11px] tracking-[.08em] text-ink/45">分叉不推演，切换后从该节点续演</span>
          </div>
        )}

        {/* 主体：状态 → 画布 → 详情 */}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          {loading && <p className="mt-6 animate-pulse text-sm text-ink/50">载入剧情树…</p>}

          {!loading && error && (
            <p data-testid="tree-error" className="mt-6 text-sm text-red-400">
              {error}
            </p>
          )}

          {/* 解析失败：回退显示原文 */}
          {!loading && !error && markdown !== null && tree === null && (
            <pre
              data-testid="tree-raw"
              className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-[rgba(12,14,20,.6)] p-4 text-[12.5px] leading-relaxed text-ink/70"
            >
              {markdown}
            </pre>
          )}

          {!loading && !error && tree && tree.chapters.length === 0 && (
            <p className="mt-6 text-sm text-ink/50">当前世界还没有可绘制的章节节点</p>
          )}

          {!loading && !error && tree && chapter && (
            <TreeCanvas chapter={chapter} layout={layout} treeFocus={treeFocus} onFocus={setTreeFocus} />
          )}

          {focusNode && (
            <TreeDetail node={focusNode} engineBusy={engineBusy} onFork={forkAt} onClose={() => setTreeFocus(null)} />
          )}
        </div>

        {/* 底部输入行：一句话改树（引擎忙时排队） */}
        <div data-testid="tree-input" className="border-t border-white/[.06] px-6 py-4">
          {inputBlocked && (
            <p className="mb-2 text-right text-[11.5px] tracking-[.15em] text-ink/40">引擎忙，已排队，就绪后自动发送</p>
          )}
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="用一句话改这棵树…（例：在节点 3-1 后加一个雨夜遇袭的节点）"
              autoComplete="off"
              className="flex-1 rounded-lg border border-white/10 bg-[rgba(12,14,20,.8)] px-3.5 py-2.5 text-[15px] tracking-[.02em] outline-none transition-colors focus:border-gold/35"
            />
            <button
              type="button"
              data-testid="tree-send"
              disabled={inputBlocked}
              onClick={submit}
              className="rounded-lg border border-gold/35 bg-gold/15 px-5 text-[14px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink/30"
            >
              发送
            </button>
          </div>
        </div>
      </motion.div>
    </ScreenShell>
  );
}
