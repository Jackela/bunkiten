// shared/engines.mjs 的手写类型声明（v1.11）：机制与 shared/protocol.d.mts、shared/providers.d.mts 同款——
// tsc -b（moduleResolution: bundler）按 `.mjs` → `.d.mts` 解析，运行时真体是同目录的 engines.mjs
//（零依赖纯数据 + 纯函数，vite/vitest/electron 直接吃 .mjs，不经本文件）。
// 条目结构在这里钉住类型；值（有哪些引擎、叫什么名字）只活在 .mjs 里，本声明不重复第二份
//（契约 lint 只认 shared/engines.mjs 源码那一份）。

/** 一条引擎条目（展示与校验面；行为面在 server/engines.mjs 的描述符里） */
export interface EngineEntry {
  /** 稳定键（写进 credentials.json 的 engine 字段） */
  id: string;
  /** 选择器里显示的名字 */
  label: string;
  /** 一句说明（玩家话） */
  blurb: string;
  /** 未登录时让玩家在终端跑的命令（启动屏展示） */
  loginHint: string;
  /** 是否支持自备服务与密钥（false = 设置屏禁用该组的自备入口） */
  byok: boolean;
  /** byok=false 时的一句话原因（玩家话）；byok=true 时空串 */
  byokNote: string;
  /** 登录入口不可用时补在「这台机器上没有 X 的登录入口」后面的半句（给的是怎么办；空串 = 不补） */
  unavailableNote: string;
}

/** 引擎清单（唯一真源；顺序即展示顺序） */
export const ENGINES: readonly EngineEntry[];

/** 引擎 id 集合（选择器渲染与凭据校验共用） */
export const ENGINE_IDS: readonly string[];

/** 默认引擎 id（凭据里没有 / 不认得 engine 字段时回落） */
export const DEFAULT_ENGINE_ID: string;

/** 取一条引擎条目（未知 id 回 null） */
export function engineById(id: string): EngineEntry | null;
