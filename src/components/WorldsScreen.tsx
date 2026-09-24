import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { fetchWorlds, postWorld, type WorldEntry } from "../lib/acp";
import { layoutGenealogy } from "../lib/genealogy";
import { tabThroughMenu } from "../lib/menuTab";
import { useAsync } from "../lib/useAsync";
import { forkPhrase, relativeTime, worldDisplayName } from "../lib/worlds";
import { getTheme, themeVars } from "../theme";
import { useGameStore } from "../store/game";
import { ScreenShell } from "./ScreenShell";
import { ShellPage } from "./ShellPage";
import { GEN_NODE_H, GEN_NODE_W, GenealogyCanvas } from "./GenealogyCanvas";
import { WorldRow } from "./WorldRow";

/**
 * 世界线屏：选卡之后的第二环——继续某条世界线（读档续演）或开一条全新的（去捏人）。
 * 数据自己拉（fetchWorlds/preset 过滤），删除/新建/改名/导入走 POST /api/worlds；屏内不做任何推演。
 * v1.6：行内改名（label/note，空串=清除）、单条导出（浏览器下载）、打包导入（含成功/失败提示位），
 * 列表补 listbox/option 语义与 roving tabIndex，行内按钮带含世界名的 aria-label。
 * v1.7：列表/家谱视图切换——家谱把 forkedFrom 血缘画成 SVG 森林（`lib/genealogy` 纯函数布局，
 * 孤儿标「⌫ 父线已删」、fork 环容错），节点方向键走位 + Enter 选中，选中后的快捷条复用
 * `continueWorld` 继续；「查看」跳回列表并聚焦对应行。
 * v1.8：壳层页框（ShellPage：眉标 = 剧本名 + 题材/分级，右栏 = 继续上次 + 键盘）；行从「四个按钮平铺」
 * 收成**一个主行动（继续）+ 一个 ⋯ 菜单**（改名/导出/删除，删除的两段确认收在菜单内：菜单一关即作废）；
 * 文案去掉裸 id（`worldDisplayName`/`forkPhrase`），字号走 global.css 的档位类。
 * v1.8 家谱画布：缩放平移（滚轮锚点 / 拖拽 / 双击 / ± 与适应 / `+ - 0`，复用 `lib/treeLayout` 的
 * TreeView 纯函数）、渲染宽度只封上界（小森林不再把节点撑到 ~490px）、详情条吸底 +
 * 提示挂在画布工具条（1440×900 不滚动即可见）。
 * v1.9：行 ⋯ 菜单迁到 **Radix DropdownMenu**（`@radix-ui/react-dropdown-menu`，ROADMAP 第 3 项的第一面）。
 * 原语接走了手写的那几样：↑↓/Home/End 走位、typeahead、`role="menu"/menuitem` 与 `aria-haspopup/expanded/controls`、
 * Esc 与点外面关闭、开时焦点进第一项、关时焦点归还触发器、贴边自动翻面。因此**删掉**了手写的三处 document 级
 * 监听（mousedown 判点外 / 捕获阶段 Esc / focusin 出走）与 `menuUp` 的 offsetHeight 量高。
 * 两件本屏仍自己管：① Esc 靠 `onEscapeKeyDown` 就地 stopPropagation（Radix 在 document 捕获阶段监听，
 * 不拦就会继续冒到 App 挂在 window 上的 Esc 关闭链，那一下连整屏一起关回标题屏）；② Tab 走项
 * （Radix 的菜单项 tabIndex=-1 且内容会吞掉 Tab，见 `onMenuKeyDown`）。
 * 弹层**不 portal**：主题变量注入在 App 根容器而非 `:root`，portal 到 body 会掉回初始 accent。
 * v1.9 行缩略图（ROADMAP §5）：行首加 56×40 的剧本封面（`coverUrl(entry.preset)`，`/img` 白名单直服，
 * 零服务端改动，见 `WorldRow` 的 `RowCover`）——没有 cover.jpg 的剧本靠 `onError` 缩掉图片、只留同尺寸占位块，
 * 破图与行高抖动都不允许；`alt=""` + `pointer-events-none`（装饰性、不抢行的点击与键盘）。
 * v1.13：取数收进 `lib/useAsync`（统一 AbortController 与 `signal.aborted` 复查）；行与家谱画布拆到
 * `WorldRow`/`GenealogyCanvas` 两个文件；行内交互控件搬出 listbox 的 option 节点（见 `WorldRow` 文件头）。
 */
