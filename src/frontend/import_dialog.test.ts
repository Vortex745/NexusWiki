import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import type { DocumentStatus, IngestionTask, ProcessingSpan } from "../types/ingestion"

type IngestSpanNode = {
  span: Pick<ProcessingSpan, "id" | "name" | "kind" | "status" | "errorMessage" | "durationMs" | "output">
  children: IngestSpanNode[]
}
type IngestStatus = {
  documentStatus: DocumentStatus | null
  lifecycleOutcome: string | null
  task: Pick<IngestionTask, "status" | "failCount" | "nextAttemptAt"> | null
  spanTree: IngestSpanNode[]
  activationBlockReason?: string | null
  candidateState?: string | null
  documentVersion?: { version: number; contentHash: string; active: boolean }
  failure?: {
    category: string
    reasonCode: string
    retryable: boolean
    allowedOperations: string[]
    message: string
    failedAt: string
  } | null
}

function loadFrontendModule(path: string): any {
  const source = readFileSync(join(__dirname, "../..", path), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  runInNewContext(compiled, { exports })
  return exports
}

const { deriveIngestProgress, initialImportProgress, buildImportSteps, estimateUploadRemainingMs, estimateImportRemainingMs, describeActivationReasons, describeAllowedOperations } = loadFrontendModule("frontend/src/lib/ingestProgress.ts")
const constants = loadFrontendModule("frontend/src/lib/constants.ts")

/** The REAL decision-layer module — hand-mocking it drifted (a missing export
 * silently broke the settled check), so the harness loads it with a require
 * shim and tests run against production logic. */
const importBatch = (() => {
  const source = readFileSync(join(__dirname, "../../frontend/src/lib/importBatch.ts"), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports: any = {}
  runInNewContext(compiled, {
    exports,
    require: (name: string) => name === "./constants" ? constants : assert.fail(`unexpected ${name}`),
  })
  return exports
})()

test("upload ETA uses observed bytes and disappears when the transfer stalls or finishes", () => {
  const upload = { loaded: 250_000, total: 1_000_000, startedAt: 1_000, updatedAt: 2_000 }
  assert.equal(estimateUploadRemainingMs(upload, 2_000), 3_000)
  assert.equal(estimateUploadRemainingMs({ ...upload, updatedAt: 1_500 }, 1_500), null)
  assert.equal(estimateUploadRemainingMs(upload, 7_001), null)
  assert.equal(estimateUploadRemainingMs({ ...upload, loaded: upload.total }, 2_000), null)
  assert.equal(estimateUploadRemainingMs({ ...upload, total: 0 }, 2_000), null)
})

test("import ETA remains available during server processing and stops after completion", () => {
  const processing = deriveIngestProgress(payload([stage("chunk", "done"), stage("wikify", "running")]))
  assert.ok(estimateImportRemainingMs(processing, 1_000, 2_000, 100_000) > 0)
  const complete = payload()
  complete.task!.status = "completed"
  complete.documentStatus = "completed"
  assert.equal(estimateImportRemainingMs(deriveIngestProgress(complete), 1_000, 2_000, 100_000), null)
})

test("import steps distinguish upload, processing, retry and URL imports", () => {
  const uploading = buildImportSteps(initialImportProgress("uploading"), true, false)
  assert.deepEqual(Array.from(uploading, (step: { label: string }) => step.label), ["上传", "解析", "关联", "向量", "图谱"])
  assert.equal(uploading[0].status, "running")
  const processing = buildImportSteps(deriveIngestProgress(payload([
    stage("chunk", "done"), stage("wikify", "running"),
  ])), true, true)
  assert.deepEqual(Array.from(processing, (step: { status: string }) => step.status), ["done", "done", "running", "pending", "pending"])
  const retry = payload([stage("chunk", "failed")])
  retry.task!.status = "pending"
  assert.equal(buildImportSteps(deriveIngestProgress(retry), true, true)[1].status, "failed")
  const rejected = buildImportSteps(initialImportProgress("failed"), true, false)
  assert.equal(rejected[0].status, "failed")
  assert.equal(buildImportSteps(initialImportProgress("pending"), false, false).length, 4)
})

test("file upload reports transfer bytes and keeps authentication and server errors", async () => {
  class FakeXHR {
    static current: FakeXHR
    upload: { onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void } = {}
    headers: Record<string, string> = {}
    status = 0
    responseText = ""
    onload?: () => void
    onerror?: () => void
    onabort?: () => void
    ontimeout?: () => void
    timeout = 0
    body: unknown
    url = ""
    constructor() { FakeXHR.current = this }
    open(_method: string, url: string) { this.url = url }
    setRequestHeader(name: string, value: string) { this.headers[name] = value }
    send(body: unknown) { this.body = body }
    respond(status: number, body: string) { this.status = status; this.responseText = body; this.onload?.() }
  }
  const source = readFileSync(join(__dirname, "../../frontend/src/lib/api.ts"), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports: any = {}
  runInNewContext(compiled, {
    exports, XMLHttpRequest: FakeXHR, Response, DOMException,
    // UT-23: api.ts now imports the real decision layer for isPdfLike.
    require: (name: string) =>
      name === "./constants"
        ? { MIME_BY_EXTENSION: {} }
        : name === "./importBatch"
          ? importBatch
          : assert.fail(`unexpected ${name}`),
  })
  exports.setAccessToken("session-token")
  let unauthorized = 0
  exports.setUnauthorizedHandler(() => { unauthorized++ })
  const file = { name: "测试.pdf", type: "application/pdf", size: 1000 }
  const updates: Array<[number, number]> = []
  const upload = exports.uploadFileToIngest(file, "folder/测试.pdf", (loaded: number, total: number) => updates.push([loaded, total]), { knowledgeBaseId: "kb-1" })
  const request = FakeXHR.current
  assert.equal(request.url, "/api/ingest/file")
  assert.equal(request.headers.Authorization, "Bearer session-token")
  assert.equal(request.headers["x-file-name"], encodeURIComponent(file.name))
  assert.equal(request.headers["x-knowledge-base-id"], "kb-1")
  assert.ok(request.timeout > 0)
  assert.equal(request.body, file)
  request.upload.onprogress?.({ loaded: 400, total: 1000, lengthComputable: true })
  request.respond(200, JSON.stringify({ docId: "doc-1" }))
  assert.equal(await upload, "doc-1")
  assert.deepEqual(updates, [[400, 1000]])

  const rejected = exports.uploadFileToIngest(file, file.name)
  FakeXHR.current.respond(401, JSON.stringify({ error: "session expired" }))
  await assert.rejects(rejected, /HTTP 401: session expired/)
  assert.equal(unauthorized, 1)

  const timedOut = exports.uploadFileToIngest(file, file.name, undefined, "kb-1")
  FakeXHR.current.ontimeout?.()
  await assert.rejects(timedOut, /超时/)
})

test("knowledge-base creation reads the API envelope", async () => {
  const source = readFileSync(join(__dirname, "../../frontend/src/lib/api.ts"), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports: any = {}
  runInNewContext(compiled, {
    exports, Headers, AbortSignal,
    fetch: async () => new Response(JSON.stringify({ knowledgeBase: { id: "kb-new", name: "新库" } }), { status: 201 }),
    Response,
    require: (name: string) =>
      name === "./constants"
        ? { MIME_BY_EXTENSION: {} }
        : name === "./importBatch"
          ? importBatch
          : assert.fail(`unexpected ${name}`),
  })
  assert.equal((await exports.createKnowledgeBase("新库")).id, "kb-new")
})

test("knowledge import offers both document files and a folder", () => {
  const path = join(__dirname, "../../frontend/src/components/panels/ImportDropzone.tsx")
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fileInputs: ts.JsxSelfClosingElement[] = []

  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "input") {
      const type = node.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(source) === "type",
      )
      if (type?.initializer && ts.isStringLiteral(type.initializer) && type.initializer.text === "file") {
        fileInputs.push(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  assert.equal(fileInputs.length, 2, "show a file picker as well as the existing folder picker")
  const folderInputs = fileInputs.filter((input) =>
    input.attributes.properties.some(
      (property) => ts.isJsxAttribute(property) && property.name.getText(source) === "webkitdirectory",
    ),
  )
  assert.equal(folderInputs.length, 1, "only the folder picker should use directory mode")
  for (const input of fileInputs) {
    const attributes = input.attributes.properties
      .filter((property): property is ts.JsxAttribute => ts.isJsxAttribute(property))
      .map((property) => property.name.getText(source))
    assert.ok(attributes.includes("multiple"), "both pickers should support batch import")
    assert.ok(attributes.includes("accept"), "both pickers should declare supported document types")
  }
})

function stage(name: string, status: IngestSpanNode["span"]["status"], id = 1): IngestSpanNode {
  return {
    span: { id, name, kind: "stage", status, errorMessage: null, durationMs: null, output: null }, children: [],
  }
}

function payload(children: IngestSpanNode[] = []): IngestStatus {
  return {
    documentStatus: "pending", lifecycleOutcome: "pending",
    task: { status: "running", failCount: 0, nextAttemptAt: null },
    spanTree: [{ ...stage("ingest", "running", 1), children }],
  }
}

test("processing progress follows actual stage completion and exposes parser details", () => {
  const chunk = stage("chunk", "done")
  chunk.span.output = { chunkCount: 42, parser: "builtin-pdf" }
  chunk.span.durationMs = 1200
  const storeChunks = stage("storeChunks", "running")
  storeChunks.span.output = {
    embeddingBatchCount: 4,
    embeddingRequestCount: 4,
    embeddingRateLimitCount: 1,
    rateLimitWaitMs: 2500,
    bulkRequestCount: 4,
    embeddingDurationMs: 2200,
    bulkDurationMs: 1100,
  }
  const progress = deriveIngestProgress(payload([chunk, stage("wikify", "done"), storeChunks]))
  assert.equal(progress.status, "processing")
  assert.equal(progress.percent, 50)
  assert.equal(progress.summary, "正在向量与索引写入")
  assert.equal(progress.chunkCount, 42)
  assert.equal(progress.parser, "builtin-pdf")
  assert.equal(progress.stages[0].durationMs, 1200)
  assert.equal(progress.embeddingRateLimitCount, 1)
  assert.equal(progress.rateLimitWaitMs, 2500)
})

test("only terminal completion reaches 100 percent", () => {
  const input = payload(["chunk", "wikify", "storeChunks", "storeGraph"].map((name) => stage(name, "done")))
  assert.equal(deriveIngestProgress(input).percent, 95)
  input.task!.status = "completed"
  input.documentStatus = "completed"
  assert.equal(deriveIngestProgress(input).percent, 100)
  assert.equal(deriveIngestProgress(input).status, "completed")
})

test("skipped downstream stages do not count as completed on failure", () => {
  const failed = stage("storeChunks", "failed")
  failed.span.errorMessage = "embedding unavailable"
  const input = payload([stage("chunk", "done"), stage("wikify", "done"), failed, stage("storeGraph", "skipped")])
  input.task!.status = "failed"
  input.documentStatus = "failed"
  const progress = deriveIngestProgress(input)
  assert.equal(progress.status, "failed")
  assert.equal(progress.percent, 50)
  assert.equal(progress.error, "embedding unavailable")
  assert.equal(progress.stages[3].status, "skipped")
})

test("automatic retry stays pending and retains the failed attempt detail", () => {
  const input = payload([stage("chunk", "failed")])
  input.spanTree[0].span.status = "failed"
  input.spanTree[0].span.errorMessage = "parser timeout"
  input.task = { status: "pending", failCount: 1, nextAttemptAt: "2026-09-27T04:00:00Z" }
  const progress = deriveIngestProgress(input)
  assert.equal(progress.status, "pending")
  assert.equal(progress.summary, "等待自动重试")
  assert.equal(progress.percent, 0)
  assert.equal(progress.error, "parser timeout")
  assert.equal(progress.retryCount, 1)
})

test("latest ingestion attempt is selected by root id, independent of tree order", () => {
  const input = payload([stage("chunk", "done"), stage("wikify", "done")])
  const latest = { ...stage("ingest", "running", 10), children: [stage("chunk", "running")] }
  input.spanTree.unshift(latest)
  const progress = deriveIngestProgress(input)
  assert.equal(progress.percent, 0)
  assert.equal(progress.summary, "正在解析与切分")
})

test("pending reprocessing takes precedence over a previous completed document", () => {
  const input = payload(["chunk", "wikify", "storeChunks", "storeGraph"].map((name) => stage(name, "done")))
  input.documentStatus = "completed"
  input.task!.status = "pending"
  input.spanTree[0].span.status = "done"
  assert.equal(deriveIngestProgress(input).status, "pending")
  assert.equal(deriveIngestProgress(input).percent, 0)
  assert.equal(deriveIngestProgress(input).stages.filter((stage: { status: string }) => stage.status === "done").length, 0)
})

test("queued, cancelled and unchanged imports have correct terminal states", () => {
  const input = payload()
  input.spanTree = []
  input.task!.status = "pending"
  assert.equal(deriveIngestProgress(input).summary, "等待处理")
  input.task!.status = "cancelled"
  assert.equal(deriveIngestProgress(input).status, "cancelled")
  input.task = null
  input.documentStatus = "completed"
  input.lifecycleOutcome = "unchanged"
  assert.equal(deriveIngestProgress(input).percent, 100)
})

test("upload and an unobserved running task have indeterminate progress", () => {
  assert.equal(initialImportProgress("uploading").percent, null)
  const input = payload()
  input.spanTree = []
  assert.equal(deriveIngestProgress(input).percent, null)
})

async function settle() {
  // Yield MACRO-tasks: each round drains the entire microtask queue, so any
  // await chain (however deep) settles deterministically.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function dialogHarness() {
  const slots: any[] = []
  let cursor = 0
  let status = payload([stage("chunk", "done"), stage("wikify", "done"), stage("storeChunks", "running")])
  let unavailable = false
  let uploadFailure = false
  let failNext = false
  let refreshed = 0
  let uploadedTo: string | null = null
  let uploadCalls = 0
  let uploadHold = false
  let inFlight = 0
  let maxInFlight = 0
  const uploadedTos: Array<string | null> = []
  const parkedUploads: Array<() => void> = []
  let catalogHold = false
  const parkedCatalog: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  let resumeCalls = 0
  let resumeHold = false
  let resumeFailure: string | null = null
  const resumeDocIds: string[] = []
  const parkedResumes: Array<() => void> = []
  let cancelCalls = 0
  let cancelHold = false
  let cancelFailure: string | null = null
  let cancelResult: Record<string, unknown> = { docId: "doc-1", taskId: 7, status: "cancelled", changed: true }
  const parkedCancels: Array<() => void> = []
  let statusHold = false
  const parkedStatus: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  let scopes: string[] = ["ingest"]
  const toasts: string[] = []
  const timers = new Map<number, () => Promise<void>>()
  const react = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value: any) => { slots[index] = typeof value === "function" ? value(slots[index]) : value }]
    },
    useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial } },
    useEffect() { cursor++ },
    useCallback(callback: unknown) { cursor++; return callback },
  }
  const exports: any = {}
  const source = readFileSync(join(__dirname, "../../frontend/src/components/panels/ImportDialog.tsx"), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  runInNewContext(compiled, {
    exports, Date, Error, console,
    window: {
      setInterval(callback: () => Promise<void>) { timers.set(1, callback); return 1 },
      clearInterval(id: number) { timers.delete(id) },
    },
      require(name: string) {
      if (name === "react") return react
      if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
      if (name.endsWith("/api")) return {
        // UT-23: the dialog types upload failures with this class; the stub
        // carries the same shape so the row's instanceof branch stays real.
        ImportUploadError: class ImportUploadError extends Error {
          kind: string
          detected?: string
          constructor(kind: string, message: string, detected?: string) {
            super(message)
            this.name = "ImportUploadError"
            this.kind = kind
            this.detected = detected
          }
        },
        async uploadFileToIngest(_file: unknown, _path: string, _onProgress: unknown, options: { knowledgeBaseId?: string }) {
          uploadCalls += 1
          uploadedTo = options?.knowledgeBaseId ?? null
          uploadedTos.push(uploadedTo)
          // UT-25: count truly concurrent transfers — the peak must never
          // exceed the configured slot count, whatever the wave interleaving.
          inFlight += 1
          if (inFlight > maxInFlight) maxInFlight = inFlight
          const done = () => { inFlight -= 1 }
          if (failNext) {
            failNext = false
            done()
            throw new Error("upload rejected")
          }
          if (uploadFailure) {
            done()
            throw new Error("upload rejected")
          }
          // UT-24: hold() parks the upload so a worker stays visibly busy
          // while a later wave is appended. The late response still carries
          // the accepted identity ("doc-1") — releases must resolve with it.
          if (uploadHold) return new Promise<string>((resolve) => parkedUploads.push(() => { done(); resolve("doc-1") }))
          done()
          return "doc-1"
        },
        async fetchIngestStatus() {
          // UT-29: park the status query so a stale poll response can be
          // released after a newer operation has landed.
          if (statusHold) {
            return new Promise((resolve, reject) => parkedStatus.push({ resolve, reject }))
          }
          if (unavailable) throw new Error("HTTP 503")
          return status
        },
        async fetchDocumentFolders() { return [] },
        async fetchKnowledgeBaseDocuments() {
          // UT-24: the pre-check's catalog read is the interleaved network
          // boundary — hold() parks it so tests decide when a wave settles.
          if (catalogHold) {
            return new Promise((resolve, reject) => parkedCatalog.push({ resolve, reject }))
          }
          return { documents: [], total: 0, page: 1, pageSize: 100, tags: [], folders: [] }
        },
        async createKnowledgeBase() { throw new Error("not expected in this test") },
        // UT-28: the server's cancellation confirmation.
        async cancelIngest(docId: string) {
          cancelCalls += 1
          if (cancelFailure) {
            const message = cancelFailure
            cancelFailure = null
            throw new Error(message)
          }
          if (cancelHold) return new Promise((resolve) => parkedCancels.push(() => resolve(cancelResult)))
          return cancelResult
        },
        async fetchDocumentDetail() { throw new Error("not expected in this test") },
        async retireSource() {},
        async submitUrlImport() { throw new Error("not expected in this test") },
        // UT-27: the original-task resume command.
        async resumeIngest(docId: string) {
          resumeCalls += 1
          resumeDocIds.push(docId)
          const result = { docId, taskId: 7, status: "pending", changed: true }
          if (resumeFailure) {
            const message = resumeFailure
            resumeFailure = null
            throw new Error(message)
          }
          if (resumeHold) return new Promise((resolve) => parkedResumes.push(() => resolve(result)))
          return result
        },
      }
      if (name.endsWith("/importBatch")) return importBatch
      if (name.endsWith("/knowledgeStore")) return {
        useKnowledgeBases: () => ({ activeKnowledgeBases: [{ id: "kb-1", name: "测试库", folderId: null }], folders: [], status: "ready" }),
        knowledgeStore: { async refresh() {} },
      }
      if (name.endsWith("/SessionContext")) return { useSignedInSession: () => ({ scopes }) }
      if (name.endsWith("/constants")) return constants
      if (name.endsWith("/cn")) return { cn: (...parts: unknown[]) => parts.filter(Boolean).join(" ") }
      if (name.endsWith("/ingestProgress")) return { deriveIngestProgress, initialImportProgress, describeActivationReasons, describeAllowedOperations }
      if (name.endsWith("/AppShellContext")) return { useAppShell: () => ({ showToast: (message: string) => toasts.push(message) }) }
      if (name.endsWith("/icons")) return { Database: {}, X: {} }
      if (name.endsWith("/Icon")) return { Icon: "icon" }
      if (name === "./ImportProgress") return { ImportProgress: "import-progress" }
      if (name === "./ImportDropzone") return { ImportDropzone: "import-dropzone" }
      if (name === "./ImportAdvancedOptions") return { ImportAdvancedOptions: "advanced-options" }
      throw new Error(`Unexpected module ${name}`)
    },
  })
  function render() { cursor = 0; return exports.ImportDialog({ open: true, onClose() {}, onIngested() { refreshed++ } }) }
  function find(node: any, predicate: (node: any) => boolean): any {
    if (!node || typeof node !== "object") return null
    if (predicate(node)) return node
    const children = Array.isArray(node) ? node : [node.props?.children]
    for (const child of children) { const found = find(child, predicate); if (found) return found }
    return null
  }
  return {
    async upload() {
      const selector = find(render(), (node) => node.type === "select" && node.props.id === "import-knowledge-base")
      selector.props.onChange({ target: { value: "kb-1" } })
      const dropzone = find(render(), (node) => node.type === "import-dropzone")
      const file = { name: "test.pdf", size: 100 }
      dropzone.props.onPick({ files: [{ file, relativePath: "test.pdf" }], folders: [], skipped: 0 })
      await settle()
    },
    /** UT-24: enqueue extra files WITHOUT waiting — reproduces the追加 race. */
    pick(names: string[]) {
      const selector = find(render(), (node) => node.type === "select" && node.props.id === "import-knowledge-base")
      selector.props.onChange({ target: { value: "kb-1" } })
      const dropzone = find(render(), (node) => node.type === "import-dropzone")
      dropzone.props.onPick({
        files: names.map((name) => ({ file: { name, size: 100 }, relativePath: name })),
        folders: [],
        skipped: 0,
      })
    },
    clickButton(label: string) {
      const button = find(
        render(),
        (node) => node.type === "button" && JSON.stringify(node.props?.children ?? "").includes(label),
      )
      assert.ok(button, `button 「${label}」 rendered`)
      button.props.onClick()
    },
    /** UT-26: does the rendered dialog tree contain this text anywhere? */
    hasText(label: string): boolean {
      return find(render(), (node) => JSON.stringify(node.props?.children ?? "").includes(label)) !== null
    },
    /** UT-27: is a BUTTON with exactly this label rendered? (Text probes can
     * false-positive on the allowed-operations copy, e.g. 「可恢复」.) */
    hasButton(label: string): boolean {
      return find(render(), (node) => node.type === "button" && node.props?.children === label) !== null
    },
    holdUpload() { uploadHold = true },
    releaseUpload() {
      uploadHold = false
      for (const release of parkedUploads.splice(0)) release()
    },
    deferCatalog() { catalogHold = true },
    resolveCatalog(entries: Array<Record<string, unknown>> = []) {
      catalogHold = false
      for (const parked of parkedCatalog.splice(0)) {
        parked.resolve({ documents: entries, total: entries.length, page: 1, pageSize: 100, tags: [], folders: [] })
      }
    },
    failCatalog() {
      catalogHold = false
      for (const parked of parkedCatalog.splice(0)) parked.reject(new Error("catalog read failed"))
    },
    async poll(next?: IngestStatus) {
      if (next) status = next
      for (const callback of timers.values()) await callback()
      await settle()
    },
    progress() { return find(render(), (node) => node.type === "import-progress").props },
    failQuery(value: boolean) { unavailable = value },
    failUpload() { uploadFailure = true },
    failNextUpload() { failNext = true },
    setScopes(next: string[]) { scopes = next },
    holdResume() { resumeHold = true },
    releaseResume() {
      resumeHold = false
      for (const release of parkedResumes.splice(0)) release()
    },
    failResume(message: string) { resumeFailure = message },
    holdCancel() { cancelHold = true },
    releaseCancel() {
      cancelHold = false
      for (const release of parkedCancels.splice(0)) release()
    },
    failCancel(message: string) { cancelFailure = message },
    setCancelResult(result: Record<string, unknown>) { cancelResult = result },
    /** Swap the served status WITHOUT firing polls (requeue semantics). */
    stageStatus(next: IngestStatus) { status = next },
    deferStatus() { statusHold = true },
    releaseStatus() {
      statusHold = false
      for (const parked of parkedStatus.splice(0)) parked.resolve(status)
    },
    firePoll() { for (const callback of timers.values()) void callback() },
    toasts, timers, get refreshed() { return refreshed }, get uploadedTo() { return uploadedTo },
    get uploadCalls() { return uploadCalls }, get uploadedTos() { return [...uploadedTos] },
    get maxInFlight() { return maxInFlight },
    get resumeCalls() { return resumeCalls }, get resumeDocIds() { return [...resumeDocIds] },
    get cancelCalls() { return cancelCalls },
  }
}

