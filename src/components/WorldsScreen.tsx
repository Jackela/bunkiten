import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { motion } from "framer-motion";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { coverUrl, fetchWorlds, postWorld, worldExportUrl, type WorldEntry } from "../lib/acp";
import { genealogyStep, layoutGenealogy, type GenealogyLayout } from "../lib/genealogy";
import { CANVAS_ZOOM_STEP, useCanvasPanZoom } from "../lib/useCanvasPanZoom";
import { CanvasZoomToolbar } from "./CanvasZoomToolbar";
import { tabThroughMenu } from "../lib/menuTab";
import { truncate } from "../lib/text";
import { isLegacyForkNote } from "../lib/worlds";
import { getTheme, themeVars } from "../theme";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { ShellPage } from "./ShellPage";

/** 列表行进出：与创作屏气泡同款克制位移淡入 */
const ROW = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } } as const;

/** 「更早」阈值（ms）：超过 30 天不再报天数 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** 显示名/备注的字数上限（与 server POST /api/worlds update 校验一致，超了服务端会拒） */
const LABEL_MAX = 60;
const NOTE_MAX = 200;

/** ⋯ 菜单项基类（三项共用；删除/确认项在其后追加红色 hover 类） */
const MENU_ITEM_CLS =
  "w-full rounded-lg px-3 py-2 text-left text-ui text-ink-hint transition-colors hover:bg-white/[.06] hover:text-ink";

/** 菜单项里「选中即关」的例外：两段确认要留在菜单里、导出要等下载派发完再关，都自己收尾 */
const KEEP_MENU_OPEN = (event: Event) => event.preventDefault();

/**
 * Esc 就地关菜单、且**不许**冒到 App 的 Esc 关闭链（那一下会把整屏关回标题屏）。
 * Radix 的 DismissableLayer 在 document 的**捕获阶段**监听 Esc，这里在它那一拍上 stopPropagation：
 * 事件到此为止，既到不了 target 冒泡，也到不了挂在 window 上的关闭链；关菜单由 Radix 的 onDismiss
 * 继续（它看的是 defaultPrevented，我们没 preventDefault，所以不会被跳过）。
 */
const swallowEscape = (event: KeyboardEvent) => event.stopPropagation();

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
 * 行的显示名（纯函数，供单测）：显示名 label → 备注 note → 剧本名 → 「未命名世界线」。
 * 末两档是刻意的：**裸 worldId 永远不上玩家的屏**（它只活在目录名、导出文件名与日志里）。
 * 备注这一档还要过 {@link isLegacyForkNote}：旧版 server 给分叉世界自动写的「分叉自 <id> @ <节点>」
 * 正是裸 id 串，显示层把它当作「没有备注」，让位给剧本名——分叉关系由徽标（forkPhrase）交代。
 * @param {WorldEntry} w 世界线条目
 * @param {string} [presetTitle] 当前剧本标题（没显示名也没备注时的兜底）
 * @returns {string} 行主行文案
 */
export function worldDisplayName(w: WorldEntry, presetTitle = ""): string {
  const note = isLegacyForkNote(w.note) ? "" : w.note;
  return w.label?.trim() || note?.trim() || presetTitle.trim() || "未命名世界线";
}

/**
 * 分叉说明（纯函数，供单测）：父线还在清单里 → 「自《父线显示名》延伸」；父线已删（不在清单里）
 * → 「自已删除的父线延伸」。两侧都不露裸 worldId/nodeId——玩家看的是血缘的名字，不是目录名。
 * @param {{worldId: string}} fork 分叉来源（WorldEntry.forkedFrom）
 * @param {WorldEntry[]} worlds 当前清单（把父线 id 还原成显示名的唯一来源）
 * @param {string} [presetTitle] 剧本标题兜底（父线自身也没 label/note 时用）
 * @returns {string} 徽标与无障碍文案里的分叉说明
 */
export function forkPhrase(fork: { worldId: string }, worlds: WorldEntry[], presetTitle = ""): string {
  const parent = worlds.find((w) => w.worldId === fork.worldId);
  return parent ? `自《${worldDisplayName(parent, presetTitle)}》延伸` : "自已删除的父线延伸";
}

/** 家谱节点绘制尺寸：须与 layoutGenealogy 的缺省几何一致（布局定坐标、SVG 画矩形） */
const GEN_NODE_W = 210;
const GEN_NODE_H = 64;

/** 单节点最大渲染宽度（px）：家谱只有两三张卡时，`<svg w-full>` 会把 viewBox 等比放大到
    ~490px/节点（屏幕大半空着、卡片像放大的缩略图）。画布渲染宽度据此封顶，落回 260–280px 档。
    只封**上界**：森林更宽时这个上界够不着，画布照旧铺满可用宽度。 */
const GEN_MAX_NODE_PX = 270;

/**
 * 家谱画布（v1.7 / v1.8 缩放平移）：把 forkedFrom 血缘的森林画成 SVG——节点 = 圆角矩形卡
 * （显示名/章数/分叉徽章），边 = 父底边中点 → 子顶边中点的圆角拐弯。整图一个可 Tab 的节点
 * （roving tabIndex），方向键走节点（`genealogyStep` 的确定性规则）、Enter/点击选中。
 * 视图能力（滚轮缩放锚点 / 拖拽平移 / 双击复位 / ± 与「适应」按钮 / `+ - 0`）复用
 * `lib/treeLayout` 的 TreeView 纯函数与剧情图 TreeCanvas 的交互约定，不另写一套几何。
 *
 * 两条非显而易见的不变量：
 * 1) 画布渲染宽度**只封上界**（GEN_MAX_NODE_PX）：家谱小的时候 `<svg w-full>` 会把 viewBox
 *    等比放大到 ~490px/节点，封顶后落回 260–280px；森林更宽时上界够不着 → 照旧铺满可用宽度。
 * 2) 画布容器的键盘只认 `+ - 0`（缩放）；节点自己的按键只认方向键/Enter/Space（走位/选中）——
 *    两套键位不相交，节点没消费的按键照旧冒泡到容器，故与 `genealogyStep` 不抢键。
 * 焦点环走全局 :focus-visible（同 TreeCanvas）。
 * SVG 里的 fontSize 是 viewBox 坐标系里的数值、随画布整体缩放，故不走文字阶梯类。
 */
