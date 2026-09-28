// store 的类型层（v1.6 slice 拆分抽出）：只放类型，不带运行时值——
// 这样 slices/* 与 context.ts 都能 `import type` 取用，不会与 game.ts 形成运行时循环依赖。
// 对外 API 不变：game.ts 原样 `export type {...} from "./types"`，组件与测试的 import 路径不动。
import type { AssetEntry, LogEntry, Preset, StateView, WorldEntry, WorldPostResult, AcpEvent } from "../lib/acp";
import type { ArtKind, GameOption } from "../lib/parser";
import type { GameSettings } from "../lib/settings";

export type Screen =
  | "boot"
  | "title"
  | "worlds"
  | "protagonist"
  | "crafting"
  | "game"
  | "assets"
  | "creation"
  | "tree"
  | "settings"
  | "check";

/** 制作中屏单个槽位的生命周期 */
export type PreloadItemState = "pending" | "running" | "done" | "failed" | "skipped";

export interface PreloadItem {
  kind: "portrait" | "background";
  /** 立绘=角色名[-变体]（清单原文，指令与 artReady 槽位用它）；背景=地点名 */
  name: string;
  /** 立绘差分变体名（基础项为空串）：差分【图】标记不替换主立绘 */
  variant: string;
  /** 槽位显示名：差分拆开为「薇拉 · 微笑」，基础/背景原样 */
  label: string;
  /** 发给引擎的分项指令原文 */
  command: string;
  state: PreloadItemState;
  /** /api/assets 预过滤命中的持久化资产 url；正常流程由【图】标记回填 artReady */
  url: string | null;
}

/**
 * 立绘画面状态：url 指向当前显示图（基础或差分），baseUrl 恒为基础立绘（差分 404 时回退）。
 * 同一角色在画面里最多一个槽位（{@link GameStore.portraits} 里按名字归一化去重）。
 */
export interface PortraitState {
  name: string;
  /** 当前差分变体名（基础立绘为空串） */
  variant: string;
  /** 当前显示图 URL（variant 非空时为差分文件，可能 404——由 PortraitLayer 回退） */
  url: string;
  /** 基础立绘 URL（差分未生成时的回退目标） */
  baseUrl: string;
}

/**
 * 制作中阶段：init=开局指令待命中；planning=规划回合进行中（等制作清单）；
 * queue=按清单逐项美术；starting=已发/待发「开演。」；finished=进入游戏
 */
export type PreloadPhase = "init" | "planning" | "queue" | "starting" | "finished";

/** 正文幕：「第 N 幕」+ 过滤协议行后的回合正文（v1.13：kind 收成必填，与回退分割线构成真判别联合） */
export interface HistoryEntry {
  kind: "act";
  n: string;
  t: string;
}

/**
 * 回退分割线（非破坏式回退标记）：restoreSnapshot 成功时插进 history，**不删除**之前的任何幕——
 * 渲染层把标记之前的幕降不透明度、标记本身画成居中细线「—— 已回溯到第 N 幕 ——」。
 */
export interface HistoryRollbackMark {
  kind: "rollback";
  /** 回退到的目标快照 seq */
  seq: number;
  /** 落标记的时刻（ms） */
  at: number;
  /** 分割线来历：缺省/restore=剧情图原地回退（「已回溯到第 N 幕」）；reroll=重演这一幕（「第 N 幕已重演」） */
  reason?: "restore" | "reroll";
}

/** 历史条目：正文幕（HistoryEntry）或回退分割线（HistoryRollbackMark），按 kind 判别 */
export type HistoryItem = HistoryEntry | HistoryRollbackMark;

/**
 * 一个回合引发的数值变化（v1.14，因果反馈）：`排异指数 65 → 73 ↑`。
 * favor 走结构化数值；flags 走「值里首个整数」的口径（抽不到数值就跳过——那种变化说不清大小）。
 * 只有**真的变了**的项才进列表；一项都没有（或首次拿到 stateView、无从比较）时整份是 null。
 * `dir` 为契约保留的第三态「same」：数值相同的项不入列，当前只产 up/down。
 */
export interface TurnDelta {
  name: string;
  from: string;
  to: string;
  dir: "up" | "down" | "same";
}

/**
 * 磁盘回合日志的分页态（v1.14 回想接磁盘）：`logs/NNNN.json` 只写不删，历史抽屉按页往下翻。
 * `entries` 最新在前、逐页追加；`nextBefore` 为 null = 已到最早一页；`loadedOnce` 区分
 * 「还没翻过」与「翻过且到底了」（前者首翻给最近一页）。
 */
export interface DiskHistory {
  entries: LogEntry[];
  nextBefore: number | null;
  loading: boolean;
  error: string | null;
  loadedOnce: boolean;
}

/** 前情提要的一条：`n` = 该回合的 seq（summary 那一条为 null，渲染层当引言） */
export interface RecapEntry {
  n: number | null;
  t: string;
}

