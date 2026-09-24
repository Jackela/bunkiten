import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useGameStore } from "../../store/game";
import { tabThroughMenu } from "../../lib/menuTab";
import { playerStatus } from "../../lib/status";
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
}: {
  label: string;
  testId: string;
  onClick: () => void;
  aria?: string;
}) {
  return (
    <DropdownMenu.Item asChild>
      <button
        type="button"
        data-testid={testId}
        title={aria ?? label}
        aria-label={aria ?? label}
        onClick={onClick}
        className={MENU_ITEM_CLS}
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
}: {
  label: string;
  aria: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Root modal={false}>
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
 *   设置（直达）｜回顾 ▾（历史/前情）｜图鉴 ▾（角色/画廊/剧情图）｜进度 ▾（重演这一幕/重开/换剧本）｜帮助（直达）
 * 原来是十项同权重平铺，而玩家频次差着量级（设置/帮助每次进屏都可能用，换剧本一局一次），危险的「重开」
 * 也与常用项挤在同一层。现在按语义分组、低频与破坏性项进二级菜单，高频项保持一击可达。
 * 三条硬约束（改本轨前先读）：
 * ① **设置必须留在第一位**——它是 game 屏 DOM 里第一个可聚焦元素，Tab 首个落点盯着它
 *    （tests/e2e-ui/focus.spec.ts 自带一条「Tab 首个焦点 = 设置」的用例）；分组触发器排在它之后。
 * ② 叶子项沿用原 testid 与 aria（那是测试契约，逐个保留）；「重演这一幕」仍只在就绪、且不处于待重同步时
 *    渲染（重同步进行中不重演——要覆盖的正是那几份正在变的文件），只是从轨上挪进了「进度」菜单里。
 *    v1.13 起可见性判据只剩快照数（输入在盘上，点击时由 store 的解析内核现取、按三级降级提示），
 *    刷新/重启后照样可重演——不再有「内存账本空着、按钮点了没反应」那条路（见 docs/adr/0023）。
 * ③ 菜单非 portal、modal={false}（理由见 {@link RailGroup}）；弹层观感与 WorldsScreen 的行 ⋯ 菜单同源。
 */
export default function TopBar() {
  const status = useGameStore((s) => s.status);
  const worldId = useGameStore((s) => s.worldId);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const pendingResync = useGameStore((s) => s.pendingResync);
  const resyncFailed = useGameStore((s) => s.resyncFailed);
  const turnSnapshots = useGameStore((s) => s.turnSnapshots);
  const send = useGameStore((s) => s.send);
  const rerollTurn = useGameStore((s) => s.rerollTurn);
  const retryResync = useGameStore((s) => s.retryResync);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);
  const toggleCharacters = useGameStore((s) => s.toggleCharacters);
  const openAssets = useGameStore((s) => s.openAssets);
  const openTree = useGameStore((s) => s.openTree);
  const openSettings = useGameStore((s) => s.openSettings);
  const busy = status.includes("…");
  const elapsed = useTurnElapsed();
  // 不处于待重同步、且世界已知至少有两条 turn 快照（重演要退到目标幕之前的那条）——turnSnapshots 为
  // null（未知，如续玩补拉失败）时照常展示，点击后由 store 的重演解析内核按盘上数据判定三级降级
  const canReroll = status === "就绪" && !pendingResync && (turnSnapshots === null || turnSnapshots >= 2);
  // 一切正常 = 没有需要玩家读的状态：状态簇整块不画（见文件头注释）
  const idle = status === "就绪" && !busy && !pendingResync;
  // 世界名只在「有名字」时出现：无显示名时 store 退化为空串；`worldLabel !== worldId` 只是防旧状态/手改数据
  // （裸 id 对玩家零信息量）。旧版 server 自动写的分叉备注同理（「分叉自 campus-summer-1 @ 2-2」也是裸 id 串，
  // 见 lib/worlds）：当前世界线的来历在剧情图/世界线屏看，顶栏只留玩家自己起的名字。
  // 两段式（v1.13）：后台补画进行中时给一枚低调徽章（补画回合 artAsk 置位，状态行同时显示「作画中…」）
  const artAsk = useGameStore((s) => s.artAsk);
  const deferredArt = useGameStore((s) => s.deferredArt);
  const deferredDone = deferredArt.filter((i) => i.state === "done").length;
  const label = resolveWorldLabel(worldLabel, worldId);
  const showWorldLabel = label !== "";

  return (
    <>
      <div
        className={`fixed top-0 left-0 z-30 flex items-center gap-2.5 px-3.5 py-2.5 text-meta text-ink-hint ${idle ? "sr-only" : ""}`}
      >
        <span className={`h-[7px] w-[7px] flex-none rounded-full ${busy ? "animate-pulse bg-gold" : "bg-[#3d4254]"}`} />
        <span data-testid="status">
          {playerStatus(status)}
          {busy && elapsed !== null ? ` ${elapsed}s` : ""}
        </span>
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
          <RailItem label="前情" testId="recap" onClick={() => send("/recap")} />
        </RailGroup>

        <RailGroup label="图鉴" aria="图鉴（角色、画廊与剧情图）" testId="rail-collection">
          <RailItem label="角色" aria="角色面板" testId="characters" onClick={toggleCharacters} />
          {/* 不给 openAssets 传事件对象：它的首参是「顺手落的 selected」（标题屏用），传 MouseEvent 会把
              store 的 selected 写坏——画廊 rail 用的是当前已选的剧本 */}
          <RailItem label="画廊" testId="assets" onClick={() => openAssets()} />
          <RailItem label="剧情图" testId="tree" onClick={openTree} />
        </RailGroup>

        <RailGroup label="进度" aria="进度（重演、重开与换剧本）" testId="rail-progress">
          {canReroll && <RailItem label="重演这一幕" testId="reroll" onClick={() => void rerollTurn()} />}
          <RailItem label="重开" testId="new-game" onClick={() => send("/new-game")} />
          <RailItem label="换剧本" testId="presets" onClick={() => send("/presets")} />
        </RailGroup>

        <RailButton label="帮助" testId="help" onClick={() => send("/help")} />
      </nav>
    </>
  );
}
