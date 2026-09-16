// parser.ts 文本协议契约测试：期望值全部来自文件头 JSDoc 契约与手工推导的字面量，
// 与实现共享的真源只有行为规格本身（改实现不许改这里，除非契约变更）。
import { describe, expect, it } from "vitest";
import {
  AUDIO_KINDS,
  BUILD_ASSEMBLE,
  BUILD_START,
  ENTER_CREATION,
  PROTOCOL_HEADS,
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
  parseStoryTree,
  scanMarkers,
  splitAssetVariant,
  stripOptionsBlock,
  visibleTarget,
} from "../src/lib/parser";

describe("scanMarkers 流式扫描【图】标记", () => {
  it("完整行（以换行结束）匹配，name/path 去两端空白", () => {
    expect(scanMarkers("蝉鸣的教室。\n【图】立绘| 沈屿 | images/1.jpg \n")).toEqual([
      { kind: "portrait", name: "沈屿", path: "images/1.jpg" },
    ]);
  });

  it("流式半行（标记行还没有换行）不匹配，避免半截路径提前闪图", () => {
    expect(scanMarkers("【图】背景|图书馆|images/2.jpg")).toEqual([]);
  });

  it("不做去重：同一标记出现两行就返回两个（去重由调用方负责）", () => {
    const twice = "【图】背景|图书馆|images/1.jpg\n【图】背景|图书馆|images/1.jpg\n";
    expect(scanMarkers(twice)).toHaveLength(2);
  });

  it("封面类型（【图】封面|<剧本标题>|<路径>）是 v1.3 新增的标记类型", () => {
    expect(scanMarkers("剧本骨架 · 写入中\n【图】封面|末代天子|presets/twilight-throne/cover.jpg\n")).toEqual([
      { kind: "cover", name: "末代天子", path: "presets/twilight-throne/cover.jpg" },
    ]);
  });

  it("第四段「|重绘」解析为 regen=true（仅【素材重绘】输出的覆盖标记）；无第四段不产生 regen 字段", () => {
    expect(finalMarkers("【图】立绘|薇拉-微笑|images/12.jpg|重绘")).toEqual([
      { kind: "portrait", name: "薇拉-微笑", path: "images/12.jpg", regen: true },
    ]);
    expect(finalMarkers("【图】背景|太极殿|assets/背景-太极殿.jpg|重绘\n")).toEqual([
      { kind: "background", name: "太极殿", path: "assets/背景-太极殿.jpg", regen: true },
    ]);
    expect(finalMarkers("【图】立绘|薇拉|assets/立绘-薇拉.jpg")).toEqual([
      { kind: "portrait", name: "薇拉", path: "assets/立绘-薇拉.jpg" },
    ]);
  });
});

describe("finalMarkers 终态扫描", () => {
  it("行尾锚定：正文最后一行没有换行符的标记也能兜底匹配", () => {
    expect(finalMarkers("她走出门。\n【图】背景|天台|images/3.jpg")).toEqual([
      { kind: "background", name: "天台", path: "images/3.jpg" },
    ]);
  });

  it("行尾空白被吞掉，path 仍干净", () => {
    expect(finalMarkers("【图】背景|天台|images/3.jpg  \n")).toEqual([
      { kind: "background", name: "天台", path: "images/3.jpg" },
    ]);
  });

  it("不做去重（回到旧背景等场景需要重放）", () => {
    const twice = "【图】背景|A|images/1.jpg\n【图】背景|A|images/1.jpg";
    expect(finalMarkers(twice)).toHaveLength(2);
  });
});

describe("visibleTarget 打字机目标文本", () => {
  it("流式期间丢弃最后一行（可能是半截标记行）", () => {
    expect(visibleTarget("第一幕：蝉鸣\n她抬起头。\n半截还没收完", "")).toBe("第一幕：蝉鸣\n她抬起头。");
  });

  it("只有一行且未定稿时什么都不显示", () => {
    expect(visibleTarget("半截", "")).toBe("");
  });

  it("【图】行始终不进对话正文（含流式期间）", () => {
    expect(visibleTarget("【图】背景|教室|images/1.jpg\n蝉鸣渐起。\n半截", "")).toBe("蝉鸣渐起。");
  });

  it("finalText 落定后保留全部正文行", () => {
    expect(visibleTarget("【图】立绘|沈屿|images/1.jpg\n她开口了。\n「无聊。」", "已定稿全文")).toBe(
      "她开口了。\n「无聊。」",
    );
  });
});

