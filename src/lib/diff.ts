// 快照对比的行级 diff 纯函数（v1.7，ADR-0007 的「看两份存档差在哪」）：零依赖，node 单测直引
//（tests/diff.test.ts），UI 侧由 StoryTreeScreen 的快照对比面板消费。
//
// 复杂度与取舍：经典 LCS DP，O(n·m) 时间与空间。快照三文件（state.md / summary.md /
// story-tree.md）通常 < 100 行，最坏 10^4 个单元格、微秒级，没必要上 Myers O((n+m)D) 或
// histogram diff——那些算法赢在大文件与海量改动，这里换来的只是不可读。若未来文件涨到
// 数千行再换算法，本模块对外形状（DiffRow[]）不变。
export interface DiffRow {
  /** equal=两边都有；add=b 新增的行；remove=a 独有的行 */
  type: "equal" | "add" | "remove";
  /** 行原文（不含换行） */
  text: string;
}

/**
 * 文件文本 → 行数组：空串/undefined 容错为 0 行；末尾换行切出的尾部空行不算一行
 * （"x" 与 "x\n" 视为同一份内容，不产生噪音行——与 unified diff 的惯例一致）。
 */
function toLines(s: string | null | undefined): string[] {
  if (s == null || s === "") return [];
  const parts = s.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * 行级 diff（最长公共子序列）。以 b 为目标：add = b 新增的行、remove = a 独有的行；
 * 同一替换块里 remove 在 add 之前（git 惯例，见回溯的 tie-break）。逐行一条 DiffRow，
 * 不合并相邻同型行——渲染端自行分组/折叠，纯函数保持最小形状。
 * @param {string} a 旧文本（对比基线，如上一条快照的文件）
 * @param {string} b 新文本（对比目标，如当前快照的文件）
 * @returns {DiffRow[]} 按文档顺序的行序列；两边都空时是空数组
 */
export function diffLines(a: string, b: string): DiffRow[] {
  const as = toLines(a);
  const bs = toLines(b);
  const n = as.length;
  const m = bs.length;
  if (n === 0) return bs.map((text) => ({ type: "add", text }));
  if (m === 0) return as.map((text) => ({ type: "remove", text }));

  // dp[i][j] = as[i..n) 与 bs[j..m) 的 LCS 长度（后缀表，末行末列是 0 哨兵）——
  // 用后缀表可以从 (0,0) 正向回溯，输出天然按文档顺序，不需要收集后再 reverse。
  // oxlint-disable-next-line unicorn/no-new-array -- 「定长数组填同一个初值」在这里比 Array.from({length}) 更直白，且要的是 number[][]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = as[i] === bs[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (as[i] === bs[j]) {
      rows.push({ type: "equal", text: as[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 走得动 LCS 不变的方向；两边都走得动（tie）时先输出 a 的旧行 → 替换块里 remove 在 add 前
      rows.push({ type: "remove", text: as[i] });
      i += 1;
    } else {
      rows.push({ type: "add", text: bs[j] });
      j += 1;
    }
  }
  // 尾部残余：只可能剩一边（另一边已并入 LCS/equal）
  while (i < n) rows.push({ type: "remove", text: as[i++] });
  while (j < m) rows.push({ type: "add", text: bs[j++] });
  return rows;
}

/**
 * diff 行的 +N −M 摘要（tab 头显示用）。
 * @param {DiffRow[]} rows {@link diffLines} 的输出
 * @returns {{added: number, removed: number}} add/remove 各自的行数
 */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added += 1;
    else if (r.type === "remove") removed += 1;
  }
  return { added, removed };
}
