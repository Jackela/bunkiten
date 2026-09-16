// 全局状态机：boot → title → protagonist → crafting → game；overlay 屏 assets（画廊）/creation（创作）从 game/title 进入、返回原屏。
// SSE 事件 → handleEvent（段过滤/标记/选项的处理迁移自 shell/index.html，行为对齐旧版）。
// crafting 屏由章节制作流水线驱动（v1.2）：开局指令（待命版）→ 规划（制作清单）→ 逐项美术指令 → 「开演。」；
// game 屏收到【章】标记后切回 crafting，规划下一章。
// v1.3：【立绘】表情切换事件驱动差分立绘、【新剧本】事件刷新轮播、画廊重绘回合与游戏态共用引擎。
// v1.5：世界线（title→worlds→protagonist/crafting→game，开局/续玩指令携带 worldId）、剧情图屏（tree overlay，剧情：编辑）、
//       清单缓存过滤抽成 parser 纯函数（assetNameMatches）。
// v1.5.1：美术资产随故事走——预载直服与表情切换 URL 走 presets/<剧本 id>/assets/，清单与 /img 请求都带 preset。
import { create } from "zustand";
import {
  BUILD_ASSEMBLE,
  BUILD_START,
  ENTER_CREATION,
  assetNameMatches,
  buildArtCommand,
  buildCustomOpening,
  buildPlanCommand,
  buildQuickOpening,
  buildRegenCommand,
  buildResumeCommand,
  buildTreeEditCommand,
  cleanForHistory,
  finalMarkers,
  isProtocolLine,
  parseCardLines,
  parseChapterMark,
  parseManifest,
  parseOptions,
  scanMarkers,
  segStatusLabel,
  splitAssetVariant,
  type ArtKind,
  type CardAnswer,
  type GameOption,
  type Marker,
} from "../lib/parser";
import {
  assetFileUrl,
  assetPath,
  assetUrl,
  fetchAssets,
  fetchPresets,
  imageUrl,
  postPrompt,
  postWorld,
  type AcpEvent,
  type AssetEntry,
  type Preset,
  type WorldEntry,
} from "../lib/acp";

export type Screen = "boot" | "title" | "worlds" | "protagonist" | "crafting" | "game" | "assets" | "creation" | "tree";

/** 清单项 → 分项美术指令的种类字面 */
const ART_KIND: Record<"portrait" | "background", ArtKind> = { portrait: "立绘", background: "背景" };

/** 「选 1-2」类问题的最大选择数 */
const MULTI_MAX = 2;

/** 单项美术生成的前端看门狗：需覆盖 server /prompt 的 600s 超时（SSE 断线丢事件时兜底） */
const WATCHDOG_MS = 610_000;

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

/** 名字归一化：去掉「」『』包夹与首尾空白（槽位名与引擎标记名对齐） */
function normName(x: string): string {
  return x.replace(/[「」『』]/g, "").trim();
}

/**
 * 【图】标记 URL 的当前剧本 id（/img 的 &preset=：直服与流式落盘都据此定位目录）。
 * 创作屏里正在装配的新剧本 id 只由【新剧本】事件揭示，揭示前留空——
 * 宁可不落盘（服务端会 warn），也不能把新剧本的美术写进正在玩的剧本目录。
 *
 * 装配期 URL 语义（与服务端契约对齐，改这里前先看 server persistAsset 的剧本 id 来源）：
 * 【新剧本】到达前客户端不知道新剧本 id，所以标记 URL 不带 preset；
 * 到达后由**服务端**按【新剧本】id 补落盘（图片先以会话路径存着，谁先知道剧本 id 谁负责归档）。
 * 客户端**不重写已发出的历史 URL**——补落盘是服务端职责，别在这里「顺手把旧 URL 修一下」。
 */
function markerPresetId(screen: Screen, selected: Preset | null, creationResult: string | null): string {
  if (screen === "creation") return creationResult ?? "";
  return selected?.id ?? "";
}

