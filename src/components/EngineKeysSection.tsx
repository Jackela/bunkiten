// 「引擎与密钥」设置节（v1.10，docs/adr/0019）：玩家在 GUI 里填自备的对话服务与出图服务。
// 挂在 SettingsScreen 里（完整设置屏），本身不占屏——只负责这一节的取数/保存/测试/重启。
//
// 交互约定（与设置屏其余部分一致：改动即时生效、没有「保存」按钮）：
//   · 文本格改动 → 400ms 静默后自动保存（防每敲一个字打一次盘）；下拉/开关立即保存；
//   · key 格**永不由服务端回填**：输入中就是本地明文（type=password，可「显示」），失焦即提交并清空本地值，
//     之后显示服务端的掩码（`sk-…4f2a`）——任何一帧都没有「服务端把明文发回屏上」这回事；
//   · 「测试连接」测的是**已保存**的配置（真连一次服务），失败原因来自服务端（已脱敏、已截断）；
//   · 保存成功给一句人话提示 + 「立刻重启引擎」——引擎子进程的 env 只在启动时读一次。
//
// 服务目录（v1.10，docs/adr/0020）：下拉候选优先取服务端的在线目录（`/api/providers`），
// 读不到就回落内置真源 `providersFor`（唯一的 id 表，别处不许再抄一份）。**目录只喂候选**：
// 它到屏上只影响「有哪些服务可挑」，绝不改写玩家已存的地址/密钥/模型（保存仍只由玩家动作触发）。
//
// 文案纪律：不出现 env、变量名、配置文件路径这类内部词；说的是「服务地址 / 密钥 / 模型」。
// v1.13：两组表单拆到 `EngineGroupForm`、登录/登出块拆到 `EngineAuthPanel`；三处取数收进 `lib/useAsync`。
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import {
  engineLogout,
  fetchAuth,
  fetchCredentials,
  fetchProviders,
  postCredentials,
  restartEngine,
  startEngineLogin,
  type CredentialsView,
} from "../lib/acp";
import { watchLogin } from "../lib/engine-login";
import { useAsync } from "../lib/useAsync";
import { ENGINES, engineById } from "../../shared/engines.mjs";
import { EngineAuthPanel } from "./EngineAuthPanel";
import { EngineGroupForm } from "./EngineGroupForm";

/**
 * 设置屏的「引擎与密钥」整节：两份 GroupForm + 保存提示与重启按钮。
 * 取数失败走一句人话 + 重试（与设置屏其余部分不同：凭据在服务端，拉不到就画不出掩码）。
 * 另外独立读一次在线服务目录（v1.10）：读到就用它画下拉、没读到就静默回落内置表（不占错误态）。
 * @param {object} [props]
 * @param {boolean} [props.showTitle] 是否画节内标题（缺省 true）。设置屏把整节收进披露区（v1.12）时传 false——
 *   披露头已经写着「引擎与密钥」，同一句话上下叠两遍只是噪声；直接渲染本组件的场景照旧带标题。
 */
