import { motion } from "framer-motion";
import { useGameStore } from "../../store/game";

/** 选项列表：打字机完成后逐条浮入。galgame 规范的居中竖排 + ◇ 子弹 + 悬停主题色描边微上浮 */
export default function OptionList() {
  const options = useGameStore((s) => s.options);
  const typingDone = useGameStore((s) => s.typingDone);
  const send = useGameStore((s) => s.send);

  if (!typingDone || !options || options.length === 0) return null;

  return (
    <div data-testid="options" className="mb-3 mx-auto flex w-fit max-w-full flex-col items-center gap-1">
      {options.map((o, i) => (
        <motion.button
          key={i}
          type="button"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: Math.min(i * 0.08, 0.32), ease: "easeOut" }}
          onClick={() => send(o.t)}
          className="group flex items-center justify-center gap-2.5 rounded-lg border border-transparent bg-[rgba(10,12,18,.55)] px-5 py-2 text-center text-[15.5px] tracking-[.03em] text-ink/85 backdrop-blur-md transition-[color,border-color,transform,background-color] duration-200 hover:-translate-y-0.5 hover:border-[color:var(--accent)] hover:bg-[rgba(16,19,28,.8)] hover:text-ink"
        >
          <span className="text-[10px] leading-none text-[color:var(--accent)]/80 transition-transform duration-200 group-hover:rotate-90">
            ◇
          </span>
          {o.n && <b className="font-normal text-[color:var(--accent)]">{o.n}</b>}
          <span>{o.t}</span>
        </motion.button>
      ))}
    </div>
  );
}
