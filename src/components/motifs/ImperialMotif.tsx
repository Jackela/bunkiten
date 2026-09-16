import { motion } from "framer-motion";

/** imperial 光柱：横向位置 / 宽度 / 平移幅度 / 周期 */
const PILLARS = [
  { l: "16%", w: 90, amp: 46, d: 24, delay: 0 },
  { l: "58%", w: 130, amp: 60, d: 30, delay: 4 },
  { l: "84%", w: 70, amp: 34, d: 21, delay: 8 },
];

/** 墨色晕染团 */
const BLOOMS = [
  { l: "8%", t: "56%", s: 260, d: 18, delay: 0 },
  { l: "70%", t: "30%", s: 320, d: 22, delay: 6 },
];

/**
 * imperial：朱金光柱缓移 + 墨色晕染（晕染是静态 blur 上做 scale 呼吸）。
 * @param {object} props dense=true 用于标题屏卡面（更亮）
 */
export function ImperialMotif({ dense = false }: { dense?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {PILLARS.map((p, i) => (
        <motion.div
          key={`pillar-${i}`}
          className="absolute inset-y-0"
          style={{
            left: p.l,
            width: p.w,
            background:
              "linear-gradient(180deg, transparent 6%, rgba(216,92,64,.16) 45%, rgba(228,180,96,.12) 60%, transparent 94%)",
          }}
          animate={{ x: [-p.amp, p.amp, -p.amp], opacity: dense ? [0.6, 1, 0.6] : [0.35, 0.75, 0.35] }}
          transition={{ duration: p.d, delay: p.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
      {BLOOMS.map((b, i) => (
        <motion.div
          key={`bloom-${i}`}
          className="absolute rounded-full"
          style={{
            left: b.l,
            top: b.t,
            width: b.s,
            height: b.s,
            background: "radial-gradient(circle, rgba(16,10,8,.5), rgba(16,10,8,0) 68%)",
            filter: "blur(6px)",
          }}
          animate={{ scale: [1, 1.18, 1] }}
          transition={{ duration: b.d, delay: b.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
