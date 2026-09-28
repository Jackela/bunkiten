// panels slice（v1.14）：两个本地面板的数据与「回想接磁盘」的分页——
// 元命令本地化：`/help`、`/recap` 从前端发指令给引擎改成纯前端合成，**零引擎回合**（面板本体在 D 泳道渲染）。
// 回想的分页数据源是 `state/worlds/<worldId>/logs/NNNN.json`（append-only、不进导出包）：
// 内存 history 只活本会话，磁盘这份才跨刷新。
import { fetchHistory, fetchLogs, fetchSnapshot, fetchState, type LogEntry } from "../../lib/acp";
import type { SliceContext } from "../context";
import type { DiskHistory, GameStore, RecapData, RecapEntry } from "../types";

/** 回想一页的条数：日志条目不大，一页 50 条既够翻也够快 */
const DISK_HISTORY_PAGE = 50;

/** 前情提要取最近几条回合日志（「提要」不是流水账） */
const RECAP_LOG_COUNT = 5;

/** 提要条目的正文上限：压掉换行再掐长，面板一行读得完 */
const RECAP_SNIPPET_MAX = 120;

/** 压成单行并掐长（提要条目用；空串原样返回） */
function snippet(text: string): string {
  const one = (text ?? "").replace(/\s*\n+\s*/g, " ").trim();
  return one.length > RECAP_SNIPPET_MAX ? `${one.slice(0, RECAP_SNIPPET_MAX)}…` : one;
}

/** 一条回合日志 → 提要条目：玩家的输入（有就带）+ 引擎整轮回复的摘要 */
function recapEntryOf(e: LogEntry): RecapEntry {
  const parts = [snippet(e.prompt), snippet(e.text)].filter(Boolean);
  return { n: e.seq, t: parts.join(" — ") };
}

/** 空的磁盘历史分页态（初值与换局清零共用一处） */
export function emptyDiskHistory(): DiskHistory {
  return { entries: [], nextBefore: null, loading: false, error: null, loadedOnce: false };
}

export function createPanelsSlice(
  ctx: SliceContext<"set" | "get">,
): Pick<GameStore, "openHelp" | "closeHelp" | "openRecap" | "closeRecap" | "loadHistoryPage"> {
  const { set, get } = ctx;

  return {
    openHelp() {
      // 纯前端开关：帮助内容（命令轨说明/快捷键/数据位置）全部本地静态，不占引擎回合
      set({ helpOpen: true });
    },

    closeHelp() {
      set({ helpOpen: false });
    },

    async openRecap() {
      // 先落「取数中」的空壳（面板立刻出来、显示加载态），再补数据
      set({
        recapOpen: true,
        recapData: { loaded: false, error: null, chapterNo: null, time: null, scene: null, entries: [] },
      });
      const worldId = get().worldId;
      if (!worldId) {
        // 还没有世界线（标题屏进前情）：不算错，给空提要——面板自己说「还没有可回顾的内容」
        set({
          recapData: { loaded: true, error: null, chapterNo: get().chapterNo, time: null, scene: null, entries: [] },
        });
        return;
      }
      // chapterNo 先用客户端当前章号兜底，拿到快照索引后以最后一条 turn 条目的章号为准
      const data: RecapData = {
        loaded: true,
        error: null,
        chapterNo: get().chapterNo,
        time: null,
        scene: null,
        entries: [],
      };
      try {
        const logs = await fetchLogs(worldId, { limit: RECAP_LOG_COUNT });
        data.entries = logs.entries.map(recapEntryOf);
      } catch (e) {
        // 日志是提要给不出内容的主因：报错但照给其余能拿到的字段
        data.error = `回顾失败：${String(e)}`;
      }
      try {
        const st = await fetchState(worldId);
        data.time = st.status.time;
        data.scene = st.status.scene;
      } catch {
        // 时间/地点取不到不是致命（state.md 还没写过）：提要照给，面板留白
      }
      try {
        const h = await fetchHistory(worldId);
        const last = h.snapshots.filter((s) => s.kind === "turn").at(-1);
        if (last) {
          if (last.chapterNo !== null) data.chapterNo = last.chapterNo;
          try {
            // 摘要取不到就降级为「不带 summary」（提要其余部分照给）
            const snap = await fetchSnapshot(worldId, last.seq);
            const summary = (snap.files.summary ?? "").trim();
            if (summary) data.entries = [{ n: null, t: summary }, ...data.entries];
          } catch {
            /* 摘要降级 */
          }
        }
      } catch {
        // 快照索引取不到：chapterNo 用客户端兜底值
      }
      if (get().worldId !== worldId) return; // await 期间换世界：这份提要作废
      set({ recapData: data });
    },

    closeRecap() {
      set({ recapOpen: false });
    },

    async loadHistoryPage() {
      const s = get();
      if (s.diskHistory.loading) return;
      const worldId = s.worldId;
      if (!worldId) return;
      // 已翻到最早（loadedOnce 且没有更早的页）时，这一次调用转为**重拉最新一页**：
      // logs 是 append-only，新回合会往尾部追加，摘要是活的；已在手上的条目按 seq 去重后合并
      const atEnd = s.diskHistory.loadedOnce && s.diskHistory.nextBefore === null;
      const before = atEnd ? undefined : (s.diskHistory.nextBefore ?? undefined);
      set({ diskHistory: { ...s.diskHistory, loading: true, error: null } });
      try {
        const r = await fetchLogs(worldId, { before, limit: DISK_HISTORY_PAGE });
        if (get().worldId !== worldId) return; // 期间换世界：旧世界的日志不许写进新世界
        const cur = get().diskHistory;
        if (atEnd) {
          const seen = new Set(cur.entries.map((e) => e.seq));
          set({
            diskHistory: {
              entries: [...r.entries.filter((e) => !seen.has(e.seq)), ...cur.entries],
              nextBefore: null,
              loading: false,
              error: null,
              loadedOnce: true,
            },
          });
          return;
        }
        set({
          diskHistory: {
            entries: [...cur.entries, ...r.entries],
            nextBefore: r.nextBefore,
            loading: false,
            error: null,
            loadedOnce: true,
          },
        });
      } catch (e) {
        if (get().worldId !== worldId) return;
        set({ diskHistory: { ...get().diskHistory, loading: false, error: String(e), loadedOnce: true } });
      }
    },
  };
}
