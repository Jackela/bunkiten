import type { ReactNode } from "react";

/**
 * 壳层页框（v1.8）：worlds/protagonist/crafting/settings/assets 这些非游戏舞台屏共用的外框——
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
 *   children 主体
 */
export function ShellPage({
  eyebrow,
  title,
  actions,
  aside,
  footer,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="shell-page"
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