/**
 * 【立绘】表情切换事件 → 下一个立绘状态（纯函数，供单测）。
 * 当前立绘就是该角色时只换 variant/url（保留 baseUrl）；否则新建槽位（本剧本的基础立绘兜底）。
 * @param {PortraitState | null} prev 当前立绘状态
 * @param {string} character 引擎指令里的角色名
 * @param {string} variant 变体名（空串=回基础立绘）
 * @param {string} preset 当前剧本 id（差分图与兜底图都按它构造，路径走 acp.assetPath；空串=无剧本上下文）
 * @returns {PortraitState} 新立绘状态
 */
export function nextPortraitOnExpression(
  prev: PortraitState | null,
  character: string,
  variant: string,
  preset: string,
): PortraitState {
  const who = normName(character);
  const keep = prev && normName(prev.name) === who ? prev : null;
  const baseUrl = keep ? keep.baseUrl : assetUrl("portrait", who, preset);
  // 无剧本上下文（preset 空）时 assetPath 回空串：宁可用基础图，也不构造 presets//assets/… 这种坏路径
  const variantPath = variant ? assetPath("立绘", `${who}-${variant}`, preset) : "";
  return { name: keep ? keep.name : character, variant, url: variantPath ? assetFileUrl(variantPath) : baseUrl, baseUrl };
}

/**
 * 立绘图 404（差分素材尚未生成）时的回退 URL（纯函数，供单测）。
 * @param {PortraitState} p 当前立绘状态
 * @returns {string} 回退目标（基础立绘）；url 已是基础时原样返回
 */
