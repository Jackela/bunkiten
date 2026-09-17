import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchAuth } from "../lib/acp";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

type BootState = "checking" | "login" | "error";

/** 启动屏：确认 grok CLI 登录态，未登录给终端指引 */
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
    <ScreenShell className="flex flex-col items-center justify-center gap-5 bg-[radial-gradient(120%_90%_at_50%_0%,#131627_0%,#07080c_60%)] p-6">
      <h1 className="text-3xl font-normal tracking-[.55em] [text-indent:.55em]">剧 本</h1>

      {state === "checking" && <p className="animate-pulse text-[13px] tracking-[.3em] text-ink-hint">正在确认引擎登录状态…</p>}

      {state === "login" && (
        <div className="max-w-md rounded-xl border border-white/10 bg-white/5 p-6 text-center">
          <p className="text-sm leading-relaxed text-ink/80">还没有登录 Grok 引擎。</p>
          <p className="mt-2 text-sm leading-relaxed text-ink/60">
            打开终端，运行
            <code className="mx-1.5 rounded bg-black/40 px-2 py-0.5 text-gold">grok login</code>
            完成登录，然后回到这里重试。
          </p>
          <button
            type="button"
            onClick={() => void check()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-gold/50 bg-gold/15 px-5 py-2 text-sm text-gold transition-colors hover:bg-gold/25"
          >
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      )}

      {state === "error" && (
        <div className="max-w-md rounded-xl border border-white/10 bg-white/5 p-6 text-center">
          <p className="text-sm leading-relaxed text-ink/80">连不上引擎服务。</p>
          <p className="mt-2 text-sm leading-relaxed text-ink/60">请确认 acp-server 已启动（终端运行 node server/acp-server.mjs）。</p>
          <button
            type="button"
            onClick={() => void check()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-gold/50 bg-gold/15 px-5 py-2 text-sm text-gold transition-colors hover:bg-gold/25"
          >
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      )}
    </ScreenShell>
  );
}
