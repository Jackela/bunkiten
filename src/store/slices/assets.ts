// assets slice（v1.6 拆分）：画廊（assets overlay）——打开/预览、重绘（单项与顺序批量队列）、批量删除、提示位。
// 重绘的流水线本体（finishRegen/pumpRegenQueue：队列派发与收尾提示）在 context.ts——
// handleEvent 的【图|重绘】标记与 turn_end/error 都要驱动它，属跨片共享。
import { postAssetDelete } from "../../lib/acp";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

export function createAssetsSlice(
  ctx: StoreContext,
): Pick<
  GameStore,
  "openAssets" | "setAssetsPreview" | "startRegen" | "startRegenBatch" | "deleteAssets" | "clearAssetsNotice"
> {
  const { set, get } = ctx;

  return {
    openAssets() {
      // 画廊与游戏态共存：只切屏不动回合/画面状态，引擎忙时画廊内禁用重绘
      set({ screen: "assets", screenReturn: get().screen });
    },

    setAssetsPreview(a) {
      set({ assetsPreview: a });
    },

    startRegen(type, key, matchName) {
      // 单项重绘 = 只有一条的顺序队列（保持既有语义：忙时拒绝、挂起等待、标记解除）
      get().startRegenBatch([{ type, key, matchName }]);
    },

    startRegenBatch(jobs) {
      const s = get();
      if (jobs.length === 0) return;
      // 重绘走引擎回合：忙时等本轮结束再点（按钮禁用兜底，此处再挡一层 409）
      if (s.engineBusy || s.regenPending) {
        set({ regenNotice: { kind: "error", text: "引擎忙或已有重绘在跑，等这一轮结束再来" } });
        return;
      }
      set({
        regenQueue: [...jobs],
        regenTotal: jobs.length,
        regenDone: 0,
        regenFailed: [],
        regenNotice: null,
      });
      ctx.pumpRegenQueue();
    },

    async deleteAssets(files) {
      const preset = get().selected?.id ?? "";
      if (!preset || files.length === 0) return;
      set({ assetsBusy: true, assetsNotice: null });
      const failed: string[] = [];
      // 逐条删（不并发）：失败项要能按文件点名，且服务端 unlink 的顺序与玩家勾选顺序一致，日志可对
      for (const file of files) {
        const r = await postAssetDelete({ preset, file });
        if (!r.ok) failed.push(`${file}（${r.error ?? "未知错误"}）`);
      }
      const ok = files.length - failed.length;
      set({
        assetsBusy: false,
        // 收尾刷新一次清单：删掉的文件不该还留在画廊里
        assetsStamp: get().assetsStamp + 1,
        assetsNotice:
          failed.length > 0
            ? { kind: "error", text: `已删除 ${ok}/${files.length} 项，${failed.length} 项失败：${failed.join("、")}` }
            : { kind: "ok", text: `已删除 ${ok} 项素材` },
      });
    },

    clearAssetsNotice() {
      set({ assetsNotice: null });
    },
  };
}
