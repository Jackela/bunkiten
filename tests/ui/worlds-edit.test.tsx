// @vitest-environment jsdom
// 世界线屏的改名/导出/导入（拆自 tests/ui.test.tsx）：行内编辑器键盘、listbox 语义、Radix ⋯ 菜单、导入两条路径。
// 单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorldsScreen from "../../src/components/WorldsScreen";
import { useGameStore } from "../../src/store/game";
import { worldDisplayName } from "../../src/lib/worlds";
import { type WorldEntry } from "../../src/lib/acp";
import { PRESET, jsonResponse, openRowMenu, setupUi } from "./helpers";

setupUi();

describe("WorldsScreen：改名 / 导出 / 导入（v1.6）", () => {
  const NOW = Date.now();
  /** 世界线条目构造器（只写用例关心的字段） */
  function world(over: Partial<WorldEntry> & { worldId: string }): WorldEntry {
    return {
      preset: "campus-summer",
      title: "盛夏偏差值",
      chapterNo: 1,
      lastPlayed: NOW - 60_000,
      note: "",
      forkedFrom: null,
      exists: true,
      ...over,
    };
  }
  /** GET /api/worlds 的清单（可被单个用例覆盖；update 成功后就地改它，模拟服务端回带新值） */
  let worldsResp: WorldEntry[];
  /** POST /api/worlds 收到的动作 */
  let worldPosts: Record<string, unknown>[];
  /** POST import 的返回（可被单个用例覆盖成失败） */
  let importResp: Record<string, unknown>;

  beforeEach(() => {
    worldsResp = [
      world({
        worldId: "campus-summer-2",
        label: "雨夜的岔口",
        note: "分叉自 campus-summer-1 @ 2-2",
        chapterNo: 2,
        lastPlayed: NOW - 5 * 60_000,
        forkedFrom: { worldId: "campus-summer-1", nodeId: "2-2" },
      }),
      world({ worldId: "campus-summer-1" }),
    ];
    worldPosts = [];
    importResp = { ok: true, worldId: "campus-summer-9" };
    useGameStore.setState({
      selected: PRESET,
      screen: "worlds",
      screenReturn: null,
      engineBusy: false,
      worldId: null,
      worldBusy: false,
      worldNotice: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            action: string;
            worldId?: string;
            label?: string;
            note?: string;
          };
          worldPosts.push(body);
          if (body.action === "update") {
            // 服务端落定后 listWorlds 应回带新值（空串=清除），屏内靠重取清单回显
            worldsResp = worldsResp.map((w) =>
              w.worldId === body.worldId ? { ...w, label: body.label ?? "", note: body.note ?? "" } : w,
            );
            return jsonResponse({ ok: true });
          }
          if (body.action === "import") return jsonResponse(importResp, importResp.ok ? 200 : 400);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
  });

  it("显示名用 label；label 与真实备注都在时备注降为次行；无 label 回退剧本名（旧版分叉备注不算备注）", async () => {
    worldsResp = [
      worldsResp[0], // label 雨夜的岔口 + 旧版分叉备注：次行不铺
      { ...worldsResp[1], label: "二周目", note: "第一次玩到这里" },
    ];
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-2")).toBeTruthy());

    const labeled = within(screen.getByTestId("world-row-campus-summer-2"));
    expect(labeled.getByText("雨夜的岔口")).toBeTruthy();
    expect(labeled.queryByTestId("world-note-campus-summer-2")).toBeNull(); // 旧版分叉备注不上屏
    const both = within(screen.getByTestId("world-row-campus-summer-1"));
    expect(both.getByText("二周目")).toBeTruthy();
    expect(both.getByTestId("world-note-campus-summer-1").textContent).toBe("第一次玩到这里");

    // 纯函数：label 空白串视为未设置；回退链 label → note → 剧本名 → 未命名世界线（裸 id 永不上屏）
    expect(worldDisplayName(world({ worldId: "w", label: "  ", note: " 旧备注 " }))).toBe("旧备注");
    expect(worldDisplayName(world({ worldId: "w" }), "盛夏偏差值")).toBe("盛夏偏差值");
    expect(worldDisplayName(world({ worldId: "w" }))).toBe("未命名世界线");
    expect(worldDisplayName(world({ worldId: "w", note: "分叉自 w1 @ 2-2" }), "盛夏偏差值")).toBe("盛夏偏差值");
  });

  it("行内改名：编辑打开即聚焦显示名输入框；保存把 label/note 提交给 update 并重取清单回显", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-1")).toBeTruthy());
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));

    const label = screen.getByTestId("world-edit-label-campus-summer-1") as HTMLInputElement;
    expect(screen.getByTestId("world-editor-campus-summer-1")).toBeTruthy();
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull(); // 进编辑器顺手收菜单
    expect(label.value).toBe(""); // 初值取服务端现值（未设置=空串）
    expect(document.activeElement).toBe(label);
    expect(label.getAttribute("maxlength")).toBe("60");
    expect(screen.getByTestId("world-edit-note-campus-summer-1").getAttribute("maxlength")).toBe("200");
    expect(screen.getByLabelText("显示名（盛夏偏差值）")).toBe(label); // aria-label 用显示名，不露裸 id

    fireEvent.change(label, { target: { value: " 天台上的雨 " } });
    fireEvent.change(screen.getByTestId("world-edit-note-campus-summer-1"), { target: { value: "第一周目" } });
    fireEvent.click(screen.getByTestId("world-edit-save-campus-summer-1"));

    // 提交体只带 label/note（前后空白收敛掉），worldId 指认目标
    await waitFor(() =>
      expect(worldPosts).toEqual([
        { action: "update", worldId: "campus-summer-1", label: "天台上的雨", note: "第一周目" },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId("world-editor-campus-summer-1")).toBeNull());
    await waitFor(() =>
      expect(within(screen.getByTestId("world-row-campus-summer-1")).getByText("天台上的雨")).toBeTruthy(),
    );
    expect(screen.getByTestId("worlds-notice").textContent).toContain("已保存");
  });

  it("编辑器键盘：Enter 保存（组字中的 Enter 不算）、Esc 取消不发请求；清空显示名=清除并回退备注", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-2")).toBeTruthy());
    openRowMenu("campus-summer-2");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-2"));
    const label = screen.getByTestId("world-edit-label-campus-summer-2") as HTMLInputElement;
    expect(label.value).toBe("雨夜的岔口");

    fireEvent.change(label, { target: { value: "" } }); // 空串 = 清除显示名
    fireEvent.keyDown(label, { key: "Enter" });
    await waitFor(() =>
      expect(worldPosts.at(-1)).toEqual({
        action: "update",
        worldId: "campus-summer-2",
        label: "",
        note: "分叉自 campus-summer-1 @ 2-2",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("world-editor-campus-summer-2")).toBeNull());
    // 显示名清掉后：主行回退剧本名（旧版分叉备注不算备注）、次行仍不铺，分叉徽标还在
    await waitFor(() =>
      expect(within(screen.getByTestId("world-row-campus-summer-2")).getByText("盛夏偏差值")).toBeTruthy(),
    );
    expect(
      within(screen.getByTestId("world-row-campus-summer-2")).queryByTestId("world-note-campus-summer-2"),
    ).toBeNull();
    expect(within(screen.getByTestId("world-row-campus-summer-2")).getByText("自《盛夏偏差值》延伸")).toBeTruthy();

    // Esc 取消：不发请求、编辑器收起（从 ⋯ 菜单进）
    const before = worldPosts.length;
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    fireEvent.keyDown(screen.getByTestId("world-edit-note-campus-summer-1"), { key: "Escape" });
    expect(screen.queryByTestId("world-editor-campus-summer-1")).toBeNull();
    expect(worldPosts).toHaveLength(before);

    // 中文输入法组字中的 Enter 不算保存
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    fireEvent.keyDown(screen.getByTestId("world-edit-label-campus-summer-1"), { key: "Enter", isComposing: true });
    expect(screen.getByTestId("world-editor-campus-summer-1")).toBeTruthy();
    expect(worldPosts).toHaveLength(before);

    // 「取消」按钮与 Esc 是同一条出口：编辑器收起、不发请求、半截改动丢掉（重开仍是服务端现值）
    fireEvent.change(screen.getByTestId("world-edit-label-campus-summer-1"), { target: { value: "半截改的名字" } });
    fireEvent.click(screen.getByTestId("world-edit-cancel-campus-summer-1"));
    expect(screen.queryByTestId("world-editor-campus-summer-1")).toBeNull();
    expect(worldPosts).toHaveLength(before);
    expect(within(screen.getByTestId("world-row-campus-summer-1")).getByText("盛夏偏差值")).toBeTruthy(); // 行内显示名原样
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-1"));
    expect((screen.getByTestId("world-edit-label-campus-summer-1") as HTMLInputElement).value).toBe("");
  });

  it("改名失败：编辑器留在原地（玩家改的内容不丢），失败落在提示位", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/worlds" && init?.method === "POST") {
          worldPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({ ok: false, error: "label 太长" }, 400);
        }
        if (url.pathname === "/api/worlds") return jsonResponse({ worlds: worldsResp });
        return jsonResponse({}, 404);
      }),
    );
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-2")).toBeTruthy());
    openRowMenu("campus-summer-2");
    fireEvent.click(screen.getByTestId("world-edit-campus-summer-2"));
    fireEvent.change(screen.getByTestId("world-edit-label-campus-summer-2"), { target: { value: "太长的名字" } });
    fireEvent.click(screen.getByTestId("world-edit-save-campus-summer-2"));

    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("保存失败：label 太长"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("error");
    expect(screen.getByTestId("world-editor-campus-summer-2")).toBeTruthy();
    expect((screen.getByTestId("world-edit-label-campus-summer-2") as HTMLInputElement).value).toBe("太长的名字");
  });

  it("导出：⋯ 菜单里的下载链接指向 /api/worlds/export 并带 <worldId>.world.json 文件名", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-1")).toBeTruthy());

    openRowMenu("campus-summer-1");
    const link = screen.getByTestId("world-export-campus-summer-1") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/worlds/export?worldId=campus-summer-1");
    expect(link.getAttribute("download")).toBe("campus-summer-1.world.json");
    // aria-label 用显示名（label 优先，绝不露裸 id）
    expect(link.getAttribute("aria-label")).toBe("导出世界线 盛夏偏差值");

    // 换另一行的菜单：链接随行，无障碍名跟着换（同屏只开一个菜单）
    openRowMenu("campus-summer-2");
    expect(screen.getByTestId("world-export-campus-summer-2").getAttribute("aria-label")).toBe("导出世界线 雨夜的岔口");
    expect(screen.queryByTestId("world-export-campus-summer-1")).toBeNull();
  });

  it("列表语义：listbox + option + roving tabIndex，↑↓ 只让光标行可 Tab；行内按钮 aria-label 含世界名", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "世界线" })).toBeTruthy());

    // 清单一到就会重挂键盘监听，但 jsdom 的 act 垫片（flushSync 版）会把这一轮 useEffect 推迟到下次 flush，
    // 不先冲刷就会打到「清单还是空」的旧监听上（浏览器里不存在这个窗口期）
    await act(async () => {});
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1"]);

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]),
    );
    expect(screen.getAllByRole("option").map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0"]);
    // roving tabIndex 的焦点也真的搬过去了（不能只是换个描边）
    expect(document.activeElement).toBe(screen.getByTestId("world-row-campus-summer-1"));

    expect(screen.getByLabelText("继续世界线 雨夜的岔口")).toBeTruthy();
    // 行内动作收在 ⋯ 菜单里：触发器与菜单项的无障碍名都用显示名（不露裸 worldId）
    fireEvent.pointerDown(screen.getByLabelText("世界线 盛夏偏差值 的更多操作"), { button: 0 });
    expect(screen.getByLabelText("改名世界线 盛夏偏差值")).toBeTruthy();
    expect(screen.getByLabelText("导出世界线 盛夏偏差值")).toBeTruthy();
    expect(screen.getByLabelText("删除世界线 盛夏偏差值")).toBeTruthy();
  });

  it("⋯ 菜单语义（v1.9 Radix）：菜单 ARIA、↑↓/Home/End 走位与 typeahead、Tab 走项、Esc 就地关闭（不冒到 Esc 关闭链）、点外面关闭、删除确认随关闭作废", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("world-menu-campus-summer-1")).toBeTruthy());

    const trigger = screen.getByTestId("world-menu-campus-summer-1");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    openRowMenu("campus-summer-1");
    const popup = screen.getByTestId("world-menu-popup-campus-summer-1");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(popup).getByTestId("world-edit-campus-summer-1")).toBeTruthy();
    expect(within(popup).getByTestId("world-export-campus-summer-1")).toBeTruthy();
    expect(within(popup).getByTestId("world-delete-campus-summer-1")).toBeTruthy();
    // 菜单语义由原语给：role=menu 挂在弹层上、三项是 role=menuitem、弹层的无障碍名来自触发器
    expect(popup.getAttribute("role")).toBe("menu");
    expect(popup.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.getAttribute("aria-controls")).toBe(popup.id);
    const items = within(popup).getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual(["改名", "导出", "删除"]);
    // 默认向下展开（贴到视口底边时的翻面由 Radix 的 flip 负责，jsdom 量不出布局 → 浏览器级断言在 menu.spec.ts）
    expect(popup.getAttribute("data-side")).toBe("bottom");
    expect(popup.className).toContain("shell-panel");
    const edit = screen.getByTestId("world-edit-campus-summer-1");
    const exp = screen.getByTestId("world-export-campus-summer-1");
    const del = screen.getByTestId("world-delete-campus-summer-1");
    // 打开即把焦点送进第一项（鼠标路径也一样：Radix 默认只聚焦弹层，本屏把自己收齐）
    await waitFor(() => expect(document.activeElement).toBe(edit));
    // 屏级键盘监听带着「菜单开着就让位」的新守卫重挂是 effect 的事，jsdom 的 act 垫片会把它推迟到下次 flush
    //（浏览器里不存在这个窗口期）；不先冲刷，下面的方向键会打到「还不知道菜单开着」的旧监听上
    await act(async () => {});

    // ↑↓ / Home / End：roving 走位（v1.9 之前只有 Tab 能用）
    fireEvent.keyDown(edit, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(exp));
    fireEvent.keyDown(exp, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(del));
    fireEvent.keyDown(del, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(exp));
    fireEvent.keyDown(exp, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    fireEvent.keyDown(edit, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(del));

    // 走位归菜单：Home 回首项后，在首项上按 ↑ 是「菜单内的空步」（loop=false，不绕回去），
    // 屏级 handler 不许抢去做行导航（抢了的话焦点会跳到行上、列表光标也会挪走）。
    // 光标停在开着菜单的那一行是行自己的 onFocus 干的（菜单项是行的后代）
    fireEvent.keyDown(del, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    fireEvent.keyDown(edit, { key: "ArrowUp" });
    await act(async () => {});
    expect(document.activeElement).toBe(edit);
    expect(screen.getAllByRole("option").map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);

    // typeahead：按菜单项文案前缀跳项（「导」→ 导出）。Radix 的搜索串是「1s 内的连续按键拼接」，
    // 所以这里只按一次、不拼第二个字（拼了反而无匹配——那是它的约定，不是缺陷）
    fireEvent.keyDown(edit, { key: "导" });
    await waitFor(() => expect(document.activeElement).toBe(exp));

    // Tab 走项（本仓既有约定，e2e 也钉着）：Home 回首项后 Tab 依次走 改名 → 导出 → 删除；
    // 走到末项就把 Tab 交还页面，菜单随之收掉
    fireEvent.keyDown(exp, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    fireEvent.keyDown(edit, { key: "Tab" });
    expect(document.activeElement).toBe(exp);
    fireEvent.keyDown(exp, { key: "Tab" });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(del, { key: "Tab" });
    await waitFor(() => expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull());
    // 弹层是这一行 DOM 里最后的可聚焦块，文档序的下一站是右栏「继续上次」的按钮
    expect(document.activeElement).toBe(screen.getByTestId("worlds-resume-continue"));

    // Esc：就地关菜单并 stopPropagation——那一下不许冒到 App 的 Esc 关闭链（外面听不到）
    openRowMenu("campus-summer-1");
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(screen.getByTestId("world-menu-popup-campus-summer-1"), { key: "a" }); // 探针：没人拦的按键能冒到 document（证明下面不是空转）
    expect(outer).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId("world-menu-popup-campus-summer-1"), { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).toHaveBeenCalledTimes(1); // Esc 那一下被就地吃掉：App 的关闭链听不到
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    // 关菜单把焦点归还触发器（Radix 的 onCloseAutoFocus；卸载后一拍才做，故等一等）
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    // 删除 → 确认态；点菜单外面关闭：半截确认一起作废（重开回到第一屏），没发过请求
    openRowMenu("campus-summer-1");
    fireEvent.click(screen.getByTestId("world-delete-campus-summer-1"));
    expect(screen.getByTestId("world-confirm-campus-summer-1")).toBeTruthy();
    expect(screen.getByTestId("world-cancel-campus-summer-1")).toBeTruthy();
    // 「删除」被换掉这一拍，焦点跟着挪到确认按钮上（否则掉回 body，键盘用户断线）
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("world-confirm-campus-summer-1")));
    // 点外面关：Radix 听的是 pointerdown（在事件派发一拍之后才挂上监听，先让那一拍跑完）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.pointerDown(document.body, { button: 0 });
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    expect(worldPosts).toEqual([]);
    openRowMenu("campus-summer-1");
    expect(screen.getByTestId("world-delete-campus-summer-1")).toBeTruthy();
    expect(screen.queryByTestId("world-confirm-campus-summer-1")).toBeNull();

    // 焦点 Tab 走出这一行 → 菜单立刻收掉（Radix 的 focusOutside）：不留「开着却没人管」的孤儿菜单
    expect(trigger.getAttribute("aria-expanded")).toBe("true"); // 上面刚重开的菜单还开着
    act(() => (screen.getByTestId("worlds-new") as HTMLElement).focus());
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // 焦点已不在菜单里时按 Esc：Radix 的 document 捕获监听兜住，且不许冒到 window ——
    // 那正是 App 的 Esc 关闭链（会把整屏关回标题屏）
    openRowMenu("campus-summer-1");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const outer2 = vi.fn();
    window.addEventListener("keydown", outer2);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", outer2);
    expect(outer2).not.toHaveBeenCalled();
    expect(screen.queryByTestId("world-menu-popup-campus-summer-1")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("导入：选中文件 → 校验通过后 POST import，成功刷新清单并出成功提示", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-import-input")).toBeTruthy());
    const bundle = {
      format: "bunkiten-world",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      world: {
        worldId: "campus-summer-9",
        preset: "campus-summer",
        title: "盛夏偏差值",
        label: "导进来的",
        note: "",
        chapterNo: 2,
        files: { state: null, summary: null, tree: null },
        snapshots: [],
      },
    };
    worldsResp = [...worldsResp, world({ worldId: "campus-summer-9", label: "导进来的" })];
    const file = new File([JSON.stringify(bundle)], "campus-summer-9.world.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("worlds-import-input"), { target: { files: [file] } });

    await waitFor(() => expect(worldPosts).toEqual([{ action: "import", bundle }]));
    await waitFor(() =>
      expect(screen.getByTestId("worlds-notice").textContent).toContain("已导入世界线 campus-summer-9"),
    );
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("ok");
    await waitFor(() => expect(screen.getByTestId("world-row-campus-summer-9")).toBeTruthy()); // 重取清单可见
  });

  it("导入失败：不是导出包本地挡下（不打服务端）；服务端拒绝走错误提示位", async () => {
    render(<WorldsScreen />);
    await waitFor(() => expect(screen.getByTestId("worlds-import-input")).toBeTruthy());

    const junk = new File(["这只是一段普通文本"], "note.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("worlds-import-input"), { target: { files: [junk] } });
    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("不是有效的世界线导出包"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("error");
    expect(worldPosts).toEqual([]);

    importResp = { ok: false, error: "bundle 校验失败" };
    const file = new File(
      [JSON.stringify({ format: "bunkiten-world", version: 1, world: { worldId: "x" } })],
      "x.world.json",
    );
    fireEvent.change(screen.getByTestId("worlds-import-input"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("worlds-notice").textContent).toContain("导入失败：bundle 校验失败"));
    expect(screen.getByTestId("worlds-notice").getAttribute("data-kind")).toBe("error");
  });
});