export default function WorldsScreen() {
  const selected = useGameStore((s) => s.selected);
  const engineBusy = useGameStore((s) => s.engineBusy);
  const worldNotice = useGameStore((s) => s.worldNotice);
  const worldBusy = useGameStore((s) => s.worldBusy);
  const clearWorldNotice = useGameStore((s) => s.clearWorldNotice);
  const updateWorld = useGameStore((s) => s.updateWorld);
  const importWorldText = useGameStore((s) => s.importWorldText);
  const toTitle = useGameStore((s) => s.toTitle);
  const beginNewWorld = useGameStore((s) => s.beginNewWorld);
  const resumeWorld = useGameStore((s) => s.resumeWorld);
  // 回退后的会话内标记：对应世界行内亮「待重同步」（该世界档已回退、引擎等一次续玩指令重读档）
  const pendingResync = useGameStore((s) => s.pendingResync);

  const presetId = selected?.id;
  /** 剧本标题：显示名与分叉说明的最后一道兜底（合成显示名只在屏内算，不进 store/服务端） */
  const presetTitle = selected?.title ?? "";

  /** 行内动作（删除/新建/导入文件读取）的错误文案：不占满屏，贴着列表展示 */
  const [actionError, setActionError] = useState("");
  /** 行内动作的成功提示（v1.7：删除进回收站后的去向说明），与错误同一位展示 */
  const [actionNotice, setActionNotice] = useState("");
  /** 键盘高亮的行下标 */
  const [focus, setFocus] = useState(0);
  /** 正在两段式确认删除的世界 id（null=无确认态，键盘导航让位于确认按钮） */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** 正在改名的世界 id（行内编辑器；null=无编辑器，键盘导航让位给输入框） */
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editNote, setEditNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  /** 视图（v1.7 家谱）：平铺列表 / forkedFrom 血缘森林；屏内状态，不持久化 */
  const [view, setView] = useState<"list" | "genealogy">("list");
  /** 家谱里选中的世界 id（选中 = 高亮 + 下方快捷信息条；null=未选中） */
  const [genFocus, setGenFocus] = useState<string | null>(null);
  /** 「查看」跳回列表后要聚焦的行（世界 id；effect 里消费一次即清） */
  const [listJumpId, setListJumpId] = useState<string | null>(null);
  /** 打开着 ⋯ 菜单的世界 id（同屏只开一个；null=全关） */
  const [menuId, setMenuId] = useState<string | null>(null);

  /** 行元素引用：↑↓ 把 DOM 焦点一起搬到光标行（roving tabIndex 的完整语义，不是只换个描边） */
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /** 隐藏 file input（导入入口按钮点它） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 打开编辑器时把光标送进「显示名」输入框 */
  const labelRef = useRef<HTMLInputElement | null>(null);
  /** 打开着的那行 ⋯ 菜单的弹层本体（把焦点送进第一项、Tab 走项都按它查菜单项） */
  const [menuPopup, setMenuPopup] = useState<HTMLDivElement | null>(null);
  /** 弹层节点的挂载回调：用 state 而不是 ref —— Radix 的 Presence 比本屏的状态晚一拍才把弹层挂上来，
   *  ref 在本屏那次 effect 里还是 null（拿不到节点就没法把焦点送进第一项），state 变更能再触发一轮 effect */
  const attachMenuPopup = useCallback((node: HTMLDivElement | null) => setMenuPopup(node), []);
  /**
   * 关菜单时**不要**把焦点归还触发器：焦点已经由我们自己安置（进改名编辑器 / Tab 走出菜单）。
   * Radix 在弹层卸载时默认把焦点送回触发器（DropdownMenuContent 的 onCloseAutoFocus），
   * 那一下会把玩家刚点开的输入框焦点甩掉（编辑器里打字打到一半光标就飞了）。
   */
  const keepFocusOnCloseRef = useRef(false);

  /**
   * 关菜单：同时撤销半截删除确认（重开菜单回到「改名/导出/删除」第一屏）。
   * 三条关法都汇到这里：Radix 的 onOpenChange(false)（Esc / 点外面 / 焦点出走 / 选中即关）。
   */
  const closeMenu = useCallback(() => {
    setMenuId(null);
    setConfirmId(null);
  }, []);

  // 挂载与换卡（selected.id 变）时拉清单；删除/改名/导入成功后 reload 重取。
  // key 只含 presetId——动作后重取走 reload（同一 key 下重跑），不占 key
  const worldsReq = useAsync((signal) => fetchWorlds(presetId, signal), `worlds:${presetId ?? ""}`);
  const list = useMemo(() => worldsReq.data ?? [], [worldsReq.data]);
  const worlds = worldsReq.data;
  const loading = worldsReq.loading;
  const error = worldsReq.error;
  const reload = worldsReq.reload;

  // 家谱布局（纯函数）：worlds 变化（删除/导入/改名重取）时重算
  const genealogy = useMemo(
    // 画布常量显式传进布局（StoryTreeScreen 的惯例）：单侧改尺寸不会让 rect 与坐标静默错位
    () => layoutGenealogy(list, { nodeW: GEN_NODE_W, nodeH: GEN_NODE_H }),
    [list],
  );

  /** aside「继续上次」的世界：清单里最近游玩的那条（不依赖 fetch 的排序，自己取最大 lastPlayed） */
  const lastWorld = useMemo(
    () => list.reduce<WorldEntry | null>((best, w) => (!best || w.lastPlayed > best.lastPlayed ? w : best), null),
    [list],
  );

  // 「查看」收尾：切回列表后把 DOM 焦点送到对应行（键盘用户从那里继续 ↑↓/Enter）
  useEffect(() => {
    if (view !== "list" || !listJumpId) return;
    rowRefs.current.get(listJumpId)?.focus();
    setListJumpId(null);
  }, [view, listJumpId]);

  // 进屏/换卡时清掉上一轮的提示条（否则「已导入世界线 x」会在下次进屏复读）
  useEffect(() => {
    clearWorldNotice();
  }, [presetId, clearWorldNotice]);

  // 清单长度变化：高亮下标越界时回到第一行
  useEffect(() => {
    setFocus((i) => (i < list.length ? i : 0));
  }, [list.length]);

  // 打开编辑器：把焦点送进显示名输入框（也方便键盘用户直接改）
  useEffect(() => {
    if (editId) labelRef.current?.focus();
  }, [editId]);

  // 菜单开着时把焦点送进第一项（键盘路径：⋯ 上 Enter → 菜单第一项已聚焦 → ↓ 走位/Tab 前进；
  // 鼠标路径 Radix 默认只把焦点落在弹层上，这里一并收齐，两种打开方式结果一致）。
  // confirmId 也进依赖：删除→确认这一拍里「第一项」变成了确认按钮，焦点要跟着换过去
  // （否则被替换掉的「删除」按钮会把焦点丢回 body）。
  useEffect(() => {
    if (!menuId || !menuPopup) return;
    menuPopup.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuId, confirmId, menuPopup]);

  /** 键盘：↑↓ 移动高亮，Enter 继续高亮的世界线；确认态/编辑态/菜单开着时全部让位。
   *  家谱视图下让位（方向键由家谱节点自己接，Enter 只选中不清档续演） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return; // 中文输入法组字中的按键不算导航
      if (view !== "list") return; // 家谱视图：节点级键盘，不做屏级列表导航
      if (confirmId || editId || menuId) return; // 确认删除/行内改名/菜单开着：不拦截
      const el = e.target instanceof HTMLElement ? e.target : null;
      // 焦点在按钮/输入框上时不做屏级导航，避免 Enter 被激活两次（⋯ 菜单项也在这条里）
      if (
        el &&
        (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      )
        return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(Math.max(focus + (e.key === "ArrowUp" ? -1 : 1), 0), Math.max(list.length - 1, 0));
        setFocus(next);
        const id = list[next]?.worldId;
        if (id) rowRefs.current.get(id)?.focus(); // 焦点跟着光标走（焦点回到行上时 onFocus 再确认一次同一行）
      } else if (e.key === "Enter") {
        const entry = list[focus];
        if (entry && entry.exists && !engineBusy) resumeWorld(entry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmId, editId, menuId, engineBusy, focus, list, resumeWorld, view]);

  /** 继续：目录缺失或引擎忙时不可用（resumeWorld 会立刻发续演指令） */
  const continueWorld = (entry: WorldEntry) => {
    if (!entry.exists || engineBusy) return;
    resumeWorld(entry);
  };

  /**
   * ⋯ 开菜单：清掉上一次的行内提示，半截删除确认归零。
   * 开/关的切换交给 Radix 的触发器（pointerdown 与 Enter/Space/↓），屏内只接 onOpenChange。
   */
  const openMenuFor = (entry: WorldEntry) => {
    setActionError("");
    setActionNotice("");
    setConfirmId(null);
    setMenuId(entry.worldId);
  };

  /**
   * 菜单内容区的键盘：Tab 在菜单项之间走位（本仓既有约定：Tab 走项、Esc 收菜单，见
   * tests/e2e-ui/worlds.spec.ts 的键盘用例；键位速查卡里也写着「Tab 行内按钮与 ⋯ 菜单」）。
   * 走位本体在 lib/menuTab（命令轨的分组菜单同样吃它，两个菜单的键位只有一套）；这里只剩组字让路。
   */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) {
      event.preventDefault(); // 中文输入法组字中的按键不算导航/typeahead（本仓惯例）
      return;
    }
    if (event.key !== "Tab") return;
    tabThroughMenu(event.nativeEvent, event.currentTarget);
  };

  /** 弹层卸载时 Radix 默认把焦点送回触发器；玩家进的是行内编辑器时别抢（见 keepFocusOnCloseRef） */
  const onMenuCloseAutoFocus = (event: Event) => {
    if (!keepFocusOnCloseRef.current) return;
    keepFocusOnCloseRef.current = false;
    event.preventDefault();
  };

  /** 新建世界线：id 由 server 分配，成功才带着 id 去捏人；失败留在本屏展示错误 */
  const createWorld = () => {
    if (!presetId || creating) return;
    setCreating(true);
    setActionError("");
    setActionNotice("");
    postWorld({ action: "create", preset: presetId })
      .then((r) => {
        if (!r.ok || !r.worldId) {
          setActionError(`新建世界线失败：${r.error ?? "未知错误"}`);
          setCreating(false);
          return;
        }
        beginNewWorld(r.worldId);
      })
      .catch((e: unknown) => {
        setActionError(`新建世界线失败：${String(e)}`);
        setCreating(false);
      });
  };

  /** 删除（第二段确认触发）：成功即重取清单并提示去向（回收站可找回），失败在列表上方行内报错 */
  const removeWorld = (entry: WorldEntry) => {
    if (deleting) return;
    setDeleting(entry.worldId);
    setActionError("");
    setActionNotice("");
    postWorld({ action: "delete", worldId: entry.worldId })
      .then((r) => {
        if (!r.ok) {
          setActionError(`删除失败：${r.error ?? "未知错误"}`);
          setDeleting(null);
          return;
        }
        closeMenu();
        setDeleting(null);
        // trashed:false = 回收站 rename 失败、服务端已回退直删——文案不能再说「可找回」
        setActionNotice(r.trashed === false ? "已删除（未能进回收站，无法找回）" : "已移入回收站，可从数据目录找回");
        reload();
      })
      .catch((e: unknown) => {
        setActionError(`删除失败：${String(e)}`);
        setDeleting(null);
      });
  };

  /** 打开行内改名编辑器：字段初值取服务端现值（缺省空串=未设置），保存时原样回传（空串=清除） */
  const openEdit = (entry: WorldEntry) => {
    setActionError("");
    setActionNotice("");
    clearWorldNotice();
    setEditLabel(entry.label ?? "");
    setEditNote(entry.note ?? "");
    setEditId(entry.worldId);
  };

  /** 保存改名：成功后重取清单（回显以服务端落定的值为准），失败留在编辑态由提示位说明 */
  const saveEdit = (entry: WorldEntry) => {
    if (saving) return;
    setSaving(true);
    updateWorld({ worldId: entry.worldId, label: editLabel.trim(), note: editNote.trim() })
      .then((r) => {
        setSaving(false);
        if (!r.ok) return; // 失败不关编辑器：玩家改的内容还在
        setEditId(null);
        reload();
      })
      .catch(() => setSaving(false)); // updateWorld 内部已兜异常，这里只是双保险
  };

  /** 编辑器键盘：Enter 保存、Esc 取消；中文输入法组字中的 Enter 不算保存 */
  const onEditKey = (e: ReactKeyboardEvent<HTMLInputElement>, entry: WorldEntry) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      saveEdit(entry);
    } else if (e.key === "Escape") {
      // 就地收尾，别冒到 App 的 Esc 关闭链（那一下会直接回标题屏）
      e.preventDefault();
      e.stopPropagation();
      setEditId(null);
    }
  };

  /** 导入：读文件原文 → store 校验+POST；成功重取清单，失败由提示位/行内错误说明 */
  const onImportPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许连续导入同一个文件（不清值浏览器不会再触发 change）
    if (!file || importing) return;
    setActionError("");
    setActionNotice("");
    clearWorldNotice();
    setImporting(true);
    try {
      const text = await file.text();
      const r = await importWorldText(text);
      if (r.ok) reload(); // 导入成功：重取清单，新世界线立刻可见
    } catch (err) {
      setActionError(`导入失败：${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  /** aside「键盘」卡的提示行：视图不同、可用键不同（与页脚那条一句话提示互补） */
  const keyHints: [string, string][] =
    view === "list"
      ? [
          ["↑ ↓", "选择世界线"],
          ["Enter", "读档续演"],
          ["Tab", "行内按钮与 ⋯ 菜单"],
          ["Esc", "关菜单 / 返回标题"],
        ]
      : [
          ["方向键", "走血缘节点"],
          ["Enter", "选中节点"],
          ["+ − 0", "缩放 / 适应"],
          ["Tab", "快捷条按钮"],
          ["Esc", "返回标题"],
        ];

  return (
    <ScreenShell className="overflow-y-auto shell-backdrop" style={themeVars(getTheme(selected))}>
      <div data-testid="worlds-screen" className="min-h-full">
        <ShellPage
          // 眉标：剧本名 + 题材/分级（不再用药丸，评级不是标签墙而是这一行的元信息）
          eyebrow={
            selected ? (
              <>
                {selected.title}
                <span className="text-ink-hint">
                  {" "}
                  · {selected.genre} · {selected.rating}
                </span>
              </>
            ) : undefined
          }
          title="世 界 线"
          aside={
            <div className="space-y-4 xl:sticky xl:top-8">
              {/* 继续上次：最近游玩的那条（aside 里的快捷入口，复用行上那个 continueWorld） */}
              <section data-testid="worlds-resume-card" className="shell-panel rounded-2xl p-4">
                <h2 className="text-ui tracking-[.25em] text-gold/80">继 续 上 次</h2>
                {lastWorld ? (
                  <>
                    <p className={`mt-3 truncate text-body ${lastWorld.exists ? "text-ink" : "text-ink-hint"}`}>
                      {worldDisplayName(lastWorld, presetTitle)}
                    </p>
                    <p className="mt-1 text-meta text-ink-hint">
                      第 {lastWorld.chapterNo} 章 · {relativeTime(lastWorld.lastPlayed)}
                      {!lastWorld.exists && <span className="ml-2 text-red-400/90">目录缺失</span>}
                    </p>
                    <button
                      type="button"
                      data-testid="worlds-resume-continue"
                      aria-label={`继续上次的世界线 ${worldDisplayName(lastWorld, presetTitle)}`}
                      disabled={!lastWorld.exists || engineBusy}
                      title={!lastWorld.exists ? "目录缺失" : engineBusy ? "忙碌中，稍后再试" : undefined}
                      onClick={() => continueWorld(lastWorld)}
                      className={`mt-3 w-full rounded-lg border px-4 py-2 text-ui tracking-[.1em] transition-colors ${
                        !lastWorld.exists || engineBusy
                          ? "cursor-not-allowed border-white/10 text-ink-hint"
                          : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                      }`}
                    >
                      {engineBusy ? "忙碌中" : "继续"}
                    </button>
                  </>
                ) : (
                  <p className="mt-3 text-meta leading-relaxed text-ink-hint">
                    开一条新世界线后，最近游玩的那条会出现在这里。
                  </p>
                )}
              </section>

              {/* 键盘卡：屏级快捷键的速查（行内 ⋯ 菜单是行上的入口，不占列表宽度） */}
              <section data-testid="worlds-keys-card" className="shell-panel rounded-2xl p-4">
                <h2 className="text-ui tracking-[.25em] text-gold/80">键 盘</h2>
                <dl className="mt-3 grid gap-1.5">
                  {keyHints.map(([key, hint]) => (
                    <div key={key} className="flex gap-3 text-meta">
                      <dt className="w-16 flex-none text-ink-body">{key}</dt>
                      <dd className="min-w-0 text-ink-hint">{hint}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          }
          actions={
            <>
              {/* 视图切换（v1.7）：平铺列表 ↔ forkedFrom 家谱森林（分段按钮） */}
              <div
                role="group"
                aria-label="世界线视图"
                className="flex items-center rounded-lg border border-white/10 p-0.5"
              >
                <button
                  type="button"
                  data-testid="worlds-view-list"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                  className={`rounded-md px-3 py-1 text-ui tracking-[.15em] transition-colors ${
                    view === "list" ? "bg-gold/15 text-gold" : "text-ink-hint hover:text-ink"
                  }`}
                >
                  列表
                </button>
                <button
                  type="button"
                  data-testid="worlds-view-genealogy"
                  aria-pressed={view === "genealogy"}
                  onClick={() => setView("genealogy")}
                  className={`rounded-md px-3 py-1 text-ui tracking-[.15em] transition-colors ${
                    view === "genealogy" ? "bg-gold/15 text-gold" : "text-ink-hint hover:text-ink"
                  }`}
                >
                  家谱
                </button>
              </div>
              <button
                type="button"
                data-testid="worlds-import"
                disabled={importing || worldBusy}
                onClick={() => fileRef.current?.click()}
                className="rounded-lg border border-white/10 px-4 py-2 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
              >
                {importing ? "导入中…" : "导入"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                data-testid="worlds-import-input"
                className="hidden"
                onChange={onImportPick}
              />
              <button
                type="button"
                data-testid="worlds-new"
                disabled={!presetId || creating}
                onClick={createWorld}
                className="rounded-lg border border-gold/35 bg-gold/15 px-5 py-2 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-ink-faint"
              >
                {creating ? "创建中…" : "新世界线"}
              </button>
              <button
                type="button"
                onClick={toTitle}
                className="rounded-lg border border-white/10 px-4 py-2 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-[color:var(--accent)]"
              >
                返回
              </button>
            </>
          }
          // 家谱视图不铺页脚：画布会把页脚顶到折叠线以下，那里的提示改挂在画布工具条上（始终可见）
          footer={view === "list" ? "↑ ↓ 选择 · Enter 继续" : undefined}
        >
          {selected?.tagline && (
            <p className="mb-5 max-w-3xl text-ui leading-relaxed text-ink-body">{selected.tagline}</p>
          )}

          {/* 提示位：导入/改名的成功与失败（删除/新建的行内提示在下面） */}
          {worldNotice && (
            <p
              data-testid="worlds-notice"
              data-kind={worldNotice.kind}
              role="status"
              className={`mb-3 rounded-xl border px-4 py-2.5 text-ui leading-relaxed backdrop-blur-md ${
                worldNotice.kind === "error"
                  ? "border-red-400/25 bg-panel text-red-400"
                  : "border-gold/25 bg-gold/10 text-gold/90"
              }`}
            >
              {worldNotice.text}
            </p>
          )}

          {/* 行内动作提示：错误（红）与删除成功的回收站去向（金）各一行 */}
          {actionError && <p className="mb-3 text-ui text-red-400">{actionError}</p>}
          {actionNotice && <p className="mb-3 text-ui text-gold/80">{actionNotice}</p>}

          {/* 加载 / 失败态 */}
          {loading && worlds === null && !error && (
            <p className="mb-3 animate-pulse text-ui text-ink-hint">清点世界线…</p>
          )}
          {error && (
            <div
              data-testid="worlds-error"
              className="mb-3 flex items-center gap-3 rounded-xl border border-red-400/25 bg-panel px-4 py-3 backdrop-blur-md"
            >
              <p role="status" className="text-ui text-red-400">
                世界线加载失败：{error}
              </p>
              <button
                type="button"
                data-testid="worlds-retry"
                onClick={reload}
                className="ml-auto flex-none rounded-md border border-gold/35 px-3 py-1.5 text-ui tracking-[.1em] text-gold transition-colors hover:bg-gold/20"
              >
                重试
              </button>
            </div>
          )}

          {/* 空态 */}
          {!error && worlds !== null && list.length === 0 && (
            <div
              data-testid="worlds-empty"
              className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/15 bg-panel px-6 py-10 backdrop-blur-md"
            >
              <p className="text-body tracking-[.12em] text-ink-hint">还没有世界线——开始新的吧</p>
              <p className="text-meta tracking-[.2em] text-ink-hint">新世界线从捏人开始</p>
            </div>
          )}

          {/* 世界列表（列表视图）：listbox + option，光标行独占 tabIndex 0（roving tabIndex）。
              行上一个主行动（继续）+ 一个 ⋯ 菜单（改名/导出/删除）；菜单按钮恒在自己的 Tab 位
              （tabIndex 0），行的 roving 只管行本身。
              家谱视图下整块卸载：行的存在与否就是视图状态本身（测试与读屏都以此为准） */}
          {view === "list" && (
            <div role="listbox" aria-label="世界线" className="space-y-2.5">
              {list.map((entry, i) => {
                const editing = editId === entry.worldId;
                return (
                  <WorldRow
                    key={entry.worldId}
                    entry={entry}
                    focused={i === focus}
                    presetTitle={presetTitle}
                    worlds={list}
                    engineBusy={engineBusy}
                    resyncing={pendingResync?.worldId === entry.worldId}
                    confirming={confirmId === entry.worldId}
                    deleting={deleting === entry.worldId}
                    editing={editing}
                    menuOpen={menuId === entry.worldId}
                    editLabel={editLabel}
                    editNote={editNote}
                    saving={saving}
                    worldBusy={worldBusy}
                    rowRef={(el) => {
                      // 取消挂载/换行时清掉引用，别把脱管元素留在 Map 里
                      if (el) rowRefs.current.set(entry.worldId, el);
                      else rowRefs.current.delete(entry.worldId);
                    }}
                    labelRef={labelRef}
                    attachMenuPopup={attachMenuPopup}
                    onHover={() => setFocus(i)}
                    onFocusRow={() => setFocus(i)}
                    onClickRow={() => setFocus(i)}
                    onContinue={() => continueWorld(entry)}
                    onOpenMenu={() => openMenuFor(entry)}
                    onCloseMenu={closeMenu}
                    onMenuKeyDown={onMenuKeyDown}
                    onMenuCloseAutoFocus={onMenuCloseAutoFocus}
                    onEditOpen={() => {
                      // 关菜单后焦点归输入框（不是触发器）——Radix 的关闭自动对焦要因此让开
                      keepFocusOnCloseRef.current = true;
                      closeMenu();
                      // 该行已经在改名：只把光标送回输入框，别用服务端现值盖掉玩家还没保存的改动
                      if (editing) labelRef.current?.focus();
                      else openEdit(entry);
                    }}
                    onEditSave={() => saveEdit(entry)}
                    onEditKey={(e) => onEditKey(e, entry)}
                    onDelete={() => removeWorld(entry)}
                    onCancelDelete={() => setConfirmId(null)}
                    onRequestDelete={() => {
                      setActionError("");
                      setActionNotice("");
                      setConfirmId(entry.worldId);
                    }}
                    onEditCancel={() => setEditId(null)}
                    onEditLabelChange={setEditLabel}
                    onEditNoteChange={setEditNote}
                    onExport={() => window.setTimeout(closeMenu, 0)}
                  />
                );
              })}
            </div>
          )}

          {/* 家谱视图（v1.7 / v1.8 缩放平移）：SVG 森林 + 选中节点的快捷信息条
              （继续复用 continueWorld，不另起一份逻辑）。
              详情条 sticky bottom-0：画布高时「继续/查看」也钉在视口底边 —— 不吸底就得先滚到底才够得着 */}
          {view === "genealogy" && list.length > 0 && (
            <div className="pb-1">
              <GenealogyCanvas
                layout={genealogy}
                worlds={list}
                presetTitle={presetTitle}
                focusId={genFocus}
                onFocus={setGenFocus}
              />
              {(() => {
                const entry = list.find((w) => w.worldId === genFocus);
                if (!entry) return null;
                const name = worldDisplayName(entry, presetTitle);
                const missing = !entry.exists;
                const node = genealogy.nodes.find((n) => n.worldId === entry.worldId);
                return (
                  <div
                    data-testid="genealogy-detail"
                    // 吸底时要压在画布上，故底色取近实底（半透面板会让按钮与边线糊在一起）
                    className="sticky bottom-0 z-10 mt-3 rounded-xl border border-white/10 bg-panel-strong px-4 py-3 backdrop-blur-md"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className={`text-body ${missing ? "text-ink-hint" : "text-ink"}`}>{name}</span>
                      <span className="text-meta tracking-[.12em] text-ink-hint">
                        第 {entry.chapterNo} 章 · {relativeTime(entry.lastPlayed)}
                        {missing && <span className="ml-2 text-red-400/90">目录缺失</span>}
                      </span>
                      {entry.forkedFrom && !node?.missingParent && (
                        <span className="rounded-sm border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-meta tracking-[.12em] text-ink-hint">
                          {forkPhrase(entry.forkedFrom, list, presetTitle)}
                        </span>
                      )}
                      {node?.missingParent && (
                        <span className="rounded-sm border border-red-400/30 px-1.5 py-0.5 text-meta tracking-[.12em] text-red-300/90">
                          ⌫ 父线已删
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        <button
                          type="button"
                          data-testid={`genealogy-continue-${entry.worldId}`}
                          aria-label={`继续世界线 ${name}`}
                          disabled={missing || engineBusy}
                          onClick={() => continueWorld(entry)}
                          className={`rounded-lg border px-3.5 py-1.5 text-ui tracking-[.1em] transition-colors ${
                            missing || engineBusy
                              ? "cursor-not-allowed border-white/10 text-ink-hint"
                              : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
                          }`}
                        >
                          {engineBusy ? "忙碌中" : "继续"}
                        </button>
                        <button
                          type="button"
                          data-testid={`genealogy-view-${entry.worldId}`}
                          aria-label={`在列表中查看世界线 ${name}`}
                          onClick={() => {
                            const idx = list.findIndex((w) => w.worldId === entry.worldId);
                            setView("list");
                            if (idx >= 0) {
                              setFocus(idx);
                              setListJumpId(entry.worldId);
                            }
                          }}
                          className="rounded-lg border border-white/10 px-3 py-1.5 text-ui tracking-[.1em] text-ink-hint transition-colors hover:border-gold/40 hover:text-ink"
                        >
                          查看
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </ShellPage>
      </div>
    </ScreenShell>
  );
}
