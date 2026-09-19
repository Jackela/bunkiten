import { useEffect, useState, type Ref } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { fallbackPortraitUrl, speakerOf, useGameStore, type PortraitState } from "../../store/game";
import { warmPortraitVariants } from "../../lib/preload";

/** 非发言者的压暗档（Ren'Py 生态的 focus=False 约定）：降不透明度 + 轻微降饱和——还在画面里，但退到后景 */
const DIM_MEDIA = "opacity-55 saturate-[.7]";

// —— 立绘高度/宽度档（数值由 1280×720 实测推得，见 global.css .portrait-reserve-duo）——
/** 单人：沿用 58vh + 46vw 上限 */
const SOLO_BOX = "h-[58vh] max-w-[46vw] max-sm:h-[44vh]";
/** 同屏 2 人的发言者：矮一档（并排更宽，得给对话区让出空间），略高于非发言者以示在场顺序 */
const DUO_LEAD_BOX = "h-[46vh] max-w-[min(20vw,250px)] max-sm:h-[34vh]";
/** 同屏 2 人的非发言者：再矮一档 */
const DUO_DIM_BOX = "h-[42vh] max-w-[min(20vw,250px)] max-sm:h-[30vh]";

/** 队列指纹的分隔符（不可见字符：角色名里不会出现，依赖数组才不会因拼接歧义漏掉变化） */
const CAST_SEP = "\u0000";

/**
 * 单个角色的立绘：换差分只做交叉淡入（0.4s，无位移）；差分图 404 回退基础图。
 * 亮/暗与名牌都挂在**外层**（framer 会写内联 opacity，压暗档必须落在内层元素上才不被覆盖）。
 * `ref` 必须接住并转给外层 motion.div：AnimatePresence(mode="popLayout") 靠它量退场元素的位置，
 * 量不到就摘不出文档流（见 PortraitLayer 文件头——第二版实测量出退场者仍在流里、并排被挤到 3 人宽）。
 */
function PortraitFigure({
  portrait,
  lead,
  duo,
  ref,
}: {
  portrait: PortraitState;
  lead: boolean;
  duo: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  // 0=当前 url；1=回退基础图；2=基础也 404（差分未生成且基础未落盘），只剩名牌
  const [level, setLevel] = useState(0);
  useEffect(() => setLevel(0), [portrait.url]);
  const src = level === 0 ? portrait.url : level === 1 ? fallbackPortraitUrl(portrait) : null;

  return (
    <motion.div
      ref={ref}
      data-testid="portrait-figure"
      data-speaker={lead ? "true" : "false"}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.9, ease: "easeOut" }}
      className={`pointer-events-none relative flex items-end ${duo ? (lead ? DUO_LEAD_BOX : DUO_DIM_BOX) : SOLO_BOX}`}
    >
      {/* grid 单格堆叠：差分交叉淡化要两张图同格重叠，且**不能**用 absolute——absolute 儿里没有
          参与布局的尺寸，外层 shrink-to-fit 宽度恒 0，img 的 max-w-full 就会解析成 max-width:0（立绘不可见）。
          行高必须显式 1fr（=外层 h-[46vh] 等档位高度）：auto 行下 img 的 h-full 会退化成 auto，
          立绘就按固有比例涨到宽度上限（比档位高度高一大截、顶部越出视口）。
          压暗档挂在这一层（发言者切换时 300ms 渐变，位移/换人不补间——位序由队列数组直接决定）。 */}
      <div
        className={`grid h-full grid-rows-1 transition-[opacity,filter] duration-300 ease-out motion-reduce:transition-none ${
          lead ? "" : DIM_MEDIA
        }`}
      >
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
              className="col-start-1 row-start-1 h-full w-auto max-w-full object-contain drop-shadow-[0_18px_40px_rgba(0,0,0,.65)]"
            />
          )}
        </AnimatePresence>
      </div>
      {/* 名牌只归发言者：竖排名牌贴在她自己左缘，与并排位（间距 14px > 名牌外伸 12px）刚好不压到前一位 */}
      {lead && portrait.name && (
        <span
          data-testid="portrait-nameplate"
          className="absolute -left-3.5 top-2.5 rounded-sm border border-gold/35 bg-panel px-[5px] py-3 text-sm tracking-[.35em] text-gold [writing-mode:vertical-rl]"
        >
          {portrait.name}
        </span>
      )}
    </motion.div>
  );
}

/**
 * 立绘层：右下角一个浮层容器，内部横向排列（左=较早出场，右=发言者），底对齐、间距 14px。
 * 发言者（队列末位）全亮带名牌，其余压暗缩小（VN 的 dim 约定）。
 * `mode="popLayout"`：被淘汰/换下的角色退出时被**摘出文档流**（按上一帧位置钉住再淡出），
 * 否则她会在退场动画期间继续占位，并排宽度会短暂变成三人宽、压到对话区上。
 * 同一角色重复标记不重放动画（keyed by name），单角色时的呈现与 v1.8 逐字一致。
 */
export default function PortraitLayer() {
  const portraits = useGameStore((s) => s.portraits);
  const presetId = useGameStore((s) => s.selected?.id ?? "");
  // 发言者 = 队列末位（判定走 portrait.speakerOf，别在渲染层自己写「最后一个」）
  const speaker = speakerOf(portraits)?.name ?? "";
  const duo = portraits.length > 1;
  // 依赖数组只吃指纹（数组每次 set 都是新引用）：名字一变就重跑，队列顺序变化不影响预热
  const castKey = portraits.map((p) => p.name).join(CAST_SEP);

  // 差分预热（lib/preload）：场上每个角色一变，就把她在本剧本下的**全部**立绘（基础 + 差分）
  // 塞进浏览器缓存——【立绘】换差分时命中的是已经解码好的图，不再空白一下才画出来。
  // fire-and-forget：不 await、不 setState、失败静默（清单拉不到就是不预热），渲染路径零等待。
  // 同屏 2 人 = 每人一次；模块内按 preset 缓存清单，重复调用便宜。
  useEffect(() => {
    if (!presetId) return;
    for (const name of castKey.split(CAST_SEP)) {
      if (name) warmPortraitVariants(presetId, name);
    }
  }, [presetId, castKey]);

  return (
    <div className="pointer-events-none fixed right-[max(2vw,8px)] bottom-[26vh] flex items-end gap-3.5 max-sm:bottom-[30vh]">
      <AnimatePresence mode="popLayout">
        {portraits.map((p) => (
          <PortraitFigure key={p.name} portrait={p} lead={p.name === speaker} duo={duo} />
        ))}
      </AnimatePresence>
    </div>
  );
}
