// acp-server 的 HTTP/SSE 客户端。全部走相对路径：dev 由 vite 代理，生产由 /app 同源托管。
import type { AudioKind } from "./parser";

/** 剧本主题（preset frontmatter 的 theme 字段；字段非法或缺省由 theme.ts 兜底） */
export interface PresetTheme {
  accent: string;
  accent2: string;
  motif: string;
  /** 字体族档位 serif|song|kai|hei（v1.7；白名单与 theme.ts / acp-server.mjs 一致） */
  font?: string;
  /** 对话框质感档位 plain|silk|paper|glass（v1.7） */
  dialog?: string;
}

/** /api/presets 返回的单个剧本（字段与 server/acp-server.mjs scanPresets 对齐） */
export interface Preset {
  id: string;
  title: string;
  tagline: string;
  genre: string;
  rating: string;
  characters: string[];
  protagonist_card: string[];
  theme?: PresetTheme;
}

/** /api/assets 返回的单条持久化资产（形状与 server listAssets 对齐） */
export interface AssetEntry {
  /** "立绘" | "背景" | "封面" */
  type: string;
  /** 立绘=角色名（差分已拆出）；背景=地点名；封面=剧本标题 */
  name: string;
  /** 立绘差分变体名（基础版为空串） */
  variant: string;
  /**
   * 所属剧本 id（v1.5.1 资产随故事走：presets/<preset>/assets/）。
   * 每条都必须回填（服务端漏填会被画廊的防御性过滤当成跨剧本项丢掉并在控制台告警），别删这个字段。
   */
  preset: string;
  /** 相对 server 根的落盘路径（presets/<id>/assets/….jpg 或 presets/<id>/cover.jpg，展示走 {@link assetFileUrl}） */
  file: string;
  ready: boolean;
  /** 是否被当前剧情引用（state.md 文本含名字） */
  inUse: boolean;
  /** 磁盘 mtime（ms；画廊按需破缓存） */
  mtime: number;
}

export interface PresetsResponse {
  presets: Preset[];
  errors: { dir: string; error: string }[];
}

/**
 * /api/audio 返回的单条音频（v1.6）。目录 `presets/<id>/audio/`，文件命名 `<类型>-<名>.<ext>`；
 * 音频不落盘、不生成、不进 assetRegistry——索引只列「磁盘上已存在的文件」，缺失即静默 no-op。
 */
export interface AudioItem {
  /** 曲（BGM）/ 环境（环境音）/ 音效（一次性）——与协议行【曲】【环境】【音效】同字面 */
  kind: AudioKind;
  /** 名（与文件名里的 <名> 一致，协议行里写的就是它） */
  name: string;
  /** 相对 server 根的落盘路径 `presets/<剧本 id>/audio/<类型>-<名>.<ext>` */
  file: string;
  /** 服务端给出的直服 URL（/audio?p=…）；缺失时由 {@link audioFileUrl} 按 preset+file 兜底拼 */
  url: string;
}

/**
 * /api/audio 的响应体（preset 必填且过 PRESET_ID_RE，否则 400——与 /api/assets 同款）。
 * 剧本没有 audio 目录时是空数组（不报错）。
 */
export interface AudioResponse {
  items: AudioItem[];
}

/** /api/worlds 返回的单条世界线（与 server listWorlds 对齐；chapterNo/lastPlayed 由磁盘自愈） */
export interface WorldEntry {
  /** 世界 id（`state/worlds/<worldId>/`） */
  worldId: string;
  /** 所属剧本 id */
  preset: string;
  /** 剧本标题（建世界时从 preset 抄录） */
  title: string;
  /** 当前章号（读自 story-tree.md，读不到回退索引记录） */
  chapterNo: number;
  /** 最近游玩时间（ms；取三份文件最新 mtime） */
  lastPlayed: number;
  /** 显示名/备注（分叉世界自动写「分叉自 <世界> @ <节点>」） */
  note: string;
  /** 显示用名（v1.6 POST update 写入，≤60 字；空串=未设置，UI 回退 note/id） */
  label?: string;
  /** 分叉来源（非分叉世界为 null） */
  forkedFrom: { worldId: string; nodeId: string } | null;
  /** 目录是否存在（索引记录但目录被删时为 false） */
  exists: boolean;
}

