import { motion } from "framer-motion";

/** summer 光斑参数：位置/尺寸/上浮周期/延迟（错开节奏避免齐步） */
const SPOTS = [
  { l: "10%", t: "68%", s: 150, d: 16, delay: 0 },
  { l: "68%", t: "34%", s: 100, d: 19, delay: 2 },
  { l: "30%", t: "18%", s: 70, d: 14, delay: 5 },
  { l: "84%", t: "72%", s: 130, d: 21, delay: 1 },
  { l: "48%", t: "82%", s: 90, d: 17, delay: 7 },
  { l: "20%", t: "45%", s: 60, d: 13, delay: 9 },
];

/**
 * summer：暖金光斑缓慢上浮 + 柔焦（blur 为静态滤镜，动画只走 transform/opacity）。
 * @param {object} props dense=true 用于标题屏卡面（更亮）
 */
export function SummerMotif({ dense = false }: { dense?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {SPOTS.map((p, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full"
          style={{
            left: p.l,
            top: p.t,
            width: p.s,
            height: p.s,
            background: "radial-gradient(circle, rgba(240,185,90,.32), rgba(240,185,90,0) 70%)",
            filter: "blur(5px)",
          }}
          animate={{ y: [0, -p.s * 0.7, -p.s * 0.7, 0], opacity: dense ? [0.55, 1, 1, 0.55] : [0.3, 0.7, 0.7, 0.3] }}
          transition={{ duration: p.d, delay: p.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
