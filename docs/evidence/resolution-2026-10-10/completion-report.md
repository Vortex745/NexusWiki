# 解决方案执行验收报告

日期：2026-10-10。范围：已批准的 PT09、ES 索引迁移与业务路由、PDF v2 协议/诊断/独立验收及证据收尾。

## 交付与完成边界

- PT09：三个错误断言修复；真实正文泄漏反例和清理前后 provenance 控制保留。3/3 + 关联90/90。
- ES：全入口统一 ES_CHUNK_INDEX；三条 float 叶子声明；旧 long 明确要求迁移。带路由真实演练通过。源122条复制至 kefu-rag-chunks-v2-20261010，全量 ID、routing、规范化全文/权限/向量hash一致，85个1024维子块向量及37个合法父块保留，三个数值叶子的461个小数通过float32 docvalues核验。
- 维护：使用 indices.addBlock 分片确认屏障而非仅putSettings；原索引保留并锁写，新索引切换并解除写锁。停止旧API及其MCP子进程，重启本地API。原工作区暂存状态未改；已有修改没有整体提交。
- Nginx笔记：实际原记录 failed，执行同docId retry，task32 completed；新索引114块，storeChunks done，storeGraph done。历史旧索引保持55块，不能回旧索引写入。没有假设无图关系的文档必须生成关系。
- PDF：版本v2，单一9合法组合Choice；真实服务拒绝含斜杠的option ID，改下划线后HTTP200。严格联合概率/argmax、v1只读兼容与审核失效、取消迟到防写、服务故障不可复用诊断、合法空OCR内容未验证拒绝与非法结构优先级均有测试。

## 实际验证

- npm test：3645 tests，3644 pass，0 fail，1 skip。ARCH-01A冻结skip保持，非本次解除目标。full-regression-final.log。最后增加的诊断信任边界另以11/11验证（原8+新3）；没有把它们伪称已在3645全量中。
- npm run build、npm run typecheck:web、npm run build:web均exit0。前端仅已知大bundle警告。
- PT09初始3fail、ES接口演练、全量首轮10fail、Clef最初HTTP400均保留原始记录；修复后分别复验，无扩大skip。
- 文档、KB、状态、Wiki页面、图谱实体HTTP读取烟测200；同文档retry真实完成。

## PDF独立真实评估与未达标项

16份PDF ×3轮，共48个文档执行、30个带独立标签的输入页；原26页独立render/raw标签，新增4份holdout由另一代理只看render+raw标注。fixture名称/标签不进入模型请求。实测114个page-stage判断：99 match、9 false reject、6 false accept；软件终态/零下游一致性错误0，非法联合输出0。调用实测145次fetch：Clef200×123、OCR200×21、OCR429×1（有界重试）；审核记录报告的OCR18次不含未持久化OCR失败尝试，因此不拿18当总调用量。

关键漏检：partially-rasterized及holdout-image-digits各3轮均放行了缺字本地候选。两栏等误拒绝9次按页阶段单列，不能把协议结构合法说成语义准确。PDF_OCR_FALLBACK_ENABLED仍false，未达到自动启用验收；R1/R5属于明确未解决的模型质量风险。空页按ocr_empty_page_unverified拒绝，不自动确认空白。详细raw及逐页比较见pdf-live/outcomes-v2.json和comparison-v2.json。这是合成小样本观察，不主张普遍准确率。

## TypeSafe完成判断

实际请求HTTP451，806ms，响应Typesafe is not available in your region；没有返回模型判断、概率或confidence。结果在typesafe-completion-metadata.json及typesafe-completion-response.json。请求只含脱敏事实、范围及独立缺口，既问实现完成也单独问语义上线验收，不能用测试通过掩盖漏检。若服务仍451，无概率或confidence可报告，不以人工百分数替代。

## 交付位置和回退

集成分支codex/resolution-20261010；基础36b8faad为用户原有工作区私有恢复快照，不应发布。任务差异限定为git diff36b8faad...HEAD。PDF固定字节新增.gitattributes binary，避免Windows checkout把合法xref空格/换行当文本改写。原目录获回填经过漂移核验的任务文件，保留旧branch及index；没有推送或公开PR。本地票据tickets.json。

切换前旧源/新目标已全量验证；切换后目标已接受恢复和测试写入，禁止直接回旧索引，否则丢增量。需要回退应暂停写入、保留两侧、核对增量并修复新路线。生产迁移和删除均未执行。工作树/演练索引保留以遵守用户禁止删除规则。
