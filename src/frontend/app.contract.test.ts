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
  // Ticket 22 (ATT-01): the browser uploads to the conversation's attachment
  // endpoint instead of pasting file text into the prompt, so the run can
  // retrieve and cite the file — and only inside that conversation.
  assert.match(app, /uploadSessionAttachment/, "the composer uploads attachments to the session")
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
  // Ticket 16: `/observability/ragas` is gone on purpose — the evaluation
  // surface is `/evaluations` (asserted in the dialog test below).
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

test("the evaluation dialog shows all six retrieval metrics and the ranking's score source", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  for (const key of ["precision", "recall", "ndcg@3", "ndcg@10", "mrr", "map"]) {
    assert.ok(dialog.includes(`["${key}", `), `the metric grid must render ${key}`)
  }
  assert.match(dialog, /OrderingNote/, "the score source of the scored ranking is displayed")
  assert.match(dialog, /原始顺序（未重排）/, "an unscored order is never labelled as a dedicated rerank")
  assert.match(dialog, /summary\?\.sampleSize/, "every average shows its effective sample size")
  assert.match(dialog, /task\.metrics\.version/, "the metric version stamp is displayed")
})

test("the evaluation dialog offers only allowed model ids and shows the redacted snapshot", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  assert.match(dialog, /allowedModels\.chat\.map/, "only allowed chat models are offered")
  assert.match(dialog, /allowedModels\.rerank\.map/, "only allowed rerank models are offered")
  assert.match(
    dialog,
    /chatModel: chatModel\.trim\(\)/,
    "the page sends a model id and nothing else"
  )
  assert.match(dialog, /不能填写 Base URL 或密钥/, "the copy states the constraint")
  assert.match(dialog, /task\.config\.chatModel/, "the model this run really used is displayed")
  assert.match(dialog, /task\.config\.rerankSource/, "the run's score source is displayed")
  assert.ok(api.includes("allowedModels"), "the client reads the server allowlist")
})

test("the old RAGAS read entry is gone from the frontend too", () => {
  // Ticket 16: no client, no metric labels, no styles and no hidden file read.
  // (The evaluation dialog's copy still contrasts its scores with the old
  // semantic metrics — that mention goes away with the engine in ticket 17.)
  const files = [
    "frontend/src/App.tsx",
    "frontend/src/lib/api.ts",
    "frontend/src/lib/constants.ts",
    "frontend/src/components/panels/InsightDialog.tsx",
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
    read("frontend/src/components/panels/InsightDialog.tsx").includes("质量评估"),
    false,
    "the RAGAS tab is removed, not hidden behind a flag"
  )
})

test("the evaluation entry and the answer-path view both survive the switch", () => {
  const sidebar = read("frontend/src/components/Sidebar.tsx")
  const insight = read("frontend/src/components/panels/InsightDialog.tsx")
  assert.ok(sidebar.includes("运行评测"), "evaluation is a first-class sidebar entry")
  assert.match(insight, /<TraceSteps\b/, "the answer-path view still renders the trace steps")
  assert.match(insight, /aria-label="回答路径"/, "the trace panel keeps its accessible name")
  assert.match(app, /<EvaluationDialog\b/, "the app mounts the evaluation dialog")
})

test("the evaluation dialog covers every state and stays usable on small screens", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  // Every stage a user can meet has a label — including `cleaning`, which the
  // cleanup work made observable, and both partial-outcome stages.
  for (const stage of [
    "queued",
    "preparing",
    "running",
    "cleaning",
    "completed",
    "completed_with_errors",
    "failed",
  ]) {
    assert.match(dialog, new RegExp(`\\b${stage}:`), `${stage} has a label`)
  }
  assert.match(dialog, /重启后不可查询/, "the restart-empty state is explained")
  assert.match(dialog, /aria-label="评测进度"/, "progress is announced")
  assert.match(dialog, /aria-label="关闭评测"/, "the close control has an accessible name")
  assert.ok(dialog.includes("max-md:"), "the dialog reflows on narrow screens")
  assert.match(
    dialog,
    /<dialog\b/,
    "it is a native dialog: Escape, focus and modality come from the platform"
  )
})

