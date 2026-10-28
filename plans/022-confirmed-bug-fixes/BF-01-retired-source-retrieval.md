# BF-01：退役文档立即退出所有知识检索

优先级：P1。状态：draft；implementationStatus：not_started。拟用标签：ready-for-agent。功能依赖：无。测试边界待用户确认。

## Problem Statement

用户删除知识来源后，在后台清理索引之前，仍能搜索到并引用该来源的旧内容。已复现正常顺序“完成并启用 → 退役 → 清理执行前搜索”，无需并发条件。

来源已经标记为 retired，但活动版本查询只检查活动指针非空。异步清理负责物理删除，不能承担即时检索可见性的职责。

## Solution

退役状态提交后，新发起的知识检索立即排除该来源。后台清理继续按原方式执行；清理延迟或失败不改变这一行为。其他活动来源仍可正常查询。

## User Stories

1. As a knowledge-base user, I want retired content excluded from new searches immediately, so that deleted knowledge cannot inform new answers.
2. As a knowledge-base user, I want active documents to remain searchable, so that deleting one source does not hide unrelated knowledge.
3. As a search user, I want keyword and vector retrieval to respect the same lifecycle state, so that changing retrieval mode cannot reveal retired content.
4. As a navigation user, I want PageIndex to exclude retired sources, so that document navigation follows the same visibility rule.
5. As an operator, I want delayed cleanup to leave retired sources invisible, so that index maintenance does not determine user-visible deletion.
6. As an authorized user, I want existing tenant, group and knowledge-base restrictions preserved, so that fixing deletion does not broaden access.
7. As a maintainer, I want old document versions to remain ineligible, so that retiring a source cannot revive a superseded version.

## Implementation Decisions

- 在活动版本资格查询中同时判断来源生命周期和非空活动指针，使已提交的 retired 来源失去检索资格。
- 对齐通用检索和 PageIndex 的活动来源语义；追踪 BM25、向量和父块装配所用的既有资格入口，避免留下旁路。
- 保留活动指针、历史版本及异步清理任务的现有存储职责，不以清空历史或同步删除索引代替资格修复。
- 保留现有租户、组、知识库、候选版本和附件范围，不把私有会话附件纳入全局活动来源列表。
- 无数据库迁移、无新增后台任务、无额外网络请求；在现有资格查询内完成过滤。
- 范围是退役提交后开始的新检索；不引入在途回答取消、全局锁或新的并发协议。

## Testing Decisions

- 主边界：调用真实来源生命周期和退役操作，随后调用运行时真实检索组合入口；数据库使用隔离 SQLite，索引适配器可控。
- 索引替身必须响应实际提交的过滤语义，并保留 retired 文档数据，不能预先返回空结果来掩盖缺陷。
- 行为断言以最终结果及送入父块上下文的内容为主；SQL 字符串或活动 ID 列表只能作补充证据。
- PageIndex 通过其现有公开导航/候选接口验证；无法在同一组合入口触发的分支使用既有仓库公开方法补充。
- 既有范例：来源生命周期、searcher、PageIndex repository 和 ingestion lifecycle 测试。测试全部离线，不接真实 Elasticsearch。

### Acceptance Criteria

- [ ] BF-01-A1：先启用来源，再退役，并暂停清理；新 BM25 查询不返回该来源的命中，活动来源对照仍命中。
- [ ] BF-01-A2：同一夹具下，向量检索及父块装配不返回 retired 文档内容；使用实际运行时资格接线。
- [ ] BF-01-A3：PageIndex 的公开查询不返回 retired 来源，仍能导航正常活动来源。
- [ ] BF-01-A4：清理任务保持 pending 或失败时，重复新检索仍满足 A1–A3，不依赖先执行物理删除。
- [ ] BF-01-A5：候选/旧版本、其他租户、无组权限和范围外知识库对照仍被排除；合法活动版本仍可见。
- [ ] BF-01-A6：回归在修复前因 retired 命中而失败，修复后通过；测试证据记录受控索引仍有旧数据且未调用真实网络。
- [ ] BF-01-A7：资格判断没有新增逐命中数据库读取或外部调用，相关生命周期和检索既有测试通过。

## Out of Scope

同步清理全部索引、历史引用撤销、正在生成的回答取消、来源状态模型重构、业务数据修复或重索引、权限体系重写、新并发基础设施。

## Further Notes

- 原始复现：sourceState=retired；activeIdsAfterRetire 仍含退役 doc；actualHitsAfterRetire=1；cleanupCallsBeforeSearch=0；pendingCleanup=4；networkAttempts=0。
- 定位起点：[来源退役](../../src/knowledge/source_lifecycle_store.ts)、[活动版本资格](../../src/ingestion/tracking/active_version_repo.ts)、[检索组合](../../src/retrieval/search/searcher.ts)、[PageIndex 资格](../../src/ingestion/tracking/page_index_repo.ts)。
- 本票与 BF-02 优先处理；优先级不是功能阻塞关系。复现与基线见 [evidence.md](evidence.md)。
