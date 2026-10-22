# Handoff — BF-01–05 已完成

## BF-01–05 已完成（2026-10-29）

- 集成分支 `codex/confirmed-bug-fixes`；工作区 `C:/Users/14253/.codex/worktrees/confirmed-bug-fixes/Agentic RAG`。五票已 resolved，35/35 项验收、新增 45 项行为回归、最终 32 文件联合套件 408/408、后端构建通过。状态与证据：`.scratch/confirmed-bug-fix-tickets/execution-state.json`、`evidence/final/README.md`。
- 原工作区现有未提交业务内容与 index 保留；修复前快照 `57dbc29459adac5ef737556a1542c9be5e707f0c` 包含当时业务内容，审查使用 `git diff 57dbc29459adac5ef737556a1542c9be5e707f0c...HEAD`。业务及测试最终验证 HEAD `65c84c2e6192b4915243977dab40fa9b6d890d04`，后续仅补完成状态、证据和交接。原业务分支没有自动同步本批修复。
- 已完成双轴独立审查：0 硬性违规、0 规格问题，唯一 P3 测试工厂重复建议已用共享 fixture 处理。
- 全量回归不是全绿：3205 tests / 3195 pass / 8 fail / 2 skip。相同八项全部在修复前快照复现：5 项字节 fixture 断言与 CRLF 检出有关，2 项 persistence 和 1 项 MCP 文件依赖缺失 OPENAI_API_KEY。假配置下另暴露 2 项 MCP 既有失败，修复前同样复现，不扩进五票。
- 验证踩坑：Windows 新 worktree 可经 Git LF/CRLF 转换破坏独立 SHA256 fixture；诊断恢复字节前先对 manifest 核验，最终 restore，勿把修正后的全量冒充原始全绿。CJS preload 使用 `--require C:/.../legacy-unit-env.cjs`；Windows 盘符路径不能直接当 ESM `--import` URL。
- 五项修复不涉及迁移、新依赖、真实 provider 或业务数据写入、部署。下方 BF 草案、未实施与未确认记录属于历史，已被本节完成状态替代。


## 五个 Bug 修复票草案（2026-10-28，测试边界待确认）

- 来源规格：plans/022-confirmed-bug-fixes/README.md；BF-01–05 每票含 7 条用户故事、7 项未勾选验收，共 35 项。机器映射 ticket-plan.json，复现输入与旧基线 evidence.md，文档一致性校验 validation.json。
- 拆分为：P1 退役后检索资格、P1 run-history 所有权、P2 分支截断清真实 pending、P2 特殊围栏解析崩溃、P2 表格末格转义竖线。所有 blockedBy 为空；BF-02/03 协调聊天模块，BF-04/05 建议串行写共享标准化文件，均不是功能依赖。
- 主测试边界：真实退役→运行时检索；已认证 HTTP 运行历史；编辑/重新生成 HTTP→真实 dispatcher 输入；共用 DocReaderPdfParser.parse。真实外部服务受控，使用隔离 SQLite 与合成数据。
- 注意所有权不能直接等同 getSessionLock 非空：该方法对本人未绑定助手/知识库的目录也可返回 null；BF-02 必须保留此正常对照。BF-03 实际 pending 位于 conversation_turns，清理应复用现有截断事务。
- 当前 draft / implementationStatus=not_started / fix verification=not_run。to-spec 明确要求 “Check with the user that these seams match their expectations.”，本批次尚待确认；不得沿用旧 PT/LO/DR 的确认。正式本地队列 .scratch/confirmed-bug-fix-tickets/ 尚未创建，确认后以 ready-for-agent 发布，发布不启动实施。
- 本轮只新增计划与评审页面并更新交接，未修改业务代码、操作业务数据库或调用真实 provider。页面：C:/Users/14253/.answer-me-with-html/pages/5-个-Bug-的修复计划-20261028-231805.html。

## 可修复 Bug 审查（2026-10-28，只读扫描，5 项已复现）

- 基线为 HEAD `bbedc95` 加当前未提交工作树。Git 中 WD-01–15 / DocReader 与技术完成策略已经实现；下方旧“尚未实施”文字属于历史计划状态，不能当当前源码事实。本次未修改业务代码或操作业务数据库。
- **P1：删除后仍有检索资格。** `source_lifecycle_store.ts:202` 退役保留活动指针，`active_version_repo.ts:8` 只筛 `active_doc_id IS NOT NULL`，未排除 retired 来源；`page_index_repo.ts:222` 有同类活动条件。真实 lifecycle/pipeline/retire + 内存 SQLite + mock 索引顺序复现：来源 retired，activeIds 仍含 docId，BM25 命中 1（期望 0），异步清理尚有 4 项 pending。修复方向是在现有活动资格查询内筛来源状态，不需要新增并发机制。
- **P1：运行历史缺少所有权校验（既有债仍存在）。** `src/api/chat.ts:213–219` 直接按 runId 返回 `traceRepository.getRun`。真实 createApp + mock 已认证身份、内存 SQLite：跨租户 Alice 读取 Bob 的运行得到 200 和合成回答正文；读取 Bob 会话目录为 404。应按 trace.sessionId 复用现有 tenant+subject 所有权规则。
- **P2：编辑/重新生成后 pending 清错表。** `conversation_history_store.ts:383–390` 只清 `clarification_pending`，实际分发链的 pending 在 `conversation_turns.kind='pending_clarification'`。内存数据库保存待澄清问题后截断对应 run，展示历史已删，pending 仍在；下一轮真实 `createRouteDispatchRunner` 的 effectiveMessage 仍把旧问题拼到新输入前。修复应在现有事务按 session+tenant 清当前 pending。
- **P2：代码围栏令整份标准化报错。** `docreader_pdf_normalize.ts:333` 的围栏识别与 `:382` 的段落停止规则不一致；四反引号，或三个反引号加 `python title="demo"`，触发空段落并在 `:410` 读取 undefined.end。临时回归探针已复现；普通三反引号对照正常。修复需统一消费条件并保证未识别输入保留原文、推进游标。
- **P2：末格转义竖线解析错值。** `docreader_pdf_normalize.ts:82` 先无条件剥离末尾 `|`，使无行尾外框的 `symbol | A\|` 输出末格 `A` 加反斜线，而非 `A|`；显式带外框的对照正常。原始 block.text 保留，错误范围是结构化 table.rows，不能描述为原始全文丢失。
- 验证：既有聊天 4 文件 60/60、DocReader 27/27 通过，但未覆盖以上触发；新 DocReader 临时回归 2 个对照通过、3 个触发用例失败（对应 2 条 bug）。全部使用离线 mock/内存数据库，无真实模型/OCR/ES 请求。证据目录分别在 OS temp 的 `agentic-bug-review-20261028/`、`docreader-readonly-20261028-221002/`、`rag-lifecycle-audit-20261028-18ca51eb/`；临时目录可能被系统清理，以上记录保留触发与根因。

