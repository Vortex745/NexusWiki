# ADR 0003: 恢复 Worker 双层架构，pi-subagents 下沉 Worker

日期：2026-11-09　状态：已采纳　取代：`docs/spec/pi-subagents-adoption.md` 的「Worker 系统退役」裁决

## 背景

2026-11-09 的 pi-subagents 接入（0fae1d6）把自研 Worker 派发系统整体退役，Router 直接挂 inline `subagent` 工具，提示词要求执行类请求一律委派。该形态与两篇架构依据都不符：

- DeepSeek Harness 团队《Super-agent 设计探索》的 §2 双层架构要求常驻 Router 层与隔离执行的 Worker 层分离，§2.2 明确 Subagent 属于 Worker 内部能力，§4.1 要求耗时任务走异步 start/stop 而非阻塞主循环。
- Claude《Building agents: when to fold subagents into your main agent loop》要求主 agent 自己在上下文写计划，小事直接做，只有并行独立任务或长执行污染主上下文时才委派；反对一切皆委派与重叠委派路径。

微信文章的消融实验（§7.1）给出了直接证据。单 Session + Subagent 工具在提示词鼓励委派时，5 次运行仍有 1 次模型自行执行形成长尾，p95 为 29.5 分钟；双层架构 p50/p95 为 12.4/15.7 分钟。inline subagent 同步阻塞 Router 循环，还违反 §4.1 全双工。

## 决定

1. 恢复 Worker 层：`src/main/tasks/worker.ts` 与 `dispatcher.ts` 从 0fae1d6^ 恢复，连同 5 个既有测试。行为规格即退役前代码。
2. pi-subagents 下沉 Worker：`runWorker` 经 `loadAppExtensions` 的 `extensionPaths` 注入扩展，复用 `subagent-extension.ts` 零改动。Worker 内 subagent 调用经既有 `onActivity` 工具标签透出，不建事件桥。
3. Router 分工：`dispatch_task` / `interrupt_task` / `task_status` 三工具回归；提示词写明问答、知识检索、单步只读命令自己做，写文件、多步执行、并行任务派 Worker；`[task-report]` 注回后简短转述。
4. Router 不再挂 subagent 扩展与事件桥。`subagent-bridge.ts`、`store.upsertTaskEvent` 镜像壳及其测试一并删除。运行期 tasks 表唯一写者=dispatcher；启动恢复 `recoverInterruptedTasks` 仍写 interrupted（退役前路径，不在本次改动范围）。
5. Router 重建改用 `attachRouter(null)` 显式解绑。旧代码没有 detach，重建后 dispatcher 仍持旧 Router 引用，窗口内完成的汇报会 send 到已 dispose 实例并抛出 router-error notice。

## 证据

- 恢复源：`0fae1d6^` 的 worker.ts（490 行）、dispatcher.ts（152 行）与 5 个测试，均为已验收代码。
- 异步语义：dispatcher 的 `handleDispatch` 同步落账后立即返回 taskId，Worker 并发执行，汇报经 RouterLoop 攒批通道注回，对应 §4.1 的 start/stop 全双工。
- 门禁：typecheck / lint / test（159/159）/ build（主 JS 7,368.70 kB）四绿。
- CDP fake 全链 15/15：任务行 running→done+report、dispatch_task ToolRow、Router 无 subagent、活动 seq 每任务单调、转述到达、派发后插话获得独立回复、叫停路径有回执、零 console 异常。派发为异步：`dispatch_task` 立即返回 taskId，Worker 执行与 Router 回合互不阻塞。双 Worker 时间区间重叠与运行期提交插话的时序断言在 `dispatch.test.ts`（harness 级），CDP 层不重复。截图 `.tmp/worker-layer-accept/final.png`。
- CDP real 冒烟 6/6：真模型选择派发，Worker 真实执行并汇报（生产 userData，该消息写入真实会话历史）。实测中 real 模型用绝对路径把文件写到应用根目录，并在汇报里说明 artifacts 为空。截图与 wire dump 在 `.tmp/worker-layer-accept/`。

## 后果

- Router 上下文只承载交互与分派，长执行细节留在 Worker 会话，主上下文不再被工具流污染。
- 两条重叠委派路径收敛为一条：Router 只能派 Worker，Worker 内部才是 subagent。提示词不再出现 conflicting instructions。
- `[task-report]` 等内部消息继续经 `toHistoryMessages` 前缀过滤，不进 UI 历史。
- 已知取舍：Router 重建窗口内完成的 Worker 汇报不注入新 Router。任务行事件与 tasks 表落账不受影响，新 Router 不转述该结果。与旧行为相比，静默跳过替代了 send 到已 dispose 实例的 router-error notice。
- Worker 不挂 MCP。`runWorker` 的 `loadConfig` 返回空 servers，Worker 只有内置工具、`report_result`、Worker 内 subagent、技能与上下文文件；MCP 仍是 Router 专属。
- `workspace/<taskId>/` 是 Worker 会话的 cwd，不是文件系统沙箱。`report_result` 的 artifacts 校验只覆盖任务目录内路径，目录外写入不会被拒绝（real 冒烟实测模型用绝对路径写到应用根目录）。
- 遗留：Worker 内 subagent 的 real 质量未专项实测；Router 换轻量模型未做；事件驱动（Trigger/Thread/订阅直通）、Watchdog、存算分离属于后续独立立项。

## 验证命令

`npm run typecheck`、`npm run lint`、`npm test`、`npx electron-vite build`；CDP 探针 `.tmp/worker-layer-accept/probe.mjs`（fake）与 `probe-real.mjs`（real）。`.tmp` 不入库。