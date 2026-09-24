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

test("ARCH-01B/C/D #5: each stack takes a narrow context, not the entry's options", () => {
  // Tickets 49/51 acceptance: a stack must not accept or retain the complete
  // SharedAnswerEntryOptions object. Anything that would let it reach request
  // concerns (observers, budgets, the runtime, the events source) is checked
  // structurally here. Comments are stripped first — a stack documents what it
  // deliberately does NOT own, and prose must not trip the check.
  const stacks: Array<{ file: string; factory: string }> = [
    { file: "src/mastra/answer_retrieval_stack.ts", factory: "createAnswerRetrievalStack" },
    { file: "src/mastra/answer_route_stack.ts", factory: "createAnswerRouteStack" },
  ]
  for (const { file, factory } of stacks) {
    assert.ok(existsSync(join(REPO_ROOT, file)), `${file} exists`)
    const source = sourceOf(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    for (const forbidden of [
      "SharedAnswerEntryOptions",
      "AnswerRuntime",
      "traceObserver",
      "observers",
      "budgetMs",
      "resourceBudget",
      "eventsSource",
      "langfuse",
      "modelProfile",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${factory}'s module must not know about ${forbidden}`
      )
    }
    // It is composed by the entry and by nothing else — a second caller would be
    // a second, undocumented composition seam.
    const callers = AREA.filter(
      (candidate) =>
        candidate !== file && new RegExp(`${factory}\\(`).test(sourceOf(candidate))
    )
    assert.deepEqual(callers, [ENTRY], `${factory} has exactly one caller`)
  }
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

/** Every non-test production source under src/, repo-relative. */
function productionSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        walk(path)
        continue
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
      out.push(toPosix(relative(REPO_ROOT, path)))
    }
  }
  walk(join(REPO_ROOT, "src"))
  return out.sort()
}

test("ARCH-01D #5: the route stack's only retrieval dependency is the searcher factory", () => {
  // The entry hands the route stack ONE function for retrieval, so a route can
  // never reach search operations, the reranker or an evidence channel — the
  // layering ticket 47 §Design fixes.
  const source = sourceOf("src/mastra/answer_route_stack.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  for (const forbidden of [
    "SearchOperations",
    "RuntimeSearchOperations",
    "createDedicatedReranker",
    "Reranker",
    "AttachmentSearchOperations",
    "WebEvidenceOperations",
    "createFaqEvidenceOperations",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `the route stack must not name ${forbidden}`
    )
  }
  assert.match(
    source,
    /createSearcher: \(\s*assistant\?: AssistantRunSnapshot\s*\) => SearcherImpl/
  )
})

