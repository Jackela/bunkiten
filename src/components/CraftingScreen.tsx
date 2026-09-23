import { AnimatePresence, motion } from "framer-motion";
import { useGameStore, type PreloadItem } from "../store/game";
import { playerStatus } from "../lib/status";
import { resolveWorldLabel } from "../lib/worlds";
import { ScreenShell } from "./ScreenShell";
import { ShellPage } from "./ShellPage";
import { useTick, useTurnElapsed } from "./useTurnElapsed";

/**
 * 本批美术的剩余预估文案（纯函数，单测直引）。口径：
 * - 平均每张 = （现在 − 批次起点）/ 已完成张数——**已有 2 张以上才给**（样本太少时估出来是噪声）；
 * - 剩余 = 平均 × 还没完成的张数；
 * - 一律带「约」：这是粗估不是承诺（出图快慢取决于服务商与画幅）。没在跑的批次或样本不足时返回 null。
 * @param {{done: number, total: number, startedAt: number|null, now: number}} o 已完成张数 / 总数 / 批次起点 / 现在
 * @returns {string|null} 形如「平均 ≈38s / 张 · 约还需 ~6 分钟」，或 null（不显示）
 */
export function preloadEtaLabel(o: { done: number; total: number; startedAt: number | null; now: number }): string | null {
  if (o.startedAt === null || o.done < 2 || o.done >= o.total) return null;
  const perItemMs = Math.max(0, (o.now - o.startedAt) / o.done);
  const remainMs = perItemMs * (o.total - o.done);
  const per = `平均 ≈${Math.max(1, Math.round(perItemMs / 1000))}s / 张`;
  const remain = remainMs < 90_000 ? `约还需 ~${Math.max(1, Math.round(remainMs / 1000))} 秒` : `约还需 ~${Math.round(remainMs / 60_000)} 分钟`;
  return `${per} · ${remain}`;
}

/** 槽位名（清单/preset 可能带「」）→ artReady 槽位 URL */
function slotUrl(artReady: Record<string, string>, item: PreloadItem): string | null {
  if (item.url) return item.url;
  const norm = (x: string) => x.replace(/[「」『』]/g, "").trim();
  return artReady[item.name] || artReady[norm(item.name)] || null;
}

