// tree slice（v1.6 拆分）：剧情图 overlay（剧情：编辑）——取树/编辑指令（含排队）、快照回退、分叉与切换世界线。
// v1.7 起「重演这一幕」（rerollTurn）也住这里：与剧情图原地回退共享同一套「restore + 分割线 + 重同步」时序；
// v1.13 起同一内核也服务树屏的「回到这一幕并重演」（rerollAt）、输入随快照条目落盘（docs/adr/0023）。
// 分叉与回退都是 server 侧文件操作，不占引擎回合；只有编辑指令与回退后的续档指令走 prompt 通路。
// v1.8：玩家可见文案去引擎口吻（「快照 #N」→「第 N 幕」、排队/忙碌走「忙碌中」、回退成功说「已备份」）；
//       分叉不再往世界线备注里塞「分叉自 <裸 id> @ <节点>」（note 留空，血缘由徽标交代）。
import {
  fetchHistory,
  fetchSnapshot,
  postWorld,
  postWorldRestore,
  type WorldAction,
  type WorldPostResult,
  type WorldSnapshotMeta,
} from "../../lib/acp";
import { buildResumeCommand, buildTreeEditCommand } from "../../lib/parser";
import { prevTurnSnapshotSeq } from "../../lib/replay";
import type { SliceContext } from "../context";
import type { GameStore, HistoryRollbackMark } from "../types";

/** 重演解析的失败码：两个入口各自映射成玩家话术（见 REPLAY_FAIL_TEXT） */
type ReplayFailure = "no-act" | "no-target" | "no-input";
/** resolveReplay 的结果（成功带齐回退点与要重发的输入） */
type ReplayPlan = { ok: true; targetSeq: number; prompt: string } | { ok: false; reason: ReplayFailure };

/** 重演三级降级 → 玩家话术（「回合/快照」等内部词不上屏；旧档与续玩同文案——客户端无法也不为此再加字段分辨） */
const REPLAY_FAIL_TEXT: Record<ReplayFailure, string> = {
  "no-act": "无法重演：找不到这一幕的存档点",
  "no-target": "无法重演：这是第一幕，没有可回退的存档点",
  "no-input": "无法重演：这一档没有留下当时的输入",
};

/**
 * 游戏屏回看目标幕的上限（条）：最新一条 turn 可能是空的续玩条目（刷新/重启后的「继续世界线」、
 * 回退后的重同步都会落这样一条），要往回找最近一条带玩家输入的那一幕。回看的每一步 = 一次本地单条查询，
 * 现实里 1–2 步；上限只兜「连着回退多次又没演过一幕」的极端链，超出就给降级提示（不无限回看）。
 */
const REPLAY_PROBE_MAX = 8;

