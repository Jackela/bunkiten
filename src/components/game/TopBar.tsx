import { useEffect, useRef, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useGameStore } from "../../store/game";
import { fetchAssets, worldExportUrl } from "../../lib/acp";
import { tabThroughMenu } from "../../lib/menuTab";
import { playerStatus } from "../../lib/status";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { resolveWorldLabel } from "../../lib/worlds";
import { useTurnElapsed } from "../useTurnElapsed";

/** 菜单项基类（与 WorldsScreen 的行 ⋯ 菜单逐字同款：面板底色/圆角/描边/字号档位在屏与屏之间只有一套） */
const MENU_ITEM_CLS =
  "w-full rounded-lg px-3 py-2 text-left text-ui text-ink-hint transition-colors hover:bg-white/[.06] hover:text-ink";

/**
 * Esc 就地收菜单、且**不许**冒到 App 的 Esc 关闭链。
 * Radix 的 DismissableLayer 在 document 的**捕获阶段**监听 Esc，这里在它那一拍上 stopPropagation：
 * 事件到此为止，既到不了 target 冒泡，也到不了挂在 window 上的关闭链；关菜单由 Radix 的 onDismiss
 * 继续（它看的是 defaultPrevented，我们没 preventDefault，所以不会被跳过）。
 * game 屏上那条链今天是空转，但这一层不假定「我挂在哪块屏上」——冒上去的 Escape 就是一次意外关屏。
 */
const swallowEscape = (event: KeyboardEvent) => event.stopPropagation();

/** 快捷命令按钮：竖排文字，贴右侧边缘（galgame 规范的操作轨）；testId/aria 供 e2e 与无障碍名分离于短标签 */
function RailButton({
  label,
  onClick,
  testId,
  aria,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
  aria?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={aria ?? label}
      aria-label={aria ?? label}
      data-testid={testId}
      className="rounded-md px-1.5 py-2.5 text-meta tracking-[.25em] text-ink-hint transition-colors duration-200 hover:bg-white/[.06] hover:text-[color:var(--accent)] [writing-mode:vertical-rl]"
    >
      {label}
    </button>
  );
}

/** 分组菜单里的一项：真实 `<button>`（Radix 只管 roving/typeahead/ARIA，元素语义仍归按钮自己） */
function RailItem({
  label,
  testId,
  onClick,
  aria,
  disabled,
  title,
  keepOpen,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  aria?: string;
  /** 忙碌等不可用态：Radix 的 Item 与本元素都上 disabled（照 WorldRow 的行 ⋯ 菜单写法） */
  disabled?: boolean;
  /** 禁用原因（玩家话）；缺省用 aria/label 当 title */
  title?: string;
  /** 选中不关菜单（两段确认要留在菜单里，照 WorldRow 的 KEEP_MENU_OPEN） */
  keepOpen?: boolean;
}) {
  return (
    <DropdownMenu.Item asChild disabled={disabled} onSelect={keepOpen ? (event) => event.preventDefault() : undefined}>
      <button
        type="button"
        data-testid={testId}
        title={title ?? aria ?? label}
        aria-label={aria ?? label}
        disabled={disabled}
        onClick={onClick}
        className={`${MENU_ITEM_CLS} ${
          disabled ? "cursor-not-allowed text-ink-faint hover:bg-transparent hover:text-ink-faint" : ""
        }`}
      >
        {label}
      </button>
    </DropdownMenu.Item>
  );
}

/**
 * 命令轨的分组（v1.12 菜单信息架构）：一个竖排文字的触发器 + 一个 Radix 菜单。
 *
 * 用法照抄 WorldsScreen 的行 ⋯ 菜单（非 portal + modal={false}），差别只有两处：
 * ① 弹层朝**左**开（命令轨贴在屏幕右缘，side="left" 才落回画面里；贴边翻面仍由 Radix 的 flip 兜底）；
 * ② 不接 `onCloseAutoFocus`：菜单卸载时 Radix 默认把焦点送回触发器，那正是本轨要的行为
 *    （WorldsScreen 拦那一下，是因为它把焦点送进了行内改名输入框——不是同一个场景）。
 *
 * 触发器沿用竖排文字母题（同 {@link RailButton}），只在末尾多一枚极小的 `▾`：它是纯视觉的「可展开」提示，
 * 用 aria-hidden 挡在读屏之外——「这是个下拉」由 aria-haspopup/aria-expanded 交代，别让读屏把它念成一个字。
 */
