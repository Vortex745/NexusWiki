# Spec: 恢复 Worker 双层架构 + Router 分工（取代 pi-subagents-adoption）

状态：已批准（2026-11-09 /think 计划，用户授权执行）· 分支 `feat/worker-layer`（自 fix/router-lifecycle-race HEAD）

## 来源文章

- 微信：DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）。系统架构依据：§2 双层架构（Router 常驻交互/分派/记忆/批处理；Worker 隔离并发执行；§2.2「Worker 内部可以再创建 Subagent……对上层的 Router 层保持透明」）；§4.1 异步 ReAct Loop（start/stop 全双工）。
- Claude：《Building agents: when to fold subagents into your main agent loop》。Router 内部分工依据：主 agent 自己在上下文写计划/修订；小事直接做；仅并行独立任务或长执行污染主上下文时委派；反对一切皆委派与重叠委派路径。

## 方向校准

当前仓库（0fae1d6 之后）是两篇文章共同反对的形态：Worker 层被删，Router 挂 inline subagent + 提示词「执行类请求一律委派」。这正是微信 §7.1 实验里表现最差的「单 Session + Subagent 工具」变体（委派靠模型临场判断，p95 长尾）；且 inline subagent 同步阻塞 Router 循环，违反 §4.1 全双工。

冲突披露：已批准规格 docs/spec/pi-subagents-adoption.md 写明「Worker 系统退役」，本规格推翻它，以用户本次指令为准。落地时写新 ADR 标记旧规格被取代。

## 目标架构

```
用户 ⇄ Router（常驻主会话：交互/计划/记忆/轻量直接执行）
         │  dispatch_task → 立即返回 taskId（异步，不阻塞对话）
         │  interrupt_task / task_status
         ▼
      Dispatcher（落账 SQLite tasks 表，每任务一个 AbortController）
         │  并发 spawn，各自 workspace/<taskId>/
         ▼
      Worker × N（隔离上下文，全量执行工具 + report_result）
         │  内部可用 subagent 工具拆子步骤（pi-subagents，对 Router 透明）
         ▼
      [task-report] 经 RouterLoop 攒批通道注回 Router → 统一向用户转述
```

## 本轮范围（单阶段，独立可交付）

Building：恢复 Worker 层 + pi-subagents 下沉到 Worker + Router 分工提示词重写。
Not building：Thread/Trigger 事件驱动、订阅直通、Watchdog、存算分离（微信 §3/5/6，后续独立立项）；Router 换轻量模型；生产打包 asar 适配（既有遗留票）。

## 步骤

1. 从 `0fae1d6^` 恢复 worker.ts（490 行）、dispatcher.ts（152 行）及 5 个测试文件（dispatch / interrupt-status / worker-activity / worker-session / worker-single-loop）。recovery.test.ts 已在仓库保留。
2. router.ts：加回 dispatch_task/interrupt_task/task_status 三工具；移除 Router 侧 subagent 扩展与 attachSubagentBridge 接线；ROUTER_SYSTEM_PROMPT 重写为分工 criteria——问答/检索/单步只读命令自己做，写文件/多步执行/并行任务派 Worker，收到 [task-report] 做转述。
3. Worker 会话注入 pi-subagents：runWorker 里复用现有 subagent-extension.ts（零改动），经 loadAppExtensions 的 extensionPaths 接缝挂载。Worker 内部的 subagent 工具调用经既有 onActivity 工具标签透出，不需要新桥。
4. ipc.ts：重建 dispatcher（workerModel 读 worker.model，db.ts 加回 WORKER_MODEL_KEY），三个 router-slot release 点 attachRouter(null)、创建后 attachRouter(router)；任务落账回归 dispatcher 直写。
5. 删除本轮变成死码的：subagent-bridge.ts + 测试、store.upsertTaskEvent 镜像壳及其测试；fake 脚本恢复 dispatch/interrupt/status 意图，T1 子代理冒烟移到 Worker 侧。
6. 文档：新 ADR 取代旧规格 + HANDOFF 落账。

## Key decisions

- subagent 只挂 Worker，Router 不留——两条重叠委派路径正是 Claude 文章警告的 conflicting instructions；且 inline subagent 阻塞 Router，Worker 派发天然异步。
- Router 保留 bash 做单步快捷命令——按用户指令取 Claude 分工观，偏离微信「Router 可不配 Bash」的纯化形态；边界写死在提示词：写文件/多步/并行必须派发。
- 恢复而非重写——旧系统已通过六票验收，其异步语义恰好就是 §4.1 的 start/stop 全双工。
- 账本语义不变——tasks 表结构不动，recoverInterruptedTasks 原样，无数据迁移。

## 最脆弱假设

Router 模型能按提示词稳定区分「自己做 vs 派发」。微信 §7.1 证明纯提示词分派不可靠——但那是同步 inline 场景；本设计派发是一次工具调用立即返回，成本低得多。若实测仍欠委派，后手是收紧提示词或收掉 Router 的 bash（回到微信纯化形态），不是回到 inline subagent。

## 攻击角

- pi-subagents 缺失/版本不符 → Worker 降级为无子代理会话（现有降级路径复用）。
- 回滚 = 单分支 git revert，表结构不变。
- 并发 Worker 无上限是旧系统既有语义，本轮不加旋钮。

