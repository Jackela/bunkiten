// 启动屏：确认叙事引擎能不能用（v1.10 起：终端登录态 **或** 已配好自备密钥，两者任一即可开玩）。
// v1.11（docs/adr/0022）：登录指引与**登录入口**都按当前引擎分支——一键把玩家自己的 CLI 登录流程拉起来
// （grok → `grok login`、codex → 随包 codex 的 `login`，都在浏览器里完成），之后轮询 /api/auth 自动继续；
// 登录态始终是玩家的（我们不存凭据），所以「也可以自己在终端登录」这条老路一直保留着。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, LogIn, RefreshCw } from "lucide-react";
import { fetchAuth, startEngineLogin } from "../lib/acp";
import { watchLogin } from "../lib/engine-login";
import { useAsync } from "../lib/useAsync";
import { ENGINES, engineById } from "../../shared/engines.mjs";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

type BootState = "checking" | "login" | "error";

/** 登录进行到哪一步（idle / 正在拉起 / 已拉起等浏览器完成 / 失败） */
type LoginState =
  { phase: "idle" } | { phase: "starting" } | { phase: "waiting"; hint?: string } | { phase: "error"; error: string };

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
 * 启动屏：三种去处——登录态可用 / 已配好自备密钥（两条都直接进标题屏）/ 都没有（给登录、设置、重试三个入口）。
 * 「填自备密钥」走设置屏（openSettings 记返回目标为 boot，关掉设置就回到这里重新判定）。
 */
export default function BootScreen() {
  const toTitle = useGameStore((s) => s.toTitle);
  const openSettings = useGameStore((s) => s.openSettings);
  const [state, setState] = useState<BootState>("checking");
  // 当前引擎（v1.11）：未登录态的指引文案与登录入口按它分支（/api/auth 每次都回当前引擎 id 与 canLogin）
  const [engine, setEngine] = useState<string>(ENGINES[0].id);
  const [canLogin, setCanLogin] = useState(false);
  const [login, setLogin] = useState<LoginState>({ phase: "idle" });
  // 登录等待的取消函数（切屏/完成/超时都要停掉；卸载时一并清理）
  const stopWatchRef = useRef<(() => void) | null>(null);

  const stopPolling = useCallback(() => {
    stopWatchRef.current?.();
    stopWatchRef.current = null;
  }, []);

  // 自检走 lib/useAsync（AbortController 与「写回前复查 signal.aborted」统一在 hook 里）；
  // 「重试」走 reload——它会中止在途请求再打一次，比原来复用同一个 controller 更干净。
  const authReq = useAsync((signal) => fetchAuth(signal), "boot");
  // 判定去处：登录态可用 / 已配好自备密钥（两条都直接进标题屏）/ 都没有（给登录、设置、重试三个入口）
  useEffect(() => {
    if (!authReq.data) return;
    setEngine(authReq.data.engine);
    setCanLogin(authReq.data.canLogin);
    if (authReq.data.loggedIn || authReq.data.hasCredentials) toTitle();
    else setState("login");
  }, [authReq.data, toTitle]);
  // 读不到（含挂住超过 15s 的超时）：错误态给 RetryCard
  useEffect(() => {
    if (authReq.error) setState("error");
  }, [authReq.error]);
  // 卸载时停掉登录轮询
  useEffect(() => () => stopWatchRef.current?.(), []);

  const retryCheck = () => {
    setState("checking");
    authReq.reload();
  };

  /**
   * 一键登录：把玩家自己的 CLI 登录流程拉起来（浏览器里完成），然后轮询 /api/auth——
   * 看到登录态出现就自动进标题屏（省掉「登录完还要回来点一下」这一步）。
   */
  const doLogin = async () => {
    setLogin({ phase: "starting" });
    const r = await startEngineLogin();
    if (!r.ok) {
      setLogin({ phase: "error", error: r.error ?? "没能启动登录流程" });
      return;
    }
    setLogin({ phase: "waiting", hint: r.hint });
    stopPolling();
    stopWatchRef.current = watchLogin(
      () => {
        stopWatchRef.current = null;
        toTitle();
      },
      {
        onTimeout: () => {
          stopWatchRef.current = null;
          setLogin({ phase: "error", error: "等待超时了——完成登录后点「重试」即可" });
        },
      },
    );
  };

  // 当前引擎条目（未知 id 回落表里第一个——服务端读路径同样回落，见 shared/engines.mjs）
  const engineEntry = engineById(engine) ?? ENGINES[0];

  return (
    <ScreenShell className="flex flex-col items-center justify-center gap-5 shell-backdrop p-6">
      <h1 className="text-display font-normal tracking-[.55em] [text-indent:.55em]">剧 本</h1>

      {state === "checking" && (
        <p className="animate-pulse text-meta tracking-[.3em] text-ink-hint">正在确认登录状态…</p>
      )}

      {state === "login" && (
        <div className="shell-panel w-full max-w-md rounded-2xl p-6 text-center" data-testid="boot-login">
          <p className="text-body leading-relaxed text-ink-body">还没连上叙事引擎。</p>
          <p className="mt-2 text-meta leading-relaxed text-ink-hint">
            {canLogin
              ? `点下面的按钮会打开浏览器完成 ${engineEntry.label} 登录，登录成功后这里会自动继续；`
              : `没找到 ${engineEntry.label} 的登录入口，`}
            也可以自己在终端运行
            <code className="mx-1.5 rounded bg-black/40 px-2 py-0.5 text-gold">{engineEntry.loginHint}</code>
            登录后回来点重试。
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {canLogin && login.phase !== "waiting" ? (
              <button
                type="button"
                data-testid="boot-login-start"
                onClick={() => void doLogin()}
                disabled={login.phase === "starting"}
                className="inline-flex items-center gap-2 rounded-lg border border-gold/50 bg-gold/15 px-5 py-2 text-ui text-gold transition-colors hover:bg-gold/25 disabled:opacity-60"
              >
                <LogIn size={14} /> {login.phase === "starting" ? "正在打开…" : `登录 ${engineEntry.label}`}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="boot-credentials"
              onClick={openSettings}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-5 py-2 text-ui text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              <KeyRound size={14} /> {engineEntry.byok ? "填自备密钥" : "打开设置"}
            </button>
            <button
              type="button"
              data-testid="boot-retry"
              onClick={retryCheck}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-5 py-2 text-ui text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              <RefreshCw size={14} /> 重试
            </button>
          </div>
          {login.phase === "waiting" ? (
            <p data-testid="boot-login-waiting" role="status" className="mt-3 text-meta leading-relaxed text-ink-hint">
              已打开浏览器，完成登录后这里会自动继续…
              {login.hint ? <span className="mt-1 block break-all text-ink-faint">{login.hint}</span> : null}
            </p>
          ) : null}
          {login.phase === "error" ? (
            <p data-testid="boot-login-error" role="status" className="mt-3 text-meta leading-relaxed text-ink-hint">
              {login.error}
            </p>
          ) : null}
        </div>
      )}

      {state === "error" && (
        <RetryCard title="连不上叙事服务。" hint="请确认本地服务已启动，然后重试。" onRetry={retryCheck} />
      )}
    </ScreenShell>
  );
}
