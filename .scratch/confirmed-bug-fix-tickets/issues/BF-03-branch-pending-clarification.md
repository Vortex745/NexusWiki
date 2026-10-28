# BF-03：编辑和重新生成时清除旧分支的待澄清状态

优先级：P2。状态：resolved；implementationStatus：completed；verificationStatus：passed。标签：resolved。功能依赖：无。测试边界已随用户实施指令确认。

## Problem Statement

用户编辑或重新生成旧消息后，界面中的旧分支已消失，但下一轮仍把旧问题当作待补充问题，拼接到新输入前。当前截断事务清理的是旧 pending 表，而真实分发使用的待澄清状态保存在 conversation turns。

## Solution

成功截断分支时，在同一事务中清理该会话当前的待澄清状态，让编辑或重新生成后的输入按新分支执行。未发生分支截断的正常补充回答继续承接原问题。

## User Stories

1. As a conversation user, I want editing a clarification turn to discard its pending question, so that my new request does not inherit the abandoned branch.
2. As a conversation user, I want regeneration to reset pending clarification consistently, so that repeated generation follows the current branch.
3. As a conversation user, I want an ordinary clarification answer to retain its pending question, so that continuing a valid task still works.
4. As a conversation user, I want other sessions to retain their pending state, so that editing one conversation cannot alter another.
5. As a tenant member, I want branch cleanup confined to the authorized session and tenant, so that similarly named sessions cannot affect each other.
6. As a conversation user, I want unknown branch anchors to leave history unchanged, so that a no-op does not erase valid pending context.
7. As a maintainer, I want display history, validated turns and rolling summaries to retain their branch rules, so that removing stale pending state does not change unrelated history behavior.

## Implementation Decisions

- 在现有成功截断分支的事务内，清理实际分发读取的 pending clarification 记录，按 session + tenant 限定。
- 沿用现有所有权入口；在入口验证后传递可信范围，不在每层重新解析身份。
- 保持“截断起点”和“截断之后”两个操作现有的锚点包含规则、返回计数及摘要失效行为。
- 未找到锚点时仍是无写入的 no-op；普通聊天补参不触发分支清理。
- 旧 pending 存储兼容行为随现有契约保留，不借此删除整套旧表或重构记忆系统。
- 不新增分支版本表、时间戳猜测关联或新的并发机制；复用现有事务和当前会话 pending 语义。

## Testing Decisions

- 主边界：通过真实 chat HTTP 编辑/重新生成请求触发截断，再捕获下一次真实 route dispatch 的 effectiveMessage；只替换外部模型/工具。
- 使用隔离 SQLite 和真实 history/conversation store；至少一个断言贯穿“展示历史已截断 → 下轮实际输入不含旧 pending”。
- 补充现有存储公开方法测试事务范围、未知锚点 no-op、两个截断模式及摘要/validated 语义。
- 既有范例：chat conversation scope、conversation history、conversation store 与 route dispatch runner 测试。

### Acceptance Criteria

- [x] BF-03-A1：待澄清旧问题被编辑替换后，下一次分发的 effectiveMessage 不再包含旧问题，且使用新请求。
- [x] BF-03-A2：重新生成覆盖同类旧分支时满足相同规则；展示历史与真实分发输入一致。
- [x] BF-03-A3：同租户其他会话和其他租户的 pending 对照保持原值；未授权截断继续被拒。
- [x] BF-03-A4：未知锚点返回既有 no-op 结果，展示历史、validated、pending 和摘要均不被修改。
- [x] BF-03-A5：既有 from/after 锚点包含规则、validated/history 返回计数与摘要失效行为通过公开存储回归。
- [x] BF-03-A6：不截断分支的正常澄清补参仍把原 pending 与补充输入正确合并；清理与现有截断处于同一事务。
- [x] BF-03-A7：包含“旧问题：帮我查退款”与“新问题：介绍产品”的行为回归在修复前失败、修复后通过；相关聊天/历史测试通过。

## Out of Scope

对话分支数据模型重建、完整长期记忆清理、摘要策略重设计、同会话并发协议变更、旧数据批量修复、全面淘汰历史 pending 表。

## Further Notes

- 原复现中 truncateFromRun 删除 2 条展示历史后，pending 仍保留。下一轮 effectiveMessage 为“旧问题：帮我查退款 新问题：介绍产品”。
- 定位起点：[分支截断](../../../src/answer/conversation_history_store.ts)、[真实 pending 存储](../../../src/answer/conversation_store.ts)、[分发输入装配](../../../src/mastra/route_dispatch_runner.ts)。
- pending 目前是会话态；不要凭空引入 run 归属迁移或增加对历史 pending 的精细保留要求。

## Resolution

完成日期：2026-10-29（Asia/Shanghai）。实现提交：`237f4afe0188f551fdb8afb890ef6d83b94d8d25`；集成合并：`d3cf4b8949cd2ca98581dba198ff2c426e8c4094`。

七项验收均通过；[逐项行为证据](../evidence/BF-03/README.md)。新增回归 11 项；最终联合回归 408/408，后端构建通过；[汇总与全量基线限制](../evidence/final/README.md)。
