// nav slice（v1.6 拆分）：屏幕流与全局 overlay 的进入/返回——title 主屏、剧本选择、
// 设置屏（settings 是无状态片，动作就近放这里）、剧本体检屏（check，v1.8：只切屏 + 记返回目标）、overlay 通用返回。
// v1.7 加剧本导出包的导入（importPresetText：TitleScreen 的「导入剧本」入口；presets 的刷新也走这里，
// 与 setPresets 同一片——轮播数据只有这一个写入方族）。各动作的接口文档见 ../types.ts 的 GameStore。
import { fetchPresets, postPresetImport, type PresetBundle } from "../../lib/acp";
import { audioManager } from "../../lib/audio";
import { saveSettings, type GameSettings } from "../../lib/settings";
import type { SliceContext } from "../context";
import type { GameStore } from "../types";

/**
 * 解析导入的剧本包原文（纯函数，导入动作与单测共用）。
 * 只做「敢原样回传服务端」的最小校验：JSON 能解析、format/version 对得上、id 与 presetMd 有值；
 * 文件名安全、base64 与重名改名一律由服务端裁决（前端不替服务端预判剧本 id 合法性）。
 * @param {string} text 文件原文（.preset.json）
 * @returns {PresetBundle | null} 合法包；不是 JSON / 格式不符 / version 非 1 / 缺 id 或 presetMd 时 null
 */
export function parsePresetBundle(text: string): PresetBundle | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const b = data as Partial<PresetBundle>;
  if (b.format !== "bunkiten-preset" || b.version !== 1) return null;
  if (typeof b.id !== "string" || !b.id) return null;
  if (typeof b.presetMd !== "string" || !b.presetMd) return null;
  return b as PresetBundle;
}

export function createNavSlice(
  ctx: SliceContext<"set" | "get" | "clearWatchdog" | "resetRunState">,
): Pick<
  GameStore,
  | "toTitle"
  | "toWorlds"
  | "selectPreset"
  | "setPresets"
  | "importPresetText"
  | "clearTitleNotice"
  | "openSettings"
  | "openCheck"
  | "updateSettings"
  | "closeOverlay"
> {
  const { set, get } = ctx;

  return {
    toTitle() {
      ctx.clearWatchdog();
      set({ screen: "title", screenReturn: null, turnStartAt: null });
    },

    toWorlds() {
      // 只切屏：世界已由 POST /api/worlds 建在服务端，牌面（selected/答题/worldId）必须原样留着，
      // 所以这里不借道 selectPreset / resetRunState（它们会把选卡与答题清成初始态）
      ctx.clearWatchdog();
      set({ screen: "worlds", screenReturn: null });
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

    async importPresetText(text) {
      // 非法原文不进服务端：本地校验先挡（服务端也会挡，但没必要拿一次 400 当校验器）
      const bundle = parsePresetBundle(text);
      if (!bundle) {
        set({ titleNotice: { kind: "error", text: "导入失败：不是有效的剧本导出包" } });
        return { ok: false, error: "不是有效的剧本导出包" };
      }
      try {
        const r = await postPresetImport(bundle);
        if (!r.ok) {
          set({ titleNotice: { kind: "error", text: `导入失败：${r.error ?? "未知错误"}` } });
          return r;
        }
        // 成功：重取轮播（新卡带立刻可见），提示带实际落地的 id（可能已被服务端重名改名）
        try {
          const resp = await fetchPresets();
          set({ presets: resp.presets });
        } catch {
          // 刷新失败不影响导入结果：提示照给，玩家回标题屏会再拉一次
        }
        set({ titleNotice: { kind: "ok", text: `已导入为 ${r.id ?? bundle.id}` } });
        return r;
      } catch (e) {
        const msg = String(e);
        set({ titleNotice: { kind: "error", text: `导入失败：${msg}` } });
        return { ok: false, error: msg };
      }
    },

    clearTitleNotice() {
      set({ titleNotice: null });
    },

    openSettings() {
      // 同 overlay 模式：只切屏不动回合、不动画面；返回目标交给 closeOverlay（Esc 链在 App）
      set({ screen: "settings", screenReturn: get().screen });
    },

    openCheck(preset) {
      // 剧本体检是只读的诊断片：只切屏 + 记返回目标，不动回合/画面状态（同 openSettings）。
      // 从标题屏进来时把当前中央卡落进 selected——那时它可能还是 null 或上一局的剧本，
      // 而体检的对象必须是玩家看着的那张卡（selectPreset 那条路要进世界线屏并重置运行态，不能用）
      set({ screen: "check", screenReturn: get().screen, ...(preset ? { selected: preset } : {}) });
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
