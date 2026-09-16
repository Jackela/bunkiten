// nav slice（v1.6 拆分）：屏幕流与全局 overlay 的进入/返回——title 主屏、剧本选择、
// 设置屏（settings 是无状态片，动作就近放这里）、overlay 通用返回。
// 各动作的接口文档（含前置/后置条件）见 ../types.ts 的 GameStore；这里只留实现所需的最小注释。
import { audioManager } from "../../lib/audio";
import { saveSettings, type GameSettings } from "../../lib/settings";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

export function createNavSlice(
  ctx: StoreContext,
): Pick<GameStore, "toTitle" | "selectPreset" | "setPresets" | "openSettings" | "updateSettings" | "closeOverlay"> {
  const { set, get } = ctx;

  return {
    toTitle() {
      ctx.clearWatchdog();
      set({ screen: "title", screenReturn: null, turnStartAt: null });
    },

    selectPreset(preset) {
      ctx.clearWatchdog();
      // v1.6：换本先换音频索引（setPreset 内部 stopAll——旧本的曲不带进新本），顺手把当前设置喂给管理器；
      // 索引是异步拉的，调用方不 await（拉失败静默 = 这个本没有音频可用；同一个本在途/已失败都不再重拉，
      // 所以反复点同一张卡既不会打断正在播的曲，也不会把 /api/audio 打成轮询）
      audioManager.applySettings(get().settings);
      void audioManager.setPreset(preset.id);
      // v1.5：选卡后先进世界线屏（继续已有世界 / 开新世界），worldId 由世界线屏落定
      ctx.resetRunState({ selected: preset, screen: "worlds", worldId: null, worldLabel: "" });
    },

    setPresets(presets) {
      set({ presets });
    },

    openSettings() {
      // 同 overlay 模式：只切屏不动回合、不动画面；返回目标交给 closeOverlay（Esc 链在 App）
      set({ screen: "settings", screenReturn: get().screen });
    },

    updateSettings(patch) {
      const next: GameSettings = { ...get().settings, ...patch };
      // 音频即时生效（音量/静音），再落盘——刷新后由 loadSettings 读回；文本速度由 DialogueBox 直接读 store
      audioManager.applySettings(next);
      saveSettings(next);
      set({ settings: next });
    },

    closeOverlay() {
      const back = get().screenReturn ?? "title";
      set({ screen: back, screenReturn: null, assetsPreview: null, creationExitPrompt: false });
    },
  };
}
