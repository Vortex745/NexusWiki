# Spec: pi-subagents 接入（替代 Worker 派发系统）

状态：**已被 ADR 0003 取代（2026-11-09）**——「Worker 系统退役」裁决作废，Worker 双层架构恢复、pi-subagents 下沉 Worker。保留本文件供追溯接入细节（扩展接缝、PI_CODING_AGENT_DIR 守卫、事件桥实测裁决）。· 分支 `feat/pi-subagents`（历史）· SDD 票序 T1→T2→T3

## 目标

Router 会话经 SDK 扩展接缝挂载 `pi-subagents`（0.87.0，MIT）；`subagent` 工具替代 `dispatch_task`/`interrupt_task`/`task_status`；Worker 系统（worker.ts/dispatcher.ts）退役。聊天 UI 零新增通道：复用 ToolRow/TaskRow/`chat:task-event`/`chat:task-activity`。

## 钉死条件（任一不满足 = 不上线）

1. `PI_CODING_AGENT_DIR` 在扩展加载前指向 agentDir（生产恒 `userData/pi-agent`）。应用进程内**每次调用无条件赋值**（嵌入语义非用户 CLI 语义；不覆盖则扩展 config/用户级 agent 定义/results 落到真实 `~/.pi`，违反项目隔离原则。生产 agentDir 恒定，逐次赋值幂等；set-once 守卫被判投机复杂度放弃——探针 4）。
2. `config.json`（`agentDir/extensions/subagent/config.json`）幂等种子：`toolActivation:"eager"`（不赌模型中途调加载器激活）、`asyncByDefault:false` + `maxActiveAsyncRunsPerSession:0`（封死 detached runner——Electron 主进程无 node 二进制保证）。**缺文件才写；已存在（含损坏 JSON）一律不覆盖**，同 pi-seed 语义。
3. lockfile 锁 0.87.0——扩展模块加载时做版本一致性校验，不一致直接抛错。

## 替换映射

| 现有 Worker 系统 | pi-subagents 对应 | 处置 |
|---|---|---|
| `dispatch_task` 工具 | `subagent` 工具（`agent`+`task` 直接执行） | T2 替换 |
| `interrupt_task`/`task_status` | `subagent` 的 `status`/`stop` action | T2 删除 |
| SQLite tasks 表 + 启动恢复 | 扩展无落账 | T2 起镜像落账（事件桥写表）；恢复语义不变 |
| `chat:task-event` TaskRow | subagent 工具行 + 镜像 TaskRow | 复用 |
| `chat:task-activity` 活动预览 | `pi.events` 的 `SUBAGENT_*` 事件 | T2 事件桥映射 |
| `[task-report]` 注回攒批 | 不需要 | T2 删除（工具结果直接回模型同 loop 续跑） |
| 12 回合预算/收尾 | 扩展自带 timeoutMs（默认 30min）/depth≤2/并发限制 | 随扩展 |
| 内置 agent 定义 | scout/worker/reviewer/oracle/delegate 自带 | 随扩展；自定义放 `agentDir/.agents/` |

## FR 与验收

### FR-1 接入（T1，不改现有行为——双轨）

- dependencies 增 `pi-subagents@0.87.0`（externalizeDepsPlugin 自动外置）。
- `loadAppExtensions` 增 `extensionPaths` 参数透传 `additionalExtensionPaths`（本机 resource-loader.js:409 证实 `noExtensions:true` 下仍加载）。
- 新模块 `src/main/chat/subagent-extension.ts`：包路径解析（`import.meta.resolve('pi-subagents')` → exports `"."` → `index.ts`）+ PI_CODING_AGENT_DIR 守卫 + `ensureSubagentConfig`。
- Router 创建时与 MCP 同一 extensions 集合注入；扩展加载失败（包未装/路径不存在）降级为 notice + 会话照常（无委派工具）。
- `extensions.errors` 上报 `chat:notice`（现有代码只报 mcpConfig.errors，顺手补齐同一管线）。
- fake 脚本增 subagent 意图（子代理 toolCall + 子代理结果后的文本收尾；现有 dispatch 意图原样保留）。
- 验收：`subagent-extension.test.ts`（config 幂等/路径缺失降级/加载冒烟）+ router 冒烟（fake 驱动一次**真扩展**子代理运行，子代理输出经 toolResult 回流父会话）；四绿。

### FR-2 工具替换（T2）