/**
 * 逐轮快照的元信息（v1.6）：`state/worlds/<worldId>/history/NNNN.json` 的头部字段。
 * 快照 append-only，seq 从 1 起递增（> 9999 后服务端不再写并 warn once）。
 */
export interface WorldSnapshotMeta {
  seq: number;
  /** 写入时刻（ISO 字符串） */
  at: string;
  /** turn=正戏回合的自动快照；backup=回退前自动备份的当前状态 */
  kind: "turn" | "backup";
  /** 该回合影的剧情树节点 id（解析不到为 null） */
  nodeId: string | null;
  /** 该回合的章号（读不到为 null） */
  chapterNo: number | null;
}

/** 快照三文件（缺失文件为 null；带 seq 查询才返回本字段） */
export interface SnapshotFiles {
  state: string | null;
  summary: string | null;
  tree: string | null;
}

/** 带全文的快照（GET /api/history?worldId=&seq= 附 files） */
export interface WorldSnapshot extends WorldSnapshotMeta {
  files: SnapshotFiles;
}

/** GET /api/history?worldId=<id> 的响应（snapshots 升序） */
export interface HistoryResponse {
  worldId: string;
  snapshots: WorldSnapshotMeta[];
}

/**
 * `# 剧情状态` 小节（v1.7 角色面板）：preset/周目/时间/场景的固定键。
 * 引擎（LLM）维护的 state.md 字段可缺——缺的键为 null，客户端按「有没有」渲染。
 */
export interface StateStatus {
  preset: string | null;
  /** 周目（引擎写非整数时为 null） */
  playthrough: number | null;
  time: string | null;
  scene: string | null;
}

/** 角色面板的单张角色卡（`# 角色卡` 的 `## <角色名>` 子节；缺的字符串字段是空串） */
export interface StateCharacter {
  name: string;
  /** 身份 */
  role: string;
  /** 性格关键词 */
  traits: string;
  /** 口癖 */
  catchphrase: string;
  /** 好感度 0-100（服务端夹过界；引擎写了非整数时为 null） */
  favor: number | null;
  /** art_file（立绘落盘路径，未生成为空串） */
  artFile: string;
  /** 当前差分变体名（基础立绘为空串） */
  expression: string;
  /** 秘密原文（引擎写「无」表示没有秘密，是否折叠由组件判断） */
  secret: string;
  /** 最近互动一句话 */
  recentInteraction: string;
}

/**
 * GET /api/state?worldId= 的响应（v1.7 角色面板）：世界 state.md 的容错解析视图。
 * `protagonist`/`director` 是键值原样收录（引擎可自由加字段）；`flags`/`foreshadowing` 是列表；
 * 解析侧绝不抛错——缺小节/乱序/越界一律静默缺省（见 docs/ARCHITECTURE.md「角色面板」）。
 */
export interface StateView {
  worldId: string;
  status: StateStatus;
  /** `# 主角` 的键值行（姓名/性别/身份/出身/特质…，引擎可自由加） */
  protagonist: Record<string, string>;
  /** `# 导演手记` 的键值行（张力/本场景目标/下一节拍/玩家画像/NPC 场外进度…） */
  director: Record<string, string>;
  characters: StateCharacter[];
  flags: { name: string; value: string }[];
  /** 未回收伏笔（`turn` 来自行尾「埋于第 N 轮」，缺省 null） */
  foreshadowing: { text: string; turn: number | null }[];
}

/** GET /api/history?worldId=<id>&seq=<n> 的响应（条目附 files；服务端可能仍返回整列，调用方自行取目标 seq） */
export interface SnapshotResponse {
  worldId: string;
  snapshots: WorldSnapshot[];
}

/** 世界线导出包（GET /api/worlds/export 体；POST import 原样回传） */
export interface WorldBundle {
  format: "bunkiten-world";
  version: 1;
  /** 导出时刻（ISO 字符串） */
  exportedAt: string;
  world: {
    worldId: string;
    preset: string;
    title: string;
    label: string;
    note: string;
    chapterNo: number;
    files: SnapshotFiles;
    snapshots: WorldSnapshot[];
  };
}

