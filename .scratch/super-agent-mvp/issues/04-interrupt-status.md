# 04: 叫停与查询

**What to build:** interrupt_task 工具立即中止指定运行中 Worker（状态转 aborted，不再产出）；task_status 工具回答当前任务列表与状态；任务生命周期（开始/完成/失败/中止）作为事件行内联在聊天流中展示，简洁不刷屏。

**Blocked by:** 03 (派活闭环)

**Status:** done

- [x] 运行中任务被叫停后状态为 aborted，Worker 进程性停止
- [x] 通过 Router 问"现在在忙什么"返回与 SQLite 一致的真实状态
- [x] 生命周期事件行在 UI 可读、样式克制（不逐 token 刷屏）
