import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { fallbackPortraitUrl, useGameStore, type PortraitState } from "../../store/game";

/** 单个角色的立绘：换差分只做交叉淡入（0.4s，无位移）；差分图 404 回退基础图 */
function PortraitFigure({ portrait }: { portrait: PortraitState }) {
  // 0=当前 url；1=回退基础图；2=基础也 404（差分未生成且基础未落盘），只剩名牌
  const [level, setLevel] = useState(0);
  useEffect(() => setLevel(0), [portrait.url]);
  const src = level === 0 ? portrait.url : level === 1 ? fallbackPortraitUrl(portrait) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.9, ease: "easeOut" }}
      className="pointer-events-none fixed right-[max(2vw,8px)] bottom-[26vh] flex h-[58vh] max-w-[46vw] items-end max-sm:h-[44vh] max-sm:bottom-[30vh]"
    >
      <div className="relative h-full">
        <AnimatePresence>
          {src && (
            <motion.img
              key={src}
              src={src}
              alt={portrait.name}
              onError={() => setLevel((l) => Math.min(l + 1, 2))}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: "easeInOut" }}
              className="absolute inset-y-0 left-0 h-full max-w-full object-contain drop-shadow-[0_18px_40px_rgba(0,0,0,.65)]"
            />
          )}
        </AnimatePresence>
      </div>
      {portrait.name && (
        <span className="absolute -left-3.5 top-2.5 rounded-sm border border-gold/35 bg-[rgba(10,12,18,.72)] px-[5px] py-3 text-sm tracking-[.35em] text-gold [writing-mode:vertical-rl]">
          {portrait.name}
        </span>
      )}
    </motion.div>
  );
}

/** 立绘层：右下、竖排名牌、浮入（0.9s，对齐旧版 setPortrait）。同一角色重复标记不重放动画 */
export default function PortraitLayer() {
  const portrait = useGameStore((s) => s.portrait);

  return (
    <AnimatePresence>
      {portrait && <PortraitFigure key={portrait.name} portrait={portrait} />}
    </AnimatePresence>
  );
}
