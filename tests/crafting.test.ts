// 制作中屏（crafting）章节制作流水线测试（v1.2）：不依赖真实引擎回合。
// 走 store 公共 API（selectPreset/startGame/skipPreload/handleEvent——SSE 事件的进程内入口），
// 只在系统边界打桩：global.fetch 扮演 acp-server（/prompt 记录指令序列，/api/assets 给资产清单）。
// 期望值全部来自引擎 SKILL 契约字面量与手抄的制作清单 fixture，
// 与实现共享的真源只有行为规格本身（改实现不许改这里，除非契约变更）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fallbackPortraitUrl,
  nextPortraitOnExpression,
  useGameStore,
} from "../src/store/game";
import { assetPath, type AssetEntry, type Preset, type PresetsResponse } from "../src/lib/acp";

// presets/campus-summer/preset.md 手抄 fixture（「# 主要角色」的三个 ## 标题即 characters）
const PRESET: Preset = {
  id: "campus-summer",
  title: "盛夏偏差值",
  tagline: "补习学校的重考之年，把她拖向不同方向的两个人",
  genre: "现代校园 / 恋爱",
  rating: "",
  characters: ["沈屿", "程野", "教导主任·老蒋"],
  protagonist_card: [],
};

// 引擎 SKILL 契约字面量（与 tests/parser.test.ts 的字符串快照同源，独立于实现）
// v1.5：开局指令携带世界段——这些用例里 worldId 未落定（selectPreset 后直接 startGame），走缺省 main
const OPENING_STANDBY =
  "开局：《盛夏偏差值》。快速开局：用剧本 quick_start 预设主角。世界：main。待命：只初始化，不开始剧情，等待分项美术指令与「开演。」";
const PLAN_CH1 = "规划：第 1 章。";
const PLAN_CH2 = "规划：第 2 章。";
const ART_SHENYU = "美术：立绘 沈屿";
const ART_CHENGYE = "美术：立绘 程野";
const ART_LAOJIANG = "美术：立绘 教导主任·老蒋";
const ART_LINWANZHAO = "美术：立绘 林晚照";
const ART_BG_JIAOXUELOU = "美术：背景 旧教学楼";
const ART_BG_TIANTAI = "美术：背景 天台";
const ART_BG_HUIQUEZHEN = "美术：背景 灰雀镇";
const START = "开演。";

// 第 1 章 / 第 2 章规划回合的制作清单 fixture（引擎契约：【清单】行单独成段，此外无输出）
const MANIFEST_CH1 =
  "【清单】立绘|沈屿\n【清单】立绘|程野\n【清单】立绘|教导主任·老蒋\n【清单】背景|旧教学楼\n【清单】背景|天台";
const MANIFEST_CH2 = "【清单】立绘|沈屿\n【清单】立绘|林晚照\n【清单】背景|灰雀镇";

const OPENING =
  "蝉鸣把旧教学楼叫成一锅白粥。她抱着书包站在教室后门。\n**行动**\n1. 溜进座位\n2. 转身去天台";
// v1.3 起「**行动**」选项段不进历史（选项由按钮呈现），历史只留正文
const OPENING_PROSE = "蝉鸣把旧教学楼叫成一锅白粥。她抱着书包站在教室后门。";

