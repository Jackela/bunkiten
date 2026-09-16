// 音频管理器（v1.6，CONTRACTS §1 客户端细则）：BGM/环境双通道交叉淡入（≈600ms）、音效一次性（并发≤4）。
// 设计要点：
// - 单例挂在 store 之外、不依赖 React：SSE 的 audio 事件由 store 转发进来，组件不碰音频元素。
// - 「类型+名 → 文件」只认 /api/audio 索引（换本先 stopAll 再重建）：协议行不携带路径，
//   解析不到就是没放文件（或该剧本没有 audio 目录）——一律静默 no-op，绝不打断剧情。
// - 索引未就绪（首次拉取中）时【曲】/【环境】各挂起最近一次、就绪后补播；【音效】是一次性的，不挂起。
// - 索引记账（v1.6 修正）：同一剧本「在途 / 就绪 / 已判定失败」三种情况都不重拉、更不 stopAll——
//   索引失败是常态（剧本没放 audio 目录），只看 ready 的话每次选本都会把正在播的曲掐掉再重拉一遍。
// - 音效槽位有兜底超时（{@link SFX_TIMEOUT_MS}）：ended/error/play 全被环境挂起时到点照样释放，
//   否则 4 个槽被无名音效永久占满，本会话再也放不出音效。
// - 淡入淡出用 setTimeout 步进而非 rAF：后台标签页里 rAF 会完全停摆（旧曲不淡出、新曲永远 0 音量），
//   setTimeout 只是被节流成更慢的斜坡，行为仍收敛；node 单测（无 DOM/无 rAF）同样走这条路。
import { audioFileUrl, fetchAudio } from "./acp";
import type { AudioKind } from "./parser";
import { DEFAULT_SETTINGS, clamp01, type GameSettings } from "./settings";

/** 交叉淡入/淡出时长（≈600ms，CONTRACTS §1） */
export const FADE_MS = 600;
/** 淡入步进间隔（≈60 帧/秒；被后台节流也只是斜坡变慢） */
const FADE_TICK_MS = 16;
/** 音效并发上限：超出直接丢弃（音效是点缀，排队补放只会更难听） */
export const MAX_SFX = 4;
/**
 * 音效槽位兜底超时（ms）：ended/error/play 三者都可能被环境挂起（静音策略、解码卡住、音频设备被拔、
 * jsdom 的 play 打桩不触发任何事件），只靠事件摘除会让 {@link MAX_SFX} 个槽被无名音效永久占满。
 * 8s 远长于任何点缀音效（超时后元素照旧放着，只是把槽位让出来），代价可以忽略。
 */
export const SFX_TIMEOUT_MS = 8000;
/** 「停」字面：【曲】停/【环境】停 = 淡出停止；【音效】没有停止语义 */
const STOP_NAME = "停";

/** 双通道（BGM / 环境音）的协议字面 */
type ChannelKind = Extract<AudioKind, "曲" | "环境">;

const CHANNEL_KINDS: ChannelKind[] = ["曲", "环境"];

/** 一条音频请求（SSE 事件与内部调用共用；AudioKind 来自 parser 的 AUDIO_KINDS） */
export interface AudioRequest {
  kind: AudioKind;
  name: string;
}

/** 一条通道：交叉淡入用的一对元素 + 当前在播的一侧 + 在途淡入的作废令牌 */
interface Channel {
  /** [A, B]：一个在播、一个待淡入；null = 无 DOM 环境（node 单测） */
  els: [HTMLAudioElement | null, HTMLAudioElement | null];
  /** 当前在播的一侧下标 */
  active: 0 | 1;
  /** 当前曲名（null=没有在播；重复请求同一首不重启，避免场景回切时从头炸起） */
  name: string | null;
  /**
   * 是否有已发起播放的曲目。为什么不看 element.paused：jsdom / 静音策略下 paused 可能不翻转，
   * 而「同一首要不要重启」是我们自己的决策，得有自己的状态（也便于单测）。
   */
  playing: boolean;
  /** 淡入令牌：每次播放/停止/清空自增，旧帧据此自我作废（省掉一套 cancel 记账） */
  token: number;
}

/** 索引键：`类型|名`（协议行的两个字段就是全部信息，不需要路径） */
function audioKey(kind: AudioKind, name: string): string {
  return `${kind}|${name}`;
}

/**
 * 建一个播放元素；无 Audio 构造器（node 单测、极端环境）返回 null——
 * 所有播放路径都对 null 保持 no-op，音频永远不该让游戏崩。
 */
function createElement(): HTMLAudioElement | null {
  if (typeof Audio !== "function") return null;
  try {
    const el = new Audio();
    el.preload = "auto";
    return el;
  } catch {
    return null;
  }
}

