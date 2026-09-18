import { useEffect, useRef, useState } from "react";
import { visibleTarget } from "../../lib/parser";
import { AUTO_ADVANCE_LABELS, AUTO_ADVANCE_OPTIONS, TEXT_SPEED_MS, type AutoAdvance } from "../../lib/settings";
import { isTypingTarget, useGameStore } from "../../store/game";
import { dialogClass, getTheme } from "../../theme";

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

/**
 * 打开面板「自动」时落到哪个档位：档位表里第一个非零项（3 秒）。
 * 玩家在设置屏把自动前进关掉后，这里得有一个确定的「开」值可用——否则面板上的开关没有能落回去的档。
 * 刻意不记「上次用过的档」：面板上这一下是一键开，档位档细节仍归设置屏；设置屏里选的 5 秒关掉后
 * 再从面板打开会回到 3 秒（按钮的 title 里写着当下生效的档，不含糊）。
 */
const AUTO_ON: AutoAdvance = AUTO_ADVANCE_OPTIONS.filter((v) => v > 0)[0];

/** 面板右上角两个小控件共用的底座：尺寸小、静息只到 hint 档文字（不跟叙事正文抢注意力） */
const CONTROL_BASE = "rounded-md border px-2 py-0.5 text-meta leading-none tracking-[.15em] transition-colors";
/** 未激活：低对比，悬停/聚焦才亮出主题色 */
const CONTROL_IDLE = "border-white/10 text-ink-hint hover:border-gold/30 hover:bg-white/[.05] hover:text-gold";
/** 激活（自动前进开着）：主题色文字 + 描边，一眼能看出它现在是开着的 */
const CONTROL_ON = "border-gold/45 bg-gold/15 text-gold";
/** 不可用（打字已完成的「快进」）：ink-faint 是阶梯里唯一允许的禁用态档位 */
const CONTROL_DEAD = "border-white/5 text-ink-faint";

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
  // v1.8 面板内联的自动/快进控件：自动前进读同一份设置（设置屏的档位与这里是一个开关的两处入口）
  const autoAdvance = useGameStore((s) => s.settings.autoAdvance);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const resumeAutoAdvance = useGameStore((s) => s.resumeAutoAdvance);
  const cancelAutoAdvance = useGameStore((s) => s.cancelAutoAdvance);
  const interval = usePrefersReducedMotion() ? 0 : TEXT_SPEED_MS[textSpeed];
  // v1.7 对话框质感：当前剧本 theme.dialog → global.css 的 dialog-* 类（plain 无规则=现状）
  const texture = useGameStore((s) => dialogClass(getTheme(s.selected).dialog));

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

  // 「快进」按钮的可用性判据与 completeNow 的第一道判断逐字同源：打完（或已经追平）就不谎称点了有用
  const canComplete = !typingDone && shown.length < target.length;
  const autoOn = autoAdvance > 0;

  /**
   * 面板上的「自动」开关（VN 肌肉记忆的入口；与设置屏的「自动前进」档位是同一份设置）。
   *
   * 打开：落到 {@link AUTO_ON} 并立刻起计时（选项已经在屏上时不必等下一回合才生效）。
   * 走 store 的 resumeAutoAdvance——App 在 window 捕获阶段把任何 pointerdown/keydown/input
   * 都当成「玩家接管了」而 cancelAutoAdvance()（本回合 muted），而这一下点击恰恰是玩家明确要求自动前进；
   * 该动作负责解掉标记再武装（语义见 store/context.ts）。
   *
   * 关闭：除了落设置，还必须 cancelAutoAdvance()——倒计时是**已经排好的** setTimeout，
   * 只改设置的话它到点照样替玩家选第一项（关掉自动却自动前进了，玩家只会认为是 bug）。
   */
  const toggleAuto = () => {
    if (autoOn) {
      updateSettings({ autoAdvance: 0 });
      cancelAutoAdvance();
      return;
    }
    updateSettings({ autoAdvance: AUTO_ON });
    resumeAutoAdvance();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 中文输入法组字里的空格是空格；焦点在输入框里时空格是玩家的正文（让路）
      if (e.key !== " " || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // 焦点在按钮上（面板的自动/快进）时空格是**按钮的激活键**：打字中的补全不许把它吞掉——
      // completeNow 会返回 true，不提前让路的话 preventDefault() 会把这次激活按灭（按钮点了没反应）。
      // e.target 可能是 document/window（没有 closest），先卡一道 instanceof
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      // 没在打字就不吞按键：空格照旧走它自己的语义（滚动/激活），而不是被这里吃掉
      if (!completeRef.current()) return;
      e.preventDefault(); // 别让空格滚页
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showReadyHint = status === "就绪" && !options;

  return (
    <div
      data-testid="dialogue-box"
      onClick={completeNow}
      className={`relative min-h-32 cursor-pointer rounded-xl border border-white/10 border-t-gold/35 bg-[rgba(10,12,18,.72)] p-5 pb-4 shadow-[0_20px_60px_rgba(0,0,0,.5)] backdrop-blur-xl ${texture}`}
    >
      {/* 顶部主题色发丝线 */}
      <span
        className="pointer-events-none absolute inset-x-4 top-0 h-px"
        style={{
          background: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 70%, transparent), transparent)",
        }}
      />
      {/* 自动 / 快进：VN 肌肉记忆的两个控件，落位面板右上角。
          刻意**不**放进下面的提示行——提示行只在「打字中 / 等玩家输入」时渲染，
          而这两个控件最需要的时候（选项已上屏、提示行已收起）正好会被一起藏掉。
          两者都 stopPropagation：这里点的是 HUD 上的控件，不是「补全正文」那一击（面板的 onClick 才是）。
          负上边距把那点高度收进面板 padding 里，正文位置几乎不动。 */}
      <div className="mb-1 -mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="dialogue-auto"
          aria-pressed={autoOn}
          aria-label="自动前进"
          title={
            autoOn
              ? `自动前进（${AUTO_ADVANCE_LABELS[autoAdvance]}）· 点击关闭`
              : `自动前进（${AUTO_ADVANCE_LABELS[AUTO_ON]}）· 点击开启`
          }
          onClick={(e) => {
            e.stopPropagation();
            toggleAuto();
          }}
          className={`${CONTROL_BASE} ${autoOn ? CONTROL_ON : CONTROL_IDLE}`}
        >
          自动
        </button>
        <button
          type="button"
          data-testid="dialogue-skip"
          aria-label="立即显示全文"
          title="立即显示全文"
          disabled={!canComplete}
          onClick={(e) => {
            e.stopPropagation();
            completeNow();
          }}
          className={`${CONTROL_BASE} ${canComplete ? CONTROL_IDLE : CONTROL_DEAD}`}
        >
          快进
        </button>
      </div>
      <div
        ref={textRef}
        data-testid="dialogue-text"
        className="max-h-[34vh] overflow-y-auto whitespace-pre-wrap text-read leading-[1.95] tracking-[.03em] max-sm:text-body"
      >
        {shown}
        {!typingDone && <span className="ml-0.5 animate-pulse text-gold">▌</span>}
      </div>
      {(!typingDone || showReadyHint) && (
        <div className="mt-2 flex items-center gap-3 text-meta tracking-[.1em] text-ink-hint">
          {/* 等玩家输入的继续指示：主题色轻微脉冲更醒目；reduced-motion 时 global.css 的媒体规则自动停 */}
          {showReadyHint && <span className="animate-pulse text-gold/90">◈ 输入数字或直接写下你想做的事</span>}
          {/* 打字中才提示补全：打完就没有「补全」可做了 */}
          {!typingDone && (
            <span data-testid="dialogue-hint" className="ml-auto text-meta tracking-[.15em] text-ink-hint">
              空格补全
            </span>
          )}
        </div>
      )}
    </div>
  );
}