/** POST /prompt 收到的指令序列（按发送顺序） */
let prompts: string[] = [];
/** GET /api/assets?preset= 返回的持久化资产清单（v1.5.1：只含当前剧本的资产） */
let assets: AssetEntry[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/** 模拟引擎跑完一个回合（可选带一段 chunk 正文） */
function engineTurn(chunk?: string) {
  const s = useGameStore.getState();
  s.handleEvent({ type: "turn_start" });
  if (chunk) s.handleEvent({ type: "chunk", seg: 0, text: chunk });
  s.handleEvent({ type: "turn_end" });
}

/** 走完「待命 → 规划 → 全部美术 → 开演 → 开场正文」直达 game 屏 */
async function reachGame() {
  useGameStore.getState().startGame(true, true);
  engineTurn(); // 待命确认
  await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
  engineTurn(MANIFEST_CH1); // 规划回合回清单
  for (const cmd of [ART_SHENYU, ART_CHENGYE, ART_LAOJIANG, ART_BG_JIAOXUELOU, ART_BG_TIANTAI]) {
    await vi.waitUntil(() => prompts.at(-1) === cmd);
    engineTurn(); // 分项美术确认
  }
  await vi.waitUntil(() => prompts.at(-1) === START);
  engineTurn(OPENING); // 开场正文
}

describe("章节制作流水线（store 公共 API 驱动）", () => {
  beforeEach(() => {
    prompts = [];
    assets = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/assets") {
          // v1.5.1：清单按剧本分组，preset 必须带上（服务端缺省即 400）
          return url.searchParams.get("preset") === "campus-summer"
            ? jsonResponse(assets)
            : jsonResponse({ error: "preset required" }, 400);
        }
        return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
      }),
    );
    useGameStore.getState().selectPreset(PRESET);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useGameStore.getState().toTitle(); // 清看门狗定时器，避免测试进程悬挂
  });

  it("快速开局 + 制作美术：发待命版开局指令进入 crafting；待命回合结束发「规划：第 1 章。」，进入 planning", async () => {
    useGameStore.getState().startGame(true, true);

    const s0 = useGameStore.getState();
    expect(s0.screen).toBe("crafting");
    expect(s0.preloadPhase).toBe("init");
    expect(prompts).toEqual([OPENING_STANDBY]);
    expect(s0.preload).toEqual([]); // 队列由规划回合的制作清单构建，开局不预填

    engineTurn(); // 引擎确认待命 → 发第 1 章规划指令
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);

    const s = useGameStore.getState();
    expect(prompts).toEqual([OPENING_STANDBY, PLAN_CH1]);
    expect(s.preloadPhase).toBe("planning");
    expect(s.chapterNo).toBe(1);
    expect(s.status).toBe("撰写章节大纲…");

    // 规划回合里引擎写剧情树的段切换（工具调用）不覆盖 planning 文案
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "seg", seg: 1, label: "写入剧情树" });
    expect(useGameStore.getState().status).toBe("撰写章节大纲…");
  });

  it("规划回合：清单解析→过滤→队列正确；已就绪立绘与背景都跳过（v1.5 背景不再照发），未就绪不跳", async () => {
    // 程野基础已就绪可跳过；沈屿在清单里但 ready=false 必须照发；旧教学楼背景已就绪 → 同样跳过
    assets = [
      {
        type: "立绘",
        name: "程野",
        variant: "",
        preset: "campus-summer",
        file: "presets/campus-summer/assets/立绘-程野.jpg",
        ready: true,
        inUse: false,
        mtime: 1,
      },
      {
        type: "立绘",
        name: "沈屿",
        variant: "",
        preset: "campus-summer",
        file: "presets/campus-summer/assets/立绘-沈屿.jpg",
        ready: false,
        inUse: false,
        mtime: 0,
      },
      {
        type: "背景",
        name: "旧教学楼",
        variant: "",
        preset: "campus-summer",
        file: "presets/campus-summer/assets/背景-旧教学楼.jpg",
        ready: true,
        inUse: false,
        mtime: 2,
      },
    ];
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认 → 规划指令
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1); // 规划回合回清单 → 清点资产 → 开跑第一项

    await vi.waitUntil(() => prompts.at(-1) === ART_SHENYU);
    expect(useGameStore.getState().preloadPhase).toBe("queue");
    // 队列按清单顺序就位：全部立绘 + 全部背景
    expect(useGameStore.getState().preload.map((i) => `${i.kind}:${i.name}`)).toEqual([
      "portrait:沈屿",
      "portrait:程野",
      "portrait:教导主任·老蒋",
      "background:旧教学楼",
      "background:天台",
    ]);
    // 程野与旧教学楼被清点跳过：状态 done，展示 URL 指向本剧本的落盘文件（p 参数可独立解出）
    const chengye = useGameStore.getState().preload.find((i) => i.name === "程野")!;
    expect(chengye.state).toBe("done");
    expect(new URL(chengye.url!, "http://localhost").searchParams.get("p")).toBe(
      "presets/campus-summer/assets/立绘-程野.jpg",
    );
    const jiaoxuelou = useGameStore.getState().preload.find((i) => i.name === "旧教学楼")!;
    expect(jiaoxuelou.state).toBe("done");
    expect(new URL(jiaoxuelou.url!, "http://localhost").searchParams.get("p")).toBe(
      "presets/campus-summer/assets/背景-旧教学楼.jpg",
    );
    expect(useGameStore.getState().preload.find((i) => i.name === "天台")?.state).toBe("pending");

    engineTurn(); // 沈屿完成 → 下一位（程野已跳过）
    await vi.waitUntil(() => prompts.at(-1) === ART_LAOJIANG);
    engineTurn(); // 老蒋完成 → 天台（旧教学楼已跳过）
    await vi.waitUntil(() => prompts.at(-1) === ART_BG_TIANTAI);
    expect(prompts.slice(2)).toEqual([ART_SHENYU, ART_LAOJIANG, ART_BG_TIANTAI]);
  });

  it("差分项不被基础立绘吸收：基础已就绪、差分缺失 → 差分照发指令（v1.5 缓存兜底修正）", async () => {
    assets = [
      {
        type: "立绘",
        name: "沈屿",
        variant: "",
        preset: "campus-summer",
        file: "presets/campus-summer/assets/立绘-沈屿.jpg",
        ready: true,
        inUse: false,
        mtime: 1,
      },
    ];
    useGameStore.getState().selectPreset(PRESET);
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认 → 规划指令
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn("【清单】立绘|沈屿\n【清单】立绘|沈屿-微笑\n【清单】背景|天台");

    // 等预过滤完成（清点后才会派发第一个待生成项；基础沈屿被跳过，差分项先跑）
    await vi.waitUntil(() => prompts.at(-1) === "美术：立绘 沈屿-微笑");
    const items = useGameStore.getState().preload;
    expect(items.find((i) => i.name === "沈屿")?.state).toBe("done"); // 基础命中缓存
    // 命中项的直服路径落在本剧本目录（同剧本缓存复用，不跨剧本串味）
    expect(new URL(items.find((i) => i.name === "沈屿")!.url!, "http://localhost").searchParams.get("p")).toBe(
      "presets/campus-summer/assets/立绘-沈屿.jpg",
    );
    expect(items.find((i) => i.name === "沈屿-微笑")?.state).toBe("running"); // 差分不被基础吸收，照发
    expect(items.find((i) => i.name === "天台")?.state).toBe("pending");
  });

  it("队列清空后发「开演。」，开场回合回完切 game：制作中噪声不进历史，开场正文进历史", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认 → 规划指令
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1); // 规划回合回清单（清单行不进历史）
    for (const cmd of [ART_SHENYU, ART_CHENGYE, ART_LAOJIANG, ART_BG_JIAOXUELOU, ART_BG_TIANTAI]) {
      await vi.waitUntil(() => prompts.at(-1) === cmd);
      engineTurn("薇拉 · 完成"); // 分项美术确认
    }

    await vi.waitUntil(() => prompts.at(-1) === START);
    expect(useGameStore.getState().preloadPhase).toBe("starting");
    expect(useGameStore.getState().history).toEqual([]); // 待命/清单/确认都不是剧情

    engineTurn(OPENING);

    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.preloadPhase).toBe("finished");
    expect(s.history).toEqual([{ n: "第 1 幕", t: OPENING_PROSE }]); // **行动** 段不进历史
  });

  it("单项美术失败：标 failed 不阻塞，队列继续下一项直至「开演。」", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命 → 规划
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1);
    await vi.waitUntil(() => prompts.at(-1) === ART_SHENYU); // → 沈屿生成中

    useGameStore.getState().handleEvent({ type: "error", message: "image_gen failed" });

    const failed = useGameStore.getState().preload.find((i) => i.name === "沈屿")!;
    expect(failed.state).toBe("failed");
    await vi.waitUntil(() => prompts.at(-1) === ART_CHENGYE); // 失败后立即接下一项
    expect(prompts).toEqual([OPENING_STANDBY, PLAN_CH1, ART_SHENYU, ART_CHENGYE]);

    engineTurn(); // 程野
    await vi.waitUntil(() => prompts.at(-1) === ART_LAOJIANG);
    engineTurn(); // 老蒋
    await vi.waitUntil(() => prompts.at(-1) === ART_BG_JIAOXUELOU);
    engineTurn(); // 旧教学楼
    await vi.waitUntil(() => prompts.at(-1) === ART_BG_TIANTAI);
    engineTurn(); // 天台
    await vi.waitUntil(() => prompts.at(-1) === START); // 失败项不拦住收尾

    const s = useGameStore.getState();
    expect(s.preload.find((i) => i.name === "沈屿")?.state).toBe("failed");
    expect(s.preload.filter((i) => i.state === "done")).toHaveLength(4);
  });

  it("跳过剩余（引擎空闲时，queue 阶段）：pending/running 全部标 skipped，立即发「开演。」", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn();
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1);
    await vi.waitUntil(() => prompts.at(-1) === ART_SHENYU); // → 沈屿生成中（turn_end 后引擎空闲）

    useGameStore.getState().skipPreload();

    const s = useGameStore.getState();
    expect(s.preload.every((i) => i.state === "skipped")).toBe(true);
    expect(s.preloadPhase).toBe("starting");
    expect(prompts.at(-1)).toBe(START);
  });

  it("待命阶段跳过（引擎忙时）：不发新指令，待命回合结束后直接「开演。」（不再规划/逐项）", async () => {
    useGameStore.getState().startGame(true, true); // 待命指令在途，engineBusy
    useGameStore.getState().skipPreload();

    expect(prompts).toEqual([OPENING_STANDBY]); // 引擎忙：不抢发

    engineTurn(); // 待命回合结束 → 不发规划，直接收尾
    await vi.waitUntil(() => prompts.at(-1) === START);
    expect(prompts).toEqual([OPENING_STANDBY, START]);
  });

  it("planning 阶段跳过（引擎忙时）：规划回合结束后直接「开演。」，清单不建队列", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认 → 规划指令
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);

    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" }); // 规划回合进行中，engineBusy
    useGameStore.getState().skipPreload();

    expect(prompts).toEqual([OPENING_STANDBY, PLAN_CH1]); // 引擎忙：只记账不抢发

    engineTurn(MANIFEST_CH1); // 规划回合结束 → 跳过请求生效，清单被无视
    await vi.waitUntil(() => prompts.at(-1) === START);
    expect(prompts).toEqual([OPENING_STANDBY, PLAN_CH1, START]);
    expect(useGameStore.getState().preloadPhase).toBe("starting");
    expect(useGameStore.getState().preload).toEqual([]);
  });

  it("规划回合清单为空（引擎异常）：视作失败项直接「开演。」，不卡死", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认 → 规划指令
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);

    engineTurn("（引擎没按协议输出清单行）");

    await vi.waitUntil(() => prompts.at(-1) === START);
    expect(prompts).toEqual([OPENING_STANDBY, PLAN_CH1, START]);
    expect(useGameStore.getState().preloadPhase).toBe("starting");
  });

  it("【章】标记触发章间制作：标记行不进历史，切 crafting 发「规划：第 2 章。」，清单（可跨段）建新队列", async () => {
    await reachGame();
    expect(useGameStore.getState().screen).toBe("game");

    // 终章回合：正文与章标记收尾（引擎工具调用在前、正文在后的既有段序）
    engineTurn("晚风把答案吹散在天台上。\n【章】第 1 章 完");

    const c = useGameStore.getState();
    expect(c.screen).toBe("crafting"); // 章标记 → 制作中屏
    expect(c.chapterNo).toBe(2);
    expect(c.preloadPhase).toBe("planning");
    expect(prompts.at(-1)).toBe(PLAN_CH2);
    expect(c.history.at(-1)).toEqual({ n: "第 2 幕", t: "晚风把答案吹散在天台上。" }); // 【章】行不进历史

    // 第 2 章规划回合：清单行落在工具调用之后的 seg 1
    const p = useGameStore.getState();
    p.handleEvent({ type: "turn_start" });
    p.handleEvent({ type: "seg", seg: 1, label: "写入剧情树" });
    p.handleEvent({ type: "chunk", seg: 1, text: MANIFEST_CH2 });
    p.handleEvent({ type: "turn_end" });

    await vi.waitUntil(() => prompts.at(-1) === ART_SHENYU);
    expect(useGameStore.getState().chapterNo).toBe(2);
    expect(useGameStore.getState().preload.map((i) => `${i.kind}:${i.name}`)).toEqual([
      "portrait:沈屿",
      "portrait:林晚照",
      "background:灰雀镇",
    ]);
    engineTurn(); // 沈屿（缓存复用）
    await vi.waitUntil(() => prompts.at(-1) === ART_LINWANZHAO);
    engineTurn(); // 林晚照
    await vi.waitUntil(() => prompts.at(-1) === ART_BG_HUIQUEZHEN);
    engineTurn(); // 灰雀镇
    await vi.waitUntil(() => prompts.at(-1) === START); // 第 2 章开演
    engineTurn("灰雀镇的旅店亮着最后一盏灯。\n**行动**\n1. 推门进去");
    expect(useGameStore.getState().screen).toBe("game");
    expect(useGameStore.getState().history.at(-1)?.t).toBe("灰雀镇的旅店亮着最后一盏灯。");
  });

  it("【章】标记不在末段（正文后引擎又静默调了工具）：按该回合全文扫描，切屏与规划照常触发", async () => {
    await reachGame();
    const historyLen = useGameStore.getState().history.length;

    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "晚风把答案吹散在天台上。\n【章】第 1 章 完" });
    s.handleEvent({ type: "seg", seg: 1, label: "写状态" }); // 末段无正文
    s.handleEvent({ type: "turn_end" });

    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH2);
    const c = useGameStore.getState();
    expect(c.screen).toBe("crafting");
    expect(c.chapterNo).toBe(2);
    expect(c.history).toHaveLength(historyLen); // 末段为空不产生空历史条目
  });

  it("美术回合的【图】标记回填 artReady 槽位与当前画面（立绘按角色名、背景按地点名）", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn();
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1);
    await vi.waitUntil(() => prompts.at(-1) === ART_SHENYU);

    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|沈屿|images/7.jpg\n" });
    const st = useGameStore.getState();
    expect(st.portrait?.name).toBe("沈屿");
    const u = new URL(st.artReady["沈屿"] ?? "", "http://localhost");
    expect(u.pathname).toBe("/img");
    expect(u.searchParams.get("p")).toBe("images/7.jpg"); // 新生成的会话路径原样透传
    expect(u.searchParams.get("t")).toBe("立绘");
    expect(u.searchParams.get("n")).toBe("沈屿");
    expect(u.searchParams.get("preset")).toBe("campus-summer"); // 落盘目标/直服都按当前剧本

    engineTurn(); // 沈屿完成 → 程野 … 直至旧教学楼
    await vi.waitUntil(() => prompts.at(-1) === ART_CHENGYE);
    engineTurn();
    await vi.waitUntil(() => prompts.at(-1) === ART_LAOJIANG);
    engineTurn();
    await vi.waitUntil(() => prompts.at(-1) === ART_BG_JIAOXUELOU);

    const t = useGameStore.getState();
    t.handleEvent({ type: "turn_start" });
    t.handleEvent({ type: "chunk", seg: 0, text: "【图】背景|旧教学楼|images/9.jpg\n" });
    const st2 = useGameStore.getState();
    expect(st2.bgUrl).toContain("p=images%2F9.jpg");
    expect(new URL(st2.artReady["旧教学楼"] ?? "", "http://localhost").searchParams.get("n")).toBe("旧教学楼");
  });
});

