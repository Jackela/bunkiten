// 世界线列表的一行（v1.13 从 WorldsScreen 抽出）：缩略图 + 显示名/备注 + 主行动「继续」+ ⋯ 菜单
// （改名/导出/删除，删除的两段确认收在菜单内）。状态与动作仍归 WorldsScreen 管（这里只渲染 + 回调）。
//
// a11y（v1.13）：行本身是 listbox 的 `role="option"`，而 option 里**不许再套可交互控件**——所以
// 「继续」按钮与 ⋯ 菜单触发器搬出了 option 节点，成为它的兄弟（同在 role="presentation" 的行框里，
// 该框在无障碍树里被忽略、option 因此仍是 listbox 的直接子节点）。行的点击/悬停/焦点（roving 光标）
// 与键盘导航一字未变；`data-testid="world-row-<id>"` 仍钉在可聚焦的 option 上（e2e 依赖它）。
import { motion } from "framer-motion";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { coverUrl, worldExportUrl, type WorldEntry } from "../lib/acp";
import { forkPhrase, isLegacyForkNote, relativeTime, worldDisplayName } from "../lib/worlds";
import { useState } from "react";

/** 列表行进出：与创作屏气泡同款克制位移淡入 */
const ROW = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } } as const;

/** 显示名/备注的字数上限（与 server POST /api/worlds update 校验一致，超了服务端会拒） */
const LABEL_MAX = 60;
const NOTE_MAX = 200;

/** ⋯ 菜单项基类（三项共用；删除/确认项在其后追加红色 hover 类） */
const MENU_ITEM_CLS =
  "w-full rounded-lg px-3 py-2 text-left text-ui text-ink-hint transition-colors hover:bg-white/[.06] hover:text-ink";

/** 菜单项里「选中即关」的例外：两段确认要留在菜单里、导出要等下载派发完再关，都自己收尾 */
const KEEP_MENU_OPEN = (event: Event) => event.preventDefault();

/**
 * Esc 就地关菜单、且**不许**冒到 App 的 Esc 关闭链（那一下会把整屏关回标题屏）。
 * Radix 的 DismissableLayer 在 document 的**捕获阶段**监听 Esc，这里在它那一拍上 stopPropagation：
 * 事件到此为止，既到不了 target 冒泡，也到不了挂在 window 上的关闭链；关菜单由 Radix 的 onDismiss
 * 继续（它看的是 defaultPrevented，我们没 preventDefault，所以不会被跳过）。
 */
const swallowEscape = (event: KeyboardEvent) => event.stopPropagation();

/**
 * 行缩略图（ROADMAP §5）：整屏的世界线都属同一个剧本（清单本来按 `fetchWorlds(presetId)` 过滤），
 * 所以不必给每条世界线各存一张图——直接复用剧本封面 `coverUrl(entry.preset)`（`/img` 白名单直服
 * `presets/<id>/cover.jpg`，零服务端改动）。尺寸 56×40（`h-10 w-14`），行高由右边的文字块决定。
 *
 * 三条不显然的约定：
 * 1) **盒子常驻、图片可缺席**：外层 span 恒定 56×40，`onError` 只把 `<img>` 摘掉，留下这层中性底
 *    （`bg-white/[.03]`，与行内徽标同底）。没有 cover.jpg 的剧本并不罕见（导入进来的剧本、假栈里的
 *    preset 目录默认都没有那张图），404 既不能留破图、也不能让行高抖动——固定尺寸的盒子让「有无封面」
 *    两态在布局上完全同形。与标题屏的 `CardCover` 同一种「回退 = 不渲染」的写法，
 *    差别只是那里回退成主题渐变、这里回退成占位块。
 * 2) `alt=""`：装饰性图像——显示名就在右边文字块里，再给一句 alt 等于让读屏把同一个名字念两遍。
 * 3) `pointer-events-none`：缩略图不是交互元素，行的点击/键盘（选中、roving tabIndex、⋯ 菜单）全归行自己。
 *
 * 刻意**没做**「该世界当前场景背景」那一版：`WorldEntry` 不带任何图字段（ROADMAP §5 记了这笔账）。
 * @param {string} preset 剧本 id（封面按剧本取，与本世界线的章数/节点无关）
 * @param {string} worldId 世界 id（只用于 data-testid，便于 e2e 按行点名）
 */