export function fallbackPortraitUrl(p: PortraitState): string {
  return p.baseUrl;
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

interface GameStore {
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
  /** 图屏重取树（编辑完成/手动刷新） */
  refreshTree(): void;
  setTreeNotice(n: string | null): void;
  /** 图屏选中节点（详情侧栏；null=收起） */
  setTreeFocus(nodeId: string | null): void;
  /** 图屏发送自然语言编辑指令（引擎忙时排队，复用创作屏排队模式） */
  sendTreeEdit(text: string): void;
  /** 在已走过节点上分叉（server 侧复制+回退，不推演任何内容） */
  forkAt(nodeId: string): void;
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
  /** 画廊大图预览开关（null=关闭；Esc 链第一环） */
  setAssetsPreview(a: AssetEntry | null): void;
  /** 创作屏返回：有对话时开确认卡，无对话直接返回 */
  requestCreationExit(): void;
  closeCreationExitPrompt(): void;
}

/** 把已选答案按 card 问题顺序整理成开局指令用的作答列表 */
function cardAnswersOf(preset: Preset, answers: Record<string, string[]>): CardAnswer[] {
  return parseCardLines(preset.protagonist_card)
    .map((q) => ({ shortName: q.shortName, values: answers[q.shortName] ?? [] }))
    .filter((a) => a.values.length > 0);
}

// 看门狗定时器（store 为应用级单例，模块变量即可）
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

export const useGameStore = create<GameStore>()((set, get) => {
  /** marker.kind → 协议字面（regen 匹配 key 用） */
  const KIND_CN: Record<Marker["kind"], ArtKind> = { portrait: "立绘", background: "背景", cover: "封面" };

  /** 重绘完成：解除挂起并让画廊刷新（标记带|重绘 或 重绘回合结束两路都到这） */
  function finishRegen() {
    if (get().regenPending) set({ regenPending: null, assetsStamp: get().assetsStamp + 1 });
  }

  /**
   * 应用【图】标记到背景/立绘/预载槽位。
   * @param markers 标记列表
   * @param dedupe 流式期间按整行 key 去重（同一段 chunk 会重复扫描）；turn_end 全量重放（回到旧背景的场景）
   */
  function applyMarkers(markers: Marker[], dedupe: boolean) {
    const s = get();
    const seen = new Set(s.seenMarkerKeys);
    const artReady = { ...s.artReady };
    // 当前剧本：/img 的 &preset=（直服与流式落盘都要它定位 presets/<id>/assets/）
    const preset = markerPresetId(s.screen, s.selected, s.creationResult);
    // 槽位名（来自 preset，可能带「」）与引擎标记名（常不带）做归一化对齐
    const norm = normName;
    const slotByNorm = new Map(Object.keys(artReady).map((k) => [norm(k), k]));
    const patch: { bgUrl?: string; portrait?: PortraitState } = {};
    let changed = false;
    for (const m of markers) {
      // 重绘覆盖标记：命中挂起中的画廊重绘即解除（放在去重之前——重复出现的重绘标记也要触发刷新）
      if (m.regen && get().regenPending === `${KIND_CN[m.kind]}|${m.name}`) finishRegen();
      const key = `${m.kind}|${m.name}|${m.path}`;
      if (dedupe && seen.has(key)) continue;
      seen.add(key);
      changed = true;
      // 标记里的 p 可能是会话路径（新生成）或 presets/<id>/assets/…（缓存命中），原样透传给服务端解析
      const url = m.kind === "cover" ? assetFileUrl(m.path) : imageUrl(m.path, m.kind, m.name, preset);
      if (m.kind === "background") {
        patch.bgUrl = url;
        // 背景槽位名 = 清单地点名（旧开场场景槽已随 v1.2 清单化移除）
        const slotKey = m.name in artReady ? m.name : slotByNorm.get(norm(m.name));
        if (slotKey) artReady[slotKey] = url;
      } else if (m.kind === "cover") {
        // 封面不是演出画面：只点亮创作屏的装配清单（server 会把它落盘到 presets/<id>/cover.jpg）
        if (get().screen === "creation") set({ creationCover: true });
      } else {
        const slotKey = m.name in artReady ? m.name : slotByNorm.get(norm(m.name));
        if (slotKey) artReady[slotKey] = url;
        // 差分立绘（清单里的 薇拉-微笑 类槽位）只填槽位，不替换主立绘
        const isVariantSlot = s.preload.some(
          (i) => i.kind === "portrait" && i.variant && (i.name === m.name || norm(i.name) === norm(m.name)),
        );
        if (!isVariantSlot) patch.portrait = { name: m.name, variant: "", url, baseUrl: url };
        // 装配阶段的基础立绘标记：点亮创作屏清单（去重）
        if (get().screen === "creation" && !get().creationPortraits.includes(m.name)) {
          set({ creationPortraits: [...get().creationPortraits, m.name] });
        }
      }
    }
    if (!changed) return;
    set({ ...patch, artReady, seenMarkerKeys: seen });
  }

  /** 清空当前回合显示状态（turn_start 与段切换共用；旁白段被新段覆盖） */
  function resetTurnState(turnKey: number) {
    set({
      received: "",
      finalText: "",
      options: null,
      typingDone: false,
      turnKey,
    });
  }

  function armWatchdog() {
    clearWatchdog();
    watchdogTimer = setTimeout(() => onEngineError("等待引擎响应超时"), WATCHDOG_MS);
  }

  /** 发送「开演。」并进入 starting 阶段（幂等：已 starting 不重发；同时清掉待命/规划的跳过请求） */
  function sendStart() {
    if (get().preloadPhase === "starting") return;
    set({ preloadPhase: "starting", skipRequested: false });
    armWatchdog();
    get().send(BUILD_START);
  }

  /** 取下一个 pending 项开跑；没有则收尾发「开演。」 */
  function runNextPending() {
    const s = get();
    const next = s.preload.find((i) => i.state === "pending");
    if (!next) {
      sendStart();
      return;
    }
    set({
      preload: s.preload.map((i) =>
        i === next ? { ...i, state: "running" } : i.state === "running" ? { ...i, state: "done" } : i,
      ),
    });
    armWatchdog();
    get().send(next.command);
  }

  /** 发某一章的规划指令并进入 planning（send 会覆盖 status，故在其后再写文案） */
  function beginPlanning(n: number) {
    set({ preloadPhase: "planning" });
    armWatchdog();
    get().send(buildPlanCommand(n));
    set({ status: "撰写章节大纲…" });
  }

  /**
   * 回合结束（turn_end）后的流水线推进。init=待命已确认，发规划指令；
   * planning=规划回合已回，解析制作清单→过滤已就绪→进入逐项队列；
   * queue=当前项完成取下一项；starting=开场正文已回，切 game。
   */
  async function advancePreload() {
    const s = get();
    if (s.screen !== "crafting") return;
    if (s.preloadPhase === "init") {
      if (s.skipRequested) {
        sendStart();
        return;
      }
      beginPlanning(get().chapterNo);
    } else if (s.preloadPhase === "planning") {
      if (s.skipRequested) {
        sendStart();
        return;
      }
      // 该回合全文 = 各段拼接（规划回合先写树文件再输出清单行，清单可能在非当前段）
      const manifest = parseManifest(Object.values(s.segs).join("\n"));
      if (manifest.length === 0) {
        // 引擎异常没给清单：视作失败项，直接开演（引擎按旧语义回退 opening），不卡死
        sendStart();
        return;
      }
      // 同步落队列与槽位再异步清点（期间玩家可跳过，跳过后这里直接返回）
      set({
        preloadPhase: "queue",
        status: "清点既有美术…",
        preload: manifest.map((m) => {
          // 差分清单项（薇拉-微笑）拆出角色名与变体：指令/槽位用原名，槽位显示「薇拉 · 微笑」
          const { base, variant } = m.kind === "portrait" ? splitAssetVariant(m.name) : { base: m.name, variant: "" };
          return {
            kind: m.kind,
            name: m.name,
            variant,
            label: variant ? `${base} · ${variant}` : m.name,
            command: buildArtCommand(ART_KIND[m.kind], m.name),
            state: "pending" as const,
            url: null,
          };
        }),
        artReady: Object.fromEntries(manifest.map((m) => [m.name, ""])),
      });
      let assets: Awaited<ReturnType<typeof fetchAssets>> = [];
      // 只清点当前剧本的资产（v1.5.1 资产随故事走；服务端缺 preset 即 400）
      const presetId = s.selected?.id ?? "";
      try {
        assets = await fetchAssets(presetId);
      } catch {
        // 清点失败 = 全量重做，不阻塞流程
      }
      const st = get();
      if (st.screen !== "crafting" || st.preloadPhase !== "queue") return; // 期间已跳过/推进
      // 预过滤兜底（引擎侧规划已做缓存感知，正常应近空）：名字归一化匹配（trim / 互为包含，
      // 纯函数在 parser.assetNameMatches 并有单测），立绘与背景一视同仁——命中的按落盘文件直服跳过生成
      set({
        preload: st.preload.map((i) => {
          if (i.state !== "pending") return i;
          const typeCn = i.kind === "portrait" ? "立绘" : "背景";
          // 差分项先拆出基础名（清单项 薇拉-微笑 → 薇拉）；背景名可能含连字符，不拆
          const base = i.variant ? splitAssetVariant(i.name).base : i.name;
          const hit = assets.some((a) => {
            if (a.type !== typeCn || !a.ready) return false;
            return assetNameMatches({ name: a.name, variant: a.variant }, { name: base, variant: i.variant });
          });
          // 已就绪项按落盘文件直服（差分同契约：presets/<id>/assets/立绘-薇拉-微笑.jpg）。
          // 路径与 sanitize 都交给 acp.assetPath——落盘名由服务端 sanitize，前端只有这一处实现
          const path = assetPath(typeCn, i.name, presetId);
          return hit && path
            ? { ...i, state: "done" as const, url: assetFileUrl(path) }
            : i;
        }),
      });
      runNextPending();
    } else if (s.preloadPhase === "queue") {
      set({ preload: get().preload.map((i) => (i.state === "running" ? { ...i, state: "done" } : i)) });
      runNextPending();
    } else if (s.preloadPhase === "starting") {
      clearWatchdog();
      set({ preloadPhase: "finished", screen: "game" });
    }
  }

  /** 引擎报错/超时：制作中屏按阶段降级，不阻塞整体 */
  function onEngineError(message: string) {
    set({ status: `出错：${message}`, engineBusy: false, turnStartAt: null });
    clearWatchdog();
    finishRegen(); // 挂起中的重绘回合没了：解除挂起，画廊按钮恢复
    if (get().screen === "creation" && get().assembling) {
      // 装配回合超时/出错：可重试
      set({ assembling: false, assemblyStalled: true });
    }
    const s = get();
    if (s.screen !== "crafting") return;
    if (s.preloadPhase === "queue") {
      set({ preload: s.preload.map((i) => (i.state === "running" ? { ...i, state: "failed" } : i)) });
      runNextPending();
    } else if (s.preloadPhase === "planning") {
      // 规划回合失败：同无清单回退，直接「开演。」（引擎回退 opening）
      sendStart();
    } else if (s.preloadPhase === "init") {
      // 待命回合失败：留在本屏（队列未建）等玩家跳过
    } else if (s.preloadPhase === "starting") {
      // 「开演。」回合失败：退回 queue 态，重新暴露「跳过剩余，立即开演」按钮（点击即重发）
      set({ preloadPhase: "queue" });
    }
  }

  /**
   * 一次游玩的运行态清零（选剧本 / 新世界 / 续玩共用）：清显示与簿记字段，不动 selected/presets；
   * 调用方用 patch 覆盖本次要落定的字段（screen/worldId/chapterNo/engineBusy…）。
   */
  function resetRunState(patch: Partial<GameStore>) {
    set({
      cardAnswers: {},
      bgUrl: null,
      portrait: null,
      history: [],
      artReady: {},
      preload: [],
      preloadPhase: "finished",
      chapterNo: 1,
      skipRequested: false,
      segs: { 0: "" },
      curSeg: 0,
      received: "",
      finalText: "",
      options: null,
      typingDone: false,
      seenMarkerKeys: new Set<string>(),
      turnNo: 0,
      awaitCommand: null,
      engineBusy: false,
      turnStartAt: null,
      treeAsk: false,
      pendingTreeMessage: null,
      turnKey: get().turnKey + 1,
      ...patch,
    });
  }

  return {
    screen: "boot",
    screenReturn: null,
    selected: null,
    presets: [],
    cardAnswers: {},
    status: "连接引擎…",
    turnKey: 0,
    received: "",
    finalText: "",
    options: null,
    typingDone: false,
    bgUrl: null,
    portrait: null,
    artReady: {},
    preload: [],
    preloadPhase: "finished",
    chapterNo: 1,
    skipRequested: false,
    engineBusy: false,
    history: [],
    drawerOpen: false,
    creationMessages: [],
    assembling: false,
    assemblyStalled: false,
    creationCover: false,
    creationPortraits: [],
    creationResult: null,
    regenPending: null,
    assetsStamp: 0,
    assetsPreview: null,
    pendingCreationMessage: null,
    creationExitPrompt: false,
    turnStartAt: null,
    worldId: null,
    worldLabel: "",
    treeStamp: 0,
    treeNotice: null,
    treeAsk: false,
    pendingTreeMessage: null,
    treeFocus: null,
    forkResult: null,
    segs: { 0: "" },
    curSeg: 0,
    seenMarkerKeys: new Set<string>(),
    turnNo: 0,
    awaitCommand: null,

    toTitle() {
      clearWatchdog();
      set({ screen: "title", screenReturn: null, turnStartAt: null });
    },

    selectPreset(preset) {
      clearWatchdog();
      // v1.5：选卡后先进世界线屏（继续已有世界 / 开新世界），worldId 由世界线屏落定
      resetRunState({ selected: preset, screen: "worlds", worldId: null, worldLabel: "" });
    },

    setPresets(presets) {
      set({ presets });
    },

    toggleCardAnswer(shortName, option, multi) {
      const cur = get().cardAnswers[shortName] ?? [];
      let next: string[];
      if (!multi) {
        next = cur[0] === option ? [] : [option];
      } else if (cur.includes(option)) {
        next = cur.filter((v) => v !== option);
      } else {
        // 「选 1-2」：超过上限时挤掉最早的选择
        next = [...cur, option].slice(-MULTI_MAX);
      }
      set({ cardAnswers: { ...get().cardAnswers, [shortName]: next } });
    },

    startGame(quick, preload) {
      const s = get();
      if (!s.selected) return;
      // 新世界线由世界线屏分配；缺省 main 兜底（未选世界/异常路径引擎按 main 处理）
      const worldId = s.worldId ?? "main";
      const prompt = quick
        ? buildQuickOpening(s.selected.title, preload, worldId)
        : buildCustomOpening(s.selected.title, cardAnswersOf(s.selected, s.cardAnswers), preload, worldId);
      resetRunState({
        screen: preload ? "crafting" : "game",
        // 制作队列由第 1 章规划回合的制作清单构建，开局不预填槽位
        preloadPhase: preload ? "init" : "finished",
        engineBusy: true,
      });
      if (preload) armWatchdog();
      get().send(prompt);
    },

    send(text) {
      const t = text.trim();
      if (!t) return;
      set({
        options: null,
        typingDone: false,
        status: "引擎演绎中…",
        awaitCommand: t === "/new-game" || t === "/presets" ? t : null,
      });
      postPrompt(t)
        .then((r) => {
          // 回合没发出去（409 等）就不会有 turn 事件，engineBusy 需复位供制作中屏推进
          if (!r.ok) {
            set({ status: `出错：${r.error}`, engineBusy: false, turnStartAt: null });
            // 挂起中的画廊重绘没有对应回合了，解除挂起让按钮恢复
            finishRegen();
          }
        })
        .catch((e: unknown) => {
          set({ status: `出错：${String(e)}`, engineBusy: false, turnStartAt: null });
          finishRegen();
        });
    },

    /** 制作中屏：跳过剩余项立即开演；引擎正忙时等本回合结束自动接上 */
    skipPreload() {
      const s = get();
      if (s.screen !== "crafting" || s.preloadPhase === "starting" || s.preloadPhase === "finished") return;
      if (s.preloadPhase === "init" || s.preloadPhase === "planning") {
        // 待命/规划中跳过：队列还没建，直接（或待本回合结束后）「开演。」
        if (!s.engineBusy) {
          sendStart();
        } else {
          set({ skipRequested: true });
        }
        return;
      }
      set({
        preload: s.preload.map((i) => (i.state === "pending" || i.state === "running" ? { ...i, state: "skipped" } : i)),
      });
      if (!s.engineBusy) {
        // 空闲：直接推进（已无 pending → 发「开演。」）
        runNextPending();
      }
    },

    toggleDrawer() {
      set({ drawerOpen: !get().drawerOpen });
    },

    setTypingDone(done) {
      if (get().typingDone !== done) set({ typingDone: done });
    },

    openAssets() {
      // 画廊与游戏态共存：只切屏不动回合/画面状态，引擎忙时画廊内禁用重绘
      set({ screen: "assets", screenReturn: get().screen });
    },

    openCreation() {
      const fresh = get().screen !== "creation" && get().creationMessages.length === 0 && !get().creationResult;
      set({
        screen: "creation",
        screenReturn: get().screen,
        // 首次进入才重置创作态（从画廊往返不清空对话流）
        ...(fresh
          ? {
              creationMessages: [],
              assembling: false,
              assemblyStalled: false,
              creationCover: false,
              creationPortraits: [],
              creationResult: null,
              pendingCreationMessage: null,
              creationExitPrompt: false,
            }
          : {}),
      });
      if (fresh && !get().engineBusy) get().send(ENTER_CREATION);
    },

    closeOverlay() {
      const back = get().screenReturn ?? "title";
      set({ screen: back, screenReturn: null, assetsPreview: null, creationExitPrompt: false });
    },

    sendCreation(text) {
      const t = text.trim();
      if (!t) return;
      set({ creationMessages: [...get().creationMessages, { role: "player", text: t }] });
      if (t === BUILD_ASSEMBLE) set({ assembling: true, assemblyStalled: false });
      if (get().engineBusy) {
        // 引擎回合进行中（如进入创作的首回合）：排队，回合结束自动补发，玩家气泡已先出
        set({ pendingCreationMessage: t });
        return;
      }
      get().send(t);
    },

    finishCreation() {
      set({
        screen: "title",
        screenReturn: null,
        creationMessages: [],
        assembling: false,
        assemblyStalled: false,
        creationCover: false,
        creationPortraits: [],
        creationResult: null,
        pendingCreationMessage: null,
        creationExitPrompt: false,
        turnStartAt: null,
      });
    },

    setAssetsPreview(a) {
      set({ assetsPreview: a });
    },

    requestCreationExit() {
      const s = get();
      if (s.screen !== "creation") return;
      if (s.creationMessages.length > 0) {
        set({ creationExitPrompt: true });
      } else {
        s.closeOverlay();
      }
    },

    closeCreationExitPrompt() {
      set({ creationExitPrompt: false });
    },

    beginNewWorld(worldId) {
      clearWatchdog();
      resetRunState({ worldId, worldLabel: worldId, screen: "protagonist" });
    },

    resumeWorld(entry) {
      clearWatchdog();
      resetRunState({
        worldId: entry.worldId,
        worldLabel: entry.note || entry.worldId,
        chapterNo: entry.chapterNo || 1,
        screen: "game",
      });
      get().send(buildResumeCommand(entry.worldId));
    },

    openTree() {
      // 与画廊同构的 overlay：只切屏不动回合；游戏内与制作中屏都能进
      set({ screen: "tree", screenReturn: get().screen, treeNotice: null, treeFocus: null, forkResult: null });
    },

    refreshTree() {
      set({ treeStamp: get().treeStamp + 1 });
    },

    setTreeNotice(n) {
      set({ treeNotice: n });
    },

    setTreeFocus(nodeId) {
      set({ treeFocus: nodeId });
    },

    sendTreeEdit(text) {
      const t = text.trim();
      if (!t) return;
      const cmd = buildTreeEditCommand(t);
      if (get().engineBusy) {
        // 同创作屏排队模式：回合结束自动补发（见 handleEvent turn_end）
        set({ pendingTreeMessage: cmd, treeNotice: "引擎忙，已排队，就绪后自动发送" });
        return;
      }
      set({ treeAsk: true, treeNotice: null });
      get().send(cmd);
    },

    forkAt(nodeId) {
      const s = get();
      if (!s.worldId || !nodeId) return;
      // 分叉是 server 侧的文件操作（复制 + 回退 + fork.md），不占用引擎回合，也不推演内容
      set({ treeNotice: "正在分叉…" });
      postWorld({ action: "fork", worldId: s.worldId, nodeId })
        .then((r) => {
          if (!r.ok || !r.worldId) {
            set({ treeNotice: `分叉失败：${r.error ?? "未知错误"}` });
            return;
          }
          set({
            forkResult: { worldId: r.worldId, nodeId },
            treeNotice: `已创建世界线 ${r.worldId}（分叉自 ${s.worldId} @ ${nodeId}）· 分叉不推演，切换后从该节点续演`,
            treeStamp: get().treeStamp + 1,
          });
        })
        .catch((e: unknown) => set({ treeNotice: `分叉失败：${String(e)}` }));
    },

    switchToFork() {
      const s = get();
      const f = s.forkResult;
      if (!f) return;
      if (s.engineBusy) {
        set({ treeNotice: "引擎忙，等这一轮结束再切换" });
        return;
      }
      s.closeOverlay();
      get().resumeWorld({ worldId: f.worldId, chapterNo: s.chapterNo, note: `分叉自 ${s.worldId} @ ${f.nodeId}` });
    },

    startRegen(type, key, matchName) {
      const s = get();
      // 重绘走引擎回合：忙时等本轮结束再点（按钮禁用兜底，此处再挡一层 409）
      if (s.engineBusy || s.regenPending) return;
      set({ regenPending: `${type}|${matchName}` });
      get().send(buildRegenCommand(type, key));
    },

    handleEvent(event) {
      const s = get();
      switch (event.type) {
        case "turn_start": {
          set({ segs: { 0: "" }, curSeg: 0, engineBusy: true, turnStartAt: Date.now() });
          resetTurnState(s.turnKey + 1);
          break;
        }
        case "seg": {
          if (event.seg > s.curSeg) {
            set({
              curSeg: event.seg,
              // 规划中引擎的写树工具调用会触发段切换，文案保持「撰写章节大纲…」不被通用状态覆盖
              status: s.preloadPhase === "planning" ? "撰写章节大纲…" : segStatusLabel(event.label),
            });
            resetTurnState(s.turnKey + 1);
          }
          break;
        }
        case "chunk": {
          const segs = { ...s.segs, [event.seg]: (s.segs[event.seg] ?? "") + event.text };
          set({ segs, received: segs[event.seg] });
          applyMarkers(scanMarkers(segs[event.seg]), true);
          break;
        }
        case "expression": {
          // 【立绘】表情切换：差分素材未生成（404）时由 PortraitLayer 回退基础图
          set({ portrait: nextPortraitOnExpression(s.portrait, event.character, event.variant, s.selected?.id ?? "") });
          break;
        }
        case "presetAdded": {
          // 【新剧本】入轮播：刷新 presets（TitleScreen 读 store.presets），创作屏转成功态
          set({ creationResult: event.id, assembling: false, assemblyStalled: false });
          fetchPresets()
            .then((r) => set({ presets: r.presets }))
            .catch(() => {
              // 刷新失败不打断成功态；回 title 时 TitleScreen 挂载会重新拉取
            });
          break;
        }
        case "treeEdited": {
          // 【树】协议行：引擎已静默写回剧情树——图屏据此重取（编辑回合的可见摘要随 turn_end 落 treeNotice）
          set({ treeStamp: s.treeStamp + 1, ...(event.note ? { treeNotice: event.note } : {}) });
          break;
        }
        case "turn_end": {
          const finalText = s.segs[s.curSeg] ?? "";
          applyMarkers(finalMarkers(finalText), false);
          // 重绘回合结束：标记若未命中也解除挂起（文件落盘可能晚于标记，统一刷一次清单）
          finishRegen();
          // 制作中阶段引擎只回确认/清单/标记，不进历史；「开演。」后的开场正文正常记录
          const craftingNoise =
            s.screen === "crafting" &&
            (s.preloadPhase === "init" || s.preloadPhase === "planning" || s.preloadPhase === "queue");
          const clean = craftingNoise || s.screen === "creation" || s.treeAsk ? "" : cleanForHistory(finalText);
          set({
            finalText,
            options: parseOptions(finalText),
            status: "就绪",
            engineBusy: false,
            turnStartAt: null,
            history: clean ? [...s.history, { n: `第 ${s.turnNo + 1} 幕`, t: clean }] : s.history,
            turnNo: clean ? s.turnNo + 1 : s.turnNo,
          });
          if (s.screen === "creation") {
            // 创作屏：引擎整轮回复（跨段全文）过滤协议行后进对话流；协议行只驱动画面/事件
            const engineText = Object.values(s.segs)
              .join("\n")
              .split("\n")
              .filter((l) => !isProtocolLine(l))
              .join("\n")
              .trim();
            const c = get();
            set({
              ...(engineText ? { creationMessages: [...c.creationMessages, { role: "engine" as const, text: engineText }] } : {}),
              // 装配回合结束仍没有【新剧本】：置为可重试
              ...(c.assembling ? { assembling: false, assemblyStalled: true } : {}),
            });
          }
          if (s.treeAsk) {
            // 剧情图编辑回合：可见摘要进图屏提示条（不进历史），并让图屏重取树
            const visible = Object.values(s.segs)
              .join("\n")
              .split("\n")
              .filter((l) => !isProtocolLine(l))
              .join("\n")
              .trim();
            set({ treeAsk: false, treeStamp: get().treeStamp + 1, ...(visible ? { treeNotice: visible } : {}) });
          }
          // 创作屏排队消息补发（不筛屏：覆盖排队后 Esc 离屏的滞留场景；server busy 已在本事件前复位）
          const pendingMsg = get().pendingCreationMessage;
          if (pendingMsg) {
            set({ pendingCreationMessage: null });
            get().send(pendingMsg);
          }
          // 图屏排队编辑指令补发（同排队模式；treeAsk 提前置位，保证该回合不进历史）
          const pendingTree = get().pendingTreeMessage;
          if (pendingTree) {
            set({ pendingTreeMessage: null, treeAsk: true, treeNotice: null });
            get().send(pendingTree);
          }
          clearWatchdog();
          void advancePreload();
          const g = get();
          if (g.awaitCommand === "/new-game" || g.awaitCommand === "/presets") {
            set({ screen: "title", awaitCommand: null });
            break;
          }
          // 章标记（终章回合，全文可能跨段）：切制作中屏并规划下一章
          const mark = parseChapterMark(Object.values(s.segs).join("\n"));
          if (mark !== null && get().screen === "game") {
            const next = mark + 1;
            set({
              screen: "crafting",
              chapterNo: next,
              preload: [],
              skipRequested: false,
              artReady: {},
              seenMarkerKeys: new Set(),
              options: null,
              typingDone: false,
            });
            beginPlanning(next);
          }
          break;
        }
        case "error": {
          onEngineError(event.message);
          break;
        }
      }
    },
  };
});
