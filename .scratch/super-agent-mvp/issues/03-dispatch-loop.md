# 03: 派活闭环

**What to build:** Router 获得 dispatch_task 工具。用户说"做一个 X" → 主进程 spawn 独立 Worker pi session（全量内置工具，cwd = workspace/<taskId>/，模型可与 Router 不同）→ Worker 完成后通过 report_result 将结果注回 Router → Router 用简短回复向用户汇报。SQLite tasks 表落账（id/title/status/report/时间戳）。Router 物理上无执行工具（bash/read/edit/write 被排除）。

**Blocked by:** 02 (pi Router 接入)

**Status:** done (c978cd4)

- [x] 聊天要求"在 workspace 写一个 hello.js 并运行"之类实际任务 → workspace/<taskId>/ 出现产物，聊天流出现任务开始/完成事件行与 Router 汇报
- [x] SQLite tasks 表记录完整（可查询验证 status 流转）
- [x] Router 尝试执行类工具不可用（工具被排除），只走 dispatch
- [x] 假模型下可自动化验证：dispatch 调用 → Worker 行为 → 汇报回注 的事件序列