/** POST /api/worlds 的动作（create=新建 / fork=在节点分叉 / delete=删除 / update=改标签 / restore=精确回退 / import=导入世界线） */
export type WorldAction =
  | { action: "create"; preset: string }
  | { action: "fork"; worldId: string; nodeId: string; seq?: number }
  | { action: "delete"; worldId: string }
  | { action: "update"; worldId: string; label?: string; note?: string }
  | { action: "restore"; worldId: string; seq: number }
  | { action: "import"; bundle: WorldBundle };

/** POST /api/worlds 的响应（失败在 error 里，不抛错；restore 额外回备份 seq，import 回分配到的 worldId） */
export interface WorldPostResult {
  ok: boolean;
  worldId?: string;
  entry?: WorldEntry;
  /** restore 先写的那条 kind:"backup" 快照的 seq */
  backupSeq?: number;
  error?: string;
}

/** /events 推送的回合事件（与 server broadcast 结构对齐） */
export type AcpEvent =
  | { type: "turn_start" }
  | { type: "seg"; seg: number; label: string }
  | { type: "chunk"; seg: number; text: string }
  | { type: "turn_end" }
  | { type: "error"; message: string }
  | { type: "expression"; character: string; variant: string }
  | { type: "presetAdded"; id: string }
  | { type: "treeEdited"; note: string }
  /** v1.6 【曲】/【环境】/【音效】协议行（单独成段、不进正文；文件缺失由客户端静默 no-op） */
  | { type: "audio"; kind: AudioKind; name: string };

/** @returns {Promise<{loggedIn: boolean}>} grok CLI 登录态（~/.grok/auth.json 存在性） */
export async function fetchAuth(): Promise<{ loggedIn: boolean }> {
  const r = await fetch("/api/auth");
  if (!r.ok) throw new Error(`GET /api/auth -> HTTP ${r.status}`);
  return (await r.json()) as { loggedIn: boolean };
}

/**
 * @param {AbortSignal} [signal] 组件卸载时取消
 * @returns {Promise<PresetsResponse>} presets + 解析失败的目录
 * @throws HTTP 非 200 时带上下文抛错
 */
export async function fetchPresets(signal?: AbortSignal): Promise<PresetsResponse> {
  const r = await fetch("/api/presets", { signal });
  if (!r.ok) throw new Error(`GET /api/presets -> HTTP ${r.status}`);
  return (await r.json()) as PresetsResponse;
}

/**
 * 某个剧本的持久化美术清单（制作中屏据此跳过已就绪项，画廊按剧本分组）。
 * @param {string} preset 剧本 id（v1.5.1 起服务端要求，缺失或非法即 400）
 * @param {AbortSignal} [signal] 取消
 * @returns {Promise<AssetEntry[]>} 该剧本已落盘的立绘/背景/封面
 * @throws HTTP 非 200 时带上下文抛错
 */
export async function fetchAssets(preset: string, signal?: AbortSignal): Promise<AssetEntry[]> {
  const r = await fetch(`/api/assets?preset=${encodeURIComponent(preset)}`, { signal });
  if (!r.ok) throw new Error(`GET /api/assets -> HTTP ${r.status}`);
  return (await r.json()) as AssetEntry[];
}

/**
 * 世界线清单（世界线屏据此渲染；chapterNo/lastPlayed 由 server 从磁盘自愈）。
 * @param {string} [preset] 只看某个剧本的世界（世界线屏按选中的卡过滤）
 * @param {AbortSignal} [signal] 取消
 * @returns {Promise<WorldEntry[]>} 世界列表（最近游玩优先）
 * @throws HTTP 非 200 时抛错
 */
export async function fetchWorlds(preset?: string, signal?: AbortSignal): Promise<WorldEntry[]> {
  const q = preset ? `?preset=${encodeURIComponent(preset)}` : "";
  const r = await fetch(`/api/worlds${q}`, { signal });
  if (!r.ok) throw new Error(`GET /api/worlds -> HTTP ${r.status}`);
  const data = (await r.json()) as { worlds?: WorldEntry[] };
  return data.worlds ?? [];
}

