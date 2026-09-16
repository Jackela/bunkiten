import { motion } from "framer-motion";

/** aurora 光带：色相组合 / 高度位置 / 流动周期与相位 */
const BANDS = [
  {
    top: "-18%",
    d: 26,
    delay: 0,
    background:
      "linear-gradient(100deg, transparent 8%, rgba(64,184,168,.15) 30%, rgba(118,108,214,.13) 52%, rgba(66,142,202,.11) 72%, transparent 92%)",
  },
  {
    top: "6%",
    d: 34,
    delay: 5,
    background:
      "linear-gradient(80deg, transparent 12%, rgba(150,96,190,.10) 38%, rgba(70,170,160,.13) 58%, transparent 88%)",
  },
];

/**
 * aurora：极光渐变流动（blur 静态，流动只走 transform）。
 * @param {object} props dense=true 用于标题屏卡面（更亮）
 */
export function AuroraMotif({ dense = false }: { dense?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {BANDS.map((b, i) => (
        <motion.div
          key={i}
          className="absolute left-[-24%] w-[148%]"
          style={{ top: b.top, height: "62%", background: b.background, filter: "blur(22px)" }}
          animate={{
            x: ["-3%", "3%", "-3%"],
            skewX: [-3, 4, -3],
            opacity: dense ? [0.75, 1, 0.75] : [0.45, 0.8, 0.45],
          }}
          transition={{ duration: b.d, delay: b.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
