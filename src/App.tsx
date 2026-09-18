import { useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig } from "framer-motion";
import { subscribeEvents } from "./lib/acp";
import { playerStatus } from "./lib/status";
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
import PresetCheckScreen from "./components/PresetCheckScreen";
import GameStage from "./components/game/GameStage";
import BgLayer from "./components/game/BgLayer";
import ChapterCard from "./components/game/ChapterCard";
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
      {playerStatus(text)}
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

  // Esc 关闭链（画廊预览 → 剧情图节点详情 → 历史抽屉 → 角色面板 → 创作退出确认 → 剧情图/设置 → 捏人屏/世界线屏）；
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
      if (s.charactersOpen) {
        s.toggleCharacters();
        return;
      }
      if (s.creationExitPrompt) {
        s.closeCreationExitPrompt();
        return;
      }
      // overlay 屏（剧情图/设置/剧本体检）：Esc 返回进入前的原屏
      if (s.screen === "tree" || s.screen === "settings" || s.screen === "check") {
        s.closeOverlay();
        return;
      }
      // 捏人屏（worlds 屏的「新世界线」）不是死路：Esc 回世界线屏，牌面留着（见 nav.toWorlds）
      if (s.screen === "protagonist") s.toWorlds();
      if (s.screen === "worlds") s.toTitle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // reducedMotion="user"：系统开了「减少动态效果」时，全树 framer-motion 的位移/布局动画
    // （transform 与 layout）降为瞬时；交叉淡入（opacity，如屏转场与差分切换）按 framer-motion
    // 13 的语义保留——淡入本身是 WCAG 推荐的降级替代。CSS keyframes 与打字机的降级分别在
    // global.css 与 DialogueBox（见 docs/ARCHITECTURE.md「动效降级」）。
    <MotionConfig reducedMotion="user">
      <div className="fixed inset-0 overflow-hidden bg-bg text-ink" style={{ ...themeVars(theme), fontFamily: "var(--font-preset)" }}>
        <StatusAnnouncer />
        <BgLayer />
        <div className="pointer-events-none absolute inset-0">
          <MotifLayer motif={theme.motif} />
        </div>
        <Veil />
        {/* 章节过场卡常驻在这一层（不在 GameStage 里）：屏切换会重建整棵子树，卡挂在屏内就必然
            在「画廊/剧情图 → game」返回时同章号再亮一次；它的跨屏记忆与渲染条件见 ChapterCard 文件头 */}
        <ChapterCard />
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
          {screen === "check" && <PresetCheckScreen key="check" />}
          {screen === "game" && <GameStage key="game" />}
        </AnimatePresence>
        <Atmosphere />
      </div>
    </MotionConfig>
  );
}
