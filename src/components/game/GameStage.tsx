import { useEffect, useState } from "react";
import { useGameStore, type TurnDelta } from "../../store/game";
import { ScreenShell } from "../ScreenShell";
import CharactersDrawer from "./CharactersDrawer";
import DialogueBox from "./DialogueBox";
import FreeInput from "./FreeInput";
import HistoryDrawer from "./HistoryDrawer";
import OptionList from "./OptionList";
import PortraitLayer from "./PortraitLayer";
import TopBar from "./TopBar";

/** 差分条在屏时长（ms）：数秒淡出，够读一眼又不常驻压画面（导出给用例当时间真源） */
export const TURN_DELTA_MS = 6000;

/**
 * 数值差分条（v1.14 因果反馈）：`store.lastTurnDeltas` 有值才现，数秒后淡出、换回合清零。
 * 行文案如「排异指数 65 → 73 ↑」——把「这一回合世界变在哪」摆在对话区正上方。
 *
 * 为什么用本地定时器而不是清 store：lastTurnDeltas 由 store 在回合收尾写、下一回合覆盖，组件只读；
 * 这里保留「最近一次非空的差值」并起一个 6s 定时器（新差值到达即重置计时），到点自己撤下。
 * store 把差值置回 null（本回合无变化/换了局）时立刻撤下——不闪、不残留上一局的数。
 * role="status"：读屏把它当一条状态读出，与 StatusAnnouncer 的 polite 语气一致。
 */
function TurnDeltas() {
  const deltas = useGameStore((s) => s.lastTurnDeltas);
  const [shown, setShown] = useState<TurnDelta[] | null>(null);
  useEffect(() => {
    if (!deltas || deltas.length === 0) {
      setShown(null);
      return;
    }
    setShown(deltas);
    const t = setTimeout(() => setShown(null), TURN_DELTA_MS);
    return () => clearTimeout(t);
  }, [deltas]);
  if (!shown) return null;
  return (
    <div
      data-testid="turn-deltas"
      role="status"
      aria-live="polite"
      className="mx-auto mb-2 flex w-fit max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-0.5 rounded-lg border border-white/[.08] bg-panel-soft px-3 py-1.5 text-meta tracking-[.08em] text-ink-body backdrop-blur-md"
    >
      {shown.map((d) => (
        <span key={d.name} data-testid={`turn-delta-${d.name}`} className="tabular-nums text-ink-hint">
          {d.name} <span className="text-ink-body">{d.from}</span>
          {" → "}
          <span className="text-ink-body">{d.to}</span>{" "}
          <span className={d.dir === "down" ? "text-[#d98b8b]" : "text-gold"}>{d.dir === "down" ? "↓" : "↑"}</span>
        </span>
      ))}
    </div>
  );
}

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
  // 两个抽屉各有开关、可同时开（Esc 链也是两环），任一打开就压住背后的舞台。
  // 两个 selector **分开**调（别写成 `useGameStore(a) || useGameStore(b)`：|| 会短路掉右边那次
  // hook 调用，第一个抽屉一开就是「Rendered fewer hooks than expected」）
  const drawerOpen = useGameStore((s) => s.drawerOpen);
  const charactersOpen = useGameStore((s) => s.charactersOpen);
  const backstageInert = drawerOpen || charactersOpen;

  return (
    <ScreenShell>
      {/* 舞台背景（立绘 + HUD + 对话区）整块一层：抽屉打开时这一层 inert——点击、Tab、程序化 focus
          都进不去，键盘用户不会再从抽屉逛到 TopBar 与命令轨（这就是 ROADMAP §3 说的「背景 inert」）。
          两条硬约束写在这里，免得下次调整结构时踩回去：
          ① **两个抽屉必须留在这层之外**：inert 子树里的元素连 el.focus() 都是 no-op（Chromium 实测），
             把抽屉套进来，焦点陷阱就再也无法把焦点送进抽屉（层开着却停在外面的键盘用户 = 死路）；
          ② inert 由 React 按属性写在**提交的变更阶段**落地，早于焦点陷阱的被动 effect 一拍——
             顺序正好：先压背景（此刻焦点还在命令轨按钮上；Chromium 不会因为元素变 inert 而掉焦点），
             紧接着 useFocusTrap 把焦点搬进抽屉；关闭那一拍反过来——变更阶段先摘掉 inert，
             被动清理随后归还焦点，归还目标（命令轨按钮）此刻已经恢复可聚焦。 */}
      <div data-testid="stage-background" inert={backstageInert}>
        <PortraitLayer />
        <TopBar />
        {/* 立绘上屏时右侧留出立绘宽度（.portrait-reserve* 只作用于 ≥lg），否则对话区会压在立绘上；
            预留必须在满宽外层上，内层才能在不挤压自身宽度的前提下于剩余空间里重新居中。
            内层宽度是**上限** 800px（≈ 44 个汉字/行，17px 正文——再宽单行就超过舒适阅读的 40-45 字）：
            用 max-w 而不是固定宽，预留吃掉可用宽度时面板跟着收缩，不会从预留区里溢出滑到立绘下面 */}
        <div data-testid="dialogue-dock" className={`fixed inset-x-0 bottom-0 z-20 ${reserve}`}>
          <div className="mx-auto w-full max-w-[800px] px-3.5 pb-3.5">
            <TurnDeltas />
            <OptionList />
            <DialogueBox />
            <FreeInput />
          </div>
        </div>
      </div>
      <HistoryDrawer />
      <CharactersDrawer />
    </ScreenShell>
  );
}