test("dialog polls processing stages and notifies completion only after a terminal response", async () => {
  const host = dialogHarness()
  await host.upload()
  assert.equal(host.uploadedTo, "kb-1")
  assert.equal(host.progress().progress.percent, 50)
  assert.equal(host.toasts.length, 0)
  assert.equal(host.refreshed, 0)
  const complete = payload()
  complete.task!.status = "completed"
  complete.documentStatus = "completed"
  await host.poll(complete)
  assert.equal(host.progress().progress.percent, 100)
  assert.equal(host.timers.size, 0)
  assert.equal(host.toasts.length, 1)
  assert.equal(host.refreshed, 1)
})

test("a status query failure preserves progress and recovers on a later successful poll", async () => {
  const host = dialogHarness()
  await host.upload()
  host.failQuery(true)
  await host.poll()
  assert.equal(host.progress().progress.status, "processing")
  assert.equal(host.progress().progress.percent, 50)
  assert.equal(host.progress().syncError, "HTTP 503")
  assert.equal(host.timers.size, 1)
  host.failQuery(false)
  await host.poll()
  assert.equal(host.progress().syncError, null)
})

test("upload rejection settles the row without starting processing polling", async () => {
  const host = dialogHarness()
  host.failUpload()
  await host.upload()
  assert.equal(host.progress().progress.status, "failed")
  assert.equal(host.progress().progress.error, "upload rejected")
  assert.equal(host.timers.size, 0)
  assert.equal(host.refreshed, 0)
  assert.equal(host.toasts.length, 1)
})

