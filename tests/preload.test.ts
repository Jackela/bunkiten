// lib/preload 单测（node 环境，无 jsdom）：立绘差分预热的三条硬约束——
//   ① 清单**每剧本只拉一次**（在途/已完成/已判定失败三条路都复用同一条 promise）；
//   ② 命中角色的**全部**立绘（基础 + 各差分）都进预载；其他角色、背景、未就绪项一律不动；
//   ③ 任何失败静默（不抛、不重拉、不预载）——没有清单只意味着「不预热」，演出照常。
// 模块只依赖两个宿主 API（fetch / Image），垫掉它们就能在 node 里确定性地断言「打了几个接口、预载了哪些 URL」。
// 每个用例用**各自的 preset id**（p1/p2/…）：模块级清单缓存按 preset 记账，复用同一个 id 会让后面的
// 用例直接吃前一个用例的缓存（fetch 一次都没打，还看不出为什么红）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadImage, warmPortraitVariants } from "../src/lib/preload";

/** 手工 Image 垫片：每次挂 src 记一笔（预载路径只做这一件事，模块不读 onload/onerror） */
class FakeImage {
  /** 按赋值顺序记下所有预载 URL */
  static warmed: string[] = [];
  /** 建过多少个图片对象（去重断言用：一个 URL 只该有一个） */
  static images = 0;
  #src = "";
  constructor() {
    FakeImage.images += 1;
  }
  get src(): string {
    return this.#src;
  }
  set src(v: string) {
    this.#src = v;
    FakeImage.warmed.push(v);
  }
}

/** 一次宏任务冲洗：预载链全在微任务里跑，等一个 setTimeout 就够（不引假定时器，避免多一层时序假设） */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 假 /api/assets 条目（形状与 server listAssets 对齐：数组本体，不是包壳对象） */
function entry(preset: string, name: string, variant = "", type: "立绘" | "背景" = "立绘", ready = true) {
  const file = `presets/${preset}/assets/${type}-${name}${variant ? `-${variant}` : ""}.jpg`;
  return { type, name, variant, preset, file, ready, inUse: false, mtime: 1 };
}

/** 把清单塞进假 fetch；返回调用记录 */
function stubAssets(items: unknown) {
  const mock = vi.fn(async () => new Response(JSON.stringify(items), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** 预载 URL 的可读形态（断言用解码后的路径，别在用例里手写一长串 %E8%96%87…） */
const warmedUrls = () => FakeImage.warmed.map(decodeURIComponent);

beforeEach(() => {
  FakeImage.warmed = [];
  FakeImage.images = 0;
  vi.stubGlobal("Image", FakeImage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preload：立绘差分预热（warmPortraitVariants）", () => {
  it("同一剧本的清单只拉一次：重复/并发调用共用一条请求，角色的全部差分都进预载", async () => {
    const fetchMock = stubAssets([
      entry("p1", "薇拉"),
      entry("p1", "薇拉", "微笑"),
      entry("p1", "薇拉", "愤怒"),
      entry("p1", "艾达"),
      entry("p1", "教堂", "", "背景"),
    ]);
    warmPortraitVariants("p1", "薇拉");
    warmPortraitVariants("p1", "薇拉"); // 第二次（同角色）与第一次共用清单，且预载 URL 去重

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toBe("/api/assets?preset=p1");
    expect(warmedUrls()).toEqual([
      "/img?p=presets/p1/assets/立绘-薇拉.jpg",
      "/img?p=presets/p1/assets/立绘-薇拉-微笑.jpg",
      "/img?p=presets/p1/assets/立绘-薇拉-愤怒.jpg",
    ]);
    expect(FakeImage.images).toBe(3); // 去重：同一 URL 不会建第二个 Image
  });

  it("只有该角色的立绘进缓存：换角色走清单缓存不重拉，其他角色/背景/未就绪项都不预载", async () => {
    const fetchMock = stubAssets([
      entry("p2", "薇拉"),
      entry("p2", "薇拉", "微笑"),
      entry("p2", "艾达"),
      entry("p2", "教堂", "", "背景"),
      entry("p2", "薇拉", "未完成", "立绘", false), // ready:false = 还没有对应落盘文件
    ]);
    warmPortraitVariants("p2", "薇拉");
    await flush();
    warmPortraitVariants("p2", "艾达"); // 同一剧本的第二个角色：清单已缓存，不再打接口
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warmedUrls()).toEqual([
      "/img?p=presets/p2/assets/立绘-薇拉.jpg",
      "/img?p=presets/p2/assets/立绘-薇拉-微笑.jpg",
      "/img?p=presets/p2/assets/立绘-艾达.jpg",
    ]);
  });

  it("名字比对与制作中屏清点同源：空白归一后互为包含即命中（marker 与落盘名的等价关系只有这一条）", async () => {
    stubAssets([entry("p3", "薇拉"), entry("p3", "薇 拉", "微笑")]);
    warmPortraitVariants("p3", " 薇拉 ");
    await flush();

    expect(warmedUrls()).toEqual([
      "/img?p=presets/p3/assets/立绘-薇拉.jpg",
      "/img?p=presets/p3/assets/立绘-薇 拉-微笑.jpg",
    ]);
  });

  it("清单不可用（HTTP 404）静默：不抛错、不预载、本会话不再重拉", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(() => warmPortraitVariants("p4", "薇拉")).not.toThrow();
    await flush();
    warmPortraitVariants("p4", "薇拉");
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1); // 失败记账：同一个本不再打第二次
    expect(FakeImage.images).toBe(0);
  });

  it("网络失败（fetch reject）同样静默：不产生 unhandled rejection，也不预载", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", fetchMock);

    warmPortraitVariants("p5", "薇拉");
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeImage.images).toBe(0);
  });

  it("没有剧本上下文或缺角色名：接口都不打（宁可不预热，也不构造坏请求）", async () => {
    const fetchMock = stubAssets([]);
    warmPortraitVariants("", "薇拉");
    warmPortraitVariants("   ", "薇拉");
    warmPortraitVariants("p6", "");
    warmPortraitVariants("p6", "  ");
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeImage.images).toBe(0);
  });
});

describe("preload：preloadImage（单图预热）", () => {
  it("同一 URL 只预载一次；空 URL 忽略", () => {
    preloadImage("/img?p=x.jpg");
    preloadImage("/img?p=x.jpg");
    preloadImage("");
    expect(FakeImage.images).toBe(1);
    expect(warmedUrls()).toEqual(["/img?p=x.jpg"]);
  });

  it("无 Image 构造器的环境（服务端渲染/node）静默 no-op，绝不抛错", () => {
    vi.stubGlobal("Image", undefined);
    expect(() => preloadImage("/img?p=y.jpg")).not.toThrow();
  });
});
