// 假引擎确定性 UI e2e（音频演出，v1.6）：【曲】/【环境】/【音效】协议行 → AudioManager 单例。
//
// 为什么单开一条：音频是整个前端里唯一「不进 React、也没有 DOM 挂点」的子系统——AudioManager
// （src/lib/audio.ts）挂在 store 之外，播放元素是游离的，store 里没有任何音频字段，屏幕上什么也看不见。
// 可观测面因此只剩两处，两条用例把这两处都钉住：
//   ① 网络：直服请求 /audio?p=presets/<id>/audio/<类型>-<名>.<ext>（索引 /api/audio 是另一个 pathname，不计入）；
//   ② 元素：AudioManager 造出来的 HTMLAudioElement 的 src / paused / volume / ended。
//
// 关于 ② 的观测装置：AudioManager 的 createElement 只 `new Audio()`，**从不挂进 document**——
// document.querySelectorAll("audio") 在真浏览器里恒为空（游离元素不在文档树里，这是确定的浏览器语义）。
// 所以这里用 addInitScript 把 Audio 构造器包一层当「登记簿」（window.__bunkitenAudio）：只登记、不改行为，
// 记下来的仍是同一个真元素（原型链、play/pause/volume 全走原生实现）。
//
// 音量口径 = 主音量 × 通道音量（DEFAULT_SETTINGS：master=1、bgm=.8、ambient=.6、sfx=.9）：
// 三条通道因此分别是 0.8 / 0.6 / 0.9——只乘主音量、或写死 1 的实现都会在这里红。
//
// 自动播放策略：显式起一个带 --autoplay-policy=no-user-gesture-required 的 chromium（Playwright 默认
// **不带**这个开关，只带 --mute-audio；后者只静音输出，不影响 element.volume/paused 的读数）。
// 不显式放行的话，无用户手势的 play() 被拦、paused 恒为 true，整条用例都是假红。
// 音频文件是自造的合法 WAV（44 字节 RIFF/WAVE PCM 头 + N 秒静音采样），刻意做长（30s）：
// 元素一播完 paused 会翻回 true，而整个断言窗口里它必须一直「在播」。
//
// 两条用例各自独立走一遍屏幕流（同一 page 上重新 goto = 新的 JS 上下文，AudioManager 与登记簿都重来一份）：
//   ① 三行协议 → 三条直服请求各恰好一次 + 元素 src / 在播 / 音量；
//   ② 换曲交叉淡入（新元素淡入、旧元素淡出到 0 后 pause）+ 设置屏静音把在播音量归 0。
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { startUiStack, stopUiStack, type StartedStack } from "./stack";
import { enterProtagonist, quickStartToGame } from "./flow";

const PRESET_ID = "demo";
const PRESET_TITLE = "示例剧本";

/** 协议行里的「名」（`【曲】<名>`）——与文件名 `presets/<id>/audio/<类型>-<名>.<ext>` 里的 <名> 同字面 */
const BGM_NAME = "夜灯谣";
const BGM_NEXT_NAME = "新曲";
const AMBIENT_NAME = "雨夜";
const SFX_NAME = "门响";

/** 文件名契约（类型 ∈ 曲/环境/音效，ext ∈ mp3/ogg/m4a/wav/flac）：索引里查不到就是静默 no-op */
const audioFile = (kind: "曲" | "环境" | "音效", name: string): string => `${kind}-${name}.wav`;
/** 音频目录的相对路径（= /audio 的 p 参数去掉文件名那一段） */
const AUDIO_DIR = `presets/${PRESET_ID}/audio`;
/** 落盘相对路径 = /audio 的 p 参数值，也是 <audio>.src 解码后能读到的子串 */
const audioPath = (file: string): string => `${AUDIO_DIR}/${file}`;

const BGM_FILE = audioFile("曲", BGM_NAME);
const BGM_NEXT_FILE = audioFile("曲", BGM_NEXT_NAME);
const AMBIENT_FILE = audioFile("环境", AMBIENT_NAME);
const SFX_FILE = audioFile("音效", SFX_NAME);

/** 用例②的换曲触发词（同时也是第一项选项的文本）：prompt 里带它 → 引擎回【曲】新曲 */
const B2_OPTION = "留住这段旋律";

/**
 * 自造的最小合法 WAV：44 字节 RIFF/WAVE PCM 头 + N 秒静音采样（8kHz 单声道 16-bit，采样值全 0）。
 * 为什么不用几字节的占位内容：元素必须**真的在播**（paused === false）且断言窗口内不播完——
 * 解码失败的杂牌内容会让 play() reject、paused 翻回 true，短音频播完也会翻回去。
 * @param {number} seconds 静音时长（默认 30s，远长于本条 spec 的断言窗口）
 * @returns {Buffer} 可直接落盘的 WAV 字节
 */
