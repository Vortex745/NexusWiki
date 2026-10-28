# 五个 Bug 修复：正式本地执行队列

唯一执行状态：[execution-state.json](execution-state.json)。集成分支 codex/confirmed-bug-fixes。

用户已通过 implement-spec 明确要求完成全部五票；沿用已展示的 S1–S4 测试边界。五票均 ready-for-agent，初始实现 not_started，验收 not_run。无功能依赖，共享文件串行调度。

- [BF-01 退役文档立即退出所有知识检索](issues/BF-01-retired-source-retrieval.md) — P1
- [BF-02 运行历史读取校验会话所有权](issues/BF-02-run-history-ownership.md) — P1
- [BF-03 编辑和重新生成时清除旧分支的待澄清状态](issues/BF-03-branch-pending-clarification.md) — P2
- [BF-04 特殊代码围栏不再导致整份 PDF 解析失败](issues/BF-04-markdown-fence-progress.md) — P2
- [BF-05 表格末格的转义竖线保留为真实单元格内容](issues/BF-05-table-escaped-pipe.md) — P2

来源规格：[plans/022](../../plans/022-confirmed-bug-fixes/README.md)。执行图：[final-ticket-plan.json](final-ticket-plan.json)。离线实施，不部署、不调用真实 provider。