export default function EngineKeysSection({ showTitle = true }: { showTitle?: boolean }) {
  const [view, setView] = useState<CredentialsView | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [restart, setRestart] = useState<{ state: "idle" | "running" | "done" | "error"; error?: string }>({
    state: "idle",
  });
  const [authBusy, setAuthBusy] = useState(false);
  const [authNote, setAuthNote] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const authWatchRef = useRef<(() => void) | null>(null);
  useEffect(() => () => authWatchRef.current?.(), []);

  // 凭据：挂载读一次（拿掩码/已存值），重试走 reload；保存回包由 EngineGroupForm 的 onView 直接落 view
  const credsReq = useAsync((signal) => fetchCredentials(signal), "credentials");
  useEffect(() => {
    if (credsReq.data) setView(credsReq.data);
  }, [credsReq.data]);
  // 读不到配置 / 保存失败共用同一个错误位（原文案「读不到当前配置」对两者都成立：都画不出可用的这一节）
  const loadError = credsReq.error || actionError;
  const retryLoad = () => {
    setActionError("");
    credsReq.reload();
  };

  // 登录态（v1.11 收尾）：终端登录态的「看得见 + 点得动」——状态行 + 一键登录/登出。
  // canLogin=false（这台机器没有该 CLI 的入口）时按钮不画，改为一句说明。读不到就不画状态行（不是错误态）
  const authReq = useAsync((signal) => fetchAuth(signal), "engine-auth");
  const auth = authReq.data ? { loggedIn: authReq.data.loggedIn, canLogin: authReq.data.canLogin } : null;

  // 目录只在挂载时读一次（跟凭据一起）：它和「玩家刚选了什么」无关，切屏回来重读也行，但不必要。
  // 读不到**不报错也不提示**——服务目录是候选的加分项，缺了就照旧用内置表，不该在屏上留一条玩家的红字。
  const catalogReq = useAsync((signal) => fetchProviders(signal), "providers");
  const catalog = catalogReq.data && catalogReq.data.providers.length > 0 ? catalogReq.data : null;

  const onSaved = useCallback(() => {
    setNotice("已保存，重启引擎后生效");
    setRestart({ state: "idle" });
  }, []);

  const doRestart = async () => {
    setRestart({ state: "running" });
    const r = await restartEngine();
    setRestart(r.ok ? { state: "done" } : { state: "error", error: r.error });
    if (r.ok) setNotice("引擎已重启，新配置已生效");
  };

  // 当前引擎条目（未知 id 回落表里的第一个——服务端读路径同样回落，见 shared/engines.mjs）
  const engineEntry = engineById(view?.engine ?? "") ?? ENGINES[0];

  /** 切引擎：与下拉/开关同款「立即保存」；生效走既有的「立刻重启引擎」（会话 env 只在 spawn 时读一次） */
  const pickEngine = async (id: string) => {
    if (!view || view.engine === id) return;
    const r = await postCredentials({ engine: id });
    if (!r.ok || !r.view) {
      setActionError(r.error ?? "保存失败");
      return;
    }
    setView(r.view);
    setNotice("已保存，重启引擎后生效");
    setRestart({ state: "idle" });
    setConfirmLogout(false);
    setAuthNote("");
    authReq.reload(); // 登录态是按引擎看的：换了引擎，状态行跟着换
  };

  /**
   * 一键登录（v1.11 收尾）：把**玩家自己**的 CLI 登录流程拉起来（浏览器里完成），再轮询 /api/auth——
   * 完成后自动刷新状态行（省掉「登录完了还要点一下」）。与启动屏走同一套（lib/engine-login.ts）。
   */
  const doLogin = async () => {
    setAuthBusy(true);
    setAuthNote("");
    const r = await startEngineLogin();
    if (!r.ok) {
      setAuthBusy(false);
      setAuthNote(r.error ?? "没能启动登录流程");
      return;
    }
    setAuthNote("已打开浏览器，完成登录后这里会自动刷新…");
    authWatchRef.current?.();
    authWatchRef.current = watchLogin(
      () => {
        authWatchRef.current = null;
        setAuthBusy(false);
        setAuthNote("登录成功。");
        authReq.reload();
      },
      {
        onTimeout: () => {
          authWatchRef.current = null;
          setAuthBusy(false);
          setAuthNote("等待超时了——完成登录后点「重试」即可。");
        },
      },
    );
  };

  /** 登出：**全局动作**（玩家终端里那份登录也一起清掉），所以 UI 上是两段确认（首点出确认条） */
  const doLogout = async () => {
    setConfirmLogout(false);
    setAuthBusy(true);
    const r = await engineLogout();
    setAuthBusy(false);
    setAuthNote(r.ok ? "已退出登录。" : `没能退出：${r.error ?? "未知原因"}`);
    authReq.reload();
  };

  return (
    <section className="shell-panel rounded-2xl p-6 lg:col-span-2" data-testid="engine-keys">
      {showTitle ? <h3 className="text-ui tracking-[.35em] text-gold/85">引擎与密钥</h3> : null}
      <p className={`text-meta leading-relaxed text-ink-hint ${showTitle ? "mt-2" : ""}`}>
        故事由语言模型演绎、插画由图片服务生成。两者都能用你自己的服务：填上服务地址与密钥即可，改动即时保存。
      </p>

      {/* 叙事引擎（v1.11，docs/adr/0022）：驱动剧情的后端。选择立即保存，切完点下面「立刻重启引擎」生效 */}
      {view ? (
        <div className="mt-4">
          <div className="flex flex-wrap gap-2" data-testid="engine-backend" role="group" aria-label="叙事引擎">
            {ENGINES.map((e) => (
              <button
                key={e.id}
                type="button"
                data-testid={`engine-backend-${e.id}`}
                aria-pressed={view.engine === e.id}
                onClick={() => void pickEngine(e.id)}
                className={`rounded-lg border px-4 py-1.5 text-ui tracking-[.1em] transition-colors duration-200 ${
                  view.engine === e.id
                    ? "border-gold/40 bg-gold/15 text-gold"
                    : "border-white/10 text-ink-hint hover:border-gold/25 hover:text-ink"
                }`}
              >
                {e.label}
              </button>
            ))}
          </div>
          <p data-testid="engine-backend-note" className="mt-2 text-meta leading-relaxed text-ink-hint">
            {engineEntry.blurb}
          </p>

          <EngineAuthPanel
            auth={auth}
            busy={authBusy}
            note={authNote}
            confirming={confirmLogout}
            engineEntry={engineEntry}
            onLogin={() => void doLogin()}
            onRequestLogout={() => setConfirmLogout(true)}
            onConfirmLogout={() => void doLogout()}
            onCancelLogout={() => setConfirmLogout(false)}
          />
        </div>
      ) : null}

      {loadError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-meta text-ink-hint">读不到当前配置（{loadError}）</span>
          <button
            type="button"
            data-testid="engine-keys-retry"
            onClick={retryLoad}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-meta text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            重试
          </button>
        </div>
      ) : null}

      {/* 用的是在线目录（新于内置表）时给一句人话说明：玩家话，不带任何内部标识；
          同一句里点明「你已填的不会被改」——这正是目录更新最容易让人担心的那件事 */}
      {catalog && catalog.source !== "bundled" ? (
        <p data-testid="engine-catalog-online" className="mt-3 text-meta leading-relaxed text-ink-hint">
          服务清单已是「在线目录」的最新一批（比你装游戏时多几条、地址也可能更准）。你已填的地址与密钥不会被它改动。
        </p>
      ) : null}

      {view ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <EngineGroupForm
            group="llm"
            view={view.llm}
            catalog={catalog?.providers ?? null}
            locked={engineEntry.byok ? null : engineEntry.byokNote}
            onView={setView}
            onSaved={onSaved}
            onError={setActionError}
          />
          <EngineGroupForm
            group="image"
            view={view.image}
            catalog={catalog?.providers ?? null}
            locked={null}
            onView={setView}
            onSaved={onSaved}
            onError={setActionError}
          />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/[.06] pt-4">
        <button
          type="button"
          data-testid="engine-restart"
          onClick={() => void doRestart()}
          disabled={restart.state === "running"}
          className="inline-flex items-center gap-2 rounded-lg border border-gold/50 bg-gold/15 px-4 py-1.5 text-ui text-gold transition-colors hover:bg-gold/25 disabled:opacity-60"
        >
          <RotateCw size={14} className={restart.state === "running" ? "animate-spin" : ""} />
          {restart.state === "running" ? "正在重启…" : "立刻重启引擎"}
        </button>
        <span data-testid="engine-restart-note" role="status" className="text-meta leading-relaxed text-ink-hint">
          {restart.state === "error" ? `没能重启：${restart.error ?? "未知原因"}` : notice}
        </span>
      </div>
      <p className="mt-2 text-meta leading-relaxed text-ink-faint">
        重启只影响正在运行的这一局：进度都在存档里，不会因为重启丢东西。
      </p>
    </section>
  );
}