- Router customTools 移除三工具（bash/search_knowledge 保留，契约测试断言完整清单）；RouterOptions 相应收敛。
- **事件桥 `src/main/chat/subagent-bridge.ts`：订阅父会话事件流**（`session.subscribe`，经注入的 subscribe 函数解耦可测），把 `subagent` 工具的 `tool_execution_start/update/end` 映射为 `chat:task-event`（running→终态；report=子代理 finalOutput）+ `chat:task-activity`（label ≤120，seq 每任务单调）。Router dispose 时退订。
- 镜像落账：store 层 `upsertTaskEvent(db, event)`（getTask→insert+update 的幂等 upsert），ipc.ts 的 onTaskEvent 消费处调用——镜像持久化在 electron 壳层，桥保持纯映射。
- **Worker 系统退役并入 T2**（migrate-callers-then-delete-legacy-apis：`onDispatchTask` 移除后 dispatcher 测试无法编译，文件与测试一波删净）：worker.ts/dispatcher.ts/dispatch.test.ts/interrupt-status.test.ts/worker-*.test.ts/recovery.test.ts + fake 脚本 dispatch/interrupt/status 意图 + TASK_REPORT_PREFIX 机制。
- T3 收敛为：CDP 真机验收（fake 全链 + real 冒烟）+ 重启恢复验收 + HANDOFF/MEMORY/docs 落账。

### FR-3 账本与恢复（T2/T3）

- tasks 表镜像：**taskId=toolCallId**（start/update/end 三事件稳定关联；`details.runId` 仅终态载荷有，不作关联键）；title=task 文本首 32 字符；状态映射 running/终态（isError‖exitCode≠0→failed）。
- `recoverInterruptedTasks` 语义不变（启动时 running/queued → interrupted；前台子代理随进程死，语义自洽）。

### FR-4 退役（T3）

- 删 `worker.ts`/`dispatcher.ts`/`dispatch.test.ts`/`interrupt-status.test.ts`/`worker-*.test.ts`/`recovery.test.ts` 相应部分 + pi-shared Worker 专用辅助。
- grep `dispatch_task`/`runWorker`/`TASK_REPORT_PREFIX` 零残留（账本镜像除外）。
- HANDOFF.md/MEMORY.md 落账。

## Out of scope

后台 async 子代理（Electron 进程模型，v2 议题）；council/workflow-scripts/schedule/mission/inspector（零配置起步，模型自然不碰）；扩展 skills/prompts 装载；agent 定义管理 UI（用户放文件即可）；electron-builder 生产打包适配（`node_modules/pi-subagents` 不可进 asar——jiti 读盘，留生产打包票）。

## Spec-probes 裁决记录

| # | 探针 | 状态 |
|---|---|---|
| 1 | config 种子幂等：跑两次同终态 | resolved（write-if-missing 测试覆盖） |
| 2 | agentDir 缺省（inMemory 测试）→ 跳过扩展加载，同 MCP 语义 | resolved |
| 3 | 扩展路径不存在 → errors + 降级 + 会话照常 | resolved（测试覆盖） |
| 4 | PI_CODING_AGENT_DIR 重复设置（Router 重建）无害 | resolved（无条件逐次赋值，幂等；set-once 守卫判为投机复杂度放弃，与实现一致） |
| 5 | customTools 清单相邻性：删三后 bash/search_knowledge 顺序保留 | resolved（契约测试） |
| 6 | 桥的 seq：每子代理各自单调、终态即清 | resolved（沿用 dispatcher 语义） |
| 7 | Router dispose 后事件到达 | resolved（退订；backstop 测试） |
| 8 | ~~bus 可达性/事件形态未知~~ **实测推翻**：inline 前台 run 在 `subagent:*` 总线零事件（仅 async/workflow/detach 路径会发）；镜像事件源改为父会话事件流的 `tool_execution_start/update/end`（探针实测载荷：toolCallId 稳定关联、args.task 标题源、details.results[].progress/exitCode/finalOutput） | resolved（jev-1.14.0 裁决 B 会话事件桥镜像 0.66/0.27/0.07，留档 .tmp/jev-subagent-mirror-out.json；report=finalOutput 与重启镜像边际成本为零一并保留） |
| 9 | 子代理文件边界：内置 agent 无独立沙箱，cwd=父 cwd（userData）→ auth.json/app.db 可及 | **judgment**：接受并记录——Router 自身已开放 bash 工具（2026-11-08 票），同模型同威胁模型，单用户本地应用不为理论边界加复杂度（规则 10） |
| 10 | 活动预览不得泄漏子代理全文转录 | resolved（≤120 整行替换契约） |
| 11 | 禁止暴露 council/schedule 等重型能力 | dismissed（零配置起步；token 成本为观察项） |

## 已知不确定（T1 观察项 → 裁决时用 typesafe-ai）

- `pi.events` bus 宿主可达性（ExtensionRunner 构造于 agent-session.js:2983，bus 实例从链上哪里取）。
- 子代理会话在 fake 模式下的模型解析（child-session.ts injectable seam + `model:'inherit'` 语义，冒烟实测定；fallback = 测试 agentDir 种子 models.json）。