/** 音量赋值（部分环境 volume setter 会抛：静默） */
function setVolume(el: HTMLAudioElement, v: number): void {
  try {
    el.volume = clamp01(v);
  } catch {
    /* 忽略：音量设置失败不影响播放 */
  }
}

/**
 * 播放：浏览器自动播放策略、文件缺失（404）、解码失败都会 reject——
 * 一律静默（rejection 不吞会导致 unhandledrejection 污染控制台，且剧情不该因音频中断）。
 * @param {HTMLAudioElement} el 目标元素
 * @param {() => void} [onFail] 失败回调（音效据此从并发计数里摘掉）
 */
function play(el: HTMLAudioElement, onFail?: () => void): void {
  try {
    const p = el.play() as Promise<void> | undefined;
    if (p && typeof p.catch === "function") p.catch(() => onFail?.());
  } catch {
    // jsdom / 受限环境：play 未实现，静默
    onFail?.();
  }
}

function pause(el: HTMLAudioElement): void {
  try {
    // pause 会触发浏览器自动暂停（jsdom 打到 "not implemented"）——必须包起来
    el.pause();
  } catch {
    /* 忽略 */
  }
}

/**
 * 音频管理器：一次只放一条 BGM 与一条环境音，音效可叠加。
 * 除 setPreset 外全部方法都是同步副作用，调用方（store）不需要 await 任何东西。
 */
export class AudioManager {
  /** 当前剧本 id（null=没有剧本上下文，所有播放请求静默丢弃） */
  private presetId: string | null = null;
  /** `类型|名` → 直服 URL（来自 /api/audio 的索引；命不中即「文件缺失」） */
  private index = new Map<string, string>();
  /** 索引是否就绪（拉取成功；失败保持 false——本会话不再重拉，见 indexFailedId） */
  private ready = false;
  /**
   * 索引请求在途的剧本 id（null=没有在途请求）。
   * 早退条件之一：同一个本在途时再调 setPreset 直接 return——既不重复打接口，也不 stopAll
   * （选本屏的卡点/重渲染会把 setPreset 反复调起来，这里必须幂等）。
   */
  private inFlightId: string | null = null;
  /** 索引请求序号：每次发起自增，收尾时只清「自己那一笔」在途标记（旧请求不许擦掉新请求的） */
  private indexSeq = 0;
  /**
   * 已判定「索引不可用」的剧本 id（本会话不再重拉）。
   * 为什么必须记账：失败后 ready 恒为 false，只靠 ready 早退的话每次 selectPreset 都会
   * stopAll（把正在播的曲掐掉）+ 重拉一遍，表现为「点同一个本，音乐莫名停了」。
   * 代价是服务端后来补了音频目录也要重开应用才生效——比每次选本都打断演出划算。
   */
  private indexFailedId: string | null = null;
  /** 索引未就绪时挂起的最近一次【曲】/【环境】（就绪后补播；各通道最多留一条） */
  private pending = new Map<ChannelKind, string>();
  /**
   * 已经提示过「索引不可用」的剧本 id（每个 preset 只留一行 debug）。
   * 为什么按 preset 记账而不是每次 setPreset 都报：索引失败是常态（剧本没放 audio 目录 / 服务端没有该接口），
   * 而 setPreset 会在选本、换本、单测里被反复调用——每次刷一行会让真正的异常淹没在噪音里。
   */
  private indexWarned = new Set<string>();
  /** 最近一次应用的设置（音量换算的唯一来源） */
  private settings: GameSettings = { ...DEFAULT_SETTINGS };
  private channels: Record<ChannelKind, Channel>;
  /** 在播的一次性音效（并发计数；ended/error/play 失败/兜底超时任一先到即摘除） */
  private sfx = new Set<HTMLAudioElement>();
  /** 音效槽位的兜底超时句柄（元素 → 定时器）：stopAll 时一并清掉，不让定时器活过本会话 */
  private sfxTimers = new Map<HTMLAudioElement, ReturnType<typeof setTimeout>>();

  constructor() {
    this.channels = {
      曲: { els: [createElement(), createElement()], active: 0, name: null, playing: false, token: 0 },
      环境: { els: [createElement(), createElement()], active: 0, name: null, playing: false, token: 0 },
    };
  }

