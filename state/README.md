# state/

运行时进度，按「世界线」组织：一个世界一个目录 `state/worlds/<worldId>/`；同一条世界线就是一局存档。

- `worlds/<worldId>/state.md` — 剧情状态（角色卡、好感度、Flags、伏笔、导演手记），每轮更新
- `worlds/<worldId>/summary.md` — 滚动摘要，每 8-12 轮压缩追加
- `worlds/<worldId>/story-tree.md` — 当前章剧情树（节点/出边/剪枝/嫁接/进度指针）
- `worlds/<worldId>/fork.md` — 分叉回退说明，只在该世界首次「继续」时存在，引擎校准 state/summary 后自动删除
- `worlds/<worldId>/*.bak.md` — /new-game 重开后保留的上一周目存档（state.bak.md / summary.bak.md）
- `worlds/index.json` — 世界线索引（worldId / preset / title / chapterNo / lastPlayed / note / forkedFrom）

删除某个世界目录 = 删掉那一局（正常玩法在世界线屏点「删除」即可）；整个 `worlds/` 删掉 = 重置全部进度（引擎会重新初始化）。v1.5 之前的旧扁平布局（本目录下的 `state.md` / `summary.md`）会在应用首次启动时由 server 一次性迁入 `worlds/main/`。

## 回收站（v1.7）

删除世界线或画廊素材**不是直删**：server 先把整个目录/文件挪进 `state/trash/`（同卷 rename，原子），挪不进去（如跨磁盘的 EXDEV）才回退直删。恢复路径只走手工文档，不做恢复 UI（ADR-0014）。

- 命名规则：`trash/<删除时间戳ms>-<随机4字符>[-<剧本id>]-<原名>/`（世界线是目录、素材是文件；素材条目带剧本 id 标注归属，跨剧本同名文件靠它区分该挪回哪个剧本），例：
  - `state/trash/1758000000000-a1b2-campus-summer-1/`（一局世界线，三文件与 history/ 都在里面）
  - `state/trash/1758000000000-a1b2-rift-mark-立绘-薇拉.jpg`（rift-mark 剧本的一张素材）
- **手工找回世界线**：把 `<ts>-xxx-<worldId>/` 目录挪回 `state/worlds/<worldId>/`，再在 `state/worlds/index.json` 的数组里补一条（`worldId` 必须与目录名一致）：

  ```json
  {
    "worldId": "campus-summer-1",
    "preset": "campus-summer",
    "title": "盛夏偏差值",
    "label": "",
    "note": "",
    "chapterNo": 3,
    "lastPlayed": 1758000000000,
    "forkedFrom": null
  }
  ```

  重启应用（或重进世界线屏）即可看到并继续。索引不补的话目录会一直在但列表不显示。
- **手工找回素材**：把 `<ts>-xxx-<剧本id>-<文件名>` 挪回 `presets/<剧本 id>/assets/<文件名>`——注意剥掉 trash 前缀（含剧本 id 段），文件名必须还原成原名；剧本 id 就在前缀里。
- **保留策略**：不自动清理、不设上限，玩家觉得没用了手动删 `state/trash/` 即可。