## 上下文策略核查（2026-10-28，只读分析）

- 模型近期记忆为最近 6 对 validated 问答，窗口外用滚动摘要承接；256 是摘要生成的 `max_tokens`，不是摘要与近期原文的共享输入预算。离线 mock 探针给改写器一条 20000 个中文字符的历史消息，捕获请求仍含全文；条数限制不能视为 prompt token 裁剪。未向真实 provider 发送该探针。
- 检索上下文默认预算 6000、单父块窗口 4500，只约束证据上下文，不覆盖整份模型输入。`modelTokenCount` 对含非 ASCII 的整段文本按 UTF-8 字节计数，纯 ASCII 才走 LlamaIndex tokenizer；不是当前聊天模型的原生 token 精确计数。
- 直答把旧摘要、近期问答和当前问题拼入生成消息；simple/complex 知识生成主要通过 `contextualizedQuery` 让历史影响检索，最终生成消息仍用证据与 `effectiveMessage`，没有直接附上近期问答或会话摘要。`OpenAIAnswerModel.stream` 原样转发消息，不补历史或统一裁剪。
- 常规 completed 回答落库后可触发摘要更新；FAQ 精确命中会保存问答，但该分支没有触发 summarizer。超预算证据压缩与会话摘要是两套独立机制。
- 11 个既有离线测试文件共 146/146 通过，覆盖历史存取、摘要、改写、证据组装/压缩/预算/纠错及记忆适配；未修改业务代码，未调用真实模型，不能据此证明语义压缩无损或 provider 窗口不会溢出。

## 意图识别核查：英文长期记忆规则漏匹配（2026-10-28，未修复）

- `src/mastra/memory_prompt.ts` 的 `isLongTermMemoryQuery` 会先删除全部空白，但英文正则仍包含空格。直接探针中 `show my saved memories` 和 `what do you remember about me` 均返回 `false`；`你还记得我什么` 返回 `true`。因此英文原句不会命中该规则，若上下文改写后变成可匹配的中文仍可能命中。此处只记录发现，未修改业务逻辑。
- 当前 `.env` 配置为 `DECISION_PROVIDER=clef`、`OPENAI_CHAT_MODEL=glm-5.3-flash`、路由请求超时 10000ms；这不证明已运行进程使用了同一配置。四个路由与一次权威分发的离线测试 93/93 通过，未请求真实模型，不能据此判断分类准确率。

## WeKnora 技术完成策略 + DocReader PDF（2026-10-28，最新方向，仅规划）

- 用户明确改选：放弃本项目的文件内容审批门禁，按 WeKnora 技术处理成功方式启用，并实际接入 DocReader PDF。本轮只计划，未实施。此方向取代下方“保留 PyMuPDF、只移植规则”的旧建议；当前运行代码仍是旧门禁，不得把计划写成已生效。
- 完整方案：`plans/020-weknora-docreader/plan.md`。固定 WeKnora SHA `256a3f2966866337f7dc3c5fcc10037f2ae18d52`；一个官方 Dockerfile 构建的独立 DocReader 服务；Node 用 ReadStream，扫描整页图片接现有火山 OCR；不迁入 WeKnora Go 应用。新任务退役 contentProof/indexProof、覆盖硬门槛、索引回读探针、页级 Clef 验收及人工批准写入口；保留实际写入失败、取消、权限与版本生命周期。旧规格的冲突与替代范围已列入方案。
- 说明页面：`C:/Users/14253/.answer-me-with-html/pages/改用-WeKnora-技术完成策略-并接入-DocReader-PDF-20261028-040614.html`（8 面板，CLI STE 0 warnings）。
- 方案中的重新处理：completed 统一新建同 source 的候选版本，不再对活动 docId 直接覆盖索引；failed/cancelled retry 继续复用当前候选及有效提取缓存。旧活动/待审/rejected 行均不因升级而自动放行或批量重处理。
- 本轮只读检查：Docker Server 29.9.2、Compose v5.6.1、Node v26.8.1；50051 未监听；grpc-js/proto-loader 顶层未安装；固定官方源可读，未验证镜像构建和真实 RPC/OCR。实际 config 读取 `VOLC_ACCESSKEY`/`VOLC_SECRETKEY`，当前 .env 均存在；旧“未配 OCR_ACCESS_KEY_ID”描述不代表当前能力。只输出凭据存在性，未输出值或调用付费服务。
- 核实踩坑：DocReader source_blocks 是 Unicode 码点偏移，不能直接 JS slice；bbox 为比例坐标，不能冒充旧消费者的点坐标。ReadStream 首帧不是完成；扫描 OCR 在应用侧。官方固定快照含已知 Figure 前正文/同名页眉误删，初版按上游行为报告，不增加隐藏质量门禁。
- 新证据：`.scratch/weknora-docreader-plan-2026-10-28/`（官方部署/RPC/配置源码与 RAGFlow 技术完成对照）。新方案未重跑 TypeSafe；旧报告的模型分数不适用于新路线。工作树原有大量改动未回滚或提交；本轮只写计划、来源材料与页面、更新交接。

## WeKnora 文件清洗／噪声控制可行性（2026-10-28，仅分析）

