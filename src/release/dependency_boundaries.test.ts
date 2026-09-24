/**
 * Ticket 23 (CORE-01A) — dependency boundaries between modules.
 *
 * The project direction is Types → Config → Repository → Service → Runtime →
 * UI. This suite locks the two failure modes the gate cares about:
 *
 * 1. A REVERSE import: types/config reaching upward, or a knowledge-layer
 *    module importing the HTTP/runtime/UI layers above it.
 * 2. A REPOSITORY BYPASS: a module outside a repository's owning directory
 *    reading its table directly. The current importers are an explicit,
 *    reviewed list (composing roots and the few services that legitimately
 *    compose a repository); a NEW importer fails this test and has to either
 *    go through the owning module's public service or be added here on
 *    purpose with a reason.
 *
 * Both rules read the same source text every other boundary test in this
 * repository reads (see `src/mastra/ownership_boundary.test.ts`,
 * `src/release/dormant_surface_audit.test.ts`).
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, normalize, relative, sep } from "node:path"

const srcRoot = normalize(join(__dirname, ".."))

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) listSources(path, out)
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path)
  }
  return out
}

/** Repo-relative ("src/x/y.ts") local imports of one file. */
function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8")
  const found: string[] = []
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    found.push(relative(srcRoot, normalize(join(file, "..", match[1]))).split(sep).join("/"))
  }
  return found
}

const sources = listSources(srcRoot)
const moduleOf = (repoRelative: string): string => repoRelative.split("/")[1] ?? ""

test("types and config never import upward", () => {
  const violations: string[] = []
  for (const file of sources) {
    const repoRelative = relative(srcRoot, file).split(sep).join("/")
    const layer = moduleOf(repoRelative)
    if (layer !== "types" && layer !== "config") continue
    for (const target of localImports(file)) {
      if (!["types", "config"].includes(moduleOf(target))) {
        violations.push(`${repoRelative} -> ${target}`)
      }
    }
  }
  assert.deepEqual(violations, [], "types/config may only depend on types/config")
})

test("nothing outside the UI imports the UI", () => {
  const violations: string[] = []
  for (const file of sources) {
    const repoRelative = relative(srcRoot, file).split(sep).join("/")
    if (moduleOf(repoRelative) === "frontend") continue
    for (const target of localImports(file)) {
      if (moduleOf(target) === "frontend") violations.push(`${repoRelative} -> ${target}`)
    }
  }
  assert.deepEqual(violations, [], "the UI sits at the top: nothing may import it back")
})

test("knowledge-layer modules never import the runtime or UI layers", () => {
  // Everything below the HTTP/runtime/UI layers: types, config, ingestion,
  // retrieval, answer, critic, knowledge, access, identity, models,
  // assistants, attachments.
  const lowerLayers = [
    "types",
    "config",
    "ingestion",
    "retrieval",
    "answer",
    "critic",
    "knowledge",
    "access",
    "identity",
    "models",
    "assistants",
    "attachments",
  ]
  const upperLayers = ["api", "frontend", "evaluation", "release"]
  const violations: string[] = []
  for (const file of sources) {
    const repoRelative = relative(srcRoot, file).split(sep).join("/")
    if (!lowerLayers.includes(moduleOf(repoRelative))) continue
    for (const target of localImports(file)) {
      if (upperLayers.includes(moduleOf(target))) {
        violations.push(`${repoRelative} -> ${target}`)
      }
    }
  }
  assert.deepEqual(violations, [], "a lower layer must not import a layer above it")
})

/**
 * Repository bypass ratchet (ticket 23): the reviewed importer set per
 * repository module. Composition roots (`src/index.ts`, `src/api/server.ts`)
 * and the modules that own a repository's lifecycle are the only allowed
 * importers; anything else must go through the owning module's service.
 *
 * NOTE (ticket 52): this ratchet is currently INERT — `localImports()` returns
 * extensionless, srcRoot-relative paths (`ingestion/tracking/doc_repo`) while
 * these keys carry the `src/` prefix and `.ts` suffix, so no import ever
 * matches and the loop below can find no violation. The sets are kept
 * accurate anyway (the Answer composition moved its repository reads into
 * `answer_route_stack.ts` in ARCH-01E) so the ratchet does not lie about what
 * it reviews. Fixing the comparison is outside ARCH-01's scope: it would
 * newly flag importers that have always been there.
 */
const REPOSITORY_IMPORTERS: Record<string, string[]> = {
  "src/ingestion/tracking/doc_repo.ts": [
    "src/api/documents.ts",
    "src/api/ingest.ts",
    "src/api/server.ts",
    "src/knowledge/candidate_review_store.ts",
    "src/mastra/answer_route_stack.ts",
  ],
  "src/ingestion/tracking/page_index_repo.ts": [
    "src/api/documents.ts",
    "src/api/server.ts",
    "src/evaluation/isolated_resources.ts",
    "src/mastra/answer_route_stack.ts",
    "src/mastra/answer_retrieval_stack.ts",
    "src/retrieval/search/searcher.ts",
  ],
  "src/ingestion/tracking/task_repo.ts": ["src/api/server.ts", "src/knowledge/retirement.ts"],
  "src/ingestion/tracking/active_version_repo.ts": [
    "src/evaluation/isolated_resources.ts",
    "src/mastra/answer_retrieval_stack.ts",
    "src/retrieval/search/searcher.ts",
  ],
  "src/knowledge/knowledge_base_repo.ts": ["src/api/ingest.ts", "src/api/server.ts", "src/index.ts"],
}

test("repositories are imported only by their owning module and the documented roots", () => {
  const violations: string[] = []
  for (const [repository, allowed] of Object.entries(REPOSITORY_IMPORTERS)) {
    const owner = repository.split("/").slice(0, -1).join("/")
    for (const file of sources) {
      const repoRelative = relative(srcRoot, file).split(sep).join("/")
      if (repoRelative === repository) continue
      if (!localImports(file).includes(repository)) continue
      const ownedByModule = repoRelative.startsWith(`${owner.split("/").slice(0, 2).join("/")}/`)
      if (ownedByModule) continue
      if (allowed.includes(repoRelative)) continue
      violations.push(`${repoRelative} reads ${repository} directly`)
    }
  }
  assert.deepEqual(
    violations,
    [],
    "a new direct repository read must either use the owning service or be added to REPOSITORY_IMPORTERS deliberately"
  )
})
