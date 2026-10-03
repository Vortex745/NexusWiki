// UT-09：原始提取与逐页证据重启可读。
//
// 契约（UP-04 AC 1/2/3/5，经 09 票继承）：清洗前的原始提取、其自身哈希、
// 解析器配置指纹、逐页覆盖与警告按 (doc, version) 持久化；重开隔离仓储后
// 读取到的是同一份字节；清洗结果不覆盖原提取；半写/篡改/缺字段的记录
// valid:false，绝不作为验证缓存；证据读取遵守租户与授权作用域。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import express from "express"
import type { AddressInfo } from "node:net"
import { loadConfig } from "../config"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  ExtractionEvidenceRepository,
  type ExtractionEvidenceRecord,
} from "./tracking/extraction_evidence_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import {
  BuiltinPdfParser,
  DirectTextParser,
  MarkItDownParser,
  MarkerParser,
} from "./parser"
import type { IngestionStoreImpl } from "./storage"
import { createDocumentsRouter } from "../api/documents"

const HERE = dirname(__filename)
// loadConfig 在缺省环境必需一个 key（本票不调用任何模型）。
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库，
// 否则后续测试会落到开发库 data/kefu-rag.db。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut09-")), "ingestion.db")

const TXT_TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/txt")
const PDF_TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/pdf")

// 同一进程内共享一个隔离库；测试顺序执行，各自用独立文档行。
const evidenceDocIds: { txt?: string; simplePdf?: string; mixedPdf?: string } = {}

function makeFakeStore() {
  const storedChunks: Array<{ documentId: string; content: string }> = []
  const fakeStore = {
    async storeChunks(
      chunks: Array<{ documentId: string; content: string }>
    ): Promise<unknown> {
      storedChunks.push(...chunks.map(({ documentId, content }) => ({ documentId, content })))
      return {
        chunkCount: chunks.length,
        passageCount: chunks.length,
        batchCount: 1,
        embeddingBatchCount: 1,
        embeddingRequestCount: 1,
        embeddingRetryCount: 0,
        embeddingRateLimitCount: 0,
        embeddingDurationMs: 1,
        rateLimitWaitMs: 0,
        bulkRequestCount: 1,
        bulkDurationMs: 1,
      }
    },
    async storeEntities(): Promise<void> {},
    async storeWikilinks(): Promise<void> {},
    get chunkIndexName(): string {
      return "fake-index"
    },
    async close(): Promise<void> {},
  }
  return { fakeStore: fakeStore as unknown as IngestionStoreImpl, storedChunks }
}