describe("parseOptions 解析「**行动**」选项段", () => {
  it("正常段：编号支持「1.」与「1、」两种写法", () => {
    expect(parseOptions("她合上书，走出了教室。\n\n**行动**\n1. 跟出去\n2、留在教室\n")).toEqual([
      { n: "1", t: "跟出去" },
      { n: "2", t: "留在教室" },
    ]);
  });

  it("没有「**行动**」段时返回 null", () => {
    expect(parseOptions("她合上书。\n1. 跟出去")).toBeNull();
  });

  it("选项段里混入的【图】行被过滤，不产生选项", () => {
    expect(parseOptions("**行动**\n【图】立绘|沈屿|images/1.jpg\n1. 追上去\n2. 装作没看见")).toEqual([
      { n: "1", t: "追上去" },
      { n: "2", t: "装作没看见" },
    ]);
  });

  it("无编号行保留为选项，编号为空串", () => {
    expect(parseOptions("**行动**\n自由写下你想做的事")).toEqual([{ n: "", t: "自由写下你想做的事" }]);
  });
});

describe("stripOptionsBlock 截断「**行动**」选项段", () => {
  it("完整选项段：从「**行动**」行（含）起连同选项一并截断，只留正文", () => {
    expect(stripOptionsBlock("她合上书。\n\n**行动**\n1. 跟出去\n2. 留在教室")).toBe("她合上书。");
  });

  it("无选项段时原样返回（含尾部换行）", () => {
    expect(stripOptionsBlock("晚风把答案吹散。\n她抬头。\n")).toBe("晚风把答案吹散。\n她抬头。\n");
  });

  it("流式半截的「**行」不算选项段：不截断（行保持机制丢最后一行即可）", () => {
    expect(stripOptionsBlock("她开口了。\n**行")).toBe("她开口了。\n**行");
  });

  it("与 visibleTarget 行保持配合：「**行动**」行打出后正文不再增长", () => {
    // 行已完整：直接截断
    expect(visibleTarget("她开口了。\n**行动**\n1. 跟出", "")).toBe("她开口了。");
    // 选项还在流式补齐：目标保持不变
    expect(visibleTarget("她开口了。\n**行动**\n1. 跟出去\n2. 留在教室", "")).toBe("她开口了。");
    // 半截标记行：靠丢弃最后一行隐藏，不误伤正文
    expect(visibleTarget("她开口了。\n**行", "")).toBe("她开口了。");
  });

  it("cleanForHistory 历史清理：选项段与协议行都不进历史", () => {
    expect(cleanForHistory("正文推进。\n**行动**\n1. 选择\n2. 另一个选择")).toBe("正文推进。");
    expect(cleanForHistory("【图】背景|教室|images/1.jpg\n正文推进。\n**行动**\n1. 选择")).toBe("正文推进。");
  });
});

describe("cleanForHistory 历史正文", () => {
  it("过滤【图】行并去除首尾空白", () => {
    expect(cleanForHistory("\n【图】背景|教室|images/1.jpg\n蝉鸣渐起。\n她合上书。\n")).toBe(
      "蝉鸣渐起。\n她合上书。",
    );
  });

  it("过滤协议行：【清单】与【章】行同【图】一样不进历史", () => {
    expect(cleanForHistory("晚风把答案吹散。\n【章】第 1 章 完\n")).toBe("晚风把答案吹散。");
    expect(cleanForHistory("【清单】立绘|沈屿\n【清单】背景|天台\n")).toBe("");
  });
});

describe("parseManifest 制作清单（规划回合输出）", () => {
  it("整行匹配【清单】立绘|<名> / 【清单】背景|<地点>，name 去两端空白，保持输出顺序", () => {
    expect(parseManifest("【清单】立绘| 沈屿 \n【清单】背景|旧教学楼\n【清单】立绘|林晚照\n")).toEqual([
      { kind: "portrait", name: "沈屿" },
      { kind: "background", name: "旧教学楼" },
      { kind: "portrait", name: "林晚照" },
    ]);
  });

  it("夹在正文/其他行之间只取完整清单行；没有清单行返回空数组", () => {
    expect(parseManifest("沈屿：别愣着。\n【清单】立绘|沈屿\n（说明文字）")).toEqual([
      { kind: "portrait", name: "沈屿" },
    ]);
    expect(parseManifest("引擎没按协议输出。\n清单：沈屿")).toEqual([]);
  });

  it("行内前缀不误匹配（须整行以【清单】开头）", () => {
    expect(parseManifest("备注【清单】立绘|沈屿\n")).toEqual([]);
  });
});

