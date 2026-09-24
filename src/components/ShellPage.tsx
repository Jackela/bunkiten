import type { ReactNode } from "react";

/**
 * 壳层页框（v1.8）：**6 屏**共用的外框——worlds/protagonist/crafting/settings/assets/preset-check
 * （v1.13 更正名单：此前这里写「worlds/protagonist/crafting/settings/assets」并常被连带读成含 title，
 * 实际 title 是卡带舞台、creation/story-tree 各有版式、boot 是首启三态，四者都不走页框）。
 * 满幅主题底（由屏外层吃 global.css 的 .shell-backdrop）+ 宽栏（本文件唯一的定宽：max-w-[84rem]）+
 * 统一表头（eyebrow → 标题 + 短 accent 分隔线 → 右侧动作簇）+ 可选 ≥xl 右栏 + 可选页脚提示行。
 *
 * 它约束的那条规则：**壳层屏不再各屏自写居中窄栏**（旧屏的 mx-auto max-w-3xl 那类）。
 * 整屏只有这一处定宽，屏内区块一律撑满可用宽度、靠栅格与多列组织信息，别再往中间挤一条窄条；
 * 右栏只在 ≥xl 成列（xl:grid-cols-[minmax(0,1fr)_360px]），窄屏时它顺序排在正文之后、不做抽屉。
 * 字号取 global.css 的 text-* 阶梯档位（本文件全用档位类，无 text-[Npx] 字面）。
 *
 * @param {object} props eyebrow 眉标：短标记（剧本名/分类这类），text-meta 上限；
 *   title 屏标题，text-title；actions 右侧动作簇（按钮/分段控件，窄屏自动换行）；
 *   aside 右栏内容（仅 ≥xl 与正文并排）；footer 页脚提示行（快捷键提示/统计；不传则不渲染该行）；
 *   inert 背景压制：本页框被打开在它之上的模态盖住时置真（属性落在页框根上）；
 *   children 主体
 */
export function ShellPage({
  eyebrow,
  title,
  actions,
  aside,
  footer,
  inert = false,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  /**
   * 背景 `inert`（v1.9）：模态/确认层打开时把**整个页框**（眉标、标题、动作簇、正文、页脚）一起压住，
   * Tab 与点击都进不来。为什么是页框根而不是别的：
   * - 模态是页框的**兄弟**（各屏都渲染在 `</ShellPage>` 之后、同一个 ScreenShell 里），所以压页框
   *   不会连带压住模态自己——inert 子树里的元素连程序化 focus 都进不去（Chromium 实测），
   *   把模态套进来焦点陷阱就送不进焦点了；
   * - 页框根是这一屏「除模态之外的全部可交互面」的最小公共祖先，一处属性收住所有背景控件
   *   （连表头的返回/管理素材按钮），不必逐个控件挂。
   * 默认 false = 一个属性都不写：没开模态的屏 DOM 与 v1.8 逐字一致。
   */
  inert?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="shell-page"
      inert={inert}
      className="mx-auto flex min-h-full w-full max-w-[84rem] flex-col px-6 py-8 lg:px-10"
    >
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-meta tracking-[.3em] text-gold/85">{eyebrow}</p>
          <h1 className="mt-1 text-title tracking-[.18em]">{title}</h1>
          <div className="mt-3 h-px w-16 bg-[color-mix(in_oklab,var(--accent)_70%,transparent)]" />
        </div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </header>

      {aside ? (
        <div className="grid flex-1 gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">{children}</div>
          <aside className="min-w-0">{aside}</aside>
        </div>
      ) : (
        <div className="min-w-0 flex-1">{children}</div>
      )}

      {footer ? <div className="mt-8 text-meta tracking-[.3em] text-ink-hint">{footer}</div> : null}
    </div>
  );
}
