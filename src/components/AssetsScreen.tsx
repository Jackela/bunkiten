import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw, X } from "lucide-react";
import { assetFileUrl, fetchAssets, type AssetEntry } from "../lib/acp";
import { variantLabel, REGEN_NOTE_MAX } from "../lib/parser";
import { useAsync } from "../lib/useAsync";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useGameStore, type RegenJob } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { ShellPage } from "./ShellPage";

/** 卡片显示名：差分拆开为「薇拉 · 微笑」（格式见 lib/parser 的 variantLabel），基础/背景/封面原样 */
function assetLabel(a: AssetEntry): string {
  return a.type === "立绘" && a.variant ? variantLabel(a.name, a.variant) : a.name;
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

/** 管理模式下 checkbox 的 id（label htmlFor 指向它，整张卡都是点击热区） */
function pickId(a: AssetEntry): string {
  return `asset-pick-${assetTestId(a)}`;
}

/**
 * 标题带（v1.8）：组标题与角色名原先直接压在游戏底图上——亮底图上那点灰字基本读不出来。
 * 现在每个标题行都包一层 .shell-panel 带（面板底色 + 毛玻璃 + 发丝描边，见 global.css），
 * 带内文字的对比度由面板基线保证，与底图亮暗无关。
 * variant="group" 组标题（金、宽字距、h3）；variant="sub" 角色名这类次级标题（text-meta ink-body）。
 */
function HeadingBand({ variant, children }: { variant: "group" | "sub"; children: ReactNode }) {
  const text =
    variant === "group" ? "text-ui tracking-[.35em] text-gold/85" : "text-meta tracking-[.2em] text-ink-body";
  return (
    <div className="shell-panel rounded-xl px-3 py-2">
      {variant === "group" ? <h3 className={text}>{children}</h3> : <p className={text}>{children}</p>}
    </div>
  );
}

/**
 * 一张素材卡。画廊两种模式共用同一份外观，只有外层容器不同：
 * - 浏览模式：整卡是一个 button，点击开大图预览（画廊的默认语义：只看不改）；
 * - 管理模式：整卡是一个 label（htmlFor 指到左上角 checkbox），点卡片任意处即勾选，不误开预览。
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
        {/* 角标标的是异常不是常态：「在用」是多数（标了等于没标），只有未使用的项才配一枚 */}
        {!a.inUse && (
          <span className="absolute right-1.5 top-1.5 rounded-sm border border-white/20 bg-black/45 px-1.5 py-0.5 text-micro text-ink-hint">
            未使用
          </span>
        )}
      </div>
      <div className="truncate px-2 py-1.5 text-meta text-ink-body">{label}</div>
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

