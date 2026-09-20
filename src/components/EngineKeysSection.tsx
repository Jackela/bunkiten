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
// 文案纪律：不出现 env、变量名、配置文件路径这类内部词；说的是「服务地址 / 密钥 / 模型」。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, Plug, RotateCw, Trash2 } from "lucide-react";
import {
  fetchCredentials,
  postCredentials,
  restartEngine,
  testCredentials,
  type CredentialProbe,
  type CredentialGroupView,
  type CredentialsView,
} from "../lib/acp";
import { providersFor, type ProviderEntry } from "../../shared/providers.mjs";

/** 哪一组（对话 / 出图） */
type GroupKey = "llm" | "image";

/** 一组表单的本地草稿（不含 key：key 只活在一次输入里） */
interface Draft {
  mode: string;
  provider: string;
  baseUrl: string;
  model: string;
  size: string;
}

/** 分组文案与默认值（两组共用一套渲染，只有这些差异） */
const GROUP_META: Record<
  GroupKey,
  { title: string; blurb: string; modes: { value: string; label: string }[]; keyHint: string; modeLabels: Record<string, string> }
> = {
  llm: {
    title: "故事引擎",
    blurb: "演绎剧情用的对话模型。留空则沿用终端里的登录状态。",
    modes: [
      { value: "session", label: "沿用终端登录" },
      { value: "byok", label: "自备密钥" },
    ],
    keyHint: "密钥只存在这台机器上，不会写进剧本、存档或导出包。",
    modeLabels: { session: "沿用终端登录", byok: "自备密钥" },
  },
  image: {
    title: "插画生成",
    blurb: "生成角色立绘与背景用的图片服务。不上心就选「不用」——剧情照常进行。",
    modes: [
      { value: "off", label: "不用" },
      { value: "byok", label: "自备服务" },
    ],
    keyHint: "密钥只存在这台机器上；出图失败只会静默略过，不会打断剧情。",
    modeLabels: { off: "不用", byok: "自备服务" },
  },
};

/** 草稿 ↔ 服务端视图（size 只在图片组有，缺省空串） */
function draftOf(view: CredentialGroupView): Draft {
  return { mode: view.mode, provider: view.provider, baseUrl: view.baseUrl, model: view.model, size: view.size ?? "" };
}

/** 目录里某用途的可选项（kind 过滤在真源里） */
function optionsFor(group: GroupKey): readonly ProviderEntry[] {
  return providersFor(group === "llm" ? "llm" : "image");
}

/**
 * 一个输入行：标签 + 控件 + 可选说明。控件由调用方给（input/select），这里只管排版。
 */
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-ui tracking-[.2em] text-ink-body">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-meta leading-relaxed text-ink-hint">{hint}</span> : null}
    </label>
  );
}

/** 文本框的统一样式（设置屏其余输入格同款观感） */
const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-ui text-ink placeholder:text-ink-faint focus:border-gold/40 focus:outline-none";

/**
 * 一组凭据的表单（对话或出图）。
 * @param {object} props 组件属性
 * @param {GroupKey} props.group 组名
 * @param {CredentialGroupView} props.view 服务端的脱敏视图（掩码与 hasKey 的来源）
 * @param {(view: CredentialsView) => void} props.onView 保存成功后的最新视图（整份，父级统一落地）
 * @param {(text: string) => void} props.onSaved 保存成功（父级弹「重启后生效」提示）
 * @param {(err: string) => void} props.onError 保存失败
 */
