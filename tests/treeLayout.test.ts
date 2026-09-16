// 剧情树布局纯函数测试（v1.5 剧情图）：分层规则、抗环、边归一与输出确定性。
// 期望值来自 layoutTree 的 JSDoc 契约（最长路径分层 / 回边忽略 / 目标不在本章的边跳过）。
import { describe, expect, it } from "vitest";
import { layoutTree } from "../src/lib/treeLayout";
import type { TreeChapter, TreeNode } from "../src/lib/parser";

/** 造节点：edges 是 [label, target] 对，便于手写用例 */
function node(id: string, edges: [string, string][] = [], status: TreeNode["status"] = "可达"): TreeNode {
  return {
    id,
    beat: `拍点 ${id}`,
    location: `地点 ${id}`,
    present: "",
    synopsis: "",
    edges: edges.map(([label, target]) => ({ label, target })),
    status,
  };
}

function chapter(nodes: TreeNode[]): TreeChapter {
  return { title: "第 1 章", goal: "", outline: "", current: null, nodes };
}

describe("layoutTree：最长路径分层与画布尺寸", () => {
  it("链式三层：层号 0/1/2 递增，x 按层右移，单节点列 y 对齐", () => {
    const l = layoutTree(chapter([node("a", [["", "b"]]), node("b", [["", "c"]]), node("c")]));
    expect(l.nodes.map((n) => [n.id, n.layer])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    expect(l.nodes[0].x).toBeLessThan(l.nodes[1].x);
    expect(l.nodes[1].x).toBeLessThan(l.nodes[2].x);
    expect(l.nodes[0].y).toBe(l.nodes[1].y); // 各列只有一个节点 → 同一垂直居中位置
    expect(l.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b", "b->c"]);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
  });

  it("分叉与汇合：层号取最长路径，汇合点对齐较深分支（不提前）", () => {
    // a → b → d（两跳）；a → c → d（两跳）：d 层号 = 2
    const l = layoutTree(
      chapter([node("a", [["", "b"], ["", "c"]]), node("b", [["", "d"]]), node("c", [["", "d"]]), node("d")]),
    );
    const layerOf = (id: string) => l.nodes.find((n) => n.id === id)!.layer;
    expect(layerOf("a")).toBe(0);
    expect(layerOf("b")).toBe(1);
    expect(layerOf("c")).toBe(1);
    expect(layerOf("d")).toBe(2);
    // 同层两节点纵向错开
    const yb = l.nodes.find((n) => n.id === "b")!.y;
    const yc = l.nodes.find((n) => n.id === "c")!.y;
    expect(yb).not.toBe(yc);
    expect(l.edges).toHaveLength(4);
  });

  it("抗环：环形边不死循环，回边不参与分层（层号有界）", () => {
    const l = layoutTree(chapter([node("a", [["", "b"]]), node("b", [["", "a"]])]));
    expect(l.nodes).toHaveLength(2);
    expect(Math.max(...l.nodes.map((n) => n.layer))).toBeLessThanOrEqual(1);
  });

  it("出边目标不在本章：跳过该边；节点仍按章节顺序输出", () => {
    const l = layoutTree(chapter([node("a", [["", "ghost"]]), node("b")]));
    expect(l.edges).toEqual([]);
    expect(l.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("重复节点 id 与重复边去重（保留首次出现）", () => {
    const l = layoutTree(chapter([node("a", [["", "b"], ["", "b"]]), node("a"), node("b")]));
    expect(l.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(l.edges).toHaveLength(1);
  });

  it("空章节 / null：空布局（0×0）", () => {
    expect(layoutTree(null)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
    expect(layoutTree(chapter([]))).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it("确定性：同输入两次布局结果完全一致（坐标抹浮点噪声）", () => {
    const ch = chapter([node("a", [["", "b"], ["", "c"]]), node("b", [["", "d"]]), node("c", [["", "d"]]), node("d")]);
    expect(layoutTree(ch)).toEqual(layoutTree(ch));
  });
});
