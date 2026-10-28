import assert from "node:assert/strict"
import test from "node:test"
import { PipelineStageRunner } from "./pipeline"
import { DocReaderPdfParser } from "./parser/docreader_pdf"
import type { ReadStreamResponse__Output } from "./parser/docreader_types/docreader/ReadStreamResponse"
import { openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { ExtractionEvidenceRepository } from "./tracking/extraction_evidence_repo"
import type { IngestionStoreImpl } from "./storage"

function metaFrame(markdown: string): ReadStreamResponse__Output {
  return {
    meta: {
      markdown_content: markdown,
      image_dir_path: "",
      metadata: { page_count: "1" },
      error: "",
      image_count: 0,
      source_blocks: [
        { start: 0, end: Array.from(markdown).length, locator_json: '{"type":"pdf","page":1}' },
      ],
    },
  } as ReadStreamResponse__Output
}

function fakeStore(): IngestionStoreImpl {
  return {
    async storeChunks() {},
    async storeEntities() {},
    async storeWikilinks() {},
    get chunkIndexName() { return "test-chunks" },
    async close() {},
  } as unknown as IngestionStoreImpl
}

test("the pipeline persists DocReader extraction evidence, parser metadata and policy", async () => {
  const db = openDb(":memory:")
  try {
    const documents = new DocumentRepo(db)
    documents.insert({
      docId: "doc-docreader",
      sourceId: "source-docreader",
      contentHash: "hash",
      version: 1,
      title: "DocReader PDF",
      source: "C:/knowledge/sample.pdf",
      content: "",
      rawContent: Buffer.from("%PDF-1.7\n"),
      fileName: "sample.pdf",
      mimeType: "application/pdf",
      tenantId: "tenant-a",
      allowedGroups: [],
      knowledgeBaseId: "kb-a",
    })
    const document = documents.get("doc-docreader")!
    const markdown = "# Title\n\nBody paragraph"
    const parser = new DocReaderPdfParser({
      address: "fake",
      timeoutMs: 5_000,
      inputLimitBytes: 20 * 1024 * 1024,
      outputLimitBytes: 20 * 1024 * 1024,
      clientFactory: () => ({
        async *readStream() { yield metaFrame(markdown) },
        close() {},
      }),
    })
    const runner = new PipelineStageRunner(db, () => parser, fakeStore())
    const summary = await runner.run(document, {
      signal: new AbortController().signal,
      executionId: "test-execution",
      async runStage(_name, _input, operation, summarize) {
        const result = await operation()
        summarize(result)
        return result
      },
    })
    assert.equal(summary.parser, "docreader-pdf")

    const evidence = new ExtractionEvidenceRepository(db).get(document.id, document.version)
    assert.ok(evidence?.valid)
    assert.equal(evidence?.artifact.parserType, "docreader-pdf")
    assert.match(evidence?.artifact.rawExtraction ?? "", /docreader-pdf-v1/)
    const envelope = JSON.parse(evidence!.artifact.rawExtraction) as {
      sourceBlocks: Array<{ locatorJson: string }>
    }
    assert.equal(JSON.parse(envelope.sourceBlocks[0].locatorJson).page, 1)

    const saved = new DocumentRepo(db).get(document.id)!
    const system = saved.metadata.system as {
      parser?: { selected?: string }
      ingestionPolicy?: { version?: string; parser?: string; pdfMode?: string }
    }
    assert.equal(system.parser?.selected, "docreader-pdf")
    assert.equal(system.ingestionPolicy?.version, "weknora-technical-v1")
    assert.equal(system.ingestionPolicy?.parser, "docreader-pdf")
    assert.equal(system.ingestionPolicy?.pdfMode, "auto")
  } finally {
    db.close()
  }
})