function GenealogyCanvas({
  layout,
  worlds,
  presetTitle,
  focusId,
  onFocus,
}: {
  layout: GenealogyLayout;
  /** 当前清单：把 forkedFrom 的父线 id 换成分叉说明里的显示名 */
  worlds: WorldEntry[];
  presetTitle: string;
  focusId: string | null;
  onFocus: (id: string) => void;
}) {
  // 视图 + 指针/滚轮/键盘缩放全在共享 hook 里（与剧情图画布同一份实现，见 lib/useCanvasPanZoom.ts）
  const canvas = useCanvasPanZoom(layout);
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

  /**
   * 画布键盘：`+`/`=` 放大、`-`/`_` 缩小、`0` 适应（都在共享 hook 里）。
   * 与节点级按键（方向键/Enter/Space）不相交，节点未消费的按键冒泡到这里 —— 两套键位可以共存。
   */
  const onCanvasKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return; // 中文输入法组字中的按键不算快捷键
    canvas.onZoomKeyDown(e);
  };

  /** 渲染宽度上界：单节点 ≤ GEN_MAX_NODE_PX（`layout.width × (270 / 210)`；forest 更宽时上界不起作用） */
  const maxRenderW = Math.round(layout.width * (GEN_MAX_NODE_PX / GEN_NODE_W));

  return (
    <div data-testid="genealogy-canvas-wrap" onKeyDown={onCanvasKey} className="mt-1">
      {/* 工具条：缩放控件 + 鼠标/键盘提示。提示放这一行（画布之上）而不是屏脚：
          画布高时屏脚会被顶到折叠线以下，1440×900 不滚动就看不到 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-meta tracking-[.05em] text-ink-hint">
        <CanvasZoomToolbar
          testIdPrefix="genealogy"
          zoomPct={canvas.zoomPct}
          onZoomIn={() => canvas.zoomBy(CANVAS_ZOOM_STEP)}
          onZoomOut={() => canvas.zoomBy(1 / CANVAS_ZOOM_STEP)}
          onFit={canvas.fit}
          iconSize={13}
          levelClassName="ml-1 w-10 text-right"
        />
        <span className="ml-auto">滚轮缩放 · 拖拽平移 · 双击复位 · 方向键走节点</span>
      </div>

      {/* 上界盒子（只封渲染宽度，mx-auto 居中）：森林更大时上界够不着，照旧铺满可用宽度 */}
      <div data-testid="genealogy-canvas-cap" className="mx-auto w-full" style={{ maxWidth: `${maxRenderW}px` }}>
        <svg
          ref={canvas.svgRef}
          data-testid="genealogy-canvas"
          viewBox={canvas.viewBox}
          preserveAspectRatio="xMidYMid meet"
          className="block w-full cursor-grab touch-none rounded-xl border border-white/[.06] bg-panel active:cursor-grabbing"
          style={{ height: "auto", aspectRatio: `${layout.width} / ${layout.height}` }}
          onPointerDown={canvas.onPointerDown}
          onPointerMove={canvas.onPointerMove}
          onPointerUp={canvas.onPointerUp}
          onPointerCancel={canvas.onPointerUp}
          onDoubleClick={canvas.onDoubleClick}
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
            const name = worldDisplayName(n.entry, presetTitle);
            const forkText = fork ? forkPhrase(fork, worlds, presetTitle) : "";
            // 徽章（⑂ / ⌫ ⑂）右对齐占掉约 3em：带徽章的卡显示名收窄到 10 字，
            // 否则 fontSize 14 的最宽字形（CJK ≈ 1em）会顶到徽章上
            const badged = Boolean(fork) || n.missingParent;
            return (
              <g
                key={n.worldId}
                data-testid={`genealogy-node-${n.worldId}`}
                role="button"
                tabIndex={n.worldId === tabbableId ? 0 : -1}
                aria-label={`世界线 ${name} · 第 ${n.entry.chapterNo} 章${forkText ? ` · ${forkText}` : ""}${
                  missing ? " · 目录缺失" : ""
                }`}
                onClick={() => {
                  // 拖完手抬起那一下不算点选（否则平移顺手就把节点选中了）
                  if (canvas.consumeDragged()) return;
                  onFocus(n.worldId);
                }}
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
                {/* 显示名超长时截断（SVG text 不会自动省略）；n 按最宽字形（CJK ≈ 1em）估算 */}
                <text
                  x={n.x + 12}
                  y={n.y + 25}
                  style={{ fill: "var(--ink)" }}
                  fontSize={14}
                  fontWeight={600}
                  letterSpacing="0.06em"
                >
                  {truncate(name, badged ? 10 : 12)}
                </text>
                <text x={n.x + 12} y={n.y + 46} style={{ fill: "var(--ink)", opacity: 0.55 }} fontSize={12}>
                  第 {n.entry.chapterNo} 章
                </text>
                {/* 分叉徽章：只留「分叉了」这个信号（⑂），节点 id 不上屏；父线已删的孤儿前面加 ⌫ */}
                {badged && (
                  <text
                    data-testid={n.missingParent ? `genealogy-orphan-${n.worldId}` : undefined}
                    x={n.x + GEN_NODE_W - 12}
                    y={n.y + 25}
                    textAnchor="end"
                    style={{ fill: n.missingParent ? "rgba(248,113,113,.9)" : "var(--accent)", opacity: 0.9 }}
                    fontSize={12}
                    letterSpacing="0.08em"
                  >
                    {n.missingParent ? "⌫ ⑂" : "⑂"}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/**
 * 行缩略图（ROADMAP §5）：整屏的世界线都属同一个剧本（清单本来按 `fetchWorlds(presetId)` 过滤），
 * 所以不必给每条世界线各存一张图——直接复用剧本封面 `coverUrl(entry.preset)`（`/img` 白名单直服
 * `presets/<id>/cover.jpg`，零服务端改动）。尺寸 56×40（`h-10 w-14`），行高由右边的文字块决定。
 *
 * 三条不显然的约定：
 * 1) **盒子常驻、图片可缺席**：外层 span 恒定 56×40，`onError` 只把 `<img>` 摘掉，留下这层中性底
 *    （`bg-white/[.03]`，与行内徽标同底）。没有 cover.jpg 的剧本并不罕见（导入进来的剧本、假栈里的
 *    preset 目录默认都没有那张图），404 既不能留破图、也不能让行高抖动——固定尺寸的盒子让「有无封面」
 *    两态在布局上完全同形。与标题屏的 `CardCover` 同一种「回退 = 不渲染」的写法，
 *    差别只是那里回退成主题渐变、这里回退成占位块。
 * 2) `alt=""`：装饰性图像——显示名就在右边文字块里，再给一句 alt 等于让读屏把同一个名字念两遍。
 * 3) `pointer-events-none`：缩略图不是交互元素，行的点击/键盘（选中、roving tabIndex、⋯ 菜单）全归行自己。
 *
 * 刻意**没做**「该世界当前场景背景」那一版：`WorldEntry` 不带任何图字段（ROADMAP §5 记了这笔账）。
 * @param {string} preset 剧本 id（封面按剧本取，与本世界线的章数/节点无关）
 * @param {string} worldId 世界 id（只用于 data-testid，便于 e2e 按行点名）
 */
function RowCover({ preset, worldId }: { preset: string; worldId: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      data-testid={`world-cover-${worldId}`}
      className="pointer-events-none h-10 w-14 flex-none overflow-hidden rounded-md border border-white/[.07] bg-white/[.03]"
    >
      {!failed && (
        <img
          data-testid={`world-cover-img-${worldId}`}
          src={coverUrl(preset)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="pointer-events-none h-full w-full object-cover"
        />
      )}
    </span>
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
 * v1.8：壳层页框（ShellPage：眉标 = 剧本名 + 题材/分级，右栏 = 继续上次 + 键盘）；行从「四个按钮平铺」
 * 收成**一个主行动（继续）+ 一个 ⋯ 菜单**（改名/导出/删除，删除的两段确认收在菜单内：菜单一关即作废）；
 * 文案去掉裸 id（`worldDisplayName`/`forkPhrase`），字号走 global.css 的档位类。
 * v1.8 家谱画布：缩放平移（滚轮锚点 / 拖拽 / 双击 / ± 与适应 / `+ - 0`，复用 `lib/treeLayout` 的
 * TreeView 纯函数）、渲染宽度只封上界（小森林不再把节点撑到 ~490px）、详情条吸底 +
 * 提示挂在画布工具条（1440×900 不滚动即可见）。
 * v1.9：行 ⋯ 菜单迁到 **Radix DropdownMenu**（`@radix-ui/react-dropdown-menu`，ROADMAP 第 3 项的第一面）。
 * 原语接走了手写的那几样：↑↓/Home/End 走位、typeahead、`role="menu"/menuitem` 与 `aria-haspopup/expanded/controls`、
 * Esc 与点外面关闭、开时焦点进第一项、关时焦点归还触发器、贴边自动翻面。因此**删掉**了手写的三处 document 级
 * 监听（mousedown 判点外 / 捕获阶段 Esc / focusin 出走）与 `menuUp` 的 offsetHeight 量高。
 * 两件本屏仍自己管：① Esc 靠 `onEscapeKeyDown` 就地 stopPropagation（Radix 在 document 捕获阶段监听，
 * 不拦就会继续冒到 App 挂在 window 上的 Esc 关闭链，那一下连整屏一起关回标题屏）；② Tab 走项
 * （Radix 的菜单项 tabIndex=-1 且内容会吞掉 Tab，见 `onMenuKeyDown`）。
 * 弹层**不 portal**：主题变量注入在 App 根容器而非 `:root`，portal 到 body 会掉回初始 accent。
 * v1.9 行缩略图（ROADMAP §5）：行首加 56×40 的剧本封面（`coverUrl(entry.preset)`，`/img` 白名单直服，
 * 零服务端改动，见 `RowCover`）——没有 cover.jpg 的剧本靠 `onError` 缩掉图片、只留同尺寸占位块，
 * 破图与行高抖动都不允许；`alt=""` + `pointer-events-none`（装饰性、不抢行的点击与键盘）。
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
  /** 剧本标题：显示名与分叉说明的最后一道兜底（合成显示名只在屏内算，不进 store/服务端） */
  const presetTitle = selected?.title ?? "";

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
  /** 打开着 ⋯ 菜单的世界 id（同屏只开一个；null=全关） */
  const [menuId, setMenuId] = useState<string | null>(null);

  /** 行元素引用：↑↓ 把 DOM 焦点一起搬到光标行（roving tabIndex 的完整语义，不是只换个描边） */
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /** 隐藏 file input（导入入口按钮点它） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 打开编辑器时把光标送进「显示名」输入框 */
  const labelRef = useRef<HTMLInputElement | null>(null);
  /** 打开着的那行 ⋯ 菜单的弹层本体（把焦点送进第一项、Tab 走项都按它查菜单项） */
  const [menuPopup, setMenuPopup] = useState<HTMLDivElement | null>(null);
  /** 弹层节点的挂载回调：用 state 而不是 ref —— Radix 的 Presence 比本屏的状态晚一拍才把弹层挂上来，
   *  ref 在本屏那次 effect 里还是 null（拿不到节点就没法把焦点送进第一项），state 变更能再触发一轮 effect */
  const attachMenuPopup = useCallback((node: HTMLDivElement | null) => setMenuPopup(node), []);
  /**
   * 关菜单时**不要**把焦点归还触发器：焦点已经由我们自己安置（进改名编辑器 / Tab 走出菜单）。
   * Radix 在弹层卸载时默认把焦点送回触发器（DropdownMenuContent 的 onCloseAutoFocus），
   * 那一下会把玩家刚点开的输入框焦点甩掉（编辑器里打字打到一半光标就飞了）。
   */
  const keepFocusOnCloseRef = useRef(false);

  /**
   * 关菜单：同时撤销半截删除确认（重开菜单回到「改名/导出/删除」第一屏）。
   * 三条关法都汇到这里：Radix 的 onOpenChange(false)（Esc / 点外面 / 焦点出走 / 选中即关）。
   */
  const closeMenu = useCallback(() => {
    setMenuId(null);
    setConfirmId(null);
  }, []);

  const list = useMemo(() => worlds ?? [], [worlds]);

  // 家谱布局（纯函数）：worlds 变化（删除/导入/改名重取）时重算
  const genealogy = useMemo(
    // 画布常量显式传进布局（StoryTreeScreen 的惯例）：单侧改尺寸不会让 rect 与坐标静默错位
    () => layoutGenealogy(list, { nodeW: GEN_NODE_W, nodeH: GEN_NODE_H }),
    [list],
  );

  /** aside「继续上次」的世界：清单里最近游玩的那条（不依赖 fetch 的排序，自己取最大 lastPlayed） */
  const lastWorld = useMemo(
    () => list.reduce<WorldEntry | null>((best, w) => (!best || w.lastPlayed > best.lastPlayed ? w : best), null),
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

  // 菜单开着时把焦点送进第一项（键盘路径：⋯ 上 Enter → 菜单第一项已聚焦 → ↓ 走位/Tab 前进；
  // 鼠标路径 Radix 默认只把焦点落在弹层上，这里一并收齐，两种打开方式结果一致）。
  // confirmId 也进依赖：删除→确认这一拍里「第一项」变成了确认按钮，焦点要跟着换过去
  // （否则被替换掉的「删除」按钮会把焦点丢回 body）。
  useEffect(() => {
    if (!menuId || !menuPopup) return;
    menuPopup.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuId, confirmId, menuPopup]);

  /** 键盘：↑↓ 移动高亮，Enter 继续高亮的世界线；确认态/编辑态/菜单开着时全部让位。
   *  家谱视图下让位（方向键由家谱节点自己接，Enter 只选中不清档续演） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return; // 中文输入法组字中的按键不算导航
      if (view !== "list") return; // 家谱视图：节点级键盘，不做屏级列表导航
      if (confirmId || editId || menuId) return; // 确认删除/行内改名/菜单开着：不拦截
      const el = e.target instanceof HTMLElement ? e.target : null;
      // 焦点在按钮/输入框上时不做屏级导航，避免 Enter 被激活两次（⋯ 菜单项也在这条里）
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
  }, [confirmId, editId, menuId, engineBusy, focus, list, resumeWorld, view]);

  /** 继续：目录缺失或引擎忙时不可用（resumeWorld 会立刻发续演指令） */
  const continueWorld = (entry: WorldEntry) => {
    if (!entry.exists || engineBusy) return;
    resumeWorld(entry);
  };

  /**
   * ⋯ 开菜单：清掉上一次的行内提示，半截删除确认归零。
   * 开/关的切换交给 Radix 的触发器（pointerdown 与 Enter/Space/↓），屏内只接 onOpenChange。
   */
  const openMenuFor = (entry: WorldEntry) => {
    setActionError("");
    setActionNotice("");
    setConfirmId(null);
    setMenuId(entry.worldId);
  };

  /**
   * 菜单内容区的键盘：Tab 在菜单项之间走位（本仓既有约定：Tab 走项、Esc 收菜单，见
   * tests/e2e-ui/worlds.spec.ts 的键盘用例；键位速查卡里也写着「Tab 行内按钮与 ⋯ 菜单」）。
   * 走位本体在 lib/menuTab（命令轨的分组菜单同样吃它，两个菜单的键位只有一套）；这里只剩组字让路。
   */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) {
      event.preventDefault(); // 中文输入法组字中的按键不算导航/typeahead（本仓惯例）
      return;
    }
    if (event.key !== "Tab") return;
    tabThroughMenu(event.nativeEvent, event.currentTarget);
  };

  /** 弹层卸载时 Radix 默认把焦点送回触发器；玩家进的是行内编辑器时别抢（见 keepFocusOnCloseRef） */
  const onMenuCloseAutoFocus = (event: Event) => {
    if (!keepFocusOnCloseRef.current) return;
    keepFocusOnCloseRef.current = false;
    event.preventDefault();
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

  /** 删除（第二段确认触发）：成功即重取清单并提示去向（回收站可找回），失败在列表上方行内报错 */
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
        closeMenu();
        setDeleting(null);
        // trashed:false = 回收站 rename 失败、服务端已回退直删——文案不能再说「可找回」
        setActionNotice(r.trashed === false ? "已删除（未能进回收站，无法找回）" : "已移入回收站，可从数据目录找回");
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

  /** aside「键盘」卡的提示行：视图不同、可用键不同（与页脚那条一句话提示互补） */
  const keyHints: [string, string][] =
    view === "list"
      ? [
          ["↑ ↓", "选择世界线"],
          ["Enter", "读档续演"],
          ["Tab", "行内按钮与 ⋯ 菜单"],
          ["Esc", "关菜单 / 返回标题"],
        ]
      : [
          ["方向键", "走血缘节点"],
          ["Enter", "选中节点"],
          ["+ − 0", "缩放 / 适应"],
          ["Tab", "快捷条按钮"],
          ["Esc", "返回标题"],
        ];

  return (
    <ScreenShell className="overflow-y-auto shell-backdrop" style={themeVars(getTheme(selected))}>
      <div data-testid="worlds-screen" className="min-h-full">
        <ShellPage
          // 眉标：剧本名 + 题材/分级（不再用药丸，评级不是标签墙而是这一行的元信息）
          eyebrow={
            selected ? (
              <>
                {selected.title}
                <span className="text-ink-hint"> · {selected.genre} · {selected.rating}</span>
              </>
            ) : undefined
          }
          title="世 界 线"
          aside={
            <div className="space-y-4 xl:sticky xl:top-8">
              {/* 继续上次：最近游玩的那条（aside 里的快捷入口，复用行上那个 continueWorld） */}
              <section data-testid="worlds-resume-card" className="shell-panel rounded-2xl p-4">
                <h2 className="text-ui tracking-[.25em] text-gold/80">继 续 上 次</h2>
                {lastWorld ? (
                  <>
                    <p className={`mt-3 truncate text-body ${lastWorld.exists ? "text-ink" : "text-ink-hint"}`}>
                      {worldDisplayName(lastWorld, presetTitle)}
                    </p>
                    <p className="mt-1 text-meta text-ink-hint">
                      第 {lastWorld.chapterNo} 章 · {relativeTime(lastWorld.lastPlayed)}
                      {!lastWorld.exists && <span className="ml-2 text-red-400/90">目录缺失</span>}
                    </p>
                    <button
                      type="button"
                      data-testid="worlds-resume-continue"
                      aria-label={`继续上次的世界线 ${worldDisplayName(lastWorld, presetTitle)}`}
                      disabled={!lastWorld.exists || engineBusy}
                      title={!lastWorld.exists ? "目录缺失" : engineBusy ? "忙碌中，稍后再试" : undefined}
                      onClick={() => continueWorld(lastWorld)}
                      className={`mt-3 w-full rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                        !lastWorld.exists || engineBusy
                          ? "cursor-not-allowed border-white/10 text-ink-hint"
                          : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                      }`}
                    >
                      {engineBusy ? "忙碌中" : "继续"}
                    </button>
                  </>
                ) : (
                  <p className="mt-3 text-meta leading-relaxed text-ink-hint">
                    开一条新世界线后，最近游玩的那条会出现在这里。
                  </p>
                )}
              </section>

              {/* 键盘卡：屏级快捷键的速查（行内 ⋯ 菜单是行上的入口，不占列表宽度） */}
              <section data-testid="worlds-keys-card" className="shell-panel rounded-2xl p-4">
                <h2 className="text-ui tracking-[.25em] text-gold/80">键 盘</h2>
                <dl className="mt-3 grid gap-1.5">
                  {keyHints.map(([key, hint]) => (
                    <div key={key} className="flex gap-3 text-meta">
                      <dt className="w-16 flex-none text-ink-body">{key}</dt>
                      <dd className="min-w-0 text-ink-hint">{hint}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          }
          actions={
            <>
              {/* 视图切换（v1.7）：平铺列表 ↔ forkedFrom 家谱森林（分段按钮） */}
              <div role="group" aria-label="世界线视图" className="flex items-center rounded-lg border border-white/10 p-0.5">
                <button
                  type="button"
                  data-testid="worlds-view-list"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                  className={`rounded-md px-3 py-1 text-ui tracking-[.15em] transition-colors ${
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
                  className={`rounded-md px-3 py-1 text-ui tracking-[.15em] transition-colors ${
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
                className="rounded-lg border border-white/10 px-4 py-2 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
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
                className="rounded-lg border border-gold/35 bg-gold/15 px-5 py-2 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
              >
                {creating ? "创建中…" : "新世界线"}
              </button>
              <button
                type="button"
                onClick={toTitle}
                className="rounded-lg border border-white/10 px-4 py-2 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-[color:var(--accent)]"
              >
                返回
              </button>
            </>
          }
          // 家谱视图不铺页脚：画布会把页脚顶到折叠线以下，那里的提示改挂在画布工具条上（始终可见）
          footer={view === "list" ? "↑ ↓ 选择 · Enter 继续" : undefined}
        >
          {selected?.tagline && (
            <p className="mb-5 max-w-3xl text-ui leading-relaxed text-ink-body">{selected.tagline}</p>
          )}

          {/* 提示位：导入/改名的成功与失败（删除/新建的行内提示在下面） */}
          {worldNotice && (
            <p
              data-testid="worlds-notice"
              data-kind={worldNotice.kind}
              className={`mb-3 rounded-xl border px-4 py-2.5 text-ui leading-relaxed backdrop-blur-md ${
                worldNotice.kind === "error"
                  ? "border-red-400/25 bg-panel text-red-400"
                  : "border-gold/25 bg-gold/10 text-gold/90"
              }`}
            >
              {worldNotice.text}
            </p>
          )}

          {/* 行内动作提示：错误（红）与删除成功的回收站去向（金）各一行 */}
          {actionError && <p className="mb-3 text-ui text-red-400">{actionError}</p>}
          {actionNotice && <p className="mb-3 text-ui text-gold/80">{actionNotice}</p>}

          {/* 加载 / 失败态 */}
          {loading && worlds === null && !error && (
            <p className="mb-3 animate-pulse text-ui text-ink-hint">清点世界线…</p>
          )}
          {error && (
            <div
              data-testid="worlds-error"
              className="mb-3 flex items-center gap-3 rounded-xl border border-red-400/25 bg-panel px-4 py-3 backdrop-blur-md"
            >
              <p className="text-ui text-red-400">世界线加载失败：{error}</p>
              <button
                type="button"
                data-testid="worlds-retry"
                onClick={() => setStamp((v) => v + 1)}
                className="ml-auto flex-none rounded-md border border-gold/35 px-3 py-1.5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/20"
              >
                重试
              </button>
            </div>
          )}

          {/* 空态 */}
          {!error && worlds !== null && list.length === 0 && (
            <div
              data-testid="worlds-empty"
              className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/15 bg-panel px-6 py-10 backdrop-blur-md"
            >
              <p className="text-body tracking-[.12em] text-ink-hint">还没有世界线——开始新的吧</p>
              <p className="text-meta tracking-[.2em] text-ink-hint">新世界线从捏人开始</p>
            </div>
          )}

          {/* 世界列表（列表视图）：listbox + option，光标行独占 tabIndex 0（roving tabIndex）。
              行上一个主行动（继续）+ 一个 ⋯ 菜单（改名/导出/删除）；菜单按钮恒在自己的 Tab 位
              （tabIndex 0），行的 roving 只管行本身。
              家谱视图下整块卸载：行的存在与否就是视图状态本身（测试与读屏都以此为准） */}
          {view === "list" && (
            <div role="listbox" aria-label="世界线" className="space-y-2.5">
              {list.map((entry, i) => {
                const missing = !entry.exists;
                const confirming = confirmId === entry.worldId;
                const busy = deleting === entry.worldId;
                const editing = editId === entry.worldId;
                const name = worldDisplayName(entry, presetTitle);
                const openMenu = menuId === entry.worldId;
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
                    // relative + z-20（仅菜单开着的那行）：framer-motion 留在行上的 transform 会让行自建层叠上下文，
                    // 弹出层因此逃不出自己的行——不抬行的话后面的行会盖在菜单上（真的盖住，点不到）
                    className={`relative rounded-xl border bg-panel px-4 py-3 backdrop-blur-md transition-colors ${
                      openMenu ? "z-20" : ""
                    } ${i === focus ? "border-gold/40" : "border-white/10 hover:border-gold/25"}`}
                  >
                    <div className="flex items-center gap-3">
                      {/* 行缩略图：剧本封面（本屏的清单本来就按剧本过滤），无 cover.jpg 时只剩同尺寸占位块 */}
                      <RowCover preset={entry.preset} worldId={entry.worldId} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`truncate text-body ${missing ? "text-ink-hint" : "text-ink"}`}>{name}</span>
                          {entry.forkedFrom && (
                            <span className="flex-none rounded-sm border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-meta tracking-[.12em] text-ink-hint">
                              {forkPhrase(entry.forkedFrom, list, presetTitle)}
                            </span>
                          )}
                          {pendingResync?.worldId === entry.worldId && (
                            <span
                              data-testid={`world-resync-${entry.worldId}`}
                              className="flex-none rounded-sm border border-gold/40 px-1.5 py-0.5 text-meta tracking-[.12em] text-gold/90"
                            >
                              待重同步
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-meta tracking-[.12em] text-ink-hint">
                          第 {entry.chapterNo} 章 · {relativeTime(entry.lastPlayed)}
                          {missing && <span className="ml-2 text-red-400/90">目录缺失</span>}
                        </p>
                        {/* 显示名与备注都有时，备注降为次行（分叉说明这类信息不该被显示名吃掉）。
                            旧版 server 自动写的分叉备注是裸 id 串，不算备注——次行不铺（分叉关系看徽标） */}
                        {entry.label?.trim() && entry.note?.trim() && !isLegacyForkNote(entry.note) && (
                          <p data-testid={`world-note-${entry.worldId}`} className="mt-1 truncate text-meta text-ink-hint">
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
                          title={missing ? "目录缺失" : engineBusy ? "忙碌中，稍后再试" : undefined}
                          onClick={() => continueWorld(entry)}
                          className={`rounded-lg border px-3.5 py-1.5 text-ui tracking-[.1em] transition-colors ${
                            missing || engineBusy
                              ? "cursor-not-allowed border-white/10 text-ink-hint"
                              : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                          }`}
                        >
                          {engineBusy ? "忙碌中" : "继续"}
                        </button>

                        {/* ⋯ 菜单（v1.9：迁到 Radix DropdownMenu，非 portal）。原语负责：↑↓/Home/End 的
                            roving 走位、typeahead（按菜单项文案前缀匹配，默认 1s 内连击拼接）、
                            role=menu/menuitem 与 aria-haspopup/aria-expanded/aria-controls、Esc 与点外面关闭
                            （DismissableLayer：Esc 走 document 捕获阶段，我们在它那一拍 stopPropagation，
                            见 swallowEscape）、开时焦点进第一项、关时焦点归还触发器、擦边时翻到触发器上方（flip）。
                            本屏自己留的：删除的两段确认（收在菜单里）、导出下载的延后关、Tab 走位（见 onMenuKeyDown）。
                            刻意**不** portal 到 body：主题 CSS 变量注入在 App 根容器而不是 :root，portal 出去
                            会掉回 global.css 的初始 accent（见 docs/ROADMAP.md 第 3 项）。modal=false：
                            菜单不是模态——不 aria-hidden 背景、不锁滚动、Tab 可以走出菜单。
                            菜单按钮不是 roving 的一部分——每行都有自己的 Tab 位，读屏/键盘随时够得着 */}
                        <div className="relative">
                          <DropdownMenu.Root
                            modal={false}
                            open={openMenu}
                            onOpenChange={(next) => (next ? openMenuFor(entry) : closeMenu())}
                          >
                            <DropdownMenu.Trigger
                              data-testid={`world-menu-${entry.worldId}`}
                              aria-label={`世界线 ${name} 的更多操作`}
                              className={`rounded-lg border px-3 py-1.5 text-ui tracking-[.1em] transition-colors ${
                                openMenu
                                  ? "border-gold/40 text-ink"
                                  : "border-white/10 text-ink-hint hover:border-gold/40 hover:text-ink"
                              }`}
                            >
                              ⋯
                            </DropdownMenu.Trigger>

                            <DropdownMenu.Content
                              ref={attachMenuPopup}
                              data-testid={`world-menu-popup-${entry.worldId}`}
                              // 向下展开、右对齐、留 6px 缝（等价于原来的 right-0 mt-1）；贴到视口底边时 Radix 自动翻上去
                              side="bottom"
                              align="end"
                              sideOffset={6}
                              onEscapeKeyDown={swallowEscape}
                              onCloseAutoFocus={onMenuCloseAutoFocus}
                              onKeyDown={onMenuKeyDown}
                              className="z-20 grid w-44 gap-0.5 shell-panel rounded-xl p-1"
                            >
                              {/* 两段式确认收在菜单里：首点「删除」变「确认删除/取消」，二点才发删除。
                                  三项都 preventDefault 掉「选中即关」：确认态要留在菜单里，导出要等下载派发完 */}
                              {confirming ? (
                                <>
                                  <DropdownMenu.Item asChild disabled={busy} onSelect={KEEP_MENU_OPEN} onClick={() => removeWorld(entry)}>
                                    <button
                                      type="button"
                                      data-testid={`world-confirm-${entry.worldId}`}
                                      aria-label={`确认删除世界线 ${name}`}
                                      disabled={busy}
                                      className={`${MENU_ITEM_CLS} text-red-300 hover:bg-red-500/20 hover:text-red-200 disabled:cursor-not-allowed disabled:text-ink-faint`}
                                    >
                                      {busy ? "删除中…" : "确认删除"}
                                    </button>
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item asChild disabled={busy} onSelect={KEEP_MENU_OPEN} onClick={() => setConfirmId(null)}>
                                    <button
                                      type="button"
                                      data-testid={`world-cancel-${entry.worldId}`}
                                      aria-label={`取消删除世界线 ${name}`}
                                      disabled={busy}
                                      className={`${MENU_ITEM_CLS} disabled:cursor-not-allowed disabled:text-ink-faint`}
                                    >
                                      取消
                                    </button>
                                  </DropdownMenu.Item>
                                </>
                              ) : (
                                <>
                                  <DropdownMenu.Item
                                    asChild
                                    onClick={() => {
                                      // 关菜单后焦点归输入框（不是触发器）——Radix 的关闭自动对焦要因此让开
                                      keepFocusOnCloseRef.current = true;
                                      closeMenu();
                                      // 该行已经在改名：只把光标送回输入框，别用服务端现值盖掉玩家还没保存的改动
                                      if (editing) labelRef.current?.focus();
                                      else openEdit(entry);
                                    }}
                                  >
                                    <button
                                      type="button"
                                      data-testid={`world-edit-${entry.worldId}`}
                                      aria-label={`改名世界线 ${name}`}
                                      className={MENU_ITEM_CLS}
                                    >
                                      改名
                                    </button>
                                  </DropdownMenu.Item>
                                  {/* 导出走浏览器下载：href 指向 /api/worlds/export（服务端带 Content-Disposition），
                                      download 属性给本地落盘兜一个 <worldId>.world.json 的名字。
                                      关菜单推迟一拍：浏览器要等事件派发走完才执行 <a download> 的默认动作，
                                      在这一拍里把它卸载掉会把下载掐掉；`onSelect` 的 preventDefault 是同一件事的另一半——
                                      Radix 默认「选中即关」，不拦的话菜单在 click 那一拍就没了。 */}
                                  <DropdownMenu.Item asChild onSelect={KEEP_MENU_OPEN}>
                                    <a
                                      href={worldExportUrl(entry.worldId)}
                                      download={`${entry.worldId}.world.json`}
                                      data-testid={`world-export-${entry.worldId}`}
                                      aria-label={`导出世界线 ${name}`}
                                      onClick={() => window.setTimeout(closeMenu, 0)}
                                      className={`${MENU_ITEM_CLS} block`}
                                    >
                                      导出
                                    </a>
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item
                                    asChild
                                    onSelect={KEEP_MENU_OPEN}
                                    onClick={() => {
                                      setActionError("");
                                      setActionNotice("");
                                      setConfirmId(entry.worldId);
                                    }}
                                  >
                                    <button
                                      type="button"
                                      data-testid={`world-delete-${entry.worldId}`}
                                      aria-label={`删除世界线 ${name}`}
                                      className={`${MENU_ITEM_CLS} hover:bg-red-500/15 hover:text-red-300`}
                                    >
                                      删除
                                    </button>
                                  </DropdownMenu.Item>
                                </>
                              )}
                            </DropdownMenu.Content>
                          </DropdownMenu.Root>
                        </div>
                      </div>
                    </div>

                    {/* 行内改名：显示名（≤60）+ 备注（≤200），Enter 保存 / Esc 取消，留空即清除该字段 */}
                    {editing && (
                      <div
                        data-testid={`world-editor-${entry.worldId}`}
                        className="mt-3 grid gap-2 border-t border-white/[.06] pt-3"
                      >
                        <label className="flex items-center gap-2">
                          <span className="w-14 flex-none text-meta tracking-[.2em] text-ink-hint">显示名</span>
                          <input
                            ref={labelRef}
                            data-testid={`world-edit-label-${entry.worldId}`}
                            aria-label={`显示名（${name}）`}
                            maxLength={LABEL_MAX}
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            onKeyDown={(e) => onEditKey(e, entry)}
                            placeholder="留空则回退为剧本名"
                            autoComplete="off"
                            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-panel-strong px-3 py-1.5 text-ui transition-colors focus:border-gold/35"
                          />
                        </label>
                        <label className="flex items-center gap-2">
                          <span className="w-14 flex-none text-meta tracking-[.2em] text-ink-hint">备注</span>
                          <input
                            data-testid={`world-edit-note-${entry.worldId}`}
                            aria-label={`备注（${name}）`}
                            maxLength={NOTE_MAX}
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                            onKeyDown={(e) => onEditKey(e, entry)}
                            placeholder="留空则清除备注"
                            autoComplete="off"
                            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-panel-strong px-3 py-1.5 text-ui transition-colors focus:border-gold/35"
                          />
                        </label>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            data-testid={`world-edit-save-${entry.worldId}`}
                            disabled={saving || worldBusy}
                            onClick={() => saveEdit(entry)}
                            className="rounded-lg border border-gold/35 bg-gold/15 px-4 py-1.5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
                          >
                            {saving ? "保存中…" : "保存"}
                          </button>
                          <button
                            type="button"
                            data-testid={`world-edit-cancel-${entry.worldId}`}
                            disabled={saving}
                            onClick={() => setEditId(null)}
                            className="rounded-lg border border-white/10 px-3 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
                          >
                            取消
                          </button>
                          <span className="text-meta tracking-[.08em] text-ink-hint">Enter 保存 · Esc 取消 · 留空即清除</span>
                        </div>
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          )}

          {/* 家谱视图（v1.7 / v1.8 缩放平移）：SVG 森林 + 选中节点的快捷信息条
              （继续复用 continueWorld，不另起一份逻辑）。
              详情条 sticky bottom-0：画布高时「继续/查看」也钉在视口底边 —— 不吸底就得先滚到底才够得着 */}
          {view === "genealogy" && list.length > 0 && (
            <div className="pb-1">
              <GenealogyCanvas
                layout={genealogy}
                worlds={list}
                presetTitle={presetTitle}
                focusId={genFocus}
                onFocus={setGenFocus}
              />
              {(() => {
                const entry = list.find((w) => w.worldId === genFocus);
                if (!entry) return null;
                const name = worldDisplayName(entry, presetTitle);
                const missing = !entry.exists;
                const node = genealogy.nodes.find((n) => n.worldId === entry.worldId);
                return (
                  <div
                    data-testid="genealogy-detail"
                    // 吸底时要压在画布上，故底色取近实底（半透面板会让按钮与边线糊在一起）
                    className="sticky bottom-0 z-10 mt-3 rounded-xl border border-white/10 bg-panel-strong px-4 py-3 backdrop-blur-md"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className={`text-body ${missing ? "text-ink-hint" : "text-ink"}`}>{name}</span>
                      <span className="text-meta tracking-[.12em] text-ink-hint">
                        第 {entry.chapterNo} 章 · {relativeTime(entry.lastPlayed)}
                        {missing && <span className="ml-2 text-red-400/90">目录缺失</span>}
                      </span>
                      {entry.forkedFrom && !node?.missingParent && (
                        <span className="rounded-sm border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-meta tracking-[.12em] text-ink-hint">
                          {forkPhrase(entry.forkedFrom, list, presetTitle)}
                        </span>
                      )}
                      {node?.missingParent && (
                        <span className="rounded-sm border border-red-400/30 px-1.5 py-0.5 text-meta tracking-[.12em] text-red-300/90">
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
                          className={`rounded-lg border px-3.5 py-1.5 text-ui tracking-[.1em] transition-colors ${
                            missing || engineBusy
                              ? "cursor-not-allowed border-white/10 text-ink-hint"
                              : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                          }`}
                        >
                          {engineBusy ? "忙碌中" : "继续"}
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
                          className="rounded-lg border border-white/10 px-3 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
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
        </ShellPage>
      </div>
    </ScreenShell>
  );
}
