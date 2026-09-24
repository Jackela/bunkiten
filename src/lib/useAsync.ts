// 一次异步取数的通用形态（v1.13）：把此前散在 7 个屏里手抄的 load/error/abort effect 收成一处。
//
// 每个屏的旧写法都差不多——`new AbortController()`、`loading`/`error` 两个 state、`.then` 里写数据、
// `.catch` 里判 AbortError、卸载时 `abort()`——但细节各写各的，于是漏了 `signal.aborted` 复查
// （AssetsScreen 的过期应答会落到已卸载的屏上）。本 hook 统一：
//   · AbortController 随 key 变化与卸载中止；
//   · **写回前统一复查 `signal.aborted`**——过期应答不许落到已卸载/已换 key 的屏上；
//   · 对外是 `data` / `loading` / `error` / `reload` 四个面，`reload` 用于「重试」与「动作后重取」。
//
// 约定（exhaustive-deps 友好）：`load` 的依赖**不**进 effect deps——只认 `key`。调用方把 `load` 用到的
// 每个输入拼进 key（如 `` `${presetId}:${stamp}` ``），key 变才重取；`key === null`（或 `enabled:false`）
// 表示「暂不取数」（如还没选剧本），此时清空 data/error、loading=false。
import { useCallback, useEffect, useRef, useState } from "react";

/** hook 的对外面 */
export interface AsyncResult<T> {
  /** 最近一次成功的数据；还没成功（加载中/失败/未启用）时为 null */
  data: T | null;
  loading: boolean;
  /** 屏上文案（缺省 `String(e)`；用 mapError 可换成玩家话，如 404 的兜底） */
  error: string;
  /** 重新取数（重试按钮、动作后刷新）；换 key 会自动取数，不必手动调 */
  reload: () => void;
}

export interface UseAsyncOptions {
  /** false 与 `key === null` 同义：不取数（用于「开关式」取数）。缺省 true */
  enabled?: boolean;
  /** 错误 → 屏上文案（缺省 `String(e)`）。需要映射（如把 404 说成人话）时传入 */
  mapError?: (e: unknown) => string;
  /**
   * key 变化时是否先把 data 清空。缺省 **false**：保留旧数据直到新数据到——
   * 列表/画廊重取时不清空，React 按 key 复用同一批 DOM 节点（元素身份不丢，焦点归还等行为才稳）；
   * 需要「换世界线立刻清屏、显示载入中」的场景（如剧情树换世界/换 stamp）显式传 true。
   */
  resetOnKey?: boolean;
}

/**
 * 取一次异步数据并管好 loading/error/abort。
 * @param load 取数函数（收到 AbortSignal；依赖请拼进 key，别指望本 hook 跟踪 load 的闭包）
 * @param key 取数标识（变化即重取；null = 不取数）。把 load 用到的每个输入都拼进来
 * @param options.enabled 同 key===null 的开关式禁用；options.mapError 错误文案映射
 * @returns {{data, loading, error, reload}} 见 {@link AsyncResult}
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string | null,
  options: UseAsyncOptions = {},
): AsyncResult<T> {
  const { enabled = true, mapError, resetOnKey = false } = options;
  const active = enabled && key !== null;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  // load / mapError 的最新闭包：不进 effect deps（否则每次渲染都重取）；靠 key 描述依赖。
  const loadRef = useRef(load);
  const mapErrorRef = useRef(mapError);
  useEffect(() => {
    loadRef.current = load;
    mapErrorRef.current = mapError;
  }, [load, mapError]);

  // 上一次跑过的 key：resetOnKey 时用来判断「是不是换了 key」（换 key 才清 data，reload 不清）
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) {
      lastKeyRef.current = key;
      setData(null);
      setError("");
      setLoading(false);
      return;
    }
    const keyChanged = lastKeyRef.current !== key;
    lastKeyRef.current = key;
    if (resetOnKey && keyChanged) setData(null); // 显式要求时：换 key 先把旧数据清掉（如换世界线）
    setLoading(true);
    setError("");
    const ctrl = new AbortController();
    loadRef
      .current(ctrl.signal)
      .then((r) => {
        // 统一复查：卸载或换 key 后中止的请求，应答一律丢弃（AssetsScreen 此前漏的正是这一句）
        if (!ctrl.signal.aborted) setData(r);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e as Error | undefined)?.name === "AbortError") return;
        setError(mapErrorRef.current ? mapErrorRef.current(e) : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [key, tick, active, resetOnKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}