/**
 * 前情提要的数据（v1.14，本地合成、零引擎回合）：元命令 `/recap` 本地化后的产物。
 * 数据源 = `fetchLogs` 最近 5 条 + `fetchState`（时间/地点）+ 最新一条快照的 summary——
 * summary 形状上不单独占字段，作为 `entries` 的首项（`n: null`）呈现；取不到就不给这一项。
 * `loaded:false` = 还在取；`error` 非空 = 取数失败（面板显示原因，不留白）。
 */
export interface RecapData {
  loaded: boolean;
  error: string | null;
  chapterNo: number | null;
  time: string | null;
  scene: string | null;
  entries: RecapEntry[];
}

/** 创作模式对话流的一条消息 */
export interface CreationMessage {
  role: "engine" | "player";
  text: string;
}

/**
 * 屏内提示条（世界线屏 / 画廊共用位）。kind 只决定配色：失败一律 error，
 * 文案里已经写清「什么失败」，组件不再解析字符串判断语气。
 */
export interface Notice {
  kind: "ok" | "error";
  text: string;
}

/** 顺序重绘队列里的一项（与单项 startRegen 的三元组同源，队列化后仍逐条走同一条流水线） */
export interface RegenJob {
  type: ArtKind;
  key: string;
  matchName: string;
  /** 玩家要求（一句人话，v1.12；空/缺省 = 盲重绘——批量重绘恒为盲重绘） */
  note?: string;
}

export interface GameStore {
  screen: Screen;
  /** overlay 屏（assets/creation）的返回目标 */
  screenReturn: Screen | null;
  selected: Preset | null;
  /** /api/presets 的轮播数据（TitleScreen 挂载、presetAdded 与剧本导入成功时刷新） */
  presets: Preset[];
  /**
   * 标题屏卡带轮播的当前下标（v1.14 从 TitleScreen 的屏内 state 提到 store）：
   * 屏重挂（App 的 keyed 重挂 / 切屏回来）后轮播停在原处，不再每次回到第一张。
   * 越界由 TitleScreen 的收敛 effect 夹回范围（删卡 / 轮播刷新后可能越界）。
   */
  titleIndex: number;
  /** 标题屏提示位：剧本导入的成功/失败（v1.7；失败 kind=error） */
  titleNotice: Notice | null;
  /** shortName -> 已选选项（多选按选择顺序） */
  cardAnswers: Record<string, string[]>;
  status: string;

  /** turn_start / 段切换时自增，对话组件据此重置打字机 */
  turnKey: number;
  received: string;
  finalText: string;
  options: GameOption[] | null;
  typingDone: boolean;
  /**
   * 已经「完整展示过」的那一幕的打字机键（v1.14）：键 = {@link turnKey} 的字符串形态。
   * 屏切换（App 的 keyed 重挂）会把 DialogueBox 整棵子树重建、shown 归零，于是同一幕再打字一遍；
   * 记住这个键之后，重挂时由消费方直接播种全文（见 `markTypingDone`）。
   * 新回合/换段（turnKey 变化）即与之不匹配，自然重播；换局随 resetRunState 清空。
   */
  typingDoneKey: string | null;

  bgUrl: string | null;
  /**
   * 同屏立绘队列（v1.9）：数组顺序 = 出场/发言新旧顺序（渲染左→右），**末位 = 当前发言者**
   * （名牌归它、全亮；其余压暗缩小）。上限 {@link MAX_STAGE}，入队与淘汰只经 applyExpression。
   * 空数组 = 屏上无立绘（GameStage 据此决定是否给对话区让位）。
   */
  portraits: PortraitState[];
  /** 预载阶段的名字槽位 -> 图片 URL；空串 = 未就绪。非预载开局为空对象 */
  artReady: Record<string, string>;

  /** 制作中屏的美术队列（规划回合后由制作清单构建；空数组 = 尚在规划/非制作开局） */
  preload: PreloadItem[];
  preloadPhase: PreloadPhase;
  /**
   * 本批美术的起点时刻（建队列那一刻，ms；null = 没有在跑的批次）：屏上据此算「平均每张 / 约还需」。
   * 只服务可预期性（v1.13）——不参与流程判定，失败/跳过项也不会写它。
   */
  preloadBatchStartedAt: number | null;
  /** 当前制作中的章号（开局=1；章标记后=N+1） */
  chapterNo: number;
  /**
   * 延迟补画队列（v1.13 两段式）：规划后**没进开场子集**的清单项（差分、别的地点/角色…）。
   * 开场后每次引擎空闲由 pumpDeferredArt 取一项补画；跨章保留（下一章的清单只列本章新增项，
   * 不保留就永久丢），换世界线/换剧本/重开由 resetRunState 清零。
   */
  deferredArt: PreloadItem[];
  /**
   * 当前这回合是「后台补画」的指令回合（v1.13）：正文不进历史、标记不换画面（只记槽位），
   * 玩家这一轮的操作进 pendingPlayerPrompt 排队。由 pumpDeferredArt 置位、turn_end 清除。
   */
  artAsk: boolean;
  /**
   * 玩家在补画期间（引擎忙且 artAsk）的输入：单槽、**后到覆盖**（玩家改主意比锁死第一次合理），
   * turn_end 时**优先于补画**补发；换世界线/换剧本/重开随 resetRunState 清空。
   */
  pendingPlayerPrompt: string | null;
  /** 玩家在 init/planning 期间按了跳过：该回合结束后直接「开演。」 */
  skipRequested: boolean;
  /** 引擎回合进行中（turn_start→turn_end/error）；skip 时用来判断能否立即推进 */
  engineBusy: boolean;