- 用户要求先评估迁移可行性，未授权实施。建议选择性移植 PDF 去噪规则，沿用现有解析器／分块／内容凭证／索引核验／启用链路；更换 docreader 布局引擎需后续语料对比。报告及可复现材料：`.scratch/weknora-cleaning-feasibility-2026-10-28/`；页面：`C:/Users/14253/.answer-me-with-html/pages/借鉴-WeKnora-清洗方案-可行-但应选择性迁移-20261028-031156.html`。
- 上游固定：正式版 `v0.8.3`（2026-10-14，`3e22822c1d23`）；研究主分支 `256a3f296686`（2026-10-27）。LICENSE 正文说明主体 MIT、第三方组件各自许可证；GitHub API 的 SPDX `NOASSERTION` 不能替代正文核对。
- **实测误删**：AST 仅提取上游纯函数运行合成样例。v0.8.3 会删除独立行数字 `100/200/300`；主分支已有 2026-10-26 修复 `735eeb1f2db4`（#3228）。两份源码仍删除 Figure 标题前的“本条适用于金融机构”与“Payment is due”。重复页眉规则 `max(2,int(n*0.6))` 会在 4 页中仅 2 页重复时触发，且会删除正文中的同名行。结果见 `rule-probe-results.json`，不能据此估计真实语料误删率。
- **接入边界**：PDF normalization 应位于最终块 ID 生成之前，保持 rawExtraction 不变，并绑定清洗规则版本与派生产物；清洗后块覆盖不证明删除内容无害。二进制会话附件已复用 `createConfiguredParser`，只在 ingestion pipeline 末端加清洗会导致附件与知识库正文不同。TXT 保真语义不应套用 PDF 删除规则。
- **源码注释陷阱**：`pipeline.ts` 先 `parseRaw` 捕获原始输出，再 `normalizeRaw`，之后才 `extractionEvidenceRepository.upsert`；“before any cleaning runs”注释描述的是原始内容性质，不能当作落库顺序保证。标准化抛错时不能承诺该次 raw 已持久化。本轮未修业务逻辑。
- **docreader 不是仅有 Markdown**：当前 protobuf 还有 `source_blocks`（Unicode 码点偏移、1-based 页码、左上原点的比例 bbox），需转换到本项目坐标／区间约定。扫描页返回图片，后续 OCR 在 WeKnora Go 侧执行；只接 gRPC 服务不会自动得到完整 OCR 链。
- 纯函数后处理探针（66012 字符，80 次）主分支 p50 8.9ms／p95 10.1ms，未含提取、布局、OCR、向量与索引，不能推广为整链路性能。真实领域语料与生产性能仍未测。
- TypeSafe 已读实时 API／Noul／Choice／Confidence／构建指南及 cascade cookbook。最终实际 HTTP 200，`jev-1.14.0`：选择性移植 Choice=1.00/confidence=1.00；架构可行 Noul=0.88，原样复制安全=0.07，生产收益已证明=0.03，首版必须在线 AI=0.07。最终请求／响应／耗时均存该目录；这些是给定材料的模型判断，非质量成绩。
- Windows Python 输出含软连字符时，默认 GBK 会在打印 JSON 处 `UnicodeEncodeError`；使用 `E:/miniconda3/python.exe -X utf8`，结果 JSON 文件本身已按 UTF-8 写入。未修改业务代码、启动服务、上传业务语料、部署或重处理现有文档。
- **门禁核对补充**：固定上游快照的 PDF 导入主链路有解析错误、块写入错误与向量索引错误处理；未看到本项目同款“内容完整性凭证 pending_review → 批准启用”环节。`ValidateChunks` 是策略筛选，`chunker/strategy.go:43–57、103–122` 在所有策略验证未通过后仍可能返回 legacy 或 SplitText 兜底，不能宣传为整份文件硬质量门禁。`internal/types/knowledge.go:50` 明确 `finalizing` 已可向量检索；`completed` 表示后处理子任务均到终态，不代表子任务全成功或逐页内容核对通过。`enable_status` 与解析状态独立。来源快照与说明：上述 scratch 目录新增 `internal__types__knowledge.go`、`internal__application__service__knowledge_post_process.go`、`internal__infrastructure__chunker__strategy.go`、`file-gates.md`。只替换解析器不会自动改变本项目启用条件。

更新时间：2026-10-27（Asia/Shanghai）。本轮按用户授权实施 `.scratch/ocr-activation-relaxation-2026-10-26/plan.md` 的门禁部分；未恢复业务图片、未改数据库、未部署。工作区仍保留大量既有前端迁移改动，本轮未回滚、未暂存、未提交。

## 已实施事实

- 新政策版本 `ocr-advisory-v1`：内容凭证为 `pending_review` 且理由集**恰好只有** `structural_risk: ocr_content_unverified` 时，作为非阻断 warning 继续执行全部索引、绑定与检索可见性检查；任何混入/未知/空白理由仍按原拒绝路径。代码：`src/ingestion/activation_gate.ts`。
- 原始内容凭证不改写，仍是 `pending_review`；接受事实单独写 `candidate_evidence.activationAcceptance`（policyVersion、warningCodes、expectedChunksSha256、evaluatedAt）。`DocumentRepo.setCandidateEvidence` 在新产物写证据时丢弃旧接受记录，避免新产物继承旧政策接受。代码：`src/ingestion/tracking/doc_repo.ts`。
- 自动激活与人工批准共用同一决定；只有活动指针真正指向该版本才记录接受。状态接口新增 `activationWarnings` / `activationPolicyVersion`。代码：`src/ingestion/lifecycle.ts`、`src/knowledge/candidate_review_store.ts`。
- 导入弹窗：普通 OCR 接受行计成功并显示“来自 OCR，未逐字核对”；异常行仍“待校验”，文案统一为“尚未启用”，底部增加待校验计数，提示语拆分待校验/待审。代码：`frontend/src/lib/api.ts`、`frontend/src/lib/ingestProgress.ts`、`frontend/src/components/panels/ImportDialog.tsx`。
- 政策文档已同步：`HINTS.md` §2.11、`MEMORY.md`（新条目）、`plans/009-ocr-api-integration.md`（链接替代决定，历史保留）。

## 验证结果

- 聚焦回归（方案指定 9 个测试文件）：109 tests，108 pass，1 skipped，0 fail。
- 全量 `npm test`：3657 tests，3653 pass，4 skipped，0 fail。
- `npm run build`、`npm run typecheck:web`、`npm run build:web`：全部 exit 0。
- 门禁固定输入重复 10000 次（OCR 唯一软提示 + 索引 pass）：p50 0.2µs、p95 0.5µs、max 562.6µs（首次 JIT 尾部），低于 1ms 目标。
- 本轮改动未新增外部模型/ES 调用；真实上传与真实 OCR 联调未执行。

## 未做与下一步

- 未在真实浏览器/运行中的服务上验收上传计数与恢复入口；未对目标 PNG 执行“重新处理”。两者需要本地服务与业务数据操作，待用户授权后按原方案执行。
- 恢复目标 PNG 只能走既有“重新处理”入口（同 docId、复用有效 OCR 缓存）；重复 approve 是幂等短路，不会重评门禁。
- 代码回滚恢复旧门禁与状态接线，但不会自动撤销已启用的版本；首次业务验收前记录目标 source 的 `active_doc_id`。

## 容易重复踩的点

- 精确字符串是 `structural_risk: ocr_content_unverified`；不能按 `ocr_` 或 `structural_risk` 前缀豁免，也不能接受混入其他理由。
- 接受记录不是内容 pass；看到 `contentProof.verdict = pending_review` 是预期状态，不要“修”成 pass。
- `setCandidateEvidence` 会丢弃 `activationAcceptance`；只有 `recordActivationAcceptance` 能写接受事实。
- `DocumentRepo.activate` 只允许更高 `activation_order` 切换，不能当降级回滚接口。
- 前端仍处于迁移中，本轮只做最小字段/文案/计数改动，不动组件结构。

## 长文本导入排查（2026-10-27，仅方案，未实施）

