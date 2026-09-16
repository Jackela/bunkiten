import { AnimatePresence, motion } from "framer-motion";
import { useGameStore, type PreloadItem } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { useTurnElapsed } from "./useTurnElapsed";

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

function ArtSlot({ item, url }: { item: PreloadItem; url: string | null }) {
  const scene = item.kind === "background";
  // 跳过项若随后收到图也照常显示（只是不再等它）；失败项恒不显示
  const showArt = url && item.state !== "failed";
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`relative aspect-[3/4] w-full overflow-hidden rounded-xl border bg-white/[.03] ${
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
                <span className="absolute inset-0 flex items-center justify-center text-2xl text-ink/30">
                  <span className="absolute h-[2px] w-[130%] -rotate-45 bg-ink/25" />
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {item.state === "running" && (
          <span className="absolute left-2 top-2 rounded-sm bg-black/55 px-1.5 py-0.5 text-[10px] tracking-[.15em] text-gold">
            生成中
          </span>
        )}
      </div>
      <div className={`text-[13px] ${item.state === "failed" ? "text-ink/35" : url ? "text-gold" : "text-ink/60"}`}>
        {item.label}
        <span className="ml-1.5 text-[10px] tracking-[.1em] text-ink/35">{STATE_LABEL[item.state]}</span>
      </div>
    </div>
  );
}

/** 规划阶段的「章节大纲」槽位：山景剪影 + 撰写中文案 */
function OutlineSlot({ active }: { active: boolean }) {
  return (
    <div className="flex w-36 flex-col items-center gap-2">
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl border border-white/10 bg-white/[.03]">
        <Silhouette scene dim={!active} />
      </div>
      <div className="text-[13px] text-ink/60">
        章节大纲
        <span className="ml-1.5 text-[10px] tracking-[.1em] text-ink/35">{active ? "撰写大纲与剧情树…" : "排队中"}</span>
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
  const worldLabel = useGameStore((s) => s.worldLabel);
  const elapsed = useTurnElapsed();

  if (!selected) return null;

  const planning = preloadPhase === "init" || preloadPhase === "planning";
  const doneCount = preload.filter((i) => i.state === "done").length;
  const busy = status.includes("…");
  const canSkip = preloadPhase === "init" || preloadPhase === "planning" || preloadPhase === "queue";

  return (
    <ScreenShell className="overflow-y-auto bg-bg/60">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center px-6 py-12">
        <h2 className="text-xl tracking-[.6em] [text-indent:.6em]">{chapterNo > 1 ? `第 ${chapterNo} 章 · 制作中` : "制 作 中"}</h2>
        {chapterNo > 1 && <p className="mt-2 text-[11px] tracking-[.2em] text-gold/70">本章完 · 下一章制作中</p>}
        <p className="mt-4 flex items-center gap-2 text-xs text-ink/60">
          <span className={`h-[7px] w-[7px] rounded-full ${busy ? "animate-pulse bg-gold" : "bg-[#3d4254]"}`} />
          {status}
          {busy && elapsed !== null && <span className="tabular-nums">{elapsed}s</span>}
        </p>
        <p className="mt-1.5 text-[11px] tracking-[.2em] text-ink/40">
          {planning
            ? `为《${selected.title}》撰写第 ${chapterNo} 章大纲与剧情树`
            : `${doneCount} / ${preload.length} 就绪 · 为《${selected.title}》赶制美术`}
          {worldLabel && <span className="ml-2 text-ink/30">· {worldLabel}</span>}
        </p>
        {planning ? (
          <div className="mt-8">
            <OutlineSlot active={preloadPhase === "planning"} />
          </div>
        ) : (
          <div className="mt-8 grid w-full grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {preload.map((item) => (
              <ArtSlot key={`${item.kind}-${item.name}`} item={item} url={slotUrl(artReady, item)} />
            ))}
          </div>
        )}

        {canSkip && (
          <button
            type="button"
            onClick={skipPreload}
            className="mt-10 rounded-lg border border-dashed border-white/20 px-5 py-2.5 text-sm tracking-[.1em] text-ink/70 transition-colors hover:border-gold/40 hover:text-ink"
          >
            跳过剩余，立即开演
          </button>
        )}
        <button
          type="button"
          onClick={openTree}
          data-testid="crafting-tree-link"
          className="mt-4 text-[11.5px] tracking-[.2em] text-ink/45 underline-offset-4 transition-colors hover:text-[color:var(--accent)] hover:underline"
        >
          查看剧情图
        </button>
      </div>
    </ScreenShell>
  );
}
