import { useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig } from "framer-motion";
import { subscribeEvents } from "./lib/acp";
import { audioManager } from "./lib/audio";
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
import SettingsScreen from "./components/SettingsScreen";
import GameStage from "./components/game/GameStage";
import BgLayer from "./components/game/BgLayer";
import { Veil } from "./components/game/Veil";
import { Atmosphere } from "./components/Atmosphere";
import { MotifLayer } from "./components/motifs";

/**
 * 屏幕阅读器播报区（a11y）：只看 store.status，不改变任何视觉。
 * 只播报**变化过**的状态：同一句重复写入不再动 DOM——否则屏幕阅读器会把同一段文案重念一遍。
 */
export function StatusAnnouncer() {
  const status = useGameStore((s) => s.status);
  const last = useRef(status);
  const [text, setText] = useState(status);
  useEffect(() => {
    if (status === last.current) return;
    last.current = status;
    setText(status);
  }, [status]);
  return (
    <div aria-live="polite" aria-atomic="true" data-testid="sr-status" className="sr-only">
      {text}
    </div>
  );
}

// 只做屏幕切换与全局氛围；背景层常驻（crafting→game 转场不重载），SSE 在此接入 store。
// 根容器按当前剧本 theme 注入 --accent/--accent2，标题屏在自己的子树按当前卡覆盖。
export default function App() {
  const screen = useGameStore((s) => s.screen);
  const handleEvent = useGameStore((s) => s.handleEvent);
  const selected = useGameStore((s) => s.selected);
  const theme = getTheme(selected);

  useEffect(() => subscribeEvents(handleEvent), [handleEvent]);

  // 启动时把持久化设置同步给音频管理器（音量/静音；文本速度由 DialogueBox 直接读 store，不经这里）
  useEffect(() => {
    audioManager.applySettings(useGameStore.getState().settings);
  }, []);

  // 自动前进的唯一取消点：玩家一动手（点击/按键/输入）就作废本回合的倒计时，
  // 倒计时不该在玩家已经接管后还替她做决定。捕获阶段挂 window：任何子树里的交互都算数。
  useEffect(() => {
    const cancel = () => useGameStore.getState().cancelAutoAdvance();
    const types = ["pointerdown", "keydown", "input"] as const;
    for (const t of types) window.addEventListener(t, cancel, true);
    return () => {
      for (const t of types) window.removeEventListener(t, cancel, true);
    };
  }, []);

  // Esc 关闭链（画廊预览 → 剧情图节点详情 → 历史抽屉 → 创作退出确认 → 剧情图/设置 → 世界线屏）；
  // 只在「正在打字」的输入控件里不拦截（滑杆聚焦时 Esc 仍应能关设置屏）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el && (el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range"));
      if (typing) return;
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
      // overlay 屏（剧情图/设置）：Esc 返回进入前的原屏
      if (s.screen === "tree" || s.screen === "settings") {
        s.closeOverlay();
        return;
      }
      if (s.screen === "worlds") s.toTitle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // reducedMotion="user"：系统开了「减少动态效果」时，全树 framer-motion 的 transform/opacity
    // 动画降为瞬时（屏转场/motif 氛围/浮入），布局切换与拖拽手势不受影响——CSS keyframes 与打字机
    // 的降级分别在 global.css 与 DialogueBox（见 docs/ARCHITECTURE.md「动效降级」）。
    <MotionConfig reducedMotion="user">
      <div className="fixed inset-0 overflow-hidden bg-bg font-serif text-ink" style={themeVars(theme)}>
        <StatusAnnouncer />
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
          {screen === "settings" && <SettingsScreen key="settings" />}
          {screen === "game" && <GameStage key="game" />}
        </AnimatePresence>
        <Atmosphere />
      </div>
    </MotionConfig>
  );
}