- `frontend/src/lib/importBatch.ts` 的 `describeImportError` 会把包含 `embedding`、`向量化` 或 `profile` 的错误映射为“知识库向量化配置与服务端不一致”；已用记录中的 embedding HTTP 400 复现误报。截图本身不能证明模型配置不一致。
- 同名 `2610.30755.pdf` 的一次导入已分出 747 块；14:18 从 offset 64 开始的 63 条、45747 字节请求收到通用 HTTP 400，14:19 重试同样失败。具体拒绝参数、当时 provider 和 model 均未确认；截图无时间戳，不能断言就是该次任务。
- `.env` 在 15:47 修改，当前配置为 `BAAI/bge-m3:1024`；目标知识库记录 `embedding-2:1024`。这是独立的模型差异，不证明前述 400 的原因；相同维度也不证明向量语义空间兼容。
- 当前 ES 映射为 1024 维；该失败文档有 64 条索引记录，source 的 `active_doc_id` 为 null。不要据此手动启用或删除这些残留；先核对版本及正常恢复流程。
- `src/ingestion/limits.ts` 的字符估算不是通用 token 上界：600 字符标点样本以 `cl100k_base` 分词为 450 token，估算为 210；这不是对 BGE tokenizer 的计数。
- `src/ingestion/long_content.test.ts` 自行执行 `dotenvConfig`，真实 provider 用例可能读取 `.env` 并发出计费请求；离线排查不要无筛选运行该文件。该用例校验返回条数和向量维度，但仅凭 HTTP 成功不能证明 provider 未截断输入。
- 本轮前端相关测试通过 30/30，未覆盖上述误分类；未重传 PDF、未运行真实 provider 复现、未做索引迁移或全量测试。

## 知识库重命名保存后的 UI 抽动（2026-10-27，已修复）

- 根因：`frontend/src/runtime/knowledgeStore.ts` 的 `refresh()` 对所有读取先置 `status: "loading"`；`resyncAfter` 在每个命令（重命名/移动/归档/创建…）后调用它，于是对话框工具栏与行列表、侧栏知识库树被整体换成“正在加载知识库…”，随后再重建。真实浏览器探针实测保存后约 130ms 内工具栏与行消失。
- 修复：`refresh()` 只在当前状态不是 `ready` 时进入 loading；回归测试 `frontend/src/runtime/knowledgeStore.test.ts`（本仓库 `.gitignore` 忽略 `*.test.*`，按惯例测试不入库）。
- 同类未改：`frontend/src/runtime/assistantStore.ts` 的 `refresh()` 仍会在专家命令后置 loading，专家侧栏切换显示后会闪“正在加载专家…”；本次未动。
- 本地运行注意：Windows 排除端口段覆盖 3000/3001/3200，直接启动会出现 Vite `EACCES` 或后端打印 listening 但实际拒绝连接；需 `API_PORT=4100`、`VITE_PORT=4000`、`API_PROXY_TARGET=http://127.0.0.1:4100`。

## 上传记录真实状态与终态折叠（2026-10-28，已实施）

- 根因：`ImportDialog` 的 5 秒折叠只覆盖 `completed/failed/cancelled`，`pending_review`/`business_review` 永远留在队列；上传记录又只看 catalog 的粗粒度 `status`，`completed` 一律渲染 ✅，无视 `active=false`。同一份 PDF 因此出现“队列待校验、记录已完成”的矛盾。
- 修复：终止态折叠统一改用 `IMPORT_TERMINAL_STATUSES`；记录态改由 `deriveRecordView(status + candidateState + active + activationBlockReason)` 派生，✅ 仅保留给 `active` 指针持有的版本。catalog 行新增只读字段 `activationBlockReason`（`documents` 表已有列，无迁移）。
- 图标：`CircleCheck`（✅ 已完成）、`CircleX`（❌ 失败）、`ShieldAlert`（待校验）、`Clock`（待审中）、`Ban`（已取消）、`History`（非活动版本），全部经 `frontend/src/components/ui/icons.ts` 的 lucide-react seam。
- 验证：`import_dialog.test.ts` + `documents.test.ts` 54 passed；`app.contract.test.ts` + `doc_repo.test.ts` 18 passed；`typecheck:web`、`tsc`、`vite build` 全部 exit 0（仅保留既有大 chunk 警告）。未做真实浏览器上传、未启动本地服务。

## 侧边栏把未启用文档当知识展示（2026-10-28，已修复）

- 现象：侧边栏知识库「律师」展开后仍列出 `2610.30755.pdf`，但该文档实际未启用。查 `data/kefu-rag.db`：该 KB 非 retired 行仅 1 条（`7982d672…`），`status=completed`、`activation_block_reason=activation_content_proof_pending_review;…`、`active_doc_id=null`；另一条 failed 行所在 source 已 retired。即“处理完成但未激活”的候选被当成了知识内容。
- 根因：`Sidebar.KnowledgeBaseRow` 展开时以 `status:""` 拉 catalog 并全量渲染，没有按 `active` 指针过滤；catalog 也没有 active 过滤参数。
- 修复：catalog 新增 `active=true|false` 查询（correlated `EXISTS`，COUNT 与分页同一规则，非法值 400）；侧边栏只请求 `active:true`，因此 failed / 待校验 / 被新版取代的版本都不再出现在内容树，`total` 也同步只计可用文档。
- 验证：`documents.test.ts` 新增 active 过滤用例（total=1，failed/held 不计）；`documents`+`import_dialog` 55 passed；`typecheck:web`、`tsc`、`vite build`、`build:web` 全部 exit 0。未启动本地服务做浏览器回归。

## 更多设置与查看日志（2026-10-28，已实施）