function silentWav(seconds = 30): Buffer {
  const sampleRate = 8000;
  const channels = 1;
  const bits = 16;
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataSize = byteRate * seconds;
  const buf = Buffer.alloc(44 + dataSize); // 全 0 = 静音，不必再填采样
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4); // RIFF 块长度 = 4 + (8 + 16) + (8 + dataSize)
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt 块长度（PCM = 16）
  buf.writeUInt16LE(1, 20); // format = 1（PCM）
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32); // block align
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/** 四个文件共用同一份静音 WAV（内容无所谓，只要合法且够长） */
const SILENT_WAV = silentWav();

/** seed 音频：没有它 AudioManager 的索引查不到任何文件，三条协议行全部静默 no-op（这正是最容易漏测的一环） */
const AUDIO_SEED = [
  { name: BGM_FILE, bytes: SILENT_WAV },
  { name: BGM_NEXT_FILE, bytes: SILENT_WAV },
  { name: AMBIENT_FILE, bytes: SILENT_WAV },
  { name: SFX_FILE, bytes: SILENT_WAV },
];

/**
 * fake-engine 脚本队列。两条 `match: "开局："` 按声明顺序各消费一次（第一条给用例①、第二条给用例②），
 * 第三条只认用例②的第二回合——**全程只有用例②点一次选项**，避免「没匹配上的 prompt 顺次消费下一条」
 * 把两条用例的脚本搅在一起（fake-engine 的 match 命中不重复用，见 fake-engine.mjs 顶部说明）。
 */
const TURNS = [
  {
    // 用例①：三行音频协议 + 正文 + 行动（选项不点，本用例只要第一回合）
    match: "开局：",
    ops: [
      "夜雨敲着屋檐，走廊尽头的灯忽明忽暗。\n",
      `【曲】${BGM_NAME}\n`,
      `【环境】${AMBIENT_NAME}\n`,
      `【音效】${SFX_NAME}\n`,
      "门轴响了一声，有人从雨里走了进来。\n\n**行动**\n1. 走向那盏灯\n2. 先回房\n",
    ],
  },
  {
    // 用例②第一回合：先起一首曲（交叉淡入要有「旧曲」才谈得上交叉）
    match: "开局：",
    ops: [
      "薇拉把留声机的针搭上唱片，屋里响起一段旧旋律。\n",
      `【曲】${BGM_NAME}\n`,
      `**行动**\n1. ${B2_OPTION}\n2. 把窗关上\n`,
    ],
  },
  {
    // 用例②第二回合：换曲（点第一项选项的 prompt 文本命中这一条）
    match: B2_OPTION,
    ops: ["唱片转到末尾，另一段旋律从雨声里接了上来。\n", `【曲】${BGM_NEXT_NAME}\n`],
  },
];

/**
 * 元素登记簿（addInitScript 注入，见文件头）：包一层 Audio 构造器，把 AudioManager 造出来的元素收进
 * window.__bunkitenAudio。只登记不改行为——Reflect.construct 出来的仍是原生 HTMLAudioElement，
 * typeof Audio 仍为 "function"（audio.ts 的 `typeof Audio !== "function"` 兜底不受影响）。
 */
function installAudioRegistry(): void {
  const w = window as unknown as { Audio: typeof Audio; __bunkitenAudio?: HTMLAudioElement[] };
  const collected: HTMLAudioElement[] = [];
  w.__bunkitenAudio = collected;
  const Orig = w.Audio;
  w.Audio = new Proxy(Orig, {
    construct(target, args) {
      const el = Reflect.construct(target, args) as HTMLAudioElement;
      collected.push(el);
      return el;
    },
  });
}

/** 登记簿里一个元素的可断言摘要 */
interface AudioSnapshot {
  src: string;
  paused: boolean;
  volume: number;
  ended: boolean;
}

/** 登记簿快照（src 走 decodeURIComponent：p 参数里的中文文件名能直接肉眼比对） */
async function audioElements(p: Page): Promise<AudioSnapshot[]> {
  return p.evaluate(() => {
    const w = window as unknown as { __bunkitenAudio?: HTMLAudioElement[] };
    return (w.__bunkitenAudio ?? []).map((a) => ({
      src: decodeURIComponent(a.src || ""),
      paused: a.paused,
      volume: a.volume,
      ended: a.ended,
    }));
  });
}

