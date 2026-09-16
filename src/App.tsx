import { useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { subscribeEvents } from "./lib/acp";
import { useGameStore } from "./store/game";
import { getTheme, themeVars } from "./theme";
import BootScreen from "./components/BootScreen";
import TitleScreen from "./components/TitleScreen";
import ProtagonistScreen from "./components/ProtagonistScreen";
import CraftingScreen from "./components/CraftingScreen";
import AssetsScreen from "./components/AssetsScreen";
import CreationScreen from "./components/CreationScreen";
import WorldsScreen from "./components/WorldsScreen";
import StoryTreeScreen from "./components/StoryTreeScreen";
import GameStage from "./components/game/GameStage";
import BgLayer from "./components/game/BgLayer";
import { Veil } from "./components/game/Veil";
import { Atmosphere } from "./components/Atmosphere";
import { MotifLayer } from "./components/motifs";

// 只做屏幕切换与全局氛围；背景层常驻（crafting→game 转场不重载），SSE 在此接入 store。
// 根容器按当前剧本 theme 注入 --accent/--accent2，标题屏在自己的子树按当前卡覆盖。
export default function App() {
  const screen = useGameStore((s) => s.screen);
  const handleEvent = useGameStore((s) => s.handleEvent);
  const selected = useGameStore((s) => s.selected);
  const theme = getTheme(selected);

  useEffect(() => subscribeEvents(handleEvent), [handleEvent]);

  // Esc 关闭链（画廊预览 → 剧情图节点详情 → 历史抽屉 → 创作退出确认 → 剧情图/世界线屏）；输入框聚焦时不拦截
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const s = useGameStore.getState();
      if (s.assetsPreview) {
        s.setAssetsPreview(null);
        return;
      }
      if (s.screen === "tree" && s.treeFocus) {
        s.setTreeFocus(null);
        return;
      }
      if (s.drawerOpen) {
        s.toggleDrawer();
        return;
      }
      if (s.creationExitPrompt) {
        s.closeCreationExitPrompt();
        return;
      }
      if (s.screen === "tree") {
        s.closeOverlay();
        return;
      }
      if (s.screen === "worlds") s.toTitle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-bg font-serif text-ink" style={themeVars(theme)}>
      <BgLayer />
      <div className="pointer-events-none absolute inset-0">
        <MotifLayer motif={theme.motif} />
      </div>
      <Veil />
      <AnimatePresence mode="wait">
        {screen === "boot" && <BootScreen key="boot" />}
        {screen === "title" && <TitleScreen key="title" />}
        {screen === "worlds" && <WorldsScreen key="worlds" />}
        {screen === "protagonist" && <ProtagonistScreen key="protagonist" />}
        {screen === "crafting" && <CraftingScreen key="crafting" />}
        {screen === "assets" && <AssetsScreen key="assets" />}
        {screen === "creation" && <CreationScreen key="creation" />}
        {screen === "tree" && <StoryTreeScreen key="tree" />}
        {screen === "game" && <GameStage key="game" />}
      </AnimatePresence>
      <Atmosphere />
    </div>
  );
}
