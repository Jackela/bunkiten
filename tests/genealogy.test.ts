// 世界线家谱布局纯函数测试（v1.7）：森林分层、孤儿（父线已删）、fork 环终止、
// 层内排序确定性与键盘步进规则。期望值来自 layoutGenealogy 的 JSDoc 契约。
import { describe, expect, it } from "vitest";
import { genealogyStep, layoutGenealogy } from "../src/lib/genealogy";
import type { WorldEntry } from "../src/lib/acp";

/** 造世界线：fork 是 [父 worldId, 节点 id]，lp 是 lastPlayed（ms） */
function world(id: string, o: { fork?: [string, string]; lp?: number } = {}): WorldEntry {
  return {
    worldId: id,
    preset: "demo",
    title: "示例剧本",
    chapterNo: 1,
    lastPlayed: o.lp ?? 1_000,
    note: "",
    forkedFrom: o.fork ? { worldId: o.fork[0], nodeId: o.fork[1] } : null,
    exists: true,
  };
}

describe("layoutGenealogy：家谱森林分层与画布尺寸", () => {
  it("单根链三代：深度 0/1/2 递增，y 按层下移，边父→子", () => {
    const l = layoutGenealogy([world("a"), world("b", { fork: ["a", "1-1"] }), world("c", { fork: ["b", "2-1"] })]);
    expect(l.nodes.map((n) => [n.worldId, n.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const yOf = (id: string) => l.nodes.find((n) => n.worldId === id)!.y;
    expect(yOf("a")).toBeLessThan(yOf("b"));
    expect(yOf("b")).toBeLessThan(yOf("c"));
    expect(l.nodes.every((n) => !n.missingParent)).toBe(true);
    expect(l.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b", "b->c"]);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
  });

  it("多根森林：根都在第 0 层，层内按 lastPlayed 降序从左到右排", () => {
    const l = layoutGenealogy([
      world("old-root", { lp: 100 }),
      world("new-root", { lp: 900 }),
      world("c1", { fork: ["old-root", "1-1"], lp: 500 }),
      world("c2", { fork: ["new-root", "1-2"], lp: 800 }),
    ]);
    const byId = new Map(l.nodes.map((n) => [n.worldId, n]));
    expect([byId.get("old-root")!.depth, byId.get("new-root")!.depth]).toEqual([0, 0]);
    expect([byId.get("c1")!.depth, byId.get("c2")!.depth]).toEqual([1, 1]);
    // 第 0 层：new-root（900）在 old-root（100）左边；第 1 层同理 c2 在 c1 左边
    expect(byId.get("new-root")!.x).toBeLessThan(byId.get("old-root")!.x);
    expect(byId.get("c2")!.x).toBeLessThan(byId.get("c1")!.x);
    expect(l.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["new-root->c2", "old-root->c1"]);
  });

  it("孤儿：forkedFrom 指向不存在的世界 → 按根处理、missingParent 标记、不产生边", () => {
    const l = layoutGenealogy([world("a"), world("ghost-child", { fork: ["deleted", "3-1"] })]);
    const orphan = l.nodes.find((n) => n.worldId === "ghost-child")!;
    expect(orphan.depth).toBe(0);
    expect(orphan.missingParent).toBe(true);
    expect(l.nodes.find((n) => n.worldId === "a")!.missingParent).toBe(false);
    expect(l.edges).toEqual([]);
  });

  it("抗环：fork 环（含自指）不死循环，环节点按输入序断环落层，下游照常分层", () => {
    const l = layoutGenealogy([
      world("a", { fork: ["b", "1-1"] }),
      world("b", { fork: ["a", "1-2"] }),
      world("c", { fork: ["a", "1-3"] }),
      world("self", { fork: ["self", "1-4"] }),
    ]);
    expect(l.nodes).toHaveLength(4);
    const byId = new Map(l.nodes.map((n) => [n.worldId, n]));
    expect(byId.get("a")!.depth).toBe(0); // 环成员按输入序当根
    expect(byId.get("b")!.depth).toBe(1);
    expect(byId.get("c")!.depth).toBe(1); // 环下游照常 = 父 + 1
    expect(byId.get("self")!.depth).toBe(0); // 自指 fork 不产生边，按根落位
    expect(l.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["a->b", "a->c", "b->a"]);
    expect(Math.max(...l.nodes.map((n) => n.depth))).toBeLessThanOrEqual(1); // 分层有界
  });

  it("确定性：lastPlayed 相同时按 worldId 升序破平，同输入两次布局完全一致", () => {
    const worlds = [
      world("b-root", { lp: 500 }),
      world("a-root", { lp: 500 }),
      world("z-child", { fork: ["b-root", "1-1"], lp: 500 }),
      world("m-child", { fork: ["b-root", "1-2"], lp: 500 }),
    ];
    const l = layoutGenealogy(worlds);
    const xOf = (id: string) => l.nodes.find((n) => n.worldId === id)!.x;
    expect(xOf("a-root")).toBeLessThan(xOf("b-root")); // 破平走 worldId 升序
    expect(xOf("m-child")).toBeLessThan(xOf("z-child"));
    expect(layoutGenealogy(worlds)).toEqual(l);
  });

  it("坐标全整数且都落在画布 bounds 内（含孤儿/环的混合森林）", () => {
    const l = layoutGenealogy([
      world("a"),
      world("b"),
      world("c", { fork: ["b", "1-1"] }),
      world("d", { fork: ["b", "1-2"] }),
      world("e", { fork: ["b", "1-3"] }),
      world("f", { fork: ["c", "2-1"] }),
      world("g", { fork: ["deleted", "9-9"] }),
      world("h", { fork: ["i", "1-4"] }),
      world("i", { fork: ["h", "1-5"] }),
    ]);
    expect(l.nodes).toHaveLength(9);
    expect(l.edges).toHaveLength(6); // b→c/d/e、c→f、环两条（i→h、h→i）
    for (const n of l.nodes) {
      expect(Number.isInteger(n.x), `${n.worldId}.x=${n.x} 应为整数`).toBe(true);
      expect(Number.isInteger(n.y), `${n.worldId}.y=${n.y} 应为整数`).toBe(true);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + 210).toBeLessThanOrEqual(l.width);
      expect(n.y + 64).toBeLessThanOrEqual(l.height);
    }
  });

  it("空输入：空布局（0×0）", () => {
    expect(layoutGenealogy([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it("genealogyStep：同层左右、跨层取水平最近，出森林/未知节点返回 null", () => {
    const l = layoutGenealogy([
      world("r1", { lp: 200 }),
      world("r2", { lp: 100 }),
      world("c1", { fork: ["r1", "1-1"], lp: 200 }),
      world("c2", { fork: ["r2", "1-2"], lp: 100 }),
    ]);
    expect(genealogyStep(l, "r1", "right")).toBe("r2");
    expect(genealogyStep(l, "r2", "left")).toBe("r1");
    expect(genealogyStep(l, "r2", "right")).toBeNull(); // 行尾
    expect(genealogyStep(l, "r1", "down")).toBe("c1"); // 同列直下 = 水平最近
    expect(genealogyStep(l, "r2", "down")).toBe("c2");
    expect(genealogyStep(l, "c1", "up")).toBe("r1");
    expect(genealogyStep(l, "c1", "right")).toBe("c2");
    expect(genealogyStep(l, "c1", "left")).toBeNull(); // 行首
    expect(genealogyStep(l, "r1", "up")).toBeNull(); // 已是最浅层
    expect(genealogyStep(l, "c2", "down")).toBeNull(); // 已是最深层
    expect(genealogyStep(l, "ghost", "right")).toBeNull();
  });
});