/**
 * 世界线管理动作（新建 / 在节点分叉 / 删除 / 改标签 / 精确回退 / 导入）。分叉本身不推演任何内容——
 * 新世界只带树与回退进度；有快照时服务端以快照三文件精确建世界（兼容路径仍是复制当前文件 + forkNote）。
 * @param {WorldAction} body 动作负载
 * @returns {Promise<WorldPostResult>} 失败在 error 里返回，不抛错
 */
export async function postWorld(body: WorldAction): Promise<WorldPostResult> {
  const r = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as WorldPostResult;
  return { ...data, ok: r.ok && data.ok !== false };
}

/**
 * 改世界线的显示名/备注（世界线管理用）。
 * @param {{worldId: string; label?: string; note?: string}} p label ≤60 字、note ≤200 字；空串=清除该字段
 * @returns {Promise<WorldPostResult>} 失败在 error 里返回，不抛错
 */
export async function postWorldUpdate(p: { worldId: string; label?: string; note?: string }): Promise<WorldPostResult> {
  return postWorld({ action: "update", ...p });
}

/**
 * 精确回退到某个快照：服务端先写一条 `kind:"backup"` 的当前状态快照，再覆盖为目标快照的 state/summary/tree。
 * @param {{worldId: string; seq: number}} p 目标世界与快照序号
 * @returns {Promise<WorldPostResult>} 成功时 backupSeq = 回退前那条备份的 seq
 */
export async function postWorldRestore(p: { worldId: string; seq: number }): Promise<WorldPostResult> {
  return postWorld({ action: "restore", ...p });
}

/**
 * 世界线导出包下载地址（浏览器直接开或喂给 <a download>；服务端带 Content-Disposition）。
 * @param {string} worldId 世界 id
 * @returns {string} 相对 URL（`/api/worlds/export?worldId=…`）
 */
export function worldExportUrl(worldId: string): string {
  return `/api/worlds/export?worldId=${encodeURIComponent(worldId)}`;
}

/**
 * 导入世界线包（服务端校验 format/version/worldId；重名改 <id>-2、-3…，note 追加「（导入）」）。
 * @param {WorldBundle} bundle 导出包原文（原样回传，前端不改结构）
 * @returns {Promise<WorldPostResult>} 成功时 worldId = 实际落盘的（可能改名后的）世界 id
 */
export async function postWorldImport(bundle: WorldBundle): Promise<WorldPostResult> {
  return postWorld({ action: "import", bundle });
}

/**
 * 剧本导出包（v1.7，GET /api/presets/export 体；POST /api/presets import 原样回传）。
 * preset.md 全文 + 资产（含 cover.jpg 键）与音频的 base64 内容；文件名安全与 base64 校验都在服务端。
 */
export interface PresetBundle {
  format: "bunkiten-preset";
  version: 1;
  id: string;
  title: string;
  exportedAt: string;
  presetMd: string;
  /** 文件名 → base64（键含 cover.jpg；导入时封面落 preset 根、其余落 assets/） */
  assets: Record<string, string>;
  /** 文件名 → base64（扩展名白名单以 server 的 AUDIO_EXTS 为准；导入落 audio/） */
  audio: Record<string, string>;
}

/** POST /api/presets {action:"import"} 的响应（成功回实际落地的剧本 id——可能已重名改名） */
export interface PresetImportResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * 剧本导出包下载地址（浏览器直接开或喂给 <a download>；服务端带 Content-Disposition）。
 * @param {string} id 剧本 id
 * @returns {string} 相对 URL（`/api/presets/export?id=…`）
 */
export function presetExportUrl(id: string): string {
  return `/api/presets/export?id=${encodeURIComponent(id)}`;
}

/**
 * 导入剧本包（服务端校验 format/version/id/presetMd 与文件名安全；重名改 <id>-2、-3…）。
 * 注意这条端点的 body 上限是 50MB（包里是 base64 图片/音频），不是其余 POST 的 5MB。
 * @param {PresetBundle} bundle 导出包原文（原样回传，前端不改结构）
 * @returns {Promise<PresetImportResult>} 成功时 id = 实际落盘的（可能改名后的）剧本 id
 */
