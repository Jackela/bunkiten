import { useEffect, useState } from "react";
import { useGameStore } from "../store/game";

/**
 * 每秒一跳的「现在」（active 为真时才起定时器）：给屏上那些「已耗时 / 平均 / 约还需」的读数用。
 * 抽出来是因为不止回合耗时需要它——制作中屏的剩余预估（v1.13）也要同一份节拍，
 * 别为每个读数各起一个 setInterval。
 */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * 引擎回合耗时秒数：turnStartAt 非 null 时每秒刷新，null 返回 null（回合未进行）。
 * 段切换不重置（store 只在回合边界维护 turnStartAt），与状态行文案拼接用。
 */
export function useTurnElapsed(): number | null {
  const turnStartAt = useGameStore((s) => s.turnStartAt);
  const now = useTick(turnStartAt !== null);
  return turnStartAt === null ? null : Math.max(0, Math.floor((now - turnStartAt) / 1000));
}