describe("parseChapterMark 章标记（终章回合输出）", () => {
  it("匹配「【章】第 N 章 完」整行，返回章号", () => {
    expect(parseChapterMark("晚风把答案吹散在天台上。\n【章】第 1 章 完")).toBe(1);
    expect(parseChapterMark("【章】第 12 章 完\n")).toBe(12);
  });

  it("没有章标记返回 null；残缺格式不算", () => {
    expect(parseChapterMark("普通的一轮正文。\n**行动**\n1. 走")).toBeNull();
    expect(parseChapterMark("【章】第 1 章完")).toBeNull();
  });
});

describe("协议行过滤（正文与打字机）", () => {
  it("visibleTarget 过滤【清单】/【章】行（与【图】同类）", () => {
    expect(visibleTarget("【清单】立绘|沈屿\n【章】第 1 章 完\n她抬起头。", "已定稿")).toBe("她抬起头。");
  });

  it("parseOptions 选项段里混入的【章】行不产生选项", () => {
    expect(parseOptions("**行动**\n【章】第 1 章 完\n1. 追上去")).toEqual([{ n: "1", t: "追上去" }]);
  });

  it("【立绘】表情切换行不进对话正文与历史（v1.3）", () => {
    expect(visibleTarget("「无聊。」\n【立绘】沈屿|\n她合上书。", "已定稿")).toBe("「无聊。」\n她合上书。");
    expect(cleanForHistory("「无聊。」\n【立绘】薇拉|微笑\n她合上书。")).toBe("「无聊。」\n她合上书。");
  });

  it("【新剧本】行同【图】一样不进正文（创作模式装配收尾行）", () => {
    expect(visibleTarget("剧本骨架 · 写入中\n【新剧本】midnight-library\n", "已定稿")).toBe("剧本骨架 · 写入中\n");
  });
});

describe("parseCardLines protagonist_card 逐问解析", () => {
  it("「- 问题: A / B」拆出 label 与选项，全角/半角冒号等价", () => {
    const qs = parseCardLines(["- 姓名: 顾迟", "- 性别：男"]);
    expect(qs).toEqual([
      { label: "姓名", shortName: "姓名", multi: false, options: ["顾迟"] },
      { label: "性别", shortName: "性别", multi: false, options: ["男"] },
    ]);
  });

  it("「（选 1-2）」括注识别为 multi，shortName 剥掉尾部括注", () => {
    const [q] = parseCardLines(["- 特质（选 1-2）: 毒舌防御 / 情绪雷达 / 直觉"]);
    expect(q.label).toBe("特质（选 1-2）");
    expect(q.shortName).toBe("特质");
    expect(q.multi).toBe(true);
    expect(q.options).toEqual(["毒舌防御", "情绪雷达", "直觉"]);
  });

  it("半角括注同样剥离；「（选一）」不是 multi", () => {
    const [q] = parseCardLines(["- 身份(选一): 重考生 / 补习老师"]);
    expect(q.shortName).toBe("身份");
    expect(q.multi).toBe(false);
  });

  it("无法解析的行跳过，不产出问题", () => {
    expect(parseCardLines(["# protagonist_card", "普通说明行", "- 有冒号: A / B"])).toHaveLength(1);
  });
});