- 顶部入口 `管理工作区` 改名 `更多设置`，其余三个管理项不变；新增 `查看系统日志` / `查看 Agent 日志` 两项，分隔线之后排列。
- 新接口 `POST /api/logs/open`（`src/api/logs.ts`）：仅管理员；body 只接受 `stream: "system" | "agent"`，不接受路径；目录复用 `LOG_DIR`，优先当天 `system|agent-YYYY-MM-DD.log`，缺失回退该 stream 最新一份；非管理员 403、非法 stream 400、无文件 404、打开器失败 500。
- 打开方式按用户选择走服务端本机默认程序：Windows 用 PowerShell `Start-Process -FilePath` 且路径经环境变量传入（避免引号注入），macOS `open`，Linux 需 `DISPLAY/WAYLAND_DISPLAY` 才用 `xdg-open`，否则 501/500 明确失败。**边界：后端在 Docker/远程时只会打开服务器上的文件，不会弹到浏览器所在电脑。**
- 前端 `openProjectLog(stream)` 复用 Bearer 鉴权并 toast 结果；菜单只在 admin 会话渲染。
- 验证：`logs.test.ts` + `server.test.ts` 10 passed（注入 opener，未启动真实程序）；`typecheck:web`、`tsc`、`vite build`、`build:web` 全部 exit 0；另手工对真实 `logs/system-2026-10-28.log` 执行 opener 一次，返回 `OPENED`，系统默认程序已弹出。
- **踩坑（2026-10-28）**：`npm run dev` 是 `tsx src/index.ts`，没有 watch；新增路由后旧后端进程仍在跑，`POST /api/logs/open` 得到 Express 默认 404（无 JSON `error`），前端只能显示“打开日志失败（404）”。前端 Vite HMR 会先出现新菜单，容易误判为接口逻辑错误。**改后端路由后必须重启后端进程。** 前端已把“404 且无 JSON error”识别为“日志接口未就绪，请重启后端”。
- 同轮修正：Toast 原先固定成功勾，失败消息也显示绿勾；`showToast(text, "error")` 现在用红色 X 图标，日志打开失败走该通道。
- **当前开发实例（2026-10-28 重启后）**：后端 `API_PORT=3501`，前端 Vite `--port 5174 --strictPort`，代理目标 `http://127.0.0.1:3501`。旧的 10-27 后端进程与占用 3500–3504 的陈旧 Vite 实例已清理；浏览器用 `http://localhost:5174`。
- **打开成功但窗口不可见（2026-10-28 修复）**：旧实现 `spawn` PowerShell 时用了 `windowsHide: true`，并在 `'spawn'` 事件就返回 200；日志里 01:57/01:58/02:03 多次 200 但用户看不到窗口，`Get-Process notepad` 出现 `MainWindowHandle=0` 的隐藏进程。现改为：日志路径用绝对路径；PowerShell `Start-Process -FilePath $env:LOG_FILE_PATH -WindowStyle Normal -PassThru`，等 PowerShell 退出且 exit=0 才返回 200，失败把 stderr 作为 500。端到端实测返回 200 后出现 `system-2026-10-28.log - Notepad` 可见窗口（PID 48692，MainWindowHandle 非 0）。

## 空状态与 Composer 极简化（2026-10-28，已实施）

- `ThreadWelcome` 去掉 Badge、标题/副标题、上下文记忆按钮和四张建议卡；只保留居中的「随时可以开始。」。`SUGGESTIONS` 常量随唯一使用方一并删除。
- Composer 改为圆角药丸：左侧 `+` 添加会话附件（接现有 `uploadSessionAttachment`，成功后刷新 chips），中间占位「询问 NexusWiki」，右侧圆形发送按钮常驻（无可发送内容时 disabled，颜色走 `--accent`）。
- 原本空状态里的「管理上下文记忆」是唯一入口；删除后移到「更多设置 → 上下文记忆」，避免功能失联。
- 语音麦克风未实现：目标图有麦克风，但项目没有语音输入能力，添加一个死按钮比不画更差；如需要再加。
- 验证：`typecheck:web`、`tsc`、`vite build`、`build:web` 全部 exit 0；Playwright 浏览器实测空状态仅有居中标题，底部药丸含 +、发送按钮与「询问 NexusWiki」，无徽章/副标题/卡片/记忆按钮，控制台无错误。
- **标题与输入框整体居中（2026-10-28 追加）**：空线程分支不再渲染 scroller，改为 `flex-1 items-center justify-center` 的单组：标题 +（附件 chips）+ Composer；非空分支才挂载 `MessageScrollerProvider` 与底部 composer。实测视口 912px 时标题 top=414/bottom=457、药丸 top=481/bottom=531，间距 24px，组中心距视口中心约 16px（`pb-6` 导致），控制台无错误。未发送首条消息验证 scroller 挂载切换，避免触发真实模型调用。

## 输入框附件格式对齐导入（2026-10-28，已实施）

- 目标：输入框 `+` 的附件选择器与「导入文档」接受同一批格式。格式清单现在只有一份：`SUPPORTED_DOCUMENT_EXTENSIONS`（`src/ingestion/parser/router.ts`），附件侧 `SUPPORTED_ATTACHMENT_EXTENSIONS` 是它的别名；前端 `IMPORT_FILE_EXTENSIONS` 补上 `.markdown`，两个选择器共用 `ATTACHMENT_ACCEPT`，共 24 种扩展名。
- 后端解析分两条：`.txt/.md/.markdown/.json/.csv` 仍进程内解码、同步 `ready`；其余（PDF/Word/Excel/PPT/HTML/EPUB/RTF/XML/图片）走 `selectParserRoute` + `createConfiguredParser`（与导入同一解析器），在**后台**提取文本后 `setContent` → 分块 → `ready/failed`。上传接口 201 直接返回 `parsing`，请求不会被 python/markitdown/OCR 阻塞。
- 前端 `App.tsx` 在存在 `parsing` 附件时按 `IMPORT_POLL_MS` 轮询，全部结算后停止；chips 显示「解析中…」→「临时/解析失败」。
- 边界与已知失败面：图片走 OCR API，`.env` 未配 `OCR_ACCESS_KEY_ID` 时解析失败并在 chip 上显示错误；Office/EPUB 依赖 `markitdown` CLI；PDF 无文本层会由 builtin-pdf 报错（提示用 ocr-api）。失败行仍保留 raw bytes，可删除后重传；提升到知识库仍复用原 `lifecycle.submit`。
- 测试：`session_attachment.test.ts` 新增注入 `parserFor` 的 PDF 用例（上传返回 `parsing`，轮询到 `ready` 后能检索到正文）；`.zip` 仍 415；`attachments.test.ts` 的 `supportedExtensions` 断言更新为 24 项；`app.contract.test.ts` 的旧断言「composer 不上传附件 / 无 file input」已按当前产品改为「`+` 上传 + 选择器用同一格式清单」，占位文案断言改为 `/询问 Nexus\w+/`。
- 验证：`tsc`、`typecheck:web`、`vite build` 全部 exit 0；全量 `npm test` 3671 tests，3669 pass，1 fail，1 skipped。唯一失败是既有的 `lifecycle.p6_3.test.ts` 静态契约（`markPendingReview` 必须不碰 `active_doc_id`），本次未触及 `src/ingestion/lifecycle.ts`，与附件改动无关。
- 真实解析实测：用 `golden/upload-truth/pdf/simple-body.pdf` 直接调用服务，上传返回 `parsing`，随后 `ready`，落 217 字 2 块，查询「订单」命中该块 —— 说明 builtin-pdf/python 路径在附件链路可用。未启动本地服务做浏览器 UI 回归。
- **踩坑**：附件解析失败的错误文案由服务端截到 300 字符并单行化；真实解析排障要看该 chip 的 error 或后端日志，不要只看上传 201。测试里绝不能落到真实 python/OCR，必须注入 `parserFor`。


## 模型思考强度调研（2026-10-28，仅方案，未实施）

