// 登录等待轮询的单测（v1.11 收尾）：src/lib/engine-login.ts——启动屏与设置屏的一键登录都靠它。
// 每条都对着「改坏哪一处会红」：成功回调只调一次 / 超时回调与自停 / 取消立刻生效 / 单轮失败不算数。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchLogin } from "../src/lib/engine-login";
import { jsonResponse } from "./helpers/http-doubles.mjs";

describe("watchLogin：登录等待的轮询", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("看到登录态就回调一次并自停（之后不再打扰 /api/auth）", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ loggedIn: calls >= 2, hasCredentials: false });
      }),
    );
    const onLoggedIn = vi.fn();
    watchLogin(onLoggedIn, { intervalMs: 100, timeoutMs: 10_000 });

    await vi.advanceTimersByTimeAsync(100); // 第一轮：还没登录
    expect(onLoggedIn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); // 第二轮：登录了
    expect(onLoggedIn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // 自停后不再问
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("hasCredentials 也算「能开玩」：自备 key 的引擎同样自动继续", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ loggedIn: false, hasCredentials: true })),
    );
    const onLoggedIn = vi.fn();
    watchLogin(onLoggedIn, { intervalMs: 100, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
  });

  it("超时就回调 onTimeout 并停表（玩家没完成时给一句人话，而不是永远转圈）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ loggedIn: false, hasCredentials: false }));
    vi.stubGlobal("fetch", fetchMock);
    const onTimeout = vi.fn();
    watchLogin(() => {}, { intervalMs: 100, timeoutMs: 250, onTimeout });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const after = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.length).toBe(after); // 已停表
  });

  it("取消后立刻停（再次点登录 / 切屏时不该还挂着上一轮的轮询）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ loggedIn: false, hasCredentials: false }));
    vi.stubGlobal("fetch", fetchMock);
    const onLoggedIn = vi.fn();
    const cancel = watchLogin(onLoggedIn, { intervalMs: 100, timeoutMs: 10_000 });

    await vi.advanceTimersByTimeAsync(100);
    cancel();
    const after = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.length).toBe(after);
    expect(onLoggedIn).not.toHaveBeenCalled();
    cancel(); // 幂等：重复取消不炸
  });

  it("单轮读失败不打断等待（网络抖一下不该把整次登录作废）", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return jsonResponse({ loggedIn: true, hasCredentials: false });
      }),
    );
    const onLoggedIn = vi.fn();
    watchLogin(onLoggedIn, { intervalMs: 100, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(300);
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
  });
});
