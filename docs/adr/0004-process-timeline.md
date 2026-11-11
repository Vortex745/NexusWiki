# ADR 0004: 过程时间线与子代理指示器

日期：2026-11-09　状态：已采纳　部分取代：ADR 0003 第 2 条「不建子代理事件桥」　实现：2f0f050 + 88e6b32

## 背景

聊天时间线原本只有单行工具摘要和单行 Worker 活动预览。用户看不到每次工具执行的输入、输出与失败现场。一个 Worker 内部的多个工具调用被压成一条不断覆盖的活动行。一轮里多个思考块还会因为 key 用 `contentIndex` 而合并成一行。用户要求按参考图把不同工具执行分开显示，并在 Worker 调用 pi-subagent 时，在界面其他位置提示「正在调用 xx 子智能体」，点击后能看具体过程。

## 决定

1. Router 自己的工具执行改用 `tool_execution_start/update/end` 作为唯一生命周期来源。事件携带展示类型、有界输入、累计或最终输出、`isError`、`aborted`、`durationMs`。主时间线把同一 anchor 的连续思考与工具行收进一个可折叠过程组，组头无失败时显示「执行工具 N 次」，有失败时追加「，其中 K 次失败」。每个工具行独立展开输入与输出，纯文本渲染，不解析 markdown。
2. 思考块 key 改为 run 内单调计数，不再使用每条 assistant 消息都会重置的 `contentIndex`。一轮里的多个「已思考」保持独立。
3. 子智能体只指 Worker 内部的 pi-subagent，不扩展到 Worker 任务本身。Worker 订阅自己的 `tool_execution_*`，只透出 `toolName === 'subagent'` 的 start/update/end，经 `chat:subagent-step` 推给渲染层。dispatcher 为每个任务补 `taskId` 与单调 `seq`。
4. header 右侧放一个胶囊。运行中显示「正在调用 <agent> 子智能体」，多个任务显示数量。结束后保留最近一次结果，直到下一次用户发送。点击打开右侧抽屉。
5. 抽屉优先回放子会话 JSONL。Worker 会话里 `subagent` 工具的 `toolResult.details.results[0].sessionFile` 指向子会话文件。主进程校验它是 `agentDir` 下的 `.jsonl` 后，用 `SessionManager` 读出子代理自己的思考与工具调用，逐条展示。实时 progress 作为运行中的补充。文件缺失或读取失败时退回实时进展与最终输出，不向渲染层抛错。
6. 所有输入与输出按 Unicode code point 截断到 4000 字符。子代理最近输出保留 20 行、每行 300 字符。单次详情最多 200 步。主时间线步骤默认收起，失败用红色图标与「运行失败」表达，不自动展开，避免过程区随输出长高。
7. Router 工具行仍然只做实时展示，不写入历史恢复。子代理详情按需从已有会话文件回放；Worker 会话文件只用于定位子会话，Worker 自身工具轨迹不展示。不新增数据库表。

## 备选方案

- 平铺所有工具行，不加组头。单工具回合更安静，但多工具回合会拉长聊天。Jev 首选组头，保留组头，并在只有思考时改标题。
- 点击后就地展开子代理过程。会推走后续消息。选择右侧抽屉，保持聊天可见。
- 把 Worker 任务也做成详情视图。超出本轮诉求。只做 pi-subagent，避免与任务行重复。
- 过程步骤持久化到 SQLite。写入量大，且已有 Worker 会话 JSONL。按需回放更轻。

## 后果

- 新增一个事件通道与一个 invoke 通道。preload 与渲染层各增加一个订阅面。
- header 多一个状态胶囊。聊天页多一个非模态抽屉，不改变单列布局。输入区在抽屉之上，打开抽屉时仍可继续输入与发送。
- 子代理详情的完整度取决于子会话文件是否可用。文件不可用时 UI 展示实时进展与已到达的最终输出，并在文案上说明。
- ADR 0003 的「Worker 内 subagent 不建事件桥」在展示层被取代。这是 UI 详情通道，不改变 Router 与 Worker 分层，也不恢复被删除的 Router subagent 镜像。
- 不新增依赖，不修改 SQLite schema。

## 验证

- `npm run typecheck`、`npm run lint`、`npm test`、`npx electron-vite build` 全绿。测试 167/167，主 JS 7,382.39 kB。
- CDP fake 27/27。代码提交信息里的 26/26 是加最后一条断言前的一轮，以最终探针为准。覆盖 bash 工具行与展开输出、子代理 start/update/end、胶囊运行态与完成态、抽屉子会话回放（`编辑文件` 步骤）、失败组头与错误输出、零 console 异常。截图在 `.tmp/process-timeline-accept/timeline.png` 与 `drawer.png`（`.tmp` 不入库）。
- 探针证据：`tool_execution_*` 对自定义 bash 工具确实发出，end 带 `content[0].text` 与 `durationMs`（`.tmp/probe-tool-exec-events.mjs`）。
- Jev 裁决记录在 `.tmp/jev-process-timeline-out.json`。展开内容 `input_plus_output` 0.96，回放 `replay_worker_jsonl` 1.0，范围 `nested_both` 0.56（未采纳，用户裁决只做 Worker 内 pi-subagent），位置 `header_chip` 0.47，详情形态 `side_drawer` 0.45，可见性 `active_plus_recent` 0.58。默认展开 `running_and_failed_expanded` 0.52 未采纳，改为主时间线默认收起。