// ---------------------------------------------------------------------------
// UT-24: wave pre-flight gate — old workers never race a new wave.
// ---------------------------------------------------------------------------

test("UT-24: a busy worker from an earlier wave never claims a new wave's unsettled rows", async () => {
  const host = dialogHarness()
  // Wave 1: pre-check settles immediately, then the upload parks — the worker
  // is now busy for the rest of the scenario.
  host.holdUpload()
  await host.upload()
  assert.equal(host.uploadCalls, 1)

  // 追加 wave 2 while wave 1's upload is in flight, and its pre-check hangs
  // on the network (interleaved slow catalog read).
  host.deferCatalog()
  host.pick(["追加-b.pdf"])
  await settle()
  assert.equal(host.uploadCalls, 1, "no upload request for the row before its pre-check settles")

  // The pre-check completing — not the idle worker — is what releases the row.
  host.resolveCatalog()
  await settle()
  assert.equal(host.uploadCalls, 2, "the row is claimable only after settlement")
  assert.deepEqual(host.uploadedTos, ["kb-1", "kb-1"], "multi-wave uploads keep the wave's KB binding")
  host.releaseUpload()
})

test("UT-24: a same-name hit waits for the user's decision and is schedulable after 确认", async () => {
  const host = dialogHarness()
  host.deferCatalog()
  host.pick(["existing.pdf"])
  await settle()
  assert.equal(host.uploadCalls, 0)

  // The catalog read comes back with the same base file name: the row must
  // settle INTO the confirmation state, not into the worker queue.
  host.resolveCatalog([{ fileName: "existing.pdf" }])
  await settle()
  assert.equal(host.uploadCalls, 0, "same-name hits never auto-upload")

  // 拒绝 path first: skipping is terminal and creates no upload.
  // (Skipped via 跳过 below only after confirming the 仍要导入 path here.)
  host.clickButton("仍要导入")
  await settle()
  assert.equal(host.uploadCalls, 1, "confirmation makes exactly the confirmed row claimable")
})