- 用户明确要模型原生思考深度，不联动 Agent 检索／工具／纠错工作量。报告：`.scratch/reasoning-effort-research-2026-10-28/report.md`；来源快照在同目录 `sources/`。HTML：`C:/Users/14253/.answer-me-with-html/pages/思考强度-接入-GLM-原生三档-20261028-174143.html`（8 面板、1 个待确认选择，STE 0 warnings）。
- 实际 `.env` 为智谱中国区官方 `open.bigmodel.cn/api/paas/v4` + `glm-5.3-flash`，不要沿用旧 DeepSeek 记忆。只读了白名单配置，未输出密钥。官方模型文档：GLM-5.3/Flash 支持 reasoning_effort low/high/max，默认 max，不能关闭思考；Flash 文本参数与 GLM-5.3 相同。当前生成未传强度，因此 max 是按官方默认作出的推断，未验证运行进程配置或真实模型响应。
- 已安装 openai 6.46.0 类型包含 reasoning_effort 与 max，无需升级 SDK。知识生成在 `src/answer/generation.ts`，direct 生成在 `src/mastra/direct_reply_stream.ts` 且自建客户端；只改前者会漏 direct。推荐输入框「轻量／增强／深度」，默认深度，只作用答案初稿／重写；经运行参数传递，不给共享客户端的所有 Chat 调用统一加参数。方案未获实施授权。
- 记录两个已核实边界：`openai_budget_client.ts` 的 TTFT 会被 reasoning_content/tool_calls 触发，不能当答案首字时间；model_profiles 的设置保存会读到 .env 新值，但 Answer 要重启才切换，能力返回必须来自实际组装 cfg。
- 上游固定对照：WeKnora `256a3f2966866337f7dc3c5fcc10037f2ae18d52` 的能力目录和协议出口编码（主体 MIT，第三方自带许可证）；Hermes `ee7e0f517232fb619c72e49d7e648436bddc598e`（MIT）的模型专属映射。两仓库 10-28 仍有推送。Hermes 的 GLM53_EFFORTS 仍含 medium，与当前官方三档不一致，不可照抄常量或照搬「关闭」暗改 low 的语义。
- 本轮只新增调研材料并更新交接，未改业务代码、配置、数据库，未启动服务、安装依赖、在线评测或部署。真实模型是否遵守档位、质量与延迟差异均未测。计划约 15 个生产文件、0 新服务／依赖／环境变量／数据库迁移；不要将调研结论记成已生效功能。

## 模型思考强度详细计划（2026-10-28，计划完成，未实施）

- 用户后续要求使用 think 制定详细计划。正式依据：`plans/021-reasoning-effort/plan.md`；页面源稿：同目录 `review.md`；HTML：`C:/Users/14253/.answer-me-with-html/pages/思考强度-详细修改计划-20261028-184233.html`（8 节、2 个流程图、STE 0 warnings）。未发布执行票，未启动任何既有票队列。
- 推荐仍为轻量 low／增强 high／深度 max，默认深度，只作用答案初稿、直接回复和纠错重写；页面内保留选择，刷新恢复默认。计划细化了运行能力来源、精确校验、JSON/SSE/SQLite 请求选择字段，以及 15 个生产文件、11 个测试文件的修改清单。不是已批准实施或已生效功能。
- **界面核对修正**：现有 `frontend/src/components/arc/dropdown-menu/dropdown-menu.tsx` 没有 trigger disabled、单选语义与 className，且有测量动画。计划在 `Thread.tsx` 直接组合已安装的 Radix DropdownMenu 单选原语；不扩展公共封装、不新增依赖。包装器已保留输入字段，不应无端修改 workflow/memory/dispatch。
- **离线测试踩坑补充**：`scripts/test-env.ts` 只加载 parser 命令，不能阻止 `src/ingestion/long_content.test.ts` 自行 `dotenvConfig`。原样 `npm test` 会包含名为 `UT-14 真实 provider 受控请求：…` 的真实 Embedding 用例。计划的全量离线命令显式使用 `--test-skip-pattern='^UT-14 真实 provider 受控请求：'`；不能把未获授权的付费调用混进离线验证。
- 在线验收从上轮未固定的四题进一步明确为 direct 1、simple 1、complex 2 道合成题 × 三档，共 12 次真实生成尝试；路由／检索使用隔离夹具，不能冒称生产路由或检索验收。实施后的付费验证仍需用户授权。详细题目、正确答案、调用上限及停止条件见计划第 9 节。
- 本轮只写计划／页面并更新此交接，未修改业务代码、配置、数据库，未启动服务、运行测试、付费模型或部署。当前 git 可见的 lifecycle.test.ts、lifecycle.ts、source_identity.ts 修改属于既有工作，不回滚。上次全量失败不代表当前基线，实施时按实际前后结果判定归属。未把待实施设计写入 MEMORY.md。

## 模型思考强度三档选择器（2026-10-28，已实施；离线与浏览器 mock 已验证，真实 provider 未验证）

