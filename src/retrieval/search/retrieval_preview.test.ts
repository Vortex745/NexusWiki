import assert from "node:assert/strict"
import test from "node:test"
import { retrievalPreview } from "./searcher"
import type { RetrievalResult } from "../../types"

/** LO-12-AC02: the retrieval preview is bounded (25 results × 160 chars). */

function result(index: number, content: string): RetrievalResult {
  return {
    chunk: { id: `chunk-${index}`, documentId: `doc-${index}`, content, index },
    score: 0.5,
  } as unknown as RetrievalResult
}

test("LO-12-AC02: at most 25 results survive the preview", () => {
  const results = Array.from({ length: 60 }, (_, index) => result(index, `body-${index}`))
  const preview = retrievalPreview(results)
  assert.equal(preview.length, 25)
  assert.equal(preview[0], "body-0")
  assert.equal(preview[24], "body-24")
})

test("LO-12-AC02: each preview is capped at 160 characters", () => {
  const long = "文".repeat(500)
  const preview = retrievalPreview([result(0, long), result(1, "short")])
  assert.equal(preview[0].length, 160)
  assert.equal(preview[1], "short")
})
