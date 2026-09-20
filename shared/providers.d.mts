// shared/providers.mjs 的手写类型声明（v1.10）：机制与 shared/protocol.d.mts 同款——
// tsc -b（moduleResolution: bundler）按 `.mjs` → `.d.mts` 解析，运行时真体是同目录的 providers.mjs
//（零依赖纯数据，vite/vitest/electron 直接吃 .mjs，不经本文件）。
// 目录条目结构在这里钉住类型；值（哪些服务、什么地址）只活在 .mjs 里，本声明不重复第二份
//（契约 lint ⑦ 组只认 shared/providers.mjs 源码那一份）。

/** 一条服务目录条目 */
export interface ProviderEntry {
  /** 稳定键（`[a-z0-9-]+`；写进 credentials.json） */
  id: string;
  /** 下拉里显示的名字 */
  label: string;
  /** 这条服务能配哪种用途 */
  kind: "llm" | "image" | "both";
  /** 预填的 base_url；空串 = 需玩家按账号/部署手填（见 note） */
  baseUrl: string;
  /** 对话模型的示例 id（下拉提示，可空） */
  models: string[];
  /** 出图模型的示例 id（kind 含 image 时用） */
  imageModels?: string[];
  /** 给玩家的一句说明（服务地址/口径的特殊之处） */
  note?: string;
}

/** 服务目录（唯一真源；顺序即下拉展示顺序） */
export const PROVIDERS: readonly ProviderEntry[];

/** 目录里的 id 集合（下拉渲染与 credentials 校验共用） */
export const PROVIDER_IDS: readonly string[];

/** 按用途筛出可选服务（kind 为 both 或该用途的条目） */
export function providersFor(kind: "llm" | "image"): readonly ProviderEntry[];

/** 取一条目录条目（未知 id 回 null） */
export function providerById(id: string): ProviderEntry | null;