  /**
   * 换剧本：先停掉现有两条通道，再拉 /api/audio 建索引。
   * **同一剧本**（{@link presetId} 已是它）三种情况一律直接 return：索引就绪、请求在途、已判定失败——
   * 三种都别 stopAll：正在播的曲不该因为「又选了一次同一个本」被掐掉，索引也不该被反复重拉。
   * 失败静默：没有音频的剧本（目录不存在 → 空数组）与请求失败的剧本行为一致——都不播。
   * @param {string} presetId 剧本 id（空串 = 回到无剧本上下文，并把索引与失败记账一并清零）
   * @returns {Promise<void>} 索引就绪（或失败落定）后 resolve；调用方通常不 await
   */
  async setPreset(presetId: string): Promise<void> {
    const id = (presetId ?? "").trim();
    if (this.presetId === id && (this.ready || this.inFlightId === id || this.indexFailedId === id)) return;
    this.stopAll();
    this.presetId = id || null;
    this.index.clear();
    this.ready = false;
    this.pending.clear();
    this.indexFailedId = null; // 新的一轮索引：失败记账随索引一起清
    if (!this.presetId) return;
    const fetchId = this.presetId;
    const seq = ++this.indexSeq;
    this.inFlightId = fetchId;
    try {
      const items = await fetchAudio(fetchId);
      if (this.presetId !== id) return; // 期间又换了本：结果过期，丢弃
      for (const item of items) {
        const url = item.url || audioFileUrl(id, item.file);
        if (item.name && url) this.index.set(audioKey(item.kind, item.name), url);
      }
      this.ready = true;
      this.flushPending();
    } catch (e) {
      // 静默：拉不到索引只意味着这个本没有音频可用（服务端没有 /api/audio、目录不存在、请求失败一视同仁）。
      // 语义仍是「不播」；线索每个剧本只留一行 debug（不带 Error 对象，避免把栈打进控制台噪音）。
      // 记账 indexFailedId：同一个本本会话不再重拉（上面第三条早退），也就不会再顺带 stopAll。
      // 期间又换了本则这次失败与当前本无关，不记账（那次换本的 stopAll 是正常代价）。
      if (this.presetId !== id) return;
      this.indexFailedId = id;
      if (!this.indexWarned.has(id)) {
        this.indexWarned.add(id);
        console.debug(`[音频] ${id} 的音频索引不可用，本剧本静默不播：${(e as Error).message ?? e}`);
      }
    } finally {
      // 只清自己那一笔：期间若已发出更新的请求（换本/重置后又回到同一个本），在途标记归它
      if (this.indexSeq === seq) this.inFlightId = null;
    }
  }

  /**
   * 处理一条音频协议行（store 的 audio 事件入口）。
   * @param {AudioRequest} req kind=曲/环境/音效，name=短名（「停」对曲/环境 = 淡出停止）
   */
  handle(req: AudioRequest): void {
    const kind = req?.kind;
    const name = (req?.name ?? "").trim();
    if (!kind || !name || !this.presetId) return;
    if (kind === "音效") {
      // 音效无停止语义：「停」不作用于它（一次性播完即止）
      if (name !== STOP_NAME) this.playOneShot(name);
      return;
    }
    const ch = this.channels[kind];
    if (!ch) return;
    if (name === STOP_NAME) {
      this.fadeOut(kind);
      return;
    }
    if (!this.ready) {
      // 索引还没就绪：挂起最近一次，就绪后补播（避免开场第一句的【曲】被索引请求吃掉）
      this.pending.set(kind, name);
      return;
    }
    this.playChannel(kind, name);
  }

  /** 停掉全部通道与音效（换剧本 / 回标题时用）：立即停，不做淡出（旧本的音乐不该多留半秒） */
  stopAll(): void {
    for (const kind of CHANNEL_KINDS) {
      const ch = this.channels[kind];
      ch.token += 1; // 作废在途淡入
      ch.name = null;
      ch.playing = false;
      for (const el of ch.els) {
        if (!el) continue;
        pause(el);
        setVolume(el, 0);
      }
    }
    for (const el of this.sfx) pause(el);
    this.sfx.clear();
    // 兜底超时一并撤掉：元素都停了，定时器留着只会晚一步空跑（还让测试进程多挂几秒）
    for (const timer of this.sfxTimers.values()) clearTimeout(timer);
    this.sfxTimers.clear();
    this.pending.clear();
  }

  /**
   * 应用设置：主音量 × 通道音量，静音时归 0。立即作用到在播的通道上。
   * 正在淡入的 600ms 内以淡入终值为准（下一帧会覆盖），这也是刻意的：改音量不该打断换曲。
   * @param {GameSettings} settings 最新设置
   */
  applySettings(settings: GameSettings): void {
    this.settings = { ...settings };
    for (const kind of CHANNEL_KINDS) {
      const ch = this.channels[kind];
      const el = ch.els[ch.active];
      if (el && !el.paused) setVolume(el, this.channelGain(kind));
    }
  }

  /** 通道目标音量 = 主音量 × 通道音量（静音归 0） */
  private channelGain(kind: ChannelKind): number {
    if (this.settings.muted) return 0;
    const base = kind === "曲" ? this.settings.bgm : this.settings.ambient;
    return clamp01(this.settings.master) * clamp01(base);
  }

  /** 音效目标音量 = 主音量 × 音效音量（静音归 0） */
  private sfxGain(): number {
    if (this.settings.muted) return 0;
    return clamp01(this.settings.master) * clamp01(this.settings.sfx);
  }

