import { useGameStore } from "../../store/game";
import { playerStatus } from "../../lib/status";
import { isLegacyForkNote } from "../../lib/worlds";
import { useTurnElapsed } from "../useTurnElapsed";

/** 快捷命令按钮：竖排文字，贴右侧边缘（galgame 规范的操作轨）；testId/aria 供 e2e 与无障碍名分离于短标签 */
function RailButton({ label, onClick, testId, aria }: { label: string; onClick: () => void; testId?: string; aria?: string }) {
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
 * 「重演这一幕」（rerollTurn：退回上一回合结束态并重发同一玩家输入）只在就绪、有上一回合输入、
 * 且不处于待重同步时出现——重同步进行中不重演（要覆盖的正是那几份正在变的文件）。
 */
export default function TopBar() {
  const status = useGameStore((s) => s.status);
  const worldId = useGameStore((s) => s.worldId);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const pendingResync = useGameStore((s) => s.pendingResync);
  const resyncFailed = useGameStore((s) => s.resyncFailed);
  const lastTurnPrompt = useGameStore((s) => s.lastTurnPrompt);
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
  // 有上一回合输入、不处于待重同步、且世界已知至少有两条 turn 快照（重演要退到「次新」那条）——
  // turnSnapshots 为 null（未知，如续玩补拉失败）时照常展示，点击后再由 rerollTurn 的 fetch 判定
  const canReroll = status === "就绪" && !!lastTurnPrompt && !pendingResync && (turnSnapshots === null || turnSnapshots >= 2);
  // 一切正常 = 没有需要玩家读的状态：状态簇整块不画（见文件头注释）
  const idle = status === "就绪" && !busy && !pendingResync;
  // 世界名只在「有备注名」时出现：store 在无备注时会把它写成 worldId，
  // 这时显示出来就是一条 slug（campus-summer-1），对玩家零信息量——干脆不渲染。
  // 旧版 server 自动写的分叉备注同理（「分叉自 campus-summer-1 @ 2-2」也是裸 id 串，
  // 见 lib/worlds）：当前世界线的来历在剧情图/世界线屏看，顶栏只留玩家自己起的名字。
  const showWorldLabel = !!worldLabel && worldLabel !== worldId && !isLegacyForkNote(worldLabel);

  return (
    <>
      <div className={`fixed top-0 left-0 z-30 flex items-center gap-2.5 px-3.5 py-2.5 text-meta text-ink-hint ${idle ? "sr-only" : ""}`}>
        <span
          className={`h-[7px] w-[7px] flex-none rounded-full ${busy ? "animate-pulse bg-gold" : "bg-[#3d4254]"}`}
        />
        <span data-testid="status">
          {playerStatus(status)}
          {busy && elapsed !== null ? ` ${elapsed}s` : ""}
        </span>
        {showWorldLabel && (
          <span data-testid="world-label" className="max-w-[26ch] truncate text-ink-hint">
            {worldLabel}
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

      <nav className="fixed top-1/2 right-2.5 z-30 flex -translate-y-1/2 flex-col gap-0.5 rounded-lg border border-white/[.08] bg-panel p-1 backdrop-blur-md">
        <RailButton label="设置" testId="settings" onClick={openSettings} />
        <RailButton label="历史" testId="history" onClick={toggleDrawer} />
        <RailButton label="角色" aria="角色面板" testId="characters" onClick={toggleCharacters} />
        <RailButton label="画廊" testId="assets" onClick={openAssets} />
        <RailButton label="剧情图" testId="tree" onClick={openTree} />
        {canReroll && <RailButton label="重演" aria="重演这一幕" testId="reroll" onClick={() => void rerollTurn()} />}
        <RailButton label="重开" onClick={() => send("/new-game")} />
        <RailButton label="前情" onClick={() => send("/recap")} />
        <RailButton label="换剧本" onClick={() => send("/presets")} />
        <RailButton label="帮助" onClick={() => send("/help")} />
      </nav>
    </>
  );
}
