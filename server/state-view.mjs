// 角色面板的解析与视图（v1.13 从 worlds.mjs 拆出，ADR-0013 的模块化延续）：
// state.md 是**引擎维护**的文件——小节可能缺、顺序可能乱、值可能越界，所以本模块只做
// 「尽力解析、缺的静默缺省」，任何输入都不抛错；未知小节（场景美术等）与角色卡的未知键（art_prompt 等）
// 一律忽略，不进响应。拆出来的理由：这是 server 侧最复杂的正则/字段映射，此前埋在 780 行的
// worlds.mjs（索引/CRUD/导出导入）里，改哪一头都要在同一个文件里翻。
// 入口 server/acp-server.mjs 逐名 re-export parseStateFile/stateViewFor（tests/server.test.ts 从这里 import）。
import fs from "fs";
import path from "path";
import { WORLDS_ROOT } from "./config.mjs";
import { WORLD_ID_RE } from "./snapshots.mjs";

// ---------- 角色面板（v1.7）：state.md 容错解析 → GET /api/state ----------
// state.md 由引擎（LLM）维护：小节可能缺、顺序可能乱、值可能越界——这里只做「尽力解析、缺的静默缺省」，
// 任何输入都不抛错；未知小节（场景美术等）与角色卡的未知键（art_prompt 等）一律忽略，不进响应。

/** state.md 的键值行：`- <键>: <值>`（冒号全半角都认；值可为空串） */
const STATE_KV_RE = /^-\s*([^:：]+?)\s*[:：]\s*(.*)$/;
/** 未回收伏笔行尾的轮次标注：`（埋于第 N 轮）`（全半角括号都认） */
const FORESHADOW_TURN_RE = /[（(]埋于第\s*(\d+)\s*轮[）)]\s*$/;

/** 好感度解析：取行内第一个整数并夹进 [0,100]（引擎可能写出界）；解析不出（如「很高」）→ null
 *  @param {unknown} raw @returns {number|null} */
