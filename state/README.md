# state/

运行时进度，按「世界线」组织：一个世界一个目录 `state/worlds/<worldId>/`；同一条世界线就是一局存档。

- `worlds/<worldId>/state.md` — 剧情状态（角色卡、好感度、Flags、伏笔、导演手记），每轮更新
- `worlds/<worldId>/summary.md` — 滚动摘要，每 8-12 轮压缩追加
- `worlds/<worldId>/story-tree.md` — 当前章剧情树（节点/出边/剪枝/嫁接/进度指针）
- `worlds/<worldId>/fork.md` — 分叉回退说明，只在该世界首次「继续」时存在，引擎校准 state/summary 后自动删除
- `worlds/<worldId>/*.bak.md` — /new-game 重开后保留的上一周目存档（state.bak.md / summary.bak.md）
- `worlds/index.json` — 世界线索引（worldId / preset / title / chapterNo / lastPlayed / note / forkedFrom）

删除某个世界目录 = 删掉那一局（正常玩法在世界线屏点「删除」即可）；整个 `worlds/` 删掉 = 重置全部进度（引擎会重新初始化）。v1.5 之前的旧扁平布局（本目录下的 `state.md` / `summary.md`）会在应用首次启动时由 server 一次性迁入 `worlds/main/`。