  history: HistoryItem[];
  drawerOpen: boolean;

  // —— v1.7 角色面板（游戏屏侧栏抽屉）——
  /** 角色面板抽屉开合（TopBar「角色」轨按钮 / Esc 链；开时拉一次 /api/state） */
  charactersOpen: boolean;
  /** 最近一次拉到的 state.md 解析视图；null = 还没拉到（404 或失败）——面板显示空态文案 */
  stateView: StateView | null;
  /**
   * 上一次拉到的 state.md 视图（v1.14 数值差分的比较基线）：与 {@link stateView} 同批写入，
   * 回合收尾重拉时拿它与新的一份对比产出 {@link lastTurnDeltas}。换局随 resetRunState 清空
   * （跨世界比较毫无意义）。
   */
  prevStateView: StateView | null;
  /**
   * 上一个回合引发的数值变化（v1.14）：`turn_end` 收尾重拉 state.md 时与上一份对比得出；
   * 无变化、首次拿到视图（无从比较）或本轮不是正戏回合时为 null。只读——D 泳道据此画差分条。
   */
  lastTurnDeltas: TurnDelta[] | null;

  // —— v1.14 章待办 & 本地面板（帮助/前情提要）——
  /**
   * 待规划的章号（v1.14）：收到【章】标记时**始终**记下（= 该标记的章号 + 1，沿用 beginPlanning 的口径），
   * 在 game 屏即刻切制作中屏规划；在其它屏（画廊/设置/剧情图 overlay 等）只记待办，
   * 等回到 game 屏（且引擎空闲）由 context.consumePendingChapter 消费。null = 没有待规划章。
   */
  pendingChapter: number | null;
  /** 帮助面板（v1.14 本地化 /help）：纯前端开关，不占引擎回合 */
  helpOpen: boolean;
  /** 前情提要面板（v1.14 本地化 /recap）：纯前端开关，数据见 {@link recapData} */
  recapOpen: boolean;
  /** 前情提要的数据（打开时本地合成一次；null = 从未打开过） */
  recapData: RecapData | null;

  // —— v1.14 磁盘历史与回合对账 ——
  /**
   * 磁盘回合日志的分页态（回想接磁盘）：`/api/logs` 逐页往下翻，来源是 `logs/NNNN.json`
   * （append-only，不进导出包）——内存 history 只活本会话，磁盘这份才跨刷新。换局清空。
   */
  diskHistory: DiskHistory;
  /**
   * 当前回合的服务端序号（v1.14）：`turn_start` 带 `turn` 时落它，`turn_end`/`error`/`turn_cancelled`
   * 清除。带 `turn` 的 chunk 与之不符即丢弃——SSE 重连或取消后迟到的旧回合片段不许污染新回合。
   * null = 未知（更老的 server 不发 turn，此时不做任何回合校验，行为与 v1.13 逐字一致）。
   */
  currentTurn: number | null;
  /**
   * SSE 事件流断开（v1.14，App 的 onConn("error") 回调置位）：顶栏据此亮一处「连接中断」提示，
   * 重连成功（onConn("open") → {@link GameStore.reconcileAfterReconnect}）即复位。
   * 刻意不带 aria-live —— 状态播报归 StatusAnnouncer（sr-status），这里只是一处可见提示，别抢读屏的播报。
   */
  sseDown: boolean;

  // —— 创作模式（creation 屏）——
  creationMessages: CreationMessage[];
  /** 已发「装配。」，等待【图】标记与【新剧本】 */
  assembling: boolean;
  /** 装配回合结束/出错但没收到 presetAdded：可重试 */
  assemblyStalled: boolean;
  /** 装配清单点亮：封面 + 已就位的基础立绘（来自【图】标记） */
  creationCover: boolean;
  creationPortraits: string[];
  /** 【新剧本】事件带回的新剧本 id（成功态） */
  creationResult: string | null;

  // —— 画廊（assets 屏）——
  /** 正在重绘的资产 key（`类型|标记名`）；null=无进行中的重绘 */
  regenPending: string | null;
  /** 重绘完成（标记或回合结束）自增：AssetsScreen 据此刷新清单与破缓存 */
  assetsStamp: number;
  /** 画廊大图预览（Esc 关闭链第一环） */
  assetsPreview: AssetEntry | null;

