// 制作中屏（crafting）章节制作流水线测试（v1.2）：不依赖真实引擎回合。
// 走 store 公共 API（selectPreset/startGame/skipPreload/handleEvent——SSE 事件的进程内入口），
// 只在系统边界打桩：global.fetch 扮演 acp-server（/prompt 记录指令序列，/api/assets 给资产清单）。
// 期望值全部来自引擎 SKILL 契约字面量与手抄的制作清单 fixture，
// 与实现共享的真源只有行为规格本身（改实现不许改这里，除非契约变更）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_STAGE,
  applyExpression,
  castMember,
  fallbackPortraitUrl,
  isTypingTarget,
  nextPortraitOnExpression,
  disposeStore,
  parseWorldBundle,
  speakerOf,
  useGameStore,
  type HistoryItem,
} from "../src/store/game";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { assetPath, type AssetEntry, type Preset, type PresetsResponse } from "../src/lib/acp";

/**
 * 历史里最近一条**正文幕**的文本：`history` 是判别联合（回退分割线没有 `t`），
 * 直接 `.at(-1)?.t` 在类型上不成立——先按 kind 收窄再取，比断言更贴近数据形状。
 * @param {HistoryItem[]} history 历史条目
 * @returns {string | undefined} 末条正文（末条是分割线或历史为空时 undefined）
 */
function lastActText(history: HistoryItem[]): string | undefined {
  const last = history.at(-1);
  return last?.kind === "act" ? last.t : undefined;
}

/**
 * 历史里最近一条**正文幕**的幕标题（「第 N 幕」）。
 * 与 {@link lastActText} 同一套收窄：分割线没有 `n`。
 * @param {HistoryItem[]} history 历史条目
 * @returns {string | undefined} 末条幕标题
 */
function lastActLabel(history: HistoryItem[]): string | undefined {
  const last = history.at(-1);
  return last?.kind === "act" ? last.n : undefined;
}

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

const OPENING = "蝉鸣把旧教学楼叫成一锅白粥。她抱着书包站在教室后门。\n**行动**\n1. 溜进座位\n2. 转身去天台";
// v1.3 起「**行动**」选项段不进历史（选项由按钮呈现），历史只留正文
const OPENING_PROSE = "蝉鸣把旧教学楼叫成一锅白粥。她抱着书包站在教室后门。";

/** POST /prompt 收到的指令序列（按发送顺序） */
let prompts: string[] = [];
/** GET /api/assets?preset= 返回的持久化资产清单（v1.5.1：只含当前剧本的资产） */
let assets: AssetEntry[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/** 当前发言者 = 立绘队列末位（v1.9 同屏多立绘的读法；队列为空时 undefined） */
function speaker() {
  return speakerOf(useGameStore.getState().portraits);
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

// 两段式（v1.13）的树 fixture：当前指针节点 1-2 的地点与在场——开场子集就按它挑。
// 与 MANIFEST_CH1 对照：开场集 = 沈屿 + 程野 + 旧教学楼（3 项），延迟队列 = 教导主任·老蒋 + 天台（2 项）。
const TREE_CH1 = [
  "# 剧情树",
  "## 第 1 章：盛夏偏差值",
  "- 当前进度: 节点 1-2（已走 0 轮）",
  "",
  "### 节点 1-1（校门口）",
  "- 地点: 校门口",
  "- 在场: 沈屿",
  "- 状态: 已走过",
  "",
  "### 节点 1-2（旧教学楼）",
  "- 地点: 旧教学楼",
  "- 在场: 沈屿、程野",
  "- 状态: 可达",
  "",
].join("\n");

/** 把 /api/tree 挂上（其余沿用本文件 beforeEach 的通用 stub） */
function stubTree(markdown: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/prompt") {
        prompts.push(JSON.parse(String(init?.body)).text);
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/assets") return jsonResponse(assets);
      if (url.pathname === "/api/tree") {
        return markdown === null ? jsonResponse({ error: "没树" }, 404) : jsonResponse({ worldId: "w1", markdown });
      }
      return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
    }),
  );
}