function RailGroup({
  label,
  aria,
  testId,
  children,
  onOpenChange,
}: {
  label: string;
  aria: string;
  testId: string;
  children: ReactNode;
  /** 菜单开合回调（进度菜单据此「打开时按需取素材数」） */
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu.Root modal={false} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger
        type="button"
        title={aria}
        aria-label={aria}
        data-testid={testId}
        className="rounded-md px-1.5 py-2.5 text-meta tracking-[.25em] text-ink-hint transition-colors duration-200 hover:bg-white/[.06] hover:text-[color:var(--accent)] data-[state=open]:bg-white/[.06] data-[state=open]:text-[color:var(--accent)] [writing-mode:vertical-rl]"
      >
        {label}
        <span aria-hidden className="text-micro opacity-70">
          ▾
        </span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Content
        data-testid={`${testId}-menu`}
        side="left"
        align="center"
        sideOffset={6}
        collisionPadding={8}
        onEscapeKeyDown={swallowEscape}
        onKeyDown={(event) => {
          // 中文输入法组字中的按键不算导航（Tab 也不是字符键，Radix 的 typeahead 不会吃它）
          if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
          tabThroughMenu(event.nativeEvent, event.currentTarget);
        }}
        className="z-20 grid w-44 gap-0.5 shell-panel rounded-xl p-1"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/**
 * 重演对话框（v1.14 可编辑重演）：把「重演这一幕」从「再说一遍同一句错话」变成「回到这里，换一种说法」。
 *
 * 受 store 的 `rerollDialog` 控制，两个入口共用这一份：游戏屏命令轨「重演这一幕」→ `openRerollDialog()`
 * （目标幕 = 最近一条带玩家输入的 turn 条目），剧情图屏「回到这一幕并重演」→ `openRerollDialog(seq)`
 * （目标幕 = 该存档点）；预填值都是那条快照记下的输入。确认 → `submitReroll(多行输入)`（空串回退为预填值），
 * 取消/背板 → `closeRerollDialog()`。退出后由 store 走既有 reroll 通路与既有 pendingResync 时序。
 *
 * 照本仓 overlay 范式：`role="dialog"` + `aria-modal` + {@link useFocusTrap}（开框焦点进多行输入、
 * Tab 在框里循环、关时归还给开框前的元素）。两处刻意：① **不做退场动画**（不上 AnimatePresence）——
 * 确认/取消是即时动作，而「关掉即不在 DOM」是单测与 e2e 都在用的契约，退场那 250ms 会让它多留一拍；
 * ② Esc **就地吞掉**（同上方菜单的 swallowEscape）：冒到 App 的关闭链会顺手把整屏（剧情图）一起关掉。
 *
 * 剧情图屏从 `TreeDetail` 复用这一份，并另传节点作用域的按钮 testid（旧的两段确认契约不破，
 * e2e 与 `tests/ui/story-tree-snapshots.test.tsx` 都还照着它点）。
 */
export function RerollDialog({
  confirmTestId = "reroll-confirm",
  cancelTestId = "reroll-cancel",
}: {
  /** 确认按钮的 testid（剧情图屏传 `tree-replay-confirm-<节点 id>`，沿用旧的两段确认契约） */
  confirmTestId?: string;
  /** 取消按钮的 testid（同上，`tree-replay-cancel-<节点 id>`） */
  cancelTestId?: string;
}) {
  const dialog = useGameStore((s) => s.rerollDialog);
  const closeRerollDialog = useGameStore((s) => s.closeRerollDialog);
  const submitReroll = useGameStore((s) => s.submitReroll);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const open = dialog !== null;
  useFocusTrap(open, panelRef);
  // 预填该幕记下的输入。effect 同时盯 seq 与 prompt：图屏路径是「先开框、预填值随后单条取回」，
  // 只盯 seq 的话那一发回填落不进输入框（seq 没变）。
  useEffect(() => {
    setText(dialog?.prompt ?? "");
  }, [dialog?.seq, dialog?.prompt]);
  if (!dialog) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={closeRerollDialog}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.stopPropagation(); // 只关框，别穿透到 App 的 Esc 关闭链（那会顺手关掉整屏）
        closeRerollDialog();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="重演这一幕"
        data-testid="reroll-dialog"
        onClick={(event) => event.stopPropagation()}
        className="relative w-[min(560px,94vw)] rounded-2xl border border-white/10 bg-panel-strong p-6"
      >
        <h2 className="text-title tracking-[.3em] text-ink">重 演</h2>
        <p className="mt-1.5 text-meta leading-relaxed text-ink-hint">
          回到第 {dialog.seq} 幕开演前，换一种说法再演一次。留空就照当时那句话重来。
        </p>
        <label htmlFor="reroll-input" className="mt-4 block text-meta tracking-[.15em] text-ink-hint">
          当时你说的是
        </label>
        <textarea
          id="reroll-input"
          data-testid="reroll-input"
          value={text}
          rows={4}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          placeholder="换一种说法…（例：不敲门，直接从窗户翻进去）"
          className="mt-1.5 w-full resize-y rounded-lg border border-white/10 bg-panel-sunken px-3 py-2 text-ui leading-relaxed tracking-[.02em] transition-colors focus:border-gold/35"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid={cancelTestId}
            onClick={closeRerollDialog}
            className="rounded-lg border border-white/10 px-4 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            取消
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            onClick={() => void submitReroll(text)}
            className="rounded-lg border border-gold/35 bg-gold/15 px-4 py-1.5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30"
          >
            确认重演
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 顶栏（已拆两半）：左侧只留「异常/进行中」状态簇，快捷命令是右侧竖排文字按钮轨。
 *
 * VN 惯例——正常态不画 HUD：`status === "就绪"` 且不忙、无待重同步时，整个左侧状态簇走 `sr-only`
 * （DOM 留在原位：`data-testid="status"` 的文本断言照常命中，屏幕阅读器也照常读得到；画面上一片
 * 干净，把画布还给立绘/背景）。忙起来、出错、待重同步时簇立刻现身——那时它是玩家最需要的信息。
 * 注意 sr-only 的副作用：被 clip 的 `status` 不再接受点按（Playwright 的 `.click()` 会因
 * 「收不到指针事件」超时）；需要「点一下把焦点从输入框挪回 body」的 e2e 用例请改点对话框或根节点。
 *
 * 状态文案经 {@link playerStatus} 转成玩家口吻（store 字符串不动）；章号已移出顶栏——
 * 它现在只在章节过场卡（ChapterCard）与回想抽屉标题上出现。
 * 长回合显示已耗时秒数（区分「在跑」与「卡死」）。/new-game、/presets 回合结束后回标题屏。
 * 回退后的「待重同步」徽章挂在这里；重同步失败时旁边长出「再同步」按钮（retryResync 重发续玩指令）。
 *
 * v1.12 菜单信息架构：命令轨从 10 项平铺收成 5 个顶层——
 *   设置（直达）｜回顾 ▾（历史/前情）｜图鉴 ▾（角色/画廊/剧情图）｜进度 ▾（重演这一幕/返回标题/导出这一局/统计/重开/换剧本）｜帮助（直达）
 * v1.14 元命令本地化（ADR-0027）：「帮助」不再发 /help，改为打开本地面板（openHelp，零引擎回合）；
 *   同理「回顾 → 前情」走 openRecap（本地合成，零回合）。testid 与位置一个字没改，只换了动作。
 * v1.14 可编辑重演（C7）：「重演这一幕」不再直接重演，改为开对话框预填那一刻的玩家输入
 *   （openRerollDialog；解析失败照旧走 status 降级提示），确认才走 reroll 通路。见 {@link RerollDialog}。
 * 原来是十项同权重平铺，而玩家频次差着量级（设置/帮助每次进屏都可能用，换剧本一局一次），危险的「重开」
 * 也与常用项挤在同一层。现在按语义分组、低频与破坏性项进二级菜单，高频项保持一击可达。
 * 四条硬约束（改本轨前先读）：
 * ① **设置必须留在第一位**——它是 game 屏 DOM 里第一个可聚焦元素，Tab 首个落点盯着它
 *    （tests/e2e-ui/focus.spec.ts 自带一条「Tab 首个焦点 = 设置」的用例）；分组触发器排在它之后。
 * ② 叶子项沿用原 testid 与 aria（那是测试契约，逐个保留）；「重演这一幕」仍只在就绪、且不处于待重同步时
 *    渲染（重同步进行中不重演——要覆盖的正是那几份正在变的文件），只是从轨上挪进了「进度」菜单里。
 *    v1.13 起可见性判据只剩快照数（输入在盘上，点击时由 store 的解析内核现取、按三级降级提示），
 *    刷新/重启后照样可重演——不再有「内存账本空着、按钮点了没反应」那条路（见 docs/adr/0023）；
 *    v1.14 起点击只是**开框**（预填可编辑输入），真的重演要玩家在框里点「确认重演」。
 * ③ 菜单非 portal、modal={false}（理由见 {@link RailGroup}）；弹层观感与 WorldsScreen 的行 ⋯ 菜单同源。
 * ④ v1.14 进度菜单扩充：「返回标题」（本地 toTitle，零回合）、「导出这一局」（worldExportUrl 的下载）、
 *    只读统计（本局幕数 + 打开菜单时按需 fetchAssets 的素材数）；「重开」「换剧本」仍是引擎指令，
 *    忙碌时禁用并给原因（`title`），两者都收进菜单内的两段确认。状态簇 busy 时多一枚「停止」。
 */
export default function TopBar() {
  const status = useGameStore((s) => s.status);
  const worldId = useGameStore((s) => s.worldId);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const pendingResync = useGameStore((s) => s.pendingResync);
  const resyncFailed = useGameStore((s) => s.resyncFailed);
  const sseDown = useGameStore((s) => s.sseDown);
  const turnSnapshots = useGameStore((s) => s.turnSnapshots);
  const send = useGameStore((s) => s.send);
  const openRerollDialog = useGameStore((s) => s.openRerollDialog);
  const retryResync = useGameStore((s) => s.retryResync);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);
  const toggleCharacters = useGameStore((s) => s.toggleCharacters);
  const openAssets = useGameStore((s) => s.openAssets);
  const openTree = useGameStore((s) => s.openTree);
  const openSettings = useGameStore((s) => s.openSettings);
  const openHelp = useGameStore((s) => s.openHelp);
  const openRecap = useGameStore((s) => s.openRecap);
  const busy = status.includes("…");
  const elapsed = useTurnElapsed();
  // 不处于待重同步、且世界已知至少有两条 turn 快照（重演要退到目标幕之前的那条）——turnSnapshots 为
  // null（未知，如续玩补拉失败）时照常展示，点击后由 store 的重演解析内核按盘上数据判定三级降级
  const canReroll = status === "就绪" && !pendingResync && (turnSnapshots === null || turnSnapshots >= 2);
  // 一切正常 = 没有需要玩家读的状态：状态簇整块不画（见文件头注释）。
  // 连接断开时簇要现身（那是玩家需要知道的事），所以也并进 idle 的否定条件
  const idle = status === "就绪" && !busy && !pendingResync && !sseDown;
  // 世界名只在「有名字」时出现：无显示名时 store 退化为空串；`worldLabel !== worldId` 只是防旧状态/手改数据
  // （裸 id 对玩家零信息量）。旧版 server 自动写的分叉备注同理（「分叉自 campus-summer-1 @ 2-2」也是裸 id 串，
  // 见 lib/worlds）：当前世界线的来历在剧情图/世界线屏看，顶栏只留玩家自己起的名字。
  // 两段式（v1.13）：后台补画进行中时给一枚低调徽章（补画回合 artAsk 置位，状态行同时显示「作画中…」）
  const artAsk = useGameStore((s) => s.artAsk);
  const deferredArt = useGameStore((s) => s.deferredArt);
  const deferredDone = deferredArt.filter((i) => i.state === "done").length;
  const label = resolveWorldLabel(worldLabel, worldId);
  const showWorldLabel = label !== "";
  // v1.14：「停止本回合」与「进度」菜单的新动作
  const cancelTurn = useGameStore((s) => s.cancelTurn);
  const toTitle = useGameStore((s) => s.toTitle);
  const history = useGameStore((s) => s.history);
  const presetId = useGameStore((s) => s.selected?.id ?? "");
  // 出错态：状态行亮警示色 + role="alert"（读屏立即播报），别破 data-testid="status"
  const isError = status.startsWith("出错：");
  // 「本局幕数」：已知快照数优先（与存档点/重演同基底），未知时退回本会话内存里的正文幕数
  const acts = turnSnapshots !== null ? turnSnapshots : history.filter((h) => h.kind === "act").length;
  // 进度菜单的两段确认（照 WorldRow 的 confirming 分支：首点变「确认/取消」，二点才发）
  const [confirming, setConfirming] = useState<"new-game" | "presets" | null>(null);
  // 「素材 N 张」：打开进度菜单时按需拉一次当前剧本的资产数（未回来显示占位「…」）
  const [progressOpen, setProgressOpen] = useState(false);
  const [assetCount, setAssetCount] = useState<number | null>(null);
  useEffect(() => {
    if (!progressOpen || !presetId) return;
    let alive = true;
    setAssetCount(null); // 每次打开重新取（画廊刚加过图）：先回占位，不显示上一轮的旧数
    fetchAssets(presetId)
      .then((list) => {
        if (alive) setAssetCount(list.length);
      })
      .catch(() => {
        /* 取不到就保持占位「…」，不打扰玩家 */
      });
    return () => {
      alive = false;
    };
  }, [progressOpen, presetId]);

  return (
    <>
      <div
        className={`fixed top-0 left-0 z-30 flex items-center gap-2.5 px-3.5 py-2.5 text-meta text-ink-hint ${idle ? "sr-only" : ""}`}
      >
        <span
          className={`h-[7px] w-[7px] flex-none rounded-full ${
            isError ? "bg-[#d98b8b]" : busy ? "animate-pulse bg-gold" : "bg-[#3d4254]"
          }`}
        />
        {/* 出错态：role="alert"（读屏立即播报）+ 警示色；平时只是一行灰字，不加任何 live 语义 */}
        <span data-testid="status" role={isError ? "alert" : undefined} className={isError ? "text-[#d98b8b]" : ""}>
          {playerStatus(status)}
          {busy && elapsed !== null ? ` ${elapsed}s` : ""}
        </span>
        {/* 连接断开（v1.14 App 的 onConn("error")）：一处可见提示，重连成功即撤。
            刻意**不带 live 语义**——状态播报归 StatusAnnouncer（sr-status），别抢读屏的播报 */}
        {sseDown && (
          <span
            data-testid="sse-down"
            className="flex-none rounded-sm border border-[#d98b8b]/40 px-1.5 py-0.5 text-micro tracking-[.12em] text-[#d98b8b]"
          >
            连接中断，重连中…
          </span>
        )}
        {/* 忙时给一个出口：停止本回合（服务端置「忽略在途响应」、复位忙态、置待重同步）。
            非忙时不画——平时这枚按钮没有可停的东西 */}
        {busy && (
          <button
            type="button"
            data-testid="turn-cancel"
            onClick={() => void cancelTurn()}
            title="停止这一回合"
            className="flex-none rounded-md border border-white/15 px-2 py-0.5 text-meta tracking-[.1em] text-ink-body transition-colors hover:border-red-400/50 hover:text-red-200"
          >
            停止
          </button>
        )}
        {artAsk && deferredArt.length > 0 && (
          <span
            data-testid="art-pump"
            className="flex-none rounded-sm border border-white/15 px-1.5 py-0.5 text-micro tracking-[.12em] text-ink-hint"
          >
            补画 {deferredDone}/{deferredArt.length}
          </span>
        )}
        {showWorldLabel && (
          <span data-testid="world-label" className="max-w-[26ch] truncate text-ink-hint">
            {label}
          </span>
        )}
        {/* 回退后的待重同步徽章：重同步回合成功即消失；失败时旁边长出「再同步」重试入口 */}
        {pendingResync && (
          <span
            data-testid="resync-badge"
            className={`flex-none rounded-sm border px-1.5 py-0.5 text-micro tracking-[.12em] ${
              resyncFailed ? "border-red-400/40 text-red-300/90" : "border-gold/40 text-gold/90"
            }`}
          >
            待重同步
          </span>
        )}
        {pendingResync && resyncFailed && (
          <button
            type="button"
            data-testid="resync-retry"
            onClick={retryResync}
            className="flex-none rounded-md border border-gold/35 bg-gold/15 px-2 py-0.5 text-meta tracking-[.1em] text-gold transition-colors hover:bg-gold/30"
          >
            再同步
          </button>
        )}
      </div>

      {/* 命令轨：5 个顶层（顺序即 DOM 顺序，别调——「设置」必须是 game 屏首个可聚焦元素，见文件头） */}
      <nav className="fixed top-1/2 right-2.5 z-30 flex -translate-y-1/2 flex-col gap-0.5 rounded-lg border border-white/[.08] bg-panel p-1 backdrop-blur-md">
        <RailButton label="设置" testId="settings" onClick={openSettings} />

        <RailGroup label="回顾" aria="回顾（历史与前情）" testId="rail-review">
          <RailItem label="历史" testId="history" onClick={toggleDrawer} />
          <RailItem label="前情" testId="recap" onClick={() => void openRecap()} />
        </RailGroup>

        <RailGroup label="图鉴" aria="图鉴（角色、画廊与剧情图）" testId="rail-collection">
          <RailItem label="角色" aria="角色面板" testId="characters" onClick={toggleCharacters} />
          {/* 不给 openAssets 传事件对象：它的首参是「顺手落的 selected」（标题屏用），传 MouseEvent 会把
              store 的 selected 写坏——画廊 rail 用的是当前已选的剧本 */}
          <RailItem label="画廊" testId="assets" onClick={() => openAssets()} />
          <RailItem label="剧情图" testId="tree" onClick={openTree} />
        </RailGroup>

        {/* 进度菜单（v1.14 扩充）：重演这一幕 / 返回标题 / 导出这一局 / 只读统计 / 重开 / 换剧本。
            「返回标题」「导出这一局」是纯本地动作（零引擎回合），忙碌时照常可用；
            「重开」「换剧本」仍是引擎指令（`/new-game`、`/presets`），忙碌时 409——所以禁用并给出原因。
            两者都收进菜单内的两段确认（照 WorldRow 的 confirming 分支）。 */}
        <RailGroup
          label="进度"
          aria="进度（重演、返回标题与重开）"
          testId="rail-progress"
          onOpenChange={(open) => {
            setProgressOpen(open);
            if (!open) setConfirming(null); // 关菜单撤销半截确认（重开菜单回到第一屏）
          }}
        >
          {confirming === "new-game" ? (
            <>
              <RailItem
                label="确认重开"
                testId="progress-confirm"
                aria="确认重开（回到标题屏，另开一局）"
                onClick={() => {
                  setConfirming(null);
                  send("/new-game");
                }}
              />
              <RailItem label="取消" testId="progress-cancel" keepOpen onClick={() => setConfirming(null)} />
            </>
          ) : confirming === "presets" ? (
            <>
              <RailItem
                label="确认换剧本"
                testId="progress-confirm"
                aria="确认换剧本（回到标题屏重新挑剧本）"
                onClick={() => {
                  setConfirming(null);
                  send("/presets");
                }}
              />
              <RailItem label="取消" testId="progress-cancel" keepOpen onClick={() => setConfirming(null)} />
            </>
          ) : (
            <>
              {canReroll && (
                // v1.14：不再直接重演——先开「预填可编辑输入」的对话框（目标幕与预填值由 store
                // 现取盘上那一条；解析失败走 status 降级提示，不开空框），见 RerollDialog
                <RailItem label="重演这一幕" testId="reroll" onClick={() => void openRerollDialog()} />
              )}
              <RailItem label="返回标题" testId="to-title" onClick={toTitle} aria="返回标题（不结束这一局）" />
              {worldId && (
                // 导出走浏览器下载（服务端带 Content-Disposition），接法与 WorldRow 的导出项一致。
                // 在菜单里就地派发：不 preventDefault 的话 Radix 会「选中即关」，那一拍会掐掉下载
                <DropdownMenu.Item asChild onSelect={(event) => event.preventDefault()}>
                  <a
                    href={worldExportUrl(worldId)}
                    download={`${worldId}.world.json`}
                    data-testid="export-world"
                    aria-label="导出这一局"
                    className={`${MENU_ITEM_CLS} block`}
                  >
                    导出这一局
                  </a>
                </DropdownMenu.Item>
              )}
              <p data-testid="progress-stats" className="px-3 py-1.5 text-meta tracking-[.08em] text-ink-hint">
                本局 {acts} 幕 · 素材 {assetCount === null ? "…" : `${assetCount} 张`}
              </p>
              <RailItem
                label="重开"
                testId="new-game"
                disabled={busy}
                keepOpen
                title={busy ? "忙碌中：等这一幕结束再重开" : "重开：回到标题屏另开一局"}
                onClick={() => setConfirming("new-game")}
              />
              <RailItem
                label="换剧本"
                testId="presets"
                disabled={busy}
                keepOpen
                title={busy ? "忙碌中：等这一幕结束再换剧本" : "换剧本：回到标题屏重新挑一张卡"}
                onClick={() => setConfirming("presets")}
              />
            </>
          )}
        </RailGroup>

        <RailButton label="帮助" testId="help" onClick={openHelp} />
      </nav>

      {/* 重演对话框（v1.14）：受 store 的 rerollDialog 控制，浮在游戏屏之上（见 RerollDialog） */}
      <RerollDialog />
    </>
  );
}