export async function postPresetImport(bundle: PresetBundle): Promise<PresetImportResult> {
  const r = await fetch("/api/presets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "import", bundle }),
  });
  const data = (await r.json().catch(() => ({}))) as PresetImportResult;
  return { ...data, ok: r.ok && data.ok !== false };
}

/**
 * 删除一条已落盘的素材（画廊批量删除用）。
 * @param {{preset: string; file: string}} p preset 剧本 id；file 接受画廊条目的完整相对路径
 *   （`presets/<id>/assets/<名>.jpg`），内部收敛为单层文件名——服务端只受理该形态（封面不在受理范围）
 * @returns {Promise<{ok: boolean; error?: string}>} 文件不存在（404）等失败在 error 里返回，不抛错
 */
export async function postAssetDelete(p: { preset: string; file: string }): Promise<{ ok: boolean; error?: string }> {
  // 服务端只受理单层文件名（ASSET_DELETE_FILE_RE 防穿越，见 ARCHITECTURE「素材删除」契约）；
  // 画廊条目的 file 是完整相对路径（presets/<id>/assets/<名>.jpg），在 HTTP 边界收敛为 basename
  const name = p.file.split(/[\\/]/).pop() ?? p.file;
  const r = await fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete", preset: p.preset, file: name }),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: r.ok && data.ok !== false, error: data.error || (r.ok ? undefined : `HTTP ${r.status}`) };
}

/**
 * 剧情树原文（剧情图屏解析用；解析失败屏内回退显示原文）。
 * @param {string} worldId 世界 id
 * @param {AbortSignal} [signal] 取消
 * @returns {Promise<{worldId: string; markdown: string}>} 树文件全文
 * @throws 世界没有树文件时抛错（HTTP 404）
 */
export async function fetchTree(worldId: string, signal?: AbortSignal): Promise<{ worldId: string; markdown: string }> {
  const r = await fetch(`/api/tree?worldId=${encodeURIComponent(worldId)}`, { signal });
  if (!r.ok) throw new Error(`GET /api/tree -> HTTP ${r.status}`);
  return (await r.json()) as { worldId: string; markdown: string };
}

/**
 * 角色面板数据（v1.7）：世界 state.md 的容错解析视图。
 * @param {string} worldId 世界 id
 * @param {AbortSignal} [signal] 取消
 * @returns {Promise<StateView>} 解析视图（缺小节/乱序由服务端静默缺省，形状恒完整）
 * @throws 世界没有 state.md（404）或 HTTP 非 200 时抛错；调用方（角色面板）捕获后走空态文案
 */
export async function fetchState(worldId: string, signal?: AbortSignal): Promise<StateView> {
  const r = await fetch(`/api/state?worldId=${encodeURIComponent(worldId)}`, { signal });
  if (!r.ok) throw new Error(`GET /api/state -> HTTP ${r.status}`);
  return (await r.json()) as StateView;
}

/**
 * 快照索引（逐轮回退列表）：只要元信息，不含三文件全文（列表页用）。
 * @param {string} worldId 世界 id
 * @param {AbortSignal} [signal] 取消
 * @returns {Promise<HistoryResponse>} snapshots 升序（seq 从小到大）；没有快照是空数组
 * @throws HTTP 非 200 时带上下文抛错
 */
export async function fetchHistory(worldId: string, signal?: AbortSignal): Promise<HistoryResponse> {
  const r = await fetch(`/api/history?worldId=${encodeURIComponent(worldId)}`, { signal });
  if (!r.ok) throw new Error(`GET /api/history -> HTTP ${r.status}`);
  return (await r.json()) as HistoryResponse;
}

/**
 * 单个快照的全文（含 state/summary/tree 三文件；用于预览与「以此重建」）。
 * 服务端在带 seq 时给条目附 files（可能仍返回整列，故这里按 seq 取目标项，不假设只回一条）。
 * @param {string} worldId 世界 id
 * @param {number} seq 快照序号（history 索引里的 seq）
 * @param {AbortSignal} [signal] 取消
 * @returns {Promise<WorldSnapshot>} 目标快照（含 files）
 * @throws HTTP 非 200、或响应里没有该 seq 时抛错（屏内提示「快照已不存在」）
 */
