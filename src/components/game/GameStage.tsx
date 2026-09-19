import { useGameStore } from "../../store/game";
import { ScreenShell } from "../ScreenShell";
import CharactersDrawer from "./CharactersDrawer";
import DialogueBox from "./DialogueBox";
import FreeInput from "./FreeInput";
import HistoryDrawer from "./HistoryDrawer";
import OptionList from "./OptionList";
import PortraitLayer from "./PortraitLayer";
import TopBar from "./TopBar";

/**
 * 游戏屏：背景层常驻在 App（crafting→game 转场不重载），这里只有立绘、HUD 与对话区。
 * 章节过场卡（ChapterCard）**不在这里**：它挂在 App 根（见其文件头），否则本组件随屏切换重挂时
 * 会把卡一起重建，从 overlay 返回 game 屏就会同一章再亮一次。
 */
export default function GameStage() {
  // 只吃人数（不看队列内容）：立绘上/下屏的瞬间才需要重算让位，换差分不必重渲染本屏
  const castSize = useGameStore((s) => s.portraits.length);
  // 让位分两档：单人沿用 v1.8 的 40vw/420px，同屏 2 人用更宽的 duo 档（数值与实测见 global.css）
  const reserve = castSize === 0 ? "" : castSize > 1 ? "portrait-reserve-duo" : "portrait-reserve";

  return (
    <ScreenShell>
      <PortraitLayer />
      <TopBar />
      {/* 立绘上屏时右侧留出立绘宽度（.portrait-reserve* 只作用于 ≥lg），否则对话区会压在立绘上；
          预留必须在满宽外层上，内层才能在不挤压自身宽度的前提下于剩余空间里重新居中。
          内层宽度是**上限** 800px（≈ 44 个汉字/行，17px 正文——再宽单行就超过舒适阅读的 40-45 字）：
          用 max-w 而不是固定宽，预留吃掉可用宽度时面板跟着收缩，不会从预留区里溢出滑到立绘下面 */}
      <div data-testid="dialogue-dock" className={`fixed inset-x-0 bottom-0 z-20 ${reserve}`}>
        <div className="mx-auto w-full max-w-[800px] px-3.5 pb-3.5">
          <OptionList />
          <DialogueBox />
          <FreeInput />
        </div>
      </div>
      <HistoryDrawer />
      <CharactersDrawer />
    </ScreenShell>
  );
}
