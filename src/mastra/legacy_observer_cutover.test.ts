import assert from "node:assert/strict"
import test from "node:test"
import { NoopLangfuseExporter, type LangfuseExporter } from "../answer/langfuse_exporter"
import { shouldAttachLangfuseObserver } from "./shared_answer_entry"

/**
 * LO-06 (LG-05-AC10): when OTel takes over the Answer run through the HTTP
 * root, the legacy Langfuse observer must not publish a second trace or a
 * synthetic Generation for the same execution. The cutover is decided in ONE
 * place, so the answer entry keeps exactly one egress owner.
 *
 * SQLite consumption is not part of this decision: the hard traceObserver is
 * always attached, and this flag only governs the soft Langfuse observer.
 */

const realLike = {
  export: async () => undefined,
  close: async () => undefined,
} as unknown as LangfuseExporter

test("LO-06-AC10: the legacy observer attaches only when OTel has not taken over", () => {
  assert.equal(shouldAttachLangfuseObserver(undefined, realLike), true, "default keeps today's behaviour")
  assert.equal(shouldAttachLangfuseObserver(true, realLike), true)
  assert.equal(shouldAttachLangfuseObserver(false, realLike), false, "OTel owns the run → no second trace")
})

test("LO-06-AC10: a no-op exporter never attaches, whatever the flag says", () => {
  const noop = new NoopLangfuseExporter()
  assert.equal(shouldAttachLangfuseObserver(undefined, noop), false)
  assert.equal(shouldAttachLangfuseObserver(true, noop), false)
})
