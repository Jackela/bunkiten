import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useGameStore } from "../../store/game";

/** 章节卡在屏总时长（ms）：到点即卸载——够看清「第 N 章」，又不至于压着画面不走（导出给用例当时间真源） */
export const CHAPTER_CARD_MS = 2200;
/** 退场淡出时长（ms）：从在屏时长的末尾切出来，看得清与不硬切两者兼得 */
export const CHAPTER_CARD_FADE_MS = 400;

/** 上下两条 accent 发丝线：两端淡出（与对话框顶线同一手法），中间托住章号 */
function Rule() {
  return (
    <span
      aria-hidden="true"
      className="h-px w-[min(320px,42vw)]"
      style={{
        background:
          "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 70%, transparent), transparent)",
      }}
    />
  );
}

/**
 * 章节过场卡（VN 惯例）：章号一变就在画面正中亮一次「第 N 章」，约 {@link CHAPTER_CARD_MS} 后自行退场。
 * 三条硬约束：
 * 1) `pointer-events-none`：过场不是模态——卡在屏时玩家照常点对话框/选项/命令轨，绝不拦点击；
 * 2) 屏上没有任何可聚焦元素、也不调 focus()：不打乱「就绪后 FreeInput 自动聚焦」的既有焦点流；
 * 3) z-40：压在对话区（z-20）与命令轨（z-30）之上、抽屉与 overlay（z-50）之下——
 *    卡在屏时开回想/角色抽屉，抽屉照样盖在最上面。
 *
 * **挂在 App 根、不在 GameStage 里**（v1.8）：GameStage 与 game 屏同生共死——画廊/剧情图/设置
 * 这类整屏 overlay 返回 game 屏时它整棵被重建，卡若挂在它里面就必然「同章号再亮一次」（旧版的已知副作用）。
 * 卡要活得比 game 屏长，于是挪到 App 的常驻层，跨屏记忆放一个 ref（`{ worldId, chapterNo }` = 上次亮过的）：
 * 进 game 屏时与 ref 比对，世界线或章号变过才亮。四条行为由此同时成立——首次进 game 屏照亮（ref 尚空，
 * 首次观测算一次变化：续玩第 2 章进屏直接看见「第 2 章」，不用等下一次章号变化）；局内换章照亮；
 * **从 overlay 返回不亮**；换世界线重新武装。记忆只放组件内的 ref，不放模块级变量：单测各例互不污染，
 * 也不会被上一局的记忆压住。不在 game 屏时既不渲染也不更新 ref（`screen !== "game"`）——
 * 过场卡只属于游戏屏，overlay 上不该有它；离开时顺手收起在屏的卡，免得返回时接着播旧的那张。
 *
 * 动效降级交给 App 根的 `MotionConfig reducedMotion="user"`：
 * 系统开了「减少动态效果」时 opacity/scale 动画瞬时完成，卡片本身照常出现、照常到点退场。
 *
 * 为什么不用 AnimatePresence（本仓抽屉/整屏转场的常规手法）：它的卸载时机由退场动画（rAF）决定，
 * 假定时器推不动 → 卸载时点会飘（用例得等真帧）。这里用两个 setTimeout 把「开始淡出」与「卸载」
 * 钉死在确定时刻：章节卡是整屏遮罩，卸载时刻可预期比多半秒的淡出更重要——两种定时器风格的用例
 * 都能确定性地断言「到点已消失」。
 */
export default function ChapterCard() {
  const screen = useGameStore((s) => s.screen);
  const worldId = useGameStore((s) => s.worldId);
  const chapterNo = useGameStore((s) => s.chapterNo);
  // 跨屏记忆：上次亮过的世界线与章号（null = 还没亮过任何一次）。只在 game 屏更新，
  // 章号在制作屏期间的变化因此留到下次进 game 屏才兑现（新章的第一眼就该在游戏屏上看见）
  const seen = useRef<{ worldId: string | null; chapterNo: number } | null>(null);
  // null = 无卡在屏；存的是「本次该亮的章号」，与 store 的 chapterNo 解耦：
  // 到点卸载时若章号又变了（连过两章），旧定时器不许把新卡撤掉——先比较再清。
  const [shown, setShown] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (screen !== "game" || chapterNo < 1) {
      setShown(null); // 幂等：本来就是 null 时 React 自行 bail out，不会自激
      setLeaving(false);
      return;
    }
    const prev = seen.current;
    seen.current = { worldId, chapterNo };
    if (prev && prev.worldId === worldId && prev.chapterNo === chapterNo) return; // 同一章（如从 overlay 返回）：不重亮
    setShown(chapterNo);
    setLeaving(false);
    // 两个定时器各管一段：先开始淡出，再卸载（卸载与动画无关，假定时器也能推到）
    const fade = setTimeout(() => setLeaving(true), CHAPTER_CARD_MS - CHAPTER_CARD_FADE_MS);
    const end = setTimeout(() => setShown((cur) => (cur === chapterNo ? null : cur)), CHAPTER_CARD_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(end);
    };
  }, [screen, worldId, chapterNo]);

  if (screen !== "game" || shown === null) return null;

  return (
    <motion.div
      // key 绑章号：连过两章时换成新节点，入场动效跟着重放（同节点上只换数字会「静默换字」）
      key={shown}
      data-testid="chapter-card"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: leaving ? 0 : 1, scale: leaving ? 1.01 : 1 }}
      transition={{ duration: leaving ? CHAPTER_CARD_FADE_MS / 1000 : 0.5, ease: "easeOut" }}
      className="pointer-events-none fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-scrim-soft"
    >
      <Rule />
      <p className="text-display tracking-[.4em] [text-indent:.4em] text-ink">第 {shown} 章</p>
      <Rule />
    </motion.div>
  );
}