export function createTreeSlice(
  ctx: SliceContext<"set" | "get">,
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
  | "rerollAt"
  | "retryResync"
  | "switchToFork"
> {
  const { set, get } = ctx;

  /**
   * 「restore + 分割线 + 重同步」的共用内核（restoreSnapshot 图屏回退与 rerollTurn 重演同一时序，不复制粘贴）：
   * POST restore（server 先写 kind:"backup" 快照再覆盖三文件）→ history 追加非破坏式分割线（reason 区分文案）
   * → 置 pendingResync/resyncing → 补发续档指令让引擎重读档。提示文案由调用方经 notify 落到各自的
   * 提示位（图屏回退写 treeNotice，重演写 status）。
   * @param {number} seq 目标快照序号
   * @param {{reason: "restore" | "reroll", rerollPrompt?: string, busyError: string, startText: string,
   *   failPrefix: string, notify: (text: string) => void}} opts 重演多带 rerollPrompt（重同步成功后排队补发）
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
      const backup = r.backupSeq === undefined ? "" : "；回退前的进度已备份";
      const mark: HistoryRollbackMark =
        opts.reason === "reroll"
          ? { kind: "rollback", seq, at: Date.now(), reason: "reroll" }
          : { kind: "rollback", seq, at: Date.now() };
      // treeStamp 自增 = 图屏重取树与快照索引（回退后节点状态与「最早快照」映射都会变；重演同理会变）
      set({
        // 三态之一「重同步中」：成功/失败的后两态由 gameplay slice 在 turn_end / error 里改写
        treeNotice: `已回到第 ${seq} 幕${backup}，正在同步进度…`,
        treeStamp: get().treeStamp + 1,
        // 非破坏式分割线：旧幕一条不删，渲染层把标记之前的幕置灰——玩家侧历史与档不再各说各话
        history: [...get().history, mark],
        // 会话内内存态（不持久化，理由见 types.ts）：该回合 turn_end 成功即清除，失败则亮「再同步」；
        // resyncing 认领「本轮发送的正是重同步指令」——只有它收尾的 turn_end 才算完成重同步（见 gameplay send）
        pendingResync: { worldId: s.worldId, seq },
        resyncFailed: false,
        resyncing: true,
        // 重演专用：重同步回合成功收尾后由 gameplay 的排队跟进补发（resync 失败则保留到再同步成功）
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

  /**
   * 重演的数据解析（rerollTurn / rerollAt 共用，v1.13 起全部取自盘上）：目标幕（act）→ 回退点
   * （它之前最近的一条 turn 条目）→ 该幕的玩家输入（条目 prompt）。输入与它产生的状态同条目绑定，
   * 去重 / backup / 续玩的错位不对齐也不再影响它；刷新与重启后照样成立（旧办法靠内存账本
   * lastTurnPrompt，刷新即失效——见 docs/adr/0023）。
   * @param {string} worldId 入口时的世界（调用方在 await 后复查，换了就作废）
   * @param {number} [actSeq] 目标幕的快照序号；缺省 = 最近一条**带玩家输入**的 turn 条目（游戏屏「重演这一幕」：
   *   最新一条常是空的续玩条目——刷新/重启后的继续世界线就落一条，玩家要重演的显然是最后玩过的那一幕）
   * @returns {Promise<ReplayPlan>} 失败码由入口映射成玩家话术
   */
  const resolveReplay = async (worldId: string, actSeq?: number): Promise<ReplayPlan> => {
    const h = await fetchHistory(worldId);
    const turns = h.snapshots.filter((x) => x.kind === "turn");
    let act: WorldSnapshotMeta | undefined;
    let prompt = "";
    if (actSeq === undefined) {
      // 从最新往回找第一条有玩家输入的（列表刻意不带 prompt，只能逐条单条探；见 REPLAY_PROBE_MAX）
      const from = turns.length - 1;
      for (let i = from; i >= 0 && from - i < REPLAY_PROBE_MAX; i--) {
        const single = await fetchSnapshot(worldId, turns[i].seq);
        if (single.prompt) {
          act = turns[i];
          prompt = single.prompt;
          break;
        }
      }
    } else {
      act = turns.find((t) => t.seq === actSeq);
      if (act) prompt = (await fetchSnapshot(worldId, act.seq)).prompt; // 单条才带 prompt（列表形状刻意不带）
    }
    if (!act) {
      // 给了 seq 却找不到 = 该序号不是 turn 条目（backup / 已消失）；没给 seq = 回看窗口里全是空输入
      return { ok: false, reason: actSeq === undefined ? "no-input" : "no-act" };
    }
    const targetSeq = prevTurnSnapshotSeq(h.snapshots, act.seq);
    if (targetSeq === null) return { ok: false, reason: "no-target" }; // 本世界第一幕：无处可退
    if (!prompt) return { ok: false, reason: "no-input" }; // 续玩条目或旧档：没有留下当时的输入
    return { ok: true, targetSeq, prompt };
  };

  /**
   * 重演的共用时序（两个入口只差目标幕与提示位）：解析 → 复用 restore + 重同步 + 排队重发那条老路，
   * 失败与忙碌都经 notify 出声，不静默。
   * @param {number} [actSeq] 目标幕的序号；缺省 = 最新一条 turn（游戏屏）
   * @param {(text: string) => void} notify 提示位（游戏屏写 status、图屏写 treeNotice）
   */
  const rerollCore = async (actSeq: number | undefined, notify: (text: string) => void): Promise<void> => {
    const s0 = get();
    if (!s0.worldId) return;
    // 重演要先退档：作废自动前进倒计时（fetch + restore 的毫秒窗内它不该替玩家再掷一骰抢发）
    get().cancelAutoAdvance();
    const worldId = s0.worldId; // 记住入口时的世界：await 期间重开/换世界，旧世界的档不许动
    if (s0.engineBusy || s0.pendingTreeMessage) {
      // 与回退同一纪律：重演要覆盖的正是引擎此刻可能正在写的三份文件
      notify("引擎忙，等这一轮回完再重演");
      return;
    }
    notify("正在重演这一幕…");
    let plan: ReplayPlan;
    try {
      plan = await resolveReplay(worldId, actSeq);
    } catch (e) {
      notify(`重演失败：${String(e)}`);
      return;
    }
    if (get().worldId !== worldId) return; // await 期间重开/换世界：静默中止，别动新世界的档
    if (!plan.ok) {
      notify(REPLAY_FAIL_TEXT[plan.reason]);
      return;
    }
    // 引擎忙的复查在内核里（fetch 期间可能起跑新回合）；输入已取好，重同步回合成功收尾后由
    // gameplay 的排队跟进补发，这里只负责把档退回去
    await restoreAndResync(plan.targetSeq, {
      reason: "reroll",
      rerollPrompt: plan.prompt,
      busyError: "忙碌中，等这一幕结束再重演",
      startText: "正在重演这一幕…",
      failPrefix: "重演失败",
      notify,
    });
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

    sendTreeEdit(text, nodeId) {
      const cmd = buildTreeEditCommand(text, nodeId);
      if (!cmd) return;
      if (get().engineBusy) {
        // 同创作屏排队模式：回合结束自动补发（见 handleEvent turn_end）
        set({ pendingTreeMessage: cmd, treeNotice: "忙碌中，就绪后自动发送" });
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
        seq === undefined
          ? { action: "fork", worldId: s.worldId, nodeId }
          : { action: "fork", worldId: s.worldId, nodeId, seq };
      set({ treeNotice: "正在分叉…" });
      postWorld(body)
        .then((r) => {
          if (!r.ok || !r.worldId) {
            set({ treeNotice: `分叉失败：${r.error ?? "未知错误"}` });
            return;
          }
          set({
            forkResult: { worldId: r.worldId, nodeId },
            // 新世界线的 id 与节点号都不上屏（裸 id 只活在目录名与索引里）：血缘看徽标，位置看树本身
            treeNotice: "已创建新的世界线 · 从这一幕继续",
            treeStamp: get().treeStamp + 1,
          });
        })
        .catch((e: unknown) => set({ treeNotice: `分叉失败：${String(e)}` }));
    },

    async restoreSnapshot(seq) {
      // 图屏原地回退：提示走 treeNotice（三态文案见 gameplay turn_end / error）
      return restoreAndResync(seq, {
        reason: "restore",
        busyError: "忙碌中，等这一幕结束再回退",
        startText: `正在回到第 ${seq} 幕…`,
        failPrefix: "回退失败",
        notify: (t) => set({ treeNotice: t }),
      });
    },

    async rerollTurn() {
      // 游戏屏「重演这一幕」：目标幕 = 最新一条 turn 条目，提示落顶栏状态位
      return rerollCore(undefined, (t) => set({ status: t }));
    },

    async rerollAt(seq) {
      // 图屏「回到这一幕并重演」：目标幕由该存档点给定，提示落图屏提示条
      return rerollCore(seq, (t) => set({ treeNotice: t }));
    },

    retryResync() {
      const s = get();
      if (!s.pendingResync || !s.resyncFailed) return;
      if (s.engineBusy) return; // 上一轮还没收尾：等它落定（失败路径会把 resyncFailed 置回）
      // 走正常 send 流程：成功由 turn_end 清徽章，失败由错误路径回到本入口；resyncing 同 restoreSnapshot 置位
      set({ resyncFailed: false, resyncing: true, treeNotice: "正在同步进度…" });
      get().send(buildResumeCommand(s.pendingResync.worldId));
    },

    switchToFork() {
      const s = get();
      const f = s.forkResult;
      if (!f) return;
      if (s.engineBusy) {
        set({ treeNotice: "忙碌中，等这一幕结束再切换" });
        return;
      }
      s.closeOverlay();
      // note 留空：分叉血缘由世界线屏的徽标（forkedFrom）交代，绝不把「分叉自 <裸 id> @ <节点>」写进备注。
      // label 同样留空：新世界刚由 forkWorld 建出（索引里没有显示名），父线的显示名不是它的名字，
      // 前端不替玩家猜——玩家在世界线屏行内改名，或此时屏上退化显示「本世界线」。
      get().resumeWorld({ worldId: f.worldId, chapterNo: s.chapterNo, note: "", label: "" });
    },
  };
}