describe("表情切换与创作/画廊编排（v1.3 store 公共 API 驱动）", () => {
  // 装配成功的虚构剧本（presetAdded 后 /api/presets 应带上它）
  const NEW_PRESET: Preset = {
    id: "midnight-library",
    title: "深夜图书馆",
    tagline: "",
    genre: "",
    rating: "",
    characters: [],
    protagonist_card: [],
  };
  let presetsResp: PresetsResponse = { presets: [PRESET], errors: [] };

  beforeEach(() => {
    prompts = [];
    assets = [];
    presetsResp = { presets: [PRESET], errors: [] };
    // 复位上一测试可能残留的回合中状态（engineBusy 等），再整体清场
    useGameStore.getState().handleEvent({ type: "turn_end" });
    useGameStore.getState().selectPreset(PRESET);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/assets") {
          // v1.5.1：清单按剧本分组，preset 必须带上（服务端缺省即 400）
          return url.searchParams.get("preset") === "campus-summer"
            ? jsonResponse(assets)
            : jsonResponse({ error: "preset required" }, 400);
        }
        if (url.pathname === "/api/presets") return jsonResponse(presetsResp);
        return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useGameStore.getState().finishCreation(); // 清创作态并回 title
    useGameStore.getState().toTitle(); // 清看门狗，避免测试进程悬挂
  });

  it("expression 事件：当前角色切差分 → url 指向变体文件；variant 空回基础；404 回退恒为基础图", () => {
    useGameStore.getState().selectPreset(PRESET);
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|薇拉|images/3.jpg\n" });
    let p = useGameStore.getState().portrait!;
    expect(p.name).toBe("薇拉");
    expect(p.variant).toBe("");
    expect(p.baseUrl).toBe(p.url);

    useGameStore.getState().handleEvent({ type: "expression", character: "薇拉", variant: "微笑" });
    p = useGameStore.getState().portrait!;
    expect(p.variant).toBe("微笑");
    const u = new URL(p.url, "http://localhost");
    expect(u.pathname).toBe("/img");
    expect(u.searchParams.get("p")).toBe("presets/campus-summer/assets/立绘-薇拉-微笑.jpg");
    expect(p.baseUrl).toBeTruthy(); // 基础立绘保留，供 404 回退

    // 回基础（variant 空）
    useGameStore.getState().handleEvent({ type: "expression", character: "薇拉", variant: "" });
    const back = useGameStore.getState().portrait!;
    expect(back.url).toBe(back.baseUrl);
    expect(fallbackPortraitUrl(back)).toBe(back.baseUrl); // 回退纯函数：目标恒为基础图
  });

  it("nextPortraitOnExpression 纯函数：无当前立绘按本剧本 id 起步；换角色新建槽位", () => {
    const a = nextPortraitOnExpression(null, "薇拉", "", "campus-summer");
    expect(a).toMatchObject({ name: "薇拉", variant: "" });
    expect(new URL(a.url, "http://localhost").searchParams.get("t")).toBe("立绘");
    expect(new URL(a.url, "http://localhost").searchParams.get("n")).toBe("薇拉");
    expect(new URL(a.url, "http://localhost").searchParams.get("preset")).toBe("campus-summer"); // 兜底图也带剧本

    const b = nextPortraitOnExpression(a, "薇拉", "礼服", "campus-summer");
    expect(new URL(b.url, "http://localhost").searchParams.get("p")).toBe(
      "presets/campus-summer/assets/立绘-薇拉-礼服.jpg",
    );
    expect(b.baseUrl).toBe(a.baseUrl); // 同角色保留基础

    const c = nextPortraitOnExpression(b, "沈屿", "", "campus-summer");
    expect(c.name).toBe("沈屿"); // 换角色新建

    // 无剧本上下文（preset 空）：不拼 presets//assets/… 坏路径，回基础图
    expect(nextPortraitOnExpression(c, "沈屿", "微笑", "").url).toBe(c.baseUrl);
  });

  it("manifest 差分项：槽位 label 拆「薇拉 · 微笑」、队列发差分指令、差分【图】标记只填槽位不换主立绘", async () => {
    useGameStore.getState().selectPreset(PRESET);
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认 → 规划指令
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn("【清单】立绘|薇拉\n【清单】立绘|薇拉-微笑\n【清单】背景|太极殿");
    await vi.waitUntil(() => useGameStore.getState().preloadPhase === "queue");

    const items = useGameStore.getState().preload;
    const variantItem = items.find((i) => i.name === "薇拉-微笑")!;
    expect(variantItem.label).toBe("薇拉 · 微笑");
    expect(variantItem.variant).toBe("微笑");
    expect(variantItem.command).toBe("美术：立绘 薇拉-微笑");
    expect(items.find((i) => i.name === "薇拉")!.label).toBe("薇拉"); // 基础项原样

    // 基础立绘上屏后，差分标记只回填槽位
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|薇拉|images/1.jpg\n" });
    expect(useGameStore.getState().portrait?.name).toBe("薇拉");
    const t = useGameStore.getState();
    t.handleEvent({ type: "turn_start" });
    t.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|薇拉-微笑|presets/campus-summer/assets/立绘-薇拉-微笑.jpg\n" });
    const st = useGameStore.getState();
    expect(st.portrait?.url).toContain("images%2F1.jpg"); // 主立绘未被差分替换
    expect(st.artReady["薇拉-微笑"]).toBeTruthy();
    // 缓存命中的标记路径原样透传（服务端据此直服 presets/<id>/assets/…）
    expect(new URL(st.artReady["薇拉-微笑"], "http://localhost").searchParams.get("p")).toBe(
      "presets/campus-summer/assets/立绘-薇拉-微笑.jpg",
    );
  });

  it("创作模式：进入即发指令，回合回复（含列表）进对话流且不进游戏历史；presetAdded 刷新 presets 并转成功态", async () => {
    useGameStore.getState().openCreation();
    expect(useGameStore.getState().screen).toBe("creation");
    expect(prompts.at(-1)).toBe("创作模式：进入剧本创作。");

    engineTurn("想写什么样的故事？\n- 题材：奇幻 / 悬疑\n- 角色：2-3 人");
    expect(useGameStore.getState().creationMessages).toEqual([
      { role: "engine", text: "想写什么样的故事？\n- 题材：奇幻 / 悬疑\n- 角色：2-3 人" }, // 列表放宽：允许
    ]);
    expect(useGameStore.getState().history).toEqual([]); // 创作回复不进游戏历史

    useGameStore.getState().sendCreation("写一个深夜图书馆的奇幻");
    expect(useGameStore.getState().creationMessages.at(-1)).toEqual({ role: "player", text: "写一个深夜图书馆的奇幻" });

    useGameStore.getState().sendCreation("装配。");
    expect(useGameStore.getState().assembling).toBe(true);

    // 装配回合：封面/立绘标记点亮清单
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({
      type: "chunk",
      seg: 0,
      text: "剧本骨架 · 写入中\n【图】封面|深夜图书馆|presets/midnight-library/cover.jpg\n【图】立绘|守夜人|images/9.jpg\n【新剧本】midnight-library\n",
    });
    expect(useGameStore.getState().creationCover).toBe(true);
    expect(useGameStore.getState().creationPortraits).toContain("守夜人");

    presetsResp = { presets: [PRESET, NEW_PRESET], errors: [] };
    useGameStore.getState().handleEvent({ type: "presetAdded", id: "midnight-library" });
    await vi.waitUntil(() => useGameStore.getState().presets.some((p) => p.id === "midnight-library"));
    expect(useGameStore.getState().creationResult).toBe("midnight-library");

    // 装配回合结束：协议行（含【新剧本】）过滤后进对话流
    useGameStore.getState().handleEvent({ type: "turn_end" });
    const last = useGameStore.getState().creationMessages.at(-1)!;
    expect(last.role).toBe("engine");
    expect(last.text).toBe("剧本骨架 · 写入中");
  });

  it("装配中的【图】标记：新剧本 id 揭示前不带 preset（不写进当前剧本目录），收到【新剧本】后带上", () => {
    useGameStore.getState().openCreation(); // 从正在玩的剧本（campus-summer）进创作屏
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|守夜人|images/9.jpg\n" });

    const before = new URL(useGameStore.getState().portrait!.url, "http://localhost");
    expect(before.searchParams.get("n")).toBe("守夜人");
    expect(before.searchParams.get("preset")).toBeNull(); // 新剧本 id 未知：宁可不落盘也不串味

    useGameStore.getState().handleEvent({ type: "presetAdded", id: "midnight-library" });
    const t = useGameStore.getState();
    t.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|守夜人|presets/midnight-library/assets/立绘-守夜人.jpg\n" });

    const after = new URL(useGameStore.getState().portrait!.url, "http://localhost");
    expect(after.searchParams.get("preset")).toBe("midnight-library");
    useGameStore.getState().handleEvent({ type: "turn_end" }); // 收尾，不留 engineBusy
  });

  it("装配回合结束仍无【新剧本】：置为可重试（assemblyStalled）", () => {
    useGameStore.getState().openCreation();
    engineTurn(); // 进入确认回合结束
    useGameStore.getState().sendCreation("装配。");
    expect(useGameStore.getState().assembling).toBe(true);

    engineTurn("剧本骨架 · 写入中"); // 回合结束但没收到 presetAdded

    const c = useGameStore.getState();
    expect(c.assembling).toBe(false);
    expect(c.assemblyStalled).toBe(true);
  });

  it("画廊重绘：startRegen 发指令挂起；同类型同名的 |重绘 标记解除并自增 assetsStamp（回合结束不重复自增）", () => {
    useGameStore.getState().openAssets();
    expect(useGameStore.getState().screen).toBe("assets");

    useGameStore.getState().startRegen("立绘", "薇拉-微笑", "薇拉-微笑");
    expect(prompts.at(-1)).toBe("美术：重绘 立绘 薇拉-微笑");
    expect(useGameStore.getState().regenPending).toBe("立绘|薇拉-微笑");
    const stamp0 = useGameStore.getState().assetsStamp;

    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({
      type: "chunk",
      seg: 0,
      text: "【图】立绘|薇拉-微笑|presets/campus-summer/assets/立绘-薇拉-微笑.jpg|重绘\n薇拉-微笑 · 重绘完成\n",
    });
    expect(useGameStore.getState().regenPending).toBeNull();
    expect(useGameStore.getState().assetsStamp).toBe(stamp0 + 1);

    useGameStore.getState().handleEvent({ type: "turn_end" });
    expect(useGameStore.getState().assetsStamp).toBe(stamp0 + 1); // 已解除则不重复自增
  });

  it("封面重绘：指令用 preset id、标记按剧本标题匹配解除", () => {
    useGameStore.getState().openAssets();
    useGameStore.getState().startRegen("封面", "twilight-throne", "末代天子");
    expect(prompts.at(-1)).toBe("美术：重绘 封面 twilight-throne");
    expect(useGameStore.getState().regenPending).toBe("封面|末代天子");

    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({
      type: "chunk",
      seg: 0,
      text: "【图】封面|末代天子|presets/twilight-throne/cover.jpg|重绘\n末代天子 · 重绘完成\n",
    });
    expect(useGameStore.getState().regenPending).toBeNull();
  });
});