  // —— 画廊批量（v1.6）——
  /** 顺序重绘队列里**待跑**的项（正在跑的那条看 regenPending） */
  regenQueue: RegenJob[];
  /** 本批重绘总数（0=当前没有批次；单项重绘退化为 1） */
  regenTotal: number;
  /** 本批已收尾条数（已换图 + 未确认），UI 据此显示「重绘中 i/N」 */
  regenDone: number;
  /** 本批未确认/出错的项 key（`类型|标记名`），收尾提示里点名 */
  regenFailed: string[];
  /** 批量重绘收尾提示（下一批开始时覆盖） */
  regenNotice: Notice | null;
  /** 批量删除在途（工具栏按钮禁用） */
  assetsBusy: boolean;
  /** 画廊批量操作提示（删除结果） */
  assetsNotice: Notice | null;

  // —— v1.4 UX——
  /** 创作屏引擎忙时排队的消息（turn_end 后自动补发，玩家气泡先出） */
  pendingCreationMessage: string | null;
  /** 创作屏退出确认（Esc 链第三环） */
  creationExitPrompt: boolean;
  /** 本回合起算时间戳（耗时显示；null=回合未进行；段切换不重置，回合才重置） */
  turnStartAt: number | null;

  // —— v1.5 世界线（worlds 屏）——
  /** 当前世界 id（`state/worlds/<worldId>/`；由世界线屏 POST /api/worlds 分配） */
  worldId: string | null;
  /**
   * 世界显示名（顶栏/剧情图屏展示）：玩家显示名 label → 备注 note，两者都空就是空串。
   * 绝不落裸 worldId——它只活在目录名、导出文件名与日志里（显示层还要再滤一道
   * {@link isLegacyForkNote}：老索引的 note 可能就是「分叉自 <裸 id> @ <节点>」）。
   */
  worldLabel: string;

  // —— v1.6 世界线管理（worlds 屏）——
  /** 改名/导入请求在途（按钮禁用） */
  worldBusy: boolean;
  /** 世界线屏提示位：导入与改名的成功/失败都落这里（失败 kind=error） */
  worldNotice: Notice | null;

  // —— v1.5 剧情图（tree overlay）——
  /** 图屏数据版本：世界切换/编辑完成/手动刷新自增，屏内据此重取树 */
  treeStamp: number;
  /** 图屏提示条（编辑摘要/排队/分叉结果） */
  treeNotice: string | null;
  /** 已发出一次 `剧情：` 编辑指令，等回合结束（该回合不进历史） */
  treeAsk: boolean;
  /** 引擎忙时排队的图屏编辑指令（turn_end 后自动补发） */
  pendingTreeMessage: string | null;
  /** 图屏选中的节点 id（详情侧栏；Esc 链第二环） */
  treeFocus: string | null;
  /** 最近一次分叉的结果（图屏提供「切到此世界线」） */
  forkResult: { worldId: string; nodeId: string } | null;

  // —— 回退后的重同步（会话内内存态，不持久化）——
  /**
   * 需要重同步的标记：回退成功后补发「继续世界：<worldId>。」时置位（`seq` = 回退到的幕），
   * 停止当前回合（{@link cancelTurn} / `turn_cancelled`）也会置位（`seq: null`——没有「回到第 N 幕」可言）。
   * 重同步回合（{@link resyncing}）turn_end 成功即清除，投递/回合失败则保留并置 {@link resyncFailed}。
   * v1.14 起玩家改发普通指令时**不再静默作废**：先强推一次重同步、把这句话排队跟进（见 send 入口）。
   * 刻意不持久化——App 重启后玩家走「继续世界线」本来就会重发续玩指令重读档，语义自洽，无需跨会话记账。
   */
  pendingResync: { worldId: string; seq: number | null } | null;
  /** 重同步回合失败（POST 失败或 SSE error 事件）：TopBar 亮「再同步」入口，重试成功后复位 */
  resyncFailed: boolean;
  /** 本轮发送的正是重同步指令「继续世界：<worldId>。」（由 restoreSnapshot/retryResync 在发送前置位）：
   *  只有它收尾的 turn_end 才认领「完成重同步」并清 pendingResync，失败路径也据此区分文案
   *  （重同步失败 vs 普通出错）；成功/失败收尾都复位，普通回合恒为 false。 */
  resyncing: boolean;

