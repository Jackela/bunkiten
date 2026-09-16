import { useEffect, useRef, useState } from "react";
import { visibleTarget } from "../../lib/parser";
import { useGameStore } from "../../store/game";

/** 追赶步长分母：落后文本过多时加速补齐，上限约 3 秒（预载屏转场后正文已积累的场景） */
const CATCH_UP_DIVISOR = 125;
const TYPE_INTERVAL_MS = 24;

/** 对话框：按行保持的打字机 + 金色光标（行为对齐旧版 #text） */
export default function DialogueBox() {
  const received = useGameStore((s) => s.received);
  const finalText = useGameStore((s) => s.finalText);
  const turnKey = useGameStore((s) => s.turnKey);
  const options = useGameStore((s) => s.options);
  const typingDone = useGameStore((s) => s.typingDone);
  const status = useGameStore((s) => s.status);
  const setTypingDone = useGameStore((s) => s.setTypingDone);

  const target = visibleTarget(received, finalText);
  const [shown, setShown] = useState("");
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown("");
  }, [turnKey]);

  useEffect(() => {
    if (shown === target) return;
    const step = Math.max(1, Math.ceil((target.length - shown.length) / CATCH_UP_DIVISOR));
    const t = setTimeout(() => setShown(target.slice(0, shown.length + step)), TYPE_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [shown, target]);

  useEffect(() => {
    if (finalText && shown.length >= target.length) setTypingDone(true);
  }, [finalText, shown, target, setTypingDone]);

  useEffect(() => {
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  // 标准 galgame 行为：打字未完成时点击对话框立即补完全文。
  // 只补文本：finalText 定稿后 typingDone 由下方 effect 自动置位；流式续到时打字机自然恢复。
  const completeNow = () => {
    if (!typingDone && shown.length < target.length) setShown(target);
  };

  return (
    <div
      onClick={completeNow}
      className="relative min-h-32 cursor-pointer rounded-xl border border-white/10 border-t-gold/35 bg-[rgba(10,12,18,.72)] p-5 pb-4 shadow-[0_20px_60px_rgba(0,0,0,.5)] backdrop-blur-xl"
    >
      {/* 顶部主题色发丝线 */}
      <span
        className="pointer-events-none absolute inset-x-4 top-0 h-px"
        style={{
          background: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 70%, transparent), transparent)",
        }}
      />
      <div
        ref={textRef}
        data-testid="dialogue-text"
        className="max-h-[34vh] overflow-y-auto whitespace-pre-wrap text-[17px] leading-[1.95] tracking-[.03em] max-sm:text-[15.5px]"
      >
        {shown}
        {!typingDone && <span className="ml-0.5 animate-pulse text-gold">▌</span>}
      </div>
      {status === "就绪" && !options && (
        <div className="mt-2 text-xs tracking-[.1em] text-ink/50">◈ 输入数字或直接写下你想做的事</div>
      )}
    </div>
  );
}
