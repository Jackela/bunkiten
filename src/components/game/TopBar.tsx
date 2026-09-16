import { useGameStore } from "../../store/game";
import { useTurnElapsed } from "../useTurnElapsed";

/** 快捷命令按钮：竖排文字，贴右侧边缘（galgame 规范的操作轨） */
function RailButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="rounded-md px-1.5 py-2.5 text-[11.5px] tracking-[.25em] text-ink/60 transition-colors duration-200 hover:bg-white/[.06] hover:text-[color:var(--accent)] [writing-mode:vertical-rl]"
    >
      {label}
    </button>
  );
}

/**
 * 顶栏（已拆两半）：状态点/状态文字/章节号/当前世界线留在左上角；快捷命令改为右侧竖排文字按钮轨。
 * 长回合显示已耗时秒数（区分「在跑」与「卡死」）。/new-game、/presets 回合结束后回标题屏。
 */
export default function TopBar() {
  const status = useGameStore((s) => s.status);
  const chapterNo = useGameStore((s) => s.chapterNo);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const send = useGameStore((s) => s.send);
  const toggleDrawer = useGameStore((s) => s.toggleDrawer);
  const openAssets = useGameStore((s) => s.openAssets);
  const openTree = useGameStore((s) => s.openTree);
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
      </div>

      <nav className="fixed top-1/2 right-2.5 z-30 flex -translate-y-1/2 flex-col gap-0.5 rounded-lg border border-white/[.08] bg-[rgba(10,12,18,.5)] p-1 backdrop-blur-md">
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
