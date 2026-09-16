import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw, X } from "lucide-react";
import { assetFileUrl, fetchAssets, type AssetEntry } from "../lib/acp";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 卡片显示名：差分拆开为「薇拉 · 微笑」，基础/背景/封面原样 */
function assetLabel(a: AssetEntry): string {
  return a.type === "立绘" && a.variant ? `${a.name} · ${a.variant}` : a.name;
}

/** 发给引擎的重绘 key 与【图|重绘】标记匹配名（封面用 preset id 下指令、用标题匹配标记） */
function regenTarget(a: AssetEntry): { type: "立绘" | "背景" | "封面"; key: string; matchName: string } | null {
  if (a.type === "封面") {
    const id = /^presets\/([^/]+)\/cover\.jpg$/.exec(a.file)?.[1];
    return id ? { type: "封面", key: id, matchName: a.name } : null;
  }
  if (a.type !== "立绘" && a.type !== "背景") return null;
  const key = a.type === "立绘" && a.variant ? `${a.name}-${a.variant}` : a.name;
  return { type: a.type, key, matchName: key };
}

/** 卡片测试 id（同一剧本内不会重名：立绘含差分、背景=地点、封面=标题） */
function assetTestId(a: AssetEntry): string {
  return `asset-card-${a.type === "立绘" && a.variant ? `${a.name}-${a.variant}` : a.name}`;
}

function AssetCard({ a, stamp, onClick }: { a: AssetEntry; stamp: number; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={assetTestId(a)}
      onClick={onClick}
      className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[.03] text-left transition-colors duration-200 hover:border-gold/40"
    >
      <div className={`relative w-full overflow-hidden ${a.type === "背景" ? "aspect-video" : "aspect-[3/4]"}`}>
        <img
          src={assetFileUrl(a.file, stamp)}
          alt={assetLabel(a)}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      </div>
      {a.inUse && (
        <span className="absolute right-1.5 top-1.5 rounded-sm bg-[rgba(10,12,18,.75)] px-1.5 py-0.5 text-[10px] tracking-[.15em] text-gold">
          在用
        </span>
      )}
      <div className="truncate px-2 py-1.5 text-[12px] text-ink/70">{assetLabel(a)}</div>
    </button>
  );
}

