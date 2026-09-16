// creation slice（v1.6 拆分）：创作模式（creation overlay）——对话流、装配态、退出确认。
// 排队补发（pendingCreationMessage）在 handleEvent 的 turn_end 里；装配标记点亮在 context.applyMarkers 里。
import { BUILD_ASSEMBLE, ENTER_CREATION } from "../../lib/parser";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

export function createCreationSlice(
  ctx: StoreContext,
): Pick<
  GameStore,
  "openCreation" | "sendCreation" | "finishCreation" | "requestCreationExit" | "closeCreationExitPrompt"
> {
  const { set, get } = ctx;

  return {
    openCreation() {
      const fresh = get().screen !== "creation" && get().creationMessages.length === 0 && !get().creationResult;
      set({
        screen: "creation",
        screenReturn: get().screen,
        // 首次进入才重置创作态（从画廊往返不清空对话流）
        ...(fresh
          ? {
              creationMessages: [],
              assembling: false,
              assemblyStalled: false,
              creationCover: false,
              creationPortraits: [],
              creationResult: null,
              pendingCreationMessage: null,
              creationExitPrompt: false,
            }
          : {}),
      });
      if (fresh && !get().engineBusy) get().send(ENTER_CREATION);
    },

    sendCreation(text) {
      const t = text.trim();
      if (!t) return;
      set({ creationMessages: [...get().creationMessages, { role: "player", text: t }] });
      if (t === BUILD_ASSEMBLE) set({ assembling: true, assemblyStalled: false });
      if (get().engineBusy) {
        // 引擎回合进行中（如进入创作的首回合）：排队，回合结束自动补发，玩家气泡已先出
        set({ pendingCreationMessage: t });
        return;
      }
      get().send(t);
    },

    finishCreation() {
      set({
        screen: "title",
        screenReturn: null,
        creationMessages: [],
        assembling: false,
        assemblyStalled: false,
        creationCover: false,
        creationPortraits: [],
        creationResult: null,
        pendingCreationMessage: null,
        creationExitPrompt: false,
        turnStartAt: null,
      });
    },

    requestCreationExit() {
      const s = get();
      if (s.screen !== "creation") return;
      if (s.creationMessages.length > 0) {
        set({ creationExitPrompt: true });
      } else {
        s.closeOverlay();
      }
    },

    closeCreationExitPrompt() {
      set({ creationExitPrompt: false });
    },
  };
}
