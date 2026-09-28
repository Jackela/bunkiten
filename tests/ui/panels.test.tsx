// @vitest-environment jsdom
// 本地面板专测（v1.14 新文件）：帮助面板 HelpPanel 与 前情提要 RecapPanel 的渲染与交互。
// 两者都由 store 的布尔开关控制（helpOpen/recapOpen），内容是本地静态 / 本地合成——这里只测**渲染层**，
// store 侧（openRecap 的取数合成、loadHistoryPage 分页）在 tests/crafting.test.ts 已有专测。
// Esc 关闭链与 App 接线在 tests/ui/app.test.tsx 里钉（面板本身刻意不碰 keyboard Esc）。

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HelpPanel from "../../src/components/HelpPanel";
import RecapPanel from "../../src/components/RecapPanel";
import { useGameStore } from "../../src/store/game";
import { focusableElements } from "../../src/lib/focusTrap";
import { jsonResponse, pressTab, setupUi } from "./helpers";

setupUi();

describe("HelpPanel：帮助面板（v1.14 本地化 /help，零引擎回合）", () => {
  beforeEach(() => {
    useGameStore.setState({ helpOpen: false });
  });

  it("helpOpen 控制显隐：关着不渲染；开着是模态（role=dialog + aria-modal + 名字「帮助」），焦点落在关闭按钮", () => {
    const { rerender } = render(<HelpPanel />);
    expect(screen.queryByTestId("help-panel")).toBeNull();

    act(() => useGameStore.setState({ helpOpen: true }));
    rerender(<HelpPanel />);
    const panel = screen.getByTestId("help-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe("帮助");
    // 焦点进面板：关闭按钮是 DOM 里第一个可聚焦元素
    expect(document.activeElement).toBe(screen.getByTestId("help-close"));
    expect(within(panel).getByText("帮 助")).toBeTruthy();
  });

  it("内容三块：命令轨五组、键盘速查卡（复用卡式样式）、数据与备份说明都在", () => {
    useGameStore.setState({ helpOpen: true });
    render(<HelpPanel />);

    // ① 命令轨五组说明（每组一行）
    const rail = within(screen.getByTestId("help-rail"));
    for (const g of ["设置", "回顾", "图鉴", "进度", "帮助"]) {
      expect(rail.getByText(g)).toBeTruthy();
    }
    // ② 键盘卡：卡式样式（shell-panel）与既有 worlds-keys-card 同源，操作条目包括点选/自由输入/空格补全/切卡/缩放平移
    const keys = screen.getByTestId("help-keys-card");
    expect(keys.className).toContain("shell-panel");
    for (const k of ["点击", "输入框", "空格", "← →", "拖拽 / 滚轮", "+ − 0"]) {
      expect(within(keys).getByText(k)).toBeTruthy();
    }
    // ③ 数据与备份：一句数据位置 + 两个打开目录按钮
    const data = screen.getByTestId("help-data");
    expect(within(data).getByText(/应用数据目录/)).toBeTruthy();
    expect(screen.getByTestId("help-open-logs")).toBeTruthy();
    expect(screen.getByTestId("help-open-data")).toBeTruthy();
  });

  it("「打开日志目录」调 POST /api/open-dir {which:'logs'} 并给一行反馈；「打开数据目录」发 data", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/open-dir") {
          posts.push(String((JSON.parse(String(init?.body)) as { which: string }).which));
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 404);
      }),
    );
    useGameStore.setState({ helpOpen: true });
    render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("help-open-logs"));
    });
    expect(posts).toEqual(["logs"]);
    expect(screen.getByTestId("help-dir-msg").textContent).toContain("已帮你打开日志目录");

    await act(async () => {
      fireEvent.click(screen.getByTestId("help-open-data"));
    });
    expect(posts).toEqual(["logs", "data"]);
    expect(screen.getByTestId("help-dir-msg").textContent).toContain("已帮你打开数据目录");
  });

  it("关闭：点右上 X 走 closeHelp；焦点在面板里 Tab 循环（不跑到外面的元素）", async () => {
    // 焦点陷阱的「外面」探针
    const outside = document.createElement("button");
    outside.textContent = "外面";
    document.body.appendChild(outside);

    useGameStore.setState({ helpOpen: true });
    render(<HelpPanel />);
    const panel = screen.getByTestId("help-panel");
    const [close, logs, data] = focusableElements(panel);
    expect([close, logs, data]).toEqual([
      screen.getByTestId("help-close"),
      screen.getByTestId("help-open-logs"),
      screen.getByTestId("help-open-data"),
    ]);
    // 末 → 首、首 → 末 的回绕（Tab 不逃出面板）
    data.focus();
    pressTab();
    expect(document.activeElement).toBe(close);
    pressTab(true);
    expect(document.activeElement).toBe(data);

    fireEvent.click(close);
    expect(useGameStore.getState().helpOpen).toBe(false);
    outside.remove();
  });
});

