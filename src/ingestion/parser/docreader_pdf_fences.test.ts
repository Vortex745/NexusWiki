import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { DocReaderPdfParser } from "./docreader_pdf"
import { createFakeDocReaderParser } from "./docreader_pdf.test.fixtures"
import type { DocReaderRawEnvelope } from "./docreader_pdf_types"

const PDF = Buffer.from("%PDF-1.7\n")

function parser(
  markdown: string,
  sourceBlocks: DocReaderRawEnvelope["sourceBlocks"] = [{
    start: 0,
    end: Array.from(markdown).length,
    locatorJson: '{"type":"pdf","page":1,"bbox":[0.1,0.2,0.9,0.8]}',
  }]
): DocReaderPdfParser {
  return createFakeDocReaderParser(markdown, sourceBlocks)
}

test("four-backtick PDF code fences retain code and surrounding prose", { timeout: 2_000 }, async () => {
  const markdown = ["Before", "", "````typescript", "const answer = 42;", "````", "", "After"].join("\n")
  const doc = parser(markdown)

  const blocks = await doc.parse({ content: PDF, fileName: "fences.pdf", documentId: "four-backticks" })

  assert.deepEqual(blocks.map((block) => [block.type, block.text]), [
    ["paragraph", "Before"],
    ["code", "const answer = 42;"],
    ["paragraph", "After"],
  ])
  assert.equal(blocks[1].metadata.language, "typescript")
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

test("PDF code fences with attributes retain the info string, code and surrounding prose", { timeout: 2_000 }, async () => {
  const markdown = ["Before", "", '```python title="demo"', 'print("demo")', "```", "", "After"].join("\n")
  const doc = parser(markdown)

  const blocks = await doc.parse({ content: PDF, fileName: "attributes.pdf", documentId: "attributes" })

  assert.deepEqual(blocks.map((block) => [block.type, block.text]), [
    ["paragraph", "Before"],
    ["code", 'print("demo")'],
    ["paragraph", "After"],
  ])
  assert.equal(blocks[1].metadata.language, "python")
  assert.equal(blocks[1].metadata.fenceInfo, 'python title="demo"')
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

test("ordinary triple-backtick PDF code fences keep their language and block contract", async () => {
  const doc = parser(["Before", "```typescript", "const answer = 42;", "```", "After"].join("\n"))

  const blocks = await doc.parse({ content: PDF, fileName: "ordinary.pdf", documentId: "ordinary" })

  assert.deepEqual(blocks.map((block) => [block.type, block.text]), [
    ["paragraph", "Before"],
    ["code", "const answer = 42;"],
    ["paragraph", "After"],
  ])
  assert.deepEqual(blocks[1].metadata, {
    sourceLocators: [{ type: "pdf", page: 1, bbox: [0.1, 0.2, 0.9, 0.8], bboxUnit: "ratio" }],
    sourceBlockCount: 1,
    language: "typescript",
  })
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

for (const opening of ["```typescript", '````python title="demo"']) {
  test(`an unfinished PDF fence (${opening}) keeps the original rest and warning`, async () => {
    const rest = [opening, "const answer = 42;", "", "After"].join("\n")
    const doc = parser(`Before\n\n${rest}`)

    const blocks = await doc.parse({ content: PDF, fileName: "unfinished.pdf", documentId: "unfinished" })

    assert.deepEqual(blocks.map((block) => [block.type, block.text]), [
      ["paragraph", "Before"],
      ["paragraph", rest],
    ])
    assert.deepEqual(doc.extractionProvenance()?.warnings, ["docreader_unclosed_code_fence"])
  })
}

test("a four-backtick PDF fence contains shorter fences and closes at a longer fence", async () => {
  const doc = parser([
    "Before",
    "````markdown",
    "```typescript",
    "const answer = 42;",
    "```",
    "`````",
    "After",
  ].join("\n"))

  const blocks = await doc.parse({ content: PDF, fileName: "nested.pdf", documentId: "nested" })

  assert.deepEqual(blocks.map((block) => [block.type, block.text]), [
    ["paragraph", "Before"],
    ["code", "```typescript\nconst answer = 42;\n```"],
    ["paragraph", "After"],
  ])
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

test("continuous and unrecognized PDF fences make progress without dropping raw text", { timeout: 2_000 }, async () => {
  const sample = [
    "Before",
    '```python title="demo"',
    'print("demo")',
    "```",
    "```python `unrecognized`",
    "````typescript",
    "const answer = 42;",
    "````",
    "After",
  ].join("\n")
  const doc = parser(Array(64).fill(sample).join("\n\n"))

  const blocks = await doc.parse({ content: PDF, fileName: "continuous.pdf", documentId: "continuous" })

  assert.equal(blocks.length, 320)
  for (let index = 0; index < 64; index += 1) {
    assert.deepEqual(blocks.slice(index * 5, index * 5 + 5).map((block) => [block.type, block.text]), [
      ["paragraph", "Before"],
      ["code", 'print("demo")'],
      ["paragraph", "```python `unrecognized`"],
      ["code", "const answer = 42;"],
      ["paragraph", "After"],
    ])
  }
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

test("empty consecutive PDF fences consume their delimiters and keep adjacent prose", async () => {
  const doc = parser(["Before", "```", "```", "````", "`````", "After"].join("\n"))

  const blocks = await doc.parse({ content: PDF, fileName: "empty-fences.pdf", documentId: "empty-fences" })

  assert.deepEqual(blocks.map((block) => [block.type, block.text]), [
    ["paragraph", "Before"],
    ["paragraph", "After"],
  ])
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

test("PDF fences retain raw extraction and Unicode page locators through both parser entry points", async () => {
  const markdown = ["Before 😀", "", '````python title="demo"', 'print("demo")', "````", "", "After"].join("\n")
  const fenceStart = Array.from(markdown.slice(0, markdown.indexOf("````"))).length
  const afterStart = Array.from(markdown.slice(0, markdown.indexOf("After"))).length
  const sourceBlocks = [
    { start: 0, end: fenceStart, locatorJson: '{"type":"pdf","page":1}' },
    { start: fenceStart, end: afterStart, locatorJson: '{"type":"pdf","page":2,"bbox":[0.1,0.2,0.9,0.8]}' },
    { start: afterStart, end: Array.from(markdown).length, locatorJson: '{"type":"pdf","page":3}' },
  ]
  const doc = parser(markdown, sourceBlocks)

  const blocks = await doc.parse({ content: PDF, fileName: "locators.pdf", documentId: "locators" })
  const raw = await doc.parseRaw({ content: PDF, fileName: "locators.pdf" })
  const envelope = JSON.parse(raw) as DocReaderRawEnvelope

  assert.equal(envelope.markdown, markdown)
  assert.deepEqual(envelope.sourceBlocks, sourceBlocks)
  assert.deepEqual(doc.normalizeRaw(raw, "locators"), blocks)
  assert.deepEqual(blocks.map((block) => [block.page, block.type, block.text]), [
    [1, "paragraph", "Before 😀"],
    [2, "code", 'print("demo")'],
    [3, "paragraph", "After"],
  ])
  assert.deepEqual(blocks[1].metadata.sourceLocators, [
    { type: "pdf", page: 2, bbox: [0.1, 0.2, 0.9, 0.8], bboxUnit: "ratio" },
  ])
  assert.ok(blocks.every((block) => block.boundingBox === undefined))
  assert.ok(blocks.every((block) => block.provenance.parser === "docreader-pdf" && block.provenance.adapter === "grpc"))
  assert.deepEqual(doc.extractionProvenance()?.warnings, [])
})

test("the knowledge import pipeline indexes PDF fence content and keeps its raw extraction", { timeout: 15_000 }, async () => {
  const { PipelineStageRunner } = await import("../pipeline")
  const { openDb } = await import("../tracking/db")
  const { DocumentRepo } = await import("../tracking/doc_repo")
  const { ExtractionEvidenceRepository } = await import("../tracking/extraction_evidence_repo")
  const db = openDb(":memory:")
  try {
    const documents = new DocumentRepo(db)
    documents.insert({
      docId: "fence-import",
      sourceId: "fence-source",
      contentHash: "synthetic-fence-pdf",
      version: 1,
      title: "Fence PDF",
      source: "fences.pdf",
      content: "",
      rawContent: PDF,
      fileName: "fences.pdf",
      mimeType: "application/pdf",
      tenantId: "tenant-fence",
      allowedGroups: [],
      knowledgeBaseId: "kb-fence",
    })
    const markdown = ["Before", "", '````python title="demo"', 'print("demo")', "````", "", "After"].join("\n")
    const indexed: import("../../types").Chunk[] = []
    const storage = {
      async storeChunks(chunks: import("../../types").Chunk[]) { indexed.push(...chunks) },
      async storeEntities() {},
      async storeWikilinks() {},
      chunkIndexName: "test-fence-chunks",
      async close() {},
    } as unknown as import("../storage").IngestionStoreImpl
    const runner = new PipelineStageRunner(db, (type) => {
      assert.equal(type, "docreader-pdf")
      return parser(markdown)
    }, storage)

    const summary = await runner.run(documents.get("fence-import")!, {
      signal: new AbortController().signal,
      executionId: "fence-import-test",
      async runStage(_name, _input, operation, summarize) {
        const result = await operation()
        summarize(result)
        return result
      },
    })

    assert.equal(summary.parser, "docreader-pdf")
    assert.equal(summary.normalizedBlockCount, 3)
    const content = indexed.map((chunk) => chunk.content).join("\n")
    for (const text of ["Before", 'print("demo")', "After"]) assert.ok(content.includes(text))
    const extraction = new ExtractionEvidenceRepository(db).get("fence-import", 1)
    assert.equal(extraction?.valid, true)
    const envelope = JSON.parse(extraction!.artifact.rawExtraction) as DocReaderRawEnvelope
    assert.equal(envelope.markdown, markdown)
    assert.equal(envelope.sourceBlocks[0].locatorJson, '{"type":"pdf","page":1,"bbox":[0.1,0.2,0.9,0.8]}')
  } finally {
    db.close()
  }
})

test("a PDF attachment becomes ready and searchable through the same fence parser", { timeout: 15_000 }, async () => {
  const { SessionAttachmentService } = await import("../../attachments/session_attachment_service")
  const { openDb } = await import("../tracking/db")
  const db = openDb(":memory:")
  try {
    const markdown = ["Before", "", "````typescript", "const answer = 42;", "````", "", "After"].join("\n")
    const service = new SessionAttachmentService(db, {
      parserFor: (type) => {
        assert.equal(type, "docreader-pdf")
        return parser(markdown)
      },
    })
    const [outcome] = await service.submit("fence-session", "tenant-fence", "alice", [{
      name: "fences.pdf",
      mimeType: "application/pdf",
      content: PDF,
    }])
    assert.ok(outcome.ok)
    const attachmentId = outcome.attachment.id
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (service.get(attachmentId, "fence-session", "tenant-fence", "alice")?.status !== "parsing") break
      await delay(10)
    }

    const attachment = service.get(attachmentId, "fence-session", "tenant-fence", "alice")
    assert.equal(attachment?.status, "ready", attachment?.error ?? "attachment should be ready")
    for (const query of ["Before", "answer", "After"]) {
      const hits = await service.search({
        sessionId: "fence-session",
        tenantId: "tenant-fence",
        subjectId: "alice",
        query,
        limit: 20,
      })
      assert.ok(hits.some((hit) => hit.chunk.content.includes(query)), `attachment content should retain ${query}`)
    }
  } finally {
    db.close()
  }
})