describe("两段式制作（v1.13）：开场子集 + 延迟补画泵", () => {
  beforeEach(() => {
    prompts = [];
    assets = [];
    stubTree(TREE_CH1);
    useGameStore.getState().selectPreset(PRESET);
    useGameStore.setState({ worldId: "w1" }); // 两段式要读本世界的树（没有 worldId 就退回全量）
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useGameStore.getState().toTitle();
    useGameStore.setState({ worldId: null });
  });

  it("树可判定：开场只画「当前节点的地点 + 在场角色的基础立绘」，其余进延迟队列", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1); // 规划回合回清单 → 建两段队列（读树是异步的，等队列落地）
    await vi.waitUntil(() => useGameStore.getState().preload.length > 0);

    const s1 = useGameStore.getState();
    expect(s1.preload.map((i) => i.name)).toEqual(["沈屿", "程野", "旧教学楼"]);
    expect(s1.deferredArt.map((i) => i.name)).toEqual(["教导主任·老蒋", "天台"]);
    expect(s1.artReady, "槽位仍覆盖整份清单（补画命中时要能点亮）").toHaveProperty("天台");

    // 开场子集跑完就「开演。」——不等延迟队列
    for (const cmd of [ART_SHENYU, ART_CHENGYE, ART_BG_JIAOXUELOU]) {
      await vi.waitUntil(() => prompts.at(-1) === cmd);
      engineTurn();
    }
    await vi.waitUntil(() => prompts.at(-1) === START);
    expect(prompts, "延迟队列的两项不该在开演前发").not.toContain(ART_LAOJIANG);
  });

  it("判不了就退回全量：没有树（404）时与老流程逐字一致", async () => {
    stubTree(null);
    useGameStore.getState().startGame(true, true);
    engineTurn();
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1);
    await vi.waitUntil(() => useGameStore.getState().preload.length > 0);

    const s1 = useGameStore.getState();
    expect(s1.preload.map((i) => i.name)).toEqual(["沈屿", "程野", "教导主任·老蒋", "旧教学楼", "天台"]);
    expect(s1.deferredArt).toEqual([]);
  });

  it("开演后逐张补画：每次空闲一项；补画回合正文不进历史、【图】不换画面", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn();
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1);
    for (const cmd of [ART_SHENYU, ART_CHENGYE, ART_BG_JIAOXUELOU]) {
      await vi.waitUntil(() => prompts.at(-1) === cmd);
      engineTurn();
    }
    await vi.waitUntil(() => prompts.at(-1) === START);
    engineTurn(OPENING); // 开演回合：正文进历史，屏切 game
    expect(useGameStore.getState().screen).toBe("game");
    const historyAfterOpening = useGameStore.getState().history.length;
    const bgBefore = useGameStore.getState().bgUrl;

    // 第一个正戏回合（玩家输入）收尾后，泵才动手——补画不与开场正文抢
    engineTurn("她把书包放在桌上。");
    await vi.waitUntil(() => prompts.at(-1) === ART_LAOJIANG);
    expect(useGameStore.getState().artAsk, "补画回合要标 artAsk").toBe(true);

    // 补画回合的确认句与【图】都不上玩家的屏：正文不进历史、背景不被换掉（只点亮槽位）
    useGameStore
      .getState()
      .handleEvent({ type: "chunk", seg: 0, text: "教导主任·老蒋 · 完成\n【图】背景|天台|images/9.jpg\n" });
    engineTurn();
    const s2 = useGameStore.getState();
    expect(s2.history.length, "补画回合的确认句不该进历史").toBe(historyAfterOpening + 1);
    expect(s2.bgUrl, "补画带来的【图】背景不该换掉玩家正在看的画面").toBe(bgBefore);
    expect(s2.artReady["天台"], "但槽位该点亮（补画的意义就在这）").toContain("/img");
  });

  it("补画期间玩家操作排队；回合收尾优先补发它，再继续补画", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn();
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    engineTurn(MANIFEST_CH1);
    for (const cmd of [ART_SHENYU, ART_CHENGYE, ART_BG_JIAOXUELOU]) {
      await vi.waitUntil(() => prompts.at(-1) === cmd);
      engineTurn();
    }
    await vi.waitUntil(() => prompts.at(-1) === START);
    engineTurn(OPENING);
    engineTurn("她把书包放在桌上。"); // 收尾时泵发第一项补画
    await vi.waitUntil(() => prompts.at(-1) === ART_LAOJIANG);

    // 补画回合进行中（引擎忙 + artAsk）：玩家的输入进排队，不撞 409
    const count = prompts.length;
    useGameStore.getState().sendPlayerTurn("我推开门");
    expect(prompts.length, "补画期间不该再发新指令").toBe(count);
    expect(useGameStore.getState().pendingPlayerPrompt).toBe("我推开门");

    engineTurn(); // 补画回合收尾：优先补发排队的输入
    await vi.waitUntil(() => prompts.at(-1) === "我推开门");
    expect(useGameStore.getState().pendingPlayerPrompt).toBeNull();
    expect(prompts, "玩家输入优先，补画要让位").not.toContain(ART_BG_TIANTAI);
  });

  it("换局清零：延迟队列、补画标记与排队的玩家输入都不跨玩法", async () => {
    useGameStore.setState({ deferredArt: [], artAsk: false, pendingPlayerPrompt: null });
    useGameStore.getState().startGame(true, false);
    const s1 = useGameStore.getState();
    expect(s1.deferredArt).toEqual([]);
    expect(s1.artAsk).toBe(false);
    expect(s1.pendingPlayerPrompt).toBeNull();
  });
});

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
    // 显式收尾（v1.13）：此前靠「切回标题屏」顺带清掉看门狗——那是一条隐式路径，
    // 读代码看不出这里在收尾；现在定时器归 store 实例所有，收尾有名字。
    disposeStore();
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

  it("批次起点：建队列时落时刻（屏上「平均每张 / 约还需」的数据源），换局清零", async () => {
    useGameStore.getState().startGame(true, true);
    engineTurn(); // 待命确认
    await vi.waitUntil(() => prompts.at(-1) === PLAN_CH1);
    expect(useGameStore.getState().preloadBatchStartedAt).toBeNull(); // 规划回合还没建队列

    const before = Date.now();
    engineTurn(MANIFEST_CH1); // 规划回合回清单 → 建队列
    // 建队列是异步的（两段式要读剧情树挑开场子集，v1.13）：等它落地再断言
    await vi.waitUntil(() => useGameStore.getState().preloadBatchStartedAt !== null);
    const startedAt = useGameStore.getState().preloadBatchStartedAt;
    expect(typeof startedAt, "建队列时应落批次起点").toBe("number");
    expect(startedAt!).toBeGreaterThanOrEqual(before);

    // 换一局（resetRunState 路径）：批次读数不该漂到新局上
    useGameStore.getState().startGame(true, false);
    expect(useGameStore.getState().preloadBatchStartedAt).toBeNull();
  });

  it("清单解析：按清单建队列、跳过已就绪项、顺序与指令逐字", async () => {
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
    expect(s.history).toEqual([{ kind: "act", n: "第 1 幕", t: OPENING_PROSE }]); // **行动** 段不进历史
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
    expect(c.history.at(-1)).toEqual({ kind: "act", n: "第 2 幕", t: "晚风把答案吹散在天台上。" }); // 【章】行不进历史

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
    expect(lastActText(useGameStore.getState().history)).toBe("灰雀镇的旅店亮着最后一盏灯。");
  });

  it("幕号 = 服务端快照序号（v1.13 修）：事件带 seq 时用它，不带（更老的 server）才回落客户端计数", async () => {
    await reachGame();
    const s0 = useGameStore.getState();
    // 制造「两套数字已经错开」的现场：续玩/回退会让快照 seq 跑到回合计数前面
    const d = s0.turnNo;
    expect(s0.history.at(-1)).toMatchObject({ kind: "act" });

    // ① 事件带 seq（= d + 7，模拟快照被续玩/回退推高）→ 幕号取 seq
    const s1 = useGameStore.getState();
    s1.handleEvent({ type: "turn_start" });
    s1.handleEvent({ type: "chunk", seg: 0, text: "带 seq 的一幕。\n**行动**\n1. 走" });
    s1.handleEvent({ type: "turn_end", seq: d + 7 });
    expect(lastActLabel(useGameStore.getState().history)).toBe(`第 ${d + 7} 幕`);

    // ② 事件不带 seq（更老的 server）→ 回落客户端计数，功能不消失
    const before = useGameStore.getState().turnNo;
    engineTurn("第二段正文。\n**行动**\n1. 走");
    expect(lastActLabel(useGameStore.getState().history)).toBe(`第 ${before + 1} 幕`);
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
    expect(st.portraits.map((x) => x.name)).toEqual(["沈屿"]);
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
    let p = speaker()!;
    expect(p.name).toBe("薇拉");
    expect(p.variant).toBe("");
    expect(p.baseUrl).toBe(p.url);

    useGameStore.getState().handleEvent({ type: "expression", character: "薇拉", variant: "微笑" });
    p = speaker()!;
    expect(p.variant).toBe("微笑");
    const u = new URL(p.url, "http://localhost");
    expect(u.pathname).toBe("/img");
    expect(u.searchParams.get("p")).toBe("presets/campus-summer/assets/立绘-薇拉-微笑.jpg");
    expect(p.baseUrl).toBeTruthy(); // 基础立绘保留，供 404 回退

    // 回基础（variant 空）
    useGameStore.getState().handleEvent({ type: "expression", character: "薇拉", variant: "" });
    const back = speaker()!;
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

  it("applyExpression / speakerOf / castMember 纯函数：同名原地更新并移到队尾、新角色追加、第三人淘汰队首", () => {
    const vera = { name: "薇拉", variant: "", url: "u-vera", baseUrl: "b-vera" };
    const shen = { name: "沈屿", variant: "", url: "u-shen", baseUrl: "b-shen" };

    // 空队列起步：直接进队，末位即发言者
    let cast = applyExpression([], vera);
    expect(cast).toEqual([vera]);
    expect(speakerOf(cast)).toBe(vera);
    expect(speakerOf([])).toBeNull();

    // 新角色追加到队尾
    cast = applyExpression(cast, shen);
    expect(cast.map((p) => p.name)).toEqual(["薇拉", "沈屿"]);
    expect(speakerOf(cast)?.name).toBe("沈屿");

    // 同名（带「」包夹也认）只更新那一个并移到队尾：队里不出现第二个薇拉，baseUrl 随既有槽位保留
    const veraSmile = { ...vera, variant: "微笑", url: "u-vera-smile" };
    cast = applyExpression(cast, veraSmile);
    expect(cast.map((p) => p.name)).toEqual(["沈屿", "薇拉"]);
    expect(cast).toHaveLength(MAX_STAGE);
    expect(speakerOf(cast)?.variant).toBe("微笑");
    expect(castMember(cast, "「薇拉」")?.url).toBe("u-vera-smile"); // 归一化比对
    expect(castMember(cast, "程野")).toBeNull();

    // 第三人（程野）上场：从**队首**淘汰最早出场的那位（沈屿），最近发言者留场
    const cheng = { name: "程野", variant: "", url: "u-cheng", baseUrl: "b-cheng" };
    cast = applyExpression(cast, cheng);
    expect(cast.map((p) => p.name)).toEqual(["薇拉", "程野"]);
    expect(speakerOf(cast)?.name).toBe("程野");

    // 连切同一角色的差分：队列长度不动（不重复占位）
    cast = applyExpression(cast, { ...cheng, variant: "冷脸", url: "u-cheng-cold" });
    expect(cast.map((p) => p.name)).toEqual(["薇拉", "程野"]);
    expect(speakerOf(cast)?.variant).toBe("冷脸");
  });

  it("expression 事件：同屏 2 人——第二位角色上屏并列，切回原角色时她移到队尾成为发言者", () => {
    useGameStore.getState().selectPreset(PRESET);
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|薇拉|images/1.jpg\n【图】立绘|沈屿|images/2.jpg\n" });

    // 两张【图】接着来：都上屏，末位（后出场）即发言者
    let cast = useGameStore.getState().portraits;
    expect(cast.map((p) => p.name)).toEqual(["薇拉", "沈屿"]);
    expect(cast[0].baseUrl).toBe(cast[0].url);

    // 薇拉切差分：她移到队尾（发言者），沈屿留场且槽位原样（名字不移位、不重复进队）
    useGameStore.getState().handleEvent({ type: "expression", character: "薇拉", variant: "微笑" });
    cast = useGameStore.getState().portraits;
    expect(cast.map((p) => p.name)).toEqual(["沈屿", "薇拉"]);
    expect(speaker()?.variant).toBe("微笑");
    expect(cast[0].variant).toBe(""); // 非发言者不动
    expect(cast[1].baseUrl).toContain("images%2F1.jpg"); // 同角色保留既有基础图（不按名字重拼兜底路径）

    // 沈屿回基础（variant 空）：她也移到队尾，薇拉的差分留在队首
    useGameStore.getState().handleEvent({ type: "expression", character: "沈屿", variant: "" });
    cast = useGameStore.getState().portraits;
    expect(cast.map((p) => p.name)).toEqual(["薇拉", "沈屿"]);
    expect(speaker()?.url).toBe(speaker()?.baseUrl);
    expect(cast).toHaveLength(MAX_STAGE); // 反复切换不涨人数
  });

  it("expression 事件：第三位角色上屏 → 淘汰最早出场者（队列恒 ≤ MAX_STAGE），发言者恒为队尾", () => {
    useGameStore.getState().selectPreset(PRESET);
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|薇拉|images/1.jpg\n" });
    s.handleEvent({ type: "expression", character: "沈屿", variant: "" });
    expect(useGameStore.getState().portraits.map((p) => p.name)).toEqual(["薇拉", "沈屿"]);

    s.handleEvent({ type: "expression", character: "程野", variant: "严肃" });
    const cast = useGameStore.getState().portraits;
    expect(cast.map((p) => p.name)).toEqual(["沈屿", "程野"]); // 最早出场的薇拉被淘汰
    expect(cast).toHaveLength(MAX_STAGE);
    expect(speakerOf(cast)?.variant).toBe("严肃");
    expect(castMember(cast, "薇拉")).toBeNull();
  });

  it("resetRunState：选剧本/开新世界线后立绘队列归空（下一条世界线不许留上一条的立绘）", () => {
    useGameStore.getState().selectPreset(PRESET);
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|薇拉|images/1.jpg\n【图】立绘|沈屿|images/2.jpg\n" });
    expect(useGameStore.getState().portraits).toHaveLength(2);

    useGameStore.getState().beginNewWorld("campus-summer-9");
    expect(useGameStore.getState().portraits).toEqual([]);
    expect(speakerOf(useGameStore.getState().portraits)).toBeNull();

    // 重新选剧本（同一 resetRunState 路径）同样清空
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|程野|images/3.jpg\n" });
    expect(useGameStore.getState().portraits).toHaveLength(1);
    useGameStore.getState().selectPreset(PRESET);
    expect(useGameStore.getState().portraits).toEqual([]);
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
    expect(speaker()?.name).toBe("薇拉");
    const t = useGameStore.getState();
    t.handleEvent({ type: "turn_start" });
    t.handleEvent({
      type: "chunk",
      seg: 0,
      text: "【图】立绘|薇拉-微笑|presets/campus-summer/assets/立绘-薇拉-微笑.jpg\n",
    });
    const st = useGameStore.getState();
    expect(speaker()?.url).toContain("images%2F1.jpg"); // 主立绘未被差分替换
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

  it("装配双击防线（v1.11 收尾）：turn_start 前第二次「装配。」不发——一次装配只花一个真回合", () => {
    useGameStore.getState().openCreation();
    const before = prompts.filter((p) => p === "装配。").length;
    // 「开始装配」按钮只按 engineBusy 禁用，而 engineBusy 要等 turn_start SSE 才置真——那一小段窗口里
    // 双击会发两遍。第一发已同步置 assembling，第二发必须被挡掉（连玩家气泡都不该多一条）。
    useGameStore.getState().sendCreation("装配。");
    useGameStore.getState().sendCreation("装配。");
    expect(prompts.filter((p) => p === "装配。")).toHaveLength(before + 1);
    expect(useGameStore.getState().creationMessages.filter((m) => m.text === "装配。")).toHaveLength(1);

    // 装配回合失败（回合结束仍没收到【新剧本】）→ assembling 清掉、置可重试：此时重发必须放行
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "turn_end" });
    expect(useGameStore.getState().assembling).toBe(false);
    expect(useGameStore.getState().assemblyStalled).toBe(true);
    useGameStore.getState().sendCreation("装配。");
    expect(prompts.filter((p) => p === "装配。")).toHaveLength(before + 2);
  });

  it("装配中的【图】标记：新剧本 id 揭示前不带 preset（不写进当前剧本目录），收到【新剧本】后带上", () => {
    useGameStore.getState().openCreation(); // 从正在玩的剧本（campus-summer）进创作屏
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: "【图】立绘|守夜人|images/9.jpg\n" });

    const before = new URL(speaker()!.url, "http://localhost");
    expect(before.searchParams.get("n")).toBe("守夜人");
    expect(before.searchParams.get("preset")).toBeNull(); // 新剧本 id 未知：宁可不落盘也不串味

    useGameStore.getState().handleEvent({ type: "presetAdded", id: "midnight-library" });
    const t = useGameStore.getState();
    t.handleEvent({
      type: "chunk",
      seg: 0,
      text: "【图】立绘|守夜人|presets/midnight-library/assets/立绘-守夜人.jpg\n",
    });

    const after = new URL(speaker()!.url, "http://localhost");
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
    expect(s.worldLabel).toBe(""); // 显示名留空：裸 worldId 不上屏（顶栏/图屏都不渲染），等玩家起名

    useGameStore.getState().startGame(true, true);
    expect(prompts.at(-1)).toBe(
      "开局：《盛夏偏差值》。快速开局：用剧本 quick_start 预设主角。世界：campus-summer-2。待命：只初始化，不开始剧情，等待分项美术指令与「开演。」",
    );
  });

  it("续玩世界线：resumeWorld 直接进 game 发「继续世界：」指令；章号取索引记录、显示名走 label → note 回退链", () => {
    useGameStore.getState().resumeWorld({
      worldId: "campus-summer-1",
      chapterNo: 3,
      note: "分叉自 campus-summer-1 @ 2-2",
      label: "",
    });
    const s = useGameStore.getState();
    expect(s.screen).toBe("game");
    expect(s.worldId).toBe("campus-summer-1");
    expect(s.worldLabel).toBe("分叉自 campus-summer-1 @ 2-2"); // 没有显示名才落到备注（裸 id 串由显示层再滤）
    expect(s.chapterNo).toBe(3);
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-1。");

    // 有显示名时显示名优先，且前后空白收敛；两者都空 → 空串（绝不回填裸 worldId）
    useGameStore
      .getState()
      .resumeWorld({ worldId: "campus-summer-2", chapterNo: 2, note: "第一次玩到这里", label: "  二周目  " });
    expect(useGameStore.getState().worldLabel).toBe("二周目");
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-3", chapterNo: 1, note: "", label: "" });
    expect(useGameStore.getState().worldLabel).toBe("");
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

  it("剧情图编辑：忙碌时排队不抢发（提示稍后自动发送），回合结束自动补发", () => {
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 1, note: "" });
    useGameStore.getState().openTree();
    useGameStore.getState().handleEvent({ type: "turn_start" }); // 引擎忙

    useGameStore.getState().sendTreeEdit("删掉节点 2-3");
    expect(prompts).toEqual(["继续世界：campus-summer-1。"]); // 编辑指令未抢发（只有续玩指令）
    expect(useGameStore.getState().pendingTreeMessage).toBe("剧情：删掉节点 2-3");
    expect(useGameStore.getState().treeNotice).toBe("忙碌中，就绪后自动发送");

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
    expect(useGameStore.getState().treeNotice).toBe("已创建新的世界线 · 从这一幕继续");

    useGameStore.getState().switchToFork();
    const s = useGameStore.getState();
    expect(s.screen).toBe("game"); // 关图屏并续玩新世界
    expect(s.worldId).toBe("campus-summer-3");
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-3。");
  });

  it("分叉：忙碌时 switchToFork 拒绝切换（提示留在当前世界）", async () => {
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 2, note: "" });
    useGameStore.getState().openTree();
    useGameStore.getState().forkAt("2-2");
    await vi.waitUntil(() => useGameStore.getState().forkResult !== null);

    useGameStore.getState().handleEvent({ type: "turn_start" }); // 引擎忙
    useGameStore.getState().switchToFork();

    const s = useGameStore.getState();
    expect(s.worldId).toBe("campus-summer-1"); // 未切换
    expect(s.treeNotice).toContain("忙碌中");
  });
});