- 来源：`plans/021-reasoning-effort/plan.md`；执行规格与票：`.scratch/reasoning-effort-tickets/`（`spec.md`、RE-01–06）。RE-01–RE-05 done；RE-06（真实 provider 12 次调用）为 not_started，需付费验证授权。
- 行为：输入框发送/停止按钮前的药丸选择器显示「轻量／增强／深度」，对应 GLM 原生 `reasoning_effort` 的 `low/high/max`，默认深度。仅当组合期端点与模型精确匹配 `https://open.bigmodel.cn/api/paas/v4` + `glm-5.3-flash` 时出现；其它地址/模型/别名/区域或能力读取失败时隐藏，旧请求完全不变。选择是页面级（切会话保留、刷新恢复默认），新发/编辑/重生成在第一次 await 前冻结；运行中触发器与菜单项禁用、已开菜单关闭。只作用于直接回复、知识初稿与纠错重写，不改变路由、检索、工具、纠错次数或 180s 整轮预算。
- 生产改动（15 个文件）：`src/types/answer.ts`（`ReasoningEffort`、`ReasoningCapability`、`AnswerRunResult.requestedReasoningEffort`）；`src/answer/generation.ts`（`AnswerRunOptions.reasoningEffort`、`AnswerModelStreamOptions`、两个生成出口条件编码 `reasoning_effort`）；`src/mastra/shared_answer_entry.ts`（组合期计算并深冻结能力）；`src/index.ts`→`src/api/server.ts`→`src/api/chat.ts`（能力注入、`GET /api/chat/reasoning`、POST 一次校验、JSON/SSE 快捷字段）；`src/mastra/chat_event_adapter.ts`（`MastraRunnerInput` 透传 + 成功/失败/取消 done 在 observer 前写 `requestedReasoningEffort`）；`answer_route_stack`、`simple/complex_knowledge_runner`（初稿与重写）、`direct_ambiguous_runner`、`direct_reply_stream`；前端 `api.ts`（一次解析能力响应）、`conversation/store.ts`（四态 + 页面选择 + 冻结）、`thread/Thread.tsx`（Radix 单选菜单）。
- **与方案的偏差（既有退役契约）**：新增生成测试命名为 `src/answer/generation_reasoning.test.ts`，共享选项类型命名为 `AnswerModelStreamOptions`。`src/mastra/legacy_orchestrator_retirement_acceptance.test.ts` 与 `cutover_rollback_acceptance.test.ts` 明确断言 `src/answer/generation.test.ts` 不存在、且 `generation.ts` 不得包含 `AnswerGeneration` 子串；改名保留两个既有契约，功能语义不变。
- 验证命令与结果：定向 15 文件 **291 pass / 1 skipped / 0 fail**（skip 是既有 frozen complex 合同）；全量离线（`--test-skip-pattern='^UT-14 真实 provider 受控请求：'`）**3659 tests / 3658 pass / 1 skipped / 0 fail**，日志见 `.scratch/reasoning-effort-tickets/evidence/full-offline-suite.log`；`npm run build`、`npm run typecheck:web`、`npm run build:web`、`git diff --check` 全部通过。前端产物单 JS chunk `index-vtgJ7OBq.js` 1,378.80 kB（gzip 431.97 kB），无新增 vendor chunk；因工作树没有干净的改动前基线，未给出可信 gzip 增量。
- 浏览器 mock 验收（不代表真实模型，split-button merged 版）：真实前端 + 真实后端认证，`GET /api/chat/reasoning` 与 `POST /api/chat` 在页面内用受控响应/mock SSE 拦截，**47/47 检查通过**，无新增控制台错误。覆盖：空/已答布局不溢出（1440×900、390×844，明暗主题）、单个药丸（标签+chevron，仅 1 个按钮）打开三项菜单且当前项带勾选、键盘打开/选择/Escape 回到按钮、指针点击标签也打开菜单、发送后按钮禁用并关闭菜单、新发/编辑/重生成请求体都带冻结档位、能力 GET 每页 1 次、刷新恢复默认、切会话保留、404/500/格式错误/不支持时入口隐藏且聊天照常（请求省略字段）。证据：`.scratch/reasoning-effort-tickets/evidence/`（`ui-acceptance.json` + 10 张截图）。
- **UI 修订（2026-10-28，用户指定）**：档位切换改为 uiarc.dev Split button 并原样落地为本地 arc 组件 `frontend/src/components/arc/split-button/`（逐字 morph、宽度弹簧、chevron 旋转、菜单 stagger、reduced-motion；新增可选 `compact`/受控 `open`/可读名）。随后按用户要求**合并为一个按钮**（`merged`）：一个药丸同时显示档位与 chevron，点击标签或箭头都打开三档菜单，当前项带勾选，无分隔线、无主次两半、无循环语义；菜单项为普通 menuitem。registry 快照：`.scratch/reasoning-effort-tickets/split-button-registry.json`；移动端控件总宽 65.8px，两种布局均无溢出。
- 真实后端契约（重启后实测）：能力 GET 200 + `Cache-Control: no-store`，当前 `.env` 组合返回 `supported=true, levels=[low,high,max], defaultEffort=max, model=glm-5.3-flash`；`reasoningEffort:"LOW"` 实际返回 400 `reasoningEffort must be one of: low, high, max`。**未发起任何真实生成请求**。
- 环境动作：按计划重启了本仓库 3001 开发后端以加载新路由（同一命令、同一 `.env`；演示 OIDC 端口 3900 仍由它持有）；临时启动过本仓库 vite（5175，代理到 3001）用于验收，已停止。未修改 `.env`、数据库结构、依赖或 `package.json`。`src/ingestion/lifecycle*`、`source_identity.ts` 等既有未提交修改未被触碰。
- 回滚：只回退本功能补丁并重启后端、刷新前端；无文档/索引/配置迁移。历史轨迹中可选的 `requestedReasoningEffort` 保留，旧读者可忽略，不清洗 SQLite。
- 仍未验证/未执行：真实 provider 12 次固定剧本（RE-06，not_run）；模型内部是否遵守档位、质量/延迟差异、p95；生产部署。上线前必须用新后端+新前端成套发布，回滚也成套。

---

# DR integration handoff

## Verified evaluation pitfalls (DR-08, 2026-10-22)

- Run evaluation tests with `.venv-evals/Scripts/python.exe`; the installed base Python 3.12 interpreter does not have pytest. The isolated environment preflight validates Windows locking before collection.
- An evaluation can be complete while product gates fail. `run_suite.py --baseline` returns exit 1 for a complete failing baseline and keeps its observed score; execution/record/snapshot failures are `incomplete` with score null. Read `report.json.gate.incomplete` separately from the exit code.
- `--baseline` requires all twenty v2 cases including six hard cases. Use non-baseline selection for focused repeats. Each Agent sample gets a fresh session; scoring uses `metric.measure` directly, bypassing the DeepEval evaluation cache.
- Rebuild with `run_suite.py --rebuild <run-dir>`. It regenerates report/metric projections from only that run's manifest, environment and sample records, verifies the frozen environment digest, and does not rewrite samples. Missing, truncated and skipped samples cannot inherit an earlier passing result.

DR-08 source: `tests/evals/run_suite.py`, `reporting.py`, `test_reporting.py`. Local evidence: `C:/Users/14253/dr-wt/evidence/DR-08.md`. The parent agent owns the real twenty-case backend/Jev baseline; offline fixtures do not close that live requirement.

## Continuation verified on 2026-10-22

- The authoritative local ticket queue is still `C:/Users/14253/Desktop/Agentic RAG/.scratch/deepeval-agent-repair-tickets/`. Its publication snapshot does not describe the already merged DR-01–08 implementation. Reuse this integration worktree and its branches instead of creating a second queue.
- The actual DR-08 baseline is `C:/Users/14253/dr-wt/evidence/DR-08-live/runs/20261022T083341451543Z-ef9f91`: 20 planned/attempted/persisted/scored, 0 execution or judge errors, 59 applicable metrics scored and one not applicable. Deterministic product results are 3/6 hard and 14/14 ordinary, with `incomplete=false`; product failures do not invalidate the evaluation infrastructure.
- A running backend does not prove its retrieval services are alive. At continuation `/api/status` returned disconnected ES/Neo4j even though port 3001 was listening. Docker Desktop had stopped; starting the engine and the existing `op-local-es`/`op-local-neo4j` containers restored `mode=full` and `hasKnowledgeBaseContent=true` without recreating storage or restarting the backend. Verify health before online evidence collection.
- Rechecked at integration tip `679c171`: `npm run build` passed; the converter/gate Node tests passed 62/62; Python contracts, per-case metrics, ledger, retries, calibration and reporting tests passed 91/91. These are infrastructure regressions, not P1 or latency acceptance.
- The existing private `C:/Users/14253/dr-wt/.rerank.env` contains a configured reranker. Keep the P0 baseline and repetitions on their frozen configuration; apply the existing provider settings only to the later dedicated online rerank acceptance. Never print or commit its values.
## Verified repeat-campaign pitfalls (DR-09, 2026-10-22)

