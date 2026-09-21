/**
 * Contract — the React frontend stays a thin adapter over Conversation.
 *
 * The UI was migrated from a hand-rolled vanilla DOM layer to React +
 * @assistant-ui/react. These tests pin the architectural invariant that did
 * NOT change across the migration:
 *
 *   - `src/frontend/conversation.ts` still owns thread state, run projection
 *     and persistence (exercised directly by conversation.test.ts).
 *   - `frontend/src/conversation/store.ts` is only a subscription + transport
 *     bridge: it forwards every state mutation to Conversation and owns the
 *     fetch/SSE lifecycle. It never reimplements merge/project logic and never
 *     holds thread state of its own.
 *   - React components never touch Conversation directly — they go through the
 *     store — and the HTTP/SSE surface the backend serves is unchanged.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const here = __dirname
const root = join(here, "..", "..")

const read = (path: string) => readFileSync(join(root, path), "utf8")

const packageJson = JSON.parse(read("package.json"))
const viteConfig = read("vite.config.ts")
const store = read("frontend/src/conversation/store.ts")
const api = read("frontend/src/lib/api.ts")
const runtimeProvider = read("frontend/src/runtime/ConversationRuntimeProvider.tsx")
const thread = read("frontend/src/components/thread/Thread.tsx")
const app = read("frontend/src/App.tsx")
const indexHtml = read("frontend/index.html")
const styles = read("frontend/src/styles/index.css")

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

test("frontend is built with Vite + React + Tailwind v4", () => {
  for (const dep of ["react", "react-dom", "@assistant-ui/react", "morphicons", "lucide"]) {
    assert.ok(packageJson.dependencies[dep], `package.json must depend on ${dep}`)
  }
  for (const dep of ["vite", "@vitejs/plugin-react", "@tailwindcss/vite"]) {
    assert.ok(packageJson.devDependencies[dep], `package.json must depend on ${dep}`)
  }
  assert.match(packageJson.scripts["build:web"], /vite build/, "build:web must run the Vite build")
  assert.match(packageJson.scripts["dev:web"], /\bvite\b/, "dev:web must start the Vite dev server")

  assert.match(viteConfig, /root:\s*"frontend"/, "vite root must be the frontend folder")
  assert.match(viteConfig, /react\(\)/, "vite config must register the React plugin")
  assert.match(viteConfig, /tailwindcss\(\)/, "vite config must register the Tailwind plugin")

  assert.match(styles, /@import\s+"tailwindcss"/, "Tailwind must be imported in the entry CSS")
  assert.match(indexHtml, /\/src\/main\.tsx/, "index.html must bootstrap the React entry")
  assert.ok(existsSync(join(root, "frontend", "src", "main.tsx")), "frontend/src/main.tsx must exist")
  assert.ok(existsSync(join(root, "tsconfig.web.json")), "tsconfig.web.json must exist")
})

// ---------------------------------------------------------------------------
// State ownership — the bridge delegates, never owns
// ---------------------------------------------------------------------------

test("store.ts is the only Conversation bridge and forwards every state mutation", () => {
  assert.match(store, /from "@core\/conversation"/, "store must import the Conversation core")

  for (const method of [
    "addUserMessage",
    "startAssistantRun",
    "processSseEvent",
    "applyRunHistory",
    "finalizeStreamRun",
    "finalizeAbortedRun",
    "finalizeConnectionError",
    "startRun",
    "completeRun",
    "isRunning",
    "createThread",
    "deleteThread",
    "setActiveThread",
    "truncateMessages",
    "renameThread",
  ]) {
    assert.ok(
      new RegExp(`conversation\\.${method}\\s*\\(`).test(store),
      `store must delegate ${method}() to Conversation`,
    )
  }

  // The bridge must not reimplement merge/projection — those live in Conversation.
  assert.equal(
    /\bmergeTraceEvent\s*\(/.test(store),
    false,
    "mergeTraceEvent( must not be reimplemented in the bridge",
  )
  assert.equal(
    /\bnormalizeTraceEvents\s*\(/.test(store),
    false,
    "normalizeTraceEvents( must not be reimplemented in the bridge",
  )
})

test("store.ts owns the fetch/SSE lifecycle, not the DOM", () => {
  assert.match(api, /response\.body\.getReader/, "transport must own ReadableStream reading")
  assert.match(store, /AbortController/, "store must own AbortController for run cancellation")
  assert.equal(
    /document\.(getElementById|querySelector|createElement)/.test(store),
    false,
    "the bridge must not touch the DOM",
  )
})

test("React components do not own chat state (no direct Conversation access)", () => {
  for (const file of [
    "frontend/src/components/thread/Thread.tsx",
    "frontend/src/components/Sidebar.tsx",
    "frontend/src/components/TopBar.tsx",
    "frontend/src/components/panels/TracePanel.tsx",
    "frontend/src/components/panels/InsightDialog.tsx",
  ]) {
    const source = read(file)
    assert.equal(
      /ConversationImpl|new LocalStorageConversationStorage|processSseEvent|mergeTraceEvent/.test(source),
      false,
      `${file} must not reach the Conversation core directly`,
    )
  }
})

// ---------------------------------------------------------------------------
// assistant-ui wiring
// ---------------------------------------------------------------------------

test("the assistant-ui runtime is an external store bridged to Conversation", () => {
  assert.match(runtimeProvider, /useExternalStoreRuntime/, "must use the external store runtime")
  for (const handler of ["onNew", "onEdit", "onReload", "onCancel", "convertMessage"]) {
    assert.ok(new RegExp(`\\b${handler}\\b`).test(runtimeProvider), `runtime must wire ${handler}`)
  }
  assert.match(runtimeProvider, /adapters:\s*\{\s*threadList/, "multi-thread must use the threadList adapter")
  // Edit/regenerate/cancel map onto the bridge, not onto raw state.
  assert.match(runtimeProvider, /conversationStore\.(sendPrompt|editMessage|regenerate|cancel)/)
})

// ---------------------------------------------------------------------------
// Backend HTTP/SSE surface is unchanged
// ---------------------------------------------------------------------------

test("frontend still speaks to the existing backend endpoints", () => {
  // Endpoints are built from a shared `API_BASE = "/api"` prefix, so each is
  // asserted as the path segment that literally appears in the source.
  for (const endpoint of [
    "/chat",
    "/chat/runs/",
    "/status",
    "/observability/ragas",
    "/ingest/file",
    "/ingest/url",
  ]) {
    assert.ok(api.includes(endpoint), `lib/api.ts must still call ${endpoint}`)
  }
  assert.match(api, /sessionId/, "chat requests keep the session binding")
  assert.match(api, /runId/, "chat requests keep the run binding")
})

test("the evaluation dialog submits a task and polls it through the API", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  for (const endpoint of ["/evaluation-datasets", "/evaluations"]) {
    assert.ok(api.includes(endpoint), `lib/api.ts must call ${endpoint}`)
  }
  assert.match(dialog, /createEvaluationTask\(/, "the page starts a task through the API")
  assert.match(dialog, /fetchEvaluationTask\(/, "the page polls task state through the API")
  assert.match(dialog, /EVALUATION_POLL_MS/, "polling uses the shared interval constant")
  assert.match(dialog, /TERMINAL_STAGES\.has\(detail\.stage\)/, "polling stops at a terminal stage")
  assert.match(app, /<EvaluationDialog\b/, "the dialog is mounted in the app")
})

test("the evaluation dialog accepts an uploaded dataset and shows field-level issues", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  assert.match(dialog, /type="file"/, "the page can pick a .json file")
  assert.match(dialog, /\{\s*dataset:/, "the upload path submits the inline dataset field")
  assert.match(dialog, /EvaluationRequestError/, "a rejected dataset is distinguished from other failures")
  assert.match(dialog, /error\.issues/, "the server's field/case-level issues are surfaced")
  assert.match(dialog, /uploadIssues\.map/, "the issues are rendered for the user")
  assert.ok(api.includes("EvaluationTaskInput"), "the client models both dataset sources explicitly")
})

// ---------------------------------------------------------------------------
// Product surface kept across the migration
// ---------------------------------------------------------------------------

test("mem0-style composer and suggestion surface are preserved", () => {
  const references = read("frontend/src/components/thread/References.tsx")
  const memoryDialog = read("frontend/src/components/panels/MemoryDialog.tsx")
  assert.match(thread, /--thread-max-width/, "thread keeps the 42rem mem0 column")
  assert.match(thread, /输入消息，向 NexusRAG 提问/, "composer placeholder is preserved")
  assert.match(app, /getMemoriesPromptContext/, "memory context is injected into prompts")
  assert.match(memoryDialog, /记忆/, "memory management surface is preserved")
  assert.match(references, /参考来源/, "references disclosure is preserved")
})
