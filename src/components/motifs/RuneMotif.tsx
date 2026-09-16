import { motion } from "framer-motion";

/** rune 漂浮符文：符形 / 位置 / 漂移周期 / 是否偶发闪 */
const RUNES = [
  { ch: "ᚠ", l: "12%", t: "22%", d: 15, flash: false },
  { ch: "ᛟ", l: "78%", t: "16%", d: 18, flash: true },
  { ch: "ᚱ", l: "86%", t: "62%", d: 13, flash: false },
  { ch: "ᛉ", l: "22%", t: "74%", d: 17, flash: true },
  { ch: "ᚦ", l: "56%", t: "84%", d: 20, flash: false },
  { ch: "ᛊ", l: "42%", t: "10%", d: 16, flash: true },
  { ch: "ᚨ", l: "5%", t: "52%", d: 19, flash: false },
];

/**
 * rune：青绿符文微亮漂移 + 偶发闪（闪烁只动 opacity/textShadow 强度用透明度叠层模拟）。
 * @param {object} props dense=true 用于标题屏卡面（更亮）
 */
export function RuneMotif({ dense = false }: { dense?: boolean }) {
  const base = dense ? 0.55 : 0.3;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* 符文阵线：两道极细的青绿垂线，缓慢明灭 */}
      {[18, 66].map((l, i) => (
        <motion.div
          key={`line-${i}`}
          className="absolute inset-y-0 w-px"
          style={{ left: `${l}%`, background: "linear-gradient(180deg, transparent, rgba(62,207,174,.25), transparent)" }}
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ duration: 9 + i * 3, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
      {RUNES.map((r, i) => (
        <motion.span
          key={i}
          className="absolute font-serif"
          style={{ left: r.l, top: r.t, color: "#46d6b0", textShadow: "0 0 10px rgba(70,214,176,.8)" }}
          animate={{
            y: [0, -18, 0],
            opacity: r.flash ? [base * 0.4, base, 1, base * 0.4] : [base * 0.5, base, base * 0.5],
          }}
          transition={{
            duration: r.flash ? 8 : r.d,
            times: r.flash ? [0, 0.45, 0.5, 1] : undefined,
            delay: i * 1.3,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        >
          {r.ch}
        </motion.span>
      ))}
    </div>
  );
}