test("UT-24: cancellation during a pending pre-check is terminal without an upload", async () => {
  const host = dialogHarness()
  host.deferCatalog()
  host.pick(["cancel-me.pdf"])
  await settle()
  assert.equal(host.uploadCalls, 0)
  host.clickButton("取消")
  await settle()
  host.resolveCatalog()
  await settle()
  assert.equal(host.uploadCalls, 0, "a cancelled row stays terminal even after its wave settles")
})

test("UT-24: a failed pre-check settles the wave with an explainable toast, never an infinite wait", async () => {
  const host = dialogHarness()
  host.deferCatalog()
  host.pick(["stuck.pdf"])
  await settle()
  assert.equal(host.uploadCalls, 0)
  host.failCatalog()
  await settle()
  assert.equal(host.uploadCalls, 1, "rows settle on pre-check failure — the server's 409 is the safety net")
  assert.ok(
    host.toasts.some((message) => message.includes("同名预检查不可用")),
    "the failure is explained, not hidden behind a wait",
  )
})

// ---------------------------------------------------------------------------
// UT-25: shared cross-wave upload slots.
// ---------------------------------------------------------------------------

test("UT-25: concurrent uploads never exceed the shared slot count across waves", async () => {
  const host = dialogHarness()
  // Wave 1: one upload parks; the two surplus worker loops exit (their exit
  // used to zero the boolean gate while the first worker was still alive).
  host.holdUpload()
  await host.upload()
  assert.equal(host.uploadCalls, 1)

  // Wave 2 appended mid-flight: three more rows, settled pre-check.
  host.pick(["b.pdf", "c.pdf", "d.pdf"])
  await settle()

  // Drain everything, then inspect the peak.
  host.releaseUpload()
  await settle()
  assert.ok(
    host.maxInFlight <= 3,
    `in-flight peaked at ${host.maxInFlight}; the shared limit is 3 (old bug: 4)`,
  )
  assert.equal(host.uploadCalls, 4, "every row uploaded exactly once")
  assert.equal(host.maxInFlight, 3, "slots stay fully utilized without overshoot")
})

