import { useEffect, useState } from "react";
import { useGameStore } from "../store/game";

/**
 * 引擎回合耗时秒数：turnStartAt 非 null 时每秒刷新，null 返回 null（回合未进行）。
 * 段切换不重置（store 只在回合边界维护 turnStartAt），与状态行文案拼接用。
 */
export function useTurnElapsed(): number | null {
  const turnStartAt = useGameStore((s) => s.turnStartAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (turnStartAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [turnStartAt]);

  return turnStartAt === null ? null : Math.max(0, Math.floor((now - turnStartAt) / 1000));
}
