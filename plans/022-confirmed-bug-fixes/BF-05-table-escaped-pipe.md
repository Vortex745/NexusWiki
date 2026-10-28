# BF-05：表格末格的转义竖线保留为真实单元格内容

优先级：P2。状态：draft；implementationStatus：not_started。拟用标签：ready-for-agent。功能依赖：无。测试边界待用户确认。

## Problem Statement

Markdown 表格没有独立行尾边框，且最后一格以转义竖线结尾时，结构化单元格值被改错。例如 `symbol | A\|` 应得到末格 `A|`，实际得到 A 加反斜线。原始 block.text 仍完整；错误发生在结构化 table.rows。

## Solution

解析时区分可选行尾边框和单元格中的转义竖线，保留真实末格值。带外框、无外框和普通表格继续沿用现有结构。

## User Stories

1. As a document reader, I want a final escaped pipe retained in its cell, so that structured table values match the source.
2. As a document reader, I want tables without a trailing border parsed correctly, so that an optional formatting choice does not change data.
3. As a document reader, I want an explicit trailing border still recognized, so that fixing escaped content does not create extra cells.
4. As a table consumer, I want interior escaped pipes to remain cell content, so that the column count stays correct.
5. As a document reader, I want ordinary delimiters and whitespace handling preserved, so that common tables do not regress.
6. As a maintainer, I want raw block text retained alongside correct structured rows, so that source fidelity and structured consumption agree.
7. As an attachment user, I want the shared parser fix applied to my PDF, so that knowledge uploads and attachments interpret the same table consistently.

## Implementation Decisions

- 在现有表格行扫描边界区分未转义分隔符、可选外框和转义内容；不得先无条件剥掉最后一个竖线。
- 行边框判定和单元格扫描采用一致的转义语义，覆盖连续反斜线的奇偶边界；避免局部修一处、另一处继续误拆。
- 保留普通表头、行列形状、空白修剪及 raw block.text 契约。
- 在现有共享标准化层完成有界修复，不新建表格中间模型或另一套附件解析器。
- 不补写原始文档、业务数据库或索引；无新增依赖或网络调用。

## Testing Decisions

- 主边界：与 BF-04 相同的 DocReaderPdfParser.parse，使用受控 DocReader 响应。
- 断言 table.rows 的实际字符串、列数、原始 block.text 和表格附近正文；不能只检查 raw text。
- 输入矩阵包含无外框末格转义、显式外框、格内转义、普通分隔、尾部空白，以及连续反斜线边界。
- 连续反斜线用例在 fixture 中明确期望的边框/内容解释，使表格扫描遵守同一规则；不扩展到所有 Markdown 转义。
- 既有范例：DocReader PDF 表格测试。共享调用方接线可复用 BF-04 同类用例，但本票不得依赖 BF-04 才可验收。

### Acceptance Criteria

- [ ] BF-05-A1：`Field | Value` 表格中 `symbol | A\|` 的末格精确为 `A|`，列数为 2，不能输出 A 加反斜线。
- [ ] BF-05-A2：相同内容加显式行尾外框后仍为两格，末格仍为 `A|`，不会产生多余单元格。
- [ ] BF-05-A3：单元格内部的转义竖线不拆列，普通未转义竖线继续分列；尾部空白不改变边框判定。
- [ ] BF-05-A4：普通有/无外框表格、表头及既有空白修剪行为保持；连续反斜线奇偶边界按明确 fixture 期望解析。
- [ ] BF-05-A5：原始 block.text 和前后正文保持完整；结构化 table.rows 与该输入的期望值一致。
- [ ] BF-05-A6：公开 parser 回归在修复前失败、修复后通过；知识库及附件共享 parser 选择保持，既有 DocReader 套件通过。
- [ ] BF-05-A7：修复不新增 provider 请求、依赖或额外文档全量预处理；使用离线合成输入给出验收证据。

## Out of Scope

完整 Markdown 表格标准实现、跨行/合并单元格增强、重建历史索引、改变原始 block.text、PDF 布局识别优化、把结构化错误扩大描述为全文丢失。

## Further Notes

- 精确三行样本、对照输入和既有结果见 [evidence.md](evidence.md)。
- 定位起点：[表格行扫描](../../src/ingestion/parser/docreader_pdf_normalize.ts)、[公开 PDF parser](../../src/ingestion/parser/docreader_pdf.ts)、[既有 parser 测试](../../src/ingestion/parser/docreader_pdf.test.ts)。
- 与 BF-04 无功能依赖，建议串行写共享标准化文件。若另一票已经交付接线夹具，复用即可，不新增重复测试入口。