test("UT-25: one failed transfer neither leaks a slot nor blocks the other ready rows", async () => {
  const host = dialogHarness()
  host.failNextUpload()
  await host.upload() // wave 1 row fails (terminal)
  host.pick(["b.pdf", "c.pdf"])
  await settle()
  assert.equal(host.uploadCalls, 3, "the failure did not stall the worker — later rows still upload")
  assert.ok(host.maxInFlight <= 3)
  assert.equal(host.maxInFlight >= 1, true, "a slot was actually used")
})

// ---------------------------------------------------------------------------
// UT-26: pending-review vs business-review vs capability states.
// ---------------------------------------------------------------------------

const allDone = () => [
  stage("chunk", "done"), stage("wikify", "done"),
  stage("storeChunks", "done"), stage("storeGraph", "done"),
]

test("UT-26: a gate-blocked candidate renders as 待校验 with reasons and the old-version note", () => {
  const blocked = payload(allDone())
  blocked.documentStatus = "completed"
  blocked.task = { status: "completed", failCount: 0, nextAttemptAt: null }
  blocked.activationBlockReason = "activation_content_proof_pending_review"
  blocked.documentVersion = { version: 2, contentHash: "hash", active: false }
  const progress = deriveIngestProgress(blocked)
  // A gate denial is NOT completion — no 100 percent, no success copy.
  assert.equal(progress.status, "pending_review")
  assert.match(progress.summary, /待校验/)
  assert.notEqual(progress.percent, 100)
  assert.equal(progress.outcome?.state, "pending_review")
  // The module runs in a VM realm: compare arrays structurally via JSON.
  assert.equal(
    JSON.stringify(progress.outcome?.blockReasons),
    JSON.stringify(["activation_content_proof_pending_review"]),
  )
  assert.equal(progress.outcome?.oldVersionUsable, true, "v2 blocked while v1 stays active")
})