describe("v1.6 批量重绘 / 素材删除 / 世界线管理（store 公共 API 驱动）", () => {
  /** 导入用的最小合法导出包（形状与 acp.WorldBundle 对齐） */
  const BUNDLE = {
    format: "bunkiten-world",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    world: {
      worldId: "campus-summer-8",
      preset: "campus-summer",
      title: "盛夏偏差值",
      label: "",
      note: "",
      chapterNo: 2,
      files: { state: null, summary: null, tree: null },
      snapshots: [],
    },
  };
  /** 画廊里两个可重绘项（key 与【图|重绘】标记里的名字都按既有契约） */
  const JOB_PORTRAIT = { type: "立绘", key: "薇拉", matchName: "薇拉" } as const;
  const JOB_BG = { type: "背景", key: "灰雀镇", matchName: "灰雀镇" } as const;
  const MARK_PORTRAIT = "【图】立绘|薇拉|presets/campus-summer/assets/立绘-薇拉.jpg|重绘\n";
  const MARK_BG = "【图】背景|灰雀镇|presets/campus-summer/assets/背景-灰雀镇.jpg|重绘\n";
  /** POST /api/assets 收到的删除请求（按顺序） */
  let assetPosts: { action: string; preset?: string; file?: string }[] = [];
  /** POST /api/worlds 收到的动作（按顺序） */
  let worldPosts: Record<string, unknown>[] = [];
  /** 让指定文件删除失败（file → 错误文案） */
  let deleteFails: Record<string, string> = {};
  /** 让指定世界线动作失败（action → 错误文案） */
  let worldFails: Record<string, string> = {};

  beforeEach(() => {
    prompts = [];
    assetPosts = [];
    worldPosts = [];
    deleteFails = {};
    worldFails = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/assets" && init?.method === "POST") {
          // 形状与客户端 postWorld/postAsset 的请求体一致（action 必填，preset/file 视动作而定）
          const body = JSON.parse(String(init.body)) as { action: string; preset?: string; file?: string };
          assetPosts.push(body);
          const fail = body.file ? deleteFails[body.file] : undefined;
          return fail ? jsonResponse({ error: fail }, 404) : jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/assets") return jsonResponse([]);
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          const fail = worldFails[body.action];
          if (fail) return jsonResponse({ ok: false, error: fail }, 400);
          if (body.action === "import") return jsonResponse({ ok: true, worldId: "campus-summer-9" });
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: [] });
        return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
      }),
    );
    useGameStore.getState().selectPreset(PRESET);
    // 画廊态的干净起点（store 是单例，批次记账不跨用例）
    useGameStore.setState({
      screen: "assets",
      screenReturn: "game",
      assetsStamp: 0,
      assetsPreview: null,
      regenPending: null,
      regenQueue: [],
      regenTotal: 0,
      regenDone: 0,
      regenFailed: [],
      regenNotice: null,
      assetsNotice: null,
      assetsBusy: false,
      engineBusy: false,
      worldNotice: null,
      worldBusy: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useGameStore.getState().toTitle(); // 清看门狗，避免测试进程悬挂
  });

  it("批量重绘：顺序队列逐条派发（一条收尾才发下一条），i/N 记账，跑空后落收尾提示", () => {
    useGameStore.getState().startRegenBatch([JOB_PORTRAIT, JOB_BG]);

    expect(prompts).toEqual(["美术：重绘 立绘 薇拉"]);
    expect(useGameStore.getState()).toMatchObject({
      regenPending: "立绘|薇拉",
      regenTotal: 2,
      regenDone: 0,
      regenQueue: [JOB_BG],
      regenNotice: null,
    });

    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "chunk", seg: 0, text: MARK_PORTRAIT });

    // 标记命中即解除挂起、刷新画廊；但回合没结束，下一条不许抢发（抢发必 409）
    expect(useGameStore.getState().regenPending).toBeNull();
    expect(useGameStore.getState().regenDone).toBe(1);
    expect(prompts).toHaveLength(1);

    useGameStore.getState().handleEvent({ type: "turn_end" });
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉", "美术：重绘 背景 灰雀镇"]);
    expect(useGameStore.getState()).toMatchObject({ regenPending: "背景|灰雀镇", regenQueue: [], regenDone: 1 });

    engineTurn(MARK_BG);
    const done = useGameStore.getState();
    expect(done.regenPending).toBeNull();
    expect(done.regenTotal).toBe(0);
    expect(done.regenDone).toBe(0); // 收尾后批次记账清零（提示里已经写清了结果）
    expect(done.regenNotice?.kind).toBe("ok");
    expect(done.regenNotice?.text).toContain("2 项已换图");
  });

  it("批量重绘：某条本轮没回标记 → 记未确认并继续跑，收尾提示点名那条", () => {
    useGameStore.getState().startRegenBatch([JOB_PORTRAIT, JOB_BG]);
    engineTurn(); // 第一条：回合结束但没收到 |重绘 标记
    expect(useGameStore.getState().regenFailed).toEqual(["立绘|薇拉"]);
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉", "美术：重绘 背景 灰雀镇"]); // 失败不拦住队列

    engineTurn(MARK_BG);
    const s = useGameStore.getState();
    expect(s.regenQueue).toEqual([]);
    expect(s.regenNotice?.kind).toBe("error");
    expect(s.regenNotice?.text).toContain("1/2 项换图");
    expect(s.regenNotice?.text).toContain("立绘|薇拉");
  });

  it("批量重绘：某条引擎报错 → 记未确认并立即接队列下一条（失败不拦住队列）", () => {
    useGameStore.getState().startRegenBatch([JOB_PORTRAIT, JOB_BG]);
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" });
    s.handleEvent({ type: "error", message: "image_gen failed" });

    expect(useGameStore.getState().regenFailed).toEqual(["立绘|薇拉"]);
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉", "美术：重绘 背景 灰雀镇"]); // 报错后立刻接上
    expect(useGameStore.getState().regenPending).toBe("背景|灰雀镇");
  });

  it("批量重绘：引擎忙或已有重绘在跑时拒绝起跑（不发指令、队列不动、提示原因）", () => {
    const s = useGameStore.getState();
    s.handleEvent({ type: "turn_start" }); // 引擎忙
    s.startRegenBatch([JOB_PORTRAIT]);
    expect(prompts).toEqual([]);
    expect(useGameStore.getState()).toMatchObject({ regenQueue: [], regenTotal: 0, regenPending: null });
    expect(useGameStore.getState().regenNotice?.kind).toBe("error");

    useGameStore.getState().handleEvent({ type: "turn_end" }); // 收尾本轮，不留忙态
    useGameStore.getState().startRegenBatch([JOB_PORTRAIT]);
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉"]); // 空闲后正常起跑
    useGameStore.getState().handleEvent({ type: "turn_start" });
    useGameStore.getState().handleEvent({ type: "turn_end" });
    useGameStore.getState().handleEvent({ type: "turn_end" }); // 幂等：空闲时的 turn_end 不再乱动队列
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉"]);
  });

  it("批量删除：逐条 POST delete（顺序=入参顺序），收尾刷新清单（assetsStamp+1）并落成功提示", async () => {
    const stamp0 = useGameStore.getState().assetsStamp;
    const files = ["presets/campus-summer/assets/立绘-薇拉.jpg", "presets/campus-summer/assets/背景-灰雀镇.jpg"];
    await useGameStore.getState().deleteAssets(files);

    expect(assetPosts).toEqual([
      // postAssetDelete 在 HTTP 边界把完整相对路径收敛为单层文件名（服务端 ASSET_DELETE_FILE_RE 契约）
      { action: "delete", preset: "campus-summer", file: "立绘-薇拉.jpg" },
      { action: "delete", preset: "campus-summer", file: "背景-灰雀镇.jpg" },
    ]);
    const s = useGameStore.getState();
    expect(s.assetsBusy).toBe(false);
    expect(s.assetsStamp).toBe(stamp0 + 1);
    expect(s.assetsNotice).toEqual({ kind: "ok", text: "已删除 2 项素材（已移入回收站 state/trash/，可手工找回）" });
  });

  it("批量删除：部分失败逐条记账（成功项照删），提示点名失败文件并标 error", async () => {
    const stamp0 = useGameStore.getState().assetsStamp;
    const bad = "presets/campus-summer/assets/立绘-薇拉.jpg";
    deleteFails = { "立绘-薇拉.jpg": "文件不存在" }; // mock 按收敛后的请求体（basename）命中
    await useGameStore.getState().deleteAssets([bad, "presets/campus-summer/assets/背景-灰雀镇.jpg"]);

    expect(assetPosts.map((p) => p.file)).toEqual(["立绘-薇拉.jpg", "背景-灰雀镇.jpg"]);
    const s = useGameStore.getState();
    expect(s.assetsNotice?.kind).toBe("error");
    expect(s.assetsNotice?.text).toContain("已删除 1/2 项");
    expect(s.assetsNotice?.text).toContain("立绘-薇拉.jpg");
    expect(s.assetsNotice?.text).toContain("文件不存在");
    expect(s.assetsStamp).toBe(stamp0 + 1); // 失败也要刷新：成功的那些已经不在磁盘上了
  });

  it("批量删除：没有剧本上下文或空清单时原地不动（不发请求、不刷新、不落提示）", async () => {
    const stamp0 = useGameStore.getState().assetsStamp;
    await useGameStore.getState().deleteAssets([]);
    useGameStore.setState({ selected: null });
    await useGameStore.getState().deleteAssets(["presets/campus-summer/assets/立绘-薇拉.jpg"]);

    expect(assetPosts).toEqual([]);
    expect(useGameStore.getState().assetsStamp).toBe(stamp0);
    expect(useGameStore.getState().assetsNotice).toBeNull();
  });

  it("世界线改名：POST update 带 label/note（空串=清除），成功与失败分别落 worldNotice", async () => {
    const ok = await useGameStore.getState().updateWorld({ worldId: "campus-summer-1", label: "雨夜那条", note: "" });
    expect(ok.ok).toBe(true);
    expect(worldPosts).toEqual([{ action: "update", worldId: "campus-summer-1", label: "雨夜那条", note: "" }]);
    expect(useGameStore.getState().worldNotice).toEqual({ kind: "ok", text: "已保存「雨夜那条」的显示信息" });
    expect(useGameStore.getState().worldBusy).toBe(false);

    worldFails = { update: "label 太长" };
    const bad = await useGameStore.getState().updateWorld({ worldId: "campus-summer-1", label: "x", note: "y" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("label 太长");
    expect(useGameStore.getState().worldNotice).toEqual({ kind: "error", text: "保存失败：label 太长" });
    expect(useGameStore.getState().worldBusy).toBe(false);
  });

  it("世界线导入：合法包原样回传服务端 import，成功提示落 worldId；服务端拒绝走 error 提示", async () => {
    const ok = await useGameStore.getState().importWorldText(JSON.stringify(BUNDLE));
    expect(ok).toEqual({ ok: true, worldId: "campus-summer-9" });
    expect(worldPosts).toEqual([{ action: "import", bundle: BUNDLE }]);
    expect(useGameStore.getState().worldNotice).toEqual({ kind: "ok", text: "已导入世界线 campus-summer-9" });
    expect(useGameStore.getState().worldBusy).toBe(false);

    worldFails = { import: "bundle 校验失败" };
    const bad = await useGameStore.getState().importWorldText(JSON.stringify(BUNDLE));
    expect(bad.ok).toBe(false);
    expect(useGameStore.getState().worldNotice).toEqual({ kind: "error", text: "导入失败：bundle 校验失败" });
  });

  it("世界线导入：非法原文本地挡下（不打服务端），提示说清「不是导出包」", async () => {
    for (const text of [
      "{ 这不是 JSON",
      JSON.stringify({ format: "other", version: 1 }),
      JSON.stringify({ format: "bunkiten-world", version: 0 }),
    ]) {
      const r = await useGameStore.getState().importWorldText(text);
      expect(r.ok).toBe(false);
      expect(useGameStore.getState().worldNotice?.kind).toBe("error");
    }
    expect(worldPosts).toEqual([]); // 一次都没打扰服务端
  });

  it("parseWorldBundle：format/version/worldId 三处校验，合法包原样返回", () => {
    expect(parseWorldBundle(JSON.stringify(BUNDLE))).toEqual(BUNDLE);
    expect(parseWorldBundle("不是 JSON")).toBeNull();
    expect(parseWorldBundle("[]")).toBeNull();
    // 版本只要求正整数：上限由服务端裁决（v1.8–v1.12 客户端抄成「只认 1」，把 v2/v3 包挡在门外）
    expect(parseWorldBundle(JSON.stringify({ ...BUNDLE, version: 2 }))).toEqual({ ...BUNDLE, version: 2 });
    expect(parseWorldBundle(JSON.stringify({ ...BUNDLE, version: 3 }))).toEqual({ ...BUNDLE, version: 3 });
    expect(parseWorldBundle(JSON.stringify({ ...BUNDLE, version: 0 }))).toBeNull();
    expect(parseWorldBundle(JSON.stringify({ ...BUNDLE, version: 1.5 }))).toBeNull();
    expect(parseWorldBundle(JSON.stringify({ format: "bunkiten-world", version: 1 }))).toBeNull();
    expect(parseWorldBundle(JSON.stringify({ ...BUNDLE, world: { ...BUNDLE.world, worldId: "" } }))).toBeNull();
  });
});

