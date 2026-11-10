import assert from "node:assert/strict"
import test from "node:test"
import { DocReaderError, type DocReaderReadRequest } from "./docreader_client"
import {
  DocReaderPdfParser,
  docreaderParserConfigVersion,
  type DocReaderClientLike,
} from "./docreader_pdf"
import type { ReadStreamResponse__Output } from "./docreader_types/docreader/ReadStreamResponse"

function codePointOffset(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length
}

function metaFrame(
  markdown: string,
  sourceBlocks: Array<{ start: number; end: number; locatorJson: string }> = [],
  overrides: Partial<{ imageCount: number; error: string }> = {}
): ReadStreamResponse__Output {
  return {
    meta: {
      markdown_content: markdown,
      image_dir_path: "",
      metadata: {},
      error: overrides.error ?? "",
      image_count: overrides.imageCount ?? 0,
      source_blocks: sourceBlocks.map((block) => ({
        start: block.start,
        end: block.end,
        locator_json: block.locatorJson,
      })),
    },
  } as ReadStreamResponse__Output
}

function imageFrame(filename: string, bytes = "image"): ReadStreamResponse__Output {
  return {
    image: {
      filename,
      original_ref: "page-1",
      mime_type: "image/jpeg",
      storage_key: "",
      image_data: Buffer.from(bytes),
    },
  } as ReadStreamResponse__Output
}

function client(frames: ReadStreamResponse__Output[], onRequest?: (request: DocReaderReadRequest) => void): DocReaderClientLike {
  return {
    async *readStream(request) {
      onRequest?.(request)
      for (const frame of frames) yield frame
    },
    close() {},
  }
}

function parser(
  frames: ReadStreamResponse__Output[],
  options: Partial<ConstructorParameters<typeof DocReaderPdfParser>[0]> = {},
  onRequest?: (request: DocReaderReadRequest) => void
): DocReaderPdfParser {
  return new DocReaderPdfParser({
    address: "127.0.0.1:50051",
    timeoutMs: 5_000,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
    clientFactory: () => client(frames, onRequest),
    ...options,
  })
}

const PDF = Buffer.from("%PDF-1.7\n")

for (const declared of [0, 1]) {
  test(`an image beyond the declared count ${declared} is rejected before processing`, async () => {
    let ocrCalls = 0
    const doc = parser([
      metaFrame("native text", [], { imageCount: declared }),
      ...Array.from({ length: declared + 1 }, (_, index) => imageFrame(`images/figure_${index}.jpg`)),
    ], {
      ocrPage: async () => {
        ocrCalls += 1
        throw new Error("unexpected OCR for a figure")
      },
    })
    await assert.rejects(doc.parseRaw({ content: PDF, fileName: "extra.pdf" }), (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_invalid_stream")
      return true
    })
    assert.equal(ocrCalls, 0)
  })
}

test("native markdown becomes page-aware blocks with ratio locators and no boundingBox", async () => {
  const markdown = [
    "# Title",
    "",
    "Intro paragraph with emoji 😀 and text.",
    "",
    "| Region | Window |",
    "| --- | --- |",
    "| CN | 30 days |",
    "",
  ].join("\n")
  const headingEnd = codePointOffset(markdown, markdown.indexOf("\n\n"))
  const paragraphStart = codePointOffset(markdown, markdown.indexOf("Intro"))
  const paragraphEnd = codePointOffset(markdown, markdown.indexOf("\n\n| Region"))
  const tableStart = codePointOffset(markdown, markdown.indexOf("| Region"))
  const tableEnd = codePointOffset(markdown, markdown.length)
  const doc = parser([
    metaFrame(markdown, [
      { start: 0, end: headingEnd, locatorJson: '{"type":"pdf","page":1,"bbox":[0.1,0.1,0.9,0.2]}' },
      { start: paragraphStart, end: paragraphEnd, locatorJson: '{"type":"pdf","page":1}' },
      { start: tableStart, end: tableEnd, locatorJson: '{"type":"pdf","page":2}' },
    ]),
  ])

  const raw = await doc.parseRaw({ content: PDF, fileName: "sample.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-1")

  assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "table"])
  assert.equal(blocks[0].headingLevel, 1)
  assert.equal(blocks[1].text, "Intro paragraph with emoji 😀 and text.")
  assert.equal(blocks[1].page, 1)
  assert.equal(blocks[2].page, 2)
  assert.deepEqual(blocks[2].table, { headers: ["Region", "Window"], rows: [["CN", "30 days"]] })
  assert.equal(blocks[2].boundingBox, undefined)
  assert.deepEqual(
    (blocks[0].metadata.sourceLocators as Array<Record<string, unknown>>)[0],
    { type: "pdf", page: 1, bbox: [0.1, 0.1, 0.9, 0.2], bboxUnit: "ratio" }
  )
  assert.ok(blocks.every((block) => block.provenance.parser === "docreader-pdf"))
  assert.ok(blocks.every((block) => block.provenance.adapter === "grpc"))
})

