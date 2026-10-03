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
}

function loadFrontendModule(path: string): any {
  const source = readFileSync(join(__dirname, "../..", path), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  runInNewContext(compiled, { exports })
  return exports
}

const { deriveIngestProgress, initialImportProgress, buildImportSteps, estimateUploadRemainingMs, estimateImportRemainingMs } = loadFrontendModule("frontend/src/lib/ingestProgress.ts")
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
  let refreshed = 0
  let uploadedTo: string | null = null
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
          uploadedTo = options?.knowledgeBaseId ?? null
          if (uploadFailure) throw new Error("upload rejected")
          return "doc-1"
        },
        async fetchIngestStatus() { if (unavailable) throw new Error("HTTP 503"); return status },
        async fetchDocumentFolders() { return [] },
        async fetchKnowledgeBaseDocuments() { return { documents: [], total: 0, page: 1, pageSize: 100, tags: [], folders: [] } },
        async createKnowledgeBase() { throw new Error("not expected in this test") },
        async cancelIngest() {},
        async fetchDocumentDetail() { throw new Error("not expected in this test") },
        async retireSource() {},
        async submitUrlImport() { throw new Error("not expected in this test") },
      }
      if (name.endsWith("/importBatch")) return importBatch
      if (name.endsWith("/knowledgeStore")) return {
        useKnowledgeBases: () => ({ activeKnowledgeBases: [{ id: "kb-1", name: "测试库", folderId: null }], folders: [], status: "ready" }),
        knowledgeStore: { async refresh() {} },
      }
      if (name.endsWith("/SessionContext")) return { useSignedInSession: () => ({ scopes: ["ingest"] }) }
      if (name.endsWith("/constants")) return constants
      if (name.endsWith("/cn")) return { cn: (...parts: unknown[]) => parts.filter(Boolean).join(" ") }
      if (name.endsWith("/ingestProgress")) return { deriveIngestProgress, initialImportProgress }
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
    async poll(next?: IngestStatus) {
      if (next) status = next
      for (const callback of timers.values()) await callback()
      await settle()
    },
    progress() { return find(render(), (node) => node.type === "import-progress").props },
    failQuery(value: boolean) { unavailable = value },
    failUpload() { uploadFailure = true },
    toasts, timers, get refreshed() { return refreshed }, get uploadedTo() { return uploadedTo },
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
