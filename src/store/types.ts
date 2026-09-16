// store 的类型层（v1.6 slice 拆分抽出）：只放类型，不带运行时值——
// 这样 slices/* 与 context.ts 都能 `import type` 取用，不会与 game.ts 形成运行时循环依赖。
// 对外 API 不变：game.ts 原样 `export type {...} from "./types"`，组件与测试的 import 路径不动。
import type { AssetEntry, Preset, WorldEntry, WorldPostResult, AcpEvent } from "../lib/acp";
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
  | "settings";

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

/** 立绘画面状态：url 指向当前显示图（基础或差分），baseUrl 恒为基础立绘（差分 404 时回退） */
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

export interface HistoryEntry {
  n: string;
  t: string;
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
}

export interface GameStore {
  screen: Screen;
  /** overlay 屏（assets/creation）的返回目标 */
  screenReturn: Screen | null;
  selected: Preset | null;
  /** /api/presets 的轮播数据（TitleScreen 挂载与 presetAdded 时刷新） */
  presets: Preset[];
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
  portrait: PortraitState | null;
  /** 预载阶段的名字槽位 -> 图片 URL；空串 = 未就绪。非预载开局为空对象 */
  artReady: Record<string, string>;

  /** 制作中屏的美术队列（规划回合后由制作清单构建；空数组 = 尚在规划/非制作开局） */
  preload: PreloadItem[];
  preloadPhase: PreloadPhase;
  /** 当前制作中的章号（开局=1；章标记后=N+1） */
  chapterNo: number;
  /** 玩家在 init/planning 期间按了跳过：该回合结束后直接「开演。」 */
  skipRequested: boolean;
  /** 引擎回合进行中（turn_start→turn_end/error）；skip 时用来判断能否立即推进 */
  engineBusy: boolean;

  history: HistoryEntry[];
  drawerOpen: boolean;

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
  /** 世界显示名（分叉备注或 id；顶栏展示） */
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
  selectPreset(preset: Preset): void;
  setPresets(presets: Preset[]): void;
  /** 世界线屏：开始一条全新世界线（id 已由 POST /api/worlds 分配） */
  beginNewWorld(worldId: string): void;
  /** 世界线屏：继续某个已有世界（读档续演，跳过初始化与开场卡） */
  resumeWorld(entry: Pick<WorldEntry, "worldId" | "chapterNo" | "note">): void;
  /** 打开剧情图（overlay；游戏内与章间制作屏都可进入） */
  openTree(): void;
  /** 打开设置（overlay，TopBar 齿轮；记住返回屏，Esc/返回走 closeOverlay） */
  openSettings(): void;
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
  sendTreeEdit(text: string): void;
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
   * 启动自动前进倒计时（选项上屏时由 OptionList 调；重复调用幂等）。
   * 拒绝启动：设置关闭（autoAdvance=0）、本回合已被交互取消、非游戏屏、引擎忙、
   * 创作/图屏有排队指令、打字未完成、无选项。
   * 到点若**引擎忙**（倒计时起跑后才忙起来：回合还在收尾）不作废，而是 250ms 短延迟重试、
   * 累计 ~2s 仍忙才放弃（见 context.fireAutoAdvance）——抢发必 409，表现为「偶发不自动前进」。
   */
  armAutoAdvance(): void;
  /** 用户交互（点击/按键/输入）取消本次自动前进，并记住本回合不再自动（turnKey 变化时复位） */
  cancelAutoAdvance(): void;
  /** 切到刚分叉出的世界线继续（引擎忙时拒绝） */
  switchToFork(): void;
  toggleCardAnswer(shortName: string, option: string, multi: boolean): void;
  startGame(quick: boolean, preload: boolean): void;
  send(text: string): void;
  skipPreload(): void;
  toggleDrawer(): void;
  setTypingDone(done: boolean): void;
  handleEvent(event: AcpEvent): void;
  openAssets(): void;
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
  startRegen(type: ArtKind, key: string, matchName: string): void;
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