function GroupForm({
  group,
  view,
  onView,
  onSaved,
  onError,
}: {
  group: GroupKey;
  view: CredentialGroupView;
  onView: (v: CredentialsView) => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const meta = GROUP_META[group];
  const options = optionsFor(group);
  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const [apiKey, setApiKey] = useState(""); // 只在输入期间存在；提交后清空
  const [reveal, setReveal] = useState(false);
  const [probe, setProbe] = useState<{ state: "idle" | "running" | "done"; result?: CredentialProbe }>({ state: "idle" });
  const pending = useRef<{ patch: Record<string, string>; timer: ReturnType<typeof setTimeout> | null }>({ patch: {}, timer: null });
  // 服务端视图变化（首次加载/保存回包）时同步草稿：key 格是本地态，不参与同步。
  // 「有没发出去的改动」时不回灌——否则玩家正在敲的地址会被上一笔回包覆盖成旧值（视觉回跳）
  useEffect(() => {
    if (Object.keys(pending.current.patch).length > 0 || pending.current.timer) return;
    setDraft(draftOf(view));
  }, [view.mode, view.provider, view.baseUrl, view.model, view.size]);

  const flush = useCallback(async () => {
    const patch = pending.current.patch;
    pending.current.patch = {};
    if (pending.current.timer) {
      clearTimeout(pending.current.timer);
      pending.current.timer = null;
    }
    if (Object.keys(patch).length === 0) return;
    const r = await postCredentials(group === "llm" ? { llm: patch } : { image: patch });
    if (!r.ok || !r.view) {
      onError(r.error ?? "保存失败");
      return;
    }
    onView(r.view);
    onSaved();
  }, [group, onError, onSaved, onView]);

  /** 攒一次保存：文本格走短防抖，选择类立即发 */
  const save = useCallback(
    (patch: Record<string, string>, immediate = false) => {
      pending.current.patch = { ...pending.current.patch, ...patch };
      if (pending.current.timer) clearTimeout(pending.current.timer);
      if (immediate) {
        void flush();
        return;
      }
      pending.current.timer = setTimeout(() => void flush(), 400);
    },
    [flush],
  );

  // 卸载（切屏/关 overlay）时把没发出去的改动补发——否则关了设置屏就丢字
  useEffect(() => () => void flush(), [flush]);

  const setField = (key: keyof Draft) => (value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    save({ [key]: value });
  };

  /** 换服务：地址与模型跟着目录预填（只在它们为空或还是上一家的值时动，不覆盖玩家自己填的） */
  const pickProvider = (id: string) => {
    const next = options.find((p) => p.id === id);
    const prev = options.find((p) => p.id === draft.provider);
    const patch: Record<string, string> = { provider: id };
    if (next) {
      if (!draft.baseUrl || (prev && draft.baseUrl === prev.baseUrl)) patch.baseUrl = next.baseUrl;
      if (!draft.model && next.models.length) patch.model = next.models[0];
    }
    setDraft((d) => ({ ...d, ...patch }));
    save(patch, true);
  };

  const clearKey = () => {
    setApiKey("");
    save({ apiKey: "" }, true);
  };

  const runTest = async () => {
    setProbe({ state: "running" });
    const r = await testCredentials(group);
    setProbe({ state: "done", result: r });
  };

  const active = draft.mode === "byok";
  const missing = active ? [!draft.baseUrl ? "服务地址" : "", !view.hasKey && !apiKey ? "密钥" : ""].filter(Boolean) : [];
  const providerLabel = options.find((p) => p.id === draft.provider)?.label ?? draft.provider;
  const note = options.find((p) => p.id === draft.provider)?.note;

  return (
    <div className="shell-panel rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="text-ui tracking-[.3em] text-gold/85">{meta.title}</h4>
        <span className="text-meta text-ink-hint">{view.hasKey && active ? "已配置" : active ? "未配置完整" : meta.modeLabels[draft.mode]}</span>
      </div>
      <p className="mt-2 text-meta leading-relaxed text-ink-hint">{meta.blurb}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {meta.modes.map((m) => (
          <button
            key={m.value}
            type="button"
            data-testid={`engine-${group}-mode-${m.value}`}
            aria-pressed={draft.mode === m.value}
            onClick={() => {
              setDraft((d) => ({ ...d, mode: m.value }));
              setProbe({ state: "idle" });
              save({ mode: m.value }, true);
            }}
            className={`rounded-lg border px-4 py-1.5 text-ui tracking-[.1em] transition-colors duration-200 ${
              draft.mode === m.value ? "border-gold/40 bg-gold/15 text-gold" : "border-white/10 text-ink-hint hover:border-gold/25 hover:text-ink"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {active && (
        <div className="mt-4 space-y-3">
          <Field label="服务">
            <select
              data-testid={`engine-${group}-provider`}
              value={draft.provider}
              onChange={(e) => pickProvider(e.target.value)}
              className={inputClass}
            >
              {options.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#0b0d12]">
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {note ? <p className="-mt-1 text-meta leading-relaxed text-ink-hint">{note}</p> : null}

          <Field label="服务地址">
            <input
              type="url"
              data-testid={`engine-${group}-baseurl`}
              value={draft.baseUrl}
              placeholder="https://…/v1"
              spellCheck={false}
              onChange={(e) => setField("baseUrl")(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="密钥" hint={meta.keyHint}>
            <div className="flex items-stretch gap-2">
              <input
                type={reveal ? "text" : "password"}
                data-testid={`engine-${group}-apikey`}
                value={apiKey}
                placeholder={view.hasKey ? `${view.apiKeyMasked}（已保存）` : "粘贴服务商给的密钥"}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => {
                  // 失焦即提交并清空本地值：之后这里显示的是服务端掩码，屏上不再有明文
                  if (apiKey) save({ apiKey }, true);
                  setApiKey("");
                  setReveal(false);
                }}
                className={inputClass}
              />
              <button
                type="button"
                data-testid={`engine-${group}-apikey-reveal`}
                aria-pressed={reveal}
                title={reveal ? "隐藏" : "显示"}
                onClick={() => setReveal((v) => !v)}
                className="flex-none rounded-lg border border-white/10 px-3 text-ink-hint transition-colors hover:border-gold/30 hover:text-ink"
              >
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              {view.hasKey ? (
                <button
                  type="button"
                  data-testid={`engine-${group}-apikey-clear`}
                  title="清空密钥"
                  onClick={clearKey}
                  className="flex-none rounded-lg border border-white/10 px-3 text-ink-hint transition-colors hover:border-gold/30 hover:text-ink"
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          </Field>

          <Field label="模型">
            <input
              type="text"
              data-testid={`engine-${group}-model`}
              value={draft.model}
              placeholder={options.find((p) => p.id === draft.provider)?.models[0] || "服务商文档里的模型 id"}
              spellCheck={false}
              list={`engine-${group}-models`}
              onChange={(e) => setField("model")(e.target.value)}
              className={inputClass}
            />
            <datalist id={`engine-${group}-models`}>
              {(group === "llm" ? options.find((p) => p.id === draft.provider)?.models : options.find((p) => p.id === draft.provider)?.imageModels)?.map(
                (m) => <option key={m} value={m} />,
              )}
            </datalist>
          </Field>

          {group === "image" ? (
            <Field label="出图尺寸（高级）" hint="留空按画面类型自动：立绘与封面竖构图、背景横构图。">
              <input
                type="text"
                data-testid="engine-image-size"
                value={draft.size}
                placeholder="1024x1536"
                spellCheck={false}
                onChange={(e) => setField("size")(e.target.value)}
                className={inputClass}
              />
            </Field>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              data-testid={`engine-${group}-test`}
              onClick={() => void runTest()}
              disabled={probe.state === "running"}
              className="inline-flex items-center gap-2 rounded-lg border border-gold/40 bg-gold/10 px-4 py-1.5 text-ui text-gold transition-colors hover:bg-gold/20 disabled:opacity-60"
            >
              <Plug size={14} />
              {probe.state === "running" ? "测试中…" : "测试连接"}
            </button>
            <span
              data-testid={`engine-${group}-test-result`}
              className="text-meta leading-relaxed text-ink-hint"
              role="status"
            >
              {probe.state === "done" && probe.result
                ? probe.result.ok
                  ? `通过（${probe.result.ms} ms）${probe.result.detail ? "，" + probe.result.detail : ""}`
                  : `失败：${probe.result.error ?? "未知原因"}`
                : probe.state === "running"
                  ? `正在连接「${providerLabel}」…`
                  : ""}
            </span>
          </div>
          {missing.length > 0 ? <p className="text-meta text-ink-hint">还差：{missing.join("、")}</p> : null}
        </div>
      )}
    </div>
  );
}

/**
 * 设置屏的「引擎与密钥」整节：两份 GroupForm + 保存提示与重启按钮。
 * 取数失败走一句人话 + 重试（与设置屏其余部分不同：凭据在服务端，拉不到就画不出掩码）。
 */
export default function EngineKeysSection() {
  const [view, setView] = useState<CredentialsView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [restart, setRestart] = useState<{ state: "idle" | "running" | "done" | "error"; error?: string }>({ state: "idle" });

  const load = useCallback(async () => {
    setLoadError("");
    try {
      setView(await fetchCredentials());
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <section className="shell-panel rounded-2xl p-6 lg:col-span-2" data-testid="engine-keys">
      <h3 className="text-ui tracking-[.35em] text-gold/85">引擎与密钥</h3>
      <p className="mt-2 text-meta leading-relaxed text-ink-hint">
        故事由语言模型演绎、插画由图片服务生成。两者都能用你自己的服务：填上服务地址与密钥即可，改动即时保存。
      </p>

      {loadError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-meta text-ink-hint">读不到当前配置（{loadError}）</span>
          <button
            type="button"
            data-testid="engine-keys-retry"
            onClick={() => void load()}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-meta text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            重试
          </button>
        </div>
      ) : null}

      {view ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <GroupForm group="llm" view={view.llm} onView={setView} onSaved={onSaved} onError={setLoadError} />
          <GroupForm group="image" view={view.image} onView={setView} onSaved={onSaved} onError={setLoadError} />
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
