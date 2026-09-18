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
  const portrait = useGameStore((s) => s.portrait);

  return (
    <ScreenShell>
      <PortraitLayer />
      <TopBar />
      {/* 立绘上屏时右侧留出立绘宽度（.portrait-reserve 只作用于 ≥lg），否则对话区会压在立绘上；
          预留必须在满宽外层上，内层才能在不挤压自身宽度的前提下于剩余空间里重新居中。
          内层宽度是**上限** 800px（≈ 44 个汉字/行，17px 正文——再宽单行就超过舒适阅读的 40-45 字）：
          用 max-w 而不是固定宽，预留吃掉可用宽度时面板跟着收缩，不会从预留区里溢出滑到立绘下面 */}
      <div className={`fixed inset-x-0 bottom-0 z-20 ${portrait ? "portrait-reserve" : ""}`}>
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