describe("v1.4 UX：创作排队补发 / 章号递增 / 变体 sanitize", () => {
  beforeEach(() => {
    prompts = [];
    assets = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/assets") {
          // v1.5.1：清单按剧本分组，preset 必须带上（服务端缺省即 400）
          return url.searchParams.get("preset") === "campus-summer"
            ? jsonResponse(assets)
            : jsonResponse({ error: "preset required" }, 400);
        }
        return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
      }),
    );
    useGameStore.getState().selectPreset(PRESET);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useGameStore.getState().toTitle();
  });

  it("创作排队：引擎忙时消息挂起不抢发（气泡先出），回合结束自动补发", () => {
    useGameStore.setState({ engineBusy: false }); // 清上一测试残留的回合态（store 为单例）
    useGameStore.getState().openCreation(); // 空闲 → 发进入创作指令
    expect(prompts).toEqual(["创作模式：进入剧本创作。"]);

    // 进入创作的首回合进行中，玩家发消息：排队不抢发
    useGameStore.getState().handleEvent({ type: "turn_start" });
    useGameStore.getState().sendCreation("我想玩一个赛博朋克侦探故事");
    const s = useGameStore.getState();
    expect(prompts).toEqual(["创作模式：进入剧本创作。"]); // 未发出
    expect(s.pendingCreationMessage).toBe("我想玩一个赛博朋克侦探故事");
    expect(s.creationMessages.at(-1)).toEqual({ role: "player", text: "我想玩一个赛博朋克侦探故事" });

    // 首回合结束：排队消息自动补发
    useGameStore.getState().handleEvent({ type: "turn_end" });
    expect(useGameStore.getState().pendingCreationMessage).toBeNull();
    expect(prompts.at(-1)).toBe("我想玩一个赛博朋克侦探故事");
  });

  it("章号递增：终章【章】标记后 chapterNo+1 并自动规划下一章", async () => {
    await reachGame();
    expect(useGameStore.getState().chapterNo).toBe(1);

    engineTurn("章末收束。\n【章】第 1 章 完\n");
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH2);
    const s = useGameStore.getState();
    expect(s.chapterNo).toBe(2);
    expect(s.screen).toBe("crafting");
  });

  it("变体 URL sanitize：与 server 落盘规则一致（非法字符 → _，剥「」）", () => {
    const p = nextPortraitOnExpression(null, "「薇拉」", "微/笑", "campus-summer");
    expect(decodeURIComponent(p.url)).toBe("/img?p=presets/campus-summer/assets/立绘-薇拉-微_笑.jpg");
    // 回基础立绘不受变体名影响
    expect(nextPortraitOnExpression(p, "薇拉", "", "campus-summer").url).toBe(p.baseUrl);
  });

  it("assetPath：路径契约唯一来源（presets/<id>/assets/<类型>-<名>.jpg），preset 空回空串", () => {
    expect(assetPath("立绘", "薇拉-微笑", "campus-summer")).toBe("presets/campus-summer/assets/立绘-薇拉-微笑.jpg");
    expect(assetPath("背景", "灰雀镇廉价旅店", "twilight-throne")).toBe(
      "presets/twilight-throne/assets/背景-灰雀镇廉价旅店.jpg",
    );
    // 名字按 server persistAsset 同规则收敛（非法字符 → _）：调用方传原始名，不再各自 sanitize
    expect(assetPath("立绘", "薇拉-微/笑", "campus-summer")).toBe("presets/campus-summer/assets/立绘-薇拉-微_笑.jpg");
    // 「」不收编、直接映射成 _（与 server 逐字一致）；store 侧的剥括号归 normName，不在这里做
    expect(assetPath("立绘", "「薇拉」", "campus-summer")).toBe("presets/campus-summer/assets/立绘-_薇拉_.jpg");
    // 无剧本上下文：空串，调用方必须回退（不构造 presets//assets/… 或 /img?p= 这种坏 URL）
    expect(assetPath("立绘", "薇拉", "")).toBe("");
  });
});