describe("开局指令字符串契约（与引擎 SKILL 一字不差）", () => {
  const answers = [
    { shortName: "姓名", values: ["顾迟"] },
    { shortName: "特质", values: ["毒舌防御", "情绪雷达"] },
  ];
  // v1.5：世界段 `世界：<worldId>。` 位于主角卡/快速开局段之后、美术结尾后缀之前
  const WORLD = "campus-summer-1";

  it("自定义开局 + 制作美术（待命模式：只初始化，等分项美术指令与「开演。」）", () => {
    expect(buildCustomOpening("盛夏偏差值", answers, true, WORLD)).toBe(
      "开局：《盛夏偏差值》。主角卡：姓名=顾迟；特质=毒舌防御+情绪雷达。世界：campus-summer-1。待命：只初始化，不开始剧情，等待分项美术指令与「开演。」",
    );
  });

  it("自定义开局 + 跳过美术（多值字段 + 连接、字段间「；」、卡末尾与指令间「。」分隔）", () => {
    expect(buildCustomOpening("盛夏偏差值", answers, false, WORLD)).toBe(
      "开局：《盛夏偏差值》。主角卡：姓名=顾迟；特质=毒舌防御+情绪雷达。世界：campus-summer-1。跳过美术预载，直接开演。",
    );
  });

  it("快速开局 + 制作美术（待命模式）", () => {
    expect(buildQuickOpening("盛夏偏差值", true, WORLD)).toBe(
      "开局：《盛夏偏差值》。快速开局：用剧本 quick_start 预设主角。世界：campus-summer-1。待命：只初始化，不开始剧情，等待分项美术指令与「开演。」",
    );
  });

  it("快速开局 + 跳过美术", () => {
    expect(buildQuickOpening("盛夏偏差值", false, WORLD)).toBe(
      "开局：《盛夏偏差值》。快速开局：用剧本 quick_start 预设主角。世界：campus-summer-1。跳过美术预载，直接开演。",
    );
  });

  it("世界段在美术后缀之前：待命/跳过后缀必须保持指令末尾（引擎按「以…结尾」识别变体）", () => {
    const standby = buildQuickOpening("盛夏偏差值", true, WORLD);
    expect(standby.endsWith("待命：只初始化，不开始剧情，等待分项美术指令与「开演。」")).toBe(true);
    expect(buildQuickOpening("盛夏偏差值", false, WORLD).endsWith("跳过美术预载，直接开演。")).toBe(true);
  });
});

describe("世界线指令（v1.5 契约）", () => {
  it("buildResumeCommand：「继续世界：<worldId>。」原文", () => {
    expect(buildResumeCommand("twilight-throne-2")).toBe("继续世界：twilight-throne-2。");
    expect(buildResumeCommand("main")).toBe("继续世界：main。");
  });
});

describe("剧情编辑指令（v1.5 剧情图契约）", () => {
  it("buildTreeEditCommand：前缀「剧情：」原文，输入首尾空白剥掉", () => {
    expect(buildTreeEditCommand("  在节点 3-1 后加一个雨夜遇袭的节点  ")).toBe("剧情：在节点 3-1 后加一个雨夜遇袭的节点");
  });
});

describe("协议行过滤：【树】（v1.5 剧情图编辑完成通知）", () => {
  it("visibleTarget 过滤【树】行（与【图】同类，独立成段不进正文）", () => {
    expect(visibleTarget("已新增节点 3-4：雨夜遇袭。\n【树】", "已定稿")).toBe("已新增节点 3-4：雨夜遇袭。");
  });

  it("cleanForHistory 过滤【树】行；parseOptions 里混入的【树】行不产生选项", () => {
    expect(cleanForHistory("已新增节点 3-4。\n【树】")).toBe("已新增节点 3-4。");
    expect(parseOptions("**行动**\n【树】\n1. 追上去")).toEqual([{ n: "1", t: "追上去" }]);
  });
});

