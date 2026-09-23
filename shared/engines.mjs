// 引擎真源（v1.11，docs/adr/0022）：叙事引擎可选的「后端」清单——一张表同时喂设置屏的引擎选择器、
// 启动屏的登录提示与服务端 credentials 的校验；任何一侧都不许再抄第二份 id 集合
//（契约 lint 钉住 shared/engines.mjs ↔ 设置屏渲染面 ↔ server/engines.mjs 的描述符表）。
//
// 这里只放**展示与校验面**（id / 名字 / 说明 / 是否支持自备密钥）：行为面（spawn 参数、注入 env、
// skill 注入、图片解析、档位形状）在 server/engines.mjs 的描述符里——那份依赖 node 内置模块，
// 不能进前端 bundle。
//
// 数据纪律：
//   · id 是稳定键（写进 credentials.json 的 engine 字段），一经发布不改名；
//   · blurb / loginHint / byokNote 是给玩家的人话（设置屏与启动屏渲染），不写 env、变量名、协议名；
//   · byok=false 的引擎在设置屏禁用该组的「自备密钥」，原因由 byokNote 说清。
//
// 与其他真源的关系：纯数据 + 纯函数、零依赖，运行时真体由 vite/vitest/electron 直接吃（.mjs），
// tsc 侧类型由同目录 engines.d.mts 承接（与 shared/protocol.mjs、shared/providers.mjs 同款机制）。

/**
 * 一条引擎条目。
 * @typedef {Object} EngineEntry
 * @property {string} id 稳定键（写进 credentials.json 的 engine 字段）
 * @property {string} label 选择器里显示的名字
 * @property {string} blurb 一句说明（玩家话；选择器下方展示）
 * @property {string} loginHint 未登录时让玩家在终端跑的命令（启动屏展示）
 * @property {boolean} byok 是否支持自备服务与密钥（false = 设置屏禁用该组的自备入口）
 * @property {string} byokNote byok=false 时的一句话原因（玩家话；byok=true 时空串）
 * @property {string} unavailableNote 登录入口不可用时补在「这台机器上没有 X 的登录入口」后面的半句
 *   （给的是**怎么办**；空串 = 不补——比如随包运行时缺失这种不该发生的情况）
 */

/** @type {readonly EngineEntry[]} */
export const ENGINES = Object.freeze([
  {
    id: "grok",
    label: "Grok",
    blurb: "xAI 的 Grok。默认沿用终端里的登录状态，也可以填自己的服务与密钥。",
    loginHint: "grok login",
    byok: true,
    byokNote: "",
    unavailableNote: "（先装好 grok 命令行工具）",
  },
  {
    id: "codex",
    label: "Codex",
    blurb: "OpenAI 的 Codex。沿用终端里的登录状态；自备密钥暂不支持。",
    loginHint: "codex login",
    byok: false,
    byokNote: "Codex 的自定义服务要求另一套接口协议，市面上的服务商大多不适用，所以先只支持沿用终端登录。",
    unavailableNote: "",
  },
]);

/** 引擎 id 集合（选择器渲染与凭据校验共用；顺序即展示顺序） */
export const ENGINE_IDS = Object.freeze(ENGINES.map((e) => e.id));

/** 默认引擎：凭据里没有 / 不认得 `engine` 字段时用它（v1.10 及以前的凭据文件天然是 grok） */
export const DEFAULT_ENGINE_ID = "grok";

/**
 * 取一条引擎条目。
 * @param {string} id 引擎 id（未知值 → null）
 * @returns {EngineEntry | null} 条目
 */
export function engineById(id) {
  return ENGINES.find((e) => e.id === id) ?? null;
}