/**
 * 某个文件对应元素的摘要（找不到时 null —— 失败信息直接说「登记簿里没有这个元素」，不是含糊的 false）。
 * volume 收敛到 2 位小数：淡入终值是浮点乘法（1 × 0.8），逐帧写在元素上会带 float32 尾巴。
 */
async function elementState(
  p: Page,
  file: string,
): Promise<{ file: string; paused: boolean; volume: number; ended: boolean } | null> {
  const hit = (await audioElements(p)).find((a) => a.src.includes(audioPath(file)));
  return hit ? { file, paused: hit.paused, volume: Number(hit.volume.toFixed(2)), ended: hit.ended } : null;
}

/** 带 p 参数的 /audio 直服请求（索引 /api/audio 是另一个 pathname，刻意不计入——它是「清单」不是「播放」） */
const playedPaths = (requests: readonly string[], file: string): string[] =>
  requests.filter((p) => p === audioPath(file));

/** 从（已 decodeURIComponent 的）src 里取出 p 参数值；空 src 返回空串 */
const pOf = (src: string): string => {
  const at = src.indexOf("/audio?p=");
  return at === -1 ? "" : src.slice(at + "/audio?p=".length);
};

let browser: Browser;
let stack: StartedStack;
let page: Page;
/** 本页面生命周期内发出的全部 /audio 直服请求的 p 参数（searchParams 已解码，如 presets/demo/audio/曲-夜灯谣.wav） */
let audioRequests: string[] = [];

test.beforeAll(async () => {
  // 自动播放策略：显式放行无手势的 play()（Playwright 默认开关表里没有这一项，见文件头）
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  ({ stack, page } = await startUiStack(browser, {
    presets: [{ id: PRESET_ID, title: PRESET_TITLE }],
    audioFiles: { [PRESET_ID]: AUDIO_SEED },
    turns: TURNS,
  }));
  // 登记簿必须在任何导航之前装上：AudioManager 单例是模块求值时构造的（构造函数里就 new 了 4 个元素）
  await page.addInitScript(installAudioRegistry);
  audioRequests = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname !== "/audio") return;
    const p = u.searchParams.get("p");
    if (p) audioRequests.push(p);
  });
});

test.afterAll(async () => {
  await stopUiStack(page, stack);
  await browser?.close();
});

test("① 三行音频协议各触发一次 /audio 直服请求；元素 src 指向对应文件、正在播放、音量 = 主音量 × 通道音量", async () => {
  await page.goto(stack.pageUrl);

  // 索引就绪后再开局：【音效】在索引未就绪时**不挂起**（一次性音效错过就错过），
  // 不等这一拍的话开局那声门响会被丢掉——那是确定性差异，不是被测行为，所以先等 /api/audio 落地。
  const indexReady = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/audio" && r.ok());
  await enterProtagonist(page, PRESET_TITLE);
  await indexReady;
  await quickStartToGame(page);

  // 正文上屏 = 这一回合的三行协议行都已过 server 的 handleArtLine（协议行本身对玩家不可见，不进正文）
  await expect(page.getByTestId("dialogue-text")).toContainText("夜雨敲着屋檐");

  // ——— 请求面：三个文件各**恰好一次**（0 = 没发出去，2 = 重复取同一 URL，两种都红）———
  await expect
    .poll(() => [BGM_FILE, AMBIENT_FILE, SFX_FILE].map((f) => playedPaths(audioRequests, f).length), {
      message: "【曲】/【环境】/【音效】三行应各触发一次 /audio 直服请求（各有且仅有一次）",
    })
    .toEqual([1, 1, 1]);
  // 三条请求的 p 参数就是三条落盘路径（多出第四条、或路径写错也在这里红）
  expect([...audioRequests].sort()).toEqual([audioPath(BGM_FILE), audioPath(AMBIENT_FILE), audioPath(SFX_FILE)].sort());

  // ——— 元素面：src 指向对应文件 + 在播（paused=false）+ 音量 = 主音量 × 通道音量 ———
  // ended=false 一起断言：它把「文件太短、早就播完」这类假红与真回归区分开（播完 paused 也会是 true）
  await expect
    .poll(() => elementState(page, BGM_FILE), {
      message: `【曲】${BGM_NAME} 的元素应指向 ${audioPath(BGM_FILE)}、在播、音量 1×0.8`,
    })
    .toEqual({ file: BGM_FILE, paused: false, volume: 0.8, ended: false });
  await expect
    .poll(() => elementState(page, AMBIENT_FILE), {
      message: `【环境】${AMBIENT_NAME} 的元素应指向 ${audioPath(AMBIENT_FILE)}、在播、音量 1×0.6`,
    })
    .toEqual({ file: AMBIENT_FILE, paused: false, volume: 0.6, ended: false });
  await expect
    .poll(() => elementState(page, SFX_FILE), { message: `【音效】${SFX_NAME} 的一次性元素应在播、音量 1×0.9` })
    .toEqual({ file: SFX_FILE, paused: false, volume: 0.9, ended: false });

  // 元素预算：这回合恰好三个元素带 src（曲/环境各用掉通道里的一侧，音效再造一个一次性的）。
  // 另两个是两条通道的「空槽」（src 为空、从没播放过）——通道是双元素交叉淡入，不是复用同一个。
  const withSrc = (await audioElements(page)).map((a) => pOf(a.src)).filter((p) => p !== "");
  expect(withSrc.sort()).toEqual([audioPath(BGM_FILE), audioPath(AMBIENT_FILE), audioPath(SFX_FILE)].sort());
});