describe("v1.6 精确回退与自动前进（store 公共 API 驱动）", () => {
  /** POST /api/worlds 收到的动作（按顺序） */
  let worldPosts: Record<string, unknown>[] = [];
  /** POST /prompt 收到的原始 body（逐字断言续档指令的载荷） */
  let promptBodies: string[] = [];
  /** restore 的返回（单个用例可覆盖成失败） */
  let restoreResp: Record<string, unknown> = { ok: true, backupSeq: 12 };
  /** 引擎空闲时的两个选项（自动前进到点要选第一项） */
  const OPTIONS = [
    { n: "1", t: "溜进座位" },
    { n: "2", t: "转身去天台" },
  ];
  /** 续档指令原文（与 parser.buildResumeCommand / 世界线屏「继续」同一条契约） */
  const RESUME = "继续世界：campus-summer-1。";

  beforeEach(() => {
    prompts = [];
    promptBodies = [];
    worldPosts = [];
    restoreResp = { ok: true, backupSeq: 12 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/prompt") {
          promptBodies.push(String(init?.body));
          prompts.push(JSON.parse(String(init?.body)).text);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          worldPosts.push(body);
          if (body.action === "restore") return jsonResponse(restoreResp, restoreResp.ok ? 200 : 400);
          if (body.action === "fork") return jsonResponse({ ok: true, worldId: "campus-summer-3" });
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
      }),
    );
    useGameStore.getState().selectPreset(PRESET);
    useGameStore.getState().resumeWorld({ worldId: "campus-summer-1", chapterNo: 2, note: "" });
    useGameStore.getState().openTree();
    // 自动前进的干净起点（store 是单例，上一用例的倒计时/取消不跨用例）
    useGameStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 0 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useGameStore.getState().toTitle();
  });

  it("原地回退：POST restore 带 worldId+seq；成功后补发续档指令让引擎重新读档同步（提示备份 seq 并自增 treeStamp）", async () => {
    const stamp0 = useGameStore.getState().treeStamp;
    expect(prompts).toEqual([RESUME]); // 基线：进屏时的续玩指令

    const r = await useGameStore.getState().restoreSnapshot(7);

    expect(r.ok).toBe(true);
    expect(worldPosts).toStrictEqual([{ action: "restore", worldId: "campus-summer-1", seq: 7 }]);
    // 三文件覆盖只是「换档」：紧接着必须让引擎按续档语义重新读 state/summary（跳过初始化与开场卡，重发【图】标记）
    expect(promptBodies.at(-1)).toBe(JSON.stringify({ text: RESUME }));
    expect(prompts).toEqual([RESUME, RESUME]); // 恰好多出一条，且是回退世界的那条
    const s = useGameStore.getState();
    // v1.7 三态文案的第一态：回退落定、等重同步回合收尾才说「完成重同步」（见 ui.test.tsx 的三态用例）
    expect(s.treeNotice).toBe("已回到第 7 幕；回退前的进度已备份，正在同步进度…");
    expect(s.treeStamp).toBe(stamp0 + 1);
  });

  it("原地回退后的续档回合：引擎重发【图】标记 → 画面按回退后的档重建（回退不是「只换文件」）", async () => {
    useGameStore.setState({ bgUrl: null, portraits: [] }); // 清掉回退前的画面：下面看到的一切都得是引擎重发的
    await useGameStore.getState().restoreSnapshot(7);

    engineTurn(
      "雨还在下。你回到了走廊尽头。\n【图】背景|旧教学楼|images/40.jpg\n【图】立绘|沈屿|images/41.jpg\n**行动**\n1. 推门",
    );

    const s = useGameStore.getState();
    expect(new URL(s.bgUrl ?? "", "http://localhost").searchParams.get("p")).toBe("images/40.jpg");
    expect(s.portraits.map((x) => x.name)).toEqual(["沈屿"]);
    expect(lastActText(s.history)).toBe("雨还在下。你回到了走廊尽头。"); // 续档回合是正常回合（选项段照旧不进历史）
    expect(s.options?.map((o) => o.t)).toEqual(["推门"]);
  });

  it("原地回退：忙碌（或有排队指令）时拒绝——回退覆盖的正是引擎在写的文件；失败不改 treeStamp 也不发指令", async () => {
    const stamp0 = useGameStore.getState().treeStamp;
    const sent0 = prompts.length; // 进屏时的续玩指令：此后不该再多任何一条
    useGameStore.getState().handleEvent({ type: "turn_start" }); // 引擎忙

    const busy = await useGameStore.getState().restoreSnapshot(7);
    expect(busy.ok).toBe(false);
    expect(worldPosts).toStrictEqual([]); // 一个请求都没发
    expect(prompts).toHaveLength(sent0);
    expect(useGameStore.getState().treeNotice).toContain("忙碌中");

    useGameStore.getState().handleEvent({ type: "turn_end" });
    useGameStore.setState({ pendingTreeMessage: "剧情：删掉节点 2-3" });
    expect((await useGameStore.getState().restoreSnapshot(7)).ok).toBe(false);
    expect(worldPosts).toStrictEqual([]);
    expect(prompts).toHaveLength(sent0); // 排队指令还在：同样一条都不发

    // 回退本身失败（HTTP 400 / ok:false）：不发续档指令、不改 treeStamp，提示说清原因
    useGameStore.setState({ pendingTreeMessage: null });
    restoreResp = { ok: false, error: "快照已不存在" };
    const bad = await useGameStore.getState().restoreSnapshot(9);
    expect(bad.ok).toBe(false);
    expect(useGameStore.getState().treeNotice).toBe("回退失败：快照已不存在");
    expect(useGameStore.getState().treeStamp).toBe(stamp0);
    expect(prompts).toHaveLength(sent0); // 文件都没回退成，不许让引擎去读档
  });

  it("分叉：带 seq 走精确分叉（载荷带 seq），不带 seq 的载荷与 v1.5 逐字一致", async () => {
    useGameStore.getState().forkAt("2-1", 3);
    await vi.waitUntil(() => worldPosts.length === 1);
    expect(worldPosts[0]).toStrictEqual({ action: "fork", worldId: "campus-summer-1", nodeId: "2-1", seq: 3 });
    // 提示不点名快照/节点（裸编号不上屏）：精确性只体现在载荷与 forkResult 里
    await vi.waitUntil(() => useGameStore.getState().treeNotice === "已创建新的世界线 · 从这一幕继续");

    useGameStore.getState().forkAt("2-4");
    await vi.waitUntil(() => worldPosts.length === 2);
    // toStrictEqual：无快照时连 seq 键都不许出现（旧世界的既有载荷不许被改写）
    expect(worldPosts[1]).toStrictEqual({ action: "fork", worldId: "campus-summer-1", nodeId: "2-4" });
    await vi.waitUntil(() => useGameStore.getState().treeNotice === "已创建新的世界线 · 从这一幕继续");
  });

  it("自动前进：到点自动选第一项；重复 arm 幂等（不重置计时）", () => {
    vi.useFakeTimers();
    useGameStore.setState({
      screen: "game",
      engineBusy: false,
      typingDone: true,
      options: OPTIONS,
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 3000 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });

    useGameStore.getState().armAutoAdvance();
    const deadline = useGameStore.getState().autoAdvanceDeadline;
    expect(deadline).toBe(Date.now() + 3000);

    useGameStore.getState().armAutoAdvance(); // 幂等：选项组件重渲染不该把计时重置
    expect(useGameStore.getState().autoAdvanceDeadline).toBe(deadline);

    vi.advanceTimersByTime(2999);
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-1。"); // 还没到点
    vi.advanceTimersByTime(1);
    expect(prompts.at(-1)).toBe("溜进座位"); // 到点自动选第一项
    expect(useGameStore.getState().autoAdvanceDeadline).toBeNull();
    expect(useGameStore.getState().options).toBeNull(); // 走的是同一条 send：选项随即收起
    expect(useGameStore.getState().status).toBe("引擎演绎中…");
  });

  it("自动前进：设置关 / 引擎忙 / 有排队指令 / 打字未完 / 无选项 / 非游戏屏都不启动", () => {
    const armed = () => useGameStore.getState().autoAdvanceDeadline;
    const ready = { screen: "game" as const, engineBusy: false, typingDone: true, options: OPTIONS };
    useGameStore.setState({
      ...ready,
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 3000 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });

    useGameStore.setState({ settings: { ...DEFAULT_SETTINGS, autoAdvance: 0 } });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).toBeNull();

    useGameStore.setState({ settings: { ...DEFAULT_SETTINGS, autoAdvance: 3000 }, engineBusy: true });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).toBeNull(); // 引擎忙：这一轮还没定稿

    useGameStore.setState({ engineBusy: false, pendingCreationMessage: "想玩一个赛博朋克侦探故事" });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).toBeNull(); // 创作屏排队指令还没发出去

    useGameStore.setState({ pendingCreationMessage: null, pendingTreeMessage: "剧情：删掉节点 2-3" });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).toBeNull(); // 图屏排队编辑同理

    useGameStore.setState({ pendingTreeMessage: null, typingDone: false });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).toBeNull(); // 打字还没完：此刻没有「选项已就绪」

    useGameStore.setState({ typingDone: true, options: [] });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).toBeNull();

    useGameStore.setState({ options: OPTIONS, screen: "tree" });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).toBeNull(); // 不在游戏屏（图屏/画廊里不该替玩家做决定）

    useGameStore.setState({ screen: "game" });
    useGameStore.getState().armAutoAdvance();
    expect(armed()).not.toBeNull(); // 条件都齐了才起计时
    useGameStore.getState().cancelAutoAdvance();
  });

  it("自动前进：用户交互取消本回合（不到点补发），新回合 turn_start 复位后重新计时", () => {
    vi.useFakeTimers();
    useGameStore.setState({
      screen: "game",
      engineBusy: false,
      typingDone: true,
      options: OPTIONS,
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 3000 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });

    useGameStore.getState().armAutoAdvance();
    expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull();
    useGameStore.getState().cancelAutoAdvance(); // App 层的点击/按键/输入都落到这里
    expect(useGameStore.getState()).toMatchObject({ autoAdvanceDeadline: null, autoAdvanceMuted: true });

    useGameStore.getState().armAutoAdvance(); // 本回合已取消过：不再重开
    expect(useGameStore.getState().autoAdvanceDeadline).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(prompts.at(-1)).toBe("继续世界：campus-summer-1。"); // 被取消的倒计时不会到点补发

    // 新回合：上一回合的取消不跨回合
    useGameStore.getState().handleEvent({ type: "turn_start" });
    expect(useGameStore.getState().autoAdvanceMuted).toBe(false);
    useGameStore.setState({ engineBusy: false, typingDone: true, options: OPTIONS, autoAdvanceDeadline: null });
    useGameStore.getState().armAutoAdvance();
    expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull();
    vi.advanceTimersByTime(3000);
    expect(prompts.at(-1)).toBe("溜进座位");
  });

  it("自动前进：撞上引擎忙不作废，250ms 短延迟重试到引擎空闲后照样选第一项", () => {
    vi.useFakeTimers();
    useGameStore.setState({
      screen: "game",
      engineBusy: false, // 起跑时引擎空着（忙的时候根本不会起计时，见「都不启动」那条）
      typingDone: true,
      options: OPTIONS,
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 3000 },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    });
    const sent0 = prompts.length;

    useGameStore.getState().armAutoAdvance();
    expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull();

    // 倒计时跑着，引擎又忙起来（回合还在收尾 / 刚发出的指令还没落地）
    useGameStore.setState({ engineBusy: true });
    vi.advanceTimersByTime(3000); // 到点：引擎忙
    expect(prompts).toHaveLength(sent0); // 不抢发（抢发必 409）
    expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull(); // 也不算作废：仍在重试窗口里

    // 第一个重试窗口还没到：什么都不做
    vi.advanceTimersByTime(249);
    expect(prompts).toHaveLength(sent0);

    useGameStore.setState({ engineBusy: false }); // 引擎收尾完成
    vi.advanceTimersByTime(1); // 重试到点：这次引擎空着
    expect(prompts.at(-1)).toBe("溜进座位");
    expect(useGameStore.getState().autoAdvanceDeadline).toBeNull();
    expect(useGameStore.getState().options).toBeNull(); // 走的是同一条 send：选项随即收起
  });

  it("自动前进：重试预算用尽仍忙才作废；用户交互取消照旧立即生效", () => {
    vi.useFakeTimers();
    const armed = {
      screen: "game" as const,
      typingDone: true,
      options: OPTIONS,
      settings: { ...DEFAULT_SETTINGS, autoAdvance: 3000 as const },
      autoAdvanceDeadline: null,
      autoAdvanceMuted: false,
    };
    /** 起跑（空闲）→ 引擎忙起来 → 到点，返回起跑前的指令条数 */
    const armThenBusy = () => {
      useGameStore.setState({ ...armed, engineBusy: false });
      useGameStore.getState().armAutoAdvance();
      expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull(); // 起跑成功才谈得上「到点撞忙」
      useGameStore.setState({ engineBusy: true });
    };

    const sent0 = prompts.length;
    // 引擎一直忙：到点先进入重试窗口（不作废），累计 ~2s 后才放弃
    armThenBusy();
    vi.advanceTimersByTime(3000);
    expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull(); // 到点只是开始重试，不是作废
    expect(prompts).toHaveLength(sent0);
    vi.advanceTimersByTime(2000); // 预算用尽
    expect(prompts).toHaveLength(sent0);
    expect(useGameStore.getState().autoAdvanceDeadline).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(prompts).toHaveLength(sent0); // 作废后不会再补发

    // 用户交互取消：重试窗口里的倒计时同样一处清掉（语义与 v1.6 一致）
    armThenBusy();
    vi.advanceTimersByTime(3000); // 到点 → 进入重试
    expect(useGameStore.getState().autoAdvanceDeadline).not.toBeNull();
    useGameStore.getState().cancelAutoAdvance();
    expect(useGameStore.getState()).toMatchObject({ autoAdvanceDeadline: null, autoAdvanceMuted: true });
    useGameStore.setState({ engineBusy: false }); // 即便引擎随后空下来，被取消的倒计时也不许复活
    vi.advanceTimersByTime(10_000);
    expect(prompts).toHaveLength(sent0);
  });

  it("isTypingTarget：输入控件让路、滑杆不算（设置屏聚焦滑杆时快捷键照旧可用）", () => {
    // node 环境没有 DOM：用最小形状的假元素（判据只看 tagName/type/isContentEditable）
    const el = (tagName: string, extra: Record<string, unknown> = {}) =>
      ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;

    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "range" }))).toBe(false); // 滑杆：Esc 链与数字键都不该被它挡住
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false); // 没有 tagName 的目标（window 等）
  });
});
