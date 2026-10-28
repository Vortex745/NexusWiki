# BF-04：特殊代码围栏不再导致整份 PDF 解析失败

优先级：P2。状态：approved_source。实施与验收状态以正式本地队列为准。标签：ready-for-agent。功能依赖：无。测试边界已确认。

## Problem Statement

PDF 提取出的 Markdown 含四反引号围栏，或三个反引号加带属性的语言说明时，标准化会抛出 TypeError，整份文档失败。围栏识别规则与段落停止规则不一致，导致没有消费任何内容的空段落仍访问最后一行。

## Solution

合法但此前未支持的围栏可以解析为代码，或按原文保留为回退块。解析必须继续前进，不崩溃、不挂起，也不丢掉围栏前后的正文。普通代码块保持原行为。

## User Stories

1. As a document uploader, I want four-backtick fences handled without a document-wide failure, so that ordinary extracted Markdown can be ingested.
2. As a document uploader, I want fence info strings with attributes preserved, so that unsupported metadata does not destroy document content.
3. As a document reader, I want prose around code blocks retained, so that a parser fix cannot silently omit surrounding explanations.
4. As a document reader, I want ordinary code fences to keep their existing output, so that established documents remain compatible.
5. As a document uploader, I want unfinished fences to use the existing fallback, so that malformed extraction does not hang normalization.
6. As an attachment user, I want the shared PDF parser to provide the same behavior, so that session attachments do not retain the crash.
7. As a maintainer, I want each parse step to consume input, so that an unsupported fence cannot create an infinite loop or empty success.

## Implementation Decisions

- 对齐围栏开始识别、段落停止与内容消费规则，确保每一步推进输入游标。
- 对四反引号和带属性说明的围栏，允许有界支持或保真回退；验收不强制引入完整 Markdown 标准库。
- 不用吞掉异常并返回空文档的方式修复；保留代码内容、围栏前后正文，以及既有定位/原始提取契约。
- 延续现有未闭合围栏的回退与 warning 行为。
- 在知识库和会话附件共用的 PDF 标准化层修复，不为两个调用方复制解析逻辑。
- 不新增模型调用、OCR 调用、依赖或数据库迁移。

## Testing Decisions

- 主边界：调用 DocReaderPdfParser.parse，DocReader 客户端返回受控响应帧；验证返回块、原始提取及已有定位约束。
- 四反引号、带属性说明、普通三反引号、未闭合围栏使用明确输入；断言内容保留和有界完成，不能只断言“不抛异常”。
- 少量 normalizer 局部测试用于精确定位消费规则，不能替代公开 parser 回归。
- 复用已有 ingestion/attachment parser 接线范例，分别证明调用方使用同一修复；无需启动真实 DocReader 或 OCR。
- 既有范例：DocReader PDF、extraction evidence、附件与解析器选择相关测试。

### Acceptance Criteria

- [ ] BF-04-A1：含四反引号 typescript 围栏的完整输入通过公开 parse 正常返回，代码内容仍可读取。
- [ ] BF-04-A2：三个反引号加 python title="demo" 的输入正常返回；无法结构化的信息按原文保留。
- [ ] BF-04-A3：上述两例中的 Before、After 及代码正文全部保留；不是以空文档或只剩正文作为成功。
- [ ] BF-04-A4：普通三反引号代码块输出与既有契约一致；未闭合围栏继续保留原文及既有 warning。
- [ ] BF-04-A5：连续或无法识别的围栏输入在测试超时内完成，游标推进，不出现空段落读取异常或循环。
- [ ] BF-04-A6：既有 raw extraction 与 locator 约束通过；知识库/附件受控接线用例均使用修复后的共享 parser。
- [ ] BF-04-A7：两种已复现崩溃输入在修复前失败、修复后通过；既有 DocReader 套件通过，无真实 provider 请求。

## Out of Scope

完整 CommonMark 实现、引入大型 Markdown 引擎、更换 DocReader、调整 OCR 或文档启用政策、清洗语料质量评测、改写全套分块策略。

## Further Notes

- 精确触发样本与未修复的错误见 [evidence.md](evidence.md)。
- 定位起点：[PDF 标准化](../../src/ingestion/parser/docreader_pdf_normalize.ts)、[公开 PDF parser](../../src/ingestion/parser/docreader_pdf.ts)、[既有 parser 回归](../../src/ingestion/parser/docreader_pdf.test.ts)。
- 与 BF-05 共用标准化实现，建议先 BF-04 再 BF-05，避免同时写同一文件；不是功能依赖。
