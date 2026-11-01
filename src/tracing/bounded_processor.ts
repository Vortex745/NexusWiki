import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base"

/**
 * LO-05: the only span buffer in the process.
 *
 * OTel's shipped `BatchSpanProcessor` drops silently when its queue fills and
 * exposes no counters, which would make "we lost spans" invisible. This
 * processor keeps the same shape (bounded queue, batch export, timer) but:
 *   - drops the NEWEST span when the queue is full and counts it,
 *   - never blocks the caller (`onEnd` is synchronous and allocation-light),
 *   - surfaces received/exported/dropped/exportErrors/lastError as diagnostics,
 *   - owns a single in-flight export so a slow backend cannot fan out,
 *   - bounds every export with a timeout, and bounds flush/shutdown budgets.
 *
 * Span content is already sampled and assembled by the caller; this layer
 * neither samples again nor rewrites payloads (LG-04-AC03, LG-04-AC06).
 */

export const DEFAULT_MAX_QUEUE_SIZE = 1024
export const DEFAULT_MAX_EXPORT_BATCH_SIZE = 128
export const DEFAULT_SCHEDULED_DELAY_MS = 2_000
export const DEFAULT_EXPORT_TIMEOUT_MS = 10_000
export const DEFAULT_FLUSH_TIMEOUT_MS = 5_000

export interface BoundedProcessorOptions {
  exporter: SpanExporter
  maxQueueSize?: number
  maxExportBatchSize?: number
  scheduledDelayMs?: number
  exportTimeoutMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export interface ProcessorSnapshot {
  received: number
  exported: number
  dropped: number
  exportErrors: number
  batches: number
  queued: number
  lastError?: string
  lastErrorAt?: number
}

export class BoundedBatchProcessor implements SpanProcessor {
  private readonly exporter: SpanExporter
  private readonly maxQueueSize: number
  private readonly maxExportBatchSize: number
  private readonly exportTimeoutMs: number
  private readonly timer: NodeJS.Timeout
  private queue: ReadableSpan[] = []
  private inFlight: ReadableSpan[] = []
  private activeExport: Promise<void> | undefined
  private closing = false
  private overBudget = false
  private counters = {
    received: 0,
    exported: 0,
    dropped: 0,
    exportErrors: 0,
    batches: 0,
    lastError: undefined as string | undefined,
    lastErrorAt: undefined as number | undefined,
  }

  constructor(options: BoundedProcessorOptions) {
    this.exporter = options.exporter
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this.maxExportBatchSize = options.maxExportBatchSize ?? DEFAULT_MAX_EXPORT_BATCH_SIZE
    const delay = options.scheduledDelayMs ?? DEFAULT_SCHEDULED_DELAY_MS
    this.exportTimeoutMs = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS
    this.timer = setInterval(() => {
      void this.drain()
    }, delay)
    this.timer.unref?.()
  }

  onStart(): void {
    // Start callbacks are not part of the buffer budget; nothing to do.
  }

  onEnd(span: ReadableSpan): void {
    this.counters.received += 1
    if (this.closing || this.queue.length >= this.maxQueueSize) {
      this.counters.dropped += 1
      return
    }
    this.queue.push(span)
    if (this.queue.length >= this.maxExportBatchSize) {
      void this.drain()
    }
  }

  /** Bounded flush with an explicit verdict (used by the tracing runtime). */
  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
    this.overBudget = false
    const budget = Math.max(0, timeoutMs)
    const deadline = Date.now() + budget
    // Race the whole drain, not just each batch: an exporter that hangs per
    // batch would otherwise keep the caller for (batches × exportTimeout).
    const outcome = await Promise.race([
      this.drain(deadline).then(() => "drained" as const),
      delay(budget).then(() => "deadline" as const),
    ])
    if (outcome === "deadline") this.overBudget = true
    // An unfinished batch is still not delivered, so flush must not claim
    // success just because the queue was spliced into the in-flight slot.
    return !this.overBudget && this.queue.length === 0 && this.inFlight.length === 0
  }

  /** Bounded close with an explicit verdict (used by the tracing runtime). */
  async close(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<{ closed: boolean; timedOut: boolean; alreadyClosed: boolean; droppedPending: number }> {
    const alreadyClosed = this.closing
    if (!this.closing) {
      this.closing = true
      clearInterval(this.timer)
    }
    const flushed = await this.flush(timeoutMs)
    // Anything still queued or in-flight when the budget ran out was not
    // delivered: count it as dropped so the loss is visible, not implied.
    const droppedPending = this.queue.length + this.inFlight.length
    if (droppedPending > 0) {
      this.counters.dropped += droppedPending
      this.queue.length = 0
      this.inFlight = []
    }
    if (!alreadyClosed) {
      try {
        await this.exporter.shutdown()
      } catch (error) {
        this.recordError(error)
      }
    }
    return { closed: true, timedOut: !flushed, alreadyClosed, droppedPending }
  }

  /** OTel `SpanProcessor` contract (no verdict, no budget argument). */
  async forceFlush(): Promise<void> {
    await this.flush()
  }

  /** OTel `SpanProcessor` contract (no verdict, no budget argument). */
  async shutdown(): Promise<void> {
    await this.close()
  }

  snapshot(): ProcessorSnapshot {
    return {
      ...this.counters,
      queued: this.queue.length,
    }
  }

  private drain(deadline?: number): Promise<void> {
    if (this.activeExport) return this.activeExport
    this.activeExport = this.runDrain(deadline).finally(() => {
      this.activeExport = undefined
    })
    return this.activeExport
  }

  private async runDrain(deadline?: number): Promise<void> {
    while (this.queue.length > 0) {
      const remaining = deadline === undefined ? undefined : deadline - Date.now()
      if (remaining !== undefined && remaining <= 0) {
        this.overBudget = true
        return
      }
      const batch = this.queue.splice(0, this.maxExportBatchSize)
      if (remaining === undefined) {
        await this.exportBatch(batch)
        continue
      }
      // A flush must respect ITS budget even when the exporter hangs; the
      // batch stays in flight so shutdown can still account for it.
      const outcome = await Promise.race([
        this.exportBatch(batch).then(() => "exported" as const),
        new Promise<"deadline">((resolve) => {
          const timer = setTimeout(() => resolve("deadline"), remaining)
          timer.unref?.()
        }),
      ])
      if (outcome === "deadline") {
        this.overBudget = true
        return
      }
    }
  }

  private exportBatch(batch: ReadableSpan[]): Promise<void> {
    this.inFlight = batch
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (ok: boolean, error?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.inFlight = []
        if (ok) {
          this.counters.exported += batch.length
          this.counters.batches += 1
        } else {
          this.counters.dropped += batch.length
          this.recordError(error ?? "export failed")
        }
        resolve()
      }
      const timer = setTimeout(() => {
        finish(false, new Error(`export timed out after ${this.exportTimeoutMs}ms`))
      }, this.exportTimeoutMs)
      timer.unref?.()
      try {
        this.exporter.export(batch, (result) => {
          if (result.code === ExportResultCode.SUCCESS) {
            finish(true)
            return
          }
          finish(false, result.error ?? "export returned a failure result")
        })
      } catch (error) {
        finish(false, error)
      }
    })
  }

  private recordError(error: unknown): void {
    this.counters.exportErrors += 1
    this.counters.lastError = error instanceof Error ? error.message : String(error)
    this.counters.lastErrorAt = Date.now()
  }
}