export async function fetchSnapshot(worldId: string, seq: number, signal?: AbortSignal): Promise<WorldSnapshot> {
  const r = await fetch(`/api/history?worldId=${encodeURIComponent(worldId)}&seq=${encodeURIComponent(String(seq))}`, {
    signal,
  });
  if (!r.ok) throw new Error(`GET /api/history?seq=${seq} -> HTTP ${r.status}`);
  const data = (await r.json()) as SnapshotResponse;
  const hit = (data.snapshots ?? []).find((s) => s.seq === seq);
  if (!hit) throw new Error(`快照 ${seq} 不在世界 ${worldId} 的历史里`);
  return hit;
}

/**
 * 当前剧本的音频索引（目录 `presets/<id>/audio/`，命名 `<类型>-<名>.<ext>`）。
 * @param {string} presetId 剧本 id（服务端要求必填，缺失/非法即 400）
 * @param {AbortSignal} [signal] 取消
 * @returns {Promise<AudioItem[]>} 磁盘上已存在的音频；剧本没有 audio 目录时是空数组
 * @throws HTTP 非 200 时带上下文抛错（调用方 AudioManager 捕获后静默——没有音频也能玩）
 */
export async function fetchAudio(presetId: string, signal?: AbortSignal): Promise<AudioItem[]> {
  const r = await fetch(`/api/audio?preset=${encodeURIComponent(presetId)}`, { signal });
  if (!r.ok) throw new Error(`GET /api/audio -> HTTP ${r.status}`);
  const data = (await r.json()) as AudioResponse;
  return data.items ?? [];
}

/**
 * 发送一条玩家输入/指令给引擎，回合经 /events 流回。
 * @param {string} text 玩家文本（选项正文、自由输入或 /命令）
 * @returns {Promise<{ok: boolean; error: string}>} 409（上一回合进行中）等失败在此返回，不抛错
 */