test("Unicode code point offsets map correctly across an emoji", async () => {
  const markdown = "First 😀 line\n\nSecond line\n"
  const firstEnd = codePointOffset(markdown, markdown.indexOf("\n\n"))
  const secondStart = codePointOffset(markdown, markdown.indexOf("Second"))
  const doc = parser([
    metaFrame(markdown, [
      { start: 0, end: firstEnd, locatorJson: '{"type":"pdf","page":1}' },
      { start: secondStart, end: codePointOffset(markdown, markdown.length), locatorJson: '{"type":"pdf","page":2}' },
    ]),
  ])
  const raw = await doc.parseRaw({ content: PDF, fileName: "emoji.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-emoji")
  assert.deepEqual(blocks.map((block) => block.page), [1, 2])
})

test("a table spanning two source blocks stays one table with a locator list", async () => {
  const markdown = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n"
  const split = markdown.indexOf("\n| 3")
  const doc = parser([
    metaFrame(markdown, [
      { start: 0, end: codePointOffset(markdown, split), locatorJson: '{"type":"pdf","page":2}' },
      { start: codePointOffset(markdown, split + 1), end: codePointOffset(markdown, markdown.length), locatorJson: '{"type":"pdf","page":3}' },
    ]),
  ])
  const raw = await doc.parseRaw({ content: PDF, fileName: "table.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-table")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "table")
  assert.equal(blocks[0].page, 2)
  assert.equal((blocks[0].metadata.sourceLocators as unknown[]).length, 2)
})

test("a missing or invalid locator degrades to a warning and keeps the text", async () => {
  const markdown = "Some body text\n"
  const doc = parser([
    metaFrame(markdown, [
      { start: 0, end: codePointOffset(markdown, markdown.length), locatorJson: "not-json" },
    ]),
  ])
  const raw = await doc.parseRaw({ content: PDF, fileName: "locator.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-locator")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].page, undefined)
  assert.equal(blocks[0].metadata.sourceLocators, undefined)
  assert.ok(doc.extractionProvenance()?.warnings.includes("docreader_source_locator_invalid"))
})

test("meta.error is a terminal parse failure", async () => {
  const doc = parser([metaFrame("", [], { error: "parser exploded" })])
  await assert.rejects(
    doc.parseRaw({ content: PDF, fileName: "bad.pdf" }),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_parse_failed")
      assert.equal(error.category, "permanent_input")
      return true
    }
  )
})

test("an image before metadata is an invalid stream", async () => {
  const doc = parser([imageFrame("images/x_page_1.jpg"), metaFrame("text")])
  await assert.rejects(
    doc.parseRaw({ content: PDF, fileName: "stream.pdf" }),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_invalid_stream")
      return true
    }
  )
})

test("a declared image that never arrives is an image-missing failure", async () => {
  const doc = parser([metaFrame("text", [], { imageCount: 1 })])
  await assert.rejects(
    doc.parseRaw({ content: PDF, fileName: "missing.pdf" }),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_image_missing")
      return true
    }
  )
})