test("② 换曲：新元素淡入在播、旧元素淡出到 0 后被 pause；设置屏静音把在播音量归 0", async () => {
  // 新的一局：同一 page 重新 goto = 新的 JS 上下文（AudioManager 与登记簿都重新开始记）。
  // 这里**不需要**等 /api/audio：本用例只有【曲】——索引未就绪时它会被挂起、就绪后补播，
  // 两种时序都由下面的 poll 收口（会被丢弃的只有【音效】，用例①已经专门为它先等了一拍）。
  await page.goto(stack.pageUrl);
  await enterProtagonist(page, PRESET_TITLE);
  await quickStartToGame(page);

  // 基线：第一首【曲】在播（没有这条，「交叉」就无从谈起）
  await expect
    .poll(() => elementState(page, BGM_FILE), { message: `基线：第一首【曲】${BGM_NAME} 应在播（音量 1×0.8）` })
    .toEqual({ file: BGM_FILE, paused: false, volume: 0.8, ended: false });

  // 第二回合：点第一项选项 → 引擎发【曲】新曲
  await page.getByTestId("options").locator("button").first().click();
  await expect(page.getByTestId("dialogue-text")).toContainText("另一段旋律从雨声里接了上来");

  // 换曲的下半场：新元素淡入到目标音量并在播——src 换成了新文件（同一个通道换手，不是重启旧元素）
  await expect
    .poll(() => elementState(page, BGM_NEXT_FILE), {
      message: `换曲后应出现指向 ${audioPath(BGM_NEXT_FILE)} 且在播的新元素（音量 1×0.8）`,
    })
    .toEqual({ file: BGM_NEXT_FILE, paused: false, volume: 0.8, ended: false });

  // 旧元素：淡出（FADE_MS≈600ms）走完后被 pause 且音量归 0。
  // ended=false 是硬条件：证明这条 pause 来自淡出回调，而不是「旧曲自己播完了」。
  await expect
    .poll(() => elementState(page, BGM_FILE), {
      message: `旧元素 ${BGM_FILE} 应在淡出结束时音量归 0 并被 pause（ended 仍为 false）`,
    })
    .toEqual({ file: BGM_FILE, paused: true, volume: 0, ended: false });

  // 结构：曲通道的两个元素此刻各带一个 src（旧+新并存 = 真的是两个元素交叉，不是一个元素换 src）
  const bgmPaths = (await audioElements(page)).map((a) => pOf(a.src)).filter((p) => p.startsWith(`${AUDIO_DIR}/曲-`));
  expect(bgmPaths.sort()).toEqual([audioPath(BGM_FILE), audioPath(BGM_NEXT_FILE)].sort());

  // ——— 设置屏静音：命令轨「设置」→ 静音开关（updateSettings 立即 applySettings，无需保存按钮）———
  await page.getByTestId("settings").click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByTestId("settings-muted").click();
  await expect(page.getByTestId("settings-muted")).toHaveAttribute("aria-checked", "true");
  // 静音是独立轴：它不把主音量改成 0（滑杆读数照旧），只在换算时把增益乘成 0
  await expect(page.getByTestId("settings-master-value")).toHaveText("100");

  await expect
    .poll(() => elementState(page, BGM_NEXT_FILE), { message: "静音后在播元素的音量应归 0，但仍然在播（paused 不变）" })
    .toEqual({ file: BGM_NEXT_FILE, paused: false, volume: 0, ended: false });
});
