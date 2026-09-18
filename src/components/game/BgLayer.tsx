import { useEffect, useState } from "react";
import { useGameStore } from "../../store/game";

/**
 * 背景交叉淡入时长（ms）：与 `AudioManager` 的 `FADE_MS`（600，CONTRACTS §1）同档。
 * 一个值管两件事——CSS 动画时长（内联 animation-duration）与「新图 → 底图」的晋级时刻；
 * 导出成常量是给用例当时间真源（`tests/e2e-ui/opening.spec.ts` 按它的数值断言过渡期形态，
 * 改这里要同批改那条断言）。
 */
export const BG_FADE_MS = 600;

/**
 * 两层背景的交接状态。
 * - `base`：已淡入完成的底图（常驻、不透明，DOM 里最多一个）
 * - `incoming`：正在淡入的下一张（盖在 base 之上，`BG_FADE_MS` 后晋级成 base 并卸载）
 */
interface BgSwap {
  base: string | null;
  incoming: string | null;
}

/**
 * 背景层：常驻在 App 根（crafting→game 转场不重载），全程 `pointer-events-none`。
 * 两道「不许闪」：
 * 1) **先预载再上屏**：新图离屏 `new Image()`，`onload` 之后才把 URL 挂进 DOM——
 *    否则会闪过半张未解码的图（旧版 setBg 的语义，保持不动）。
 * 2) **双层交叉淡化**：新图作为上层从 opacity 0 淡到 1，旧底图留在下层不透明——
 *    合成结果就是交叉淡化（旧图被逐渐盖掉 = 淡出），且不会出现「先压暗到黑再亮起来」的中场。
 *    `BG_FADE_MS` 后把 incoming **晋级**为 base 并卸载上层：稳态 DOM 里只有一张图（不是三层堆着）。
 *
 * 动效降级（prefers-reduced-motion: reduce）：`.stage-bg-fade` 的淡入被 `global.css` 的
 * 「动效降级」段关掉（`animation: none`）→ 新图直接以不透明挂上屏 = **瞬时换图**。
 * 注意这与 framer-motion 侧的口径刻意不同：屏转场/差分切换的 opacity 交叉淡入照常播放
 * （见 App.tsx 的 MotionConfig 注释与 docs/ARCHITECTURE.md「动效降级」），而背景是整屏亮度的大面积
 * 渐变——reduce 下换成硬切，不再让整屏亮度缓慢爬升。
 *
 * 晋级时刻用 `setTimeout` 钉死（不用 `animationend`）：动画在后台标签页/假定时器下可能不推进，
 * 状态交接却必须在确定时刻发生；即便动画一帧没跑，到点也会把新图落到 base 上（自愈）。
 */
export default function BgLayer() {
  const bgUrl = useGameStore((s) => s.bgUrl);
  const [swap, setSwap] = useState<BgSwap>({ base: null, incoming: null });

  // ① 离屏预载：bgUrl 变化（【图】背景 marker）→ onload 后才挂上屏。
  // 已经在屏上的图（底图 / 在飞的上层）不再重挂：同 URL 重复标记不该重放一次淡入。
  useEffect(() => {
    if (!bgUrl) return; // bgUrl 置 null（回标题/重开）不动画面：底图留到下一张来才换，避免闪一下黑
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive) setSwap((s) => (bgUrl === s.base || bgUrl === s.incoming ? s : { base: s.base, incoming: bgUrl }));
    };
    img.src = bgUrl;
    return () => {
      alive = false;
    };
  }, [bgUrl]);

  // ② 晋级：淡入走完（BG_FADE_MS）把 incoming 提为 base，上层随之卸载（稳态只留一张底图）。
  // 期间又来了更新的图（incoming 换人）：cleanup 撤掉旧定时器，交接时刻重新起算。
  useEffect(() => {
    const url = swap.incoming;
    if (!url) return;
    const timer = setTimeout(() => {
      setSwap((s) => (s.incoming === url ? { base: url, incoming: null } : s));
    }, BG_FADE_MS);
    return () => clearTimeout(timer);
  }, [swap.incoming]);

  return (
    <div className="pointer-events-none fixed inset-0" data-testid="bg-layer">
      {/* 底图：不透明常驻，交叉淡化期间它就是「旧图」那一半 */}
      {swap.base && (
        <div
          data-testid="bg-current"
          className="absolute inset-0 scale-[1.06] bg-cover bg-center"
          style={{ backgroundImage: `url("${swap.base}")` }}
        />
      )}
      {/* 上层：淡入中的新图。key 绑 URL——同一节点上换图不会重放 CSS 动画，会被合成硬切 */}
      {swap.incoming && (
        <div
          key={swap.incoming}
          data-testid="bg-incoming"
          className="stage-bg-fade absolute inset-0 scale-[1.06] bg-cover bg-center"
          style={{ backgroundImage: `url("${swap.incoming}")`, animationDuration: `${BG_FADE_MS}ms` }}
        />
      )}
    </div>
  );
}
