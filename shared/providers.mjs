// 服务目录的唯一真源（v1.10，docs/adr/0019）：一张表同时喂 GUI 的下拉与服务端的解析/测试端点，
// 任何一侧都不许再抄第二份 id 集合（契约 lint ⑦ 组断言 shared/providers.mjs ↔ 设置屏的渲染面）。
//
// 为什么是「目录」而不是「适配器」：这些服务说的都是同一套 OpenAI 兼容协议（/chat/completions、
// /images/generations），差别只在 base_url 与模型名——把差异收进数据表，协议层就不用为每家写代码。
// 长尾（自建网关、私有部署）走「自定义 + one-api/LiteLLM」逃生口，GUI 里的三格始终可手填。
//
// 数据纪律：
//   · id 是稳定键（写进 credentials.json 的 provider 字段），一经发布不改名；
//   · baseUrl 为空串 = 该服务的地址因账号/部署而异，必须由玩家手填（note 里说明形态）；
//   · models/imageModels 只是「下拉提示」，不是白名单——模型格永远可手填（各家模型 id 换代很快）；
//   · note 是给玩家的一句人话（显示在设置屏的服务说明位），不写实现细节。
//
// 与其他真源的关系：本文件是纯数据 + 纯函数、零依赖，运行时真体由 vite/vitest/electron 直接吃
//（.mjs），tsc 侧的类型由同目录 providers.d.mts 承接（与 shared/protocol.mjs 同款机制，ADR-0012）。

/**
 * 一条服务目录条目。
 * @typedef {Object} ProviderEntry
 * @property {string} id 稳定键（`[a-z0-9-]+`；写进 credentials.json）
 * @property {string} label 下拉里显示的名字
 * @property {"llm" | "image" | "both"} kind 这条服务能配哪种用途
 * @property {string} baseUrl 预填的 base_url；空串 = 需玩家按账号/部署手填（见 note）
 * @property {string[]} models 对话模型的示例 id（下拉提示，可空）
 * @property {string[]} [imageModels] 出图模型的示例 id（kind 含 image 时用；缺省=没有提示）
 * @property {string} [note] 给玩家的一句说明（服务地址/口径的特殊之处）
 */

/** @type {readonly ProviderEntry[]} */
export const PROVIDERS = Object.freeze([
  {
    id: "openai",
    label: "OpenAI",
    kind: "both",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    imageModels: ["gpt-image-1"],
    note: "对话与出图同一把 key；对话模型 id 以平台当前文档为准（模型格可手填）。",
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    kind: "both",
    baseUrl: "",
    models: [],
    note: "地址形如 https://<资源名>.openai.azure.com/openai/deployments/<部署名>，需在查询串带上 api-version；模型格填部署名。",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "llm",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    note: "聚合路由：一个 key 通多家模型，模型格填 vendor/model 形态的 id。",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "llm",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "base_url 不带 /v1 也能用（服务端两种写法都认）。",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    kind: "llm",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [],
    note: "模型 id 参见平台当前文档（模型格可手填）。",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    kind: "both",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [],
    imageModels: [],
    note: "对话与出图同一把 key；出图走 OpenAI 兼容的 /images/generations。",
  },
  {
    id: "dashscope",
    label: "阿里云百炼 / 通义",
    kind: "both",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [],
    imageModels: [],
    note: "兼容模式地址；出图若口径不同，请在「自定义」里按其文档填。",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    kind: "both",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [],
    imageModels: [],
    note: "一个 key 通多家开源模型；出图走同一 base_url 的 /images/generations。",
  },
  {
    id: "volcengine",
    label: "火山方舟 / 豆包",
    kind: "both",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
    imageModels: [],
    note: "模型格填方舟的推理接入点 id 或模型 id（以控制台为准）。",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "llm",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [],
    note: "模型 id 以平台当前文档为准。",
  },
  {
    id: "together",
    label: "Together AI",
    kind: "both",
    baseUrl: "https://api.together.xyz/v1",
    models: [],
    imageModels: [],
    note: "出图走同一 base_url 的 /images/generations。",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    kind: "llm",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: [],
    note: "模型格填 accounts/<账号>/models/<模型> 形态的 id（以平台为准）。",
  },
  {
    id: "xai",
    label: "xAI",
    kind: "both",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4.6"],
    imageModels: ["grok-imagine-image-quality"],
    note: "用 API key 时无需终端登录；出图口径与 OpenAI 略有出入（尺寸参数可能被忽略）。",
  },
  {
    id: "ollama",
    label: "Ollama（本机）",
    kind: "llm",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    note: "本机服务：先把模型拉下来（ollama pull <模型>），模型格填拉下来的名字。",
  },
  {
    id: "lmstudio",
    label: "LM Studio（本机）",
    kind: "llm",
    baseUrl: "http://localhost:1234/v1",
    models: [],
    note: "本机服务：在 LM Studio 里开启本地服务器后即用。",
  },
  {
    id: "vllm",
    label: "vLLM / 自建推理",
    kind: "llm",
    baseUrl: "",
    models: [],
    note: "自建服务的地址与模型名按你的部署填。",
  },
  {
    id: "gateway",
    label: "one-api / LiteLLM 网关",
    kind: "both",
    baseUrl: "",
    models: [],
    note: "把多家服务收在一个网关后面时用这里：地址与模型名按网关配置填。",
  },
  {
    id: "custom",
    label: "自定义（任意 OpenAI 兼容服务）",
    kind: "both",
    baseUrl: "",
    models: [],
    note: "按服务商文档填 base_url、key 与模型名。",
  },
]);

/** 目录里的 id 集合（下拉渲染与 credentials 校验共用；顺序即展示顺序） */
export const PROVIDER_IDS = Object.freeze(PROVIDERS.map((p) => p.id));

/**
 * 按用途筛出可选服务（设置屏两个下拉用）。
 * @param {"llm" | "image"} kind 用途
 * @returns {readonly ProviderEntry[]} kind 为 both 或该用途的条目（保持目录顺序）
 */
export function providersFor(kind) {
  return PROVIDERS.filter((p) => p.kind === kind || p.kind === "both");
}

/**
 * 取一条目录条目（未知 id 回 null；调用方据此回落「自定义」而不是拒绝加载）。
 * @param {string} id 服务 id
 * @returns {ProviderEntry | null}
 */
export function providerById(id) {
  const key = String(id || "").trim();
  return PROVIDERS.find((p) => p.id === key) ?? null;
}
