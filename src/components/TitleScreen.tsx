import { Fragment, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { coverUrl, fetchPresets, presetExportUrl } from "../lib/acp";
import { getTheme, themeVars } from "../theme";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { MotifLayer } from "./motifs";

/** 换位 spring：克制的阻尼，不弹跳 */
const SHIFT = { type: "spring", stiffness: 240, damping: 30, mass: 0.9 } as const;
/** 拖拽判定阈值（px）：超过视为切卡，抑制误触 */
const DRAG_THRESHOLD = 60;
/** 插卡动画到切屏的时长（ms） */
const INSERT_MS = 1000;

/** 卡带封面（presets/<id>/cover.jpg）：404/加载失败回退主题渐变+motif（不渲染即露出底渐变） */
function CardCover({ id }: { id: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      src={coverUrl(id)}
      alt=""
      loading="lazy"
      onError={() => setOk(false)}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}

/** 环形最短偏移：i 相对 current 的 -1/0/+1 位置（|offset|>1 的卡移出视野但保留 DOM） */
function ringOffset(i: number, current: number, n: number): number {
  const half = Math.floor(n / 2);
  let off = ((i - current) % n + n) % n;
  if (off > half) off -= n;
  return off;
}

/** 标题屏：老游戏机式的卡带轮播。← → 切卡，Enter/点中央卡「插卡」进入捏人。
 *  v1.7 加剧本分享：当前卡带「导出」小按钮（.preset.json 附件下载）与角落「导入剧本」入口。 */
export default function TitleScreen() {
  const selectPreset = useGameStore((s) => s.selectPreset);
  const setPresets = useGameStore((s) => s.setPresets);
  const importPresetText = useGameStore((s) => s.importPresetText);
  const clearTitleNotice = useGameStore((s) => s.clearTitleNotice);
  const titleNotice = useGameStore((s) => s.titleNotice);
  const openAssets = useGameStore((s) => s.openAssets);
  const openCreation = useGameStore((s) => s.openCreation);
  // 轮播数据读 store：挂载拉取写入，presetAdded（新剧本装配完成）也会刷新——新卡带封面即时出现
  const presets = useGameStore((s) => s.presets);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [skipCount, setSkipCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [inserting, setInserting] = useState(false);
  // 导入剧本（v1.7）：在途标志（按钮禁用）与文件读取失败的就近提示（POST 结果走 store 的 titleNotice）
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  // 拖拽位移记录：tap 判定用（拖动超过阈值后的 tap 不算点击）
  const dragged = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    fetchPresets(abort.signal)
      .then((r) => {
        setPresets(r.presets);
        setSkipCount(r.errors.length);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(String(e));
      });
    return () => abort.abort();
  }, [setPresets]);

  // 进屏清掉上一轮的提示条（导入结果属于上一次会话，不该复读）
  useEffect(() => {
    clearTitleNotice();
  }, [clearTitleNotice]);

  const n = presets.length;
  const current = presets[index] ?? null;
  const theme = getTheme(current);

  const step = (dir: 1 | -1) => {
    if (!inserting && n > 1) setIndex((i) => (i + dir + n) % n);
  };

  const insert = () => {
    if (inserting || !current) return;
    setInserting(true);
    window.setTimeout(() => selectPreset(current), INSERT_MS);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "Enter") insert();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onDragEnd = (_e: unknown, info: PanInfo) => {
    if (info.offset.x < -DRAG_THRESHOLD) step(1);
    else if (info.offset.x > DRAG_THRESHOLD) step(-1);
  };

  /** 导入剧本：读文件原文 → store 校验+POST+刷新轮播（提示落 titleNotice）；读文件失败就地提示 */
  const onImportPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许连续导入同一个文件（不清值浏览器不会再触发 change）
    if (!file || importing) return;
    setImportError("");
    clearTitleNotice();
    setImporting(true);
    try {
      await importPresetText(await file.text());
    } catch (err) {
      setImportError(`导入失败：${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <ScreenShell
      className="overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,#131627_0%,#07080c_60%)]"
      style={themeVars(theme)}
    >
      {/* 舞台氛围：随当前卡主题 */}
      <div className="absolute inset-0 opacity-70">
        <MotifLayer motif={theme.motif} />
      </div>

      <header className="absolute inset-x-0 top-0 z-20 pt-10 text-center">
        <h1 className="text-3xl font-normal tracking-[.55em] [text-indent:.55em]">剧 本</h1>
        <p className="mt-2.5 text-[13px] tracking-[.3em] text-ink-hint">选一张卡带，今晚住进去</p>
        {error && <p className="mt-2 text-sm text-red-400">剧本加载失败：{error}</p>}
        {!loaded && !error && <p className="mt-2 animate-pulse text-sm text-ink-hint">加载中…</p>}
        {loaded && skipCount > 0 && (
          <p className="mt-2 text-xs text-ink-hint">跳过 {skipCount} 个无法解析的剧本</p>
        )}
        {titleNotice && (
          <p
            data-testid="title-notice"
            data-kind={titleNotice.kind}
            className={`mt-2 text-sm ${titleNotice.kind === "error" ? "text-red-400" : "text-emerald-300"}`}
          >
            {titleNotice.text}
          </p>
        )}
        {importError && <p className="mt-2 text-sm text-red-400">{importError}</p>}
      </header>

      {/* 角落入口：导入剧本/画廊/创作模式（stopPropagation 防止 Enter 同时触发插卡） */}
      <div className="absolute bottom-[4vh] right-6 z-20 flex items-center gap-5 text-[12px] tracking-[.3em] text-ink-hint">
        <button
          type="button"
          data-testid="preset-import"
          disabled={importing}
          onClick={() => importRef.current?.click()}
          onKeyDown={(e) => e.stopPropagation()}
          className="transition-colors hover:text-[color:var(--accent)] disabled:cursor-not-allowed disabled:text-ink-faint"
        >
          {importing ? "导入中…" : "导入剧本"}
        </button>
        {/* 导入收 .preset.json（.json 已覆盖它，双写只是让选择器对话框里更醒目） */}
        <input
          ref={importRef}
          type="file"
          accept=".json,.preset.json"
          data-testid="preset-import-input"
          className="hidden"
          onChange={onImportPick}
        />
        <button
          type="button"
          onClick={openAssets}
          onKeyDown={(e) => e.stopPropagation()}
          className="transition-colors hover:text-[color:var(--accent)]"
        >
          素材
        </button>
        <button
          type="button"
          onClick={openCreation}
          onKeyDown={(e) => e.stopPropagation()}
          className="transition-colors hover:text-[color:var(--accent)]"
        >
          创作新剧本
        </button>
      </div>

      {/* 左右半屏点击切卡（置于卡层之下） */}
      {n > 1 && !inserting && (
        <>
          <button type="button" aria-label="上一张" onClick={() => step(-1)} className="absolute inset-y-0 left-0 z-[5] w-[18%] cursor-w-resize" />
          <button type="button" aria-label="下一张" onClick={() => step(1)} className="absolute inset-y-0 right-0 z-[5] w-[18%] cursor-e-resize" />
        </>
      )}

      {/* 卡带轮播舞台 */}
      <div className="absolute inset-0 flex items-center justify-center" style={{ perspective: 1400 }}>
        <div className="relative h-[min(430px,58vh)] w-[min(420px,84vw)]">
          {presets.map((p, i) => {
            const off = ringOffset(i, index, n);
            const visible = Math.abs(off) <= 1;
            const isCenter = off === 0;
            // n=2 时左右邻是同一张卡：只保留右侧，避免镜像重复
            const hiddenMirror = n === 2 && off === -1;
            const show = visible && !hiddenMirror;
            const t = getTheme(p);
            return (
              <Fragment key={p.id}>
                <motion.button
                  type="button"
                  onClick={() => {
                    if (Math.abs(dragged.current) > 12) return; // 拖拽后的 tap 不触发
                    if (inserting) return;
                    if (isCenter) insert();
                    else step(off > 0 ? 1 : -1);
                  }}
                  drag="x"
                  dragListener={isCenter}
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.16}
                  onDragStart={() => (dragged.current = 0)}
                  onDrag={(_e: unknown, info: PanInfo) => (dragged.current = info.offset.x)}
                  onDragEnd={onDragEnd}
                  initial={false}
                  animate={
                    inserting && isCenter
                      ? { x: 0, y: "34vh", scale: 0.16, rotateY: 0, opacity: 0.85, zIndex: 40 }
                      : {
                          x: show ? `${off * 64}%` : `${Math.sign(off || 1) * 130}%`,
                          y: 0,
                          scale: isCenter ? 1 : 0.6,
                          rotateY: show ? off * -25 : 0,
                          opacity: isCenter ? 1 : show ? 0.4 : 0,
                          zIndex: isCenter ? 20 : 10,
                        }
                  }
                  transition={inserting && isCenter ? { duration: 0.55, ease: [0.55, 0, 0.9, 0.4] } : SHIFT}
                  style={{ ...cardVars(t), transformOrigin: "50% 40%" }}
                  className={`absolute inset-0 h-full w-full rounded-2xl border text-left ${
                    isCenter ? "cursor-pointer" : "pointer-events-none"
                  } ${show ? "" : "pointer-events-none"}`}
                  aria-label={`${p.title} ${p.genre}`}
                  data-testid={isCenter ? "title-card-center" : undefined}
                >
                  {/* 卡面：封面图铺满卡底，主题色渐变与文字叠在图上保证可读性；无封面回退渐变+motif */}
                  <span
                    className="absolute inset-0 overflow-hidden rounded-2xl"
                    style={{
                      background: `linear-gradient(168deg, ${t.accent2}2e 0%, ${t.accent}24 34%, #0a0c12 76%), #0a0c12`,
                    }}
                  >
                    <CardCover id={p.id} />
                    {/* 封面可读性渐变（无封面时对底渐变无害） */}
                    <span
                      className="absolute inset-0 block"
                      style={{
                        background: "linear-gradient(180deg, rgba(10,12,18,.12) 0%, rgba(10,12,18,0) 38%, rgba(10,12,18,.88) 100%)",
                      }}
                    />
                    <span className="absolute inset-0 block">
                      <MotifLayer motif={t.motif} dense />
                    </span>
                    {/* 卡带顶部缺口与侧槽：致敬实体卡带 */}
                    <span
                      className="absolute left-1/2 top-3 h-1.5 w-16 -translate-x-1/2 rounded-full"
                      style={{ background: `linear-gradient(90deg, transparent, ${t.accent}80, transparent)` }}
                    />
                    <span className="absolute inset-x-6 bottom-24 top-14 rounded-lg border border-white/[.07] bg-black/25 backdrop-blur-[2px]">
                      <span className="absolute inset-x-0 top-0 flex justify-center gap-2 pt-3">
                        {[0, 1, 2, 3, 4].map((k) => (
                          <span key={k} className="h-1 w-6 rounded-sm bg-white/10" />
                        ))}
                      </span>
                    </span>
                  </span>

                  {/* 文案区 */}
                  <span className="absolute inset-x-0 bottom-0 block p-6 pt-14">
                    <span className="block text-[11px] tracking-[.28em]" style={{ color: t.accent }}>
                      {p.genre}
                    </span>
                    <span className="mt-2 block text-[22px] leading-snug tracking-[.12em] text-ink">{p.title}</span>
                    <span className="mt-2 block text-[12.5px] leading-relaxed text-ink-body">{p.tagline}</span>
                  </span>
                </motion.button>
                {/* 导出小按钮（v1.7）：只挂当前卡，浮在卡右上角——不嵌进 motion.button（嵌套交互元素非法）；
                    stopPropagation 防 Enter 同时触发插卡 */}
                {isCenter && !inserting && (
                  <a
                    href={presetExportUrl(p.id)}
                    download={`${p.id}.preset.json`}
                    data-testid={`preset-export-${p.id}`}
                    aria-label={`导出剧本 ${p.title}`}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      // 只拦 Enter（防止同时触发插卡）；方向键放行——点击导出后焦点留在链接上，
                      // 全拦会把 ← → 切卡也吞掉，直到玩家点别处才恢复
                      if (e.key === "Enter") e.stopPropagation();
                    }}
                    className="absolute right-3 top-3 z-30 rounded-md border border-white/15 bg-black/45 px-2 py-1 text-[11px] tracking-[.2em] text-ink/70 backdrop-blur-sm transition-colors hover:border-gold/50 hover:text-ink"
                  >
                    导出
                  </a>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* 卡槽横条（发光槽口）：插卡目标 */}
      <div
        className="absolute bottom-[9vh] left-1/2 z-30 h-3.5 w-44 -translate-x-1/2 rounded-full border border-white/15 bg-black/60"
        style={{ boxShadow: `0 0 16px 2px ${theme.accent}44, inset 0 0 10px ${theme.accent}55` }}
      >
        <AnimatePresence>
          {inserting && (
            <motion.span
              className="absolute inset-0 block rounded-full"
              style={{ background: theme.accent }}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.95, 0.25] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, times: [0, 0.45, 1], ease: "easeOut" }}
            />
          )}
        </AnimatePresence>
      </div>

      {/* 插卡瞬间的全屏主题色泛光 */}
      <AnimatePresence>
        {inserting && (
          <motion.div
            className="pointer-events-none absolute inset-0 z-40"
            style={{ background: `radial-gradient(85% 65% at 50% 88%, ${theme.accent}, transparent 72%)` }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      <p className="pointer-events-none absolute inset-x-0 bottom-[4vh] z-20 text-center text-[12px] tracking-[.35em] text-ink-hint">
        ← → 切换 · Enter 装载
      </p>
    </ScreenShell>
  );
}

/** 卡面级主题变量（继承舞台变量、按卡各自覆盖） */
function cardVars(t: ReturnType<typeof getTheme>): CSSProperties {
  return themeVars(t);
}
