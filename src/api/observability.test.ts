import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

/**
 * Eval refactor Ticket 16 — the old RAGAS read entry is gone.
 *
 * The file-backed `/api/observability/ragas` route, its client and its
 * `./data/ragas-latest.json` fallback must not come back, and the removal must
 * not have taken the neighbouring surfaces with it.
 *
 * The RAGAS engine/config removal landed in eval-refactor ticket 17; these
 * assertions are about the removed SURFACE only.
 */

const root = join(__dirname, "..", "..")
const read = (relative: string) => readFileSync(join(root, relative), "utf8")

test("the file-backed RAGAS read route no longer exists", () => {
  assert.equal(
    existsSync(join(root, "src/api/observability.ts")),
    false,
    "the route module is deleted, not merely unmounted"
  )
  const server = read("src/api/server.ts")
  assert.equal(/ragas/i.test(server), false, "the API layer holds no RAGAS reference")
  assert.equal(
    /observability/i.test(server),
    false,
    "and no mount point for a read-only observability surface"
  )
})

test("no shipped server code reads an evaluation artifact from disk", () => {
  const apiFiles = ["src/api/server.ts", "src/index.ts"]
  for (const file of apiFiles) {
    const source = read(file)
    assert.equal(
      /ragas-latest\.json|data\/ragas/i.test(source),
      false,
      `${file} must not fall back to a RAGAS artifact file`
    )
  }
  // The stale artifacts under data/ were removed with the engine in
  // eval-refactor ticket 17; what matters here is that nothing reads them.

})

test("the switch kept the neighbouring API surfaces mounted", () => {
  const server = read("src/api/server.ts")
  for (const mount of [
    "createChatRouter",
    "rawIngestRouter",
    "createStatusRouter",
    "createSourceGovernanceRouter",
    "createDocumentsRouter",
  ]) {
    assert.ok(server.includes(mount), `${mount} is still wired after the switch`)
  }
})