describe("音频协议行（v1.6：【曲】/【环境】/【音效】）", () => {
  it("PROTOCOL_HEADS 是 9 项协议头（契约 lint 的真源），isProtocolLine 的正则由它构造", () => {
    expect(PROTOCOL_HEADS).toEqual(["图", "清单", "章", "立绘", "新剧本", "树", "曲", "环境", "音效"]);
    expect(PROTOCOL_HEADS).toHaveLength(9);
    expect(AUDIO_KINDS).toEqual(["曲", "环境", "音效"]);
    // 每个协议头都必须被 isProtocolLine 认下（正则不是手写的第二份，新增头只改一个数组）
    for (const head of PROTOCOL_HEADS) expect(isProtocolLine(`【${head}】…`)).toBe(true);
  });

  it("三行音频指令都是协议行：带名与「停」、首尾空白同样识别", () => {
    expect(isProtocolLine("【曲】雨夜")).toBe(true);
    expect(isProtocolLine("【环境】旅店大堂")).toBe(true);
    expect(isProtocolLine("【音效】门响")).toBe(true);
    expect(isProtocolLine("【曲】停")).toBe(true);
    expect(isProtocolLine("  【环境】停  ")).toBe(true);
  });

  it("正文里提到音频字样的行不算协议行（必须整行以【头】开头）", () => {
    expect(isProtocolLine("她说：【曲】是这首歌的名字。")).toBe(false);
    expect(isProtocolLine("（音效）门响了一声。")).toBe(false);
    expect(isProtocolLine("背景音是雨。")).toBe(false);
    expect(isProtocolLine("【他】走进来。")).toBe(false);
    expect(isProtocolLine("")).toBe(false);
  });

  it("visibleTarget：三行音频指令不进对话正文（流式与定稿都过滤）", () => {
    expect(visibleTarget("【曲】雨夜\n【环境】旅店大堂\n她推门进来。\n半截", "")).toBe("她推门进来。");
    expect(visibleTarget("【音效】门响\n她推门进来。\n【曲】停", "已定稿")).toBe("她推门进来。");
  });

  it("cleanForHistory：音频行不进历史（混在正文里也只留正文）", () => {
    expect(cleanForHistory("【曲】雨夜\n雨敲着窗。\n【环境】停\n**行动**\n1. 继续")).toBe("雨敲着窗。");
    expect(cleanForHistory("【音效】门响\n【曲】停\n")).toBe("");
  });

  it("parseOptions：选项段里混入的音频行不产生选项", () => {
    expect(parseOptions("**行动**\n【音效】门响\n1. 追上去\n【曲】停")).toEqual([{ n: "1", t: "追上去" }]);
  });
});

describe("assetNameMatches 缓存兜底匹配（v1.5 纯函数）", () => {
  const A = (name: string, variant = "") => ({ name, variant });

  it("空白归一等价：完全一致或名字互为包含即命中（引擎措辞可能更短）", () => {
    expect(assetNameMatches(A("薇拉"), A("薇拉"))).toBe(true);
    expect(assetNameMatches(A("薇拉"), A(" 薇拉 "))).toBe(true);
    expect(assetNameMatches(A("灰雀镇旅店"), A("旅店"))).toBe(true);
    expect(assetNameMatches(A("旅店"), A("灰雀镇旅店"))).toBe(true);
    // 中缀插入不算命中（命名一致性靠引擎侧缓存感知保证；这里只兜前后缀/空白差异）
    expect(assetNameMatches(A("灰雀镇廉价旅店"), A("灰雀镇旅店"))).toBe(false);
  });

  it("差分变体必须一致：基础资产不吸收差分项、反之亦然（防差分永不生成的回归）", () => {
    expect(assetNameMatches(A("薇拉", ""), A("薇拉", "微笑"))).toBe(false);
    expect(assetNameMatches(A("薇拉", "微笑"), A("薇拉", ""))).toBe(false);
    expect(assetNameMatches(A("薇拉", "微笑"), A("薇拉", "微笑"))).toBe(true);
    expect(assetNameMatches(A("薇拉", "礼服"), A("薇拉", "微笑"))).toBe(false);
  });

  it("不同名字不命中；空名不吞一切", () => {
    expect(assetNameMatches(A("薇拉"), A("沈屿"))).toBe(false);
    expect(assetNameMatches(A(""), A("薇拉"))).toBe(false);
    expect(assetNameMatches(A("薇拉"), A(""))).toBe(false);
  });
});