describe("v1.5 世界线与剧情图（store 公共 API 驱动）", () => {
  /** POST /api/worlds 收到的动作序列 */
  let worldPosts: { action: string; worldId?: string; nodeId?: string; preset?: string }[] = [];

  beforeEach(() => {
    prompts = [];
    worldPosts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          worldPosts.push(body);
          if (body.action === "fork") return jsonResponse({ ok: true, worldId: "campus-summer-3" });
          if (body.action === "create") return jsonResponse({ ok: true, worldId: "campus-summer-2" });
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: [] });
        if (url.pathname === "/api/tree") return jsonResponse({ worldId: "x", markdown: "# 剧情树\n" });
        return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
      }),
    );
    useGameStore.getState().selectPreset(PRESET);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useGameStore.getState().toTitle();
  });

  it("新世界线：beginNewWorld 落 worldId 进捏人屏，开局指令携带世界段（后缀仍在末尾）", () => {
    useGameStore.getState().beginNewWorld("campus-summer-2");
    const s = useGameStore.getState();
    expect(s.screen).toBe("protagonist");
    expect(s.worldId).toBe("campus-summer-2");
    expect(s.worldLabel).toBe("campus-summer-2");

    useGameStore.getState().startGame(true, true);
    expect(prompts.at(-1)).toBe(
      "开局：《盛夏偏差值》。快速开局：用剧本 quick_start 预设主角。世界：campus-summer-2。待命：只初始化，不开始剧情，等待分项美术指令与「开演。」",
    );
  });

  it("续玩世界线：resumeWorld 直接进 game 发「继续世界：」指令；章号取索引记录、note 作为世界显示名", () => {
    useGameStore.getState().resumeWorld({
      worldId: "campus-summer-1",
      chapterNo: 3,
      note: "分叉自 campus-summer-1 @ 2-2",
    });
    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.worldId).toBe("campus-summer-1");
    expect(s.worldLabel).toBe("分叉自 campus-summer-1 @ 2-2");
    expect(s.chapterNo).toBe(3);
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-1。");
  });

  it("剧情图编辑：sendTreeEdit 发「剧情：」指令；编辑回合不进历史，摘要落 treeNotice 并刷新 treeStamp", async () => {
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 2, note: "" });
    useGameStore.getState().openTree();
    expect(useGameStore.getState().screen).toBe("tree");
    expect(useGameStore.getState().screenReturn).toBe("game");

    useGameStore.getState().sendTreeEdit("在节点 3-1 后加一个雨夜遇袭的节点");
    expect(prompts.at(-1)).toBe("剧情：在节点 3-1 后加一个雨夜遇袭的节点");
    expect(useGameStore.getState().treeAsk).toBe(true);
    const stamp0 = useGameStore.getState().treeStamp;

    engineTurn("已新增节点 3-4：雨夜遇袭。\n【树】");

    const s = useGameStore.getState();
    expect(s.treeAsk).toBe(false);
    expect(s.treeNotice).toBe("已新增节点 3-4：雨夜遇袭。");
    expect(s.treeStamp).toBeGreaterThan(stamp0);
    expect(s.history).toEqual([]); // 编辑回合不是剧情，不进历史
  });

  it("剧情图编辑：引擎忙时排队不抢发（提示已排队），回合结束自动补发", () => {
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 1, note: "" });
    useGameStore.getState().openTree();
    useGameStore.getState().handleEvent({ type: "turn_start" }); // 引擎忙

    useGameStore.getState().sendTreeEdit("删掉节点 2-3");
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]); // 编辑指令未抢发（只有续玩指令）
    expect(useGameStore.getState().pendingTreeMessage).toBe("剧情：删掉节点 2-3");
    expect(useGameStore.getState().treeNotice).toContain("已排队");

    useGameStore.getState().handleEvent({ type: "turn_end" });
    expect(useGameStore.getState().pendingTreeMessage).toBeNull();
    expect(prompts.at(-1)).toBe("剧情：删掉节点 2-3");
  });

  it("treeEdited 事件：刷新 treeStamp；带 note 时进提示条", () => {
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 1, note: "" });
    const stamp0 = useGameStore.getState().treeStamp;
    useGameStore.getState().handleEvent({ type: "treeEdited", note: "已删除节点 2-3" });
    expect(useGameStore.getState().treeStamp).toBe(stamp0 + 1);
    expect(useGameStore.getState().treeNotice).toBe("已删除节点 2-3");
  });

  it("分叉：forkAt 发 {action:fork,worldId,nodeId}，置 forkResult 与提示；switchToFork 续玩新世界", async () => {
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 2, note: "" });
    useGameStore.getState().openTree();
    useGameStore.getState().forkAt("2-2");

    await vi.waitUntil(() => useGameStore.getState().forkResult !== null);
    expect(worldPosts).toEqual([{ action: "fork", worldId: "campus-summer-1", nodeId: "2-2" }]);
    expect(useGameStore.getState().forkResult).toEqual({ worldId: "campus-summer-3", nodeId: "2-2" });
    expect(useGameStore.getState().treeNotice).toContain("campus-summer-3");

    useGameStore.getState().switchToFork();
    const s = useGameStore.getState();
    expect(s.screen).toBe("game"); // 关图屏并续玩新世界
    expect(s.worldId).toBe("campus-summer-3");
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-3。");
  });

  it("分叉：引擎忙时 switchToFork 拒绝切换（提示留在当前世界）", async () => {
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 2, note: "" });
    useGameStore.getState().openTree();
    useGameStore.getState().forkAt("2-2");
    await vi.waitUntil(() => useGameStore.getState().forkResult !== null);

    useGameStore.getState().handleEvent({ type: "turn_start" }); // 引擎忙
    useGameStore.getState().switchToFork();

    const s = useGameStore.getState();
    expect(s.worldId).toBe("campus-summer-1"); // 未切换
    expect(s.treeNotice).toContain("引擎忙");
  });
});
