// 资产注册表与落盘（v1.13 从入口的 startServer 闭包拆出）：**「哪个资产已就绪」这份记账 + 落盘判定**。
//
// 为什么拆它：那块闭包 650+ 行、装着七件事，而资产这一摊自己有完整的内部状态（注册表、
// 「拿不到剧本」与「旧档路径」两个告警去重集）与明确的对外面（落盘、画廊清单、旧档提示）。
// 拆出来的另一个好处是**迭代纪律终于和迭代对象住在一起**：注册表在遍历中被删（同名未就绪项）这件事，
// 之前散在三个函数的注释里，现在只有本模块知道。
//
// 它不认识「回合」：不读 turnText、不管 busy——流式扫描（哪一行是协议行）住在 server/turn-pipeline.mjs，
// 这里只回答「给我一条【图】/一次 /img 命中，该落到哪、落没落成」。会话图片的定位由调用方注入
// （`resolveImage`：那是 ACP 会话的事，见 server/acp.mjs）。
import fs from "fs";
import path from "path";
import { GAME_ROOT, WORLDS_ROOT } from "./config.mjs";
import {
  ASSET_FILE_RE,
  mtimeOf,
  presetAssetsDir,
  presetIdFromPath,
  resolvePersistPreset,
  sanitizeAssetName,
  splitAssetVariant,
} from "./assets.mjs";
import { assetTargetFile, scanPresets } from "./presets.mjs";
import { readWorldsIndex } from "./worlds.mjs";

/**
 * 资产流水线的对外面（入口拿到它之后转手给路由链与回合流水线）。
 * @typedef {object} AssetPipeline
 * @property {(type: string, rawName: string, srcRel: string, regen?: boolean, presetId?: string) => boolean} persistAsset
 *   【图】标记的落盘（拿不到剧本时为占位条目并返回 false）
 * @property {(type: string, rawName: string, src: string, presetId?: string, srcRel?: string) => boolean} persistAssetFromFile
 *   /img 从会话命中时顺手落盘（src 是绝对路径）
 * @property {(presetId: string) => Array<object>} listAssets 画廊清单（磁盘为准 + registry 补未落盘项）
 * @property {() => number} retryPendingWithOwnPreset 未就绪条目按各自记着的剧本重试（回合末补扫）
 * @property {(presetId: string) => number} retryPendingWithPreset 【新剧本】<id> 的补落盘重试
 * @property {(rel: string) => void} warnLegacyPathOnce 旧档路径提示（同一路径只提示一次）
 */

/**
 * 造一套资产流水线。
 * @param {{resolveImage: (name: string) => string|null}} ctx
 *   `resolveImage`：会话图片定位（相对名 → 绝对路径；找不到回 null）——由入口接上 ACP 会话的实现。
 * @returns {AssetPipeline} 流水线（各方法的语义见上面的 typedef 与各自文档）
 */
