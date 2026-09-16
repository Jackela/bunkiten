import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { BUILD_ASSEMBLE, parseOptions, stripOptionsBlock } from "../lib/parser";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";

/** 气泡进出：克制的小位移淡入 */
const BUBBLE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
} as const;

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

  const resultTitle = result ? (presets.find((p) => p.id === result)?.title ?? result) : null;

  return (
    <ScreenShell className="bg-[radial-gradient(120%_90%_at_50%_0%,#131627_0%,#07080c_60%)]">
      <div className="absolute inset-0 flex flex-col">
        <header className="flex items-center px-6 pt-8">
          <h2 className="text-xl tracking-[.6em] [text-indent:.6em]">剧 本 创 作</h2>
          <span
            className={`ml-3 h-[7px] w-[7px] flex-none rounded-full ${engineBusy ? "animate-pulse bg-gold" : "bg-[#3d4254]"}`}
            title={status}
          />
          <button
            type="button"
            onClick={requestCreationExit}
            className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-[12px] tracking-[.2em] text-ink/60 transition-colors hover:border-gold/40 hover:text-ink"
          >
            返回
          </button>
        </header>
        <p className="mt-2 px-6 text-[11px] tracking-[.2em] text-ink/40">
          用几句话聊聊你想要的故事，聊到满意就装配成新剧本
        </p>

        {/* 对话流：引擎在上、玩家回话靠右 */}
        <div ref={flowRef} className="mx-auto mt-4 w-[min(680px,92vw)] flex-1 overflow-y-auto px-1 pb-4">
          {messages.map((m, i) => {
            // 引擎气泡：选项段拆出来渲染成可点击 chip（点击填入输入框），正文去掉选项段
            const body = m.role === "engine" ? stripOptionsBlock(m.text) : m.text;
            const chips = m.role === "engine" ? parseOptions(m.text) : null;
            return (
              <motion.div
                key={i}
                {...BUBBLE}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className={`mb-3 max-w-[86%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-[14.5px] leading-[1.85] tracking-[.02em] ${
                  m.role === "engine"
                    ? "border border-white/[.07] bg-[rgba(16,19,28,.72)] text-ink/90"
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
                        className="rounded-full border border-white/15 bg-white/[.04] px-3 py-1 text-[12.5px] text-ink/75 transition-colors hover:border-gold/40 hover:text-ink"
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
            <p className="mb-3 text-right text-[11.5px] tracking-[.15em] text-ink/40">
              引擎就绪后自动发送
            </p>
          )}

          {/* 装配进度：收到【图】标记逐项点亮 */}
          {assembling && (
            <motion.div
              {...BUBBLE}
              transition={{ duration: 0.35 }}
              className="mb-3 rounded-2xl border border-gold/20 bg-[rgba(16,19,28,.6)] px-4 py-3"
            >
              <p className="text-[12px] tracking-[.25em] text-gold/80">装 配 中</p>
              <ul className="mt-2 space-y-1 text-[13.5px] text-ink/70">
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
            <motion.p {...BUBBLE} transition={{ duration: 0.35 }} className="mb-3 text-[13px] text-ink/50">
              这一轮装配没有完成，可能是引擎超时了。
              <button
                type="button"
                disabled={engineBusy}
                onClick={() => sendCreation(BUILD_ASSEMBLE)}
                className="ml-2 rounded-md border border-gold/35 px-2.5 py-1 text-[12px] text-gold transition-colors hover:bg-gold/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink/35"
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
              <p className="flex items-center justify-center gap-2 text-[15px] tracking-[.15em] text-gold">
                <Sparkles size={15} /> 新剧本已就绪
              </p>
              <p className="mt-1.5 text-[18px] tracking-[.1em] text-ink">《{resultTitle}》</p>
              <button
                type="button"
                onClick={finishCreation}
                className="mt-3 rounded-lg border border-gold/35 bg-gold/15 px-5 py-2 text-[13.5px] tracking-[.1em] text-gold transition-colors hover:bg-gold/30"
              >
                去选它
              </button>
            </motion.div>
          )}
        </div>

        {/* 输入区：自由输入 + 常驻的开始装配 */}
        <div className="mx-auto w-[min(680px,92vw)] px-1 pb-6">
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="描述你想要的故事（题材、角色、基调…）"
              autoComplete="off"
              className="flex-1 rounded-lg border border-white/10 bg-[rgba(12,14,20,.8)] px-3.5 py-2.5 text-[15px] tracking-[.02em] outline-none transition-colors focus:border-gold/35"
            />
            <button
              type="button"
              onClick={submit}
              className="rounded-lg border border-gold/35 bg-gold/15 px-4 text-[15px] text-gold transition-colors hover:bg-gold/30"
            >
              →
            </button>
          </div>
          <button
            type="button"
            disabled={engineBusy || !!result}
            onClick={() => sendCreation(BUILD_ASSEMBLE)}
            className="mt-2.5 w-full rounded-lg border border-dashed border-white/20 px-5 py-2.5 text-sm tracking-[.1em] text-ink/70 transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink/30"
          >
            {result ? "装配已完成" : assembling ? "装配中…" : "开始装配"}
          </button>
        </div>
      </div>

      {/* 返回确认（Esc 链第三环；对话已开始时不慎点返回不丢创作进度） */}
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
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-4 rounded-xl border border-white/10 bg-[rgba(10,12,18,.95)] px-6 py-5"
            >
              <p className="text-[14px] text-ink/85">返回？创作对话将保留</p>
              <button
                type="button"
                onClick={() => useGameStore.getState().closeOverlay()}
                className="rounded-lg border border-gold/35 bg-gold/15 px-4 py-1.5 text-[13px] text-gold transition-colors hover:bg-gold/30"
              >
                返回
              </button>
              <button
                type="button"
                onClick={closeCreationExitPrompt}
                className="rounded-lg border border-white/15 px-4 py-1.5 text-[13px] text-ink/60 transition-colors hover:text-ink"
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