export async function postPrompt(text: string): Promise<{ ok: boolean; error: string }> {
  const r = await fetch("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: r.ok && data.ok !== false, error: data.error || `HTTP ${r.status}` };
}

/**
 * `&preset=<id>` 片段（v1.5.1：资产按剧本分组，服务端据此定位落盘目录）。
 * preset 为空（无剧本上下文）时省略，服务端回退其 currentPresetId。
 */
function presetQuery(preset: string): string {
  return preset ? `&preset=${encodeURIComponent(preset)}` : "";
}

/**
 * 图片服务 URL：p 必须是标记里的原始路径——新生成是会话路径 `images/N.jpg`，缓存命中是
 * `presets/<id>/assets/….jpg`，原样透传由服务端解析；t/n 为类型与名字，preset 告诉服务端当前剧本。
 * @param {string} path 标记里的原始路径
 * @param {"portrait" | "background"} kind 标记类型
 * @param {string} name 标记里的名字
 * @param {string} preset 当前剧本 id
 * @returns {string} 可直接用于 <img>/background-image 的相对 URL
 */
export function imageUrl(path: string, kind: "portrait" | "background", name: string, preset: string): string {
  const t = kind === "portrait" ? "立绘" : "背景";
  const q = `p=${encodeURIComponent(path)}&t=${encodeURIComponent(t)}&n=${encodeURIComponent(name)}`;
  return `/img?${q}${presetQuery(preset)}`;
}

/**
 * 当前剧本的永久层图片 URL：按「类型+名字+剧本」命中（无需会话内路径），
 * 制作中屏预过滤出的已就绪项与立绘兜底图用它直接显示。
 * @param {"portrait" | "background"} kind 标记类型
 * @param {string} name 立绘角色名或背景地点名（须与资产落盘名一致）
 * @param {string} preset 当前剧本 id
 * @returns {string} 可直接用于 <img> 的相对 URL
 */
export function assetUrl(kind: "portrait" | "background", name: string, preset: string): string {
  const t = kind === "portrait" ? "立绘" : "背景";
  return `/img?t=${encodeURIComponent(t)}&n=${encodeURIComponent(name)}${presetQuery(preset)}`;
}

/**
 * 资产名 sanitize：与 server persistAsset 同规则（文件名非法字符 → _），保证前端构造的
 * 变体/预过滤 URL 与实际落盘名一致。
 */
export function sanitizeAssetName(name: string): string {
  return name.replace(/[\\/:*?"<>|「」『』\r\n\t]/g, "_").trim() || "unnamed";
}

/**
 * 资产相对路径（**路径契约的唯一来源**）：`presets/<剧本 id>/assets/<类型>-<名>.jpg`，
 * 与 server `assetRelPath` 同形（封面是 `presets/<id>/cover.jpg`，走 {@link coverUrl}，不在此列）。
 * 名字先过 {@link sanitizeAssetName}（与 server `persistAsset` 同规则）——调用方直接传清单/标记里的原始名即可，
 * 不要再各自 sanitize：同一契约在两处实现就是路径漂移的起点。
 * @param {"立绘" | "背景"} type 资产类型（协议字面）
 * @param {string} name 资产名：立绘=角色名[-变体]（差分形如 `薇拉-微笑`）、背景=地点名
 * @param {string} preset 剧本 id；为空（无剧本上下文）时返回空串，调用方**必须回退**（改用 imageUrl/assetUrl 之类，
 *   别把空串拼进 URL 变成 `presets//assets/…` 或 `/img?p=`）
 * @returns {string} 相对 server 根的落盘路径；preset 为空时为空串
 */
export function assetPath(type: "立绘" | "背景", name: string, preset: string): string {
  if (!preset) return "";
  return `presets/${preset}/assets/${type}-${sanitizeAssetName(name)}.jpg`;
}

/**
 * 已落盘文件的直服 URL（/img 白名单：presets/<id>/assets/*.jpg 与 presets/<id>/cover.jpg）。
 * 差分立绘与封面走这里；v 为破缓存戳（重绘覆盖同名文件后换图）。
 * @param {string} file 相对 server 根的落盘路径（presets/rift-mark/assets/立绘-薇拉-微笑.jpg 等）
 * @param {string | number} [v] 破缓存参数（mtime 或时间戳）
 * @returns {string} 可直接用于 <img> 的相对 URL
 */
export function assetFileUrl(file: string, v?: string | number): string {
  const base = `/img?p=${encodeURIComponent(file)}`;
  return v === undefined ? base : `${base}&v=${v}`;
}

/**
 * 剧本封面 URL（presets/<id>/cover.jpg，随 preset 目录分发）。
 * @param {string} presetId 剧本 id（kebab-case）
 * @returns {string} 可直接用于 <img> 的相对 URL（404 时由调用方回退主题渐变）
 */
export function coverUrl(presetId: string): string {
  return assetFileUrl(`presets/${presetId}/cover.jpg`);
}

/**
 * 音频直服 URL（v1.6）：服务端 `/audio?p=<相对路径>`（白名单 `presets/<id>/audio/<类型>-<名>.<ext>`）。
 * `/api/audio` 已经给了 url，这里只是兜底与「按名构造」的单一入口（AudioManager 建索引时用它）。
 * @param {string} presetId 剧本 id（file 只给文件名时用来补全目录）
 * @param {string} file 相对 server 根的路径（`presets/<id>/audio/曲-雨夜.mp3`）或裸文件名（`曲-雨夜.mp3`）
 * @returns {string} 可直接喂给 <audio>.src 的相对 URL
 */
export function audioFileUrl(presetId: string, file: string): string {
  const path = file.includes("/") ? file : `presets/${presetId}/audio/${file}`;
  return `/audio?p=${encodeURIComponent(path)}`;
}

/**
 * 订阅 SSE 回合事件流（EventSource 断线自动重连）。
 * @param {(e: AcpEvent) => void} onEvent 事件回调
 * @returns {() => void} 取消订阅（关闭连接）
 */
export function subscribeEvents(onEvent: (e: AcpEvent) => void): () => void {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as AcpEvent);
    } catch {
      // 非 JSON 帧只可能是连接建立初期的 retry 注释之类，忽略
    }
  };
  return () => es.close();
}