test("UT-26: unknown activation reasons are never mapped to completion", () => {
  const unknown = payload(allDone())
  unknown.documentStatus = "completed"
  unknown.task = { status: "completed", failCount: 0, nextAttemptAt: null }
  unknown.activationBlockReason = "activation_some_future_reason"
  const progress = deriveIngestProgress(unknown)
  assert.equal(progress.status, "pending_review")
  assert.equal(
    JSON.stringify(progress.outcome?.blockReasons),
    JSON.stringify(["activation_some_future_reason"]),
    "unmapped codes pass through verbatim",
  )
})

test("UT-26: business review hold (candidate pending_review) renders as 待审中", () => {
  const review = payload(allDone())
  review.documentStatus = "completed"
  review.task = { status: "completed", failCount: 0, nextAttemptAt: null }
  review.candidateState = "pending_review"
  review.documentVersion = { version: 1, contentHash: "hash", active: false }
  const progress = deriveIngestProgress(review)
  assert.equal(progress.status, "business_review")
  assert.match(progress.summary, /业务审批/)
  assert.equal(progress.outcome?.state, "business_review")
  // First upload (version 1): there IS no old version to point at.
  assert.equal(progress.outcome?.oldVersionUsable, false)
})

test("UT-26: capability missing surfaces the machine-readable allowed operations", () => {
  const missing = payload([stage("chunk", "failed")])
  missing.documentStatus = "failed"
  missing.task = { status: "failed", failCount: 1, nextAttemptAt: null }
  missing.failure = {
    category: "capability_missing",
    reasonCode: "configure_parser_then_retry",
    retryable: false,
    allowedOperations: ["configure_parser_then_retry", "cancel"],
    message: "Parser executable is unavailable. Configure MARKITDOWN_COMMAND.",
    failedAt: "2026-10-04T08:00:00.000Z",
  }
  const progress = deriveIngestProgress(missing)
  assert.equal(progress.status, "failed")
  assert.equal(progress.outcome?.state, "capability_missing")
  assert.equal(
    JSON.stringify(progress.outcome?.allowedOperations),
    JSON.stringify(["configure_parser_then_retry", "cancel"]),
  )
})

test("UT-26: the row shows the 待校验 badge, the reason copy and the old-version note", async () => {
  const host = dialogHarness()
  await host.upload()
  const blocked = payload(allDone())
  blocked.documentStatus = "completed"
  blocked.task = { status: "completed", failCount: 0, nextAttemptAt: null }
  blocked.activationBlockReason = "activation_content_proof_pending_review"
  blocked.documentVersion = { version: 2, contentHash: "hash", active: false }
  await host.poll(blocked)
  assert.equal(host.progress().progress.status, "pending_review")
  assert.equal(host.hasText("待校验"), true, "the badge renders the hold state")
  assert.equal(host.hasText("内容完整性待校验"), true, "the human-readable reason renders")
  assert.equal(host.hasText("现有版本仍可正常使用"), true, "the old-version note renders")
  assert.equal(host.hasText("重试"), false, "no meaningless retry on an unproven candidate")
})

// ---------------------------------------------------------------------------
// UT-27: resume sends the ORIGINAL task command.
// ---------------------------------------------------------------------------

const capabilityFailure = {
  category: "capability_missing",
  reasonCode: "configure_parser_then_retry",
  retryable: false,
  allowedOperations: ["configure_parser_then_retry", "cancel"],
  message: "Parser executable is unavailable. Configure MARKITDOWN_COMMAND.",
  failedAt: "2026-10-04T08:00:00.000Z",
}

function failedPayload() {
  const failed = payload([stage("chunk", "failed")])
  failed.documentStatus = "failed"
  failed.task = { status: "failed", failCount: 1, nextAttemptAt: null }
  failed.failure = { ...capabilityFailure }
  return failed
}

