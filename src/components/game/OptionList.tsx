import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { isTypingTarget, useGameStore } from "../../store/game";

/** 倒计时标记的刷新节拍（秒数显示用；store 侧的到点定时器另算，这里只管把读数画出来） */
const TICK_MS = 250;

/** 事件 → 选项序号（1-9 与 Numpad1-9；不是数字键返回 null） */
function digitOf(e: KeyboardEvent): number | null {
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
  const m = /^Numpad([1-9])$/.exec(e.code ?? "");
  return m ? Number(m[1]) : null;
}

/** 剩余秒数（deadline 为 null 时恒 0）；每 TICK_MS 走一次表，到点由 store 的定时器接管 */
function useAutoAdvanceLeft(deadline: number | null): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (deadline === null) {
      setSec(0);
      return;
    }
    const left = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setSec(left());
    const t = setInterval(() => setSec(left()), TICK_MS);
    return () => clearInterval(t);
  }, [deadline]);
  return sec;
}

/** 选项列表：打字机完成后逐条浮入。galgame 规范的居中竖排 + ◇ 子弹 + 悬停主题色描边微上浮 */
export default function OptionList() {
  const options = useGameStore((s) => s.options);
  const typingDone = useGameStore((s) => s.typingDone);
  // 玩家叙事入口：走 sendPlayerTurn（服务端把这次输入随快照条目落盘，重演时可原样重发），不裸调 send
  const sendPlayerTurn = useGameStore((s) => s.sendPlayerTurn);
  const autoAdvance = useGameStore((s) => s.settings.autoAdvance);
  const autoAdvanceDeadline = useGameStore((s) => s.autoAdvanceDeadline);
  const armAutoAdvance = useGameStore((s) => s.armAutoAdvance);
  const cancelAutoAdvance = useGameStore((s) => s.cancelAutoAdvance);

  // 与渲染条件同一个判断：选项真的可见（打字完成 + 有选项）才谈快捷键与倒计时
  const visible = typingDone && !!options && options.length > 0;
  const left = useAutoAdvanceLeft(autoAdvanceDeadline);

  // 选项上屏 = 打字完成且选项就绪：启动自动前进倒计时（设置关/引擎忙/有排队指令由 store 拒绝）；
  // 选项收起（已选 / 新回合 / 离屏）就作废——倒计时不该在后台替玩家做决定
  useEffect(() => {
    if (!visible) return;
    armAutoAdvance();
    return () => cancelAutoAdvance();
  }, [visible, armAutoAdvance, cancelAutoAdvance]);

  // 数字键选选项（1-9 与 Numpad1-9）：焦点在输入框里时让路（那是在打字，不是在选选项）
  useEffect(() => {
    if (!visible || !options) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const digit = digitOf(e);
      if (digit === null) return;
      const opt = options[digit - 1];
      if (!opt) return; // 只有两个选项时按 9：什么都不做，别吞按键
      e.preventDefault();
      sendPlayerTurn(opt.t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, options, sendPlayerTurn]);

  if (!visible || !options) return null;

  return (
    <div data-testid="options" className="mb-3 mx-auto flex w-fit max-w-full flex-col items-center gap-1">
      {autoAdvanceDeadline !== null && autoAdvance > 0 && (
        <p data-testid="auto-advance" className="text-meta tracking-[.15em] text-ink-hint">
          自动前进 · {left}s
        </p>
      )}
      {options.map((o, i) => (
        <motion.button
          key={i}
          type="button"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: Math.min(i * 0.08, 0.32), ease: "easeOut" }}
          onClick={() => sendPlayerTurn(o.t)}
          className="group flex items-center justify-center gap-2.5 rounded-lg border border-transparent bg-panel-soft px-5 py-2 text-center text-body tracking-[.03em] text-ink-body backdrop-blur-md transition-[color,border-color,transform,background-color] duration-200 hover:-translate-y-0.5 hover:border-[color:var(--accent)] hover:bg-panel-sunken hover:text-ink"
        >
          <span className="text-micro leading-none text-[color:var(--accent)]/80 transition-transform duration-200 group-hover:rotate-90">
            ◇
          </span>
          {o.n && <b className="font-normal text-[color:var(--accent)]">{o.n}</b>}
          <span>{o.t}</span>
        </motion.button>
      ))}
      {/* 快捷键提示：低调到不妨碍阅读，但键盘玩家一眼能找到 */}
      <p data-testid="option-hints" className="mt-0.5 text-meta tracking-[.15em] text-ink-hint">
        1-9 选择 · 空格补全
      </p>
    </div>
  );
}