  // —— 重演（reroll，会话内内存态，不持久化）——
  /** 重同步回合成功收尾（pendingResync 清除）后要补发的玩家输入——重演点击时从目标幕
   *  快照条目的 prompt 现取（v1.13 起输入在盘上，见 lib/replay 与 docs/adr/0023），这里只负责把它
   *  带过 restore → 重同步 → turn_end 的窗口。重同步失败时保留，玩家点「再同步」成功后照常跟进。
   *  v1.14 起这条路也承载「重同步还挂着时玩家直接发了普通指令」的那句话（send 入口先强推重同步、
   *  把输入排到这里跟进）——同一个语义：重同步收尾后补发一句玩家输入。 */
  pendingRerollPrompt: string | null;
  /**
   * 重演对话框（v1.14 可编辑重演，会话内内存态）：由 {@link GameStore.openRerollDialog} 解析出的
   * **目标幕快照序号**与那条快照记下的玩家输入（对话框的预填值）。两个入口共用一份对话框：
   * 游戏屏「重演这一幕」（不传 seq = 最近一条带玩家输入的 turn 条目）与剧情图屏「回到这一幕并重演」
   * （传该存档点的 seq）。null = 对话框没开；取消/确认后清空（确认走 {@link GameStore.submitReroll}，
   * 空串回退为这里预填的那句）。玩家改写的输入最终经 pendingRerollPrompt 带过重同步窗口。
   */
  rerollDialog: { seq: number; prompt: string } | null;
  /** 当前世界已知的 `kind:"turn"` 快照数（游戏屏「重演这一幕」的可见性判据）：null = 未知。建新世界置 0；
   *  入场（resumeWorld）与「还不够两条」的回合收尾按需向 /api/history 补拉（见 context.refreshTurnSnapshots）。
   *  判定口径：重演要退到目标幕之前的那条 turn 快照 = 至少两条 turn 快照；未知（null）时不藏功能，
   *  点击后由重演解析内核取数判定并三级降级（找不到这一幕 / 第一幕无处可退 / 没有留下输入）。 */
  turnSnapshots: number | null;

  // —— v1.6 设置（settings overlay）——
  /** 玩家设置（初始值读自 localStorage；updateSettings 是唯一写入方） */
  settings: GameSettings;

  // —— v1.6 自动前进（设置项 autoAdvance 的执行侧）——
  /** 自动前进倒计时到点时刻（ms；null=未在倒计时）。到点自动选第一项，见 armAutoAdvance */
  autoAdvanceDeadline: number | null;
  /** 本回合的自动前进已被用户交互取消（turnKey 变化时复位：下一回合重新计时） */
  autoAdvanceMuted: boolean;

  // —— 回合簿记（不直接进 UI）——
  segs: Record<number, string>;
  curSeg: number;
  seenMarkerKeys: Set<string>;
  turnNo: number;