function makeResolveParser() {
  const config = loadConfig()
  return (type: string) => {
    if (type === "direct-txt") {
      // UT-10：TXT 的类型匹配路径是进程内保真解码。
      return new DirectTextParser()
    }
    if (type === "builtin-pdf") {
      return new BuiltinPdfParser({
        command: config.pythonCommand || "python",
        timeoutMs: config.parserTimeoutMs ?? 120_000,
        inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
        outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      })
    }
    if (type === "marker") {
      return new MarkerParser({
        command: config.markerCommand ?? "marker_single",
        timeoutMs: config.parserTimeoutMs ?? 120_000,
        inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
        outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      })
    }
    return new MarkItDownParser({
      command: config.markitdownCommand ?? "markitdown",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
  }
}

async function ingest(
  input: {
    title: string
    rawContent: Buffer
    fileName: string
    mimeType?: string
    uriOrExternalId: string
  }
): Promise<string> {
  const db = openDb()
  const { fakeStore } = makeFakeStore()
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, makeResolveParser() as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: input.title,
    content: "",
    rawContent: input.rawContent,
    fileName: input.fileName,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    sourceIdentity: {
      kind: "file",
      uriOrExternalId: input.uriOrExternalId,
      namespace: "ut09",
    },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, `${input.title} 必须完成解析入库`)
  return submitted.docId
}

test("UT-09 a) TXT 证据行记录原始提取，清洗与证据互不覆盖", async () => {
  const { fakeStore, storedChunks } = makeFakeStore()
  const db = openDb()
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, makeResolveParser() as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: "证据真值 TXT",
    content: "",
    rawContent: readFileSync(join(TXT_TRUTH_DIR, "utf8-baseline.txt")),
    fileName: "utf8-baseline.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/utf8-baseline.txt", namespace: "ut09" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, "TXT 必须经保真文本路径完成解析")

  const evidence = new ExtractionEvidenceRepository(db).get(submitted.docId)
  assert.ok(evidence, "证据行必须存在")
  assert.equal(evidence.valid, true, `完整提交应有效：${evidence.invalidReason ?? ""}`)
  const { artifact } = evidence
  // UT-10：TXT 的类型匹配路径是 direct-txt（进程内解码）。
  assert.equal(artifact.parserType, "direct-txt")
  assert.match(artifact.parserConfigVersion, /^[0-9a-f]{64}$/, "配置指纹是 sha256")
  // 原始提取（清洗前）与文件解码输出逐字一致（无 BOM、LF 样本无变换）。
  assert.equal(artifact.rawExtraction, readFileSync(join(TXT_TRUTH_DIR, "utf8-baseline.txt")).toString("utf8"))
  assert.ok(
    artifact.rawExtraction.includes("\n    retry_limit = 3"),
    "原提取保留 4 空格缩进"
  )
  assert.equal(artifact.rawExtractionSha256,
    createHash("sha256").update(Buffer.from(artifact.rawExtraction, "utf8")).digest("hex"))
  assert.equal(artifact.pageCount, null)
  assert.deepEqual(artifact.warnings, [])

  // 清洗（UT-10 保守清洗）不再剥缩进——但证据与清洗仍是两份数据：
  // 证据行是解码原输出，清洗结果进切块，互不覆盖。
  const joined = storedChunks
    .filter((chunk) => chunk.documentId === submitted.docId)
    .map((chunk) => chunk.content)
    .join("\n")
  assert.ok(joined.includes("    retry_limit"), "保守清洗保留缩进进入切块")
  evidenceDocIds.txt = submitted.docId
})

test("UT-09 a2) markitdown 路径（.md）仍产出证据行", async () => {
  const { fakeStore } = makeFakeStore()
  const db = openDb()
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, makeResolveParser() as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: "证据真值 Markdown",
    content: "",
    rawContent: Buffer.from("# 证据标题\n\n正文段落，校验词：md-ev-77。\n", "utf8"),
    fileName: "evidence.md",
    mimeType: "text/markdown",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/evidence.md", namespace: "ut09" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, ".md 必须经 markitdown 完成解析")

  const evidence = new ExtractionEvidenceRepository(db).get(submitted.docId)
  assert.ok(evidence, "markitdown 路径的证据行必须存在")
  assert.equal(evidence.valid, true, `完整提交应有效：${evidence.invalidReason ?? ""}`)
  assert.equal(evidence.artifact.parserType, "markitdown")
  assert.ok(evidence.artifact.rawExtraction.includes("md-ev-77"), "原始提取含校验词")
})

test("UT-09 b) 简单 PDF：页 1..3 extracted、pageCount 3、无警告", async () => {
  const docId = await ingest({
    title: "证据真值 PDF（简单）",
    rawContent: readFileSync(join(PDF_TRUTH_DIR, "simple-body.pdf")),
    fileName: "policy.pdf",
    mimeType: "application/pdf",
    uriOrExternalId: "C:/truth/evidence-simple.pdf",
  })
  const db = openDb()
  const evidence = new ExtractionEvidenceRepository(db).get(docId)
  assert.ok(evidence)
  assert.equal(evidence.valid, true, `完整提交应有效：${evidence.invalidReason ?? ""}`)
  const { artifact } = evidence
  assert.equal(artifact.parserType, "builtin-pdf")
  assert.equal(artifact.pageCount, 3, "pageCount 与提取 JSON 同源")
  assert.deepEqual(artifact.warnings, [])
  assert.equal(artifact.pages.length, 3)
  for (let page = 1; page <= 3; page += 1) {
    const pageEvidence = artifact.pages.find((entry) => entry.page === page)
    assert.ok(pageEvidence, `第 ${page} 页必须有证据行`)
    assert.equal(pageEvidence.status, "extracted", `第 ${page} 页已提取`)
    assert.ok(pageEvidence.blockCount > 0 && pageEvidence.textChars > 0)
    assert.equal(pageEvidence.note, undefined)
  }
  evidenceDocIds.simplePdf = docId
})

