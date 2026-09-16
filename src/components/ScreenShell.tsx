import type { CSSProperties, ReactNode } from "react";
import { motion } from "framer-motion";

/**
 * 屏幕壳：App 的 AnimatePresence(mode="wait") 依赖此 motion 根做进出场；
 * 离场时叠一层主题色薄雾再淡出，形成「主题色溶解」转场。
 * @param {object} props className 附加类；style 透传（标题屏用来覆盖主题变量）
 */
export function ScreenShell({
  className = "",
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <motion.div
      className={`absolute inset-0 ${className}`}
      style={style}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
    >
      <motion.div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 40%, color-mix(in oklab, var(--accent) 16%, transparent), transparent 72%)",
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 0 }}
        exit={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: "easeIn" }}
      />
      {children}
    </motion.div>
  );
}
