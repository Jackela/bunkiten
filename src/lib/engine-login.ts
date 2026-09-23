// 登录等待的轮询（v1.11 收尾；启动屏与设置屏共用）：一键登录把 CLI 的登录流程拉起来之后，玩家在浏览器里
// 完成的那一刻，我们唯一看得见的信号就是 `/api/auth` 的登录态——所以按固定节奏问它：见到就回调并自停，
// 等到超时就回调 onTimeout（让调用方给一句人话），网络抖一下只跳过这一轮、不把整次登录作废。
import { fetchAuth } from "./acp";

/** 轮询节奏（2s：够快看得出「自动继续」的体感，又不至于把本地端点打成刷子） */
export const LOGIN_POLL_MS = 2000;

/** 等待上限（5 分钟：一次 OAuth 的浏览器往返绰绰有余；超了让玩家点重试） */
export const LOGIN_WAIT_MS = 5 * 60 * 1000;

/** {@link watchLogin} 的可选参数（两个时长覆盖点供测试用） */
export interface WatchLoginOptions {
  /** 等待上限到了仍没看到登录态时回调（调用方据此给提示；轮询已自停） */
  onTimeout?: () => void;
  /** 轮询节奏覆盖（测试用） */
  intervalMs?: number;
  /** 等待上限覆盖（测试用） */
  timeoutMs?: number;
}

/**
 * 开始盯着登录态。
 * @param onLoggedIn 看到登录态（`loggedIn` 或 `hasCredentials`）时回调——**只调一次**
 * @param opts 超时回调与节奏覆盖（测试用）
 * @returns 取消函数（幂等；组件卸载 / 再次点登录 / 切屏时调用）
 */
export function watchLogin(onLoggedIn: () => void, opts: WatchLoginOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? LOGIN_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? LOGIN_WAIT_MS;
  const startedAt = Date.now();
  let stopped = false;
  /** 停掉轮询（幂等） */
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }
  const timer = setInterval(() => {
    if (stopped) return;
    if (Date.now() - startedAt > timeoutMs) {
      stop();
      opts.onTimeout?.();
      return;
    }
    void fetchAuth()
      .then((a) => {
        if (stopped) return;
        if (a.loggedIn || a.hasCredentials) {
          stop();
          onLoggedIn();
        }
      })
      .catch(() => {
        /* 这一轮读失败不算数：等下一轮 */
      });
  }, intervalMs);
  return stop;
}
