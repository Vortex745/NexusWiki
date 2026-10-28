# BF-01–05 最终验收

完成日期：2026-10-29（Asia/Shanghai）。集成分支：`codex/confirmed-bug-fixes`。修复基线：`57dbc29459adac5ef737556a1542c9be5e707f0c`；最终业务及测试验证版本：`65c84c2e6192b4915243977dab40fa9b6d890d04`。之后仅修改完成状态、证据、交接和页面草稿。

## 通过的本批门槛 G-BF

- 五票 A1–A7：35/35。逐项映射见 ../BF-01 至 ../BF-05 的 README。
- 六个新增测试文件共 45 项行为回归，均包含在最终联合套件中。每票修复前失败与修复后通过证据已保留。
- 最终受影响套件：32 文件，408 tests / 408 pass / 0 fail / 0 skip。`affected-test-result.json` 保存完整文件清单及命令；`affected-tests.log` 保存输出。
- `npm run build`：exit 0；`build-final-result.json` 与 `build-final.log`。
- 独立标准/规格审查闭合：0 硬性违规、0 规格问题；唯一 P3 夹具复用建议已处理。
- 仅合成身份、隔离 SQLite、受控适配器；没有真实 provider 调用、业务数据库写入、依赖或迁移变更、部署。

历史 BF-04 文档中的 `router.test.ts` 本来不存在。最终门槛明确采用真实存在的 `router_type_compatibility.test.ts`，并显式纳入六个新增文件和全部 DocReader 测试；不把不存在的文件算作通过。

## 全量回归：未全通过，失败已在基线复现

| 检查 | Tests | Pass | Fail | Skip |
| --- | --- | --- | --- | --- |
| 五票合入后的全量 | 3205 | 3195 | 8 | 2 |
| 修复前快照重跑相同八项 | 8 | 0 | 8 | 0 |
| 修复前 MCP 假配置诊断 | 5 | 3 | 2 | 0 |

全量八项失败由两组组成：

1. 4 项 UT-10 direct_text 用例及 1 项 UT-01 真值哈希断言：新 Windows worktree 检出将 LF/CRLF 转换，破坏字节敏感 TXT fixture。
2. 2 项 persistence 默认客户端用例与 1 个 MCP 文件级失败：离线隔离环境没有 `OPENAI_API_KEY`。

`full-tests.log`、`full-test-result.json` 与 `baseline-eight-failures.log` 保留原始结果。八项在修复前后使用相同隔离配置复现，因此本次不把它们算作新回归。

进一步诊断临时恢复四个 TXT fixture 的原始字节，并按独立 manifest SHA256 校验。只给旧 persistence/MCP 测试进程注入假配置，provider URL 指向 localhost:1。原七项断言通过；MCP 再暴露 2 项既有失败：discovery returned no callable tools、unknown_tool !== ok。修复前版本在相同假配置下同样 3/5 通过、2/5 失败。

诊断输出：`environment-controls-green.log` 实际为 12 tests / 10 pass / 2 fail，文件名不代表全绿；`baseline-mcp-configured.log` 是修复前对照。临时 fixture 改动均已 restore，未进入修复提交。MCP 子进程仍缺配置的既有问题未扩入五票。

## 修改与性能范围

业务仅修改五个源文件：活动版本、PageIndex、chat HTTP、conversation history、DocReader 标准化。退役筛选直接加在现有查询，无逐命中查询；HTTP 增加一次复用的 ownership 查询；pending 清理在既有事务增加一条限定 SQL；表格采用单次行扫描。未声称已测生产延迟或真实外部服务质量。

## 交付位置

保留集成工作区：`C:/Users/14253/.codex/worktrees/confirmed-bug-fixes/Agentic RAG`。原工作区业务文件与 index 保留，仅补 HANDOFF 指针；没有自动将本批合入原有未提交业务分支。`git diff 57dbc29459adac5ef737556a1542c9be5e707f0c...HEAD` 是本批审查范围。
