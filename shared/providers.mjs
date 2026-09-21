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
    id: "gemini",
    label: "Google Gemini",
    kind: "both",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.8-flash"],
    imageModels: ["gemini-2.5-flash-image"],
    note: "用它的 OpenAI 兼容层（Google AI Studio 的 key 即可）；出图同样走 /images/generations。",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    kind: "llm",
    baseUrl: "https://api.mistral.ai/v1",
    models: [],
    note: "模型 id 以平台当前文档为准（模型格可手填）。",
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
    label: "Moonshot / Kimi（国内）",
    kind: "llm",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [],
    note: "国内站；全球账号用 api.moonshot.ai（见「Kimi（全球）」）。模型 id 参见平台当前文档。",
  },
  {
    id: "moonshot-global",
    label: "Kimi（全球）",
    kind: "llm",
    baseUrl: "https://api.moonshot.ai/v1",
    models: [],
    note: "Moonshot 的国际站；国内账号用 api.moonshot.cn（见「Moonshot / Kimi（国内）」）。",
  },
  {
    id: "zhipu",
    label: "智谱 GLM（国内）",
    kind: "both",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [],
    imageModels: [],
    note: "对话与出图同一把 key；出图走 OpenAI 兼容的 /images/generations。",
  },
  {
    id: "dashscope",
    label: "阿里云百炼 / 通义（北京）",
    kind: "both",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [],
    imageModels: [],
    note: "华北2（北京）的兼容模式地址；密钥按地域独立，海外账号请在目录里选「阿里云百炼（新加坡）」。",
  },
  {
    id: "dashscope-intl",
    label: "阿里云百炼（新加坡）",
    kind: "both",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: [],
    imageModels: [],
    note: "新加坡地域的兼容模式地址；国内账号请在目录里选「阿里云百炼 / 通义（北京）」（另有美国/香港等地域，见百炼「Base URL 总览」）。",
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
    id: "baidu-qianfan",
    label: "百度千帆 / 文心",
    kind: "llm",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: [],
    note: "用 V2 推理接口（只有 v2 兼容 OpenAI）；模型格填千帆模型列表里的 id。",
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    kind: "llm",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbos-latest"],
    note: "腾讯云 API Key（控制台创建）；模型示例 hunyuan-turbos-latest。",
  },
  {
    id: "spark",
    label: "讯飞星火",
    kind: "llm",
    baseUrl: "https://spark-api-open.xf-yun.com/x2",
    models: ["spark-x"],
    note: "X2 通道（模型填 spark-x）；密钥用控制台「HTTP 协议的 APIpassword」当 Bearer。",
  },
  {
    id: "minimax",
    label: "MiniMax（国内）",
    kind: "llm",
    baseUrl: "https://api.minimaxi.com/v1",
    models: [],
    note: "国内站（域名比国际站多一个 i）；全球账号请在目录里选「MiniMax（全球）」。密钥与站点必须配套，选错会 401。",
  },
  {
    id: "minimax-global",
    label: "MiniMax（全球）",
    kind: "llm",
    baseUrl: "https://api.minimax.io/v1",
    models: [],
    note: "国际站；国内账号用 api.minimaxi.com（见「MiniMax（国内）」）。",
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
 * 服务 id 的稳定键形态（kebab-case 的 `[a-z0-9-]`）。
 *
 * 为什么单拎出来当唯一真源：目录可被远端更新注入**新 id**（docs/adr/0020），所以「是不是一个 id」
 * 这个形态判据、与「这张内置表里有没有它」这个白名单判据必须分开——
 *   · 读路径（server/credentials.mjs 的 normalizeCredentials）只按**形态**保留：目录一次抓不到时
 *     不能拿内置 PROVIDER_IDS 把玩家已存的远程 id 改回默认，否则目录抖一下配置就丢了；
 *   · 写路径（server/credentials.mjs 的 validateCredentialsPatch）仍按**白名单**严校验，白名单由调用点注入。
 * 同一份正则也被 server/providers-catalog.mjs 校验远端条目 id、契约 lint ⑦ 组复用（不抄第二份）。
 */
export const PROVIDER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