test("ARCH-01D #6: the entry adapts the route stack's runner and nothing else", () => {
  const entry = sourceOf(ENTRY)
  assert.match(
    entry,
    /const \{ runner, mcpStatus, mcp \} = await createAnswerRouteStack\(\{/,
    "the entry consumes exactly what the route stack exports: its one runner and the MCP state"
  )
})

// ---------------------------------------------------------------------------
// Ticket 52 (ARCH-01E) — the tool and MCP layer moved behind the route stack.
// The behavior itself (schema validation, allowlist, deadline, cancellation,
// trace records) is the ticket-34/35 boundary and its own suites; what the
// split could break is WHERE the registry is composed and WHO can reach it, so
// that is what these pin.
// ---------------------------------------------------------------------------

/** Production source with comments stripped — prose must not trip a check. */
function codeOf(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

test("ARCH-01E #1/#2: the tool registry and MCP bridge are composed in exactly one production place", () => {
  const ROUTE_STACK = "src/mastra/answer_route_stack.ts"
  // `(?<!function )` keeps a definition from counting as a composition site.
  const callSites: Record<string, RegExp> = {
    "registerBuiltinTools": /(?<!function )registerBuiltinTools\(/,
    "createMcpToolBridge": /(?<!function )createMcpToolBridge\(/,
    "new ToolInvocationService": /new ToolInvocationService\(/,
  }
  const composed: Record<string, string[]> = {}
  for (const api of Object.keys(callSites)) composed[api] = []
  for (const file of productionSources()) {
    const code = codeOf(file)
    for (const [api, site] of Object.entries(callSites)) {
      if (site.test(code)) composed[api].push(file)
    }
  }
  assert.deepEqual(composed["registerBuiltinTools"], [ROUTE_STACK])
  assert.deepEqual(composed["createMcpToolBridge"], [ROUTE_STACK])
  // The only two invocation services are the route stack's published seam and
  // the complex loop's own invoker — ONE boundary, two entrances to it.
  assert.deepEqual(composed["new ToolInvocationService"].sort(), [
    "src/mastra/answer_route_stack.ts",
    "src/tools/complex_loop_adapter.ts",
  ])
})

test("ARCH-01E #6: the shared entry no longer touches the tool layer at all", () => {
  // Every tool capability the entry publishes can only come from the route
  // stack — the entry has no handle on the registry, the bridge or the
  // repositories the built-in tools read.
  const entry = codeOf(ENTRY)
  for (const forbidden of [
    "ToolRegistry",
    "ToolInvocationService",
    "registerBuiltinTools",
    "createMcpToolBridge",
    "McpToolBridge",
    "DocumentRepo",
    "PageIndexRepository",
    "singleTenantAccessContext",
  ]) {
    assert.equal(
      entry.includes(forbidden),
      false,
      `the entry must not name ${forbidden}`
    )
  }
  // The published seam and the stamped state are forwarded unchanged.
  assert.match(entry, /\.\.\.\(mcpStatus \? \{ mcp: mcpStatus\(\) \} : \{\}\)/)
  assert.match(entry, /\.\.\.\(mcp \? \{ mcp \} : \{\}\)/)
})

test("ARCH-01E #4: the route stack reads only the db handle its caller owns", () => {
  // Isolated evaluation composes its own process runtime; the tool layer must
  // therefore see the caller's store and never reach a business one. A second
  // db handle inside the route stack would be that escape.
  const route = codeOf("src/mastra/answer_route_stack.ts")
  assert.equal(route.includes("openDb("), false, "the route stack opens no database")
  assert.equal(
    /from "\.\.\/runtime\/process_runtime"/.test(route),
    false,
    "the route stack imports no process runtime"
  )
  assert.equal(
    /from "\.\.\/config"/.test(route) && /loadConfig\(/.test(route),
    false,
    "the route stack reads no environment configuration"
  )
  assert.match(route, /db: DB/, "the caller hands the route stack its own handle")
  // The built-in document tools read through THAT handle and nothing else.
  assert.match(route, /documentRepo: new DocumentRepo\(db\)/)
  assert.match(route, /pageIndexRepo: new PageIndexRepository\(db\)/)
})

test("ARCH-01E #1/#2: the complex route keeps the registry and the discovered MCP tools", () => {
  const route = codeOf("src/mastra/answer_route_stack.ts")
  assert.match(
    route,
    /createComplexKnowledgeMastraRunner\(\{[\s\S]*?toolRegistry,\s*[\s\S]*?mcpToolNames: mcpBridge\.toolNames\(\)/,
    "the loop still runs tools through the route stack's registry and allowlist"
  )
})

test("ARCH-01E #3/#6: discovery stays visible, callable only for discovered tools", () => {
  const route = codeOf("src/mastra/answer_route_stack.ts")
  // A failed discovery is caught, warned and leaves no bridge: never a broken
  // run, never a silent one.
  assert.match(route, /createMcpToolBridge\(\{[\s\S]*?\}\)\.catch\(\(error: unknown\) => \{/)
  assert.match(route, /\[mcp\] capability bridge failed to compose/)
  // The established degradation state is the asymmetry: the STAMP rides every
  // terminal whenever a bridge exists — including a connected bridge that
  // discovered nothing — while the callable seam needs a discovered tool.
  assert.match(route, /\.\.\.\(mcpBridge \? \{ mcpStatus: \(\) => mcpBridge\.status\(\) \} : \{\}\)/)
  assert.match(
    route,
    /\.\.\.\(mcpBridge && mcpCapabilityInvoker\s*\?\s*\{/,
    "the invocation seam appears only with a bridge that discovered tools"
  )
  // The seam's allowlist is the discovered MCP names — a capability caller gets
  // no business tool through it.
  assert.match(
    route,
    /new ToolInvocationService\(\{\s*registry: toolRegistry,\s*allowedTools: mcpBridge\.toolNames\(\),\s*\}\)/
  )
})

test("ARCH-01C #6: the entry forwards every retrieval seam into the stack", () => {
  // Dropping a seam here would silently narrow what an evaluation scope, a
  // probe or a deployment without a reranker can inject — the chat happy path
  // would stay green. Ticket 50 acceptance: the optional-channel behavior is
  // exposed ONLY through the existing shared-entry seams.
  const entry = sourceOf(ENTRY)
  const call = /createAnswerRetrievalStack\(\{([\s\S]*?)\n\s*\}\)/.exec(entry)
  assert.ok(call, "the entry composes the retrieval stack inline")
  const body = call[1]
  for (const resolved of ["config", "db", "elasticsearch", "embeddingClient"]) {
    assert.match(
      body,
      new RegExp(`(^|[\\s,{])${resolved}\\s*[,:]`, "m"),
      `the stack receives the resolved ${resolved}`
    )
  }
  for (const seam of ["searchOperations", "reranker", "attachments", "faq", "web"]) {
    assert.match(
      body,
      new RegExp(`\\.\\.\\..*options\\.${seam}\\b[\\s\\S]*\\{\\s*${seam}:\\s*options\\.${seam}\\s*\\}`),
      `${seam} is forwarded when and only when the caller injected it`
    )
  }
})

test("ARCH-01C #6: production search operations are composed in exactly one place", () => {
  const composers = productionSources().filter((file) =>
    /new RuntimeSearchOperations\(/.test(sourceOf(file))
  )
  assert.deepEqual(
    composers,
    ["src/evaluation/isolated_resources.ts", "src/mastra/answer_retrieval_stack.ts"],
    "only the retrieval stack composes operations; an isolated evaluation scope builds its own and injects it through the entry seam"
  )
  assert.ok(
    !AREA.some(
      (file) =>
        file !== "src/mastra/answer_retrieval_stack.ts" &&
        /new RuntimeSearchOperations\(/.test(sourceOf(file))
    ),
    "no second retrieval configuration may live inside the Answer composition area"
  )
})

test("ARCH-01C #2: retrieval-debug shares chat's operations and deliberately carries no optional channel", () => {
  assert.match(
    sourceOf("src/index.ts"),
    /searchOperations:\s*sharedAnswerEntry\.searchOperations/,
    "the debug route is handed the SAME operations object the shared entry publishes"
  )
  const debug = sourceOf("src/api/retrieval_debug.ts")
  assert.match(
    debug,
    /new SearcherImpl\(searchOperations\)/,
    "the debug searcher is built from the operations alone"
  )
  // Pinned divergence, not a bug to fix: unifying it would change what
  // /api/retrieval-debug returns, which ticket 47 puts out of scope. That the
  // channels DO reach chat's searcher is proven in answer_retrieval_stack.test.ts.
  assert.equal(
    /AttachmentSearchOperations|faqEvidence|WebEvidence|attachments/.test(debug),
    false,
    "the debug run has no attachment, FAQ or Web evidence channel"
  )
})