function parseFavor(raw) {
  const m = /-?\d+/.exec(String(raw ?? ""));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

/** 行内整数（周目）；解析不出 → null
 *  @param {unknown} raw @returns {number|null} */
function parseIntOrNull(raw) {
  const m = /-?\d+/.exec(String(raw ?? ""));
  return m && Number.isFinite(Number(m[0])) ? Number(m[0]) : null;
}

/**
 * 角色面板里的单张角色卡（parseStateFile 的 characters 元素）。
 * @typedef {Object} CharacterCard
 * @property {string} name
 * @property {string} role 身份
 * @property {string} traits 性格关键词
 * @property {string} catchphrase 口癖
 * @property {number|null} favor 好感度（夹 0-100，解析不出 null）
 * @property {string} artFile
 * @property {string} expression 表情
 * @property {string} secret 秘密
 * @property {string} recentInteraction 最近互动
 */

/**
 * 世界 state.md 解析出的角色面板视图（GET /api/state 的响应体骨架）。
 * @typedef {Object} WorldStateView
 * @property {{preset: string|null, playthrough: number|null, time: string|null, scene: string|null}} status
 * @property {Record<string, string>} protagonist
 * @property {Record<string, string>} director
 * @property {CharacterCard[]} characters
 * @property {Array<{name: string, value: string}>} flags
 * @property {Array<{text: string, turn: number|null}>} foreshadowing
 */

/** 空角色卡（角色卡的缺省形状：字符串字段空串、好感度 null）
 *  @param {string} name @returns {CharacterCard} */
function newCharacterCard(name) {
  return {
    name,
    role: "",
    traits: "",
    catchphrase: "",
    favor: null,
    artFile: "",
    expression: "",
    secret: "",
    recentInteraction: "",
  };
}

/**
 * 解析世界 state.md 为角色面板视图（纯函数，容错见函数组头注释）。
 * `# 剧情状态` 的固定键 → status（preset/周目→playthrough/时间→time/场景→scene，缺省 null）；
 * `# 主角` / `# 导演手记` 的键值行原样收进 Record（键→值，引擎可自由加字段）；
 * `# 角色卡` 的 `## <角色名>` 子节 → characters（身份→role、性格关键词→traits、口癖→catchphrase、
 * 好感度→favor（夹 0-100，解析不出 null）、art_file→artFile、表情→expression、秘密→secret、最近互动→recentInteraction；
 * art_prompt 等未知键忽略）；`# Flags` → flags；`# 未回收伏笔` → foreshadowing（行尾「埋于第 N 轮」拆出 turn，缺省 null）。
 * @param {string|null|undefined} text state.md 全文（null/undefined 视同空文本，故类型含 null——此前只写 string 与实现不符）
 * @returns {WorldStateView}
 */
export function parseStateFile(text) {
  /** @type {WorldStateView} */
  const out = {
    status: { preset: null, playthrough: null, time: null, scene: null },
    protagonist: {},
    director: {},
    characters: [],
    flags: [],
    foreshadowing: [],
  };
  /** @type {Record<string, "preset"|"playthrough"|"time"|"scene">} */
  const STATUS_KEYS = { preset: "preset", 周目: "playthrough", 时间: "time", 场景: "scene" };
  /** @type {Record<string, "role"|"traits"|"catchphrase"|"favor"|"artFile"|"expression"|"secret"|"recentInteraction">} */
  const CHARACTER_KEYS = {
    身份: "role",
    性格关键词: "traits",
    口癖: "catchphrase",
    好感度: "favor",
    art_file: "artFile",
    表情: "expression",
    秘密: "secret",
    最近互动: "recentInteraction",
  };
  let section = ""; // 当前一级小节名（未知小节也跟踪，只是不解析内容）
  /** @type {CharacterCard|null} */ let character = null; // 角色卡小节里当前的 ## 角色（其它小节恒为 null）
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const h2 = /^##(?!#)\s*(.+?)\s*$/.exec(line);
    if (h2) {
      // 二级标题：角色卡小节里是角色名（开一张新卡）；其它小节里出现只结束当前上下文。
      // 同名卡 last-wins 去重：引擎整文件重写时旧卡新卡可能并存，不去重会撞 React key 与 testid。
      if (section === "角色卡") {
        const name = h2[1];
        const prev = out.characters.findIndex((c) => c.name === name);
        if (prev !== -1) out.characters.splice(prev, 1);
        character = newCharacterCard(name);
        out.characters.push(character);
      } else {
        character = null;
      }
      continue;
    }
    const h1 = /^#(?!#)\s*(.+?)\s*$/.exec(line);
    if (h1) {
      // 剥行尾括注再比对：SKILL 模板自带「# 角色卡（每个角色一节）」这类写给引擎看的说明，
      // LLM 拷模板时带上括注是完全可能的漂移——精确匹配会把整节角色卡静默吞掉。
      section = h1[1].replace(/[（(][^）)]*[）)]\s*$/, "").trim();
      character = null;
      continue;
    }
    const kv = STATE_KV_RE.exec(line);
    if (section === "剧情状态" && kv) {
      const key = STATUS_KEYS[kv[1].trim()];
      if (!key) continue;
      const v = kv[2].trim();
      if (key === "playthrough") out.status.playthrough = parseIntOrNull(v);
      else out.status[key] = v || null;
    } else if (section === "主角" && kv) {
      out.protagonist[kv[1].trim()] = kv[2].trim();
    } else if (section === "导演手记" && kv) {
      out.director[kv[1].trim()] = kv[2].trim();
    } else if (section === "角色卡" && character && kv) {
      const field = CHARACTER_KEYS[kv[1].trim()];
      if (field === "favor") character.favor = parseFavor(kv[2]);
      else if (field) character[field] = kv[2].trim();
    } else if (section === "Flags" && kv) {
      out.flags.push({ name: kv[1].trim(), value: kv[2].trim() });
    } else if (section === "未回收伏笔" && line.startsWith("-")) {
      let t = line.replace(/^-\s*/, "").trim();
      if (!t) continue;
      /** @type {number|null} */
      let turn = null;
      const m = FORESHADOW_TURN_RE.exec(t);
      if (m) {
        turn = Number(m[1]);
        t = t.slice(0, m.index).trim();
      }
      out.foreshadowing.push({ text: t, turn });
    }
  }
  return out;
}

/**
 * GET /api/state 的路由判定与响应体（导出纯函数，root 可注入以便单测）：
 * worldId 缺失或不过 WORLD_ID_RE → 400；世界没有 state.md → 404；否则 200 + `{worldId, ...parseStateFile}`。
 * @param {string} worldId 查询参数（调用方原样传入，缺失就是空串）
 * @param {string} [root] 世界根目录（缺省 WORLDS_ROOT）
 * @returns {{code: number, body: object}} 路由直接 writeHead/JSON 用
 */
export function stateViewFor(worldId, root = WORLDS_ROOT) {
  if (!worldId || !WORLD_ID_RE.test(worldId)) return { code: 400, body: { error: "缺少或非法的 worldId 参数" } };
  let md = null;
  try {
    md = fs.readFileSync(path.join(root, worldId, "state.md"), "utf8");
  } catch {
    md = null;
  }
  if (md === null) return { code: 404, body: { error: "状态文件不存在" } };
  return { code: 200, body: { worldId, ...parseStateFile(md) } };
}
