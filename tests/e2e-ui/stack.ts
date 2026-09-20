// 假引擎 UI e2e 的栈样板（tests/e2e-ui/ 内部复用）：把每个 spec 重复的同一段引导收在一处——
// 起栈（tests/helpers/fake-stack.mjs：假 ACP 引擎 + 真 acp-server + vite dev）、开一个全新
// context+page、收尾（关页面 → 停栈）。
// 为什么不并进 flow.ts：flow.ts 是「页面里怎么走」（屏幕流导航），这里是 Playwright 生命周期
// 与进程编排，依赖与失效模式都不同；分开后 flow.ts 保持零生命周期依赖，栈引导只有一个家。
// 收尾顺序与 fake-stack.mjs 文件头一致：先关页面（vite 是页面入口，先关入口），再 stack.stop()
//（内部先停 vite 再停 acp-server 并删临时 game root）；page.close() 仍带 catch(()=>{}) 容忍。
// 选项类型按 harness.mjs / fake-engine.mjs 的文件头注释写（harness 的 JSDoc 只到 `object`，
// 直接拿 Parameters<> 推会让 spec 里的对象字面量全部落进 excess property check）。
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { startFakeStack } from "../helpers/fake-stack.mjs";

/** 一次 session/prompt 的回放 op：文本 chunk / {tool} tool_call / {error} 中止（见 fake-engine.mjs 头） */
type FakeOp = string | { tool: string } | { error: string };

/** startStack 的选项（tests/integration/harness.mjs 顶部注释的镜像，键名与语义一一对应） */
export interface UiStackOptions {
  /** fake-engine 的脚本队列；元素为纯文本（顺次消费）或 {match, ops}（按子串命中） */
  turns?: ReadonlyArray<string | { match: string; ops: ReadonlyArray<FakeOp> }>;
  /** 预置剧本；string 只给 id，对象形态可覆盖标题并追加 body 小节 */
  presets?: ReadonlyArray<string | { id: string; title?: string; body?: string }>;
  /** 预置会话图片：文件名 → 内容 */
  sessionImages?: Record<string, string | Uint8Array>;
  /** 预置资产：presetId → presets/<id>/assets/ 下的文件 */
  assets?: Record<string, ReadonlyArray<{ name: string; bytes: Uint8Array }>>;
  /** 预置音频：presetId → presets/<id>/audio/ 下的文件 */
  audioFiles?: Record<string, ReadonlyArray<{ name: string; bytes: Uint8Array }>>;
  /** 覆盖世界树：worldId → story-tree.md 全文 */
  trees?: Record<string, string>;
  /** 覆盖世界状态文件：worldId → state.md 全文（角色面板用例） */
  stateFiles?: Record<string, string>;
  /** 追加世界（w1 之外；复用同一套三文件生成逻辑） */
  worlds?: ReadonlyArray<{
    id: string;
    title?: string;
    preset?: string;
    chapterNo?: number;
    lastPlayed?: number;
    note?: string;
    forkedFrom?: string | null | { worldId: string; nodeId: string };
  }>;
  /** 预置逐轮快照：worldId → history/NNNN.json 条目（与 server writeSnapshot 落盘形状一致） */
  snapshots?: Record<
    string,
    ReadonlyArray<{
      seq: number;
      at?: string;
      kind: "turn" | "backup";
      nodeId: string | null;
      chapterNo: number | null;
      files: { state: string | null; summary: string | null; tree: string | null };
    }>
  >;
  /** 是否写临时 HOME 的 `~/.grok/auth.json`（缺省 "ok"；"missing" = boot 屏未登录态用例的前置） */
  auth?: "ok" | "missing";
  /** 非默认浏览上下文（如 reduced-motion 用例的 { reducedMotion: "reduce" }）；不进 startFakeStack */
  contextOptions?: BrowserContextOptions;
}

/** 一套已启动的假引擎 UI 栈（startFakeStack 的返回：stack.root / pageUrl / stop） */
export type StartedStack = Awaited<ReturnType<typeof startFakeStack>>;

/** 起栈 + 开一个全新 context/page：spec 里 `({ stack, page } = await startUiStack(browser, {...}))` */
export async function startUiStack(
  browser: Browser,
  options: UiStackOptions = {},
): Promise<{ stack: StartedStack; page: Page }> {
  const { contextOptions, ...stackOptions } = options;
  const stack = await startFakeStack(stackOptions);
  const page = await (await browser.newContext(contextOptions)).newPage();
  return { stack, page };
}

/** 收尾：先关页面再停栈（顺序与容忍度与迁移前的 afterAll 逐字一致） */
export async function stopUiStack(page: Page | undefined, stack: StartedStack | undefined): Promise<void> {
  if (page) await page.close().catch(() => {});
  await stack?.stop();
}
