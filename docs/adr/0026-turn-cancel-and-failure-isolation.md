# 回合取消与失败隔离（`POST /api/engine/cancel`、回合序号、`turn_cancelled`、失败留痕与 `stale` 重同步）

**问题**：一个正戏回合可以跑满 600s（`session/prompt` 超时）——引擎卡住、模型话痨、或玩家自己改主意，客户端**都没有办法停下来**。`busy` 一旦置位就锁到回合自然收尾：玩家只能看着「故事展开中…」转圈，重开/换剧本被 409 挡回，连「重演」都进不去。这不是 UI 缺按钮，是**服务端没有「作废在途回合」这个语义**——在它之前，唯一的收尾路径是 `session/prompt` 的 promise resolve（成功）或 reject（失败），中间态不可打断。

裁决四件事，都在服务端的回合记账面上（`server/turn-pipeline.mjs`）。

其一，**回合序号**。`sendPrompt` 每启动一个回合拿一个单调递增的 `t`（模块内 `turn` 计数器，`currentTurn` 记当前在跑的哪个）；`turn_start`/`chunk`/`seg`/`turn_end`/`error` 事件全部带 `t`。序号是**迟到判定的抓手**：`session/prompt` 的响应、追问的响应、超时异常到达时都先比对 `currentTurn !== myTurn` ——不等就说明这一回合**已经被取消或被取代**，直接归位（不写快照、不广播 `turn_end`、也不再报一次错）。没有序号的话，「取消之后引擎终于把那半截正文吐回来」会混进下一回合的 `turnText` 与快照，是比不能取消更糟的脏数据。

其二，**取消是本地的、即时生效的**（`POST /api/engine/cancel` → `{ok, cancelled}`，`cancelled` 为布尔：空闲时回 `false` 而非错误——客户端可能比服务端先知道回合已收尾）。`turns.cancel()` 三步：① 关掉 chunk 闸（`acceptChunks=false`，迟到的正文不累加、不上屏）；② 把已产出的协议行照常扫完落定（`flushArtLines()` ——美术标记先到先落盘，取消不该吞掉已经拿到的素材）；③ `busy` 复位、`currentTurn` 归零 → 广播 `{type:"turn_cancelled", turn}` → 留一条 `cancelled:true` 的回合日志（**不写快照**：这一轮没推进状态）。同时经 ACP 的通用通道发一条 `session/cancel` 通知请引擎别再产出——那条通知**发不发得出去都不影响**上面的本地收尾（引擎不配合也拦不住我们把账记平）。客户端收到 `turn_cancelled` 后置 `pendingResync`（下一句输入先重同步），因为引擎侧可能已经写了一半盘。

其三，**失败隔离与留痕**。回合失败（超时/引擎退出/引擎按 JSON-RPC 回 error response）走 catch：`busy` 复位、`currentTurn` 归零、写一条带 `error` 字段的回合日志（`logs/NNNN.json` 条目从 `{seq,at,prompt,text}` 扩成可选 `cancelled?`/`error?`——「这一轮发了什么、引擎回了什么/为什么没回」可回溯），并广播 `{type:"error", turn, error, message, stale:true}`（`error` 与 `message` 同值：后者是既有客户端字段，前者是冻结的事件面，等客户端统一后再删 `message`）。**`stale` 的语义**是给客户端的对账指令：超时/中断都可能让引擎**写了一半盘**（state 半更新、快照没落），所以客户端此时的正确动作是**先重同步**（补发 `继续世界：<worldId>。` 让引擎重读档）再继续，而不是当作「这一轮什么也没发生」直接发下一句。回合照常可继续，只是先对一次账。

其四，**忙碌期强制重启**（`POST /api/engine/restart {force:true}`）。默认语义不变：回合进行中重启**拒绝**（409）——杀进程等于把这一回合的推演连同落盘一起截断（客户端会停在「待重同步」态），宁可让玩家等这一回合结束。`force:true` 是给「引擎明显卡死、等不下去」那条路的：先 `session/cancel` + `turns.cancel()` 本地作废这一回合（留痕、不写快照），给引擎 500ms 吐完尾巴，然后**无论如何**杀掉旧进程、按当前凭据重建会话。切引擎时旧会话的 `.shell-session.json` 里的 `sessionId` 会因 `engine` 标记不匹配被 boot 跳过（走 `session/new`）。

配套：`GET /api/engine/status` → `{busy, turn}` 是 SSE 断线重连后的**对账面**（`busy` 决定「停止」按钮可不可点，`turn` 让客户端跟已收到的 `turn_end` 比、判断断线期间漏没漏收尾）；`turn_end` 增 `{turn, main, seq}`——`main` 为 `false` 的非主回合（`继续世界：` 触发的重同步）`seq:null`、不进快照 / 不进 history / 不占幕号。`cancelled` 与 `error` 两个日志字段是**纯增字段**：老读者忽略即可（`readTurnLogs` 原样透传），不给它们做版本闸。

边界与代价：其一，取消**不保证引擎停下**产出（`session/cancel` 是通知，引擎可能继续吐）——本地闸门与序号丢弃兜住后果，代价是引擎进程可能白跑一会儿。其二，`cancelled` 回合**不写快照**，所以它不占幕号、重演看不到它（符合「取消 = 这一轮没发生」的语义），但它的原文仍在 logs 里可查。其三，`stale` 只是**建议**，服务端无法替客户端判断「引擎到底有没有写坏盘」，只能把「这一回合可能留下了半成品」这个事实摆出来。其四，`turn` 是进程内计数器、重启从 0 起，跨重启不连续——它是对账面不是持久账本（持久面仍是 `history`/`logs` 的 seq）。被否决：**客户端本地忽略在途回合、不发取消**（服务端 `busy` 不复位，下一次 send 撞 409）；**取消即杀进程**（比 `force` 重启更粗暴，且「保存 key 后重启」与「玩家点停止」是两件事，不该共用一条杀进程路径）；**给被取消的回合也写快照**（它没推进状态，写进去只会污染重演/回退）；**busy 期一律拒绝重启、不给 force**（正是要修的「等不下去」场景的另一半）。相关：`docs/ARCHITECTURE.md`「HTTP / SSE API 一览」「回合日志与质量守卫」、`server/sse.mjs`（帧 `id:` + 20s 心跳，重连对账的另一半）。
