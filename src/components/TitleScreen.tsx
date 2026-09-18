import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { coverUrl, fetchPresets, fetchWorlds, presetExportUrl, type WorldEntry } from "../lib/acp";
import { getTheme, themeVars } from "../theme";
import { useGameStore } from "../store/game";
import { relativeTime, worldDisplayName } from "./WorldsScreen";
import { ScreenShell } from "./ScreenShell";
import { MotifLayer } from "./motifs";

/** 换位 spring：克制的阻尼，不弹跳 */
const SHIFT = { type: "spring", stiffness: 240, damping: 30, mass: 0.9 } as const;
/** 拖拽判定阈值（px）：超过视为切卡，抑制误触 */
const DRAG_THRESHOLD = 60;
/** 插卡动画到切屏的时长（ms） */
const INSERT_MS = 1000;
/** 邻卡不透明度：原 0.4 那档卡面糊成一团黑（读不出是什么本子），抬到这一档——仍明显低于中央卡的 1 */
const SIDE_CARD_OPACITY = 0.64;

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

/** 标题屏：老游戏机式的卡带轮播。← → 切卡，Enter/点中央卡「插卡」进入世界线屏（选卡后由那里落定世界）。
 *  v1.8 壳层化：产品字标（bunkiten / 分岐点）+ 左下「继续上次」直通入口 + 右下角落簇（导出当前卡 /
 *  导入剧本 / 素材 / 剧本体检 / 创作新剧本）；卡面按实体卡带分带（顶部标签带 / 磁带窗 / 底缘脊柱），文案字号走
 *  global.css 的档位类（不再手写 text-[Npx]）。 */
