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
  // Ticket 49 (ARCH-01B): the retrieval assembly moved into the entry's
  // internal AnswerRetrievalStack. The invariant is unchanged — one set of
  // operations, one searcher implementation, shared by chat and evaluation —
  // it is now owned by a different file, so the scan follows it there.
  const retrievalStack = read("src/mastra/answer_retrieval_stack.ts")
  const entry = read("src/mastra/shared_answer_entry.ts")
  const evalScope = read("src/evaluation/isolated_resources.ts")
  for (const [name, source] of [
    ["answer_retrieval_stack", retrievalStack],
    ["isolated_resources", evalScope],
  ] as const) {
    assert.match(source, /new RuntimeSearchOperations\(/, `${name} builds the shared operations`)
  }
  // The entry no longer assembles retrieval itself: it consumes the stack's
  // operations and searcher factory and has no direct SearcherImpl seam.
  assert.doesNotMatch(
    entry,
    /new SearcherImpl\(/,
    "the entry delegates searcher construction to the retrieval stack"
  )
  // Ticket 31 (FAQ-01B) + Ticket 22 (ATT-01) + Ticket 36 (WEB-01): the ONE
  // searcher factory wires the optional FAQ/attachment/web channels alongside
  // the operations. This is a source-text check on the factory's argument
  // list, and it is honestly only that: it proves one `new SearcherImpl` exists
  // in the stack and names all four channels where it is built, so moving the
  // factory to another file means retargeting this scan (done in ARCH-01B), not
  // that a dropped channel is caught semantically. The channels' actual wiring
  // is behavior-tested in the retrieval-stack suite.
  const searcherCalls = retrievalStack.match(/new SearcherImpl\(([^)]*)\)/g) ?? []
  assert.equal(searcherCalls.length, 1, "the stack builds searchers through one factory")
  const searcherArgs = searcherCalls[0]
  for (const channel of ["operations", "attachments", "faqEvidence", "web"]) {
    assert.ok(
      searcherArgs.includes(channel),
      `the searcher factory must keep the ${channel} channel`
    )
  }
  assert.match(
    evalScope,
    /searchOperations: new RuntimeSearchOperations\(\{/,
    "the evaluation scope IS its operations injection into the same entry"
  )
  assert.match(evalScope, /new PageIndexRepository\(db\)/, "evaluation reads PageIndex from its own db")
})

test("the dedicated reranker keeps one adapter and one config surface", () => {
  const sources = [
    "src/mastra/answer_retrieval_stack.ts",
    "src/api/server.ts",
    "src/evaluation/isolated_resources.ts",
  ].map(read)
  const shapes = new Set(
    sources.flatMap(rerankerCallArgNames).map((names) => names.join(","))
  )
  assert.ok(
    rerankerCallArgNames(read("src/mastra/answer_retrieval_stack.ts")).length >= 1,
    "the retrieval stack must still be one of the scanned reranker call sites"
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
