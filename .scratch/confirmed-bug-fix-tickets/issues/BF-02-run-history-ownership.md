# BF-02：运行历史读取校验会话所有权

优先级：P1。状态：ready-for-agent；implementationStatus：not_started。标签：ready-for-agent。功能依赖：无。测试边界已随用户实施指令确认。

## Problem Statement

已登录用户知道他人的 runId 后，可以通过运行历史 HTTP 接口读到对方的回答和事件。当前接口只按 runId 查询，未执行会话目录已有的 tenant + subject 所有权判断。跨租户读取已经离线复现；这是仍存在的旧问题，不能描述为本轮新引入的回归。

## Solution

用户只能通过公开 HTTP 接口恢复自己的运行历史。其他用户、其他租户、未知运行或缺失所属会话的运行统一返回现有“未找到”响应；本人合法历史仍返回完整结果。

## User Stories

1. As a conversation owner, I want to restore my complete run history, so that I can reopen previous answers and events.
2. As a conversation owner, I want other subjects in my tenant denied access, so that knowing a run identifier does not reveal my conversation.
3. As a tenant member, I want users from other tenants denied access, so that tenant separation also covers run history.
4. As an API user, I want inaccessible and unknown runs to return the same not-found response, so that the endpoint does not reveal another user's resources.
5. As a conversation owner, I want my unlocked session history to remain readable, so that ownership is not confused with assistant or knowledge-base binding.
6. As a frontend user, I want normal history restoration to keep its response contract, so that this fix does not break reopening a conversation.
7. As a maintainer, I want trusted internal trace consumers to continue working, so that evaluation and observation do not acquire an unrelated browser ownership requirement.

## Implementation Decisions

- 在公开运行历史读取入口，按轨迹所属会话与请求中可信身份执行现有 tenant + subject 所有权规则。
- 使用会话目录的所有权事实；“没有助手/知识库锁”不等于“没有所有权”，不得只把锁查询的空值当拒绝依据。
- 外来、未知和孤立轨迹统一采用同一 404 响应，不返回正文、事件或额外存在性信息。
- 已授权响应保持既有完整结构；不删减字段来代替所有权校验。
- 不让调用者通过查询参数或请求正文指定可信租户/主体。
- 内部可信轨迹仓库保留现有用途；HTTP 授权放在公开访问边界或该边界复用的现有所有权服务。
- 无身份体系重构、无数据库迁移、无新增外部调用。

## Testing Decisions

- 主边界：真实应用和路由处理的 HTTP GET，使用隔离 SQLite 保存会话和轨迹；身份适配器只提供合成的已认证身份。
- 断言状态码、完整响应和拒绝响应正文，不以“调用过某个鉴权函数”作为通过标准。
- 覆盖同租户不同 subject 与跨租户；二者不能互相替代。
- 既有范例：chat API、conversation scope、session binder 和 conversation history 测试。补充内部 trace consumer 回归，避免改变可信仓库契约。

### Acceptance Criteria

- [ ] BF-02-A1：owner 读取自己已绑定会话的 run 得到 200，回答和事件结构与既有契约一致。
- [ ] BF-02-A2：同租户其他 subject 读取该 run 得到 404，响应不含合成私密回答或事件内容。
- [ ] BF-02-A3：不同租户读取该 run 得到 404，响应与未知 run 的 404 保持同一公开形状和错误信息。
- [ ] BF-02-A4：未知 run、所属会话不存在的孤立 run 均为 404；既有未认证身份门禁继续生效。
- [ ] BF-02-A5：owner 读取未绑定助手/知识库锁的合法会话 run 仍为 200；伪造请求参数不能改变身份。
- [ ] BF-02-A6：前端恢复所依赖的本人读取契约通过，可信内部轨迹读取/观测测试不因 HTTP 授权变化而失败。
- [ ] BF-02-A7：同租户或跨租户泄漏用例在修复前失败、修复后通过；离线证据只含合成数据，相关 chat 历史测试通过。

## Out of Scope

全面身份协议改造、运行 ID 随机化替代权限检查、全库数据迁移、事件格式重设计、对内部观测新增用户态授权、其他文档/记忆接口的大范围安全审计。

## Further Notes

- 已复现：Bob 读取自己的运行为 200；另一租户 Alice 读取 Bob 的运行同样为 200，并拿到合成回答；Alice 读取 Bob 的会话目录则为 404。
- 定位起点：[运行历史 HTTP 路由](../../../src/api/chat.ts)、[轨迹仓库](../../../src/answer/trace_repository.ts)、[会话目录所有权](../../../src/answer/conversation_history_store.ts)。
- getSessionLock 的空值同时表示“无所有权”和“本人会话尚无锁”，不能直接充当本票的完整所有权判断。
- 与 BF-03 可能接触相同聊天/历史模块；协调同文件写入即可，无功能先后依赖。