/**
 * 画廊：全资产分组网格（立绘按角色分组、背景、封面）+ 单项/批量重绘 + 批量删除。
 * v1.8 版式：外框换成 ShellPage 的 84rem 满幅框架（眉标=当前剧本、标题=画 廊、页脚=操作提示），
 * 栅格按屏宽铺开（立绘 6 / 背景 3 / 封面 4 列）而不是挤在中间一条窄栏；
 * 组标题与角色名包进标题带；角标只标异常（未使用）；重绘是作者工具，在预览模态里退为次级按钮。
 */
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
  /** 眉标用的剧本标题（未选剧本时给一句状态，别留空行） */
  const presetTitle = useGameStore((s) => s.selected?.title);

  /** 管理素材模式开关（批量操作的入口；浏览模式只有预览） */
  const [selectMode, setSelectMode] = useState(false);
  /** 勾选的素材（有序数组：按落盘路径记，批量动作按勾选顺序执行，改名/重绘都不影响） */
  const [picked, setPicked] = useState<string[]>([]);
  /** 批量删除的两段式确认（与删除世界线同款：首点变确认按钮，二点才发） */
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 预览模态里的「想怎么改？」（v1.12）：一句人话只作用于这一张图；换一张图就清空（见下方 effect） */
  const [regenNote, setRegenNote] = useState("");
  /** 预览面板的关闭按钮（打开时聚焦它，键盘用户第一站就是「关掉」） */
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /** 预览面板本体（焦点陷阱的容器：Tab 在面板里循环、关面板时把焦点还给开启前那张卡片） */
  const previewRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(!!selected, previewRef);

  // 挂载、换剧本与每次重绘完成（stamp 自增）时刷新；URL 带 v=stamp 破缓存换新图。
  // 走 lib/useAsync：AbortController 与「写回前复查 signal.aborted」统一在 hook 里——
  // 此前这里手写的 .then 直接 setAssets，缺了 peers 都有的 aborted 复查（过期应答会落到已卸载的屏上）
  const assetsReq = useAsync(
    (signal) =>
      fetchAssets(preset, signal).then((list) => {
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
        return list.filter((a) => a.preset === preset);
      }),
    // 还没选剧本：没有可查的资产目录，不白打一次 400（key=null 即不取数）
    preset ? `assets:${preset}:${stamp}` : null,
  );
  const assets = assetsReq.data;
  const error = assetsReq.error;

  // 进屏/换本清掉上一轮的提示条（批次结果属于上一次会话，不该复读）
  useEffect(() => {
    clearAssetsNotice();
  }, [preset, clearAssetsNotice]);

  // 打开预览时把焦点放到关闭按钮（role=dialog 的初始焦点；Esc 链仍由 App 兜）。
  // 陷阱（useFocusTrap）的初始焦点本来就是它——面板里第一个可聚焦元素——这条显式聚焦是 v1.6 就有的行为，
  // 保留着不动既有断言，同时兜住 trapFocus 在「容器刚挂上还没量到子元素」时的极端情况
  useEffect(() => {
    if (selected) closeRef.current?.focus();
  }, [selected]);

  // 换一张图就清空「想怎么改？」（v1.12）：写了一半的话是针对上一张图说的，带到下一张会把要求发错对象
  useEffect(() => {
    setRegenNote("");
  }, [selected?.file]);

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

  /** 退出管理素材模式：勾选与确认态一起收掉（换模式不带走上一批的记账） */
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
    // 壳层根就是本屏的滚动容器（overflow-y-auto）——预览打开时锁它、不锁 body（body 在 fixed inset-0
    // 的满幅布局下根本不是滚动源，见 global.css 的 .scroll-locked 与 ROADMAP §3 的那条冲突）
    <ScreenShell className={`overflow-y-auto shell-backdrop${selected ? " scroll-locked" : ""}`}>
      {/* 预览打开时整页框（含表头的返回/管理素材）背景压制；预览面板是它的兄弟，不在这层里，
          所以面板自己的关闭/重绘按钮照常可聚焦可点（inert 的边界见 ShellPage 的同名 prop） */}
      <ShellPage
        inert={!!selected}
        eyebrow={presetTitle ?? "未选择剧本"}
        title="画 廊"
        actions={
          <>
            <button
              type="button"
              data-testid="assets-select-toggle"
              aria-pressed={selectMode}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              className={`rounded-md border px-3.5 py-1.5 text-ui tracking-[.2em] transition-colors ${
                selectMode
                  ? "border-gold/40 bg-gold/15 text-gold"
                  : "border-white/10 text-ink-hint hover:border-gold/40 hover:text-ink"
              }`}
            >
              管理素材
            </button>
            <button
              type="button"
              data-testid="assets-back"
              onClick={closeOverlay}
              className="rounded-md border border-white/10 px-3.5 py-1.5 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              返回
            </button>
          </>
        }
        footer={<span className="tracking-[.08em]">点击素材查看大图；在「管理素材」里可以批量重绘或清理</span>}
      >
        {/* 批量工具栏：只在管理素材模式出现（全选/清空/重绘选中/删除选中/退出） */}
        {selectMode && (
          <div
            data-testid="assets-toolbar"
            className="shell-panel flex flex-wrap items-center gap-2 rounded-xl px-3 py-2"
          >
            <span className="text-ui tracking-[.12em] text-ink-hint">已选 {picked.length}</span>
            <button
              type="button"
              data-testid="assets-select-all"
              disabled={(assets ?? []).length === 0}
              onClick={() => setPicked((assets ?? []).map((a) => a.file))}
              className="rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
            >
              全选
            </button>
            <button
              type="button"
              data-testid="assets-select-none"
              disabled={picked.length === 0}
              onClick={() => setPicked([])}
              className="rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
            >
              清空
            </button>
            <button
              type="button"
              data-testid="assets-regen-selected"
              disabled={regenJobs.length === 0 || selectedBusy}
              onClick={regenPicked}
              className="flex items-center gap-1.5 rounded-md border border-gold/35 bg-gold/15 px-3.5 py-1.5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
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
                  className="rounded-md border border-red-400/40 bg-red-500/15 px-3.5 py-1.5 text-ui tracking-[.1em] text-red-300 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
                >
                  确认删除({deletable.length})
                </button>
                <button
                  type="button"
                  data-testid="assets-delete-cancel"
                  disabled={assetsBusy}
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:text-ink"
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
                className="rounded-md border border-white/10 px-3.5 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-red-400/40 hover:text-red-300 disabled:cursor-not-allowed disabled:text-ink-faint"
              >
                删除选中({deletable.length})
              </button>
            )}

            {coverPicked > 0 && <span className="text-meta text-ink-hint">封面不参与批量删除</span>}

            <button
              type="button"
              data-testid="assets-exit-select"
              onClick={exitSelect}
              className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              退出选择
            </button>
          </div>
        )}

        {/* 状态位：批量重绘进度 / 批量结果提示 / 批量删除在途 */}
        {regenActive && regenTotal > 0 && (
          <p
            data-testid="assets-regen-progress"
            className="mt-3 rounded-xl border border-gold/25 bg-gold/10 px-4 py-2 text-ui tracking-[.05em] text-gold/90"
          >
            重绘中 {Math.min(regenDone + 1, regenTotal)}/{regenTotal}
            {engineBusy ? "（等待本轮完成）" : ""}
          </p>
        )}
        {regenNotice && (
          <p
            data-testid="assets-regen-notice"
            data-kind={regenNotice.kind}
            role="status"
            className={`mt-3 rounded-xl border px-4 py-2 text-ui leading-relaxed ${
              regenNotice.kind === "error"
                ? "border-red-400/25 bg-panel-soft text-red-400"
                : "border-gold/25 bg-gold/10 text-gold/90"
            }`}
          >
            {regenNotice.text}
          </p>
        )}
        {assetsBusy && (
          <p
            data-testid="assets-busy"
            className="shell-panel mt-3 animate-pulse rounded-xl px-4 py-2 text-ui tracking-[.1em] text-ink-hint"
          >
            删除中…
          </p>
        )}
        {assetsNotice && (
          <p
            data-testid="assets-notice"
            data-kind={assetsNotice.kind}
            role="status"
            className={`mt-3 rounded-xl border px-4 py-2 text-ui leading-relaxed ${
              assetsNotice.kind === "error"
                ? "border-red-400/25 bg-panel-soft text-red-400"
                : "border-gold/25 bg-gold/10 text-gold/90"
            }`}
          >
            {assetsNotice.text}
          </p>
        )}

        {error && (
          <p
            data-testid="assets-error"
            role="status"
            className="mt-3 rounded-xl border border-red-400/25 bg-scrim px-4 py-2 text-ui text-red-400 backdrop-blur-md"
          >
            素材加载失败：{error}
          </p>
        )}
        {!preset && (
          <p data-testid="assets-nopreset" className="shell-panel mt-6 rounded-xl px-4 py-2 text-ui text-ink-hint">
            先选择一个剧本，再看它的素材
          </p>
        )}
        {preset && !assets && !error && (
          <p className="shell-panel mt-6 animate-pulse rounded-xl px-4 py-2 text-ui text-ink-hint">清点素材…</p>
        )}

        {assets && assets.length === 0 && (
          <p className="shell-panel mt-6 rounded-xl px-4 py-2 text-ui text-ink-hint">这个剧本还没有已生成的素材</p>
        )}

        {portraitGroups.length > 0 && (
          <section className="mt-8">
            <HeadingBand variant="group">立 绘</HeadingBand>
            {portraitGroups.map(([who, list]) => (
              <div key={who} className="mt-4">
                <HeadingBand variant="sub">{who}</HeadingBand>
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
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
            <HeadingBand variant="group">背 景</HeadingBand>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {backgrounds.map((a) => (
                <AssetCard key={a.file} {...cardProps(a)} />
              ))}
            </div>
          </section>
        )}

        {covers.length > 0 && (
          <section className="mt-8">
            <HeadingBand variant="group">封 面</HeadingBand>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {covers.map((a) => (
                <AssetCard key={a.file} {...cardProps(a)} />
              ))}
            </div>
          </section>
        )}
      </ShellPage>

      {/* 大图预览 + 重绘（模态语义：role=dialog + aria-modal + aria-label，打开时焦点落在关闭按钮、
          Tab 在面板里循环、关闭时归还给开启预览的那张卡片；Esc 由 App 关闭链兜）。
          背景的两件事（v1.9 a11y 收尾）：整页框 inert（上面的 ShellPage）+ 壳层根滚动锁（上面的 className）——
          开了预览还 Tab 得进画廊栅格、还滚得动清单，是这一屏此前最后的两个缺口 */}
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
              ref={previewRef}
              data-testid="assets-preview"
              role="dialog"
              aria-modal="true"
              aria-label={`素材预览：${assetLabel(selected)}`}
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              className="relative flex w-[min(560px,92vw)] flex-col gap-3 rounded-2xl border border-white/10 bg-panel-strong p-4"
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
              {/* 看图与改图分开：上面是观赏信息，发丝线之下才是作者工具（重绘退为次级按钮） */}
              <div className="px-1">
                <p className="text-body text-ink">{assetLabel(selected)}</p>
                <p className="mt-0.5 truncate text-meta text-ink-hint">{selected.file}</p>
              </div>
              {/* 改图指令（v1.12）：一句人话只作用**这一张**。留空 = 同设定换一张（v1.3 起的旧行为） */}
              <div className="mx-1 border-t border-white/[.06] pt-3">
                <label htmlFor="assets-regen-note" className="block text-meta text-ink-hint">
                  想怎么改？（可留空——留空就换一张同设定的）
                </label>
                <input
                  id="assets-regen-note"
                  data-testid="assets-regen-note"
                  value={regenNote}
                  maxLength={REGEN_NOTE_MAX}
                  onChange={(e) => setRegenNote(e.target.value)}
                  onKeyDown={(e) => {
                    // 中文输入法选词的 Enter 不算发送（与世界线改名编辑器同款）
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (selectedTarget && !selectedBusy)
                        startRegen(selectedTarget.type, selectedTarget.key, selectedTarget.matchName, regenNote);
                    }
                  }}
                  placeholder="例：头发改成短发、换成夜景、正面特写"
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-ui text-ink placeholder:text-ink-faint focus:border-gold/40 focus:outline-none"
                />
              </div>
              <div className="flex justify-end px-1">
                <button
                  type="button"
                  data-testid="assets-preview-regen"
                  disabled={!selectedTarget || selectedBusy}
                  onClick={() =>
                    selectedTarget &&
                    startRegen(selectedTarget.type, selectedTarget.key, selectedTarget.matchName, regenNote)
                  }
                  className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                    !selectedTarget || selectedBusy
                      ? "cursor-not-allowed border-white/10 text-ink-hint"
                      : "border-white/15 text-ink-body hover:border-gold/40"
                  }`}
                >
                  {selectedRegenerating ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" /> 生成中…
                    </>
                  ) : engineBusy ? (
                    "忙碌中"
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
