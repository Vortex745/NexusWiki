# 06: 重启恢复

**What to build:** 应用被杀进程后重开：聊天历史从 pi session 持久化恢复，继续对话上下文连续；任务状态从 SQLite 恢复，重启时仍在 running 的任务标记为 interrupted，不残留幽灵状态。

**Blocked by:** 03 (派活闭环)

**Status:** done

- [x] 重启后历史消息完整可见，且后续对话能引用重启前的内容
- [x] 重启前运行中的任务显示"已中断"，无 running 幽灵
- [x] `npm run typecheck` 与 `npm run build` 通过