/** 画廊：全资产分组网格（立绘按角色分组、背景、封面）+ 单项重绘 */
export default function AssetsScreen() {
  const closeOverlay = useGameStore((s) => s.closeOverlay);
  const startRegen = useGameStore((s) => s.startRegen);
  const stamp = useGameStore((s) => s.assetsStamp);
  const regenPending = useGameStore((s) => s.regenPending);
  const engineBusy = useGameStore((s) => s.engineBusy);
  // 预览态放 store：Esc 关闭链（App 层）与 X/点遮罩三条路都关它
  const selected = useGameStore((s) => s.assetsPreview);
  const setAssetsPreview = useGameStore((s) => s.setAssetsPreview);
  // 画廊按剧本过滤（v1.5.1 资产随故事走）：清单与重绘都作用于当前剧本
  const preset = useGameStore((s) => s.selected?.id ?? "");

  const [assets, setAssets] = useState<AssetEntry[] | null>(null);
  const [error, setError] = useState("");

  // 挂载、换剧本与每次重绘完成（stamp 自增）时刷新；URL 带 v=stamp 破缓存换新图
  useEffect(() => {
    if (!preset) return; // 还没选剧本：没有可查的资产目录，不白打一次 400
    const abort = new AbortController();
    setError("");
    fetchAssets(preset, abort.signal)
      .then((list) => {
        // 防御性校验：服务端只应返回 presets/<preset>/assets/ 下的资产（跨剧本条目 = 旧档串味 / 装配期写错目录）。
        // 兜底把 preset 对不上的丢出去并告警——宁可画廊少显示，也不让另一部剧本的图混进当前故事
        const foreign = list.filter((a) => a.preset !== preset);
        if (foreign.length > 0) {
          console.warn(
            `[画廊] 忽略 ${foreign.length} 条不属于当前剧本（${preset}）的资产；` +
              "服务端 /api/assets 应只返回该剧本目录下的文件并逐条回填 preset：",
            foreign.map((a) => a.file),
          );
        }
        setAssets(list.filter((a) => a.preset === preset));
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(String(e));
      });
    return () => abort.abort();
  }, [preset, stamp]);

  // 立绘按角色分组：组内基础在前、差分随后；背景与封面各自一组
  const portraitGroups = useMemo(() => {
    const groups = new Map<string, AssetEntry[]>();
    for (const a of assets ?? []) {
      if (a.type !== "立绘") continue;
      const list = groups.get(a.name) ?? [];
      list.push(a);
      groups.set(a.name, list);
    }
    for (const list of groups.values()) {
      list.sort((x, y) => (x.variant ? 1 : 0) - (y.variant ? 1 : 0));
    }
    return [...groups.entries()];
  }, [assets]);
  const backgrounds = useMemo(() => (assets ?? []).filter((a) => a.type === "背景"), [assets]);
  const covers = useMemo(() => (assets ?? []).filter((a) => a.type === "封面"), [assets]);

  const selectedTarget = selected ? regenTarget(selected) : null;
  const selectedBusy = engineBusy || regenPending !== null;
  const selectedRegenerating =
    selectedTarget !== null && regenPending === `${selectedTarget.type}|${selectedTarget.matchName}`;

  return (
    <ScreenShell className="overflow-y-auto bg-bg/70">
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        <header className="flex items-center">
          <h2 className="text-xl tracking-[.6em] [text-indent:.6em]">画 廊</h2>
          <button
            type="button"
            onClick={closeOverlay}
            className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
          >
            返回
          </button>
        </header>
        <p className="mt-2 text-[11px] tracking-[.2em] text-ink/40">点击素材可预览大图并重新生成</p>
        {error && (
          <p data-testid="assets-error" className="mt-3 text-sm text-red-400">
            素材加载失败：{error}
          </p>
        )}
        {!preset && (
          <p data-testid="assets-nopreset" className="mt-6 text-sm text-ink/50">
            先在剧本库选一个剧本，再看它的素材
          </p>
        )}
        {preset && !assets && !error && <p className="mt-6 animate-pulse text-sm text-ink/50">清点素材…</p>}

        {assets && assets.length === 0 && <p className="mt-6 text-sm text-ink/50">这个剧本还没有已生成的素材</p>}

        {portraitGroups.length > 0 && (
          <section className="mt-8">
            <h3 className="text-[13px] tracking-[.35em] text-gold/80">立 绘</h3>
            {portraitGroups.map(([who, list]) => (
              <div key={who} className="mt-4">
                <p className="mb-2 text-[12px] tracking-[.2em] text-ink/45">{who}</p>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                  {list.map((a) => (
                    <AssetCard key={a.file} a={a} stamp={stamp} onClick={() => setAssetsPreview(a)} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {backgrounds.length > 0 && (
          <section className="mt-8">
            <h3 className="text-[13px] tracking-[.35em] text-gold/80">背 景</h3>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {backgrounds.map((a) => (
                <AssetCard key={a.file} a={a} stamp={stamp} onClick={() => setAssetsPreview(a)} />
              ))}
            </div>
          </section>
        )}

        {covers.length > 0 && (
          <section className="mt-8">
            <h3 className="text-[13px] tracking-[.35em] text-gold/80">封 面</h3>
            <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {covers.map((a) => (
                <AssetCard key={a.file} a={a} stamp={stamp} onClick={() => setAssetsPreview(a)} />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* 大图预览 + 重绘 */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={() => setAssetsPreview(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              className="relative flex w-[min(560px,92vw)] flex-col gap-3 rounded-2xl border border-white/10 bg-[rgba(10,12,18,.95)] p-4"
            >
              <button
                type="button"
                onClick={() => setAssetsPreview(null)}
                className="absolute right-3 top-3 rounded-md p-1 text-ink/60 transition-colors hover:text-ink"
              >
                <X size={16} />
              </button>
              <div className="max-h-[62vh] overflow-hidden rounded-xl">
                <img
                  src={assetFileUrl(selected.file, stamp)}
                  alt={assetLabel(selected)}
                  className="max-h-[62vh] w-full object-contain"
                />
              </div>
              <div className="flex items-end gap-3 px-1">
                <div className="min-w-0">
                  <p className="text-[15px] text-ink">{assetLabel(selected)}</p>
                  <p className="mt-0.5 truncate text-[11px] text-ink/40">{selected.file}</p>
                </div>
                <button
                  type="button"
                  disabled={!selectedTarget || selectedBusy}
                  onClick={() => selectedTarget && startRegen(selectedTarget.type, selectedTarget.key, selectedTarget.matchName)}
                  className={`ml-auto flex items-center gap-1.5 rounded-lg border px-4 py-2 text-[13px] tracking-[.1em] transition-colors ${
                    !selectedTarget || selectedBusy
                      ? "cursor-not-allowed border-white/10 text-ink/35"
                      : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                  }`}
                >
                  {selectedRegenerating ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" /> 生成中…
                    </>
                  ) : engineBusy ? (
                    "引擎忙"
                  ) : regenPending ? (
                    "生成中…"
                  ) : (
                    <>
                      <RefreshCw size={13} /> 重新生成
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ScreenShell>
  );
}
