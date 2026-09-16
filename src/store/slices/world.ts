// world slice（v1.6 拆分）：世界线屏（worlds）与开局/续玩入口——建新世界、读档续演、改名、导入导出。
// 还带一个纯函数 parseWorldBundle（世界线包校验，导入动作与单测共用）：它的唯一消费者在这里，
// 由 game.ts 原样再导出，组件与测试的 import 路径不变。
import { postWorldImport, postWorldUpdate, type WorldBundle } from "../../lib/acp";
import { buildResumeCommand } from "../../lib/parser";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

/**
 * 解析导入的世界线包原文（纯函数，导入动作与单测共用）。
 * 只做「敢原样回传服务端」的最小校验：JSON 能解析、format/version 对得上、world.worldId 有值；
 * 重名改名、文件写入等一律由服务端裁决（前端不替服务端预判世界 id 合法性）。
 * @param {string} text 文件原文（.world.json）
 * @returns {WorldBundle | null} 合法包；不是 JSON / 格式不符 / version 非 1 / 缺 worldId 时 null
 */
export function parseWorldBundle(text: string): WorldBundle | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const b = data as Partial<WorldBundle>;
  if (b.format !== "bunkiten-world" || b.version !== 1) return null;
  const world = b.world as { worldId?: unknown } | undefined;
  if (!world || typeof world.worldId !== "string" || !world.worldId) return null;
  return b as WorldBundle;
}

export function createWorldSlice(
  ctx: StoreContext,
): Pick<GameStore, "beginNewWorld" | "resumeWorld" | "updateWorld" | "importWorldText" | "clearWorldNotice"> {
  const { set, get } = ctx;

  return {
    beginNewWorld(worldId) {
      ctx.clearWatchdog();
      ctx.resetRunState({ worldId, worldLabel: worldId, screen: "protagonist" });
    },

    resumeWorld(entry) {
      ctx.clearWatchdog();
      ctx.resetRunState({
        worldId: entry.worldId,
        worldLabel: entry.note || entry.worldId,
        chapterNo: entry.chapterNo || 1,
        screen: "game",
      });
      get().send(buildResumeCommand(entry.worldId));
    },

    async updateWorld(p) {
      set({ worldBusy: true });
      try {
        const r = await postWorldUpdate(p);
        set({
          worldBusy: false,
          worldNotice: r.ok
            ? { kind: "ok", text: `已保存「${p.label || p.worldId}」的显示信息` }
            : { kind: "error", text: `保存失败：${r.error ?? "未知错误"}` },
        });
        return r;
      } catch (e) {
        const msg = String(e);
        set({ worldBusy: false, worldNotice: { kind: "error", text: `保存失败：${msg}` } });
        return { ok: false, error: msg };
      }
    },

    async importWorldText(text) {
      // 非法原文不进服务端：本地校验先挡（服务端也会挡，但没必要拿一次 400 当校验器）
      const bundle = parseWorldBundle(text);
      if (!bundle) {
        const r = { ok: false, error: "不是有效的世界线导出包" };
        set({ worldNotice: { kind: "error", text: `导入失败：${r.error}` } });
        return r;
      }
      set({ worldBusy: true });
      try {
        const r = await postWorldImport(bundle);
        set({
          worldBusy: false,
          worldNotice:
            r.ok && r.worldId
              ? { kind: "ok", text: `已导入世界线 ${r.worldId}` }
              : { kind: "error", text: `导入失败：${r.error ?? "未知错误"}` },
        });
        return r;
      } catch (e) {
        const msg = String(e);
        set({ worldBusy: false, worldNotice: { kind: "error", text: `导入失败：${msg}` } });
        return { ok: false, error: msg };
      }
    },

    clearWorldNotice() {
      set({ worldNotice: null });
    },
  };
}
