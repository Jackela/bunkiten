// store 的类型层（v1.6 slice 拆分抽出）：只放类型，不带运行时值——
// 这样 slices/* 与 context.ts 都能 `import type` 取用，不会与 game.ts 形成运行时循环依赖。
// 对外 API 不变：game.ts 原样 `export type {...} from "./types"`，组件与测试的 import 路径不动。
import type { AssetEntry, Preset, StateView, WorldEntry, WorldPostResult, AcpEvent } from "../lib/acp";
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

/** 正文幕：「第 N 幕」+ 过滤协议行后的回合正文（kind 可选，旧字面量 {n,t} 原样可用） */
export interface HistoryEntry {
  kind?: "act";
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
   * 回退成功后补发「继续世界：<worldId>。」的标记：重同步回合（{@link resyncing}）turn_end 成功即清除
   * （见 gameplay slice），投递/回合失败则保留并置 {@link resyncFailed}；玩家改发普通指令时在 send 入口
   * 静默清掉（选择继续走，不假称完成重同步）。刻意不持久化——App 重启后玩家走「继续世界线」
   * 本来就会重发续玩指令重读档，语义自洽，无需跨会话记账。
   */
  pendingResync: { worldId: string; seq: number } | null;
  /** 重同步回合失败（POST 失败或 SSE error 事件）：TopBar 亮「再同步」入口，重试成功后复位 */
  resyncFailed: boolean;
  /** 本轮发送的正是重同步指令「继续世界：<worldId>。」（由 restoreSnapshot/retryResync 在发送前置位）：
   *  只有它收尾的 turn_end 才认领「完成重同步」并清 pendingResync，失败路径也据此区分文案
   *  （重同步失败 vs 普通出错）；成功/失败收尾都复位，普通回合恒为 false。 */
  resyncing: boolean;

  // —— 重演（reroll，会话内内存态，不持久化）——
  /** 重演的排队跟进：重同步回合成功收尾（pendingResync 清除）后要补发的玩家输入——点击时从目标幕
   *  快照条目的 prompt 现取（v1.13 起输入在盘上，见 lib/replay 与 docs/adr/0023），这里只负责把它
   *  带过 restore → 重同步 → turn_end 的窗口。重同步失败时保留，玩家点「再同步」成功后照常跟进；
   *  玩家改发普通指令时随 pendingResync 一起静默作废（见 send 入口）。 */
  pendingRerollPrompt: string | null;
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
  /** /new-game、/presets 需要在回合结束后切屏 */
  awaitCommand: string | null;

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
   */
  rerollTurn(): Promise<void>;
  /**
   * 重演指定的一幕（剧情图屏「回到这一幕并重演」）：与 {@link rerollTurn} 同一解析内核、同一时序，
   * 只是目标幕由参数给定（该存档点的快照序号），提示落 {@link treeNotice}（图屏没有顶栏状态位）。
   * @param {number} seq 目标幕的快照序号（屏上「存档点 · 第 N 幕」的 N）
   */
  rerollAt(seq: number): Promise<void>;
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
