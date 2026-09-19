import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { BUILD_ASSEMBLE, parseOptions, stripOptionsBlock } from "../lib/parser";
import { playerStatus } from "../lib/status";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 气泡进出：克制的小位移淡入 */
const BUBBLE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
} as const;

/** 对话列宽：表头带 / 对话流 / 输入区三截必须同宽（本屏不走 ShellPage 的页框，对齐靠这一处常量） */
const COL_WIDTH = "w-[min(760px,92vw)]";

/** 创作模式：与引擎共创新剧本的对话流。打磨对话 → 「开始装配」→ 逐项点亮 → 新剧本入轮播 */
export default function CreationScreen() {
  const requestCreationExit = useGameStore((s) => s.requestCreationExit);
  const closeCreationExitPrompt = useGameStore((s) => s.closeCreationExitPrompt);
  const creationExitPrompt = useGameStore((s) => s.creationExitPrompt);
  const pendingMessage = useGameStore((s) => s.pendingCreationMessage);
  const sendCreation = useGameStore((s) => s.sendCreation);
  const finishCreation = useGameStore((s) => s.finishCreation);
  const messages = useGameStore((s) => s.creationMessages);
  const assembling = useGameStore((s) => s.assembling);
  const stalled = useGameStore((s) => s.assemblyStalled);
  const coverDone = useGameStore((s) => s.creationCover);
  const portraits = useGameStore((s) => s.creationPortraits);
  const result = useGameStore((s) => s.creationResult);
  const presets = useGameStore((s) => s.presets);
  const engineBusy = useGameStore((s) => s.engineBusy);
  const status = useGameStore((s) => s.status);

  const [value, setValue] = useState("");
  const flowRef = useRef<HTMLDivElement>(null);
  /** 返回确认层本体（焦点陷阱容器：开层时焦点从输入框进到「返回」按钮——Esc 关闭链也因此在组字/打字态下仍收得到键） */
  const exitPromptRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(creationExitPrompt, exitPromptRef);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, assembling, stalled, result, pendingMessage]);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    setValue("");
    sendCreation(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法选词的 Enter 不算发送
    if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
  };

  // 新剧本标题：presets 里查不到（或标题为空）时兜底，绝不把 id/slug 摆上玩家的屏
  const resultTitle = result ? presets.find((p) => p.id === result)?.title?.trim() || "未命名剧本" : null;

  return (
    <ScreenShell className="shell-backdrop">
      {/* 创作整列（表头 + 对话流 + 输入区）一层：返回确认层打开时整块 inert——表头的「返回」、
          输入框、对话流里的选项 chip 与「开始装配」一次性全收住，Tab/点击都进不来。
          确认层是这一列的**兄弟**（在 </div> 之后、同一个 ScreenShell 里），所以它自己不在这层里，
          两个按钮照常可聚焦、焦点陷阱照常把焦点送进去（inert 子树里的元素连程序化 focus 都是 no-op） */}
      <div data-testid="creation-content" className="absolute inset-0 flex flex-col" inert={creationExitPrompt}>
        <header className={`mx-auto mt-6 flex-none shell-panel rounded-2xl px-4 py-3 ${COL_WIDTH}`}>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-title tracking-[.6em] [text-indent:.6em]">剧 本 创 作</h2>
            <span
              className={`h-[7px] w-[7px] flex-none rounded-full ${engineBusy ? "animate-pulse bg-gold" : "bg-[#3d4254]"}`}
              title={playerStatus(status)}
            />
            <button
              type="button"
              onClick={requestCreationExit}
              className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-ui tracking-[.2em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
            >
              返回
            </button>
          </div>
          <p className="mt-1.5 text-meta tracking-[.2em] text-ink-hint">用几句话聊聊你想要的故事，聊到满意就装配成新剧本</p>
        </header>

        {/* 对话流：引擎在上、玩家回话靠右。它同时是本屏的滚动容器——确认层开着时挂 .scroll-locked
            把那唯一在滚的容器停住（锁容器不锁 body：本屏是 fixed inset-0 满幅布局，见 global.css） */}
        <div
          ref={flowRef}
          data-testid="creation-flow"
          className={`mx-auto mt-4 flex-1 overflow-y-auto px-1 pb-4 ${COL_WIDTH}${creationExitPrompt ? " scroll-locked" : ""}`}
        >
          {messages.map((m, i) => {
            // 引擎气泡：选项段拆出来渲染成可点击 chip（点击填入输入框），正文去掉选项段
            const body = m.role === "engine" ? stripOptionsBlock(m.text) : m.text;
            const chips = m.role === "engine" ? parseOptions(m.text) : null;
            return (
              <motion.div
                key={i}
                {...BUBBLE}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className={`mb-3 max-w-[86%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-body leading-[1.85] tracking-[.02em] ${
                  m.role === "engine"
                    ? "border border-white/[.07] bg-panel text-ink-body"
                    : "ml-auto border border-gold/25 bg-gold/10 text-ink"
                }`}
              >
                {body}
                {chips && chips.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {chips.map((o) => (
                      <button
                        key={o.n}
                        type="button"
                        onClick={() => setValue(o.t)}
                        className="rounded-full border border-white/15 bg-white/[.04] px-3 py-1 text-ui text-ink-body transition-colors hover:border-gold/40 hover:text-ink"
                      >
                        {o.t}
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            );
          })}

          {/* 引擎忙时排队的消息：回合结束自动补发 */}
          {pendingMessage && (
            <p className="mb-3 text-right text-meta tracking-[.15em] text-ink-hint">
              就绪后自动发送
            </p>
          )}

          {/* 装配进度：收到【图】标记逐项点亮 */}
          {assembling && (
            <motion.div
              {...BUBBLE}
              transition={{ duration: 0.35 }}
              className="mb-3 rounded-2xl border border-gold/20 bg-panel-soft px-4 py-3"
            >
              <p className="text-ui tracking-[.25em] text-gold/80">装 配 中</p>
              <ul className="mt-2 space-y-1 text-ui text-ink-body">
                <li className={coverDone ? "text-ink" : ""}>
                  {coverDone ? "封面 ✓" : "封面 · 生成中…"}
                </li>
                <li className={portraits.length > 0 ? "text-ink" : ""}>
                  {portraits.length > 0 ? `角色立绘 ✓（${portraits.join("、")}）` : "角色立绘 · 生成中…"}
                </li>
                <li className={result ? "text-ink" : ""}>{result ? "剧本就绪 ✓" : "剧本文件 · 写入中…"}</li>
              </ul>
            </motion.div>
          )}

          {/* 装配回合结束但没有【新剧本】：可重试 */}
          {stalled && !result && (
            <motion.p {...BUBBLE} transition={{ duration: 0.35 }} className="mb-3 text-ui text-ink-body">
              这次装配没能完成，可能超时了。
              <button
                type="button"
                disabled={engineBusy}
                onClick={() => sendCreation(BUILD_ASSEMBLE)}
                className="ml-2 rounded-md border border-gold/35 px-2.5 py-1 text-ui text-gold transition-colors hover:bg-gold/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
              >
                重试装配
              </button>
            </motion.p>
          )}

          {/* 成功态：新剧本入轮播 */}
          {result && resultTitle && (
            <motion.div
              {...BUBBLE}
              transition={{ duration: 0.4 }}
              className="mb-3 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-4 text-center"
            >
              <p className="flex items-center justify-center gap-2 text-body tracking-[.15em] text-gold">
                <Sparkles size={15} /> 新剧本已就绪
              </p>
              <p className="mt-1.5 text-lead tracking-[.1em] text-ink">《{resultTitle}》</p>
              <button
                type="button"
                onClick={finishCreation}
                className="mt-3 rounded-lg border border-gold/35 bg-gold/15 px-5 py-2 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30"
              >
                去选它
              </button>
            </motion.div>
          )}
        </div>

        {/* 输入区：自由输入 + 常驻的开始装配 */}
        <div className={`mx-auto flex-none px-1 pb-6 ${COL_WIDTH}`}>
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="描述你想要的故事（题材、角色、基调…）"
              autoComplete="off"
              className="flex-1 rounded-lg border border-white/10 bg-panel-sunken px-3.5 py-2.5 text-body tracking-[.02em] transition-colors focus:border-gold/35"
            />
            <button
              type="button"
              onClick={submit}
              className="rounded-lg border border-gold/35 bg-gold/15 px-4 text-body text-gold transition-colors hover:bg-gold/30"
            >
              →
            </button>
          </div>
          <button
            type="button"
            disabled={engineBusy || !!result}
            onClick={() => sendCreation(BUILD_ASSEMBLE)}
            className="mt-2.5 w-full rounded-lg border border-dashed border-white/20 px-5 py-2.5 text-ui tracking-[.1em] text-ink-body transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
          >
            {result ? "装配已完成" : assembling ? "装配中…" : "开始装配"}
          </button>
        </div>
      </div>

      {/* 返回确认（Esc 链第三环；对话已开始时不慎点返回不丢创作进度）。
          模态语义：role=dialog + aria-modal（名字用「返回确认」，可见的问句留在正文里——
          免得读屏把同一句念两遍）；焦点进「返回」、Tab 在层内循环、关层归还给开启前的那个按钮。
          背景的两件事（v1.9 a11y 收尾）：创作整列 inert（上面的属性）+ 对话流滚动锁（上面的 .scroll-locked） */}
      <AnimatePresence>
        {creationExitPrompt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={closeCreationExitPrompt}
          >
            <div
              ref={exitPromptRef}
              role="dialog"
              aria-modal="true"
              aria-label="返回确认"
              data-testid="creation-exit-prompt"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-4 rounded-xl border border-white/10 bg-panel-strong px-6 py-5"
            >
              <p className="text-body text-ink-body">返回？创作对话将保留</p>
              <button
                type="button"
                onClick={() => useGameStore.getState().closeOverlay()}
                className="rounded-lg border border-gold/35 bg-gold/15 px-4 py-1.5 text-ui text-gold transition-colors hover:bg-gold/30"
              >
                返回
              </button>
              <button
                type="button"
                onClick={closeCreationExitPrompt}
                className="rounded-lg border border-white/15 px-4 py-1.5 text-ui text-ink-hint transition-colors hover:text-ink"
              >
                取消
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </ScreenShell>
  );
}
