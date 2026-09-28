// characters slice（v1.7）：角色面板抽屉——游戏屏侧栏查看引擎维护的角色状态
//（好感度/表情/秘密/最近互动/导演手记等，数据源 `GET /api/state` 读世界 state.md）。
// 只管开合与取数：打开拉一次、回合收尾由 gameplay 重拉（见该 slice 的 turn_end）、
// 换世界/resetRunState 清空；渲染（含秘密剧透折叠）全在 CharactersDrawer 组件。
// v1.14：取数多带一条「与上一份视图的数值差分」（lastTurnDeltas）——回合收尾**恒**刷新（不再只在面板
// 开着时），差分是每一回合都要看的因果反馈；纯函数 diffStateViews 导出给单测直引。
import { fetchState, type StateView } from "../../lib/acp";
import type { SliceContext } from "../context";
import type { GameStore, TurnDelta } from "../types";

/** 取字符串里**首个整数**（差分口径：flags 的值形如「65」「第 3 章」「雨夜（2/5）」） */
function leadingInt(value: string): number | null {
  const m = (value ?? "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * 两份 state.md 视图的数值差分（纯函数，单测直引；v1.14）：
 * - favor 走结构化数值（两边都是数字才比较）；
 * - flags 走「值里首个整数」的口径（任一边抽不到数字就跳过——那种变化说不清大小）；
 * - 只有**真的变了**的项才入列；一项都没有、或没有可比基线（prev 为 null，如首次拿到视图）时返回 null。
 *
 * 为什么只给数值：差分条是「因果反馈」不是状态面板——`排异指数 65 → 73 ↑` 一眼有用，
 * 把「时间」「场景」这类文字变化也铺上去只会淹没它。文字类变化看角色面板。
 * `dir` 的第三态「same」是契约保留（数值相同的项不入列，当前只产 up/down）。
 * @param prev 上一份视图（null = 没有可比基线）
 * @param cur 刚拉到的一份
 * @returns 变化项列表；无变化/无基线为 null
 */
export function diffStateViews(prev: StateView | null, cur: StateView): TurnDelta[] | null {
  if (!prev) return null;
  const out: TurnDelta[] = [];
  const beforeChar = new Map(prev.characters.map((c) => [c.name, c]));
  for (const c of cur.characters) {
    const before = beforeChar.get(c.name);
    if (!before || before.favor === null || c.favor === null || before.favor === c.favor) continue;
    out.push({
      name: c.name,
      from: String(before.favor),
      to: String(c.favor),
      dir: c.favor > before.favor ? "up" : "down",
    });
  }
  const beforeFlag = new Map(prev.flags.map((f) => [f.name, f.value]));
  for (const f of cur.flags) {
    if (!beforeFlag.has(f.name)) continue;
    const a = leadingInt(beforeFlag.get(f.name) ?? "");
    const b = leadingInt(f.value);
    if (a === null || b === null || a === b) continue;
    out.push({ name: f.name, from: String(a), to: String(b), dir: b > a ? "up" : "down" });
  }
  return out.length > 0 ? out : null;
}

export function createCharactersSlice(
  ctx: SliceContext<"set" | "get">,
): Pick<GameStore, "toggleCharacters" | "refreshCharacters" | "refreshTurnState"> {
  const { set, get } = ctx;

  /**
   * 拉一次 `/api/state` 落 {@link GameStore.stateView}，并把这一份落成新的差分基线
   * （{@link GameStore.prevStateView}）。404（还没写过 state.md）或请求失败保持原值——
   * null 就是面板的空态（占位说明文案）；await 期间换世界则整份丢弃。
   * @param {boolean} withDeltas 回合收尾时顺带产出 lastTurnDeltas（与**这一份之前**的基线对比）
   */
  const loadStateView = (withDeltas: boolean) => {
    const worldId = get().worldId;
    if (!worldId) return;
    fetchState(worldId)
      .then((v) => {
        if (get().worldId !== worldId) return; // await 期间换世界/回标题：旧世界的视图不许回填进新世界
        // 基线必须在写入之前取：写入之后 prevStateView 已经是这一份，差分恒为空
        const baseline = get().prevStateView;
        set({
          stateView: v,
          prevStateView: v,
          ...(withDeltas ? { lastTurnDeltas: diffStateViews(baseline, v) } : {}),
        });
      })
      .catch(() => {
        // 404 或网络异常：保持原值；差分也保持原样（面板打开时的重拉不该把刚出的差分条抹掉）
      });
  };

  return {
    toggleCharacters() {
      const open = !get().charactersOpen;
      set({ charactersOpen: open });
      // 打开即取一次数；关闭不拉（下次打开再拉，期间 state.md 一定变过）
      if (open) get().refreshCharacters();
    },

    refreshCharacters() {
      loadStateView(false);
    },

    refreshTurnState() {
      // v1.14：回合收尾恒刷新（不再看 charactersOpen）——数值差分与面板数据都随回合变
      loadStateView(true);
    },
  };
}
