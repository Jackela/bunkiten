// gameplay slice（v1.6 拆分）：游戏屏的回合与选项——发指令（含 409/异常的错误路径）、SSE 事件分发（handleEvent）、
// 抽屉/打字完成标记、自动前进的玩家侧动作（倒计时本体在 context.ts，与 fireAutoAdvance 同一闭包域）。
//
// handleEvent 是整条协议链路的汇聚点（段过滤/标记/选项/章标记/排队补发），它**没有**被拆开：
// 内部时序（先 applyMarkers → finishRegen → 落 finalText → pumpRegenQueue → 创作/图屏补发 → 章标记）
// 是行为契约的一部分，逐字保留在同一个函数里；它引用的流水线函数全部来自 ctx。
import { audioManager } from "../../lib/audio";
import { fetchPresets, postPrompt } from "../../lib/acp";
import {
  cleanForHistory,
  finalMarkers,
  isProtocolLine,
  parseChapterMark,
  parseOptions,
  scanMarkers,
  segStatusLabel,
} from "../../lib/parser";
import { nextPortraitOnExpression } from "../portrait";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

export function createGameplaySlice(
  ctx: StoreContext,
): Pick<GameStore, "send" | "toggleDrawer" | "setTypingDone" | "armAutoAdvance" | "cancelAutoAdvance" | "handleEvent"> {
  const { set, get } = ctx;

  return {
    send(text) {
      const t = text.trim();
      if (!t) return;
      // 手选/自由输入即接管：倒计时作废（否则刚发出去的回合结束前倒计时会再补一条 409）
      ctx.clearAutoAdvanceTimer();
      set({
        options: null,
        typingDone: false,
        autoAdvanceDeadline: null,
        status: "引擎演绎中…",
        awaitCommand: t === "/new-game" || t === "/presets" ? t : null,
      });
      postPrompt(t)
        .then((r) => {
          // 回合没发出去（409 等）就不会有 turn 事件，engineBusy 需复位供制作中屏推进
          if (!r.ok) {
            set({ status: `出错：${r.error}`, engineBusy: false, turnStartAt: null });
            // 挂起中的画廊重绘没有对应回合了：记为未确认，解除挂起让按钮恢复并接队列下一条
            ctx.finishRegen(false);
          }
        })
        .catch((e: unknown) => {
          set({ status: `出错：${String(e)}`, engineBusy: false, turnStartAt: null });
          ctx.finishRegen(false);
        });
    },

    toggleDrawer() {
      set({ drawerOpen: !get().drawerOpen });
    },

    setTypingDone(done) {
      if (get().typingDone !== done) set({ typingDone: done });
    },

    armAutoAdvance() {
      ctx.armAutoAdvance();
    },

    cancelAutoAdvance() {
      ctx.cancelAutoAdvance();
    },

    handleEvent(event) {
      const s = get();
      switch (event.type) {
        case "turn_start": {
          set({ segs: { 0: "" }, curSeg: 0, engineBusy: true, turnStartAt: Date.now() });
          ctx.resetTurnState(s.turnKey + 1);
          break;
        }
        case "seg": {
          if (event.seg > s.curSeg) {
            set({
              curSeg: event.seg,
              // 规划中引擎的写树工具调用会触发段切换，文案保持「撰写章节大纲…」不被通用状态覆盖
              status: s.preloadPhase === "planning" ? "撰写章节大纲…" : segStatusLabel(event.label),
            });
            ctx.resetTurnState(s.turnKey + 1);
          }
          break;
        }
        case "chunk": {
          const segs = { ...s.segs, [event.seg]: (s.segs[event.seg] ?? "") + event.text };
          set({ segs, received: segs[event.seg] });
          ctx.applyMarkers(scanMarkers(segs[event.seg]), true);
          break;
        }
        case "expression": {
          // 【立绘】表情切换：差分素材未生成（404）时由 PortraitLayer 回退基础图
          set({ portrait: nextPortraitOnExpression(s.portrait, event.character, event.variant, s.selected?.id ?? "") });
          break;
        }
        case "presetAdded": {
          // 【新剧本】入轮播：刷新 presets（TitleScreen 读 store.presets），创作屏转成功态
          set({ creationResult: event.id, assembling: false, assemblyStalled: false });
          fetchPresets()
            .then((r) => set({ presets: r.presets }))
            .catch(() => {
              // 刷新失败不打断成功态；回 title 时 TitleScreen 挂载会重新拉取
            });
          break;
        }
        case "treeEdited": {
          // 【树】协议行：引擎已静默写回剧情树——图屏据此重取（编辑回合的可见摘要随 turn_end 落 treeNotice）
          set({ treeStamp: s.treeStamp + 1, ...(event.note ? { treeNotice: event.note } : {}) });
          break;
        }
        case "audio": {
          // 【曲】/【环境】/【音效】演出指令（v1.6）：交给 AudioManager 单例；文件缺失静默，
          // 与画面/回合状态完全解耦（音频永远不该影响剧情推进，所以这里不写任何 store 字段）
          audioManager.handle({ kind: event.kind, name: event.name });
          break;
        }
        case "turn_end": {
          const finalText = s.segs[s.curSeg] ?? "";
          ctx.applyMarkers(finalMarkers(finalText), false);
          // 重绘回合结束：标记若未命中也解除挂起（文件落盘可能晚于标记，统一刷一次清单）。
          // 没收到 `|重绘` 标记 = 未确认（引擎漏标记/文件没落盘），记进 regenFailed 供收尾提示点名
          ctx.finishRegen(false);
          // 制作中阶段引擎只回确认/清单/标记，不进历史；「开演。」后的开场正文正常记录
          const craftingNoise =
            s.screen === "crafting" &&
            (s.preloadPhase === "init" || s.preloadPhase === "planning" || s.preloadPhase === "queue");
          const clean = craftingNoise || s.screen === "creation" || s.treeAsk ? "" : cleanForHistory(finalText);
          set({
            finalText,
            options: parseOptions(finalText),
            status: "就绪",
            engineBusy: false,
            turnStartAt: null,
            history: clean ? [...s.history, { n: `第 ${s.turnNo + 1} 幕`, t: clean }] : s.history,
            turnNo: clean ? s.turnNo + 1 : s.turnNo,
          });
          // 批量重绘：本轮已结束、引擎空闲，派发队列里的下一条（上面若有排队指令，pump 会让它们先发）
          ctx.pumpRegenQueue();
          if (s.screen === "creation") {
            // 创作屏：引擎整轮回复（跨段全文）过滤协议行后进对话流；协议行只驱动画面/事件
            const engineText = Object.values(s.segs)
              .join("\n")
              .split("\n")
              .filter((l) => !isProtocolLine(l))
              .join("\n")
              .trim();
            const c = get();
            set({
              ...(engineText ? { creationMessages: [...c.creationMessages, { role: "engine" as const, text: engineText }] } : {}),
              // 装配回合结束仍没有【新剧本】：置为可重试
              ...(c.assembling ? { assembling: false, assemblyStalled: true } : {}),
            });
          }
          if (s.treeAsk) {
            // 剧情图编辑回合：可见摘要进图屏提示条（不进历史），并让图屏重取树
            const visible = Object.values(s.segs)
              .join("\n")
              .split("\n")
              .filter((l) => !isProtocolLine(l))
              .join("\n")
              .trim();
            set({ treeAsk: false, treeStamp: get().treeStamp + 1, ...(visible ? { treeNotice: visible } : {}) });
          }
          // 创作屏排队消息补发（不筛屏：覆盖排队后 Esc 离屏的滞留场景；server busy 已在本事件前复位）
          const pendingMsg = get().pendingCreationMessage;
          if (pendingMsg) {
            set({ pendingCreationMessage: null });
            get().send(pendingMsg);
          }
          // 图屏排队编辑指令补发（同排队模式；treeAsk 提前置位，保证该回合不进历史）
          const pendingTree = get().pendingTreeMessage;
          if (pendingTree) {
            set({ pendingTreeMessage: null, treeAsk: true, treeNotice: null });
            get().send(pendingTree);
          }
          ctx.clearWatchdog();
          void ctx.advancePreload();
          const g = get();
          if (g.awaitCommand === "/new-game" || g.awaitCommand === "/presets") {
            set({ screen: "title", awaitCommand: null });
            break;
          }
          // 章标记（终章回合，全文可能跨段）：切制作中屏并规划下一章
          const mark = parseChapterMark(Object.values(s.segs).join("\n"));
          if (mark !== null && get().screen === "game") {
            const next = mark + 1;
            set({
              screen: "crafting",
              chapterNo: next,
              preload: [],
              skipRequested: false,
              artReady: {},
              seenMarkerKeys: new Set(),
              options: null,
              typingDone: false,
            });
            ctx.beginPlanning(next);
          }
          break;
        }
        case "error": {
          ctx.onEngineError(event.message);
          break;
        }
      }
    },
  };
}