test("UT-27: resume requeues the original task — no re-upload, no new version, no File needed", async () => {
  const host = dialogHarness()
  host.setScopes(["ingest", "admin"])
  await host.upload()
  await host.poll(failedPayload())
  assert.equal(host.hasButton("恢复"), true, "admin + configure_parser_then_retry offers resume")

  host.holdResume()
  host.clickButton("恢复")
  host.clickButton("恢复") // duplicate click while in flight
  assert.equal(host.resumeCalls, 1, "duplicate clicks never double-resume")

  host.releaseResume()
  // The server requeued the task: its status now reads pending again (the
  // swap happens before the resume promise settles, mirroring the backend's
  // transaction-commit-before-response ordering).
  const requeued = payload([])
  requeued.documentStatus = "pending"
  requeued.task = { status: "pending", failCount: 0, nextAttemptAt: null }
  host.stageStatus(requeued)
  await settle()
  // The upload stub's returned docId is "doc-1" — resume requeues THAT task.
  assert.deepEqual(host.resumeDocIds, ["doc-1"], "the command carries the SAME docId")
  assert.equal(host.uploadCalls, 1, "resume never re-uploads — the File handle is irrelevant")
  assert.equal(host.progress().progress.status, "pending", "the row is processing again on the same document")
})

test("UT-27: a refused resume surfaces the server's reason without faking success", async () => {
  const host = dialogHarness()
  host.setScopes(["ingest", "admin"])
  await host.upload()
  await host.poll(failedPayload())
  host.failResume('HTTP 409: document is not retryable in state "completed"')
  host.clickButton("恢复")
  await settle()
  assert.equal(host.progress().progress.status, "failed", "the row keeps its failed state")
  assert.equal(host.hasText("not retryable"), true, "the server's refusal is shown verbatim")
  assert.equal(host.uploadCalls, 1, "refusal never becomes a re-upload")
})

test("UT-27: resume only renders for admin sessions and resume-capable failures", async () => {
  // Reader scope: the backend's resume command is admin-only, so no button.
  const reader = dialogHarness()
  await reader.upload()
  await reader.poll(failedPayload())
  assert.equal(reader.hasButton("恢复"), false, "no resume without the admin scope")

  // Transient failure: the server says wait_for_auto_retry — no resume.
  const waiting = dialogHarness()
  waiting.setScopes(["ingest", "admin"])
  await waiting.upload()
  const transient = payload([stage("chunk", "failed")])
  transient.documentStatus = "failed"
  transient.task = { status: "failed", failCount: 1, nextAttemptAt: null }
  transient.failure = {
    category: "transient",
    reasonCode: "wait_for_auto_retry",
    retryable: true,
    allowedOperations: ["wait_for_auto_retry", "cancel"],
    message: "429 rate limited",
    failedAt: "2026-10-04T08:00:00.000Z",
  }
  await waiting.poll(transient)
  assert.equal(waiting.hasButton("恢复"), false, "auto-retry rows wait instead of resuming")
})

// ---------------------------------------------------------------------------
// UT-28: server-confirmed cancellation and unknown-outcome sync.
// ---------------------------------------------------------------------------

test("UT-28: only a server-confirmed cancellation shows 已取消", async () => {
  const host = dialogHarness()
  await host.upload() // accepted: docId exists — the server is the authority
  host.clickButton("取消")
  await settle()
  assert.equal(host.cancelCalls, 1)
  // The batch footer always prints a 「N 已取消」 counter — assert the ROW's
  // own progress state, not the page text.
  assert.equal(host.progress().progress.status, "cancelled", "confirmed cancellation renders the terminal state")
  // Polling agrees with the badge: the terminal state survives a poll.
  const cancelled = payload([])
  cancelled.documentStatus = "cancelled"
  cancelled.task = { status: "cancelled", failCount: 0, nextAttemptAt: null }
  await host.poll(cancelled)
  assert.equal(host.progress().progress.status, "cancelled")
})

test("UT-28: a refused cancellation syncs the row to the server's terminal truth", async () => {
  const host = dialogHarness()
  await host.upload()
  // The task finished BEFORE the cancel landed: the server refuses (changed=false).
  host.setCancelResult({ docId: "doc-1", taskId: 7, status: "completed", changed: false, reason: "already completed" })
  const completed = payload(allDone())
  completed.documentStatus = "completed"
  completed.task = { status: "completed", failCount: 0, nextAttemptAt: null }
  host.stageStatus(completed)
  host.clickButton("取消")
  await settle()
  assert.equal(host.hasText("服务端拒绝取消"), true, "the refusal is visible")
  assert.equal(host.progress().progress.status, "completed", "the row synced to the server's authority")
})

test("UT-28: an unknown cancellation keeps the real state and converges via bounded polling", async () => {
  const host = dialogHarness()
  await host.upload()
  host.failCancel("Failed to fetch") // network failure — outcome UNKNOWN
  host.clickButton("取消")
  await settle()
  // The batch footer always prints a 「N 已取消」 counter — assert the ROW.
  assert.equal(host.hasText("取消结果未知"), true, "the unknown state is visible to the user")
  assert.notEqual(
    host.progress().progress.status,
    "cancelled",
    "the row keeps its real pre-cancel state (still processing)",
  )
  // The server DID cancel eventually: the next bounded poll converges.
  const cancelled = payload([])
  cancelled.documentStatus = "cancelled"
  cancelled.task = { status: "cancelled", failCount: 0, nextAttemptAt: null }
  await host.poll(cancelled)
  assert.equal(host.progress().progress.status, "cancelled", "polling converges to the server's truth")
})

test("UT-28: repeated cancel clicks are idempotent", async () => {
  const host = dialogHarness()
  await host.upload()
  host.holdCancel()
  host.clickButton("取消")
  host.clickButton("取消") // duplicate while the first is in flight
  assert.equal(host.cancelCalls, 1, "duplicate clicks never double-cancel")
  host.releaseCancel()
  await settle()
  assert.equal(host.progress().progress.status, "cancelled")
})

