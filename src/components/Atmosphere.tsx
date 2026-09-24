// 全局美术氛围：胶片颗粒噪点（CSS 生成的 SVG feTurbulence）+ 暗角 vignette。
// 常驻 App 顶层、pointer-events-none；颗粒抖动只走 transform，成本极低。
import { motion } from "framer-motion";

/** 常驻的氛围层：胶片颗粒（SVG feTurbulence）+ 暗角。纯装饰、不接数据、不吃主题变量。 */
export function Atmosphere() {
  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      {/* 暗角：四周压暗，聚焦中央 */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(118% 92% at 50% 44%, transparent 52%, rgba(4,5,8,.5) 100%)" }}
      />
      {/* 胶片颗粒：极轻，离散跳位模拟逐帧噪点 */}
      <motion.div
        className="grain absolute -inset-[8%] opacity-[.045] mix-blend-overlay"
        animate={{ x: [0, -7, 4, -2, 6, 0], y: [0, 3, -5, -2, 4, 0] }}
        transition={{ duration: 0.55, repeat: Infinity, ease: "linear" }}
      />
    </div>
  );
}
