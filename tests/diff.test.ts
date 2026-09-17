// 快照对比的行级 diff 纯函数测试（v1.7）：diffLines（LCS，以 b 为目标：add=b 新增、remove=a 独有，
// 替换块 remove 在 add 前）与 diffStats（+N −M 摘要）。期望值来自 src/lib/diff.ts 的 JSDoc 契约。
import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "../src/lib/diff";

describe("diffLines / diffStats：行级 LCS diff", () => {
  it("全等：多行输入全 equal、stats 归零；末尾有无换行不产生噪音行", () => {
    const rows = diffLines("# 剧情状态\n周目: 1\n好感度: 42", "# 剧情状态\n周目: 1\n好感度: 42\n");
    expect(rows).toEqual([
      { type: "equal", text: "# 剧情状态" },
      { type: "equal", text: "周目: 1" },
      { type: "equal", text: "好感度: 42" },
    ]);
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0 });
  });

  it("全增：a 为空串或 undefined 都容错为 0 行，b 逐行 add", () => {
    expect(diffLines("", "A\nB")).toEqual([
      { type: "add", text: "A" },
      { type: "add", text: "B" },
    ]);
    expect(diffLines(undefined as unknown as string, "A")).toEqual([{ type: "add", text: "A" }]);
    expect(diffStats(diffLines("", "A\nB\nC"))).toEqual({ added: 3, removed: 0 });
  });

  it("全删：b 为空（或缺失文件 null 容错）→ a 逐行 remove", () => {
    expect(diffLines("A\nB", "")).toEqual([
      { type: "remove", text: "A" },
      { type: "remove", text: "B" },
    ]);
    expect(diffLines("A", null as unknown as string)).toEqual([{ type: "remove", text: "A" }]);
  });

  it("交叉改动：替换块里 remove 在 add 之前（git 惯例），equal 分段保持文档顺序", () => {
    const rows = diffLines("A\nB\nC", "A\nX\nC");
    expect(rows).toEqual([
      { type: "equal", text: "A" },
      { type: "remove", text: "B" },
      { type: "add", text: "X" },
      { type: "equal", text: "C" },
    ]);
  });

  it("多行混合：中间删一行加两行，stats 只数 add/remove", () => {
    const a = ["1", "2", "3", "4", "5"].join("\n");
    const b = ["1", "3", "6", "7", "5"].join("\n");
    const rows = diffLines(a, b);
    expect(rows).toEqual([
      { type: "equal", text: "1" },
      { type: "remove", text: "2" },
      { type: "equal", text: "3" },
      { type: "remove", text: "4" },
      { type: "add", text: "6" },
      { type: "add", text: "7" },
      { type: "equal", text: "5" },
    ]);
    expect(diffStats(rows)).toEqual({ added: 2, removed: 2 });
  });

  it("典型 state.md：只改一行好感度，其余全 equal（玩家一眼看到哪变了）", () => {
    const prev = ["# 剧情状态", "周目: 1", "好感度: 42", "场景: 旅店大堂"].join("\n");
    const cur = ["# 剧情状态", "周目: 1", "好感度: 55", "场景: 旅店大堂"].join("\n");
    const rows = diffLines(prev, cur);
    expect(rows).toEqual([
      { type: "equal", text: "# 剧情状态" },
      { type: "equal", text: "周目: 1" },
      { type: "remove", text: "好感度: 42" },
      { type: "add", text: "好感度: 55" },
      { type: "equal", text: "场景: 旅店大堂" },
    ]);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("空输入：两边都空 → 0 行（空快照文件不渲染出行）", () => {
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines(undefined as unknown as string, null as unknown as string)).toEqual([]);
    expect(diffStats([])).toEqual({ added: 0, removed: 0 });
  });

  it("空行是行：文件中间的空行参与 diff，不与「无内容」混淆", () => {
    const rows = diffLines("A\n\nB", "A\nB");
    expect(rows).toEqual([
      { type: "equal", text: "A" },
      { type: "remove", text: "" },
      { type: "equal", text: "B" },
    ]);
  });
});
