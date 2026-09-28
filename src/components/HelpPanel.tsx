// 帮助面板（v1.14，ADR-0027 元命令本地化）：/help 不再经引擎，帮助内容全部本地静态、**零引擎回合**。
// 由 store 的 helpOpen 控制显隐（TopBar 命令轨「帮助」→ openHelp），closeHelp 关闭；Esc 由 App 的
// 关闭链接管（面板开着时它是第一环）。照既有 overlay 范式：role=dialog + aria-modal + useFocusTrap，
// 焦点进面板、Tab 在面板里循环、关时归还。这份内容不套 ShellPage——那是**整屏**的页框，面板只是浮层。
//
// 三块内容：
//   ① 命令轨五组说明（设置｜回顾｜图鉴｜进度｜帮助）——告诉玩家每条轨通往哪里；
//   ② 键盘/操作卡——复用 WorldScreen 的 worlds-keys-card 卡式样式与 keyHints 的数据形状（[键, 说明]），
//      但用本面板自己的 testid（同名 testid 只该有一种语义）；
//   ③ 数据与备份——一句话交代进度/日志存在哪（打包版在系统的应用数据目录），两个「打开目录」按钮。
// 文案一律玩家口吻：不出现环境变量名、命令行、目录路径这类开发者口径。

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { postOpenDir } from "../lib/acp";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useGameStore } from "../store/game";

/** 命令轨的五组（顺序即屏上顺序，与 TopBar 的 设置｜回顾｜图鉴｜进度｜帮助 对齐） */
const RAIL_GROUPS: [string, string][] = [
  ["设置", "调音量与静音、文字速度与自动前进；想换故事引擎或填自己的服务，也在这一页里。"],
  ["回顾", "「历史」翻看已经演过的每一幕，「前情」用几句话把最近发生的事再说一遍。"],
  ["图鉴", "「角色」看当前的好感度与线索，「画廊」看这部剧本已经画好的立绘与背景，「剧情图」看走过的节点与存档点。"],
  [
    "进度",
    "「重演这一幕」重放刚结束的一幕，「返回标题」先放下这局，「导出这一局」存一份进度备份，「重开」「换剧本」另起一局。",
  ],
  ["帮助", "就是你正在看的这一页。"],
];

/** 键盘与操作速查（数据形状照 WorldScreen 的 keyHints：`[键, 说明]`） */
const KEY_HINTS: [string, string][] = [
  ["点击", "点选项或卡片来推进故事"],
  ["输入框", "自己写一句想做的事，回车发送"],
  ["空格", "正文正在逐字浮现时，按一下立刻显示整段"],
  ["← →", "在标题屏左右切换剧本卡"],
  ["拖拽 / 滚轮", "在剧情图上平移与缩放"],
  ["+ − 0", "剧情图：放大、缩小、适应窗口"],
  ["数字键", "有选项时，按对应数字直接选"],
  ["Esc", "关闭当前打开的抽屉、面板或弹层"],
];

/** 小节标题（与其它面板同款的字距小标） */
function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-ui tracking-[.3em] text-gold/85">{children}</h3>;
}

/**
 * 帮助面板：浮在当前屏之上的模态（role=dialog + aria-modal）；开关走 store（helpOpen/closeHelp），
 * Esc 归 App 的关闭链（这里不碰键盘的 Esc）。内容本地静态，不占任何引擎回合。
 */
export default function HelpPanel() {
  const open = useGameStore((s) => s.helpOpen);
  const closeHelp = useGameStore((s) => s.closeHelp);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, panelRef);
  // 「打开目录」的反馈（成功/失败一行小字；服务端不抛错，失败在返回值里）
  const [dirMsg, setDirMsg] = useState<string | null>(null);

  const openDir = (which: "data" | "logs") => {
    const name = which === "logs" ? "日志" : "数据";
    postOpenDir(which)
      .then((r) => setDirMsg(r.ok ? `已帮你打开${name}目录` : `打开${name}目录失败：${r.error ?? "未知错误"}`))
      .catch((e: unknown) => setDirMsg(`打开${name}目录失败：${String(e)}`));
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          onClick={closeHelp}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="帮助"
            data-testid="help-panel"
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
            className="relative flex max-h-[80vh] w-[min(640px,94vw)] flex-col gap-5 overflow-y-auto rounded-2xl border border-white/10 bg-panel-strong p-6"
          >
            <button
              type="button"
              data-testid="help-close"
              aria-label="关闭帮助"
              onClick={closeHelp}
              className="absolute top-3 right-3 rounded-md p-1 text-ink-hint transition-colors hover:text-ink"
            >
              <X size={16} />
            </button>

            <header>
              <h2 className="text-title tracking-[.3em] text-ink">帮 助</h2>
              <p className="mt-1.5 text-meta leading-relaxed text-ink-hint">
                游戏里的所有操作都收在右边那条命令轨上，下面按组说一遍它们各自通往哪里。
              </p>
            </header>

            {/* ① 命令轨五组说明 */}
            <section data-testid="help-rail" className="space-y-2.5">
              <SectionTitle>命令轨</SectionTitle>
              <dl className="space-y-2">
                {RAIL_GROUPS.map(([name, hint]) => (
                  <div key={name} className="flex gap-3 text-ui">
                    <dt className="w-14 flex-none tracking-[.15em] text-ink-body">{name}</dt>
                    <dd className="min-w-0 flex-1 leading-relaxed text-ink-hint">{hint}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* ② 键盘与操作卡（卡式样式照 WorldScreen 的 worlds-keys-card） */}
            <section data-testid="help-keys-card" className="shell-panel rounded-2xl p-4">
              <h3 className="text-ui tracking-[.25em] text-gold/80">键 盘</h3>
              <dl className="mt-3 grid gap-1.5">
                {KEY_HINTS.map(([key, hint]) => (
                  <div key={key} className="flex gap-3 text-meta">
                    <dt className="w-20 flex-none text-ink-body">{key}</dt>
                    <dd className="min-w-0 text-ink-hint">{hint}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* ③ 数据与备份 */}
            <section data-testid="help-data" className="space-y-2.5">
              <SectionTitle>数据与备份</SectionTitle>
              <p className="text-meta leading-relaxed text-ink-hint">
                安装版会把你的进度与回合记录存在系统的应用数据目录里，覆盖安装或更新都不会丢档。想留一份能带走的备份，
                可以在「进度」菜单里「导出这一局」。
              </p>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  data-testid="help-open-logs"
                  onClick={() => openDir("logs")}
                  className="rounded-lg border border-white/15 px-4 py-1.5 text-ui text-ink-body transition-colors hover:border-gold/35 hover:text-ink"
                >
                  打开日志目录
                </button>
                <button
                  type="button"
                  data-testid="help-open-data"
                  onClick={() => openDir("data")}
                  className="rounded-lg border border-white/15 px-4 py-1.5 text-ui text-ink-body transition-colors hover:border-gold/35 hover:text-ink"
                >
                  打开数据目录
                </button>
              </div>
              {dirMsg && (
                <p data-testid="help-dir-msg" role="status" className="text-meta text-ink-hint">
                  {dirMsg}
                </p>
              )}
            </section>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
