// crafting slice（v1.6 拆分）：开局入口与制作中屏（crafting）的玩家侧动作——开局卡作答、发开局指令、跳过剩余项。
// 制作流水线本体（sendStart/runNextPending/beginPlanning/advancePreload/onEngineError）在 context.ts：
// 它同时被 handleEvent（turn_end/error）驱动，属跨片共享的时序逻辑，留在组装侧原样复用。
import { buildCustomOpening, buildQuickOpening, parseCardLines, type CardAnswer } from "../../lib/parser";
import type { Preset } from "../../lib/acp";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

/** 「选 1-2」类问题的最大选择数 */
const MULTI_MAX = 2;

/** 把已选答案按 card 问题顺序整理成开局指令用的作答列表 */
function cardAnswersOf(preset: Preset, answers: Record<string, string[]>): CardAnswer[] {
  return parseCardLines(preset.protagonist_card)
    .map((q) => ({ shortName: q.shortName, values: answers[q.shortName] ?? [] }))
    .filter((a) => a.values.length > 0);
}

export function createCraftingSlice(
  ctx: StoreContext,
): Pick<GameStore, "toggleCardAnswer" | "startGame" | "skipPreload"> {
  const { set, get } = ctx;

  return {
    toggleCardAnswer(shortName, option, multi) {
      const cur = get().cardAnswers[shortName] ?? [];
      let next: string[];
      if (!multi) {
        next = cur[0] === option ? [] : [option];
      } else if (cur.includes(option)) {
        next = cur.filter((v) => v !== option);
      } else {
        // 「选 1-2」：超过上限时挤掉最早的选择
        next = [...cur, option].slice(-MULTI_MAX);
      }
      set({ cardAnswers: { ...get().cardAnswers, [shortName]: next } });
    },

    startGame(quick, preload) {
      const s = get();
      if (!s.selected) return;
      // 新世界线由世界线屏分配；缺省 main 兜底（未选世界/异常路径引擎按 main 处理）
      const worldId = s.worldId ?? "main";
      const prompt = quick
        ? buildQuickOpening(s.selected.title, preload, worldId)
        : buildCustomOpening(s.selected.title, cardAnswersOf(s.selected, s.cardAnswers), preload, worldId);
      ctx.resetRunState({
        screen: preload ? "crafting" : "game",
        // 制作队列由第 1 章规划回合的制作清单构建，开局不预填槽位
        preloadPhase: preload ? "init" : "finished",
        engineBusy: true,
        // 开局 = 新世界的第一个回合：快照数确定为 0（beginNewWorld 置的 0 会被这里的 resetRunState 清掉）。
        // 重掷入口因此在首回合不出现；首个回合收尾后由 turn_end 的按需补拉把真实数（0/1）写回来。
        turnSnapshots: 0,
      });
      if (preload) ctx.armWatchdog();
      get().send(prompt);
    },

    /** 制作中屏：跳过剩余项立即开演；引擎正忙时等本回合结束自动接上 */
    skipPreload() {
      const s = get();
      if (s.screen !== "crafting" || s.preloadPhase === "starting" || s.preloadPhase === "finished") return;
      if (s.preloadPhase === "init" || s.preloadPhase === "planning") {
        // 待命/规划中跳过：队列还没建，直接（或待本回合结束后）「开演。」
        if (!s.engineBusy) {
          ctx.sendStart();
        } else {
          set({ skipRequested: true });
        }
        return;
      }
      set({
        preload: s.preload.map((i) => (i.state === "pending" || i.state === "running" ? { ...i, state: "skipped" } : i)),
      });
      if (!s.engineBusy) {
        // 空闲：直接推进（已无 pending → 发「开演。」）
        ctx.runNextPending();
      }
    },
  };
}