// ---------------------------------------------------------------------------
// UT-29: late identities and stale responses converge by operation order.
// ---------------------------------------------------------------------------

test("UT-29: a late upload identity honors the cancel intent", async () => {
  const host = dialogHarness()
  host.holdUpload()
  await host.upload() // wave 1 settles, upload A parks (worker busy)
  // Upload a second file and request cancellation WHILE it is in flight.
  host.pick(["late.pdf"])
  await settle()
  host.clickButton("取消") // uploading row: cancel intent, no docId yet
  await settle()
  assert.equal(host.hasText("取消已请求"), true, "the pending intent is visible")

  // The late upload response arrives with an identity: the row must link it
  // and ask the backend to cancel the just-accepted task.
  host.releaseUpload()
  await settle()
  assert.equal(host.cancelCalls, 1, "the backend is asked to cancel the accepted task")
  assert.equal(host.progress().progress.status, "cancelled", "the intent converges to a confirmed cancellation")
  assert.equal(host.uploadCalls, 2, "no re-upload — the late identity was reused, not resent")
})

test("UT-29: a stale poll response cannot undo a newer cancellation", async () => {
  const host = dialogHarness()
  await host.upload() // row pending, polling active
  // A status query starts NOW and its response is held in the network.
  host.deferStatus()
  host.firePoll()
  await settle()
  // The user cancels while that stale poll is still in flight: the cancel
  // bumps the row's generation, so the stale response must be discarded.
  host.clickButton("取消")
  await settle()
  assert.equal(host.progress().progress.status, "cancelled", "the cancellation took effect")
  host.releaseStatus() // the stale 「processing」 response finally lands
  await settle()
  assert.equal(
    host.progress().progress.status,
    "cancelled",
    "the stale poll cannot undo the newer cancellation",
  )
})

// ---------------------------------------------------------------------------
// UT-30: stable timing origins, ETA honesty (controlled clock).
// ---------------------------------------------------------------------------

test("UT-30: upload ETA stays honest at zero progress, tiny samples, stalls and completion", () => {
  const upload = (loaded: number, total: number, startedAt: number, updatedAt: number) =>
    ({ loaded, total, startedAt, updatedAt })
  const now = 60_000
  // 零进度：无法推导速率 — 绝不显示虚假倒计时。
  assert.equal(estimateUploadRemainingMs(upload(0, 1_000_000, 0, now), now), null)
  // 样本不足（<800ms 观测窗口）：不给精确数字。
  assert.equal(estimateUploadRemainingMs(upload(250_000, 1_000_000, now - 500, now), now), null)
  // 停滞（>5s 无更新）：估算作废。
  assert.equal(estimateUploadRemainingMs(upload(500_000, 1_000_000, 0, now - 6_000), now), null)
  // 已完成/超总量：不再倒计时，也不出现负数。
  assert.equal(estimateUploadRemainingMs(upload(1_000_000, 1_000_000, 0, now - 2_000), now), null)
  assert.equal(estimateUploadRemainingMs(upload(1_100_000, 1_000_000, 0, now - 2_000), now), null)
  // 正常情形给出有界的正数估算。
  const healthy = estimateUploadRemainingMs(upload(250_000, 1_000_000, now - 2_000, now), now)
  assert.ok(healthy !== null && healthy > 0 && Number.isFinite(healthy))
})

test("UT-30: import ETA excludes non-processing states and never goes negative", () => {
  // 处理中：有估算。
  const processing = deriveIngestProgress(payload([stage("chunk", "done"), stage("wikify", "running")]))
  assert.ok(estimateImportRemainingMs(processing, 1_000, 2_000, 100_000) > 0)
  // 处理时长已超过估算 → null（绝不出现负数倒计时）。
  assert.equal(estimateImportRemainingMs(processing, 1_000, 60_000, 100_000), null)
  // fileSize 为 0（冷启动/未知大小）不产生 NaN/Infinity。
  const zeroSize = estimateImportRemainingMs(processing, 1_000, 2_000, 0)
  assert.ok(zeroSize === null || (zeroSize > 0 && Number.isFinite(zeroSize)))
})

test("UT-30: unknown, pending-review and capability states never show an ETA", () => {
  const review = payload(allDone())
  review.documentStatus = "completed"
  review.task = { status: "completed", failCount: 0, nextAttemptAt: null }
  review.activationBlockReason = "activation_content_proof_pending_review"
  const states = [
    deriveIngestProgress(review),                                    // 待校验
    deriveIngestProgress({ ...payload(), documentStatus: "pending", task: null }), // 未知/排队
    deriveIngestProgress(failedPayload()),                           // 待能力（失败）
  ]
  for (const progress of states) {
    assert.equal(
      estimateImportRemainingMs(progress, 1_000, 60_000, 100_000),
      null,
      `state ${progress.status} must not carry a countdown`,
    )
  }
})

test("UT-30: consecutive polls keep the attempt start; a resume records a new one", async () => {
  const host = dialogHarness()
  await host.upload()
  const processing = payload([stage("chunk", "running")])
  await host.poll(processing)
  const first = host.progress().processingStartedAt
  assert.ok(first, "the attempt start is recorded on the first processing poll")
  await host.poll(processing) // another poll of the SAME attempt
  assert.equal(host.progress().processingStartedAt, first, "polls never reset the original start")
  // 失败后经原任务恢复：新尝试另有起点。（服务端 requeue 后状态即为处理中
  // ——先 stage 服务端状态再点恢复，与后端事务先于响应的顺序一致。）
  await host.poll(failedPayload())
  host.setScopes(["ingest", "admin"])
  host.stageStatus(payload([stage("chunk", "running")]))
  host.clickButton("恢复")
  await settle()
  await host.poll(payload([stage("chunk", "running")]))
  const second = host.progress().processingStartedAt
  assert.ok(second !== undefined && second > (first as number), "a resume records a NEW attempt start")
})
