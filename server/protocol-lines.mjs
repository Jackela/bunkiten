// 协议行常量与解析（v1.7 拆模块）：注入 agent 的 RULES 原文 + 引擎输出流里的五种协议行 parse*
// + 质量守卫的内部追问指令 SUPPLEMENT_PROMPT（server → 引擎方向，不进 shared/protocol.mjs）。
// 零依赖纯函数——只有完整行传入才可能命中（行完整性由上游 flushArtLines 的换行累积保证）。
// 入口 server/acp-server.mjs 逐名 re-export 这些符号（tests/server.test.ts 与契约 lint 都从入口 import）。

// 导出供契约 lint（tests/contract.test.ts）逐句比对 docs/ARCHITECTURE.md 的副本。
// 为什么导出「逐句数组」而不是只导出拼接后的串：句内本身含句号（如「世界：<id>。」），
// 从长串反推句子边界不可靠；RULES_SENTENCES 是 6 句的真源，RULES 仍是它 `.join("")` 的产物
//（注入 agent 的字符串逐字不变，只是把两个视图都暴露出来）。
export const RULES_SENTENCES = [
  "本会话运行在自定义游戏客户端下：ask_user_question 卡片工具不可用，选项一律用文本格式（正文后加粗「**行动**」+ 每行一个编号选项，多问场景每个问题单独从 1 编号）。",
  "你的每条回复只能是简体中文剧情正文和文本选项，绝不输出过程旁白、计划说明或英文。",
  "回复最末尾可以追加若干【图】标记行（由 image_gen 产物而来），格式：【图】立绘|角色名|presets/<id>/assets/立绘-角色.jpg、【图】背景|地点名|presets/<id>/assets/背景-地点.jpg 或 【图】封面|剧本标题|presets/<id>/cover.jpg，重绘覆盖旧图时追加第四段|重绘；剧情演出中可穿插【立绘】角色|变体 行切换表情差分，并可穿插【曲】<名> / 【环境】<名> / 【音效】<名> 切换音频，新剧本入轮播后输出【新剧本】<id> 行；规划回合输出【清单】立绘|<名> / 【清单】背景|<地点> 清单行（只列 presets/<剧本 id>/assets/ 缺失项，全命中时输出【清单】空）；终章回合输出【章】第 N 章 完；剧情编辑回合改完树后输出【树】行。这些协议行独立成段，不进剧情正文。",
  "缓存纪律：任何 image_gen 调用前必须先确认当前剧本 presets/<剧本 id>/assets/ 下无同名文件（唯一例外：美术：重绘）。已有素材绝不重复生成，直接出 presets/<剧本 id>/assets/… 路径标记。",
  "世界纪律：所有 state 文件读写一律在当前世界目录 state/worlds/<世界 id>/ 内（世界 id 由客户端指令给出——开局指令的「世界：<id>。」段或「继续世界：<id>。」；未给出时用 main）；除世界线分叉说明（fork.md）外绝不读写其他世界目录。",
  // 第 6 句（音频纪律）逐字来自 CONTRACTS §5：与 SKILL 的【音频】小节、客户端 AudioManager 同一份协议
  "音频纪律：场景切换或情绪转折时，可用【曲】<名>、【环境】<名>、【音效】<名> 三行切换音频（各自单独成段，不进正文）；每轮【曲】/【环境】至多各一次、【音效】至多两次，无把握就不发；文件由作者放在 presets/<剧本 id>/audio/ 下（命名 <类型>-<名>.<扩展名>），文件不存在时静默不发——绝不生成音频、绝不在标记里写路径。",
];

/** 注入 agent 的 rules 原文（6 句拼接成一条：`_meta.rules`） */
export const RULES = RULES_SENTENCES.join("");

// 质量守卫的追问指令（v1.7）：server → 引擎的**内部**指令——sendPrompt 在正戏回合缺 `**行动**`
// 选项段时自动补发一次（每回合至多一次），只出现在 session/prompt 的请求方向。
// 刻意不进 shared/protocol.mjs：它不是客户端协议——客户端从不构造也从不解析它，
// DIRECTIVE_PREFIX_RE（分档/正戏判定）与 PROTOCOL_HEADS（协议行过滤）都与它无关，真源只需要 server 一侧。
export const SUPPLEMENT_PROMPT = "补充：上一回合缺少 **行动** 选项段。请只补发完整的每轮协议回合尾（含 **行动** 与选项行），不要重述正文。";

// 【图】(立绘|背景|封面)|<名>|<路径>[|重绘]：资产标记（封面即剧本标题，重绘要求覆盖同名文件）
/** @param {string} line 协议行原文 @returns {{type: string, name: string, srcRel: string, regen: boolean}|null} */
export function parseArtLine(line) {
  const m = /^\s*【图】(立绘|背景|封面)\|([^|]+)\|([^|]+?)(?:\|(重绘))?\s*$/.exec(line);
  return m ? { type: m[1], name: m[2], srcRel: m[3], regen: m[4] === "重绘" } : null;
}

// 【立绘】<角色>|<变体>：表情切换指令，不是资产（server 不持久化，只转发事件）
/** @param {string} line 协议行原文 @returns {{character: string, variant: string}|null} */
export function parseExpressionLine(line) {
  const m = /^\s*【立绘】([^|]+?)\|([^|]*)\s*$/.exec(line);
  return m ? { character: m[1].trim(), variant: m[2].trim() } : null;
}

// 【新剧本】<id>：新剧本入轮播通知
/** @param {string} line 协议行原文 @returns {{id: string}|null} */
export function parsePresetAddedLine(line) {
  const m = /^\s*【新剧本】(.+?)\s*$/.exec(line);
  return m ? { id: m[1] } : null;
}

// 【树】：剧情图编辑完成通知（引擎已静默写回 story-tree.md）；行尾可带的摘要按 note 透传
/** @param {string} line 协议行原文 @returns {{note: string}|null} */
export function parseTreeLine(line) {
  const m = /^\s*【树】(.*?)\s*$/.exec(line);
  return m ? { note: m[1].trim() } : null;
}

// 【曲】/<名>、【环境】/<名>、【音效】/<名>：音频切换指令（演出指令，与【立绘】同级；server 不落盘，只广播）
// 行首 trim 后匹配（CONTRACTS §1）：名里不再夹带路径，`停` 也是普通名字（客户端自行处理淡出）
/** @param {string} line 协议行原文 @returns {{kind: "曲"|"环境"|"音效", name: string}|null} */
export function parseAudioLine(line) {
  const m = /^【(曲|环境|音效)】([^\n]*)$/.exec(String(line ?? "").trim());
  // 正则的交替组保证 m[1] 只能是这三个字面之一——cast 只是把这个不变式写进类型
  return m ? { kind: /** @type {"曲"|"环境"|"音效"} */ (m[1]), name: m[2] } : null;
}
