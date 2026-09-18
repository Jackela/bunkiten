import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw, X } from "lucide-react";
import { assetFileUrl, fetchAssets, type AssetEntry } from "../lib/acp";
import { useGameStore, type RegenJob } from "../store/game";
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

/** 选择模式下 checkbox 的 id（label htmlFor 指向它，整张卡都是点击热区） */
function pickId(a: AssetEntry): string {
  return `asset-pick-${assetTestId(a)}`;
}

/**
 * 一张素材卡。画廊两种模式共用同一份外观，只有外层容器不同：
 * - 浏览模式：整卡是一个 button，点击开大图预览；
 * - 选择模式：整卡是一个 label（htmlFor 指到左上角 checkbox），点卡片任意处即勾选，不误开预览。
 */
function AssetCard({
  a,
  stamp,
  selectMode,
  picked,
  onOpen,
  onToggle,
}: {
  a: AssetEntry;
  stamp: number;
  selectMode: boolean;
  picked: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const label = assetLabel(a);
  const inner = (
    <>
      <div className={`relative w-full overflow-hidden ${a.type === "背景" ? "aspect-video" : "aspect-[3/4]"}`}>
        <img
          src={assetFileUrl(a.file, stamp)}
          alt={label}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      </div>
      {a.inUse && (
        <span className="absolute right-1.5 top-1.5 rounded-sm bg-[rgba(10,12,18,.75)] px-1.5 py-0.5 text-[10px] tracking-[.15em] text-gold">
          在用
        </span>
      )}
      <div className="truncate px-2 py-1.5 text-[12px] text-ink-body">{label}</div>
    </>
  );

  if (selectMode) {
    return (
      <div
        data-testid={assetTestId(a)}
        className={`group relative block overflow-hidden rounded-xl border text-left transition-colors duration-200 ${
          picked ? "border-gold/60" : "border-white/10 hover:border-gold/40"
        }`}
      >
        <input
          id={pickId(a)}
          type="checkbox"
          aria-label={`选择 ${a.type}-${label}`}
          checked={picked}
          onChange={onToggle}
          className="absolute left-2 top-2 z-10 h-4 w-4 accent-[color:var(--accent)]"
        />
        <label htmlFor={pickId(a)} className="block cursor-pointer">
          {inner}
        </label>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid={assetTestId(a)}
      onClick={onOpen}
      className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[.03] text-left transition-colors duration-200 hover:border-gold/40"
    >
      {inner}
    </button>
  );
}

/** 画廊：全资产分组网格（立绘按角色分组、背景、封面）+ 单项/批量重绘 + 批量删除 */
export default function AssetsScreen() {
  const closeOverlay = useGameStore((s) => s.closeOverlay);
  const startRegen = useGameStore((s) => s.startRegen);
  const startRegenBatch = useGameStore((s) => s.startRegenBatch);
  const deleteAssets = useGameStore((s) => s.deleteAssets);
  const clearAssetsNotice = useGameStore((s) => s.clearAssetsNotice);
  const stamp = useGameStore((s) => s.assetsStamp);
  const regenPending = useGameStore((s) => s.regenPending);
  const regenQueue = useGameStore((s) => s.regenQueue);
  const regenTotal = useGameStore((s) => s.regenTotal);
  const regenDone = useGameStore((s) => s.regenDone);
  const regenNotice = useGameStore((s) => s.regenNotice);
  const assetsNotice = useGameStore((s) => s.assetsNotice);
  const assetsBusy = useGameStore((s) => s.assetsBusy);
  const engineBusy = useGameStore((s) => s.engineBusy);
  // 预览态放 store：Esc 关闭链（App 层）与 X/点遮罩三条路都关它
  const selected = useGameStore((s) => s.assetsPreview);
  const setAssetsPreview = useGameStore((s) => s.setAssetsPreview);
  // 画廊按剧本过滤（v1.5.1 资产随故事走）：清单与重绘都作用于当前剧本
  const preset = useGameStore((s) => s.selected?.id ?? "");

  const [assets, setAssets] = useState<AssetEntry[] | null>(null);
  const [error, setError] = useState("");
  /** 选择模式开关（批量操作的入口） */
  const [selectMode, setSelectMode] = useState(false);
  /** 勾选的素材（有序数组：按落盘路径记，批量动作按勾选顺序执行，改名/重绘都不影响） */
  const [picked, setPicked] = useState<string[]>([]);
  /** 批量删除的两段式确认（与删除世界线同款：首点变确认按钮，二点才发） */
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 预览面板的关闭按钮（打开时聚焦它，键盘用户第一站就是「关掉」） */
  const closeRef = useRef<HTMLButtonElement | null>(null);

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

  // 进屏/换本清掉上一轮的提示条（批次结果属于上一次会话，不该复读）
  useEffect(() => {
    clearAssetsNotice();
  }, [preset, clearAssetsNotice]);

  // 打开预览时把焦点放到关闭按钮（role=dialog 的初始焦点；Esc 链仍由 App 兜）
  useEffect(() => {
    if (selected) closeRef.current?.focus();
  }, [selected]);

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

  /** 落盘路径 → 条目（勾选记的是路径：清单刷新后仍能对回条目） */
  const byFile = useMemo(() => new Map((assets ?? []).map((a) => [a.file, a])), [assets]);
  const pickedSet = useMemo(() => new Set(picked), [picked]);

  /** 选中项里可重绘的那些（按勾选顺序；regenTarget 解不出的项不计入 N，也不为它发指令） */
  const regenJobs = useMemo<RegenJob[]>(() => {
    const jobs: RegenJob[] = [];
    for (const file of picked) {
      const a = byFile.get(file);
      const t = a ? regenTarget(a) : null;
      if (t) jobs.push({ type: t.type, key: t.key, matchName: t.matchName });
    }
    return jobs;
  }, [byFile, picked]);

  /** 选中项里可删除的那些（按勾选顺序）：封面不受理（服务端只收 assets 目录下的 *.jpg），前端先排除 */
  const deletable = useMemo(
    () => picked.map((f) => byFile.get(f)).filter((a): a is AssetEntry => !!a && a.type !== "封面"),
    [byFile, picked],
  );
  /** 勾了封面但不参与删除时的提示行（别让玩家以为按钮坏了） */
  const coverPicked = picked.filter((f) => byFile.get(f)?.type === "封面").length;

  const selectedTarget = selected ? regenTarget(selected) : null;
  const regenActive = regenPending !== null || regenQueue.length > 0;
  const selectedBusy = engineBusy || regenActive;
  const selectedRegenerating =
    selectedTarget !== null && regenPending === `${selectedTarget.type}|${selectedTarget.matchName}`;

  /** 退出选择模式：勾选与确认态一起收掉（换模式不带走上一批的记账） */
  const exitSelect = () => {
    setSelectMode(false);
    setPicked([]);
    setConfirmDelete(false);
  };

  const togglePick = (file: string) => {
    setPicked((prev) => (prev.includes(file) ? prev.filter((f) => f !== file) : [...prev, file]));
  };

  /** 批量重绘：交给 store 的顺序队列（一条收尾才派下一条），此处只负责起跑 */
  const regenPicked = () => {
    if (regenJobs.length === 0 || selectedBusy) return;
    setConfirmDelete(false);
    startRegenBatch(regenJobs);
  };

  /** 批量删除：两段确认的第二段，逐条删完由 store 刷新清单（assetsStamp） */
  const removePicked = async () => {
    const files = deletable.map((a) => a.file);
    if (files.length === 0 || assetsBusy) return;
    setConfirmDelete(false);
    await deleteAssets(files);
    setPicked([]); // 删掉的项不该留在勾选里
  };

  const cardProps = (a: AssetEntry) => ({
    a,
    stamp,
    selectMode,
    picked: pickedSet.has(a.file),
    onOpen: () => setAssetsPreview(a),
    onToggle: () => togglePick(a.file),
  });

  return (
    <ScreenShell className="overflow-y-auto bg-bg/70">
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        <header className="flex items-center">
          <h2 className="text-xl tracking-[.6em] [text-indent:.6em]">画 廊</h2>
          <button
            type="button"
            data-testid="assets-select-toggle"
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            className={`ml-auto rounded-md border px-3 py-1.5 text-[12px] tracking-[.2em] transition-colors ${
              selectMode
                ? "border-gold/40 bg-gold/15 text-gold"
                : "border-white/10 text-ink-hint hover:border-gold/40 hover:text-ink"
            }`}
          >
            选择模式
          </button>
          <button
            type="button"
            data-testid="assets-back"
            onClick={closeOverlay}
            className="ml-2 rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
          >
            返回
          </button>
        </header>
        <p className="mt-2 text-[11px] tracking-[.2em] text-ink-hint">
          点击素材可预览大图并重新生成；选择模式下可批量重绘与删除
        </p>

        {/* 批量工具栏：只在选择模式出现（全选/清空/重绘选中/删除选中/退出） */}
        {selectMode && (
          <div
            data-testid="assets-toolbar"
            className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-[rgba(10,12,18,.5)] px-3 py-2 backdrop-blur-md"
          >
            <span className="text-[12px] tracking-[.12em] text-ink-hint">已选 {picked.length}</span>
            <button
              type="button"
              data-testid="assets-select-all"
              disabled={(assets ?? []).length === 0}
              onClick={() => setPicked((assets ?? []).map((a) => a.file))}
              className="rounded-md border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
            >
              全选
            </button>
            <button
              type="button"
              data-testid="assets-select-none"
              disabled={picked.length === 0}
              onClick={() => setPicked([])}
              className="rounded-md border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
            >
              清空
            </button>
            <button
              type="button"
              data-testid="assets-regen-selected"
              disabled={regenJobs.length === 0 || selectedBusy}
              onClick={regenPicked}
              className="flex items-center gap-1.5 rounded-md border border-gold/35 bg-gold/15 px-3.5 py-1.5 text-[12.5px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
            >
              <RefreshCw size={12} /> 重绘选中({regenJobs.length})
            </button>

            {confirmDelete ? (
              <>
                <button
                  type="button"
                  data-testid="assets-delete-confirm"
                  disabled={assetsBusy || deletable.length === 0}
                  onClick={removePicked}
                  className="rounded-md border border-red-400/40 bg-red-500/15 px-3.5 py-1.5 text-[12.5px] tracking-[.1em] text-red-300 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
                >
                  确认删除({deletable.length})
                </button>
                <button
                  type="button"
                  data-testid="assets-delete-cancel"
                  disabled={assetsBusy}
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:text-ink"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="assets-delete-selected"
                disabled={deletable.length === 0 || assetsBusy}
                onClick={() => setConfirmDelete(true)}
                className="rounded-md border border-white/10 px-3.5 py-1.5 text-[12.5px] tracking-[.1em] text-ink-hint transition-colors hover:border-red-400/40 hover:text-red-300 disabled:cursor-not-allowed disabled:text-ink-faint"
              >
                删除选中({deletable.length})
              </button>
            )}

            {coverPicked > 0 && <span className="text-[11px] text-ink-hint">封面不参与删除（服务端只受理 assets 目录下的图）</span>}

            <button
              type="button"
              data-testid="assets-exit-select"
              onClick={exitSelect}
              className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-[12.5px] tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              退出选择
            </button>
          </div>
        )}

        {/* 状态位：批量重绘进度 / 批量结果提示 / 批量删除在途 */}
        {regenActive && regenTotal > 0 && (
          <p
            data-testid="assets-regen-progress"
            className="mt-3 rounded-xl border border-gold/25 bg-gold/10 px-4 py-2 text-[12.5px] tracking-[.05em] text-gold/90"
          >
            重绘中 {Math.min(regenDone + 1, regenTotal)}/{regenTotal}
            {engineBusy ? "（等本轮引擎回复）" : ""}
          </p>
        )}
        {regenNotice && (
          <p
            data-testid="assets-regen-notice"
            data-kind={regenNotice.kind}
            className={`mt-3 rounded-xl border px-4 py-2 text-[12.5px] leading-relaxed ${
              regenNotice.kind === "error"
                ? "border-red-400/25 bg-[rgba(10,12,18,.5)] text-red-400"
                : "border-gold/25 bg-gold/10 text-gold/90"
            }`}
          >
            {regenNotice.text}
          </p>
        )}
        {assetsBusy && (
          <p data-testid="assets-busy" className="mt-3 animate-pulse text-[12.5px] tracking-[.1em] text-ink-hint">
            删除中…
          </p>
        )}
        {assetsNotice && (
          <p
            data-testid="assets-notice"
            data-kind={assetsNotice.kind}
            className={`mt-3 rounded-xl border px-4 py-2 text-[12.5px] leading-relaxed ${
              assetsNotice.kind === "error"
                ? "border-red-400/25 bg-[rgba(10,12,18,.5)] text-red-400"
                : "border-gold/25 bg-gold/10 text-gold/90"
            }`}
          >
            {assetsNotice.text}
          </p>
        )}

        {error && (
          <p data-testid="assets-error" className="mt-3 text-sm text-red-400">
            素材加载失败：{error}
          </p>
        )}
        {!preset && (
          <p data-testid="assets-nopreset" className="mt-6 text-sm text-ink-hint">
            先在剧本库选一个剧本，再看它的素材
          </p>
        )}
        {preset && !assets && !error && <p className="mt-6 animate-pulse text-sm text-ink-hint">清点素材…</p>}

        {assets && assets.length === 0 && <p className="mt-6 text-sm text-ink-hint">这个剧本还没有已生成的素材</p>}

        {portraitGroups.length > 0 && (
          <section className="mt-8">
            <h3 className="text-[13px] tracking-[.35em] text-gold/80">立 绘</h3>
            {portraitGroups.map(([who, list]) => (
              <div key={who} className="mt-4">
                <p className="mb-2 text-[12px] tracking-[.2em] text-ink-hint">{who}</p>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                  {list.map((a) => (
                    <AssetCard key={a.file} {...cardProps(a)} />
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
                <AssetCard key={a.file} {...cardProps(a)} />
              ))}
            </div>
          </section>
        )}

        {covers.length > 0 && (
          <section className="mt-8">
            <h3 className="text-[13px] tracking-[.35em] text-gold/80">封 面</h3>
            <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {covers.map((a) => (
                <AssetCard key={a.file} {...cardProps(a)} />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* 大图预览 + 重绘（模态语义：打开时焦点落在关闭按钮，Esc 由 App 关闭链兜） */}
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
              data-testid="assets-preview"
              role="dialog"
              aria-modal="true"
              aria-label={`素材预览：${assetLabel(selected)}`}
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              className="relative flex w-[min(560px,92vw)] flex-col gap-3 rounded-2xl border border-white/10 bg-[rgba(10,12,18,.95)] p-4"
            >
              <button
                ref={closeRef}
                type="button"
                data-testid="assets-preview-close"
                aria-label="关闭预览"
                onClick={() => setAssetsPreview(null)}
                className="absolute right-3 top-3 rounded-md p-1 text-ink-hint transition-colors hover:text-ink"
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
                  <p className="mt-0.5 truncate text-[11px] text-ink-hint">{selected.file}</p>
                </div>
                <button
                  type="button"
                  data-testid="assets-preview-regen"
                  disabled={!selectedTarget || selectedBusy}
                  onClick={() => selectedTarget && startRegen(selectedTarget.type, selectedTarget.key, selectedTarget.matchName)}
                  className={`ml-auto flex items-center gap-1.5 rounded-lg border px-4 py-2 text-[13px] tracking-[.1em] transition-colors ${
                    !selectedTarget || selectedBusy
                      ? "cursor-not-allowed border-white/10 text-ink-hint"
                      : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                  }`}
                >
                  {selectedRegenerating ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" /> 生成中…
                    </>
                  ) : engineBusy ? (
                    "引擎忙"
                  ) : regenActive ? (
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
