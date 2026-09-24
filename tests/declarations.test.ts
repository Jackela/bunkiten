// 「手写类型声明 ↔ 运行时真源」的一致性门禁（v1.13 新增）。
//
// 背景：shared/ 下三对 `.mjs` + `.d.mts` 是**手工镜像**——`tsc -b` 按 `.mjs` → `.d.mts` 解析，
// 但**从不比对两者**（它不是 diff 工具，只是把声明文件当类型来源）。于是在这条门禁出现之前：
//   · `.mjs` 里加/改一个导出、忘了补 `.d.mts` → `src/**` 编译期看不见它，运行时才炸；
//   · `.d.mts` 里写了一个 `.mjs` 并不存在的导出 → 编译器放行，运行时 undefined。
// 三份文件此前在 tests/** 里**零引用**（grep `d.mts` 无命中），也就没有任何自动化守着这件事。
//
// 口径边界（写清楚，免得读的人高估它）：
//   · 只守**值导出**（const/function/class）——它们在运行时存在，可以逐个对；
//   · `interface` / `type` 是纯类型，运行时不可见，本文件只能确认它们被声明了，验不了形状；
//   · 形状漂移（把 `readonly string[]` 写成 `string[]`、可选键写错）本门禁**管不到**，
//     那部分靠契约 lint 的运行时取值断言（tests/contract.test.ts ①⑤⑦⑧ 组）覆盖。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as protocol from "../shared/protocol.mjs";
import * as providers from "../shared/providers.mjs";
import * as engines from "../shared/engines.mjs";
import * as theme from "../shared/theme.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 手写声明与运行时真源的配对（新增一对就往这里加一行）。
 * 用静态 import 而不是模板字符串动态 import：vite 对动态导入有「只能下探一层」的限制，
 * 且静态写法让「到底比了哪几个模块」在源码里一眼可见。
 */
const PAIRS: Array<{ rel: string; mod: Record<string, unknown> }> = [
  { rel: "shared/protocol", mod: protocol as Record<string, unknown> },
  { rel: "shared/providers", mod: providers as Record<string, unknown> },
  { rel: "shared/engines", mod: engines as Record<string, unknown> },
  { rel: "shared/theme", mod: theme as Record<string, unknown> },
];

/** 从 `.d.mts` 源码里抓出各类导出的名字（按类分开，值导出与纯类型导出口径不同） */
function declaredExports(source: string): { values: Set<string>; types: Set<string> } {
  const values = new Set<string>();
  const types = new Set<string>();
  for (const m of source.matchAll(/^export\s+(const|function|class)\s+([A-Za-z_$][\w$]*)/gm)) values.add(m[2]);
  for (const m of source.matchAll(/^export\s+(interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) types.add(m[2]);
  // `export { A, B }` 形态（本仓当前没有，但写全免得日后加了它却漏掉）
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const piece of m[1].split(",")) {
      const name = piece
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) values.add(name);
    }
  }
  return { values, types };
}

describe("手写类型声明 ↔ 运行时真源：shared/*.d.mts 的导出面一致性", () => {
  for (const { rel, mod } of PAIRS) {
    it(`${rel}.d.mts 与 ${rel}.mjs 的导出名逐项对齐（值导出双向；类型导出只查声明）`, () => {
      const runtimeNames = Object.keys(mod).filter((k) => k !== "default");
      const decl = declaredExports(readFileSync(path.join(ROOT, `${rel}.d.mts`), "utf8"));
      const declaredValueNames = [...decl.values];

      // ① 运行时有的，声明里必须有：漏了 → TS 侧「没有这个导出」，而 JS 侧明明有（src/** 编译期看不见真源）
      const missingInDecl = runtimeNames.filter((n) => !decl.values.has(n));
      expect(
        missingInDecl,
        `${rel}.d.mts 少了这些**运行时存在**的导出：${missingInDecl.join("、")}。` +
          `它们活在 .mjs 里，但 src/** 按 .d.mts 解析——漏声明的后果是编译期看不见、运行时才炸。` +
          `（当前 .mjs 有 ${runtimeNames.length} 个导出、声明里值导出 ${declaredValueNames.length} 个）`,
      ).toEqual([]);

      // ② 声明里承诺的值导出，运行时必须有：凭空写着 → 编译器放行、运行时 undefined
      const missingInRuntime = declaredValueNames.filter((n) => !(n in mod));
      expect(
        missingInRuntime,
        `${rel}.d.mts 声明了这些**运行时并不存在**的导出：${missingInRuntime.join("、")}。` +
          `编译器会照它放行（import 成功、类型齐全），运行时拿到 undefined——这是最难查的一类假绿。`,
      ).toEqual([]);

      // ③ 类型导出（interface/type）只在声明里存在：运行时不可见，本门禁只确认"声明了"这件事不空
      expect(
        decl.types.size + decl.values.size,
        `${rel}.d.mts 一个导出都没解析到——要么文件被清空了，要么本文件的正则跟不上它的写法（门禁空跑等于没有门禁）`,
      ).toBeGreaterThan(0);
    });
  }
});