/** 未就绪槽位的剪影占位：渐变人形/山景 + 呼吸 + 高光扫过（生成中态） */
function Silhouette({ scene, dim }: { scene: boolean; dim?: boolean }) {
  return (
    <>
      <motion.div
        className="absolute inset-0 flex items-end justify-center"
        animate={
          dim
            ? { opacity: 0.45 }
            : scene
              ? { opacity: [0.7, 1, 0.7] }
              : { scale: [1, 1.025, 1], opacity: [0.7, 1, 0.7] }
        }
        transition={dim ? { duration: 0.4 } : { duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
        style={scene ? undefined : { transformOrigin: "50% 100%" }}
      >
        {scene ? (
          <svg viewBox="0 0 100 100" className="h-2/3 w-full" preserveAspectRatio="none">
            <defs>
              <linearGradient id="slot-scene-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(236,231,219,.14)" />
                <stop offset="1" stopColor="rgba(201,168,106,.32)" />
              </linearGradient>
            </defs>
            <circle cx="70" cy="24" r="8" fill="rgba(236,231,219,.22)" />
            <path d="M0 78 L22 54 L40 70 L60 46 L82 68 L100 56 L100 100 L0 100 Z" fill="url(#slot-scene-grad)" />
          </svg>
        ) : (
          <svg viewBox="0 0 100 140" className="h-5/6">
            <defs>
              <linearGradient id="slot-figure-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(236,231,219,.16)" />
                <stop offset="1" stopColor="rgba(201,168,106,.34)" />
              </linearGradient>
            </defs>
            <circle cx="50" cy="30" r="15" fill="url(#slot-figure-grad)" />
            <path d="M50 50 C 32 50 22 62 20 82 L 16 126 L 84 126 L 80 82 C 78 62 68 50 50 50 Z" fill="url(#slot-figure-grad)" />
          </svg>
        )}
      </motion.div>
      {!dim && (
        <motion.div
          className="absolute inset-y-0 w-1/3 bg-[linear-gradient(100deg,transparent,rgba(236,231,219,.09),transparent)]"
          animate={{ x: ["-120%", "320%"] }}
          transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
    </>
  );
}

const STATE_LABEL: Record<PreloadItem["state"], string> = {
  pending: "排队中",
  running: "生成中",
  done: "就绪",
  failed: "失败",
  skipped: "跳过",
};

/** 一张美术卡：缩略图 + 槽位名/状态。宽栏下按栅格多列铺，卡片自带 .shell-panel 底（旧版是一条窄列里的小缩略图） */
function ArtSlot({ item, url }: { item: PreloadItem; url: string | null }) {
  const scene = item.kind === "background";
  // 跳过项若随后收到图也照常显示（只是不再等它）；失败项恒不显示
  const showArt = url && item.state !== "failed";
  return (
    <div data-testid={`crafting-slot-${item.kind}-${item.name}`} className="shell-panel rounded-xl p-3">
      <div
        className={`relative aspect-[3/4] w-full overflow-hidden rounded-lg border bg-white/[.03] ${
          item.state === "failed" ? "grayscale" : "border-white/10"
        }`}
      >
        <AnimatePresence>
          {showArt ? (
            <motion.img
              key="art"
              src={url ?? undefined}
              alt={item.name}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.2, ease: "easeInOut" }}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <motion.div key="placeholder" exit={{ opacity: 0 }} transition={{ duration: 1.2, ease: "easeInOut" }} className="absolute inset-0">
              <Silhouette scene={scene} dim={item.state !== "running"} />
              {item.state === "failed" && (
                <span className="absolute inset-0 flex items-center justify-center text-ink-faint">
                  <span className="absolute h-[2px] w-[130%] -rotate-45 bg-ink/25" />
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {item.state === "running" && (
          <span className="absolute left-2 top-2 rounded-sm bg-black/55 px-1.5 py-0.5 text-micro tracking-[.15em] text-gold">
            生成中
          </span>
        )}
      </div>
      <div className={`mt-2.5 flex items-baseline gap-1.5 text-meta ${item.state === "failed" ? "text-ink-hint" : url ? "text-gold" : "text-ink-hint"}`}>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <span className="flex-none text-micro tracking-[.1em] text-ink-hint">{STATE_LABEL[item.state]}</span>
      </div>
    </div>
  );
}

/** 规划阶段的「章节大纲」槽位：山景剪影 + 撰写中文案（同款卡片，宽栏下给足标签一行放下） */
function OutlineSlot({ active }: { active: boolean }) {
  return (
    <div className="shell-panel w-52 rounded-xl p-3 sm:w-64">
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-lg border border-white/10 bg-white/[.03]">
        <Silhouette scene dim={!active} />
      </div>
      <div className="mt-2.5 flex items-baseline gap-1.5 text-meta text-ink-hint">
        <span className="flex-none">章节大纲</span>
        <span data-testid="crafting-plan-slot" className="text-micro tracking-[.1em] text-ink-hint">
          {active ? "撰写大纲与剧情树…" : "排队中"}
        </span>
      </div>
    </div>
  );
}

/** 制作中屏：待命 → 规划（章节大纲）→ 按清单逐项美术 → 「开演。」→ game。单项失败不阻塞。 */
export default function CraftingScreen() {
  const selected = useGameStore((s) => s.selected);
  const artReady = useGameStore((s) => s.artReady);
  const status = useGameStore((s) => s.status);
  const preload = useGameStore((s) => s.preload);
  const preloadPhase = useGameStore((s) => s.preloadPhase);
  const chapterNo = useGameStore((s) => s.chapterNo);
  const skipPreload = useGameStore((s) => s.skipPreload);
  const openTree = useGameStore((s) => s.openTree);
  const worldId = useGameStore((s) => s.worldId);
  const worldLabel = useGameStore((s) => s.worldLabel);
  const elapsed = useTurnElapsed();
  // 批次读数按秒跳（只在真的有批次在跑时起定时器）：平均每张 / 约还需都从 preloadBatchStartedAt 算
  const preloadBatchStartedAt = useGameStore((s) => s.preloadBatchStartedAt);
  const now = useTick(preloadBatchStartedAt !== null);

  if (!selected) return null;

  const planning = preloadPhase === "init" || preloadPhase === "planning";
  const doneCount = preload.filter((i) => i.state === "done").length;
  const busy = status.includes("…");
  const canSkip = preloadPhase === "init" || preloadPhase === "planning" || preloadPhase === "queue";
  const eta = preloadEtaLabel({ done: doneCount, total: preload.length, startedAt: preloadBatchStartedAt, now });
  // 世界名只在「有名字」时出现（与顶栏同一条规则）：无显示名时 store 退化为空串；
  // `worldLabel !== worldId` 只是防旧状态/手改数据（旧版 server 自动写的分叉备注也是裸 id 串，见 lib/worlds）
  const label = resolveWorldLabel(worldLabel, worldId);
  const showWorldLabel = label !== "";

  return (
    <ScreenShell className="overflow-y-auto shell-backdrop">
      <ShellPage
        eyebrow={selected.title}
        title={chapterNo > 1 ? `第 ${chapterNo} 章 · 制作中` : "制 作 中"}
        actions={
          <>
            {canSkip && (
              <button
                type="button"
                onClick={skipPreload}
                className="rounded-lg border border-dashed border-white/20 px-5 py-2 text-ui tracking-[.1em] text-ink-body transition-colors hover:border-gold/40 hover:text-ink"
              >
                跳过剩余，立即开演
              </button>
            )}
            <button
              type="button"
              onClick={openTree}
              data-testid="crafting-tree-link"
              className="rounded-lg border border-white/10 px-4 py-2 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-[color:var(--accent)]"
            >
              查看剧情图
            </button>
          </>
        }
        footer={canSkip ? "跳过剩余会立刻开演，未就绪的美术可从画廊补画" : undefined}
      >
        {chapterNo > 1 && <p className="mb-3 text-meta tracking-[.2em] text-gold/70">本章完 · 下一章制作中</p>}
        {/* 状态行与顶栏共用 lib/status 的映射：引擎口吻（「引擎演绎中…」「撰写章节大纲…」）不上玩家的屏 */}
        <p data-testid="crafting-status" className="flex items-center gap-2 text-ui text-ink-hint">
          <span className={`h-[7px] w-[7px] rounded-full ${busy ? "animate-pulse bg-gold" : "bg-[#3d4254]"}`} />
          {playerStatus(status)}
          {busy && elapsed !== null && <span className="tabular-nums">{elapsed}s</span>}
        </p>
        <p data-testid="crafting-progress" className="mt-1.5 text-meta tracking-[.2em] text-ink-hint">
          {planning ? `正在为《${selected.title}》筹备第 ${chapterNo} 章` : `美术 ${doneCount} / ${preload.length} 就绪`}
          {/* 可预期性（v1.13）：还有多少张、大概还要多久——粗估，带「约」；样本不足时这半截不显示 */}
          {!planning && eta && <span className="ml-2 text-ink-hint">· {eta}</span>}
          {showWorldLabel && <span className="ml-2 text-ink-hint">· {label}</span>}
        </p>

        {planning ? (
          <div className="mt-8">
            <OutlineSlot active={preloadPhase === "planning"} />
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {preload.map((item) => (
              <ArtSlot key={`${item.kind}-${item.name}`} item={item} url={slotUrl(artReady, item)} />
            ))}
          </div>
        )}
      </ShellPage>
    </ScreenShell>
  );
}
