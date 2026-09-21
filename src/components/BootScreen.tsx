// 启动屏：确认叙事引擎能不能用（v1.10 起：grok 登录态 **或** 已配好自备密钥，两者任一即可开玩）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
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

/**
 * 启动屏：三种去处——登录态可用 / 已配好自备密钥（两条都直接进标题屏）/ 都没有（给两个入口）。
 * 「填自备密钥」走设置屏（openSettings 记返回目标为 boot，关掉设置就回到这里重新判定）。
 */
export default function BootScreen() {
  const toTitle = useGameStore((s) => s.toTitle);
  const openSettings = useGameStore((s) => s.openSettings);
  const [state, setState] = useState<BootState>("checking");
  // 自检的取消信号（对齐 TitleScreen 的既有做法）：自检挂着 15s 上限，不取消的话切屏后会有一条
  // /api/auth 拖到点，再往已卸载的组件里写 error 态。retry 复用同一个 controller（同一次挂载内不互相取消）
  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    setState("checking");
    try {
      const { loggedIn, hasCredentials } = await fetchAuth(abortRef.current?.signal);
      if (loggedIn || hasCredentials) toTitle();
      else setState("login");
    } catch (e) {
      // 卸载/切屏：静默（与 TitleScreen 的 catch 同款——只放行 AbortError）；其余一律进错误态
      if ((e as Error).name === "AbortError") return;
      setState("error");
    }
  }, [toTitle]);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void check();
    return () => {
      ctrl.abort();
      abortRef.current = null;
    };
  }, [check]);

  return (
    <ScreenShell className="flex flex-col items-center justify-center gap-5 shell-backdrop p-6">
      <h1 className="text-display font-normal tracking-[.55em] [text-indent:.55em]">剧 本</h1>

      {state === "checking" && <p className="animate-pulse text-meta tracking-[.3em] text-ink-hint">正在确认登录状态…</p>}

      {state === "login" && (
        <div className="shell-panel w-full max-w-md rounded-2xl p-6 text-center" data-testid="boot-login">
          <p className="text-body leading-relaxed text-ink-body">还没连上叙事引擎。</p>
          <p className="mt-2 text-meta leading-relaxed text-ink-hint">
            可以填一份自己的密钥（不碰终端），也可以在终端运行
            <code className="mx-1.5 rounded bg-black/40 px-2 py-0.5 text-gold">grok login</code>
            登录后再回来重试。
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              data-testid="boot-credentials"
              onClick={openSettings}
              className="inline-flex items-center gap-2 rounded-lg border border-gold/50 bg-gold/15 px-5 py-2 text-ui text-gold transition-colors hover:bg-gold/25"
            >
              <KeyRound size={14} /> 填自备密钥
            </button>
            <button
              type="button"
              data-testid="boot-retry"
              onClick={() => void check()}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-5 py-2 text-ui text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              <RefreshCw size={14} /> 重试
            </button>
          </div>
        </div>
      )}

      {state === "error" && (
        <RetryCard title="连不上叙事服务。" hint="请确认本地服务已启动，然后重试。" onRetry={() => void check()} />
      )}
    </ScreenShell>
  );
}