export function createAssetPipeline({ resolveImage }) {
  /**
   * 注册表：`<剧本 id>|type|sanitizedName` → 条目。磁盘真况见 {@link listAssets}。
   * @typedef {Object} AssetEntry
   * @property {string} type 立绘 | 背景 | 封面
   * @property {string} name sanitize 后的名字（差分形如 `薇拉-微笑`）
   * @property {string} rawName 标记里的原始名
   * @property {string} presetId 落盘剧本 id（拿不到剧本的占位条目为空串）
   * @property {string} file 落盘目标相对路径（占位条目为空串）
   * @property {string} srcRel 标记里的原始路径
   * @property {boolean} ready 目标文件是否已就绪
   * @property {boolean} [regen] 第四段「重绘」：覆盖同名文件
   */
  /** @type {Map<string, AssetEntry>} */
  const assetRegistry = new Map();

  // 「拿不到剧本」告警去重（同一 key 只警告一次）：回合末补扫、每条 /img 预载都会反复走到同一资产，
  // 不去重会把控制台刷爆，真正的告警反而看不见。
  const warnedPresetless = new Set();
  /** @param {string} type @param {string} name sanitize 后的名字 @param {string} rawName 标记里的原始名 */
  function warnPresetlessOnce(type, name, rawName) {
    const key = `${type}|${name}`;
    if (warnedPresetless.has(key)) return;
    warnedPresetless.add(key);
    console.warn(`[acp] 拿不到当前剧本，暂不落盘（等【新剧本】或带 &preset= 的请求补落）: ${type}|${rawName}`);
  }
  // 旧档路径提示去重（预载/轮播会反复命中同一条老路径）
  const warnedLegacyPaths = new Set();
  /** @param {string} rel 旧档相对路径 */
  function warnLegacyPathOnce(rel) {
    if (warnedLegacyPaths.has(rel)) return;
    warnedLegacyPaths.add(rel);
    console.warn(`[acp] 请求了旧档资产路径（v1.5 之前的全局 assets/ 格式），只按当前剧本目录直服: ${rel}`);
  }

  /**
   * 落盘一个资产（流式【图】标记与回合末补扫共用）。
   * 目标随剧本走：presets/<剧本 id>/assets/<类型>-<名>.jpg（封面 presets/<id>/cover.jpg）。
   * 剧本 id 只认「调用方显式传入」或「标记路径自带 presets/<id>/…」（resolvePersistPreset），
   * **不回退 currentPresetId**（B1）：创作模式装配新剧本时 currentPresetId 还是上一局的剧本，
   * 一退回就会把新剧本的立绘写进旧剧本的 assets 目录。
   * 拿不到剧本时不落盘，registry 留 ready:false 占位（同一 key 只告警一次），
   * 等【新剧本】<id> 标记（{@link retryPendingWithPreset}）或带 &preset= 的 /img 请求补落。
   * @param {string} type 立绘 | 背景 | 封面
   * @param {string} rawName 标记里的原始名（角色名/地点名/剧本标题）
   * @param {string} srcRel 标记里的原始路径（images/N.jpg 或 presets/<id>/assets/…）
   * @param {boolean} [regen] 第四段「重绘」：覆盖同名文件
   * @param {string} [presetId] 调用方解析出的剧本 id（【新剧本】补落盘会显式给出新剧本 id）
   * @returns {boolean} 目标文件是否已就绪
   */
  function persistAsset(type, rawName, srcRel, regen = false, presetId = "") {
    const name = sanitizeAssetName(rawName);
    const { presetId: pid } = resolvePersistPreset({ queryPreset: presetId, srcRel });
    const file = assetTargetFile(type, rawName, pid || "");
    if (!file) {
      const key = `${pid || ""}|${type}|${name}`;
      const entry = assetRegistry.get(key) || {
        type,
        name,
        rawName,
        presetId: pid || "",
        file: "",
        srcRel,
        ready: false,
      };
      entry.rawName = rawName;
      entry.srcRel = srcRel;
      entry.regen = regen;
      entry.ready = false;
      assetRegistry.set(key, entry);
      warnPresetlessOnce(type, name, rawName);
      return false;
    }
    const finalPid = presetIdFromPath(file) || pid || ""; // 封面按标题反查到的剧本也算数
    const key = `${finalPid}|${type}|${name}`;
    const abs = path.join(GAME_ROOT, file);
    const entry = assetRegistry.get(key) || { type, name, rawName, presetId: finalPid, file, srcRel, ready: false };
    entry.presetId = finalPid;
    entry.rawName = rawName;
    entry.srcRel = srcRel;
    entry.file = file;
    entry.regen = regen;
    if (regen || !fs.existsSync(abs)) {
      // 标记出现时图片文件应已生成（引擎先 image_gen 再输出标记）；当前会话没有就跨会话扫描
      const src = resolveImage(path.basename(srcRel));
      if (!src) {
        entry.ready = false;
        assetRegistry.set(key, entry);
        return false;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(src, abs);
    }
    entry.ready = true;
    assetRegistry.set(key, entry);
    // 清掉此前「拿不到剧本」留下的同名占位项（那些 key 里的剧本 id 是空串）
    for (const [k, e] of assetRegistry) {
      if (k !== key && !e.ready && e.type === type && e.name === name) assetRegistry.delete(k);
    }
    console.log(`[acp] asset persisted: ${file}`);
    return true;
  }

  /**
   * /img 从会话命中时顺手落盘（src 是绝对路径）。
   * 剧本 id 与 persistAsset 用同一套判定（resolvePersistPreset）：显式传入 → 来源路径解析 → 都不行就不落盘。
   * **不回退 currentPresetId**（B1）：调用方（/img 与【新剧本】补落盘）自己决定该用哪个剧本，判定只有一处。
   * @param {string} type 立绘 | 背景 | 封面
   * @param {string} rawName 标记里的原始名
   * @param {string} src 会话图片的绝对路径
   * @param {string} [presetId] 调用方解析出的剧本 id（不给即视为拿不到剧本）
   * @param {string} [srcRel] 原始来源路径（images/N.jpg 或 presets/<id>/assets/…，用于路径兜底解析）
   * @returns {boolean} 是否新落盘（目标已存在或拿不到剧本时为 false）
   */
  function persistAssetFromFile(type, rawName, src, presetId = "", srcRel = "") {
    const name = sanitizeAssetName(rawName);
    const { presetId: pid } = resolvePersistPreset({ queryPreset: presetId, srcRel });
    const file = assetTargetFile(type, rawName, pid || "");
    if (!file) {
      warnPresetlessOnce(type, name, rawName);
      return false;
    }
    const abs = path.join(GAME_ROOT, file);
    if (fs.existsSync(abs)) return false;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(src, abs);
    const finalPid = presetIdFromPath(file) || pid || "";
    assetRegistry.set(`${finalPid}|${type}|${name}`, {
      type,
      name,
      rawName,
      presetId: finalPid,
      file,
      srcRel,
      ready: true,
    });
    console.log(`[acp] asset persisted: ${file}`);
    return true;
  }

  /**
   * 把未就绪的占位条目按**各自记着的**剧本 id 重试一遍（回合末补扫用：
   * 图片文件可能晚于标记落盘，回合结束再试一次；剧本 id 一律用条目上记的——**不回退当前剧本**（B1））。
   * @returns {number} 重试了几条
   */
  function retryPendingWithOwnPreset() {
    let n = 0;
    // 这里的 `[...assetRegistry]` **不是**多余的 spread：persistAsset 会在迭代过程中 delete 注册表键
    // （同名未就绪项），直接遍历活 Map 会踩「边遍历边删」——先取一份快照才是对的。
    // oxlint-disable-next-line unicorn/no-useless-spread -- 见上：快照是语义的一部分
    for (const [, e] of [...assetRegistry]) {
      if (e.ready) continue;
      n += 1;
      persistAsset(e.type, e.rawName ?? e.name, e.srcRel, e.regen === true, e.presetId || "");
    }
    return n;
  }

  /**
   * 【新剧本】<id> 的补落盘：装配期【图】标记先到（那时还没人知道新剧本 id，这批条目的 presetId 是空串），
   * 标记后到就把它们**全部按新剧本 id** 重试一次——这批就是新剧本的美术。
   * @param {string} presetId 新剧本 id（调用方已用 PRESET_ID_RE 校验）
   * @returns {number} 重试了几条
   */
  function retryPendingWithPreset(presetId) {
    const pending = [...assetRegistry.values()].filter((e) => !e.ready);
    for (const e of pending) persistAsset(e.type, e.rawName ?? e.name, e.srcRel, e.regen === true, presetId);
    return pending.length;
  }

  /**
   * 某剧本的画廊数据：只扫该剧本的 assets/ 与封面（磁盘为准），registry 补尚未落盘的项。
   * variant 从文件名解析；inUse 只扫**该剧本的世界**（index.json 按 preset 过滤）的 state.md 是否含该名。
   * 资产随故事走，跨剧本不再串味——所以剧本 id 是必填参数。
   * @param {string} presetId 剧本 id（调用方已用 PRESET_ID_RE 校验）
   * @returns {Array<object>} 资产项列表
   */
  function listAssets(presetId) {
    /** @type {string[]} */
    const stateTexts = [];
    for (const e of readWorldsIndex(WORLDS_ROOT)) {
      if (e.preset !== presetId) continue;
      try {
        stateTexts.push(fs.readFileSync(path.join(WORLDS_ROOT, e.worldId, "state.md"), "utf8"));
      } catch {}
    }
    /** @param {string} name */
    const inUse = (name) => stateTexts.some((t) => t.includes(name));
    const out = new Map();
    /** @param {string} key @param {string} type @param {string} rest @param {string} file @param {boolean} ready */
    const push = (key, type, rest, file, ready) => {
      const { name, variant } = splitAssetVariant(rest);
      // preset 必填：客户端画廊按它做防御性过滤（跨剧本条目一律丢弃并告警）
      out.set(key, {
        type,
        name,
        variant,
        file,
        ready,
        preset: presetId,
        inUse: inUse(name),
        mtime: mtimeOf(path.join(GAME_ROOT, file)),
      });
    };
    try {
      for (const f of fs.readdirSync(presetAssetsDir(presetId))) {
        // 只认立绘/背景：封面不在 assets/ 里（契约是 presets/<id>/cover.jpg，另见下面那条），
        // `assets/封面-X.jpg` 是死路径，扫了只会给画廊塞进永远 404 的项。
        // 文件名正则取 shared 真源（ASSET_FILE_RE，由 ASSET_KINDS 构造）：落盘白名单与画廊扫描同一份
        const m = ASSET_FILE_RE.exec(f);
        // file 用**磁盘上的真实文件名**拼（v1.5 之前的素材可能是 .jpeg，硬拼 .jpg 会让画廊 404）
        if (m) push(`${m[1]}|${m[2]}`, m[1], m[2], `presets/${presetId}/assets/${f}`, true);
      }
    } catch {}
    try {
      // 封面随 preset 目录分发：presets/<id>/cover.jpg，name 用剧本标题
      const file = `presets/${presetId}/cover.jpg`;
      const preset = scanPresets().presets.find((p) => p.id === presetId);
      if (preset && fs.existsSync(path.join(GAME_ROOT, file)))
        push(`封面|${preset.title}`, "封面", preset.title, file, true);
    } catch {}
    for (const [, e] of assetRegistry) {
      if (e.presetId !== presetId) continue;
      const key = `${e.type}|${e.name}`; // 与磁盘扫描同键去重（registry 键含剧本 id）
      if (!out.has(key)) push(key, e.type, e.name, e.file, e.ready);
    }
    return [...out.values()];
  }

  return {
    persistAsset,
    persistAssetFromFile,
    listAssets,
    retryPendingWithOwnPreset,
    retryPendingWithPreset,
    warnLegacyPathOnce,
  };
}
