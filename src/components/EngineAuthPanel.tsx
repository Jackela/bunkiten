// 「引擎与密钥」设置节里的**登录状态 + 登录/登出**块（v1.13 从 EngineKeysSection 抽出）。
//
// 登录是**玩家的**（游戏不存凭据，只把 CLI 叫起来，浏览器里完成）；登出是**全局动作**
// （玩家终端里那份登录也一起清掉），所以 UI 上是两段确认（首点出确认条）。
// 状态与动作都留在 EngineKeysSection（它还要按引擎刷新登录态、和凭据一起读），这里只渲染。
import { LogIn, LogOut } from "lucide-react";
import type { EngineEntry } from "../../shared/engines.mjs";

export function EngineAuthPanel({
  auth,
  busy,
  note,
  confirming,
  engineEntry,
  onLogin,
  onRequestLogout,
  onConfirmLogout,
  onCancelLogout,
}: {
  /** 登录态（null = 读取中/读不到；canLogin=false 时按钮不画、改为一句说明） */
  auth: { loggedIn: boolean; canLogin: boolean } | null;
  busy: boolean;
  note: string;
  confirming: boolean;
  engineEntry: EngineEntry;
  onLogin: () => void;
  onRequestLogout: () => void;
  onConfirmLogout: () => void;
  onCancelLogout: () => void;
}) {
  return (
    <>
      {/* 登录状态（v1.11 收尾）：终端登录态看得见、点得动。登录是玩家的（我们不存凭据），
          登出是**全局动作**（终端里那份也一起清），所以两段确认 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-meta text-ink-hint">登录状态</span>
        <span
          data-testid="engine-auth-status"
          className={`rounded-lg border px-3 py-1 text-meta ${
            auth?.loggedIn ? "border-gold/30 bg-gold/10 text-gold" : "border-white/10 text-ink-hint"
          }`}
        >
          {auth === null ? "读取中…" : auth.loggedIn ? "已登录" : "未登录"}
        </span>
        {auth && !auth.loggedIn && auth.canLogin ? (
          <button
            type="button"
            data-testid="engine-auth-login"
            disabled={busy}
            onClick={onLogin}
            className="inline-flex items-center gap-2 rounded-lg border border-gold/40 bg-gold/10 px-4 py-1.5 text-ui text-gold transition-colors hover:bg-gold/20 disabled:opacity-60"
          >
            <LogIn size={14} /> {busy ? "正在打开…" : `登录 ${engineEntry.label}`}
          </button>
        ) : null}
        {auth && !auth.loggedIn && !auth.canLogin ? (
          <span data-testid="engine-auth-unavailable" className="text-meta leading-relaxed text-ink-hint">
            这台机器上没有 {engineEntry.label} 的登录入口{engineEntry.unavailableNote}——你也可以自己在终端运行{" "}
            {engineEntry.loginHint}
          </span>
        ) : null}
        {auth?.loggedIn ? (
          confirming ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="text-meta text-ink-hint">会同时退出你在终端里的登录。</span>
              <button
                type="button"
                data-testid="engine-auth-logout-confirm"
                disabled={busy}
                onClick={onConfirmLogout}
                className="inline-flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/15 px-4 py-1.5 text-ui text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-60"
              >
                <LogOut size={14} /> 确认退出
              </button>
              <button
                type="button"
                data-testid="engine-auth-logout-cancel"
                onClick={onCancelLogout}
                className="rounded-lg border border-white/10 px-4 py-1.5 text-ui text-ink-hint transition-colors hover:border-gold/30 hover:text-ink"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="engine-auth-logout"
              disabled={busy}
              onClick={onRequestLogout}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-1.5 text-ui text-ink-hint transition-colors hover:border-gold/30 hover:text-ink disabled:opacity-60"
            >
              <LogOut size={14} /> 退出登录
            </button>
          )
        ) : null}
      </div>
      {note ? (
        <p data-testid="engine-auth-note" role="status" className="mt-2 text-meta leading-relaxed text-ink-hint">
          {note}
        </p>
      ) : null}
    </>
  );
}
