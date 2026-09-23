/**
 * Ticket 27 (EVAL-01B2) — normal chat and evaluation must not drift apart.
 *
 * Acceptance for EVAL-01B2 says the ordinary chat path and an evaluation task
 * "use the same shared answer and rerank behavior for the comparison case".
 * Ticket 28 then compares two assistant snapshots, so the comparison only means
 * something while both paths compose the SAME answer entry, the SAME retrieval
 * operations and the SAME dedicated reranker adapter (one factory, one config
 * surface). These assertions pin that invariant structurally: a second entry, a
 * second searcher or a second reranker implementation would silently make every
 * reported difference ambiguous.
 *
 * The behavioral halves live next to their owners: `src/mastra/shared_answer_entry.test.ts`
 * (the entry stamps one frozen model snapshot per composition),
 * `src/retrieval/search/rerank_ordering.test.ts` (the shared operations publish
 * a dedicated-rerank order) and `src/api/evaluations.test.ts` (a task override
 * changes that task only).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(__dirname, "..", "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

/** Argument names of every `createDedicatedReranker({ ... })` call in a source. */
function rerankerCallArgNames(source: string): string[][] {
  const marker = "createDedicatedReranker({"
  const calls: string[][] = []
  let index = source.indexOf(marker)
  while (index !== -1) {
    const body = source.slice(index + marker.length, source.indexOf("})", index))
    calls.push(
      [...body.matchAll(/^\s*(\w+)\s*[:,]/gm)].map((match) => match[1]).sort()
    )
    index = source.indexOf(marker, index + marker.length)
  }
  return calls
}

test("chat and evaluation compose the same shared answer entry", () => {
  const chatRoot = read("src/index.ts")
  const evalScope = read("src/evaluation/isolated_resources.ts")
  assert.match(chatRoot, /createSharedAnswerEntry\(/, "normal chat composes the shared entry")
  assert.match(
    evalScope,
    /createSharedAnswerEntry\(/,
    "an isolated evaluation scope composes the same entry"
  )
  assert.equal(
    (
      read("src/mastra/shared_answer_entry.ts").match(
        /export async function createSharedAnswerEntry\(/g
      ) ?? []
    ).length,
    1,
    "there is exactly one shared answer entry implementation"
  )
})

test("both paths retrieve through the same operations and searcher", () => {
  const entry = read("src/mastra/shared_answer_entry.ts")
  const evalScope = read("src/evaluation/isolated_resources.ts")
  for (const [name, source] of [
    ["shared_answer_entry", entry],
    ["isolated_resources", evalScope],
  ] as const) {
    assert.match(source, /new RuntimeSearchOperations\(/, `${name} builds the shared operations`)
  }
  // Ticket 31 (FAQ-01B): the searcher is built through the local helper that
  // adds the FAQ evidence channel — same shared operations, same SearcherImpl.
  // Ticket 36 (WEB-01): the helper also carries the optional web channel.
  assert.match(
    entry,
    /const buildSearcher = \(operations: SearchOperations\) =>\s*new SearcherImpl\(operations, options\.attachments, faqEvidence, options\.web\)/,
    "chat searches through the shared SearcherImpl over those operations"
  )
  assert.match(
    evalScope,
    /searchOperations: new RuntimeSearchOperations\(\{/,
    "the evaluation scope IS its operations injection into the same entry"
  )
  assert.match(evalScope, /new PageIndexRepository\(db\)/, "evaluation reads PageIndex from its own db")
})

test("the dedicated reranker keeps one adapter and one config surface", () => {
  const sources = [
    "src/mastra/shared_answer_entry.ts",
    "src/api/server.ts",
    "src/evaluation/isolated_resources.ts",
  ].map(read)
  const shapes = new Set(
    sources.flatMap(rerankerCallArgNames).map((names) => names.join(","))
  )
  assert.equal(
    shapes.size,
    1,
    `every call site must pass the same config keys, saw: ${[...shapes].join(" | ")}`
  )
  assert.deepEqual(
    [...shapes][0].split(","),
    ["apiKey", "baseUrl", "maxDocumentChars", "model", "timeoutMs"],
    "the adapter's config surface is the RERANK_* set"
  )
  assert.match(read("src/api/server.ts"), /createReranker: \(model\) =>/, "a rerank override reuses the same factory")
})
