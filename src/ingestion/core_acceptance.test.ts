// UT-21：核心完整性与恢复联合验收。
//
// 契约（UP-11 AC 1/2/3/5/6，经 21 票继承）：真实隔离上传（HTTP /ingest/file）
// → 生命周期管线 → 状态 → 联合门槛 → 激活 → 检索，同一真值集逐层核对
// 原件/提取/切块/索引/检索；扫描/混合等复杂文件不假成功（待校验单列，
// 保留在分母中）；部分索引故障经恢复修复后仍受双门槛约束；支持范围按
// 预先固定清单计算完成率。真实依赖：Elasticsearch + bge-m3 嵌入。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { config as dotenvConfig } from "dotenv"
import { createApp } from "../api/server"
import { loadConfig } from "../config"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { ExpectedChunkRepository } from "./tracking/expected_chunk_repo"
import { ExtractionEvidenceRepository } from "./tracking/extraction_evidence_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { createIngestionStore } from "./storage"
import { createElasticsearchClient } from "../clients"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// 真实 ES/嵌入配置来自生产 .env（override:false）。
dotenvConfig({ override: false })
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut21-")), "ingestion.db")

const TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/txt")
const PDF_TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/pdf")
const REPORT_DIR = resolve(HERE, "../../.scratch/upload-truth")

const config = loadConfig()
const es = createElasticsearchClient({ node: config.esNode, apiKey: config.esApiKey || undefined })

const REPORT: {
  ticket: string
  supportedScope: string[]
  pendingScope: string[]
  results: Array<Record<string, unknown>>
  completionRate: Record<string, unknown>
  recovery: Record<string, unknown>
  disclaimer: string
} = {
  ticket: "UT-21",
  supportedScope: ["utf8-baseline.txt", "simple-body.pdf"],
  pendingScope: ["mixed-scan.pdf"],
  results: [],
  completionRate: {},
  recovery: {},
  disclaimer:
    "真实隔离上传→状态→门槛→激活→检索的联合验收记录。完成率按预先固定的支持范围计算，" +
    "待校验文件保留在分母中。检索质量/召回保证单列 UT-22 与检索套件。",
}

async function esReady(): Promise<boolean> {
  try {
    await Promise.race([
      es.info(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 5000)),
    ])
    return true
  } catch {
    return false
  }
}

