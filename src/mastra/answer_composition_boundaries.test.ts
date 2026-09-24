/**
 * Ticket 48 (ARCH-01A) — Shared Answer composition AREA dependency direction.
 *
 * ARCH-01 (ticket 47) splits the shared Answer composition root into two deep
 * internal modules. This file freezes the rule that makes that split safe:
 * nothing reachable from the Answer composition root may point back up into
 * the HTTP layer, the evaluation module, the process entry or the frontend.
 *
 * The area is DERIVED, not hand-listed: it is the transitive closure of the
 * relative imports of `shared_answer_entry.ts`. A stack file extracted in
 * tickets 49-53 therefore joins the checked area the moment the entry imports
 * it, with no bookkeeping step that a refactor could forget.
 *
 * Boundary: lives in src/mastra/* and MUST NOT import src/api/*,
 * src/evaluation/* or src/index (T02 #5).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..")
const MASTRA_DIR = join(__dirname)
const ENTRY = "src/mastra/shared_answer_entry.ts"

/** Import specifiers that would reverse the dependency direction. */
const FORBIDDEN: Array<{ label: string; prefix: string }> = [
  { label: "the HTTP layer", prefix: "src/api/" },
  { label: "the evaluation module", prefix: "src/evaluation/" },
  { label: "the frontend", prefix: "src/frontend/" },
  { label: "the release layer", prefix: "src/release/" },
  { label: "the process entry", prefix: "src/index.ts" },
]

/** Relative `../answer/runtime` / `./chat_event_adapter` → repo-relative .ts */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null
  const base = resolve(dirname(join(REPO_ROOT, fromFile)), specifier)
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toPosix(relative(REPO_ROOT, candidate))
    }
  }
  return null
}

function toPosix(p: string): string {
  return p.split("\\").join("/")
}

function sourceOf(file: string): string {
  return readFileSync(join(REPO_ROOT, file), "utf8")
}

function importedBy(file: string): string[] {
  const source = sourceOf(file)
  const specifiers = [
    ...[...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ]
  const out: string[] = []
  for (const specifier of specifiers) {
    const resolved = resolveSpecifier(file, specifier)
    if (resolved !== null && !resolved.endsWith(".test.ts")) out.push(resolved)
  }
  return out
}

/** Every production module the shared Answer entry reaches, transitively. */
function compositionArea(): string[] {
  const seen = new Set<string>([ENTRY])
  const queue = [ENTRY]
  while (queue.length > 0) {
    for (const next of importedBy(queue.shift() as string)) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return [...seen].sort()
}

const AREA = compositionArea()

test("ARCH-01A #6: the composition area is derived from the entry and is non-trivial", () => {
  assert.ok(AREA.includes(ENTRY))
  // The entry composes retrieval, routing, memory, FAQ and the Mastra
  // adapter, so a closure this small means the walk broke, not that the
  // graph got tidier.
  assert.ok(
    AREA.length > 40,
    `expected the entry to reach the whole answer stack, got ${AREA.length} files`
  )
  for (const file of AREA) {
    assert.ok(existsSync(join(REPO_ROOT, file)), `${file} exists`)
  }
})

test("ARCH-01A #6: nothing in the composition area reaches up into API, evaluation, frontend, release or the process entry", () => {
  const violations: string[] = []
  for (const file of AREA) {
    for (const specifier of importedBy(file)) {
      const hit = FORBIDDEN.find((f) => specifier.startsWith(f.prefix))
      if (hit) violations.push(`${file} -> ${specifier} (${hit.label})`)
    }
    // A closure member must not itself be a forbidden module.
    const own = FORBIDDEN.find((f) => file.startsWith(f.prefix))
    if (own) violations.push(`${file} is inside ${own.label}`)
  }
  assert.deepEqual(violations, [], `upward dependency from the Answer composition area:\n${violations.join("\n")}`)
})

test("ARCH-01A #6: exactly one shared Answer entry implementation exists in src/mastra", () => {
  const definers = readdirSync(MASTRA_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) =>
      /export\s+(?:async\s+)?function\s+createSharedAnswerEntry\s*\(/.test(
        readFileSync(join(MASTRA_DIR, name), "utf8")
      )
    )
  assert.deepEqual(
    definers,
    ["shared_answer_entry.ts"],
    "a second Answer entry implementation would duplicate chat and evaluation composition"
  )
})

test("ARCH-01A #6: the entry does not re-export an internal composition stack to callers", () => {
  // The stacks are internal to src/mastra; leaking them through the entry
  // would hand HTTP and evaluation a second, undocumented way to compose an
  // Answer run.
  const source = sourceOf(ENTRY)
  assert.equal(
    /export\s*\*|export\s*\{[^}]*Stack/.test(source),
    false,
    "the shared entry must expose createSharedAnswerEntry, not its internals"
  )
})

test("ARCH-01A #6: the retrieval stack takes a narrow context, not the entry's options", () => {
  // Ticket 49 acceptance: the stack must not accept or retain the complete
  // SharedAnswerEntryOptions object. Anything that would let it reach request
  // concerns (observers, budgets, the runtime) is checked structurally here.
  // Comments are stripped first — the stack documents what it deliberately
  // does NOT own, and prose must not trip the check.
  const source = sourceOf("src/mastra/answer_retrieval_stack.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  assert.ok(existsSync(join(REPO_ROOT, "src/mastra/answer_retrieval_stack.ts")))
  for (const forbidden of [
    "SharedAnswerEntryOptions",
    "AnswerRuntime",
    "traceObserver",
    "observers",
    "budgetMs",
    "resourceBudget",
    "eventsSource",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `the retrieval stack must not know about ${forbidden}`
    )
  }
  // It is composed by the entry and by nothing else — a second caller would be
  // a second, undocumented retrieval seam.
  const stackCallers = AREA.filter(
    (file) =>
      file !== "src/mastra/answer_retrieval_stack.ts" &&
      /createAnswerRetrievalStack\(/.test(sourceOf(file))
  )
  assert.deepEqual(stackCallers, ["src/mastra/shared_answer_entry.ts"])
})

test("ARCH-01A #6: chat and isolated evaluation are the only production callers", () => {
  const callers: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        walk(path)
        continue
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
      const file = toPosix(relative(REPO_ROOT, path))
      if (/createSharedAnswerEntry\s*\(/.test(readFileSync(path, "utf8"))) callers.push(file)
    }
  }
  walk(join(REPO_ROOT, "src"))
  assert.deepEqual(
    callers.filter((f) => f !== ENTRY).sort(),
    ["src/evaluation/isolated_resources.ts", "src/index.ts"],
    "only chat and evaluation may compose an Answer entry"
  )

  const index = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8")
  assert.match(
    index,
    /mastraSource:\s*sharedAnswerEntry\.eventsSource/,
    "the HTTP transport consumes the entry's eventsSource and nothing else"
  )
})
