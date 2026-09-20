// 剧本体检屏（check overlay，v1.9）：把作者侧的 `npm run doctor` 搬进游戏里——手写剧本或创作模式
// 装配出新剧本后，不必离开游戏去终端看报告，当场就知道哪一条会让剧本进不了轮播、哪一条会让素材永远 404。
//
// 数据直出 doctor 的纯函数（`GET /api/presets/check?id=<id>`，见 docs/ARCHITECTURE.md「剧本体检」）：
// server 不重写任何判定，只做 id 校验 + 目录存在性 + 归组；屏上因此**一个字都不加工**——每条 label 都是
// doctor 产出的原文（`npm run doctor` 里看到什么，屏上就是什么），组名也取 doctor 自己的用法。
//
// 版式：ShellPage 壳层页框（眉标=当前剧本、右上 重新检查/返回、页脚一句口径说明），正文按组切 .shell-panel 块，
// 块顺序 = doctor 的报告顺序（同组的行连着，按首现顺序切块即可），每行 = 严重度 chip + 行原文。
// 字号只取 global.css 的阶梯档位；配色只用既有档：通过=金、警告=琥珀、错误=红（与画廊/世界线的失败色同源）。
// 重试只有一处（右上「重新检查」）：错误态里不再摆第二个同 testid 的按钮，免得 testid 撞车。
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import { fetchPresetCheck, type PresetCheckItem, type PresetCheckResult } from "../lib/acp";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { ShellPage } from "./ShellPage";

/** 严重度 → 呈现（chip 文案 + 颜色；正文行也随级别取色，error 行用最高对比档） */
const LEVEL_STYLE: Record<PresetCheckItem["level"], { label: string; chip: string; text: string }> = {
  ok: { label: "通过", chip: "border-gold/30 bg-gold/10 text-gold/85", text: "text-ink-body" },
  warn: { label: "警告", chip: "border-amber-400/35 bg-amber-400/10 text-amber-300/90", text: "text-ink-body" },
  error: { label: "错误", chip: "border-red-400/45 bg-red-400/10 text-red-300", text: "text-ink" },
};

export default function PresetCheckScreen() {
  const presetId = useGameStore((s) => s.selected?.id ?? "");
  /** 眉标用的剧本标题（还没选剧本时给一句状态，别留空行） */
  const presetTitle = useGameStore((s) => s.selected?.title);
  const closeOverlay = useGameStore((s) => s.closeOverlay);

  const [result, setResult] = useState<PresetCheckResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** 「重新检查」的触发计数：屏内自助刷新不占 store 字段（与画廊的 assetsStamp 同款） */
  const [checkStamp, setCheckStamp] = useState(0);

  // 换剧本与每次「重新检查」都重取；卸载/换本即取消（在途响应不再回填）
  useEffect(() => {
    if (!presetId) return; // 还没选剧本：没有可查的目录，不白打一次 400
    const abort = new AbortController();
    setBusy(true);
    setError("");
    fetchPresetCheck(presetId, abort.signal)
      .then(setResult)
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setResult(null);
        setError(String(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [presetId, checkStamp]);

  /** 摘要行计数：与 doctor 的「N 项通过 · M 警告 · K 错误」同口径（组干净时整组一条 ok，所以 N 也是通过组数） */
  const counts = useMemo(() => {
    const items = result?.items ?? [];
    return {
      ok: items.filter((i) => i.level === "ok").length,
      warn: items.filter((i) => i.level === "warn").length,
      error: items.filter((i) => i.level === "error").length,
    };
  }, [result]);

  /** 按组切块（Map 的插入序 = doctor 的报告顺序：同组的行本来就是连着的） */
  const groups = useMemo(() => {
    const map = new Map<string, PresetCheckItem[]>();
    for (const item of result?.items ?? []) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return [...map.entries()];
  }, [result]);

  return (
    <ScreenShell className="overflow-y-auto shell-backdrop">
      <ShellPage
        eyebrow={presetTitle ?? "未选择剧本"}
        title="剧 本 体 检"
        actions={
          <>
            <button
              type="button"
              data-testid="preset-check-retry"
              disabled={!presetId || busy}
              onClick={() => setCheckStamp((v) => v + 1)}
              className="flex items-center gap-1.5 rounded-md border border-gold/35 bg-gold/15 px-3.5 py-1.5 text-ui tracking-[.2em] text-gold transition-colors hover:bg-gold/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-transparent disabled:text-ink-faint"
            >
              <RefreshCw size={13} className={busy ? "animate-spin" : undefined} /> 重新检查
            </button>
            <button
              type="button"
              data-testid="preset-check-back"
              onClick={closeOverlay}
              className="rounded-md border border-white/10 px-3.5 py-1.5 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              返回
            </button>
          </>
        }
        footer={<span className="tracking-[.08em]">与 npm run doctor 同一份判定：错误会让剧本进不了轮播或素材永远 404，警告只是提示</span>}
      >
        {/* 正文整体淡入位移（与设置屏同款收尾动效：壳层屏进场统一、克制） */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          data-testid="preset-check-screen"
          className="flex flex-col gap-4"
        >
          {!presetId && (
            <p data-testid="preset-check-nopreset" className="shell-panel rounded-xl px-4 py-3 text-ui text-ink-hint">
              先选择一个剧本，再看它的体检
            </p>
          )}

          {presetId && busy && !result && (
            <p className="shell-panel animate-pulse rounded-xl px-4 py-3 text-ui text-ink-hint">体检中…</p>
          )}

          {presetId && error && (
            <div data-testid="preset-check-error" className="rounded-xl border border-red-400/25 bg-panel px-4 py-3 backdrop-blur-md">
              <p className="text-ui text-red-400">体检失败：{error}</p>
              <p className="mt-1 text-meta text-ink-hint">点右上「重新检查」再试一次</p>
            </div>
          )}

          {presetId && result && (
            <>
              {/* 摘要：第一行是 doctor 的小结口径（N 项通过 · M 警告 · K 错误），第二行说清这个结论意味着什么 */}
              <div className="shell-panel rounded-xl px-4 py-3">
                <p data-testid="preset-check-summary" className="text-body tabular-nums text-ink">
                  {counts.ok} 项通过 · {counts.warn} 警告 · {counts.error} 错误
                </p>
                <p
                  data-testid="preset-check-verdict"
                  className={`mt-1 text-ui ${result.ok ? "text-gold/85" : "text-red-300"}`}
                >
                  {result.ok
                    ? "没有必须修的问题——警告只是提示，不影响发布"
                    : "有必须修的问题：错误级会让剧本进不了轮播、或素材永远不可能被显示"}
                </p>
              </div>

              {groups.map(([group, list], i) => (
                <section key={group} data-testid={`preset-check-group-${i}`} className="shell-panel rounded-xl px-4 py-3">
                  <h2 className="text-ui tracking-[.35em] text-gold/85">{group}</h2>
                  <ul className="mt-2.5 flex flex-col gap-2">
                    {list.map((item) => (
                      <li key={item.label} data-level={item.level} className="flex items-start gap-2.5">
                        <span
                          className={`mt-0.5 flex-none rounded-sm border px-1.5 py-0.5 text-micro tracking-[.12em] ${LEVEL_STYLE[item.level].chip}`}
                        >
                          {LEVEL_STYLE[item.level].label}
                        </span>
                        <span className={`text-ui leading-relaxed ${LEVEL_STYLE[item.level].text}`}>{item.label}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </motion.div>
      </ShellPage>
    </ScreenShell>
  );
}
