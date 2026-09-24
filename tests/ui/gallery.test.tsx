// @vitest-environment jsdom
// 画廊屏（拆自 tests/ui.test.tsx）：分组/未使用徽标/大图预览/跨剧本过滤，选择模式与批量重绘/批量删除队列、
// 预览里的「想怎么改？」要求输入。单例 store 的基线复位由 ./helpers 的 setupUi() 统一负责。

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AssetsScreen from "../../src/components/AssetsScreen";
import { useGameStore } from "../../src/store/game";
import { focusableElements } from "../../src/lib/focusTrap";
import { type AssetEntry } from "../../src/lib/acp";
import { PRESET, jsonResponse, pressTab, setupUi } from "./helpers";

setupUi();

describe("AssetsScreen：分组、未使用徽标与预览", () => {
  // v1.5.1：资产随剧本走，清单只含目录 presets/<preset>/assets/ 下的文件（封面 presets/<preset>/cover.jpg）；
  // 每条都带 preset，画廊按它做防御性过滤（跨剧本条目见下一条用例）
  const ASSETS: AssetEntry[] = [
    {
      type: "立绘",
      name: "薇拉",
      variant: "",
      preset: "campus-summer",
      file: "presets/campus-summer/assets/立绘-薇拉.jpg",
      ready: true,
      inUse: true,
      mtime: 1,
    },
    {
      type: "立绘",
      name: "薇拉",
      variant: "微笑",
      preset: "campus-summer",
      file: "presets/campus-summer/assets/立绘-薇拉-微笑.jpg",
      ready: true,
      inUse: false,
      mtime: 2,
    },
    {
      type: "背景",
      name: "灰雀镇廉价旅店",
      variant: "",
      preset: "campus-summer",
      file: "presets/campus-summer/assets/背景-灰雀镇廉价旅店.jpg",
      ready: true,
      inUse: false,
      mtime: 3,
    },
    {
      type: "封面",
      name: "盛夏偏差值",
      variant: "",
      preset: "campus-summer",
      file: "presets/campus-summer/cover.jpg",
      ready: true,
      inUse: false,
      mtime: 4,
    },
  ];
  /** GET /api/assets 的 mock（断言请求带 preset） */
  let fetchMock: ReturnType<typeof vi.fn>;
  /** GET /api/assets 返回的清单（单个用例可覆盖，用于混入跨剧本项） */
  let assetsResp: AssetEntry[];

  beforeEach(() => {
    assetsResp = ASSETS;
    useGameStore.setState({
      selected: PRESET,
      screen: "assets",
      screenReturn: "game",
      assetsPreview: null,
      regenPending: null,
      engineBusy: false,
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      // v1.5.1：清单必须带 preset，服务端缺省/非法即 400
      if (url.pathname === "/api/assets") {
        return url.searchParams.get("preset") === "campus-summer"
          ? jsonResponse(assetsResp)
          : jsonResponse({ error: "preset required" }, 400);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("立绘按角色分组（差分显示为 名 · 变体），背景/封面各自成组，未使用徽标只标未被引用的项", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByText("立 绘")).toBeTruthy());
    expect(screen.getByText("薇拉 · 微笑")).toBeTruthy();
    expect(screen.getByText("背 景")).toBeTruthy();
    expect(screen.getByText("封 面")).toBeTruthy();
    // inUse 是多数态（标了等于没标）：角标只标异常——4 项里只有基础薇拉 inUse
    expect(screen.queryByText("在用")).toBeNull();
    expect(screen.getAllByText("未使用")).toHaveLength(3);
    // 清单请求按当前剧本过滤
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets?preset=campus-summer",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("点击卡片打开大图预览（store 状态），Esc 关闭链入口可用", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByText("薇拉 · 微笑")).toBeTruthy());
    fireEvent.click(screen.getByTestId("asset-card-薇拉-微笑"));
    expect(useGameStore.getState().assetsPreview?.file).toBe("presets/campus-summer/assets/立绘-薇拉-微笑.jpg");
    useGameStore.getState().setAssetsPreview(null);
    expect(useGameStore.getState().assetsPreview).toBeNull();
  });

  it("未选剧本（从标题屏直接进画廊）：不请求清单，提示先选剧本", async () => {
    useGameStore.setState({ selected: null });
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-nopreset")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled(); // 没有可查的资产目录，不白打一次 400
  });

  it("跨剧本串味兜底：清单混入别的剧本的条目 → 不渲染并告警（服务端理论上不该返回）", async () => {
    assetsResp = [
      ...ASSETS,
      {
        type: "立绘",
        name: "守夜人",
        variant: "",
        preset: "twilight-throne", // 旧档串味 / 装配期写错目录的回归样本
        file: "presets/twilight-throne/assets/立绘-守夜人.jpg",
        ready: true,
        inUse: false,
        mtime: 5,
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(<AssetsScreen />);
      await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());

      expect(screen.queryByTestId("asset-card-守夜人")).toBeNull(); // 别家剧本的立绘不进画廊
      expect(screen.queryByText("守夜人")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("campus-summer"); // 告警点明当前剧本
      expect(warn.mock.calls[0][1]).toEqual(["presets/twilight-throne/assets/立绘-守夜人.jpg"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AssetsScreen：选择模式、批量重绘与批量删除（v1.6）", () => {
  // v1.5.1 资产随剧本走（presets/<preset>/assets/，封面是 presets/<preset>/cover.jpg）
  const asset = (over: Partial<AssetEntry> & Pick<AssetEntry, "type" | "name" | "file">): AssetEntry => ({
    variant: "",
    preset: "campus-summer",
    ready: true,
    inUse: false,
    mtime: 1,
    ...over,
  });
  const FILE_PORTRAIT = "presets/campus-summer/assets/立绘-薇拉.jpg";
  const FILE_VARIANT = "presets/campus-summer/assets/立绘-薇拉-微笑.jpg";
  const FILE_BG = "presets/campus-summer/assets/背景-灰雀镇廉价旅店.jpg";
  const FILE_COVER = "presets/campus-summer/cover.jpg";
  let assetsResp: AssetEntry[];
  /** POST /api/assets 收到的删除请求（按顺序） */
  let assetPosts: { action: string; preset?: string; file?: string }[];
  /** POST /prompt 收到的指令（按顺序） */
  let prompts: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  /** 模拟引擎跑完一个重绘回合（marker 给 【图…|重绘 标记时该条视为已换图） */
  async function engineTurn(marker?: string) {
    await act(async () => {
      const s = useGameStore.getState();
      s.handleEvent({ type: "turn_start" });
      if (marker) s.handleEvent({ type: "chunk", seg: 0, text: marker });
      s.handleEvent({ type: "turn_end" });
    });
  }

  beforeEach(() => {
    assetsResp = [
      asset({ type: "立绘", name: "薇拉", file: FILE_PORTRAIT, inUse: true }),
      asset({ type: "立绘", name: "薇拉", variant: "微笑", file: FILE_VARIANT, mtime: 2 }),
      asset({ type: "背景", name: "灰雀镇廉价旅店", file: FILE_BG, mtime: 3 }),
      asset({ type: "封面", name: "盛夏偏差值", file: FILE_COVER, mtime: 4 }),
    ];
    assetPosts = [];
    prompts = [];
    useGameStore.setState({
      selected: PRESET,
      screen: "assets",
      screenReturn: "game",
      assetsPreview: null,
      assetsStamp: 0,
      regenPending: null,
      regenQueue: [],
      regenTotal: 0,
      regenDone: 0,
      regenFailed: [],
      regenNotice: null,
      assetsNotice: null,
      assetsBusy: false,
      engineBusy: false,
      // 排队指令位也是单例上的脏状态（创作屏用例会写它）：不清掉会让重绘队列「等排队指令先发」
      pendingCreationMessage: null,
      pendingTreeMessage: null,
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/assets" && init?.method === "POST") {
        // 形状与 postAssetDelete 的请求体一致（action 必填；file 是收敛后的单层文件名）
        const body = JSON.parse(String(init.body)) as { action: string; preset?: string; file?: string };
        assetPosts.push(body);
        const name = body.file ?? "";
        // 请求体已收敛为单层文件名（postAssetDelete），清单条目是完整相对路径：按 basename 命中移除
        assetsResp = assetsResp.filter((a) => a.file !== name && !a.file.endsWith("/" + name));
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/assets") {
        return url.searchParams.get("preset") === "campus-summer"
          ? jsonResponse(assetsResp)
          : jsonResponse({ error: "preset required" }, 400);
      }
      if (url.pathname === "/prompt") {
        prompts.push(JSON.parse(String(init?.body)).text);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("选择模式：卡片带 checkbox，全选/清空实时显示可重绘与可删除数量（封面不进删除）", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉")).toBeTruthy());
    expect(screen.queryByTestId("assets-toolbar")).toBeNull(); // 浏览模式没有批量工具

    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    expect(screen.getByTestId("assets-toolbar")).toBeTruthy();
    expect(screen.getByLabelText("选择 立绘-薇拉")).toBeTruthy();
    expect(screen.getByLabelText("选择 立绘-薇拉 · 微笑")).toBeTruthy();
    expect(screen.getByLabelText("选择 背景-灰雀镇廉价旅店")).toBeTruthy();

    fireEvent.click(screen.getByTestId("assets-select-all"));
    for (const label of [
      "选择 立绘-薇拉",
      "选择 立绘-薇拉 · 微笑",
      "选择 背景-灰雀镇廉价旅店",
      "选择 封面-盛夏偏差值",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(true);
    }
    expect(screen.getByTestId("assets-regen-selected").textContent).toContain("重绘选中(4)");
    // 封面可重绘但不可删（服务端只受理 assets 目录下的 *.jpg）
    expect(screen.getByTestId("assets-delete-selected").textContent).toContain("删除选中(3)");
    expect(screen.getByText(/封面不参与批量删除/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("assets-select-none"));
    expect((screen.getByLabelText("选择 立绘-薇拉") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("assets-regen-selected") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("assets-delete-selected") as HTMLButtonElement).disabled).toBe(true);

    // 单点勾选即可起跑；退出选择把工具栏与 checkbox 一起收掉
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));
    expect((screen.getByTestId("assets-regen-selected") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("assets-exit-select"));
    expect(screen.queryByTestId("assets-toolbar")).toBeNull();
    expect(screen.queryByLabelText("选择 立绘-薇拉")).toBeNull();
  });

  it("选择模式下点卡片不误开预览（带下标的卡片 testid 仍在）", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByTestId("asset-card-薇拉-微笑"));
    expect(useGameStore.getState().assetsPreview).toBeNull();
  });

  it("批量删除：两段确认，第二段按勾选顺序逐条 POST delete，完成后刷新清单并落成功提示", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByLabelText("选择 背景-灰雀镇廉价旅店"));
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));

    fireEvent.click(screen.getByTestId("assets-delete-selected"));
    expect(assetPosts).toEqual([]); // 首点只进确认态
    expect(screen.getByTestId("assets-delete-confirm").textContent).toContain("确认删除(2)");

    fireEvent.click(screen.getByTestId("assets-delete-confirm"));
    // 删除在途：忙碌条在（逐条删完才收）——玩家知道这一下点住了
    expect(screen.getByTestId("assets-busy").textContent).toBe("删除中…");
    await waitFor(() => expect(assetPosts).toHaveLength(2));
    expect(screen.queryByTestId("assets-busy")).toBeNull(); // 收尾即撤（提示位换成结果）
    // 顺序=勾选顺序；file 是 postAssetDelete 收敛后的单层文件名（服务端 ASSET_DELETE_FILE_RE 契约）
    expect(assetPosts.map((p) => p.file)).toEqual(["背景-灰雀镇廉价旅店.jpg", "立绘-薇拉.jpg"]);
    expect(assetPosts.every((p) => p.action === "delete" && p.preset === "campus-summer")).toBe(true);

    await waitFor(() => expect(screen.getByTestId("assets-notice").textContent).toContain("已删除 2 项素材"));
    expect(screen.getByTestId("assets-notice").getAttribute("data-kind")).toBe("ok");
    // 收尾重取清单：删掉的卡片从画廊消失（薇拉的差分还在，组不会整块消失）
    await waitFor(() => expect(screen.queryByTestId("asset-card-薇拉")).toBeNull());
    expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy();
    expect(screen.queryByTestId("asset-card-灰雀镇廉价旅店")).toBeNull();
  });

  it("批量删除：取消不发请求；失败走错误提示位", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));

    fireEvent.click(screen.getByTestId("assets-delete-selected"));
    fireEvent.click(screen.getByTestId("assets-delete-cancel"));
    expect(assetPosts).toEqual([]);
    expect(screen.getByTestId("assets-delete-selected")).toBeTruthy(); // 回到未确认态

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/assets" && init?.method === "POST") {
        assetPosts.push(JSON.parse(String(init.body)));
        return jsonResponse({ error: "文件不存在" }, 404);
      }
      if (url.pathname === "/api/assets") return jsonResponse(assetsResp);
      return jsonResponse({}, 404);
    });
    fireEvent.click(screen.getByTestId("assets-delete-selected"));
    fireEvent.click(screen.getByTestId("assets-delete-confirm"));
    await waitFor(() => expect(screen.getByTestId("assets-notice").getAttribute("data-kind")).toBe("error"));
    expect(screen.getByTestId("assets-notice").textContent).toContain("已删除 0/1 项");
    expect(screen.getByTestId("assets-notice").textContent).toContain("文件不存在");
  });

  it("批量重绘：顺序队列逐条发指令、显示「重绘中 i/N」，收尾出完成提示", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByLabelText("选择 立绘-薇拉"));
    fireEvent.click(screen.getByLabelText("选择 背景-灰雀镇廉价旅店"));
    fireEvent.click(screen.getByTestId("assets-regen-selected"));

    // 只发第一条（顺序队列：一条收尾才发下一条，都挤在一起必然 409）
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉"]);
    expect(screen.getByTestId("assets-regen-progress").textContent).toContain("重绘中 1/2");

    await engineTurn("【图】立绘|薇拉|presets/campus-summer/assets/立绘-薇拉.jpg|重绘\n");
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉", "美术：重绘 背景 灰雀镇廉价旅店"]);
    expect(screen.getByTestId("assets-regen-progress").textContent).toContain("重绘中 2/2");

    await engineTurn("【图】背景|灰雀镇廉价旅店|presets/campus-summer/assets/背景-灰雀镇廉价旅店.jpg|重绘\n");
    expect(screen.queryByTestId("assets-regen-progress")).toBeNull();
    expect(screen.getByTestId("assets-regen-notice").textContent).toContain("重绘完成：2 项已换图");
  });

  it("预览里的「想怎么改？」（v1.12）：一句人话随指令发给引擎；留空 = 盲重绘；换一张图就清空", async () => {
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());

    fireEvent.click(screen.getByTestId("asset-card-薇拉-微笑"));
    const note = screen.getByTestId("assets-regen-note") as HTMLInputElement;
    expect(note.placeholder).toContain("头发改成短发"); // 给玩家的示例（教他能怎么说）
    fireEvent.change(note, { target: { value: "头发改成短发" } });
    fireEvent.click(screen.getByTestId("assets-preview-regen"));
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉-微笑：头发改成短发"]);
    await engineTurn("【图】立绘|薇拉-微笑|presets/campus-summer/assets/立绘-薇拉-微笑.jpg|重绘\n");

    // 换一张图：上一张的要求不能跟过来（那句话是针对上一张说的，带过去会把要求发错对象）
    fireEvent.click(screen.getByTestId("assets-preview-close"));
    fireEvent.click(screen.getByTestId("asset-card-薇拉"));
    expect((screen.getByTestId("assets-regen-note") as HTMLInputElement).value).toBe("");

    // 留空 = 盲重绘（v1.3 起的旧行为逐字不变）
    fireEvent.click(screen.getByTestId("assets-preview-regen"));
    expect(prompts[1]).toBe("美术：重绘 立绘 薇拉");
    await engineTurn("【图】立绘|薇拉|presets/campus-summer/assets/立绘-薇拉.jpg|重绘\n");

    // 下一张图：输入框里按 Enter 也能发（输入法组字中的 Enter 不算发送）
    fireEvent.click(screen.getByTestId("assets-preview-close"));
    fireEvent.click(screen.getByTestId("asset-card-薇拉-微笑"));
    const note2 = screen.getByTestId("assets-regen-note");
    fireEvent.change(note2, { target: { value: "换成夜景" } });
    fireEvent.keyDown(note2, { key: "Enter", isComposing: false });
    expect(prompts[2]).toBe("美术：重绘 立绘 薇拉-微笑：换成夜景");
  });

  it("预览模态：role=dialog + aria-modal + 关闭按钮聚焦；单项重绘仍是同一条流水线（N=1）", async () => {
    const { container } = render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("asset-card-薇拉-微笑")).toBeTruthy());
    // 壳层根（ScreenShell）就是本屏的滚动容器：关着预览时既没有滚动锁、背景也没被压住
    const scrollRoot = container.firstElementChild as HTMLElement;
    expect(scrollRoot.className).toContain("shell-backdrop");
    expect(scrollRoot.className).not.toContain("scroll-locked");
    expect(screen.getByTestId("shell-page").hasAttribute("inert")).toBe(false);
    const card = screen.getByTestId("asset-card-薇拉-微笑");
    card.focus(); // 真实浏览器里点按钮就会聚焦它；jsdom 的 click 不搬焦点，这里显式落一次（关闭归还的断言要用）
    fireEvent.click(card);

    // —— v1.9 a11y：预览打开 → 背景整页框 inert + 壳层根滚动锁；模态自己不在 inert 子树里 ——
    const page = screen.getByTestId("shell-page");
    expect(page.hasAttribute("inert")).toBe(true);
    expect(card.closest("[inert]")).toBe(page); // 打开预览的那张卡片确实被压住（本来 Tab 一转身就回到它）
    expect(scrollRoot.className).toContain("scroll-locked"); // 滚动锁的契约就是这一个类（jsdom 不滚，断类名）
    const dialog = screen.getByRole("dialog");
    expect(dialog.closest("[inert]")).toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("素材预览：薇拉 · 微笑");
    const close = screen.getByTestId("assets-preview-close");
    expect(close.getAttribute("aria-label")).toBe("关闭预览");
    // 焦点进模态（而不是被背景的 inert 挡住）：inert 子树里的元素连程序化 focus 都是 no-op，
    // 所以「焦点陷阱能把焦点送进来」与「背景已 inert」这两条必须同时成立——顺序错了这条会红
    await waitFor(() => expect(document.activeElement).toBe(close));

    // 焦点陷阱（v1.9）：面板里可 Tab 到的是「关闭 + 想怎么改？+ 重新生成」；两端回绕，Tab 走不到画廊
    const regen = screen.getByTestId("assets-preview-regen");
    expect(focusableElements(dialog)).toEqual([close, screen.getByTestId("assets-regen-note"), regen]);
    regen.focus();
    pressTab(); // 末 → 首
    expect(document.activeElement).toBe(close);
    pressTab(true); // 首 → 末（Shift+Tab 同一条回绕规则，方向相反）
    expect(document.activeElement).toBe(regen);

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(prompts).toEqual(["美术：重绘 立绘 薇拉-微笑"]);
    expect(screen.getByTestId("assets-regen-progress").textContent).toContain("重绘中 1/1");

    await engineTurn("【图】立绘|薇拉-微笑|presets/campus-summer/assets/立绘-薇拉-微笑.jpg|重绘\n");
    await waitFor(() =>
      expect(screen.getByTestId("assets-regen-notice").textContent).toContain("重绘完成：1 项已换图"),
    );

    // 关闭走 store（App 的 Esc 链与点遮罩同一条路）；退场动画期间节点还在，只断言状态
    fireEvent.click(close);
    expect(useGameStore.getState().assetsPreview).toBeNull();
    // 关闭即解锁：背景摘掉 inert、壳层根摘掉滚动锁（inert 的摘除在提交的变更阶段，
    // 早于焦点陷阱的清理——所以下一次快照能真的把焦点还给卡片而不是被 inert 顶掉）
    expect(screen.getByTestId("shell-page").hasAttribute("inert")).toBe(false);
    expect(scrollRoot.className).not.toContain("scroll-locked");
    // 关闭归还焦点：回到开启预览前拿焦点的那张卡片（层没了，焦点不该掉回 body）
    expect(document.activeElement).toBe(card);
  });

  it("引擎忙：批量重绘按钮禁用且不起跑（不抢发指令）", async () => {
    useGameStore.setState({ engineBusy: true });
    render(<AssetsScreen />);
    await waitFor(() => expect(screen.getByTestId("assets-select-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("assets-select-toggle"));
    fireEvent.click(screen.getByTestId("assets-select-all"));

    expect((screen.getByTestId("assets-regen-selected") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("assets-regen-selected"));
    expect(prompts).toEqual([]);
    expect(useGameStore.getState().regenQueue).toEqual([]);
  });
});