test("the evaluation dialog separates cleanup failures from the run outcome", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  assert.match(
    dialog,
    /未完成（可能仍有残留）/,
    "an incomplete cleanup is never shown as a clean success"
  )
  assert.match(
    dialog,
    /无残留（未创建专用资源）/,
    "a scope that never created resources is not dressed up as a failure"
  )
  assert.match(
    dialog,
    /npm run eval:residue -- --delete/,
    "the page points at the scoped residue tool"
  )
  assert.match(dialog, /cleanup\.dbClosed/, "the page reports the local temp db state")
  assert.match(
    dialog,
    /运行失败与清理失败分开记录/,
    "the copy states that the two failures stay independent"
  )
})

test("the evaluation dialog lists this process's records and never shows a stale one", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  assert.match(dialog, /listEvaluationTasks\(/, "the retained records are read from the API")
  assert.match(dialog, /history\.map/, "the records are listed so a user can switch")
  assert.match(dialog, /selectTask\(item\.id\)/, "clicking a record switches the panel to it")
  assert.match(
    dialog,
    /pollTokenRef\.current !== token/,
    "a poll that lost the race cannot write another task's result into the panel"
  )
  assert.match(dialog, /本进程暂无评测记录/, "the empty state is distinguishable from loading")
  assert.match(
    dialog,
    /仅保存在当前服务进程内/,
    "the retention copy states the records live only in this process"
  )
})

test("the evaluation dialog lets a case be expanded into the ranking that was scored", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  assert.match(dialog, /item\.candidates\.map/, "the ordered candidates are listed per case")
  assert.match(dialog, /candidate\.rank/, "each candidate shows its rank")
  assert.match(dialog, /candidate\.score\.toFixed\(3\)/, "each candidate shows its score")
  assert.match(dialog, /candidate\.channels\.join/, "each candidate shows where it came from")
  assert.match(dialog, /（未映射）/, "a candidate outside the corpus is marked, not hidden")
  assert.match(
    dialog,
    /评分输入来自第 \{item\.finalContextRound\} 轮生成上下文/,
    "the round behind the scored context is shown"
  )
})

test("the evaluation dialog reports how the batch ended and keeps every case reason visible", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  assert.match(
    dialog,
    /成功 \{task\.counts\.answered\} · 失败 \{task\.counts\.failed\} · 降级/,
    "answered/failed/degraded counts are shown next to the progress"
  )
  assert.match(
    dialog,
    /已回答（\$\{item\.terminalStatus\}）/,
    "a refusal or handoff keeps its real terminal status instead of looking like a failure"
  )
  assert.match(dialog, /item\.error/, "each failed case shows its own reason")
  assert.match(dialog, /formatScore\(item\.metrics\[key\] \?\? null\)/, "a missing metric renders as 不适用")
})

test("the evaluation dialog presents BLEU and ROUGE as text similarity with their fixed text rules", () => {
  const dialog = read("frontend/src/components/panels/EvaluationDialog.tsx")
  const similarityKeys = ["bleu-1", "bleu-2", "bleu-4", "rouge-1", "rouge-2", "rouge-l"]
  for (const key of similarityKeys) {
    assert.ok(dialog.includes(`["${key}", `), `the metric grid must render ${key}`)
  }
  assert.match(dialog, /文本相似度/, "BLEU/ROUGE are described as text similarity")
  assert.match(dialog, /不是正确率或忠实性/, "the copy must not imply accuracy or faithfulness")
  assert.match(dialog, /textRuleVersion/, "the fixed text rules are version-stamped on screen")
  assert.match(dialog, /rougeVersion/, "the ROUGE version is shown alongside BLEU's")
  assert.match(dialog, /取自本次实际回复/, "the copy states the score comes from the actual reply")
  assert.match(dialog, /已完成 \{task\.progress\.finished\}\/\{task\.progress\.total\}/, "batch progress is visible")
  assert.equal(
    /只运行一题|多题批量见后续票/.test(dialog),
    false,
    "the single-case limitation copy is gone now that batches run"
  )
  assert.equal(
    /ragas/i.test(dialog),
    false,
    "the evaluation surface must not read, display or mention RAGAS data"
  )
  // Twelve metrics in one surface: six retrieval + six similarity.
  const metricKeys = /\["(?:precision|recall|ndcg@3|ndcg@10|mrr|map|bleu-[124]|rouge-[12l])", "/g
  assert.equal((dialog.match(metricKeys) ?? []).length, 12, "the metric grid lists all twelve metrics")
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
