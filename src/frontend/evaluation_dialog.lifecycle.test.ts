import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"

// Execute the actual dialog with a minimal hook host. Transport promises and
// timers are controlled so response ordering is deterministic, without a DOM.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness() {
  const slots: any[] = []
  let cursor = 0
  let effects: Array<() => void> = []
  const timers = new Map<number, () => void>()
  const requests: Array<{ id: string; response: ReturnType<typeof deferred<any>> }> = []
  let historyError = false
  const same = (a: any[], b: any[]) => a?.length === b.length && b.every((v, i) => Object.is(v, a[i]))
  const react = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value: any) => { slots[index] = typeof value === "function" ? value(slots[index]) : value }]
    },
    useRef(initial: any) {
      const index = cursor++
      return slots[index] ??= { current: initial }
    },
    useCallback(callback: any, deps: any[]) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, callback }
      return slots[index].callback
    },
    useEffect(effect: () => any, deps: any[]) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps }
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect() })
      }
    },
  }
  const summary = (id: string) => ({ id, stage: "running", dataset: { name: id, contentDigest: "digest" }, progress: { finished: 0, total: 1 }, counts: { answered: 0, failed: 0, degraded: 0 } })
  const detail = (id: string) => ({ ...summary(id), config: {}, cases: [], metrics: { metrics: {} }, cleanup: null })
  let cancelBehaviour: "ok" | "settled" | "gone" = "ok"
  const api = {
    EvaluationCancelError: class EvaluationCancelError extends Error {
      constructor(message: string, readonly status: number) { super(message); this.name = "EvaluationCancelError" }
    },
    fetchEvaluationDatasets: async () => ({ datasets: [], defaults: {}, allowedModels: { chat: [], rerank: [] } }),
    fetchAssistants: async () => [],
    listEvaluationTasks: async () => { if (historyError) throw new Error("history offline"); return [summary("task-a"), summary("task-b")] },
    fetchEvaluationTask(id: string) { const response = deferred<any>(); requests.push({ id, response }); return response.promise },
    async cancelEvaluationTask(id: string) {
      if (cancelBehaviour === "settled") throw new api.EvaluationCancelError("任务已经结束，结果不会被取消改写", 409)
      if (cancelBehaviour === "gone") throw new api.EvaluationCancelError("任务不在当前服务进程中", 404)
      return detail(id)
    },
  }
  const exports: any = {}
  const source = readFileSync(resolve("frontend/src/components/panels/EvaluationDialog.tsx"), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      // UI primitives are inert host nodes; the real dialog's business hooks and transport stay under test.
      if (name.includes("/primitives/")) return { Button:"button", Input:"input", Textarea:"textarea", DialogTitle:"h2", RadioGroup:"radiogroup", RadioGroupItem:"radio", ToggleGroup:"group", ToggleGroupItem:"button", Alert:"alert", AlertDescription:"description", FieldSet:"fieldset", FieldLegend:"legend" }
      if (name.endsWith("/Controls")) return {Button:"button",Select:"select",TextInput:"input",TextArea:"textarea",Field:"field",Checkbox:"checkbox",EmptyState:"empty",StatusBadge:"badge"}
      if (name.endsWith("/Dialog")) return {Dialog:"dialog",PanelDialog:"dialog"}
      if (name === "react") return react
      if (name === "react/jsx-runtime") return { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) }
      if (name.endsWith("/api")) return api
      if (name.endsWith("/constants")) return { EVALUATION_POLL_MS: 1 }
      if (name.endsWith("/cn")) return { cn: (...values: any[]) => values.join(" ") }
      if (name.endsWith("/Dialog")) return { Dialog: "dialog" }
      if (name.endsWith("/Controls")) {
        return {
          Button: "button",
          Select: "select",
          TextArea: "textarea",
          TextInput: "input",
        }
      }
      return {}
    },
    window: { setInterval(callback: () => void) { const id = timers.size + 1; timers.set(id, callback); return id }, clearInterval(id: number) { timers.delete(id) } },
  })
  function render(open = true): any {
    cursor = 0
    const tree = exports.EvaluationDialog({ open, onClose() {} })
    const pending = effects; effects = []; pending.forEach((effect) => effect())
    return tree
  }
  function nodes(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(nodes)
    if (!node || typeof node !== "object") return []
    return [node, ...nodes(node.props?.children)]
  }
  function text(node: any): string {
    if (Array.isArray(node)) return node.map(text).join(" ")
    if (node && typeof node === "object") return text(node.props?.children)
    return node === undefined || node === null ? "" : String(node)
  }
  async function flush() { await Promise.resolve(); await Promise.resolve() }
  async function select(id: string) {
    const button = nodes(render()).find((node) => node.type === "button" && text(node).includes(id))
    assert.ok(button, `history button for ${id}`)
    button.props.onClick()
    await flush()
  }
  function click(label: string) {
    const button = nodes(render()).find((node) => node.type === "button" && text(node).includes(label))
    assert.ok(button, `button for ${label}`)
    button.props.onClick()
  }
  return {
    render,
    text,
    select,
    click,
    requests,
    detail,
    flush,
    timers,
    tick: () => [...timers.values()].forEach((callback) => callback()),
    failHistory: () => { historyError = true },
    setCancel: (value: "ok" | "settled" | "gone") => { cancelBehaviour = value },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
  }
}