function RowCover({ preset, worldId }: { preset: string; worldId: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      data-testid={`world-cover-${worldId}`}
      className="pointer-events-none h-10 w-14 flex-none overflow-hidden rounded-md border border-white/[.07] bg-white/[.03]"
    >
      {!failed && (
        <img
          data-testid={`world-cover-img-${worldId}`}
          src={coverUrl(preset)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="pointer-events-none h-full w-full object-cover"
        />
      )}
    </span>
  );
}

/** 一行要的全部输入与回调（状态与动作都留在 WorldsScreen，这里只画） */
export interface WorldRowProps {
  entry: WorldEntry;
  /** 是不是 roving 光标所在行（决定 aria-selected 与 tabIndex） */
  focused: boolean;
  /** 剧本标题：显示名与分叉说明的最后一道兜底 */
  presetTitle: string;
  /** 当前清单：把分叉来源的父线 id 还原成显示名 */
  worlds: WorldEntry[];
  engineBusy: boolean;
  /** 该世界档已回退、引擎等一次续玩指令重读档（行内亮「待重同步」） */
  resyncing: boolean;
  confirming: boolean;
  deleting: boolean;
  editing: boolean;
  menuOpen: boolean;
  editLabel: string;
  editNote: string;
  saving: boolean;
  worldBusy: boolean;
  /** 可聚焦的 option 节点（roving tabIndex 的焦点目标，也是 testid 所在） */
  rowRef: (el: HTMLDivElement | null) => void;
  /** 行内改名「显示名」输入框（打开编辑器时聚焦它） */
  labelRef: RefObject<HTMLInputElement | null>;
  /** ⋯ 菜单弹层节点的挂载回调（把焦点送进第一项、Tab 走项都按它查菜单项） */
  attachMenuPopup: (node: HTMLDivElement | null) => void;
  onHover: () => void;
  onFocusRow: () => void;
  onClickRow: () => void;
  onContinue: () => void;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onMenuKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onMenuCloseAutoFocus: (e: Event) => void;
  /** 菜单「改名」：关菜单 + 聚焦输入框（已在编辑就只送焦点，不覆盖未保存的改动） */
  onEditOpen: () => void;
  onEditSave: () => void;
  onEditKey: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  /** 菜单「删除」：进第一段确认态 */
  onRequestDelete: () => void;
  onEditCancel: () => void;
  onEditLabelChange: (value: string) => void;
  onEditNoteChange: (value: string) => void;
  /** 菜单「导出」：下载派发完再关菜单（延后一拍） */
  onExport: () => void;
}

/**
 * 世界线列表行。行的可聚焦/可选语义（`role="option"` + `aria-selected` + roving tabIndex）钉在
 * 左侧「缩略图 + 文字」的 option 节点上；「继续」与 ⋯ 菜单是它的兄弟，不在 option 内。
 */
export function WorldRow({
  entry,
  focused,
  presetTitle,
  worlds,
  engineBusy,
  resyncing,
  confirming,
  deleting,
  editing,
  menuOpen,
  editLabel,
  editNote,
  saving,
  worldBusy,
  rowRef,
  labelRef,
  attachMenuPopup,
  onHover,
  onFocusRow,
  onClickRow,
  onContinue,
  onOpenMenu,
  onCloseMenu,
  onMenuKeyDown,
  onMenuCloseAutoFocus,
  onEditOpen,
  onEditSave,
  onEditKey,
  onDelete,
  onCancelDelete,
  onRequestDelete,
  onEditCancel,
  onEditLabelChange,
  onEditNoteChange,
  onExport,
}: WorldRowProps) {
  const missing = !entry.exists;
  const name = worldDisplayName(entry, presetTitle);
  return (
    <motion.div
      {...ROW}
      transition={{ duration: 0.3, ease: "easeOut" }}
      // 行框在无障碍树里被忽略：option 因此是 listbox 的直接子节点（见文件头）
      role="presentation"
      onMouseEnter={onHover}
      onFocus={onFocusRow}
      onClick={onClickRow}
      // relative + z-20（仅菜单开着的那行）：framer-motion 留在行上的 transform 会让行自建层叠上下文，
      // 弹出层因此逃不出自己的行——不抬行的话后面的行会盖在菜单上（真的盖住，点不到）
      className={`relative rounded-xl border bg-panel px-4 py-3 backdrop-blur-md transition-colors ${
        menuOpen ? "z-20" : ""
      } ${focused ? "border-gold/40" : "border-white/10 hover:border-gold/25"}`}
    >
      <div className="flex items-center gap-3">
        {/* option：可聚焦/可选的是这一块（缩略图 + 文字），「继续」与 ⋯ 菜单是它的兄弟（见文件头 a11y） */}
        <div
          role="option"
          aria-selected={focused}
          tabIndex={focused ? 0 : -1}
          ref={rowRef}
          data-testid={`world-row-${entry.worldId}`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
        >
          {/* 行缩略图：剧本封面（本屏的清单本来就按剧本过滤），无 cover.jpg 时只剩同尺寸占位块 */}
          <RowCover preset={entry.preset} worldId={entry.worldId} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`truncate text-body ${missing ? "text-ink-hint" : "text-ink"}`}>{name}</span>
              {entry.forkedFrom && (
                <span className="flex-none rounded-sm border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-meta tracking-[.12em] text-ink-hint">
                  {forkPhrase(entry.forkedFrom, worlds, presetTitle)}
                </span>
              )}
              {resyncing && (
                <span
                  data-testid={`world-resync-${entry.worldId}`}
                  className="flex-none rounded-sm border border-gold/40 px-1.5 py-0.5 text-meta tracking-[.12em] text-gold/90"
                >
                  待重同步
                </span>
              )}
            </div>
            <p className="mt-1 text-meta tracking-[.12em] text-ink-hint">
              第 {entry.chapterNo} 章 · {relativeTime(entry.lastPlayed)}
              {missing && <span className="ml-2 text-red-400/90">目录缺失</span>}
            </p>
            {/* 显示名与备注都有时，备注降为次行（分叉说明这类信息不该被显示名吃掉）。
                旧版 server 自动写的分叉备注是裸 id 串，不算备注——次行不铺（分叉关系看徽标） */}
            {entry.label?.trim() && entry.note?.trim() && !isLegacyForkNote(entry.note) && (
              <p data-testid={`world-note-${entry.worldId}`} className="mt-1 truncate text-meta text-ink-hint">
                {entry.note}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            data-testid={`world-continue-${entry.worldId}`}
            aria-label={`继续世界线 ${name}`}
            disabled={missing || engineBusy}
            title={missing ? "目录缺失" : engineBusy ? "忙碌中，稍后再试" : undefined}
            onClick={onContinue}
            className={`rounded-lg border px-3.5 py-1.5 text-ui tracking-[.1em] transition-colors ${
              missing || engineBusy
                ? "cursor-not-allowed border-white/10 text-ink-hint"
                : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
            }`}
          >
            {engineBusy ? "忙碌中" : "继续"}
          </button>

          {/* ⋯ 菜单（v1.9：迁到 Radix DropdownMenu，非 portal）。原语负责：↑↓/Home/End 的
              roving 走位、typeahead（按菜单项文案前缀匹配，默认 1s 内连击拼接）、
              role=menu/menuitem 与 aria-haspopup/aria-expanded/aria-controls、Esc 与点外面关闭
              （DismissableLayer：Esc 走 document 捕获阶段，我们在它那一拍 stopPropagation，
              见 swallowEscape）、开时焦点进第一项、关时焦点归还触发器、擦边时翻到触发器上方（flip）。
              本屏自己留的：删除的两段确认（收在菜单里）、导出下载的延后关、Tab 走位（见 onMenuKeyDown）。
              刻意**不** portal 到 body：主题 CSS 变量注入在 App 根容器而不是 :root，portal 出去
              会掉回 global.css 的初始 accent（见 docs/ROADMAP.md 第 3 项）。modal=false：
              菜单不是模态——不 aria-hidden 背景、不锁滚动、Tab 可以走出菜单。
              菜单按钮不是 roving 的一部分——每行都有自己的 Tab 位，读屏/键盘随时够得着 */}
          <div className="relative">
            <DropdownMenu.Root
              modal={false}
              open={menuOpen}
              onOpenChange={(next) => (next ? onOpenMenu() : onCloseMenu())}
            >
              <DropdownMenu.Trigger
                data-testid={`world-menu-${entry.worldId}`}
                aria-label={`世界线 ${name} 的更多操作`}
                className={`rounded-lg border px-3 py-1.5 text-ui tracking-[.1em] transition-colors ${
                  menuOpen
                    ? "border-gold/40 text-ink"
                    : "border-white/10 text-ink-hint hover:border-gold/40 hover:text-ink"
                }`}
              >
                ⋯
              </DropdownMenu.Trigger>

              <DropdownMenu.Content
                ref={attachMenuPopup}
                data-testid={`world-menu-popup-${entry.worldId}`}
                // 向下展开、右对齐、留 6px 缝（等价于原来的 right-0 mt-1）；贴到视口底边时 Radix 自动翻上去
                side="bottom"
                align="end"
                sideOffset={6}
                onEscapeKeyDown={swallowEscape}
                onCloseAutoFocus={onMenuCloseAutoFocus}
                onKeyDown={onMenuKeyDown}
                className="z-20 grid w-44 gap-0.5 shell-panel rounded-xl p-1"
              >
                {/* 两段式确认收在菜单里：首点「删除」变「确认删除/取消」，二点才发删除。
                    三项都 preventDefault 掉「选中即关」：确认态要留在菜单里，导出要等下载派发完 */}
                {confirming ? (
                  <>
                    <DropdownMenu.Item asChild disabled={deleting} onSelect={KEEP_MENU_OPEN} onClick={onDelete}>
                      <button
                        type="button"
                        data-testid={`world-confirm-${entry.worldId}`}
                        aria-label={`确认删除世界线 ${name}`}
                        disabled={deleting}
                        className={`${MENU_ITEM_CLS} text-red-300 hover:bg-red-500/20 hover:text-red-200 disabled:cursor-not-allowed disabled:text-ink-faint`}
                      >
                        {deleting ? "删除中…" : "确认删除"}
                      </button>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild disabled={deleting} onSelect={KEEP_MENU_OPEN} onClick={onCancelDelete}>
                      <button
                        type="button"
                        data-testid={`world-cancel-${entry.worldId}`}
                        aria-label={`取消删除世界线 ${name}`}
                        disabled={deleting}
                        className={`${MENU_ITEM_CLS} disabled:cursor-not-allowed disabled:text-ink-faint`}
                      >
                        取消
                      </button>
                    </DropdownMenu.Item>
                  </>
                ) : (
                  <>
                    <DropdownMenu.Item asChild onClick={onEditOpen}>
                      <button
                        type="button"
                        data-testid={`world-edit-${entry.worldId}`}
                        aria-label={`改名世界线 ${name}`}
                        className={MENU_ITEM_CLS}
                      >
                        改名
                      </button>
                    </DropdownMenu.Item>
                    {/* 导出走浏览器下载：href 指向 /api/worlds/export（服务端带 Content-Disposition），
                        download 属性给本地落盘兜一个 <worldId>.world.json 的名字。
                        关菜单推迟一拍：浏览器要等事件派发走完才执行 <a download> 的默认动作，
                        在这一拍里把它卸载掉会把下载掐掉；`onSelect` 的 preventDefault 是同一件事的另一半——
                        Radix 默认「选中即关」，不拦的话菜单在 click 那一拍就没了。 */}
                    <DropdownMenu.Item asChild onSelect={KEEP_MENU_OPEN}>
                      <a
                        href={worldExportUrl(entry.worldId)}
                        download={`${entry.worldId}.world.json`}
                        data-testid={`world-export-${entry.worldId}`}
                        aria-label={`导出世界线 ${name}`}
                        onClick={onExport}
                        className={`${MENU_ITEM_CLS} block`}
                      >
                        导出
                      </a>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild onSelect={KEEP_MENU_OPEN} onClick={onRequestDelete}>
                      <button
                        type="button"
                        data-testid={`world-delete-${entry.worldId}`}
                        aria-label={`删除世界线 ${name}`}
                        className={`${MENU_ITEM_CLS} hover:bg-red-500/15 hover:text-red-300`}
                      >
                        删除
                      </button>
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        </div>
      </div>

      {/* 行内改名：显示名（≤60）+ 备注（≤200），Enter 保存 / Esc 取消，留空即清除该字段。
          它是交互表单，同样不在 option 节点里（option 不许套可交互控件） */}
      {editing && (
        <div data-testid={`world-editor-${entry.worldId}`} className="mt-3 grid gap-2 border-t border-white/[.06] pt-3">
          <label className="flex items-center gap-2">
            <span className="w-14 flex-none text-meta tracking-[.2em] text-ink-hint">显示名</span>
            <input
              ref={labelRef}
              data-testid={`world-edit-label-${entry.worldId}`}
              aria-label={`显示名（${name}）`}
              maxLength={LABEL_MAX}
              value={editLabel}
              onChange={(e) => onEditLabelChange(e.target.value)}
              onKeyDown={onEditKey}
              placeholder="留空则回退为剧本名"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-panel-strong px-3 py-1.5 text-ui transition-colors focus:border-gold/35"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-14 flex-none text-meta tracking-[.2em] text-ink-hint">备注</span>
            <input
              data-testid={`world-edit-note-${entry.worldId}`}
              aria-label={`备注（${name}）`}
              maxLength={NOTE_MAX}
              value={editNote}
              onChange={(e) => onEditNoteChange(e.target.value)}
              onKeyDown={onEditKey}
              placeholder="留空则清除备注"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-panel-strong px-3 py-1.5 text-ui transition-colors focus:border-gold/35"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid={`world-edit-save-${entry.worldId}`}
              disabled={saving || worldBusy}
              onClick={onEditSave}
              className="rounded-lg border border-gold/35 bg-gold/15 px-4 py-1.5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              data-testid={`world-edit-cancel-${entry.worldId}`}
              disabled={saving}
              onClick={onEditCancel}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
            >
              取消
            </button>
            <span className="text-meta tracking-[.08em] text-ink-hint">Enter 保存 · Esc 取消 · 留空即清除</span>
          </div>
        </div>
      )}
    </motion.div>
  );
}