test("scanned pages without an OCR stage fail explicitly, not as empty success", async () => {
  const doc = parser([
    metaFrame("", [], { imageCount: 1 }),
    imageFrame("images/x_page_1.jpg"),
  ])
  await assert.rejects(
    doc.parseRaw({ content: PDF, fileName: "scan.pdf" }),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_ocr_required")
      assert.equal(error.category, "capability_missing")
      return true
    }
  )
})

test("force-scanned uses the DocReader override and a stable SHA filename", async () => {
  let seen: DocReaderReadRequest | undefined
  const doc = parser([metaFrame("text")], { forceScanned: true }, (request) => { seen = request })
  await doc.parseRaw({ content: PDF, fileName: "original.pdf" })
  assert.equal(seen?.parserEngine, "builtin")
  assert.deepEqual(seen?.parserEngineOverrides, { pdf_force_scanned: "true" })
  assert.match(seen?.fileName ?? "", /^[a-f0-9]{64}\.pdf$/)
  assert.equal(seen?.fileType, "pdf")
})

test("the extraction fingerprint changes with force mode and stays stable otherwise", () => {
  const base = {
    timeoutMs: 300_000,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
  }
  const auto = docreaderParserConfigVersion({ ...base, forceScanned: false })
  const force = docreaderParserConfigVersion({ ...base, forceScanned: true })
  assert.equal(auto, docreaderParserConfigVersion({ ...base, forceScanned: false }))
  assert.notEqual(auto, force)
})

test("an envelope larger than the output limit fails instead of being persisted", async () => {
  const doc = parser([metaFrame("some text")], { outputLimitBytes: 10 })
  await assert.rejects(
    doc.parseRaw({ content: PDF, fileName: "large.pdf" }),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_invalid_request")
      return true
    }
  )
})