test("UT-09 c) 混合扫描 PDF：无文本层页如实记 unextracted，不伪造跨度", async () => {
  const docId = await ingest({
    title: "证据真值 PDF（混合扫描）",
    rawContent: readFileSync(join(PDF_TRUTH_DIR, "mixed-scan.pdf")),
    fileName: "mixed.pdf",
    mimeType: "application/pdf",
    uriOrExternalId: "C:/truth/evidence-mixed.pdf",
  })
  const db = openDb()
  const evidence = new ExtractionEvidenceRepository(db).get(docId)
  assert.ok(evidence)
  const { artifact } = evidence
  assert.equal(artifact.pageCount, 3)
  // 2/3 覆盖率不触发低覆盖警告（UT-02 基线已记录该阈值）。
  assert.deepEqual(artifact.warnings, [])
  const page2 = artifact.pages.find((entry) => entry.page === 2)
  assert.ok(page2, "第 2 页必须有证据行")
  assert.equal(page2.status, "unextracted_no_text_layer_or_empty")
  assert.equal(page2.blockCount, 0)
  assert.equal(page2.textChars, 0)
  assert.ok(page2.note, "无块的页必须带说明（真实空白/未提取/异常，不伪造）")
  const page1 = artifact.pages.find((entry) => entry.page === 1)
  const page3 = artifact.pages.find((entry) => entry.page === 3)
  assert.equal(page1?.status, "extracted")
  assert.equal(page3?.status, "extracted")
  evidenceDocIds.mixedPdf = docId
})

test("UT-09 d) 进程重启（closeDb→openDb）后读取到同一份证据", async () => {
  const docId = evidenceDocIds.simplePdf
  assert.ok(docId, "依赖 b) 的证据行")
  const before = new ExtractionEvidenceRepository(openDb()).get(docId)
  assert.ok(before)

  closeDb()
  const after = new ExtractionEvidenceRepository(openDb()).get(docId)
  assert.ok(after)
  const strip = (record: ExtractionEvidenceRecord) => JSON.stringify(record)
  assert.equal(strip(after.artifact), strip(before.artifact), "重启后逐字节一致")
  assert.equal(after.valid, true)
})

test("UT-09 e) 篡改 raw_extraction → valid:false，哈希不匹配可检出，原文仍可读", () => {
  const docId = evidenceDocIds.txt
  assert.ok(docId, "依赖 a) 的证据行")
  const db = openDb()
  const before = new ExtractionEvidenceRepository(db).get(docId)
  assert.ok(before)

  db.prepare(
    "UPDATE extraction_artifacts SET raw_extraction = raw_extraction || 'x' WHERE doc_id = ?"
  ).run(docId)

  const after = new ExtractionEvidenceRepository(db).get(docId)
  assert.ok(after)
  assert.equal(after.valid, false, "被篡改的记录不能作为验证缓存")
  assert.match(after.invalidReason ?? "", /raw_extraction_hash_mismatch/)
  // 记录本身仍然可读（审阅者能对出被改了什么），但永不通过校验。
  assert.ok(after.artifact.rawExtraction.endsWith("x"))
  assert.ok(after.artifact.rawExtraction.includes("    retry_limit = 3"))
})

// ---------------------------------------------------------------------------
// f) HTTP 路由：GET /documents/:docId/extraction 遵守租户与授权作用域。
// ---------------------------------------------------------------------------

function httpContextFor(tenantId: string): Record<string, unknown> {
  return { tenantId, scopes: ["chat"], groups: ["demo-tech"] }
}