- `tests/evals/repeat_sampling.py` freezes the complete baseline's first answers and selection before sampling. Each group includes that first observation plus two new observations; independent Agent sessions and the fixed first answer's judge observations have separate statistics. `--out` must name a new directory; `--rebuild` only reads frozen raw evidence and never calls providers.
- Check that the worktree has its own ignored `.env` before live execution. DR-09's initial worktree did not have one despite the shared runbook; missing `DEMO_OIDC_PASSWORD` is an execution failure, not a product result. Never print or commit credential values.
- A live Jev HTTP 451 (`Typesafe is not available in your region.`) is a permanent external failure. Preserve it and leave G-P0 unaccepted when required repeat scores or calibration are incomplete. Do not select an older passing result or overwrite the failed campaign.
- Judge error details can contain preallocated later metric rows marked `attempted: true` but without a score, termination or HTTP attempt. Those unstarted placeholders must not inflate a metric's attempted denominator. Missing/corrupt frozen inputs also invalidate any earlier derived campaign report.

DR-09 source: `tests/evals/repeat_sampling.py`, `test_repeat_sampling.py`. Live/AC evidence: `C:/Users/14253/dr-wt/evidence/DR-09.md`; machine gate: `C:/Users/14253/dr-wt/evidence/DR-09-gate.json`.

## Continuation verified on 2026-10-22

- The authoritative local ticket queue is still `C:/Users/14253/Desktop/Agentic RAG/.scratch/deepeval-agent-repair-tickets/`. Its publication snapshot does not describe the already merged DR-01–08 implementation. Reuse this integration worktree and its branches instead of creating a second queue.
- The actual DR-08 baseline is `C:/Users/14253/dr-wt/evidence/DR-08-live/runs/20261022T083341451543Z-ef9f91`: 20 planned/attempted/persisted/scored, 0 execution or judge errors, 59 applicable metrics scored and one not applicable. Deterministic product results are 3/6 hard and 14/14 ordinary, with `incomplete=false`; product failures do not invalidate the evaluation infrastructure.
- A running backend does not prove its retrieval services are alive. At continuation `/api/status` returned disconnected ES/Neo4j even though port 3001 was listening. Docker Desktop had stopped; starting the engine and the existing `op-local-es`/`op-local-neo4j` containers restored `mode=full` and `hasKnowledgeBaseContent=true` without recreating storage or restarting the backend. Verify health before online evidence collection.
- Rechecked at integration tip `679c171`: `npm run build` passed; the converter/gate Node tests passed 62/62; Python contracts, per-case metrics, ledger, retries, calibration and reporting tests passed 91/91. These are infrastructure regressions, not P1 or latency acceptance.
- The existing private `C:/Users/14253/dr-wt/.rerank.env` contains a configured reranker. Keep the P0 baseline and repetitions on their frozen configuration; apply the existing provider settings only to the later dedicated online rerank acceptance. Never print or commit its values.

## Continuation after DR-06c / DR-09 review (2026-10-22)

- DR-09 `2b61099` and DR-06c `b6c666d` are merged at `df7f9be`. The final dr-06.3 calibration fixture and manifest are frozen at `C:/Users/14253/dr-wt/evidence/DR-06c-new-dr06.3/`; it has twelve prelabelled samples, threshold 0.5 and 36 required real attempts. Status is 0/36 because the official TypeSafe endpoint returned HTTP 451 region unavailable. Do not repeat that permanent failure or change providers/regions to get around the gate.
- Keep prior dr-06.2 27/27 calibration and its complete 20-case baseline as historical evidence only. A changed rubric requires its own calibration and a fresh complete baseline/repeat campaign; never combine scores across rubric or judge configurations.
- Read `C:/Users/14253/dr-wt/evidence/p0-audit.md` before treating DR-08 reports as complete. Review reproduced missing per-case metrics changing `judge_passed` while the report stayed complete, and nested credentials persisted in successful raw payloads. Review also reproduced mixed-model DR-09 distributions. Fix and regression-test all three before considering G-P0.
- The baseline must freeze the exact expected metric membership per case, including Grounding `not_applicable` for memory-only cases. A missing, duplicate, unexpected or wrong-applicability metric makes the report incomplete; never infer requirements from the observed metric union.
- At integration `df7f9be`, the correct focused command is `.venv-evals/Scripts/python.exe -m pytest tests/evals/test_judge_contract.py tests/evals/test_calibration.py tests/evals/test_judge_retries.py tests/evals/test_reporting.py tests/evals/test_repeat_sampling.py -q`; it passed 69 tests after an isolated Python preflight. There is no `test_metrics.py` or `test_calibrate_judge.py`.
- Keep G-P0 unaccepted until dr-06.3 live calibration, the final complete baseline and the required repeat campaign are all verified. This blocks DR-10–24. G-RERANK-LIVE is unrun. Product failures alone do not fail P0 infrastructure acceptance.
- The pre-existing full Node suite had 49 failures and frontend typecheck had pre-existing failures; see `C:/Users/14253/dr-wt/evidence/continuation-node-tests.log`. Do not describe the repository-wide suite as green.

## Review fixes closed (2026-10-22, integration `4812800`)

- The three findings in `p0-audit.md` / `spec-review.md` are closed and merged (`ee955b5`; residual fixes `4812800`): per-v2-case metric membership is frozen and enforced (including DR-09 rebuild and durable `summary.json`), successful payloads are recursively scrubbed, and repeat campaigns reject judge/model/base URL/timeout/budget/capability drift before creating a ledger or making HTTP requests.
- The focused command now includes `test_ledger.py`: `.venv-evals/Scripts/python.exe -m pytest tests/evals/test_judge_contract.py tests/evals/test_calibration.py tests/evals/test_judge_retries.py tests/evals/test_reporting.py tests/evals/test_repeat_sampling.py tests/evals/test_ledger.py -q` -> 96 passed after the residual fixes. No external provider call was made.
- Queue state at this point: DR-01–06 complete; DR-07/08/09 blocked; DR-10–24 `not_started`. G-P0 `blocked`, G-RERANK-LIVE `not_run`. Do not start DR-10–24 or claim G-P0 until the dr-06.3 live calibration, final baseline and repeats exist. The HTTP 451 remains permanent external evidence; do not retry or bypass it.
- Legacy non-v2 ad-hoc runs keep the single-score judge shape and must not require the DeepEval `metrics` module; v2 cases always carry `expected_metrics` in the frozen plan.
