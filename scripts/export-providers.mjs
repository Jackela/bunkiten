// 生成服务目录发布源 docs/providers.json（v1.10，docs/adr/0020）。
//
// 唯一真源是 shared/providers.mjs 的 PROVIDERS——本脚本只做「搬不改」：把它序列化成
// `{version, updatedAt, providers}` 写进仓库的 docs/providers.json。那份 JSON 是**发布源**：
// 服务端启动时经 jsDelivr / GitHub raw 抓它（server/providers-catalog.mjs），玩家的设置屏下拉就吃到了新目录。
//
// 用法：`npm run providers:export`（改了 shared/providers.mjs 就顺手跑一次并提交 docs/providers.json）。
// 契约 lint（tests/contract.test.ts ⑦ 组）断言这份 JSON 的 providers 与 PROVIDERS 深等——手改 JSON 会被红。
// 零依赖：与 server/ 树同款，只用 node 内置模块。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PROVIDERS } from "../shared/providers.mjs";
import { CATALOG_VERSION } from "../server/providers-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "providers.json");

// JSON 往返一次：丢掉 undefined 的可选键（imageModels/note 缺省时不出现在文件里），
// 与契约 lint 的 `toEqual(PROVIDERS)` 比对口径一致。
const providers = JSON.parse(JSON.stringify(PROVIDERS));
const doc = { version: CATALOG_VERSION, updatedAt: new Date().toISOString(), providers };

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`[providers] ${path.relative(ROOT, OUT)} 已生成：${providers.length} 条服务（updatedAt ${doc.updatedAt}）`);
