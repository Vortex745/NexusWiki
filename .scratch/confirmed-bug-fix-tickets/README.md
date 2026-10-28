# 五个 Bug 修复：已完成

五票均已合入 `codex/confirmed-bug-fixes` 并按本地 tracker 关闭。35/35 项验收通过；新增 45 项行为回归；最终 32 个受影响测试文件共 408/408，通过后端构建。

唯一实时状态：[execution-state.json](execution-state.json)。[汇总证据与全量基线限制](evidence/final/README.md)。

| 票据 | 修复 | 验收 | 状态 |
| --- | --- | --- | --- |
| [BF-01](issues/BF-01-retired-source-retrieval.md) | 退役文档立即退出所有知识检索 | 7/7 | resolved |
| [BF-02](issues/BF-02-run-history-ownership.md) | 运行历史读取校验会话所有权 | 7/7 | resolved |
| [BF-03](issues/BF-03-branch-pending-clarification.md) | 编辑和重新生成时清除旧分支的待澄清状态 | 7/7 | resolved |
| [BF-04](issues/BF-04-markdown-fence-progress.md) | 特殊代码围栏不再导致整份 PDF 解析失败 | 7/7 | resolved |
| [BF-05](issues/BF-05-table-escaped-pipe.md) | 表格末格的转义竖线保留为真实单元格内容 | 7/7 | resolved |

**全量回归未全通过**：3205 项中 3195 通过、8 失败、2 跳过。八项失败均在修复前快照复现，详见汇总证据。G-BF 的通过只覆盖本批验收、受影响套件及构建。

来源规格：[plans/022](../../plans/022-confirmed-bug-fixes/README.md)。执行图：[final-ticket-plan.json](final-ticket-plan.json)。本轮离线实施，未部署、未操作业务数据库、未调用真实 provider。
