import { useEffect, useRef, useState } from "react";
import { visibleTarget } from "../../lib/parser";
import { TEXT_SPEED_MS } from "../../lib/settings";
import { isTypingTarget, useGameStore } from "../../store/game";

/** 追赶步长分母：落后文本过多时加速补齐，上限约 3 秒（预载屏转场后正文已积累的场景） */
const CATCH_UP_DIVISOR = 125;

/** 系统动效偏好查询（v1.7 动效降级）：「减少动态效果」开启时打字机整段显示 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 系统是否开了「减少动态效果」：matchMedia 不存在（jsdom 等无实现环境）时视为未开启——
 * 探测绝不抛错，缺实现就走原打字机路径。
 */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 系统动效偏好：挂载时读一次，之后跟随系统设置变化；只影响呈现，不碰用户的文字速度档 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** 对话框：按行保持的打字机 + 金色光标（行为对齐旧版 #text） */
export default function DialogueBox() {
  const received = useGameStore((s) => s.received);
  const finalText = useGameStore((s) => s.finalText);
  const turnKey = useGameStore((s) => s.turnKey);
  const options = useGameStore((s) => s.options);
  const typingDone = useGameStore((s) => s.typingDone);
  const status = useGameStore((s) => s.status);
  const setTypingDone = useGameStore((s) => s.setTypingDone);
  // v1.6 设置：打字间隔按档位（instant=0 → 直接整段显示）；
  // v1.7 动效降级：系统开了「减少动态效果」时按瞬间档**呈现**（不改用户设置——OS 级偏好不重复发明开关）
  const textSpeed = useGameStore((s) => s.settings.textSpeed);
  const interval = usePrefersReducedMotion() ? 0 : TEXT_SPEED_MS[textSpeed];

  const target = visibleTarget(received, finalText);
  const [shown, setShown] = useState("");
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown("");
  }, [turnKey]);

  useEffect(() => {
    if (shown === target) return;
    // 瞬间档：不排队定时器，直接补全文（中途切到瞬间也会立刻补齐在跑的动画）
    if (interval <= 0) {
      setShown(target);
      return;
    }
    const step = Math.max(1, Math.ceil((target.length - shown.length) / CATCH_UP_DIVISOR));
    const t = setTimeout(() => setShown(target.slice(0, shown.length + step)), interval);
    return () => clearTimeout(t);
  }, [shown, target, interval]);

  useEffect(() => {
    if (finalText && shown.length >= target.length) setTypingDone(true);
  }, [finalText, shown, target, setTypingDone]);

  useEffect(() => {
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  // 标准 galgame 行为：打字未完成时点击对话框立即补完全文。
  // 只补文本：finalText 定稿后 typingDone 由下方 effect 自动置位；流式续到时打字机自然恢复。
  // @returns {boolean} 是否真的补了（空格键据此决定要不要吞掉这次按键）
  const completeNow = (): boolean => {
    if (typingDone || shown.length >= target.length) return false;
    setShown(target);
    return true;
  };

  // 空格键走点击同一条路（completeNow）。打字机每 ~24ms 换一次 shown，监听不能跟着重挂：
  // 最新闭包存 ref，window 监听只挂一次。
  const completeRef = useRef(completeNow);
  useEffect(() => {
    completeRef.current = completeNow;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 中文输入法组字里的空格是空格；焦点在输入框里时空格是玩家的正文（让路）
      if (e.key !== " " || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // 没在打字就不吞按键：聚焦在按钮上的空格该按它自己的语义走（激活），而不是被这里吃掉
      if (!completeRef.current()) return;
      e.preventDefault(); // 别让空格滚页
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showReadyHint = status === "就绪" && !options;

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
      {(!typingDone || showReadyHint) && (
        <div className="mt-2 flex items-center gap-3 text-xs tracking-[.1em] text-ink/50">
          {showReadyHint && <span>◈ 输入数字或直接写下你想做的事</span>}
          {/* 打字中才提示补全：打完就没有「补全」可做了 */}
          {!typingDone && (
            <span data-testid="dialogue-hint" className="ml-auto text-[11px] tracking-[.15em] text-ink/35">
              空格补全
            </span>
          )}
        </div>
      )}
    </div>
  );
}