export default function TitleScreen() {
  const selectPreset = useGameStore((s) => s.selectPreset);
  const setPresets = useGameStore((s) => s.setPresets);
  const importPresetText = useGameStore((s) => s.importPresetText);
  const clearTitleNotice = useGameStore((s) => s.clearTitleNotice);
  const titleNotice = useGameStore((s) => s.titleNotice);
  const openAssets = useGameStore((s) => s.openAssets);
  const openCheck = useGameStore((s) => s.openCheck);
  const openCreation = useGameStore((s) => s.openCreation);
  const resumeWorld = useGameStore((s) => s.resumeWorld);
  const engineBusy = useGameStore((s) => s.engineBusy);
  // 轮播数据读 store：挂载拉取写入，presetAdded（新剧本装配完成）也会刷新——新卡带封面即时出现
  const presets = useGameStore((s) => s.presets);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const [inserting, setInserting] = useState(false);
  /** 最近游玩的世界线（挂载拉一次全量 /api/worlds，自己取 lastPlayed 最大的一条：与 WorldsScreen aside 同判据） */
  const [worlds, setWorlds] = useState<WorldEntry[]>([]);
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
        // 解析失败的剧本目录是开发诊断信息（旧版在标题屏报「跳过 N 个无法解析的剧本」），只留控制台
        if (r.errors.length > 0) console.debug("剧本目录解析失败：", r.errors);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(String(e));
      });
    return () => abort.abort();
  }, [setPresets]);

  // 「继续上次」的世界清单：标题屏还没有 selected，所以不按剧本过滤（最近玩的那条可能在别的本里）。
  // 拉不到不挡路：这只是个快捷入口，完整清单与错误态在世界线屏
  useEffect(() => {
    const abort = new AbortController();
    fetchWorlds(undefined, abort.signal)
      .then(setWorlds)
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") console.debug("标题屏：世界线清单拉取失败", e);
      });
    return () => abort.abort();
  }, []);

  // 进屏清掉上一轮的提示条（导入结果属于上一次会话，不该复读）
  useEffect(() => {
    clearTitleNotice();
  }, [clearTitleNotice]);

  const n = presets.length;
  const current = presets[index] ?? null;
  const theme = getTheme(current);

  const lastWorld = useMemo(
    () => worlds.reduce<WorldEntry | null>((best, w) => (!best || w.lastPlayed > best.lastPlayed ? w : best), null),
    [worlds],
  );
  /** 该世界线所属剧本：世界线屏的续玩前提就是 selected 等于它（清单本来按它过滤）；
   *  不在轮播里 = 剧本已从数据目录移除，那条世界线进不去（显示层说清，不用裸 id） */
  const resumePreset = lastWorld ? (presets.find((p) => p.id === lastWorld.preset) ?? null) : null;
  const continueName = lastWorld ? worldDisplayName(lastWorld, resumePreset?.title ?? lastWorld.title) : "";
  const continueDisabled = !lastWorld || !resumePreset || !lastWorld.exists || engineBusy;
  // loaded 进条件：轮播还没到位时不急着说「剧本已移除」（两个拉取谁先回来不定，避免闪一下死态）
  const showContinue = lastWorld !== null && (resumePreset !== null || loaded);

  const step = (dir: 1 | -1) => {
    if (!inserting && n > 1) setIndex((i) => (i + dir + n) % n);
  };

  const insert = () => {
    if (inserting || !current) return;
    setInserting(true);
    window.setTimeout(() => selectPreset(current), INSERT_MS);
  };

  /**
   * 「继续上次」：走世界线屏行上那个「继续」的同一条路径（resumeWorld）。
   * 唯一差别是前置——世界线屏的清单按 selected 过滤（它假定牌面已立），标题屏还没选卡，
   * 所以先 selectPreset 把 selected（连同音频索引）换到该世界所属剧本，紧接着同一 tick 内 resumeWorld：
   * 前者把 screen 落到 worlds，后者覆盖成 game，最终只渲染 game 屏。
   */
  const resumeLast = () => {
    if (!lastWorld || !resumePreset || continueDisabled) return;
    selectPreset(resumePreset);
    resumeWorld({
      worldId: lastWorld.worldId,
      chapterNo: lastWorld.chapterNo,
      note: lastWorld.note,
      // 显示名与备注一起带过去：缺了它顶栏就得拿备注/裸 id 顶（见 store/types.ts worldLabel）
      label: lastWorld.label,
    });
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
    <ScreenShell className="overflow-hidden shell-backdrop" style={themeVars(theme)}>
      {/* 舞台氛围：随当前卡主题 */}
      <div className="absolute inset-0 opacity-70">
        <MotifLayer motif={theme.motif} />
      </div>

      {/* 字标区：居中且收在上缘（卡带舞台落视口中线；最小窗口 960×640 下仍与卡顶留出余量） */}
      <header className="absolute inset-x-0 top-0 z-20 flex flex-col items-center pt-6 text-center">
        <h1
          data-testid="title-wordmark"
          className="text-display font-normal tracking-[.34em] text-ink [text-indent:.34em]"
        >
          bunkiten
        </h1>
        <p className="mt-1 text-meta tracking-[.4em] text-gold/85 [text-indent:.4em]">分 岐 点</p>
        <p className="mt-2 text-ui tracking-[.14em] text-ink-body">选一张卡带，今晚住进去</p>
        {error && <p className="mt-2 text-ui text-red-400">剧本加载失败：{error}</p>}
        {!loaded && !error && <p className="mt-2 animate-pulse text-ui text-ink-hint">加载中…</p>}
        {titleNotice && (
          <p
            data-testid="title-notice"
            data-kind={titleNotice.kind}
            className={`mt-2 text-ui ${titleNotice.kind === "error" ? "text-red-400" : "text-emerald-300"}`}
          >
            {titleNotice.text}
          </p>
        )}
        {importError && <p className="mt-2 text-ui text-red-400">{importError}</p>}
      </header>

      {/* 「继续上次」：最近游玩的世界线直通入口（免去 title → worlds → 继续 的三跳）。
          单占左下角一簇——不压中央卡、也不与底部中央的键盘提示抢位；
          箭头只对 Enter 让路（stopPropagation 防同时触发插卡），方向键照旧切卡 */}
      {showContinue && lastWorld && (
        <button
          type="button"
          data-testid="title-continue"
          aria-label={`继续上次的世界线 ${continueName}`}
          disabled={continueDisabled}
          title={!lastWorld.exists ? "目录缺失" : !resumePreset ? "剧本已移除" : engineBusy ? "忙碌中，稍后再试" : undefined}
          onClick={resumeLast}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.stopPropagation();
          }}
          className={`group absolute bottom-[4vh] left-6 z-20 w-[min(228px,40vw)] rounded-2xl border px-4 py-3 text-left backdrop-blur-md transition-colors ${
            continueDisabled
              ? "cursor-not-allowed border-white/10 bg-panel text-ink-hint"
              : "border-gold/35 bg-gold/15 hover:bg-gold/25"
          }`}
        >
          <span className="flex items-center gap-2">
            <span className="text-meta tracking-[.25em] text-gold/80">继 续 上 次</span>
            <span aria-hidden className="ml-auto text-meta text-gold/70 transition-transform group-hover:translate-x-0.5">
              ▸
            </span>
          </span>
          <span className={`mt-1.5 block truncate text-ui ${continueDisabled ? "text-ink-hint" : "text-ink"}`}>
            {continueName}
          </span>
          <span className="mt-0.5 block truncate text-meta text-ink-hint">
            第 {lastWorld.chapterNo} 章 · {relativeTime(lastWorld.lastPlayed)}
            {engineBusy && <span className="ml-1.5">忙碌中</span>}
            {!lastWorld.exists && <span className="ml-1.5 text-red-400/90">目录缺失</span>}
            {lastWorld.exists && !resumePreset && <span className="ml-1.5 text-red-400/90">剧本已移除</span>}
          </span>
        </button>
      )}

      {/* 角落簇：导出当前卡 / 导入剧本 / 素材 / 创作新剧本。
          「导出」从卡面（会压住封面）挪到这里，但目标恒为**当前中央卡**——
          testid、href、download 与 v1.7 逐字一致（e2e 的下载断言照旧）。
          各入口 stopPropagation 防 Enter 落到 window 上同时触发插卡 */}
      <div className="absolute bottom-[4vh] right-6 z-20 flex items-center gap-5 text-ui tracking-[.25em] text-ink-hint">
        {current && !inserting && (
          <a
            href={presetExportUrl(current.id)}
            download={`${current.id}.preset.json`}
            data-testid={`preset-export-${current.id}`}
            aria-label={`导出剧本 ${current.title}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // 只拦 Enter（防止同时触发插卡）；方向键放行——点击导出后焦点留在链接上，
              // 全拦会把 ← → 切卡也吞掉，直到玩家点别处才恢复
              if (e.key === "Enter") e.stopPropagation();
            }}
            className="transition-colors hover:text-[color:var(--accent)]"
          >
            导出
          </a>
        )}
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
        {/* 剧本体检（v1.8）：对象恒为**当前中央卡**——标题屏还没「插卡」时 store 的 selected 可能还是空
            或上一局的剧本，所以把卡带进 openCheck（只落 selected，不进世界线屏、不重置运行态）。
            没有卡可检时禁用并说明原因，不留一个点了没反应的死按钮 */}
        <button
          type="button"
          data-testid="preset-check"
          disabled={!current}
          title={current ? `体检《${current.title}》` : "还没有可体检的剧本"}
          onClick={() => current && openCheck(current)}
          onKeyDown={(e) => e.stopPropagation()}
          className="transition-colors hover:text-[color:var(--accent)] disabled:cursor-not-allowed disabled:text-ink-faint"
        >
          剧本体检
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

      {/* 左右半屏点击切卡（置于卡层之下）：宽命中区照旧留给拖拽/点击，里面加可见的雪佛龙
          ——焦点在雪佛龙上时 Enter 只切卡（不冒到 window 再插一次卡） */}
      {n > 1 && !inserting && (
        <>
          <button
            type="button"
            aria-label="上一张"
            onClick={() => step(-1)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.stopPropagation();
            }}
            className="group absolute inset-y-0 left-0 z-[5] flex w-[18%] cursor-w-resize items-center justify-center"
          >
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/12 bg-scrim text-title leading-none text-ink-body backdrop-blur-sm transition-colors group-hover:border-gold/45 group-hover:text-ink"
            >
              ‹
            </span>
          </button>
          <button
            type="button"
            aria-label="下一张"
            onClick={() => step(1)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.stopPropagation();
            }}
            className="group absolute inset-y-0 right-0 z-[5] flex w-[18%] cursor-e-resize items-center justify-center"
          >
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/12 bg-scrim text-title leading-none text-ink-body backdrop-blur-sm transition-colors group-hover:border-gold/45 group-hover:text-ink"
            >
              ›
            </span>
          </button>
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
                          opacity: isCenter ? 1 : show ? SIDE_CARD_OPACITY : 0,
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
                  {/* 卡面：封面图铺满卡底，主题色渐变与卡带细节叠在图上；无封面回退渐变+motif */}
                  <span
                    className="absolute inset-0 overflow-hidden rounded-2xl"
                    style={{
                      background: `linear-gradient(168deg, ${t.accent2}2e 0%, ${t.accent}24 34%, #0a0c12 76%), #0a0c12`,
                    }}
                  >
                    <CardCover id={p.id} />
                    {/* 可读性洗色：上/下压深（标签带与文案带落在深底上），中段几乎不压——封面照旧看得见 */}
                    <span
                      className="absolute inset-0 block"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(10,12,18,.6) 0%, rgba(10,12,18,.14) 24%, rgba(10,12,18,0) 48%, rgba(10,12,18,.5) 80%, rgba(10,12,18,.88) 100%)",
                      }}
                    />
                    <span className="absolute inset-0 block">
                      <MotifLayer motif={t.motif} dense />
                    </span>

                    {/* 顶部标签带：卡带的纸标（自带深色底+毛玻璃，保证任意封面上的可读性）——标题 + 题材/分级 */}
                    <span className="absolute inset-x-0 top-0 block border-b border-white/[.08] bg-scrim px-5 pb-2.5 pt-3 backdrop-blur-[3px]">
                      <span className="block truncate text-title leading-snug tracking-[.08em] text-ink">{p.title}</span>
                      <span className="mt-0.5 block truncate text-meta tracking-[.22em]" style={{ color: t.accent }}>
                        {p.genre} · {p.rating}
                      </span>
                    </span>

                    {/* 磁带窗：圆角凹槽 + 两个卷盘 + 两盘之间的磁带段（近底边，卡带的辨识特征，纯 CSS）。
                        凹陷感来自「比周围更深的底」——浅色填充在亮封面上会糊成一块奶白面板 */}
                    <span className="absolute inset-x-9 bottom-[27%] block h-16 rounded-xl border border-white/[.09] bg-scrim backdrop-blur-[2px]">
                      <span className="absolute inset-x-16 top-1/2 block h-px -translate-y-1/2 bg-white/[.14]" />
                      <span className="absolute inset-0 flex items-center justify-evenly">
                        {[0, 1].map((k) => (
                          <span
                            key={k}
                            className="relative block h-9 w-9 rounded-full border border-white/20 bg-white/[.07]"
                          >
                            <span className="absolute left-1/2 top-1/2 block h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30 bg-black/50" />
                          </span>
                        ))}
                      </span>
                    </span>

                    {/* 文案带：只放默认语句（题材与标题已上标签带，不重复）。
                        这里不能再写 block：display 会被它盖掉，line-clamp 的 -webkit-box 失效 */}
                    <span className="absolute inset-x-0 bottom-0 block px-5 pb-5">
                      <span className="line-clamp-2 text-ui leading-relaxed text-ink-body">{p.tagline}</span>
                    </span>

                    {/* 底缘脊柱：一道窄带 + 中央凹槽与两个卷轴开口（实体卡带下缘的形，纯 CSS） */}
                    <span className="absolute inset-x-0 bottom-0 block h-2.5 bg-scrim">
                      <span className="absolute left-1/2 top-0 block h-full w-[34%] -translate-x-1/2 border-x border-white/[.07]" />
                      <span className="absolute left-[15%] top-1/2 block h-1 w-7 -translate-y-1/2 rounded-full border border-white/15" />
                      <span className="absolute right-[15%] top-1/2 block h-1 w-7 -translate-y-1/2 rounded-full border border-white/15" />
                    </span>
                  </span>
                </motion.button>
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

      <p className="pointer-events-none absolute inset-x-0 bottom-[4vh] z-20 text-center text-meta tracking-[.35em] text-ink-hint">
        ← → 切换 · Enter 装载
      </p>
    </ScreenShell>
  );
}

/** 卡面级主题变量（继承舞台变量、按卡各自覆盖） */
function cardVars(t: ReturnType<typeof getTheme>): CSSProperties {
  return themeVars(t);
}
