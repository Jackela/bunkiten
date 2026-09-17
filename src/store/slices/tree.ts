// tree slice（v1.6 拆分）：剧情图 overlay（剧情：编辑）——取树/编辑指令（含排队）、快照回退、分叉与切换世界线。
// v1.7 起「重掷本回合」（rerollTurn）也住这里：与剧情图原地回退共享同一套「restore + 分割线 + 重同步」时序。
// 分叉与回退都是 server 侧文件操作，不占引擎回合；只有编辑指令与回退后的续档指令走 prompt 通路。
import { fetchHistory, postWorld, postWorldRestore, type WorldAction, type WorldPostResult, type WorldSnapshotMeta } from "../../lib/acp";
import { buildResumeCommand, buildTreeEditCommand } from "../../lib/parser";
import type { StoreContext } from "../context";
import type { GameStore, HistoryRollbackMark } from "../types";

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
  | "rerollTurn"
  | "retryResync"
  | "switchToFork"
> {
  const { set, get } = ctx;

  /**
   * 「restore + 分割线 + 重同步」的共用内核（restoreSnapshot 图屏回退与 rerollTurn 重掷同一时序，不复制粘贴）：
   * POST restore（server 先写 kind:"backup" 快照再覆盖三文件）→ history 追加非破坏式分割线（reason 区分文案）
   * → 置 pendingResync/resyncing → 补发续档指令让引擎重读档。提示文案由调用方经 notify 落到各自的
   * 提示位（图屏回退写 treeNotice，重掷写 status）。
   * @param {number} seq 目标快照序号
   * @param {{reason: "restore" | "reroll", rerollPrompt?: string, busyError: string, startText: string,
   *   failPrefix: string, notify: (text: string) => void}} opts 重掷多带 rerollPrompt（重同步成功后排队补发）
   * @returns {Promise<WorldPostResult>} 失败在 error 里返回，不抛错
   */
  const restoreAndResync = async (
    seq: number,
    opts: {
      reason: "restore" | "reroll";
      rerollPrompt?: string;
      busyError: string;
      startText: string;
      failPrefix: string;
      notify: (text: string) => void;
    },
  ): Promise<WorldPostResult> => {
    const s = get();
    if (!s.worldId) return { ok: false, error: "没有世界线" };
    if (s.engineBusy || s.pendingTreeMessage) {
      // 回退覆盖的正是引擎此刻可能正在写的三份文件：忙就等这一轮
      opts.notify(opts.busyError);
      return { ok: false, error: opts.busyError };
    }
    opts.notify(opts.startText);
    try {
      const r = await postWorldRestore({ worldId: s.worldId, seq });
      if (!r.ok) {
        opts.notify(`${opts.failPrefix}：${r.error ?? "未知错误"}`);
        return r;
      }
      const backup = r.backupSeq === undefined ? "" : `；回退前状态已备份为快照 #${r.backupSeq}`;
      const mark: HistoryRollbackMark =
        opts.reason === "reroll" ? { kind: "rollback", seq, at: Date.now(), reason: "reroll" } : { kind: "rollback", seq, at: Date.now() };
      // treeStamp 自增 = 图屏重取树与快照索引（回退后节点状态与「最早快照」映射都会变；重掷同理会变）
      set({
        // 三态之一「重同步中」：成功/失败的后两态由 gameplay slice 在 turn_end / error 里改写
        treeNotice: `已回退到快照 #${seq}${backup}，正在让引擎重读档…`,
        treeStamp: get().treeStamp + 1,
        // 非破坏式分割线：旧幕一条不删，渲染层把标记之前的幕置灰——玩家侧历史与档不再各说各话
        history: [...get().history, mark],
        // 会话内内存态（不持久化，理由见 types.ts）：该回合 turn_end 成功即清除，失败则亮「再同步」；
        // resyncing 认领「本轮发送的正是重同步指令」——只有它收尾的 turn_end 才算完成重同步（见 gameplay send）
        pendingResync: { worldId: s.worldId, seq },
        resyncFailed: false,
        resyncing: true,
        // 重掷专用：重同步回合成功收尾后由 gameplay 的排队跟进补发（resync 失败则保留到再同步成功）
        ...(opts.rerollPrompt !== undefined ? { pendingRerollPrompt: opts.rerollPrompt } : {}),
      });
      // 磁盘上的三份文件只是「档」，引擎会话里还留着回退点之后的「未来」记忆：
      // 三文件覆盖完必须让它按续档语义重新读 state/summary 并恢复画面（会重发【图】标记），
      // 否则下一回合仍按旧记忆往下演，回退等于白做。走与 sendTreeEdit 同一条 prompt 通路，
      // 不另开网络旁路；发送失败（含抢占窗口的 409）由 send 的既有错误路径置 resyncFailed。
      get().send(buildResumeCommand(s.worldId));
      return r;
    } catch (e) {
      const error = String(e);
      opts.notify(`${opts.failPrefix}：${error}`);
      return { ok: false, error };
    }
  };

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
      // 图屏原地回退：提示走 treeNotice（三态文案见 gameplay turn_end / error）
      return restoreAndResync(seq, {
        reason: "restore",
        busyError: "引擎忙，等这一轮回完再回退",
        startText: `正在回退到快照 #${seq}…`,
        failPrefix: "回退失败",
        notify: (t) => set({ treeNotice: t }),
      });
    },

    async rerollTurn() {
      const s = get();
      if (!s.worldId || !s.lastTurnPrompt) return;
      // 重掷要先退档：作废自动前进倒计时（fetch + restore 的毫秒窗内它不该替玩家再掷一骰抢发）
      get().cancelAutoAdvance();
      const worldId = s.worldId; // 记住入口时的世界：await 期间重开/换世界，旧账本不许退到新世界
      const notify = (t: string) => set({ status: t });
      if (s.engineBusy || s.pendingTreeMessage) {
        // 与回退同一纪律：重掷要覆盖的正是引擎此刻可能正在写的三份文件
        notify("引擎忙，等这一轮回完再重掷");
        return;
      }
      notify("正在重掷本回合…");
      let turns: WorldSnapshotMeta[];
      try {
        const h = await fetchHistory(worldId);
        turns = h.snapshots.filter((x) => x.kind === "turn");
      } catch (e) {
        notify(`重掷失败：${String(e)}`);
        return;
      }
      if (get().worldId !== worldId) return; // await 期间重开/换世界：静默中止，别动新世界的档
      // 次新 turn 快照 = 上一回合结束态（最新那条是刚结束的本回合）；不足两条 = 本世界第一回合，无处可回
      if (turns.length < 2) {
        notify("无法重掷：本世界第一回合没有可回退的快照");
        return;
      }
      // 引擎忙的复查在内核里（fetchHistory 期间可能起跑新回合）；重发输入重读一次 lastTurnPrompt
      // （入口捕获到取快照之间若有回合收尾，定格值已更新）——重同步回合成功收尾后由 gameplay
      // 排队跟进送出，这里只负责把档退回去
      const rerollPrompt = get().lastTurnPrompt;
      if (!rerollPrompt) return;
      await restoreAndResync(turns[turns.length - 2].seq, {
        reason: "reroll",
        rerollPrompt,
        busyError: "引擎忙，等这一轮回完再重掷",
        startText: "正在重掷本回合…",
        failPrefix: "重掷失败",
        notify,
      });
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
