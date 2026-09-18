import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { fetchAuth } from "../lib/acp";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

type BootState = "checking" | "login" | "error";

/** 登录/连不上两种失败态共用的提示卡：一句主因 + 一句怎么办 + 重试（同一张卡，两态只有文案差） */
function RetryCard({ title, hint, onRetry }: { title: string; hint: ReactNode; onRetry: () => void }) {
  return (
    <div className="shell-panel w-full max-w-md rounded-2xl p-6 text-center">
      <p className="text-body leading-relaxed text-ink-body">{title}</p>
      <p className="mt-2 text-meta leading-relaxed text-ink-hint">{hint}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex items-center gap-2 rounded-lg border border-gold/50 bg-gold/15 px-5 py-2 text-ui text-gold transition-colors hover:bg-gold/25"
      >
        <RefreshCw size={14} /> 重试
      </button>
    </div>
  );
}

/** 启动屏：确认叙事引擎登录态，未登录给终端指引 */
export default function BootScreen() {
  const toTitle = useGameStore((s) => s.toTitle);
  const [state, setState] = useState<BootState>("checking");

  const check = useCallback(async () => {
    setState("checking");
    try {
      const { loggedIn } = await fetchAuth();
      if (loggedIn) toTitle();
      else setState("login");
    } catch {
      setState("error");
    }
  }, [toTitle]);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <ScreenShell className="flex flex-col items-center justify-center gap-5 shell-backdrop p-6">
      <h1 className="text-display font-normal tracking-[.55em] [text-indent:.55em]">剧 本</h1>

      {state === "checking" && <p className="animate-pulse text-meta tracking-[.3em] text-ink-hint">正在确认登录状态…</p>}

      {state === "login" && (
        <RetryCard
          title="还没登录叙事引擎。"
          hint={
            <>
              在终端运行
              <code className="mx-1.5 rounded bg-black/40 px-2 py-0.5 text-gold">grok login</code>
              完成登录，然后回到这里重试。
            </>
          }
          onRetry={() => void check()}
        />
      )}

      {state === "error" && (
        <RetryCard title="连不上叙事服务。" hint="请确认本地服务已启动，然后重试。" onRetry={() => void check()} />
      )}
    </ScreenShell>
  );
}
