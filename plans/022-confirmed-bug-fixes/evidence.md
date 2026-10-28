# 复现基线与证据边界

日期：2026-10-28。基线：HEAD bbedc95 与当时未提交工作树。以下是上一轮已完成的只读离线复现；本轮整理规格未再次执行，也没有实施任何修复。

## BF-01：退役后的检索资格

使用真实 lifecycle、pipeline、retire 与运行时检索接线，隔离内存 SQLite，受控索引保留已退役文档。执行顺序为启用 → 退役 → 清理执行前查询。

~~~text
sourceState=retired
activeIdsAfterRetire=[退役文档的 docId]
actualHitsAfterRetire=1
expectedHitsAfterRetire=0
cleanupCallsBeforeSearch=0
pendingCleanup=4
networkAttempts=0
~~~

原始脚本：C:/Users/14253/AppData/Local/Temp/rag-lifecycle-audit-20261028-18ca51eb/retire-visibility.cjs。
结果：同目录 retire-visibility-result.json。

这些证据确认正常顺序下的资格遗漏；不证明在途回答或并发退役的其他行为。

## BF-02：公开运行历史越权

真实 createApp，身份适配器提供合成的已认证 Bob 与跨租户 Alice；使用真实隔离 SQLite 会话和轨迹。

| 操作 | 实测 | 预期 |
| --- | --- | --- |
| Bob 读取本人 run | 200，完整合成记录 | 200 |
| Alice 读取 Bob 的 run | 200，含合成私密回答 | 404 |
| Alice 读取 Bob 的会话目录 | 404 | 404 |

原始脚本：C:/Users/14253/AppData/Local/Temp/agentic-bug-review-20261028/foreign-run-history.cjs。

现有目录所有权规则有效，run HTTP 路由未接上该规则。实施时必须额外保留“owner 但尚无会话锁”的正常对照；锁的空值不能等同无所有权。

## BF-03：分支截断后旧 pending 仍参与下一轮

1. 保存当前 pending：“旧问题：帮我查退款”。
2. 记录 old-run 的 clarification_required 展示历史。
3. 对 old-run 执行 truncateFromRun，实测删除 2 条展示历史。
4. pending 仍然存在。
5. 通过真实 route dispatch runner 发送“新问题：介绍产品”。

实测 effectiveMessage：“旧问题：帮我查退款 新问题：介绍产品”。预期新分支不继承该旧 pending。

原始脚本：C:/Users/14253/AppData/Local/Temp/agentic-bug-review-20261028/pending-branch.cjs。

## BF-04：代码围栏触发整份标准化失败

样本 A，逐行以 LF 连接：

~~~text
Before

````typescript
const answer = 42;
````

After
~~~

样本 B：

~~~text
Before

```python title="demo"
print("demo")
```

After
~~~

当前触发 TypeError：读取空段落最后一行的 end。普通三反引号对照通过；修复期望两种输入均有界完成，并保留正文与代码。

## BF-05：末格的转义竖线

样本：

~~~text
Field | Value
--- | ---
symbol | A\|
~~~

结构化 table.rows 第二格预期为 A|，实测为 A 加反斜线。原始 block.text 仍含完整样本，不能把故障描述为原始全文丢失。

带独立末尾外框的对照：

~~~text
| Field | Value |
| --- | --- |
| symbol | A\| |
~~~

该对照现有行为正常。BF-04/BF-05 原探针：
C:/Users/14253/AppData/Local/Temp/docreader-readonly-20261028-221002/regression.test.cjs；
输出 regression-results.tap。

## 已完成基线与未完成验收

| 项目 | 既有只读审查结果 | 含义 |
| --- | --- | --- |
| conversation history/store、chat、chat conversation scope 四个测试文件 | 60/60 通过 | 当前旧测试未覆盖两项聊天故障 |
| DocReader 既有套件 | 27/27 通过 | 当前旧测试未覆盖围栏与末格转义缺陷 |
| DocReader 新临时探针 | 2 对照通过，3 触发用例失败 | 三个失败对应 BF-04 两输入和 BF-05 一个输入 |
| BF-01 退役探针 | 退役内容仍命中 | 是故障复现，不是修复验收通过 |
| BF-02/BF-03 探针 | 打印或断言当前错误行为 | 需改写为期望正确行为的持久回归 |
| 本批次修复验收/构建 | not_run | 本轮只写计划，不能沿用旧基线冒充修复通过 |

所有原复现均为离线合成数据；没有真实模型、OCR、DocReader 或 Elasticsearch 请求。临时目录可能被系统清理，本文件保留可重建的触发输入与观察值；后续票据不应依赖临时文件存在。

## 未来实施时的现有验证入口

聊天已知基线命令：

~~~powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 src/answer/conversation_history.test.ts src/answer/conversation_store.test.ts src/api/chat.test.ts src/api/chat.conversation_scope.test.ts
~~~

PDF 已有入口：

~~~powershell
npm run test:docreader
~~~

BF-01 按来源生命周期、ingestion lifecycle、searcher 和 PageIndex repository 既有套件追加持久回归。BF-03 按真实 dispatcher 接线补充行为覆盖。附件受影响用例使用现有附件 suite。

合入汇总运行受影响套件和 npm run build。新增测试文件须显式纳入运行命令；不得只重复旧命令却遗漏新增回归。执行前核对当时测试脚本，保留隔离数据库和 mock 外部调用设置。