async function uploadViaHttp(port: number, fileName: string, bytes: Buffer, mimeType: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/ingest/file`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": fileName,
      "x-file-mime-type": mimeType,
    },
    body: bytes,
  })
  assert.equal(response.status, 200, `上传应被接受：${fileName}`)
  const body = (await response.json()) as { docId: string }
  return body.docId
}

async function runPendingDocuments(): Promise<void> {
  const lifecycle = new IngestionLifecycle(
    openDb(),
    new PipelineStageRunner(openDb(), undefined as never, createIngestionStore())
  )
  for (let i = 0; i < 10; i += 1) {
    const result = await lifecycle.runNext()
    if (!result) break
  }
}

async function searchInIndex(documentId: string, text: string): Promise<boolean> {
  const result = await es.search({
    index: "kefu-rag-chunks",
    size: 5,
    query: {
      bool: {
        must: [{ match: { content: text } }],
        filter: [{ term: { documentId } }],
      },
    },
  })
  const total = (result as { hits?: { total?: { value?: number } } }).hits?.total
  return (total?.value ?? 0) > 0
}

test("UT-21 联合验收：真实上传→门槛→激活→检索（TXT/PDF）与待校验分母", async (t) => {
  if (!(await esReady())) {
    t.skip("Elasticsearch 不可达——联合验收未执行（如实单列）")
    return
  }

  const eventsSource = async function* () {}
  const server = createApp({
    eventsSource,
    ingestAccessMiddleware: (_req, res, next) => {
      res.locals.accessContext = {
        tenantId: "ut21",
        subjectId: "ut21-user",
        groups: ["ut21-group"],
        scopes: ["ingest", "chat"],
      }
      next()
    },
  }).listen(0)
  await new Promise<void>((resolveListen) => server.once("listening", resolveListen))
  const address = server.address()
  const port = (address as { port: number }).port

  const documentRepo = new DocumentRepo(openDb())
  const documentIds: Record<string, string> = {}

  try {
    // —— 1) TXT 完整成功路径（真值：utf8-baseline）——
    const txtDocId = await uploadViaHttp(
      port,
      "utf8-baseline.txt",
      readFileSync(join(TRUTH_DIR, "utf8-baseline.txt")),
      "text/plain"
    )
    documentIds["utf8-baseline.txt"] = txtDocId

    // —— 2) PDF 完整成功路径（真值：simple-body）——
    const pdfDocId = await uploadViaHttp(
      port,
      "simple-body.pdf",
      readFileSync(join(PDF_TRUTH_DIR, "simple-body.pdf")),
      "application/pdf"
    )
    documentIds["simple-body.pdf"] = pdfDocId

    // —— 3) 混合扫描（复杂文件 → 正确待校验，不假成功）——
    const mixedDocId = await uploadViaHttp(
      port,
      "mixed-scan.pdf",
      readFileSync(join(PDF_TRUTH_DIR, "mixed-scan.pdf")),
      "application/pdf"
    )
    documentIds["mixed-scan.pdf"] = mixedDocId

    // 管线执行（真实 store：bge-m3 嵌入 + ES bulk）。
    await runPendingDocuments()

    // —— 4) 支持范围：完整成功 + 活动身份正确 + 检索可达 ——
    for (const [fileName, docId] of Object.entries(documentIds)) {
      const state = documentRepo.getOperationalState(docId)?.status
      assert.equal(state, "completed", `${fileName} 管线完成`)
      const gateEvidence = documentRepo.getCandidateEvidence(docId) as {
        contentProof: { verdict: string }
        indexProof: { verdict: string }
      }
      const docRow = documentRepo.get(docId)
      assert.ok(docRow)
      const activeRow = openDb().prepare(
        "SELECT active_doc_id FROM sources WHERE source_id = ?"
      ).get(docRow.sourceId) as { active_doc_id: string | null }
      const isActive = activeRow.active_doc_id === docId

      if (REPORT.supportedScope.includes(fileName)) {
        assert.equal(gateEvidence.contentProof.verdict, "pass", `${fileName} 内容凭证 pass`)
        assert.equal(gateEvidence.indexProof.verdict, "pass", `${fileName} 索引凭证 pass`)
        assert.equal(isActive, true, `${fileName} 应为活动身份`)
      } else {
        assert.equal(isActive, false, `${fileName} 复杂文件不得激活`)
        const blockReason = documentRepo.getActivationBlockReason(docId) ?? ""
        assert.ok(
          blockReason.includes("activation_content_proof_pending_review"),
          `${fileName} 待校验原因可查：${blockReason}`
        )
        REPORT.results.push({
          file: fileName,
          verdict: "pending_review",
          blockReason,
          rawContentRetained: (() => {
            const doc = documentRepo.get(docId)
            return Boolean(doc?.rawContent && doc.rawContent.length > 0)
          })(),
        })
        continue
      }

      // 检索边界：真值词元经实际索引可检索（TXT 校验尾部/否定/数值）。
      if (fileName === "utf8-baseline.txt") {
        assert.ok(await searchInIndex(docId, "终线-42"), "尾部校验词可检索")
        assert.ok(await searchInIndex(docId, "不支持"), "否定语义可检索")
        assert.ok(await searchInIndex(docId, "A-2026-1004"), "数值可检索")
      }
      if (fileName === "simple-body.pdf") {
        // 探针词元从 ES 块内容动态取（文件型文档 documents.content 为空是
        // 既有设计——正文在切块与索引中；rawExtraction 是 JSON 也不能用）。
        const chunkManifest = new ExpectedChunkRepository(openDb()).list(docId)
        const mget = await es.mget({
          index: "kefu-rag-chunks",
          ids: chunkManifest.map((entry) => `${docId}:${entry.chunkId}`),
          _source: ["content"],
        })
        const firstContent = (mget as {
          docs?: Array<{ found?: boolean; _source?: { content?: unknown } }>
        }).docs?.find((doc) => doc.found)?._source?.content
        assert.ok(typeof firstContent === "string" && firstContent.length >= 4, "索引块有正文")
        const probeLine = firstContent
          .split("\n")
          .find((line) => line.trim().length >= 4)
        assert.ok(probeLine, "索引块有可探针行")
        assert.ok(
          await searchInIndex(docId, probeLine.trim().slice(0, 4)),
          "PDF 正文词元可检索"
        )
      }

      // 证据链：原件/原提取/期望清单逐层可查。
      const doc = documentRepo.get(docId)
      assert.ok(doc?.rawContent && doc.rawContent.length > 0, `${fileName} 原件保留`)
      const evidence = new ExtractionEvidenceRepository(openDb()).get(docId)
      assert.ok(evidence?.valid, `${fileName} 提取证据有效`)
      const manifest = new ExpectedChunkRepository(openDb()).list(docId)
      assert.ok(manifest.length > 0, `${fileName} 期望检索清单存在`)

      REPORT.results.push({
        file: fileName,
        verdict: "active",
        chunkCount: manifest.length,
        gatePassed: true,
      })
    }

    // —— 5) 待校验分母：完成率按预先固定范围计算，不事后删去 ——
    const attempted = Object.keys(documentIds).length
    const active = REPORT.results.filter((entry) => entry.verdict === "active").length
    const pending = REPORT.results.filter((entry) => entry.verdict === "pending_review").length
    REPORT.completionRate = {
      attempted,
      active,
      pendingReview: pending,
      supportedScopeCompletion: `${active}/${REPORT.supportedScope.length}`,
      note: "待校验文件保留在分母中：2/3 全量完成率、2/2 支持范围完成率",
    }

    // —— 6) 故障恢复：部分索引（删除一个 ES 条目）→ 重处理修复 → 仍活动 ——
    const recoveryDocId = documentIds["utf8-baseline.txt"]
    const manifestBefore = new ExpectedChunkRepository(openDb()).list(recoveryDocId)
    const victim = manifestBefore[0].chunkId
    await es.delete({ index: "kefu-rag-chunks", id: `${recoveryDocId}:${victim}` }, { ignore: [404] })
    await es.indices.refresh({ index: "kefu-rag-chunks" })

    const recoveryStart = Date.now()
    const reprocess = new IngestionLifecycle(
      openDb(),
      new PipelineStageRunner(openDb(), undefined as never, createIngestionStore())
    ).reprocess(recoveryDocId)
    assert.ok(reprocess?.changed, "恢复命令生效")
    await runPendingDocuments()
    const recoveryMs = Date.now() - recoveryStart

    const docRow = documentRepo.get(recoveryDocId)
    assert.ok(docRow)
    const activeRowAfter = openDb().prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = ?"
    ).get(docRow.sourceId) as { active_doc_id: string | null }
    assert.equal(activeRowAfter.active_doc_id, recoveryDocId, "修复后活动身份保持")
    assert.ok(await searchInIndex(recoveryDocId, "终线-42"), "修复后真值词元仍可检索")
    REPORT.recovery = {
      scenario: "partial index (deleted one ES entry) → reprocess → republished",
      sameDocId: recoveryDocId,
      recoveryMs,
      stillActive: true,
    }

    mkdirSync(REPORT_DIR, { recursive: true })
    writeFileSync(join(REPORT_DIR, "ut21-acceptance.json"), JSON.stringify(REPORT, null, 2) + "\n")
  } finally {
      // 清理隔离验收数据（真实 ES 中的测试文档）。
      await es
        .deleteByQuery({
          index: "kefu-rag-chunks",
          query: { terms: { documentId: Object.values(documentIds) } },
          conflicts: "proceed",
          refresh: true,
        })
        .catch(() => undefined)
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
})

test("UT-21 收尾：关闭隔离库", () => {
  closeDb()
})