describe("parseStoryTree 剧情树解析（v1.5 剧情图屏数据源）", () => {
  const TREE = [
    "# 剧情树",
    "## 归档",
    "- 第 1 章：教室相遇；已走：1-1 → 1-2 → 1-3",
    "",
    "## 第 2 章：雨夜来客",
    "- 目标: 让玩家与来客建立信任或敌意",
    "- 大纲: 雨夜，来客敲门，三条分支……",
    "- 当前进度: 节点 2-2（已走 3 轮）",
    "",
    "### 节点 2-1（来客敲门）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿、来客",
    "- 梗概: 深夜有人敲门，沈屿犹豫要不要开",
    "- 出边: 开门 → 2-2；装作没听见 → 2-3",
    "- 状态: 已走过",
    "",
    "### 节点 2-2（门外的雨声）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿、来客",
    "- 梗概: 来客淋着雨，递上一封信",
    "- 出边: 接过信 → 2-4",
    "- 状态: 已走过",
    "",
    "### 节点 2-3（假装睡着）",
    "- 地点: 灰雀镇旅店",
    "- 在场: 沈屿",
    "- 梗概: 敲门声停了，走廊里传来拖拽声",
    "- 出边: 起身查看 -> 2-4",
    "- 状态: 已剪枝",
  ].join("\n");

  it("解析归档、章节字段与全部节点（地点/在场/梗概/出边/状态）", () => {
    const tree = parseStoryTree(TREE)!;
    expect(tree.archive).toEqual(["第 1 章：教室相遇；已走：1-1 → 1-2 → 1-3"]);
    expect(tree.chapters).toHaveLength(1);
    const ch = tree.chapters[0];
    expect(ch.title).toBe("雨夜来客");
    expect(ch.goal).toContain("信任或敌意");
    expect(ch.current).toBe("2-2");
    expect(ch.nodes.map((n) => n.id)).toEqual(["2-1", "2-2", "2-3"]);
    expect(ch.nodes[0]).toMatchObject({
      beat: "来客敲门",
      location: "灰雀镇旅店",
      present: "沈屿、来客",
      status: "已走过",
    });
    expect(ch.nodes[0].edges).toEqual([
      { label: "开门", target: "2-2" },
      { label: "装作没听见", target: "2-3" },
    ]);
    expect(ch.nodes[2].status).toBe("已剪枝");
    expect(ch.nodes[2].edges).toEqual([{ label: "起身查看", target: "2-4" }]); // 半角箭头同样识别
  });

  it("容错：空文件/未规划/损坏内容返回 null（屏内回退显示原文）", () => {
    expect(parseStoryTree("")).toBeNull();
    expect(parseStoryTree("   \n")).toBeNull();
    expect(parseStoryTree("# 剧情树\n（引擎还没规划）")).toBeNull();
  });

  it("字段缺失留空、未知状态回退「可达」，坏行跳过不抛错", () => {
    const tree = parseStoryTree("## 第 1 章：\n### 节点 1-1\n- 地点: 教室\n- 状态: 莫名其妙的词\n垃圾行\n")!;
    expect(tree.chapters[0].title).toBe("第 1 章");
    expect(tree.chapters[0].nodes[0]).toMatchObject({ id: "1-1", location: "教室", status: "可达", present: "" });
    expect(tree.chapters[0].nodes[0].edges).toEqual([]);
  });
});

describe("分项美术指令与开演（制作中屏队列契约）", () => {
  it("buildArtCommand：立绘/背景两种指令原文", () => {
    expect(buildArtCommand("立绘", "沈屿")).toBe("美术：立绘 沈屿");
    expect(buildArtCommand("背景", "开场场景")).toBe("美术：背景 开场场景");
  });

  it("BUILD_START 是「开演。」原文", () => {
    expect(BUILD_START).toBe("开演。");
  });
});

describe("章节规划指令（v1.2 章间制作流程契约）", () => {
  it("buildPlanCommand：「规划：第 N 章。」原文，章号动态", () => {
    expect(buildPlanCommand(1)).toBe("规划：第 1 章。");
    expect(buildPlanCommand(3)).toBe("规划：第 3 章。");
  });
});

describe("素材重绘指令（v1.3 画廊契约）", () => {
  it("buildRegenCommand：立绘（含差分）/背景/封面三种指令原文", () => {
    expect(buildRegenCommand("立绘", "薇拉-微笑")).toBe("美术：重绘 立绘 薇拉-微笑");
    expect(buildRegenCommand("背景", "太极殿")).toBe("美术：重绘 背景 太极殿");
    expect(buildRegenCommand("封面", "twilight-throne")).toBe("美术：重绘 封面 twilight-throne");
  });

  it("buildArtCommand 直接支持差分清单项（队列按清单原文发送）", () => {
    expect(buildArtCommand("立绘", "薇拉-微笑")).toBe("美术：立绘 薇拉-微笑");
  });

  it("splitAssetVariant：第一个连字符分隔，无连字符即基础版", () => {
    expect(splitAssetVariant("薇拉-微笑")).toEqual({ base: "薇拉", variant: "微笑" });
    expect(splitAssetVariant("薇拉")).toEqual({ base: "薇拉", variant: "" });
  });
});

describe("创作模式指令（v1.3 剧本创作契约）", () => {
  it("ENTER_CREATION 是「创作模式：进入剧本创作。」原文", () => {
    expect(ENTER_CREATION).toBe("创作模式：进入剧本创作。");
  });

  it("BUILD_ASSEMBLE 是「装配。」原文", () => {
    expect(BUILD_ASSEMBLE).toBe("装配。");
  });
});
