// 氛围层总入口：按主题 motif 渲染对应的背景图案组件。
// 各 motif 都是纯 CSS/transform/opacity 动画，低透明度、不干扰阅读。
import type { Motif } from "../../theme";
import { SummerMotif } from "./SummerMotif";
import { RuneMotif } from "./RuneMotif";
import { ImperialMotif } from "./ImperialMotif";
import { AuroraMotif } from "./AuroraMotif";

/**
 * @param {object} props motif=主题图案；dense=true 用于标题屏卡面（密度更高）
 */
export function MotifLayer({ motif, dense = false }: { motif: Motif; dense?: boolean }) {
  switch (motif) {
    case "summer":
      return <SummerMotif dense={dense} />;
    case "rune":
      return <RuneMotif dense={dense} />;
    case "imperial":
      return <ImperialMotif dense={dense} />;
    case "aurora":
      return <AuroraMotif dense={dense} />;
  }
}
