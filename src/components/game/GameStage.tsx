import { ScreenShell } from "../ScreenShell";
import DialogueBox from "./DialogueBox";
import FreeInput from "./FreeInput";
import HistoryDrawer from "./HistoryDrawer";
import OptionList from "./OptionList";
import PortraitLayer from "./PortraitLayer";
import TopBar from "./TopBar";

/** 游戏屏：背景层常驻在 App（crafting→game 转场不重载），这里只有立绘、HUD 与对话区 */
export default function GameStage() {
  return (
    <ScreenShell>
      <PortraitLayer />
      <TopBar />
      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-[min(860px,100vw)] px-3.5 pb-3.5">
        <OptionList />
        <DialogueBox />
        <FreeInput />
      </div>
      <HistoryDrawer />
    </ScreenShell>
  );
}