## 验证

npm run typecheck / lint / test / build 四绿 + 恢复测试全绿；CDP fake 全链（派发→任务行→汇报转述、叫停、派发后插话获得独立回复）；双 Worker 区间重叠与运行期插话提交时机、重启幽灵恢复、Worker 内 subagent 冒烟由单测覆盖（dispatch.test / recovery.test / worker-subagent.test）；real 冒烟一单；零 console 异常。

## Unknowns（显式延期）

- Worker 内 subagent 的 real 质量（验收阶段实测）。
- Router 轻量模型选型（用户裁决，后续）。
- §3/5/6 各模块（后续独立计划）。

---

## 实现笔记（lead 补充，非原文）

### 恢复源

`git show 0fae1d6^:<path>` 取退役前最后版本。涉及文件：
- src/main/tasks/worker.ts、dispatcher.ts
- src/main/tasks/dispatch.test.ts、interrupt-status.test.ts、worker-activity.test.ts、worker-session.test.ts、worker-single-loop.test.ts
- src/main/chat/pi-shared.ts 的 Worker 辅助（workerResourceLoader、TASK_REPORT_PREFIX 等，对照 0fae1d6^ 与当前差异恢复）
- src/main/chat/router.ts 的三工具定义、RouterOptions 回调、fake dispatch/interrupt/status 意图（对照 0fae1d6^）
- src/main/db.ts 的 WORKER_MODEL_KEY

### 必须保留的当前行为（非本任务显式改变的，一律不动）

- router-slot.ts 生命周期（ensure/current/release 身份校验）与 ipc.ts 三入口。
- RouterLoop 攒批/pump/信封合并、stopRun/regenerate/thinking/compaction 全链。
- MCP 扩展注入（Router 侧 loadAppExtensions 的 loadConfig）、skills 渐进披露、记忆注入。
- protocol.ts 通道与类型、渲染层 store/rows、preload。
- subagent-extension.ts（resolveSubagentExtension/ensureSubagentConfig）零改动复用。

### 已 settle 的 edge（spec-probes）

- Worker agentDir 缺省（inMemory 测试）→ 跳过扩展注入，Worker 照常（同 Router 语义）。
- pi-subagents 包缺失/版本不符 → resolve undefined / extensions.errors → notice + 无子代理会话。
- PI_CODING_AGENT_DIR 进程全局逐次无条件赋值，生产恒 userData/pi-agent，幂等（沿用 spec probe 4 裁决）。
- fake Worker 子代理意图必须 startsWith 锚定：子会话任务注入带 "Task: " 前缀，includes 会自递归（HANDOFF 已验坑）。
- finalize 幂等（finalized Set）；interrupt 先于 onStart 不翻回 running；interrupt 无任务返回 isError 不 throw。
- Router 重建窗口内完成的 Worker 汇报不注回。attachRouter(null) 为本轮新增：旧码无 detach，重建后 dispatcher 仍持旧 Router，汇报会 send 到已 dispose 实例并报 router-error；现在 target 为 null 时静默跳过注入，落账+事件仍在。
- recoverInterruptedTasks 启动 running/queued→interrupted，二次运行 no-op。
- 运行期 tasks 表唯一写者=dispatcher；删除 upsertTaskEvent 后 ipc 不再写表。启动恢复 recoverInterruptedTasks 仍写 interrupted（退役前路径）。
- Worker 不挂 MCP：runWorker 的 loadConfig 返回空 servers，Worker 只有内置工具 + report_result + Worker 内 subagent + 技能/上下文文件；MCP 仍 Router 专属。
- workspace/<taskId> 是 Worker 会话 cwd，不是文件沙箱：report_result 的 artifacts 校验只覆盖任务目录内路径，目录外写入不被拒绝（real 冒烟实测模型用绝对路径写到应用根目录）。
- toHistoryMessages 过滤 [task-report]/[USER]/[TASK_EVENT] 内部前缀（恢复 TASK_REPORT_PREFIX）。
- judgment（非测试）：real 模型分工稳定性，CDP real 冒烟观察；提示词不得指示「一切执行皆委派」。

### 仓库硬约束

- main/preload/shared 相对导入必须带 .ts 扩展名；renderer 用 @ 别名无扩展名。
- pi 纯 ESM；customTools 注入 createXToolDefinition 必须包 defineTool（bash 票踩坑）。
- erasableSyntaxOnly：禁构造函数参数属性，显式字段赋值。
- node --test 值导入相对路径带 .ts；测试接缝只有 createRouter，不给渲染层另开接缝。
- fake 长任务测试 finally 必须 stopAllTasks 兜底；interrupt 长任务测试 workerMaxTurns 传大值（100）。
- Worker 不接 onChunk（不与用户直接交互，微信 §2.2）；活动经 onActivity，汇报经 dispatcher 注回。

### 提交要求

分支 feat/worker-layer 已建。小步有序提交，每提交前跑 deslop Before each commit 检查并留一条证据引用；typecheck/lint/test 绿后才提交。禁提交 .env/凭据/用户笔记（.zcode/tmp、.tmp、.scratch 不入库）。无 git remote，不 push 不开 PR。