test("selecting a new evaluation drops a rejected request for the old record", async () => {
  const h = harness(); h.render(); await h.flush()
  await h.select("task-a")
  await h.select("task-b")
  h.requests[1].response.resolve(h.detail("task-b")); await h.flush()
  h.requests[0].response.reject(new Error("stale failure")); await h.flush()
  assert.doesNotMatch(h.text(h.render()), /stale failure/)
  assert.equal(h.timers.size, 1)
})

test("closing invalidates pending polls and reopening reloads the selected task", async () => {
  const h = harness(); h.render(); await h.flush()
  await h.select("task-a")
  h.requests[0].response.resolve(h.detail("task-a")); await h.flush(); h.render()
  h.tick()
  h.render(false)
  assert.equal(h.timers.size, 0, "closed dialog stops polling")
  h.requests[1].response.resolve(null); await h.flush()
  assert.doesNotMatch(h.text(h.render(false)), /任务记录已不存在/)
  h.render(true); await h.flush()
  assert.equal(h.requests.length, 3, "reopening reloads selection")
  h.requests[2].response.resolve(h.detail("task-a")); await h.flush()
  assert.equal(h.timers.size, 1, "active task resumes polling")
})

test("history loading and failure are distinguishable from empty history", async () => {
  const h = harness(); h.failHistory(); h.render()
  assert.match(h.text(h.render()), /正在读取评测记录/)
  await h.flush()
  const content = h.text(h.render())
  assert.match(content, /history offline/)
  assert.doesNotMatch(content, /本进程暂无评测记录/)
})

test("a cancel refused because the task already settled shows the settled record, not a failure", async () => {
  const h = harness(); h.render(); await h.flush()
  await h.select("task-a")
  h.requests[0].response.resolve(h.detail("task-a")); await h.flush()
  h.render()
  h.setCancel("settled")
  h.click("取消本次评测")
  await h.flush()
  assert.equal(h.requests.length, 2, "409 re-reads the record instead of leaving the panel as it was")
  h.requests[1].response.resolve({ ...h.detail("task-a"), stage: "completed_with_errors", error: "清理失败" })
  await h.flush()
  const content = h.text(h.render())
  assert.doesNotMatch(content, /任务已经结束/, "the state refusal is not dressed up as a failure")
  assert.match(content, /任务失败：\s*清理失败/, "the settled record is displayed with its own reason")
})

test("cancel keeps polling until the run reaches its single terminal state", async () => {
  const h = harness(); h.render(); await h.flush()
  await h.select("task-a")
  h.requests[0].response.resolve(h.detail("task-a")); await h.flush()
  h.render()
  h.click("取消本次评测")
  await h.flush()
  assert.equal(h.timers.size, 1, "a confirmed cancel keeps polling the same task")
  h.tick()
  assert.equal(h.requests.length, 2)
  h.requests[1].response.resolve({ ...h.detail("task-a"), stage: "failed", error: "cancelled by request" })
  await h.flush()
  h.render()
  assert.equal(h.timers.size, 0, "the terminal state stops the polling")
  assert.match(h.text(h.render()), /cancelled by request/, "the cancel reason is not hidden")
})

test("polling serializes slow reads and unmount prevents a pending selection from restarting it", async () => {
  const h = harness(); h.render(); await h.flush()
  await h.select("task-a")
  h.requests[0].response.resolve(h.detail("task-a")); await h.flush()
  h.tick(); h.tick()
  assert.equal(h.requests.length, 2, "one in-flight read per task")
  await h.select("task-b")
  h.unmount()
  h.requests[2].response.resolve(h.detail("task-b")); await h.flush()
  assert.equal(h.timers.size, 0, "unmounted selection cannot start a timer")
})