  toTitle(): void;
  /**
   * 回到世界线屏（捏人屏的「返回」与 Esc 链共用）：**只切屏**，不重置运行态——
   * 世界已由 `/api/worlds` create 落在服务端，玩家回去只是想改主意/换世界，选卡与答题照旧留着
   * （重置路径是 selectPreset / resetRunState，别混用）。
   */
  toWorlds(): void;
  selectPreset(preset: Preset): void;
  setPresets(presets: Preset[]): void;
  /**
   * 标题屏轮播下标（v1.14 从屏内 state 提到 store）：← → 切卡 / 拖拽 / 越界收敛共用。
   * 不夹界——范围由调用方保证（TitleScreen 的收敛 effect 在轮播长度变化后夹回）。
   */
  setTitleIndex(n: number): void;
  /**
   * 导入剧本导出包（v1.7，TitleScreen「导入剧本」入口）：本地最小校验 → POST /api/presets import →
   * 成功重取 /api/presets 刷新轮播（新卡带立刻可见）并提示「已导入为 <id>」（服务端重名会改 -2/-3）。
   * @param {string} text 文件原文（.preset.json）
   * @returns {Promise<{ok: boolean; id?: string; error?: string}>} 失败在 error 里返回，不抛错；结果落 titleNotice
   */
  importPresetText(text: string): Promise<{ ok: boolean; id?: string; error?: string }>;
  /** 清标题屏提示位（新导入开始时） */
  clearTitleNotice(): void;
  /** 世界线屏：开始一条全新世界线（id 已由 POST /api/worlds 分配） */
  beginNewWorld(worldId: string): void;
  /**
   * 世界线屏：继续某个已有世界（读档续演，跳过初始化与开场卡）。
   * entry 直接收 {@link WorldEntry} 的这四项：显示名（label）要走同一条回退链，缺了它就退化为备注或空串，
   * 绝不落裸 worldId（见 {@link GameStore.worldLabel}）。
   */
  resumeWorld(entry: Pick<WorldEntry, "worldId" | "chapterNo" | "note" | "label">): void;
  /** 打开剧情图（overlay；游戏内与章间制作屏都可进入） */
  openTree(): void;
  /** 打开设置（overlay，TopBar 齿轮；记住返回屏，Esc/返回走 closeOverlay） */
  openSettings(): void;
  /**
   * 打开剧本体检（overlay，标题屏角落「剧本体检」；记住返回屏，Esc/返回走 closeOverlay）。
   * 与其它 overlay 同款：只切屏、不动回合与画面状态。
   * @param {Preset} [preset] 体检对象：从标题屏进来时传**当前中央卡**（那时 store 的 selected 可能还是空
   *   或上一局的剧本，而玩家要体检的正是看着的那张卡；这条路径不能借道 selectPreset——它会进世界线屏
   *   并重置运行态）。缺省（游戏内/画廊等已有 selected 的场景）沿用 store 里的 selected。
   */
  openCheck(preset?: Preset): void;
  /**
   * 更新设置：合并补丁 → 写 localStorage → 立即作用到 AudioManager → 落 store。
   * 设置屏的每个控件都直接调它（无「保存」按钮，改动即时生效）。
   */
  updateSettings(patch: Partial<GameSettings>): void;
  /** 图屏重取树（编辑完成/手动刷新） */
  refreshTree(): void;
  setTreeNotice(n: string | null): void;
  /** 图屏选中节点（详情侧栏；null=收起） */
  setTreeFocus(nodeId: string | null): void;
  /** 图屏发送自然语言编辑指令（引擎忙时排队，复用创作屏排队模式） */
  /** 剧情图编辑：v1.12 起可带节点作用域（选中节点后写的那句话只改那个节点） */
  sendTreeEdit(text: string, nodeId?: string): void;
  /**
   * 在已走过节点上分叉（server 侧复制/精确重建，不推演任何内容）。
   * @param {string} nodeId 分叉点节点 id
   * @param {number} [seq] 该节点最早匹配快照的 seq（有快照=精确分叉；无快照时**不带这个键**，
   *   走 server 的兼容路径——旧世界的既有载荷不许被改写）
   */
  forkAt(nodeId: string, seq?: number): void;
  /**
   * 原地回退到某个快照：服务端先写一条 kind="backup" 的当前状态快照，再覆盖三份文件。
   * 引擎忙或有排队指令时拒绝（回退要改的正是引擎正在写的文件）。
   * 成功后自增 treeStamp 并补发续档指令「继续世界：<worldId>。」（{@link buildResumeCommand}）——
   * 三文件只是磁盘上的档，引擎会话里还留着回退点之后的记忆，必须让它重新读档才不会接着演「未来」。
   * @param {number} seq 目标快照序号（图屏「回退到此节点」按钮传来）
   * @returns {Promise<WorldPostResult>} 失败在 error 里返回，不抛错；结果落 treeNotice
   */
  restoreSnapshot(seq: number): Promise<WorldPostResult>;
  /**
   * 重同步重试（TopBar「再同步」按钮）：重发 `继续世界：<pendingResync.worldId>。`，走正常 send 流程——
   * 成功后由 turn_end 清除 pendingResync（徽章消失），再失败由既有错误路径把 resyncFailed 置回。
   */
  retryResync(): void;
  /**
   * 重演这一幕（TopBar「进度 ▾」菜单）：撤销刚结束的正戏回合并重发当时的玩家输入。
   * 时序（v1.13 起输入取自盘上，见 docs/adr/0023）：fetchHistory + fetchSnapshot 解析出目标幕
   * （= 最近一条**带玩家输入**的 turn 条目——刷新/重启后的续玩条目是空的，跳过它；见 REPLAY_PROBE_MAX）
   * 与回退点（= 它之前最近的一条 turn 条目），输入取目标幕的 prompt → 复用 restore 端点覆盖三文件
   *（server 先写 backup）→ history 追加 reason:"reroll" 的分割线、置待重同步并发续档指令 →
   * 重同步回合成功收尾后由 gameplay 的排队跟进自动重发该输入（可连掷）。
   * 三级降级（第一幕无处可退 / 旧档与续玩没有输入 / 找不到这一幕）与引擎忙都经 status 反馈，不静默。
   * @param {string} [promptOverride] 可编辑重演（v1.14）：玩家在入口改写过的那句话；缺省 /
   *   全空白 = 原样重发快照条目里的 prompt（行为与 v1.13 逐字一致）
   */
  rerollTurn(promptOverride?: string): Promise<void>;
  /**
   * 重演指定的一幕（剧情图屏「回到这一幕并重演」）：与 {@link rerollTurn} 同一解析内核、同一时序，
   * 只是目标幕由参数给定（该存档点的快照序号），提示落 {@link treeNotice}（图屏没有顶栏状态位）。
   * @param {number} seq 目标幕的快照序号（屏上「存档点 · 第 N 幕」的 N）
   * @param {string} [promptOverride] 可编辑重演（v1.14）：同 {@link rerollTurn}
   */
  rerollAt(seq: number, promptOverride?: string): Promise<void>;
  /**
   * 打开重演对话框（v1.14 可编辑重演）：把「重演这一幕」从「再说一遍同一句错话」变成
   * 「回到这里，换一种说法」——目标幕与预填值都取自盘上（与 {@link rerollTurn}/{@link rerollAt}
   * 同一套解析内核，不写第二份）。
   * @param {number} [seq] 目标幕的快照序号（剧情图屏「回到这一幕并重演」传该存档点）；
   *   缺省 = 游戏屏「重演这一幕」——目标幕 = 最近一条**带玩家输入**的 turn 条目（与 {@link rerollTurn}
   *   缺省时的口径逐字一致：最新那条常是空的续玩条目，要往回找；回看上限 REPLAY_PROBE_MAX）。
   * 解析失败（找不到这一幕 / 第一幕无处可退 / 这一档没有留下输入）与取数失败走既有错误提示口径
   * （游戏屏 status、图屏 treeNotice），**不开空对话框**。图屏路径（给了 seq）同步开框、预填值随后单条取回。
   */
  openRerollDialog(seq?: number): Promise<void>;
  /** 关掉重演对话框（取消 / 点背板 / Esc）：不落任何请求，草稿随框一起丢弃 */
  closeRerollDialog(): void;
  /**
   * 提交重演（对话框「确认重演」）：`text` 空/全空白 = 没改写，回退为打开时预填的那句
   * （与 `replayPrompt` 同一口径）；否则按玩家改写的输入重演。
   * 目标幕 = 打开对话框时解析出的那一条（不是「此刻盘上最新一条」——续玩条目的边界上两者不同，
   * 而对话框预填的正是这一条记下的输入）。走既有 reroll 通路与既有 `pendingResync` 时序：
   * 重同步回合成功收尾后由 gameplay 的排队跟进补发这句话（图屏提示落 treeNotice，游戏屏落 status）。
   */
  submitReroll(text: string): Promise<void>;
  /**
   * 启动自动前进倒计时（选项上屏时由 OptionList 调；重复调用幂等）。
   * 拒绝启动：设置关闭（autoAdvance=0）、本回合已被交互取消、非游戏屏、引擎忙、
   * 创作/图屏有排队指令、打字未完成、无选项。
   * 到点若**引擎忙**（倒计时起跑后才忙起来：回合还在收尾）不作废，而是 250ms 短延迟重试、
   * 累计 ~2s 仍忙才放弃（见 context.fireAutoAdvance）——抢发必 409，表现为「偶发不自动前进」。
   */
  armAutoAdvance(): void;
  /** 玩家显式打开自动前进（面板上的「自动」开关）：解掉本回合的「交互即取消」标记后立即尝试武装 */
  resumeAutoAdvance(): void;
  /** 用户交互（点击/按键/输入）取消本次自动前进，并记住本回合不再自动（turnKey 变化时复位） */
  cancelAutoAdvance(): void;
  /** 切到刚分叉出的世界线继续（引擎忙时拒绝） */
  switchToFork(): void;
  /**
   * 开/关角色面板抽屉（v1.7）：打开时顺手 `refreshCharacters` 拉一次；
   * turn_end 后面板开着由 gameplay 自动重拉（好感度/导演手记随回合变）。
   */
  toggleCharacters(): void;
  /**
   * 重拉当前世界的 `/api/state` 视图落 {@link stateView}。没有世界（worldId 为空）直接返回；
   * 404（还没写过 state.md）或请求失败保持原值（空态文案由面板渲染）；await 期间换世界则不回填。
   */
  refreshCharacters(): void;
  toggleCardAnswer(shortName: string, option: string, multi: boolean): void;
  startGame(quick: boolean, preload: boolean): void;
  send(text: string): void;
  /**
   * 玩家叙事输入的发送入口（OptionList 选项 / FreeInput 自由输入 / 自动前进代点）：走 send。
   * 服务端会把这次输入连同回合产物落进快照条目的 prompt（重演的数据源）；指令类发送不走这里，
   * 服务端按 isDirectivePrompt 判掉、天然不记（v1.13，见 docs/adr/0023）。
   */
  sendPlayerTurn(text: string): void;
  skipPreload(): void;
  toggleDrawer(): void;
  setTypingDone(done: boolean): void;
  /**
   * 记下「这一幕的打字机已完整展示过」（v1.14）：键 = {@link turnKey} 的字符串形态。
   * 屏切换（App 的 keyed 重挂）会把 DialogueBox 的 shown 归零，重挂时消费方读本字段决定是否直接播种全文。
   * @param {string} key 打字机键（与 DialogueBox 的 turnKey 同源）
   */
  markTypingDone(key: string): void;
  /**
   * 消费待规划章（v1.14 兜底入口，GameStage 的「第 N 章待规划 · 继续」提示条用）：
   * 与回 game 屏时的自动消费同一条路（切 crafting 并发该章规划指令）；非 game 屏 / 引擎忙 / 无待办时不动。
   */
  resumePendingChapter(): void;
  /**
   * 停止当前回合（v1.14，TopBar「停止」按钮）：调 `POST /api/engine/cancel`；服务端确认停下后
   * 复位引擎忙态、状态写「已停止」、置 {@link pendingResync}（下一句输入先重同步）。
   * `turn_cancelled` 事件到达时走同一条路（幂等）。投递失败经 status 报错，不静默。
   */
  cancelTurn(): Promise<void>;
  /**
   * 回合收尾的 state.md 刷新（v1.14）：**不再只在角色面板开着时刷新**——数值差分（{@link lastTurnDeltas}）
   * 是每一回合都要看的因果反馈。拉到的视图与 {@link prevStateView} 对比后写差分，并把新视图落成新基线。
   */
  refreshTurnState(): void;
  /** 打开帮助面板（v1.14 本地化 /help；纯前端开关，不占引擎回合） */
  openHelp(): void;
  closeHelp(): void;
  /** 打开前情提要（v1.14 本地化 /recap）：置开关并本地合成 {@link recapData}（零引擎回合） */
  openRecap(): Promise<void>;
  closeRecap(): void;
  /**
   * 翻一页磁盘历史（v1.14）：`limit` = 50，首翻拿最近一页，之后按 `nextBefore` 往更早翻，
   * 结果逐页追加进 {@link diskHistory}。同世界 in-flight 去重；换世界时丢弃迟到的应答。
   */
  loadHistoryPage(): Promise<void>;
  /**
   * SSE 重连对账（v1.14，App 的 onConn("open") 调用；首连与重连一视同仁、幂等，受控例外新增）：
   * 断线期间错过的 `turn_start`/`turn_end` 会让客户端忙态与回合号与真值错开，这里拉一次
   * `GET /api/engine/status` 以服务端为准对齐 {@link GameStore.engineBusy} / {@link GameStore.currentTurn}，
   * 并顺手补拉一次 turnSnapshots（重演入口的可见性判据）。取数失败静默保持现态，**不伪造任何回合收尾**。
   */
  reconcileAfterReconnect(): void;
  /** 置 SSE 断开提示位（App 的 onConn 回调；成功对账会把 {@link GameStore.sseDown} 复位为 false，幂等） */
  setSseDown(down: boolean): void;
  handleEvent(event: AcpEvent): void;
  /**
   * 打开画廊（overlay；只切屏，不动回合与画面状态）。
   * 传 `preset` 时顺手把 `selected` 落到它——标题屏的「素材」用当前中央卡，避免标题屏还没插卡时
   * 用到一个空或上一局的 `selected`（与 `openCheck` 同一口径：只落 selected，不进世界线屏、不重置运行态）。
   */
  openAssets(preset?: Preset | null): void;
  openCreation(): void;
  /** 从 overlay 屏返回进入前的原屏 */
  closeOverlay(): void;
  /** 创作屏发送：追加玩家气泡并送引擎 */
  sendCreation(text: string): void;
  /** 新剧本就绪：回 title（轮播已由 presetAdded 刷新） */
  finishCreation(): void;
  /**
   * 画廊发起重绘：发指令并挂起等待（第四段|重绘 标记或回合结束解除）。
   * @param type 立绘/背景/封面（指令字面）
   * @param key 指令 key（立绘=名[-变体]、背景=地点、封面=preset id）
   * @param matchName 【图|重绘】标记里的名字（封面=剧本标题，与指令 key 不同）
   */
  /** 单项重绘（v1.12 起可带玩家要求 `note`：一句人话，空 = 盲重绘） */
  startRegen(type: ArtKind, key: string, matchName: string, note?: string): void;
  /**
   * 画廊批量重绘：把一串 job 建成顺序队列，逐条走 {@link startRegen} 同一条流水线
   * （一条收尾才派下一条；引擎忙/已有在跑的重绘时拒绝并落收尾提示位）。
   */
  startRegenBatch(jobs: RegenJob[]): void;
  /** 画廊批量删除：逐条 POST /api/assets {action:delete}，收尾刷新清单（assetsStamp）并落提示 */
  deleteAssets(files: string[]): Promise<void>;
  /** 世界线改名/备注（空串=清除该字段）；结果落 worldNotice，返回值给屏内决定要不要重取清单 */
  updateWorld(p: { worldId: string; label?: string; note?: string }): Promise<WorldPostResult>;
  /** 世界线导入：文件原文 → 校验（{@link parseWorldBundle}）→ POST import；非法原文不打扰服务端 */
  importWorldText(text: string): Promise<WorldPostResult>;
  /** 关掉世界线屏提示（进屏时清上一轮的残留） */
  clearWorldNotice(): void;
  /** 关掉画廊提示（进屏时清上一轮的残留） */
  clearAssetsNotice(): void;
  /** 画廊大图预览开关（null=关闭；Esc 链第一环） */
  setAssetsPreview(a: AssetEntry | null): void;
  /** 创作屏返回：有对话时开确认卡，无对话直接返回 */
  requestCreationExit(): void;
  closeCreationExitPrompt(): void;
}