function buildExtractionApp() {
  const db = openDb()
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    const tenant = String(req.headers["x-test-tenant"] ?? "demo")
    res.locals.accessContext = httpContextFor(tenant)
    next()
  })
  app.use("/api", createDocumentsRouter({
    documentRepo: new DocumentRepo(db),
    knowledgeBaseService: {
      list: () => [],
    } as never,
    pageIndexRepo: { getNodesByDocument: () => [] } as never,
    extractionEvidenceRepo: new ExtractionEvidenceRepository(db),
  }))
  return app
}

async function httpRequest(
  port: number,
  path: string,
  tenant: string
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    headers: { "x-test-tenant": tenant },
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

test("UT-09 f) 证据路由：同租户可见，跨租户/不可见组/无证据均为 404", async () => {
  const db = openDb()
  const repo = new DocumentRepo(db)
  const evidenceRepo = new ExtractionEvidenceRepository(db)

  const seedDoc = (options: { tenantId: string; allowedGroups: string[] }): string => {
    const source = repo.createSource({
      sourceId: `src-ev-${Math.random().toString(16).slice(2, 8)}`,
      sourceKey: `key-ev-${Math.random().toString(16).slice(2, 8)}`,
      kind: "submission",
      uri: `uri-ev-${Math.random().toString(16).slice(2, 8)}`,
      namespace: "ut09",
      tenantId: options.tenantId,
      allowedGroups: options.allowedGroups,
      knowledgeBaseId: `kb-ev-${Math.random().toString(16).slice(2, 8)}`,
    })
    const docId = `doc-ev-${Math.random().toString(16).slice(2, 8)}`
    repo.insert({
      docId,
      sourceId: source.sourceId,
      contentHash: `hash-${docId}`,
      version: 1,
      title: "证据路由可见性",
      source: "api",
      content: "证据路由测试正文",
      tenantId: options.tenantId,
      allowedGroups: options.allowedGroups,
      knowledgeBaseId: source.knowledgeBaseId,
    })
    return docId
  }

  const visibleDocId = seedDoc({ tenantId: "demo", allowedGroups: ["demo-tech"] })
  const rawExtraction = "原始提取正文（含缩进）\n    retry_limit = 3\n"
  evidenceRepo.record({
    docId: visibleDocId,
    version: 1,
    schemaVersion: 1,
    parserType: "markitdown",
    parserConfigVersion: createHash("sha256").update("ut09-config").digest("hex"),
    rawExtraction,
    rawExtractionSha256: createHash("sha256").update(Buffer.from(rawExtraction, "utf8")).digest("hex"),
    warnings: [],
    pages: [],
    pageCount: null,
    completedAt: new Date().toISOString(),
  })
  const hiddenDocId = seedDoc({ tenantId: "demo", allowedGroups: ["sealed-group"] })
  const noEvidenceDocId = seedDoc({ tenantId: "demo", allowedGroups: ["demo-tech"] })

  const app = buildExtractionApp()
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    // 同租户 + 组可见 → 200，返回完整证据（含 valid 判定）。
    const ok = await httpRequest(port, `/documents/${visibleDocId}/extraction`, "demo")
    assert.equal(ok.status, 200)
    assert.equal(ok.json?.valid, true)
    assert.equal(ok.json?.version, 1)
    const evidence = ok.json?.evidence as Record<string, unknown>
    assert.equal(evidence.rawExtraction, rawExtraction, "原提取逐字返回")
    assert.equal(evidence.parserType, "markitdown")
    assert.equal(evidence.pageCount, null)

    // 跨租户 → 与不存在的文档不可区分的 404。
    const crossTenant = await httpRequest(port, `/documents/${visibleDocId}/extraction`, "other")
    assert.equal(crossTenant.status, 404)

    // 同租户但组不可见（非管理员）→ 404。
    const hidden = await httpRequest(port, `/documents/${hiddenDocId}/extraction`, "demo")
    assert.equal(hidden.status, 404)

    // 同租户可见但没有证据行（如 mineru 路径未记录）→ 404，不伪造证据。
    const missing = await httpRequest(port, `/documents/${noEvidenceDocId}/extraction`, "demo")
    assert.equal(missing.status, 404)
  } finally {
    server.close()
  }
})
