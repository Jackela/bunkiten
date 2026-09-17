// characters slice（v1.7）：角色面板抽屉——游戏屏侧栏查看引擎维护的角色状态
//（好感度/表情/秘密/最近互动/导演手记等，数据源 `GET /api/state` 读世界 state.md）。
// 只管开合与取数：打开拉一次、turn_end 后面板开着由 gameplay 重拉（见该 slice 的 turn_end）、
// 换世界/resetRunState 清空；渲染（含秘密剧透折叠）全在 CharactersDrawer 组件。
import { fetchState } from "../../lib/acp";
import type { StoreContext } from "../context";
import type { GameStore } from "../types";

export function createCharactersSlice(ctx: StoreContext): Pick<GameStore, "toggleCharacters" | "refreshCharacters"> {
  const { set, get } = ctx;

  return {
    toggleCharacters() {
      const open = !get().charactersOpen;
      set({ charactersOpen: open });
      // 打开即取一次数；关闭不拉（下次打开再拉，期间 state.md 一定变过）
      if (open) get().refreshCharacters();
    },

    refreshCharacters() {
      const worldId = get().worldId;
      if (!worldId) return;
      fetchState(worldId)
        .then((v) => {
          // await 期间换世界/回标题：旧世界的视图不许回填进新世界
          if (get().worldId !== worldId) return;
          set({ stateView: v });
        })
        .catch(() => {
          // 404（还没写过 state.md）或网络异常：保持原值——null 就是面板的空态（占位说明文案）
        });
    },
  };
}
