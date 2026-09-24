// @vitest-environment jsdom
// AudioManager 单例（拆自 tests/ui.test.tsx）：索引建立、未就绪挂起与补播、交叉淡入、音效并发上限与兜底超时、
// 失败/在途不再重拉、无 audio 目录静默降级，以及 store 接线。基线复位由 ./helpers 的 setupUi() 统一负责。

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useGameStore } from "../../src/store/game";
import { FADE_MS, MAX_SFX, SFX_TIMEOUT_MS, audioManager } from "../../src/lib/audio";
import { DEFAULT_SETTINGS } from "../../src/lib/settings";
import { type AudioItem } from "../../src/lib/acp";
import { PRESET, jsonResponse, setupUi } from "./helpers";

setupUi();

describe("AudioManager：索引、交叉淡入与静默降级（v1.6）", () => {
  /** GET /api/audio 返回的索引（单个用例可覆盖）；曲的两条故意不给 url，逼前端按 preset+file 兜底拼 */
  let items: AudioItem[];
  /** play() 收到的元素 src（按调用顺序）——prototype 打桩，避免 jsdom 打 "not implemented" */
  let played: string[];
  /** pause() 收到的元素（淡出结束 / stopAll 时才会出现） */
  let paused: HTMLAudioElement[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let debugSpy: MockInstance<typeof console.debug>;

  /** jsdom 会把相对 src 解析成绝对 URL，断言前先解码（中文路径全被 encodeURIComponent 过） */
  const decode = (s: string) => decodeURIComponent(s);

  /** 清空 play/pause 计数：setPreset 的 stopAll 会 pause 上一轮残留的元素，那是复位噪声不是行为 */
  const resetCounters = () => {
    played = [];
    paused = [];
  };

  beforeEach(async () => {
    items = [
      { kind: "曲", name: "雨夜", file: "presets/demo/audio/曲-雨夜.mp3", url: "" },
      { kind: "曲", name: "晴日", file: "presets/demo/audio/曲-晴日.mp3", url: "" },
      { kind: "环境", name: "旅店大堂", file: "presets/demo/audio/环境-旅店大堂.mp3", url: "/audio?p=env-旅店大堂" },
      { kind: "音效", name: "门响", file: "presets/demo/audio/音效-门响.wav", url: "/audio?p=sfx-门响" },
    ];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/audio") return jsonResponse({ items });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      played.push(this.src);
      return Promise.resolve();
    });
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      paused.push(this);
    });
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // 单例跨用例共享：先清空索引/通道并回默认音量，避免上一用例的曲与设置串味。
    // 注意顺序——这步 stopAll 会 pause 上一用例残留的元素，所以计数数组必须在其后再清空。
    await audioManager.setPreset("");
    audioManager.applySettings({ ...DEFAULT_SETTINGS });
    resetCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("setPreset 建索引：【曲】走 preset+file 兜底 URL，服务端给了 url 就照用", async () => {
    await audioManager.setPreset("demo");
    expect(fetchMock).toHaveBeenCalledWith("/api/audio?preset=demo", expect.anything());

    audioManager.handle({ kind: "曲", name: "雨夜" });
    expect(played).toHaveLength(1);
    expect(decode(played[0])).toBe("http://localhost:3000/audio?p=presets/demo/audio/曲-雨夜.mp3");

    audioManager.handle({ kind: "环境", name: "旅店大堂" });
    expect(decode(played.at(-1) ?? "").endsWith("/audio?p=env-旅店大堂")).toBe(true);
  });

  it("索引未就绪：【曲】/【环境】各挂起最近一次，就绪后补播；【音效】不挂起", async () => {
    const loading = audioManager.setPreset("demo"); // 索引请求在途
    audioManager.handle({ kind: "曲", name: "不存在的旧曲" });
    audioManager.handle({ kind: "曲", name: "雨夜" }); // 后到的覆盖先到的
    audioManager.handle({ kind: "环境", name: "旅店大堂" });
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toEqual([]); // 未就绪：一条都不播

    await loading;
    expect(played.filter((s) => decode(s).includes("曲-雨夜"))).toHaveLength(1);
    expect(played.filter((s) => decode(s).endsWith("/audio?p=env-旅店大堂"))).toHaveLength(1);
    expect(played.some((s) => decode(s).includes("不存在的旧曲"))).toBe(false);
    expect(played.some((s) => s.includes("sfx"))).toBe(false); // 音效一次性：错过就错过
  });

  it("交叉淡入：换曲走另一个元素，旧曲在 FADE_MS 后暂停；同一首重复请求不重启；「停」淡出后暂停", async () => {
    vi.useFakeTimers();
    await audioManager.setPreset("demo");
    resetCounters(); // 上面的建索引会先 stopAll（复位噪声），从这里开始只数本用例的播放

    // 第一首：另一侧是还没播过的空元素（音量 0 → 收尾即停，无 600ms 斜坡），先让它淡入到位
    audioManager.handle({ kind: "曲", name: "雨夜" });
    vi.advanceTimersByTime(FADE_MS + 100);
    const first = played.at(-1)!;
    paused.length = 0;

    audioManager.handle({ kind: "曲", name: "晴日" });
    expect(played.at(-1)).not.toBe(first); // 双元素：换到另一侧淡入
    expect(paused).toEqual([]); // 旧曲还在淡出，先不打断
    vi.advanceTimersByTime(FADE_MS + 100);
    expect(paused.map((el) => el.src)).toEqual([first]); // 淡出结束才 pause

    const before = played.length;
    audioManager.handle({ kind: "曲", name: "晴日" });
    expect(played).toHaveLength(before); // 同一首在播：不从头重来

    paused.length = 0;
    audioManager.handle({ kind: "曲", name: "停" });
    expect(played).toHaveLength(before); // 「停」不播任何新音频
    expect(paused).toEqual([]);
    vi.advanceTimersByTime(FADE_MS + 100);
    expect(paused).toHaveLength(1); // 淡出到 0 才停
  });

  it("音效一次性：并发上限 4，超出丢弃；文件缺失静默 no-op（只留 console.debug 线索）", async () => {
    await audioManager.setPreset("demo");
    for (let i = 0; i < 6; i++) audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX);
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("并发"))).toBe(true);

    const n = played.length;
    audioManager.handle({ kind: "音效", name: "没放的文件" });
    expect(played).toHaveLength(n); // 解析不到文件就不播，也不抛
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("没放的文件"))).toBe(true);
  });

  it("音效槽位兜底超时：ended/error/play 全被挂起时到点释放（4 个槽占满后本会话仍有音效）", async () => {
    vi.useFakeTimers();
    // 抓住管理器内部新建的播放元素：本用例要手动派发 ended，验证「事件先到就撤定时器」
    const created: HTMLAudioElement[] = [];
    const RealAudio = window.Audio;
    vi.stubGlobal("Audio", function AudioStub() {
      const el = new RealAudio();
      created.push(el);
      return el;
    });
    await audioManager.setPreset("demo");
    resetCounters();

    for (let i = 0; i < MAX_SFX; i++) audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX);
    // jsdom ≥30.1 把 volumechange 改成排一个媒体任务（内部走 setImmediate，见 30.1.0 发行说明
    // "Fixed volumechange and ratechange events to fire asynchronously"）：audio.ts 每次 setVolume
    // 都会顺带排一条，它也进 vi.getTimerCount()。先排空这类任务（0ms，碰不到 8000ms 的兜底超时），
    // 剩下的才是每条音效各挂的那一条。
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(MAX_SFX); // 每条音效各挂一条兜底超时
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX); // 槽满：第 5 条丢弃（ended/error/play 都没来）
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("并发"))).toBe(true);

    vi.advanceTimersByTime(SFX_TIMEOUT_MS); // 兜底到点：槽位照样释放（否则本会话再无音效）
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX + 1); // 超时释放后放得下新的音效

    // ended 先到：立刻释放且撤掉兜底定时器（不会出现第二次释放），槽位随即可再用
    created.at(-1)!.dispatchEvent(new Event("ended"));
    vi.advanceTimersByTime(0); // 同上：先排空第 5 条音效那份 volume 变更任务，才看得到「兜底定时器已被撤掉」
    expect(vi.getTimerCount()).toBe(0);
    audioManager.handle({ kind: "音效", name: "门响" });
    expect(played).toHaveLength(MAX_SFX + 2);
  });

  it("索引失败：同一个本再选不重复请求、也不再多停一次通道（每个本只写一行告警）", async () => {
    /** /api/audio 被问了几次某个本（mock fetch 计数） */
    const calls = (id: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(`preset=${id}`)).length;

    // 基线：索引就绪的本——重复选本本来就不重拉、也不该打断在播的曲（元素还挂在通道上）
    await audioManager.setPreset("demo");
    audioManager.handle({ kind: "曲", name: "雨夜" });
    expect(played).toHaveLength(1);
    expect(calls("demo")).toBe(1);
    paused.length = 0; // 建索引那一次的 stopAll 是换本的正常代价，不计入「被打断」
    await audioManager.setPreset("demo");
    expect(calls("demo")).toBe(1);
    expect(paused).toEqual([]); // 在播的曲没被 stopAll 掐掉

    // 索引失败的本（服务端 500）：只拉一次，之后同一个本再选不再打扰服务端
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      return String(input).includes("preset=broken")
        ? jsonResponse({ error: "boom" }, 500)
        : jsonResponse({ items: [] });
    });
    await audioManager.setPreset("broken");
    expect(calls("broken")).toBe(1);
    const before = played.length;
    audioManager.handle({ kind: "曲", name: "雨夜" }); // 索引空 = 这个本静默不播（也不抛）
    expect(played).toHaveLength(before);
    paused.length = 0;

    await audioManager.setPreset("broken"); // ← 修正前的 bug 点：每次选本都 stopAll + 重拉
    expect(calls("broken")).toBe(1);
    expect(paused).toEqual([]); // stopAll 会对 4 个通道元素各 pause 一次：这里必须一次都没有
    expect(debugSpy.mock.calls.filter((c) => String(c[0]).includes("broken"))).toHaveLength(1); // 告警只留一行
  });

  it("索引在途：同一个本连发两次只打一次接口（在途早退，不再 stopAll）", async () => {
    /** 在途请求的释放钩子（此刻先占位，等模拟「索引还没回来」时替换成真的 resolve） */
    let release = () => {};
    let calls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (!String(input).includes("preset=inflight")) return jsonResponse({}, 404);
      calls += 1;
      await new Promise<void>((r) => {
        release = r;
      });
      return jsonResponse({ items: [] });
    });

    const first = audioManager.setPreset("inflight"); // 在途（换本那一次的 stopAll 是正常代价）
    expect(calls).toBe(1);
    const paused0 = paused.length;
    await audioManager.setPreset("inflight"); // 在途再选：直接早退
    expect(calls).toBe(1);
    expect(paused).toHaveLength(paused0); // 没有第二次 stopAll

    release();
    await first;
    audioManager.handle({ kind: "曲", name: "雨夜" }); // items 空：索引里没有它 → 静默不播
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("没有【曲】"))).toBe(true);
    expect(played).toEqual([]);
  });

  it("剧本没有 audio 目录（items 空）与无剧本上下文：全部静默 no-op，不抛", async () => {
    items = [];
    await audioManager.setPreset("demo");
    expect(() => {
      audioManager.handle({ kind: "曲", name: "雨夜" });
      audioManager.handle({ kind: "环境", name: "停" });
      audioManager.handle({ kind: "音效", name: "门响" });
    }).not.toThrow();
    expect(played).toEqual([]);

    await audioManager.setPreset(""); // 无剧本上下文：索引清空，请求直接丢
    expect(() => audioManager.handle({ kind: "曲", name: "雨夜" })).not.toThrow();
    expect(played).toEqual([]);
  });

  it("store 接线：selectPreset 换本先换索引；audio 事件转发到管理器且不碰画面/回合状态", async () => {
    useGameStore.getState().selectPreset(PRESET);
    expect(fetchMock).toHaveBeenCalledWith("/api/audio?preset=campus-summer", expect.anything());
    useGameStore.getState().selectPreset({ ...PRESET, id: "twilight-throne" });
    expect(fetchMock).toHaveBeenCalledWith("/api/audio?preset=twilight-throne", expect.anything());

    // 索引是 store 里 void 出去的异步：让出一个宏任务把 fetch/JSON 的微任务队列跑完（定长等待，无轮询）
    await new Promise((r) => setTimeout(r, 0));
    useGameStore.getState().handleEvent({ type: "audio", kind: "曲", name: "雨夜" });
    useGameStore.getState().handleEvent({ type: "audio", kind: "音效", name: "门响" });
    expect(decode(played.find((s) => s.includes("audio?p=")) ?? "")).toContain("曲-雨夜.mp3"); // 索引按新本的条目播
    expect(played.some((s) => decode(s).endsWith("/audio?p=sfx-门响"))).toBe(true);
    // 音频是完全的旁路：不写任何画面/回合字段
    expect(useGameStore.getState().received).toBe("");
    expect(useGameStore.getState().bgUrl).toBeNull();
  });
});
