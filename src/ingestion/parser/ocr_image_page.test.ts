import assert from "node:assert/strict"
import test from "node:test"
import { OcrApiError } from "../error_classification"
import { OcrApiParser } from "./ocr_api"

function ocrResponse(detail: unknown[]): Response {
  return new Response(JSON.stringify({ code: 10000, data: { detail: JSON.stringify(detail) } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function parserWith(
  responder: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof OcrApiParser>[0]> = {}
): OcrApiParser {
  return new OcrApiParser({
    accessKeyId: "test-ak",
    secretAccessKey: "test-sk",
    timeoutMs: 5_000,
    inputLimitBytes: 1024 * 1024,
    outputLimitBytes: 1024 * 1024,
    fetch: ((url: string | URL | Request, init?: RequestInit) =>
      responder(String(url), init ?? {})) as typeof fetch,
    ...overrides,
  })
}

test("readImagePage uses the OCR image form and preserves textblock order", async () => {
  let seenBody = ""
  const parser = parserWith(async (_url, init) => {
    seenBody = String(init.body ?? "")
    return ocrResponse([
      {
        page_id: 0,
        page_md: "",
        textblocks: [
          { label: "text", text: "Hello" },
          { label: "title", text: "Title" },
        ],
      },
    ])
  })
  const result = await parser.readImagePage({
    image: Buffer.from("jpeg-bytes"),
    page: 3,
    fileName: "images/x_page_3.jpg",
    timeoutMs: 5_000,
  })
  assert.equal(result.page, 3)
  assert.equal(result.text, "Hello\n\nTitle")
  assert.deepEqual(result.warnings, [])
  assert.match(seenBody, /file_type=image/)
  assert.match(seenBody, /page_num=1/)
  assert.match(seenBody, /image_base64=/)
})

test("readImagePage accepts a legal empty page", async () => {
  const parser = parserWith(async () => ocrResponse([{ page_id: 0, page_md: "", textblocks: [] }]))
  const result = await parser.readImagePage({
    image: Buffer.from("jpeg-bytes"),
    page: 1,
    fileName: "images/x_page_1.jpg",
    timeoutMs: 5_000,
  })
  assert.equal(result.text, "")
  assert.deepEqual(result.warnings, [])
})

test("readImagePage falls back to page_md when textblocks are absent", async () => {
  const parser = parserWith(async () => ocrResponse([{ page_id: 0, page_md: "Fallback text" }]))
  const result = await parser.readImagePage({
    image: Buffer.from("jpeg-bytes"),
    page: 2,
    fileName: "images/x_page_2.jpg",
    timeoutMs: 5_000,
  })
  assert.equal(result.text, "Fallback text")
  assert.ok(result.warnings.includes("ocr_layout_missing"))
})

test("readImagePage classifies provider failures without leaking messages", async () => {
  const parser = parserWith(async () => new Response("", { status: 403 }))
  await assert.rejects(
    parser.readImagePage({
      image: Buffer.from("jpeg-bytes"),
      page: 1,
      fileName: "images/x_page_1.jpg",
      timeoutMs: 5_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OcrApiError)
      assert.equal(error.category, "capability_missing")
      assert.match(error.message, /HTTP 403/)
      return true
    }
  )
})

test("readImagePage rejects an oversized image before calling the provider", async () => {
  let called = false
  const parser = parserWith(
    async () => {
      called = true
      return ocrResponse([{ page_id: 0, page_md: "", textblocks: [] }])
    },
    { inputLimitBytes: 4 }
  )
  await assert.rejects(
    parser.readImagePage({
      image: Buffer.alloc(5, 1),
      page: 1,
      fileName: "images/x_page_1.jpg",
      timeoutMs: 5_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OcrApiError)
      assert.equal(error.category, "permanent_input")
      return true
    }
  )
  assert.equal(called, false)
})

test("readImagePage honors a pre-aborted signal", async () => {
  const parser = parserWith(async () => ocrResponse([{ page_id: 0, page_md: "", textblocks: [] }]))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    parser.readImagePage({
      image: Buffer.from("jpeg-bytes"),
      page: 1,
      fileName: "images/x_page_1.jpg",
      timeoutMs: 5_000,
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError")
      return true
    }
  )
})
