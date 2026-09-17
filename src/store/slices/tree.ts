// tree slice（v1.6 拆分）：剧情图 overlay（剧情：编辑）——取树/编辑指令（含排队）、快照回退、分叉与切换世界线。
// 分叉与回退都是 server 侧文件操作，不占引擎回合；只有编辑指令与回退后的续档指令走 prompt 通路。
import { postWorld, postWorldRestore, type WorldAction } from "../../lib/acp";
import { buildResumeCommand, buildTreeEditCommand } from "../../lib/parser";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

export function createTreeSlice(
  ctx: StoreContext,
): Pick<
  GameStore,
  | "openTree"
  | "refreshTree"
  | "setTreeNotice"
  | "setTreeFocus"
  | "sendTreeEdit"
  | "forkAt"
  | "restoreSnapshot"
  | "retryResync"
  | "switchToFork"
> {
  const { set, get } = ctx;

  return {
    openTree() {
      // 与画廊同构的 overlay：只切屏不动回合；游戏内与制作中屏都能进
      set({ screen: "tree", screenReturn: get().screen, treeNotice: null, treeFocus: null, forkResult: null });
    },

    refreshTree() {
      set({ treeStamp: get().treeStamp + 1 });
    },

    setTreeNotice(n) {
      set({ treeNotice: n });
    },

    setTreeFocus(nodeId) {
      set({ treeFocus: nodeId });
    },

    sendTreeEdit(text) {
      const t = text.trim();
      if (!t) return;
      const cmd = buildTreeEditCommand(t);
      if (get().engineBusy) {
        // 同创作屏排队模式：回合结束自动补发（见 handleEvent turn_end）
        set({ pendingTreeMessage: cmd, treeNotice: "引擎忙，已排队，就绪后自动发送" });
        return;
      }
      set({ treeAsk: true, treeNotice: null });
      get().send(cmd);
    },

    forkAt(nodeId, seq) {
      const s = get();
      if (!s.worldId || !nodeId) return;
      // 分叉是 server 侧的文件操作（复制 + 回退 + fork.md），不占用引擎回合，也不推演内容。
      // 带 seq = 精确分叉（以该快照的三文件建新世界）；不带 = 旧世界的兼容路径，载荷与 v1.5 逐字一致
      const body: WorldAction =
        seq === undefined ? { action: "fork", worldId: s.worldId, nodeId } : { action: "fork", worldId: s.worldId, nodeId, seq };
      set({ treeNotice: "正在分叉…" });
      postWorld(body)
        .then((r) => {
          if (!r.ok || !r.worldId) {
            set({ treeNotice: `分叉失败：${r.error ?? "未知错误"}` });
            return;
          }
          const precise = seq === undefined ? "" : `（精确到快照 #${seq}）`;
          set({
            forkResult: { worldId: r.worldId, nodeId },
            treeNotice: `已创建世界线 ${r.worldId}（分叉自 ${s.worldId} @ ${nodeId}${precise}）· 分叉不推演，切换后从该节点续演`,
            treeStamp: get().treeStamp + 1,
          });
        })
        .catch((e: unknown) => set({ treeNotice: `分叉失败：${String(e)}` }));
    },

    async restoreSnapshot(seq) {
      const s = get();
      if (!s.worldId) return { ok: false, error: "没有世界线" };
      if (s.engineBusy || s.pendingTreeMessage) {
        // 回退覆盖的正是引擎此刻可能正在写的三份文件：忙就等这一轮
        const error = "引擎忙，等这一轮回完再回退";
        set({ treeNotice: error });
        return { ok: false, error };
      }
      set({ treeNotice: `正在回退到快照 #${seq}…` });
      try {
        const r = await postWorldRestore({ worldId: s.worldId, seq });
        if (!r.ok) {
          set({ treeNotice: `回退失败：${r.error ?? "未知错误"}` });
          return r;
        }
        const backup = r.backupSeq === undefined ? "" : `；回退前状态已备份为快照 #${r.backupSeq}`;
        // treeStamp 自增 = 图屏重取树与快照索引（回退后节点状态与「最早快照」映射都会变）
        set({
          // 三态之一「重同步中」：成功/失败的后两态由 gameplay slice 在 turn_end / error 里改写
          treeNotice: `已回退到快照 #${seq}${backup}，正在让引擎重读档…`,
          treeStamp: get().treeStamp + 1,
          // 非破坏式分割线：旧幕一条不删，渲染层把标记之前的幕置灰——玩家侧历史与档不再各说各话
          history: [...s.history, { kind: "rollback", seq, at: Date.now() }],
          // 会话内内存态（不持久化，理由见 types.ts）：该回合 turn_end 成功即清除，失败则亮「再同步」；
          // resyncing 认领「本轮发送的正是重同步指令」——只有它收尾的 turn_end 才算完成重同步（见 gameplay send）
          pendingResync: { worldId: s.worldId, seq },
          resyncFailed: false,
          resyncing: true,
        });
        // 磁盘上的三份文件只是「档」，引擎会话里还留着回退点之后的「未来」记忆：
        // 三文件覆盖完必须让它按续档语义重新读 state/summary 并恢复画面（会重发【图】标记），
        // 否则下一回合仍按旧记忆往下演，回退等于白做。走与 sendTreeEdit 同一条 prompt 通路，
        // 不另开网络旁路；发送失败（含抢占窗口的 409）由 send 的既有错误路径置 resyncFailed。
        get().send(buildResumeCommand(s.worldId));
        return r;
      } catch (e) {
        const error = String(e);
        set({ treeNotice: `回退失败：${error}` });
        return { ok: false, error };
      }
    },

    retryResync() {
      const s = get();
      if (!s.pendingResync || !s.resyncFailed) return;
      if (s.engineBusy) return; // 上一轮还没收尾：等它落定（失败路径会把 resyncFailed 置回）
      // 走正常 send 流程：成功由 turn_end 清徽章，失败由错误路径回到本入口；resyncing 同 restoreSnapshot 置位
      set({ resyncFailed: false, resyncing: true, treeNotice: "正在让引擎重读档…" });
      get().send(buildResumeCommand(s.pendingResync.worldId));
    },

    switchToFork() {
      const s = get();
      const f = s.forkResult;
      if (!f) return;
      if (s.engineBusy) {
        set({ treeNotice: "引擎忙，等这一轮结束再切换" });
        return;
      }
      s.closeOverlay();
      get().resumeWorld({ worldId: f.worldId, chapterNo: s.chapterNo, note: `分叉自 ${s.worldId} @ ${f.nodeId}` });
    },
  };
}
