# 05: 并行与隔离

**What to build:** 两个任务并行执行互不阻塞；Router 忙碌时新消息经 followUp 排队、在下一轮合并处理（不逐条多轮回复）；每个 Worker 独立 cwd（workspace/<taskId>/），相互不可见。

**Blocked by:** 03 (派活闭环)

**Status:** done(4d5f7b8)

- [x] 并发派两个任务，两者执行时间线重叠，期间用户插话有响应
- [x] Router 忙时连发 5 条消息，下一轮回复覆盖全部（合并批处理）
- [x] 两个 Worker 的工作目录相互隔离（一个任务看不到另一个任务的产物路径）

## 实现偏离说明

Router 忙碌期排队没有用票面设想的 pi `followUp` 逐条排队，改为 `pendingBuffer` + 信封合并：Router 忙碌（run 进行中/压缩中/已有排队）期间到达的用户消息与任务汇报统一入自身缓冲，`agent_settled`/`compaction_end` 后泵出——单条直投原文、多条合并为一条 `[USER]/[TASK_EVENT]` 信封消息一次注入（一次 LLM 调用），合并回合的回复按当轮 messageId 扇出。原因：pi 的 `followUp` 链不触发第二次 `agent_start`（表现为同一 run 内的续跑，`agent_end`/`agent_settled` 只在整条链结束各发一次），且空闲时调用会静默吞消息——详见 HANDOFF「T5 踩坑」。票面验收行为已达成，对外契约不变（每条消息仍独立流式回复、各自 done）。
