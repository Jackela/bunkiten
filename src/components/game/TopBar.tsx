import { useGameStore } from "../../store/game";
import { useTurnElapsed } from "../useTurnElapsed";

/** 快捷命令按钮：竖排文字，贴右侧边缘（galgame 规范的操作轨） */
function RailButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md px-1.5 py-2.5 text-[11.5px] tracking-[.25em] text-ink/60 transition-colors duration-200 hover:bg-white/[.06] hover:text-[color:var(--accent)] [writing-mode:vertical-rl]"
    >
      {label}
    </button>
  );
}

/**
 * 顶栏（已拆两半）：状态点/状态文字/章节号/当前世界线留在左上角；快捷命令改为右侧竖排文字按钮轨。
 * 长回合显示已耗时秒数（区分「在跑」与「卡死」）。/new-game、/presets 回合结束后回标题屏。
 * 回退后的「待重同步」徽章挂在这里；重同步失败时旁边长出「再同步」按钮（retryResync 重发续玩指令）。
 */
export default function TopBar() {
  const status = useGameStore((s) => s.status);
  const chapterNo = useGameStore((s) => s.chapterNo);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const pendingResync = useGameStore((s) => s.pendingResync);
  const resyncFailed = useGameStore((s) => s.resyncFailed);
  const send = useGameStore((s) => s.send);
  const retryResync = useGameStore((s) => s.retryResync);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);
  const openAssets = useGameStore((s) => s.openAssets);
  const openTree = useGameStore((s) => s.openTree);
  const openSettings = useGameStore((s) => s.openSettings);
  const busy = status.includes("…");
  const elapsed = useTurnElapsed();

  return (
    <>
      <div className="fixed top-0 left-0 z-30 flex items-center gap-2.5 px-3.5 py-2.5 text-xs text-ink/60">
        <span
          className={`h-[7px] w-[7px] flex-none rounded-full ${busy ? "animate-pulse bg-gold" : "bg-[#3d4254]"}`}
        />
        <span data-testid="status">{status}{busy && elapsed !== null ? ` ${elapsed}s` : ""}</span>
        <span className="text-ink/35">第 {chapterNo} 章</span>
        {worldLabel && (
          <span data-testid="world-label" className="max-w-[26ch] truncate text-ink/30">
            {worldLabel}
          </span>
        )}
        {/* 回退后的待重同步徽章：重同步回合成功即消失；失败时旁边长出「再同步」重试入口 */}
        {pendingResync && (
          <span
            data-testid="resync-badge"
            className={`flex-none rounded-sm border px-1.5 py-0.5 text-[10px] tracking-[.12em] ${
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
            className="flex-none rounded-md border border-gold/35 bg-gold/15 px-2 py-0.5 text-[11px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30"
          >
            再同步
          </button>
        )}
      </div>

      <nav className="fixed top-1/2 right-2.5 z-30 flex -translate-y-1/2 flex-col gap-0.5 rounded-lg border border-white/[.08] bg-[rgba(10,12,18,.5)] p-1 backdrop-blur-md">
        <RailButton label="设置" onClick={openSettings} />
        <RailButton label="历史" onClick={toggleDrawer} />
        <RailButton label="素材" onClick={openAssets} />
        <RailButton label="剧情图" onClick={openTree} />
        <RailButton label="重开" onClick={() => send("/new-game")} />
        <RailButton label="前情" onClick={() => send("/recap")} />
        <RailButton label="换剧本" onClick={() => send("/presets")} />
        <RailButton label="帮助" onClick={() => send("/help")} />
      </nav>
    </>
  );
}