  /** 索引就绪后补播挂起的【曲】/【环境】（各通道最多一条，后到的覆盖先到的） */
  private flushPending(): void {
    if (this.pending.size === 0) return;
    const queued = [...this.pending.entries()];
    this.pending.clear();
    for (const [kind, name] of queued) this.playChannel(kind, name);
  }

  /**
   * 播一条通道（重复请求同一首且仍在播 = 不重启）。
   * 交叉淡入：旧元素 600ms 淡出后 pause，新元素 0 → 目标音量淡入。
   */
  private playChannel(kind: ChannelKind, name: string): void {
    const url = this.index.get(audioKey(kind, name));
    if (!url) {
      // 文件缺失（或该剧本没有 audio 目录）：静默 no-op
      console.debug(`[音频] 没有【${kind}】${name} 对应的文件，静默跳过`);
      return;
    }
    const ch = this.channels[kind];
    if (ch.name === name && ch.playing) return; // 同一首在播：继续放，别从头重来
    const from = ch.els[ch.active];
    const to = ch.els[ch.active === 0 ? 1 : 0];
    ch.active = ch.active === 0 ? 1 : 0;
    ch.name = name;
    ch.playing = true;
    const token = ++ch.token;
    if (!to) return; // 无 DOM 环境：索引照常维护，播放 no-op
    try {
      to.src = url;
      to.currentTime = 0;
    } catch {
      /* 尚不可 seek（jsdom/未加载完）：忽略 */
    }
    setVolume(to, 0);
    play(to);
    if (from) this.fade(ch, from, from.volume, 0, token, () => pause(from));
    this.fade(ch, to, 0, this.channelGain(kind), token);
  }

  /** 【曲】停 /【环境】停：淡出当前元素并暂停，通道回到「没有在播」 */
  private fadeOut(kind: ChannelKind): void {
    const ch = this.channels[kind];
    const el = ch.els[ch.active];
    ch.name = null;
    ch.playing = false;
    const token = ++ch.token;
    if (!el) return;
    this.fade(ch, el, el.volume, 0, token, () => pause(el));
  }

  /**
   * 播一条一次性音效（并发≤{@link MAX_SFX}，超出丢弃；播完自动摘出计数）。
   * 摘除有四条路：ended / error / play 失败 / 兜底超时——先到者生效并撤掉其余（见 done）。
   */
  private playOneShot(name: string): void {
    if (!this.ready) return; // 一次性音效不挂起：错过就错过，补播反而错位
    const url = this.index.get(audioKey("音效", name));
    if (!url) {
      console.debug(`[音频] 没有【音效】${name} 对应的文件，静默跳过`);
      return;
    }
    if (this.sfx.size >= MAX_SFX) {
      console.debug(`[音频] 音效并发已达 ${MAX_SFX}，丢弃【音效】${name}`);
      return;
    }
    const el = createElement();
    if (!el) return;
    /**
     * 摘除本元素并释放槽位（幂等）：先撤兜底定时器与事件监听，避免同一条音效被释放两次。
     * 没有这条兜底，只要环境把 ended/error/play 全挂起，槽位就被永久占住。
     */
    const done = () => {
      const timer = this.sfxTimers.get(el);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.sfxTimers.delete(el);
      }
      el.removeEventListener?.("ended", done);
      el.removeEventListener?.("error", done);
      this.sfx.delete(el);
    };
    el.addEventListener?.("ended", done);
    el.addEventListener?.("error", done);
    this.sfx.add(el);
    this.sfxTimers.set(el, setTimeout(done, SFX_TIMEOUT_MS));
    try {
      el.src = url;
    } catch {
      done();
      return;
    }
    setVolume(el, this.sfxGain());
    play(el, done);
  }

  /**
   * 把元素音量从 from 线性推到 to（{@link FADE_MS} 内），结束时回调。
   * token 与通道当前令牌不一致 = 已被新的播放/停止取代，旧帧直接退出。
   */
  private fade(ch: Channel, el: HTMLAudioElement, from: number, to: number, token: number, onDone?: () => void): void {
    if (from === to) {
      // 已经在目标音量（0→0 的「停」、静音时的淡入）：不必排 600ms 的帧，直接收尾
      onDone?.();
      return;
    }
    const t0 = Date.now();
    const tick = () => {
      if (token !== ch.token) return; // 已被取代
      const k = Math.min(1, (Date.now() - t0) / FADE_MS);
      setVolume(el, from + (to - from) * k);
      if (k < 1) {
        setTimeout(tick, FADE_TICK_MS);
      } else {
        onDone?.();
      }
    };
    tick();
  }
}

/** 应用级单例（store 只与它对话；音频状态不进 React store，避免每帧音量改动触发重渲染） */
export const audioManager = new AudioManager();
