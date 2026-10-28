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
const sharedDialog = read("frontend/src/components/ui/Dialog.tsx")
const arcDialog = read("frontend/src/components/arc/dialog/dialog.tsx")

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

test("frontend is built with Vite + React + Tailwind v4", () => {
  for (const dep of ["react", "react-dom", "@assistant-ui/react", "lucide-react"]) {
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

test("edit and regenerate name the branch they replace, on the same run id", () => {
  // Ticket 21 (CONV-01B): the browser truncates locally AND tells the server
  // which run it replaces, so validated memory cannot keep the dropped branch.
  assert.match(api, /truncateFromRunId\?: string/, "the chat request carries the field")
  assert.match(store, /truncateFromRunId/, "the store forwards the replaced run id")
  assert.match(
    store,
    /private replacedRunId\(thread: Thread, messageId: string\): string \| undefined/,
    "the replaced branch is resolved from the local thread before truncation",
  )
  const calls = store.match(/this\.replacedRunId\(thread, /g) ?? []
  assert.equal(calls.length, 2, "only edit and regenerate name a replaced branch")
})

test("attachments are server-owned session resources, not prompt text", () => {
  const references = read("frontend/src/components/thread/References.tsx")
  const attachmentsApi = read("frontend/src/lib/api.ts")
  const constants = read("frontend/src/lib/constants.ts")
  // Ticket 22 (ATT-01): an attachment belongs to one conversation and is read,
  // removed and promoted through the server — its text is never pasted into the
  // prompt, so the run can retrieve and cite the file inside that conversation.
  // The composer's + adds one, and its picker offers exactly the importable
  // formats: one shared list, never a second whitelist.
  assert.match(app, /uploadSessionAttachment/, "the composer adds a session attachment")
  assert.match(thread, /accept=\{ATTACHMENT_ACCEPT\}/, "the file input filters by the shared list")
  assert.match(
    constants,
    /ATTACHMENT_ACCEPT = Array\.from\(IMPORT_FILE_EXTENSIONS\)/,
    "the attachment filter derives from the import formats",
  )
  assert.match(app, /removeSessionAttachment/, "removal is a server action")
  assert.match(app, /promoteSessionAttachment/, "promotion is an explicit action")
  assert.equal(/\[附件：/.test(app), false, "file text is no longer pasted into the prompt")
  assert.match(attachmentsApi, /chat\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/attachments/)
  assert.match(references, /origin === "attachment"/, "temporary citations are recognised")
  assert.match(references, /临时/, "and labelled temporary")
  assert.equal(
    /attachment[\s\S]{0,120}查看来源/.test(references),
    false,
    "a temporary attachment is never offered as an openable knowledge source",
  )
})

test("React components do not own chat state (no direct Conversation access)", () => {
  for (const file of [
    "frontend/src/components/thread/Thread.tsx",
    "frontend/src/components/Sidebar.tsx",
    "frontend/src/components/AppShell.tsx",
    "frontend/src/components/panels/TracePanel.tsx",
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
  // Ticket 16: `/observability/ragas` is gone on purpose.
  for (const endpoint of [
    "/chat",
    "/chat/runs/",
    "/status",
    "/ingest/file",
    "/ingest/url",
  ]) {
    assert.ok(api.includes(endpoint), `lib/api.ts must still call ${endpoint}`)
  }
  assert.match(api, /sessionId/, "chat requests keep the session binding")
  assert.match(api, /runId/, "chat requests keep the run binding")
})

test("the old RAGAS read entry is gone from the frontend too", () => {
  // Ticket 16: no client, no metric labels, no styles and no hidden file read.
  const files = [
    "frontend/src/App.tsx",
    "frontend/src/lib/api.ts",
    "frontend/src/lib/constants.ts",
    "frontend/src/components/panels/TracePanel.tsx",
    "frontend/src/styles/index.css",
  ]
  for (const file of files) {
    const source = read(file)
    for (const gone of [
      "observability/ragas",
      "fetchRagas",
      "RAGAS_METRICS",
      "RagasPayload",
      "ragas-bar",
    ]) {
      assert.equal(source.includes(gone), false, `${file} must not keep ${gone}`)
    }
  }
  assert.equal(
    read("frontend/src/components/panels/TracePanel.tsx").includes("质量评估"),
    false,
    "the RAGAS tab is removed, not hidden behind a flag"
  )
})

test("the answer-path view keeps a single surface", () => {
  // The answer path has exactly one surface: the 执行链路 panel. The old
  // InsightDialog duplicate was retired once both rendered the same TraceSteps.
  const panel = read("frontend/src/components/panels/TracePanel.tsx")
  assert.match(panel, /<TraceSteps\b/, "the answer-path view still renders the trace steps")
  assert.match(panel, /aria-label="回答来源与执行链路"/, "the trace panel keeps its accessible name")
  assert.equal(
    existsSync(join(root, "frontend/src/components/panels/InsightDialog.tsx")),
    false,
    "the duplicate answer-path dialog stays deleted"
  )
})

test("an answer carries a feedback submission and reviewers can filter the store", () => {
  const thread = read("frontend/src/components/thread/Thread.tsx")
  const feedbackDialog = read("frontend/src/components/panels/FeedbackDialog.tsx")
  const sidebar = read("frontend/src/components/Sidebar.tsx")

  // Submission: the answered message id travels with its run, and a negative
  // rating picks one of the supported reason codes.
  assert.match(thread, /submitAnswerFeedback\(runId, \{/, "the rating is submitted for the message's run")
  assert.match(thread, /messageId,/, "the answered message id is part of the submission")
  assert.match(thread, /const runId = custom\?\.runId/, "only an answered run can be rated")
  assert.match(thread, /FEEDBACK_REASON_CODES\.map/, "the reason codes come from the shared list")
  assert.match(thread, /aria-label="反馈原因"/, "the reason picker is announced")

  // Review: status + provenance filters and state transitions.
  assert.match(feedbackDialog, /fetchFeedbackList\(/, "the reviewer list is read from the API")
  assert.match(feedbackDialog, /updateFeedbackStatus\(/, "state changes go through the API")
  assert.match(feedbackDialog, /runFilter/, "the run (provenance) is filterable")
  assert.match(feedbackDialog, /STATUS_LABELS/, "the supported statuses are labelled")
  assert.match(feedbackDialog, /record\.messageId/, "the detail shows the message/run provenance")
  assert.match(feedbackDialog, /<Dialog\b/, "the panel uses the shared narrow-screen dialog")
  assert.match(sidebar, /反馈审阅/, "the review surface has a first-class entry")
  assert.match(read("frontend/src/App.tsx"), /<FeedbackDialog\b/, "the app mounts the review panel")
})

// ---------------------------------------------------------------------------
// Product surface kept across the migration
// ---------------------------------------------------------------------------

test("shadcn composer and evidence surface preserve product capabilities", () => {
  const references = read("frontend/src/components/thread/References.tsx")
  const memoryDialog = read("frontend/src/components/panels/MemoryDialog.tsx")
  assert.match(thread, /--thread-max-width/, "thread keeps a bounded reading column")
  // The brand name is not the invariant — the placeholder sentence is — so the
  // product name is matched loosely and a rename cannot redden this.
  assert.match(thread, /询问 Nexus\w+/, "composer placeholder is preserved")
  // Ticket 33 (MEM-01B): memory is recalled SERVER-side (owner-scoped,
  // traceable, disableable) — the client no longer pastes it into prompts.
  assert.doesNotMatch(app, /getMemoriesPromptContext/, "memory is not injected into prompts client-side")
  assert.match(memoryDialog, /记忆/, "memory management surface is preserved")
  assert.match(memoryDialog, /建议/, "the suggestion review surface lives in the memory dialog")
  assert.match(thread, /参考来源/, "the answer still offers its sources")
  assert.match(references, /data-reference-item/, "each source remains addressable by citation id")
})