describe("RecapPanel：前情提要（v1.14 本地合成，零引擎回合）", () => {
  const ENTRY = (n: number | null, t: string) => ({ n, t });

  beforeEach(() => {
    useGameStore.setState({ recapOpen: false, recapData: null });
  });

  it("recapOpen 控制显隐；打开即模态（role=dialog + aria-modal + 名字「前情提要」），焦点落在关闭按钮", () => {
    const { rerender } = render(<RecapPanel />);
    expect(screen.queryByTestId("recap-panel")).toBeNull();

    act(() => useGameStore.setState({ recapOpen: true }));
    rerender(<RecapPanel />);
    const panel = screen.getByTestId("recap-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe("前情提要");
    expect(document.activeElement).toBe(screen.getByTestId("recap-close"));
  });

  it("三态之加载中：recapData 未 loaded → 加载行", () => {
    useGameStore.setState({
      recapOpen: true,
      recapData: { loaded: false, error: null, chapterNo: null, time: null, scene: null, entries: [] },
    });
    render(<RecapPanel />);
    expect(screen.getByTestId("recap-loading")).toBeTruthy();
    expect(screen.queryByTestId("recap-entries")).toBeNull();
  });

  it("三态之出错：error 上屏、不留白也不显示空态", () => {
    useGameStore.setState({
      recapOpen: true,
      recapData: { loaded: true, error: "回顾失败：HTTP 500", chapterNo: 1, time: null, scene: null, entries: [] },
    });
    render(<RecapPanel />);
    expect(screen.getByTestId("recap-error").textContent).toContain("回顾失败：HTTP 500");
    expect(screen.queryByTestId("recap-empty")).toBeNull();
  });

  it("三态之内容：当前章 + 时间地点一行 + 最近 5 条一行式回顾（summary 那条 n=null 不带幕号）", () => {
    useGameStore.setState({
      recapOpen: true,
      recapData: {
        loaded: true,
        error: null,
        chapterNo: 2,
        time: "夜里",
        scene: "天台",
        entries: [ENTRY(null, "这一段的前情摘要。"), ENTRY(9, "推门进去 — 门后空无一人。"), ENTRY(8, "风停了。")],
      },
    });
    render(<RecapPanel />);
    expect(screen.getByTestId("recap-meta").textContent).toBe("第 2 章 · 夜里 · 天台");
    const entries = screen.getAllByTestId("recap-entry");
    expect(entries).toHaveLength(3);
    expect(entries[0].textContent).toBe("这一段的前情摘要。"); // 引言：无幕号
    expect(entries[1].textContent).toContain("第 9 幕");
    expect(entries[1].textContent).toContain("推门进去 — 门后空无一人。");
  });

  it("有内容但没有时间地点：meta 行不画（不提空字段）；关闭走 closeRecap", () => {
    useGameStore.setState({
      recapOpen: true,
      recapData: {
        loaded: true,
        error: null,
        chapterNo: null,
        time: null,
        scene: null,
        entries: [ENTRY(3, "只有一幕。")],
      },
    });
    render(<RecapPanel />);
    expect(screen.queryByTestId("recap-meta")).toBeNull();
    expect(screen.getAllByTestId("recap-entry")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("recap-close"));
    expect(useGameStore.getState().recapOpen).toBe(false);
  });

  it("loaded 但没有条目：给空态行（不是空白面板）", () => {
    useGameStore.setState({
      recapOpen: true,
      recapData: { loaded: true, error: null, chapterNo: 1, time: null, scene: null, entries: [] },
    });
    render(<RecapPanel />);
    expect(screen.getByTestId("recap-empty")).toBeTruthy();
    expect(screen.queryByTestId("recap-entries")).toBeNull();
  });
});
