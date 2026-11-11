# 01: 聊天骨架（回声链路）

**What to build:** 用户在聊天窗口发送消息，经 preload IPC 到主进程"回声处理器"，逐段流式推回，UI 逐字显示；会话内消息历史保留（内存即可）。打通 renderer→preload→main→事件推流→renderer 的完整管道，不接任何 LLM。UI 遵循 DESIGN.md（Nova/Lucide/motion），组件可用 MagicUI MCP 挑选。

**Blocked by:** None (can start immediately)

**Status:** done (6fe8df9)

- [x] `npm run dev` 后窗口显示单列聊天界面（消息流 + 输入框）
- [x] 发送消息后，助手侧以流式事件逐字回显回声内容
- [x] 连续发送多条消息，每条都收到回声（事件通道并发正确）
- [x] preload 以 contextBridge 暴露类型化 API（invoke + 事件订阅），渲染层无 Node 直接访问
- [x] `npm run typecheck` 通过，控制台无 React 报错