test("scanned pages are OCR'd and merged into page order even when images arrive reversed", async () => {
  const doc = parser(
    [
      metaFrame("", [], { imageCount: 2 }),
      imageFrame("images/scan_page_2.jpg", "two"),
      imageFrame("images/scan_page_1.jpg", "one"),
    ],
    {
      ocrPage: async (input) => ({
        page: input.page,
        text: `Page ${input.page} text`,
        raw: { page: input.page },
        warnings: [],
      }),
    }
  )
  const raw = await doc.parseRaw({ content: PDF, fileName: "scan.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-scan")
  assert.deepEqual(blocks.map((block) => [block.page, block.text]), [
    [1, "Page 1 text"],
    [2, "Page 2 text"],
  ])
  assert.ok(blocks.every((block) => block.metadata.docreaderOcr === true))
})

test("a legal empty OCR page is skipped, while an all-empty document fails", async () => {
  const doc = parser(
    [
      metaFrame("", [], { imageCount: 2 }),
      imageFrame("images/scan_page_1.jpg", "one"),
      imageFrame("images/scan_page_2.jpg", "two"),
    ],
    {
      ocrPage: async (input) => ({
        page: input.page,
        text: input.page === 1 ? "" : "Body on page two",
        raw: {},
        warnings: [],
      }),
    }
  )
  const raw = await doc.parseRaw({ content: PDF, fileName: "empty-page.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-empty-page")
  assert.deepEqual(blocks.map((block) => [block.page, block.text]), [[2, "Body on page two"]])

  const allEmpty = parser(
    [
      metaFrame("", [], { imageCount: 1 }),
      imageFrame("images/scan_page_1.jpg", "one"),
    ],
    { ocrPage: async (input) => ({ page: input.page, text: "", raw: {}, warnings: [] }) }
  )
  const emptyRaw = await allEmpty.parseRaw({ content: PDF, fileName: "all-empty.pdf" })
  assert.throws(
    () => allEmpty.normalizeRaw(emptyRaw, "doc-all-empty"),
    (error: unknown) => {
      assert.ok(error instanceof DocReaderError)
      assert.equal(error.reasonCode, "docreader_no_extractable_text")
      return true
    }
  )
})

test("a mixed native/scan PDF keeps native and OCR blocks in page order", async () => {
  const markdown = "# Native page\n"
  const doc = parser(
    [
      metaFrame(markdown, [
        { start: 0, end: codePointOffset(markdown, markdown.length), locatorJson: '{"type":"pdf","page":1}' },
      ], { imageCount: 1 }),
      imageFrame("images/scan_page_2.jpg", "two"),
    ],
    {
      ocrPage: async (input) => ({
        page: input.page,
        text: "Scanned page two",
        raw: {},
        warnings: [],
      }),
    }
  )
  const raw = await doc.parseRaw({ content: PDF, fileName: "mixed.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-mixed")
  assert.deepEqual(blocks.map((block) => [block.page, block.type]), [
    [1, "heading"],
    [2, "paragraph"],
  ])
})

test("an OCR failure aborts the whole parse", async () => {
  const doc = parser(
    [
      metaFrame("", [], { imageCount: 1 }),
      imageFrame("images/scan_page_1.jpg", "one"),
    ],
    { ocrPage: async () => { throw new Error("ocr unavailable") } }
  )
  await assert.rejects(doc.parseRaw({ content: PDF, fileName: "ocr-fail.pdf" }), /ocr unavailable/)
})

test("image-only markdown is never indexed as paragraph text", async () => {
  const markdown = "![page](images/x_page_1.jpg)\n\nOCR body text\n\n<img src=\"images/y_page_2.jpg\">"
  const doc = parser([metaFrame(markdown)])
  const raw = await doc.parseRaw({ content: PDF, fileName: "images.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-images")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, "OCR body text")
})

test("aligned DocReader text is reconstructed as a table while the caption stays a paragraph", async () => {
  const markdown = [
    "费用项目 金额 是否可退",
    "手续费 50 元 是",
    "运费 30 元 否",
    "打包费 20 元 是",
    "表格下方说明 ： 以上费率不含税 ，校验词 表-1 。",
  ].join("\n")
  const doc = parser([metaFrame(markdown)])
  const raw = await doc.parseRaw({ content: PDF, fileName: "table.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-whitespace-table")
  assert.deepEqual(blocks.map((block) => block.type), ["table", "paragraph"])
  assert.deepEqual(blocks[0].table, {
    headers: ["费用项目", "金额", "是否可退"],
    rows: [
      ["手续费", "50元", "是"],
      ["运费", "30元", "否"],
      ["打包费", "20元", "是"],
    ],
  })
  assert.match(blocks[0].text, /\| 费用项目 \| 金额 \| 是否可退 \|/)
  assert.match(blocks[1].text, /表格下方说明/)
})

test("wrapped whitespace table rows are assembled without inventing cells", async () => {
  const markdown = [
    "姓名 金额 是否退款",
    "张三 50元",
    "是",
    "李四 30元",
    "否",
  ].join("\n")
  const doc = parser([metaFrame(markdown)])
  const raw = await doc.parseRaw({ content: PDF, fileName: "wrapped-table.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-wrapped-table")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "table")
  assert.deepEqual(blocks[0].table, {
    headers: ["姓名", "金额", "是否退款"],
    rows: [["张三", "50元", "是"], ["李四", "30元", "否"]],
  })
})

test("ordinary prose with numbers stays a paragraph, not a table", async () => {
  const markdown = [
    "第一页：本样本用于逐页真值核对。",
    "订单编号：A-2026-1004，金额 50 元。",
    "第三页：顺序校验 甲、乙、丙。",
  ].join("\n")
  const doc = parser([metaFrame(markdown)])
  const raw = await doc.parseRaw({ content: PDF, fileName: "prose.pdf" })
  const blocks = doc.normalizeRaw(raw, "doc-prose")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "paragraph")
})
