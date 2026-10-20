import { SpanKind, SpanStatusCode, context, trace, type Span, type Tracer } from "@opentelemetry/api"
import type { SpanExporter } from "@opentelemetry/sdk-trace-base"
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import {
  BoundedBatchProcessor,
  DEFAULT_FLUSH_TIMEOUT_MS,
  type BoundedProcessorOptions,
} from "./bounded_processor"
import {
  noopOperationScope,
  type ModelCallInput,
  type ModelCallOutcome,
  type ModelCallScope,
  type ModelUsage,
  type OperationEndOptions,
  type OperationScope,
  type ShutdownResult,
  type TracingAttributes,
  type TracingDiagnostics,
  type TracingRuntime,
} from "./contract"
import { scrubModelContent, scrubText } from "./content_policy"

/**
 * LO-05: the real runtime. This file and `bounded_processor.ts` are the only
 * places allowed to touch `@opentelemetry/*`; everything else speaks the
 * neutral contract.
 *
 * Sampling happens exactly once, at the root span, through
 * `ParentBasedSampler(TraceIdRatioBasedSampler(rate))`: a child inherits the
 * parent's decision and the exporter never samples again (LG-04-AC03).
 * Payload limits are enforced here, before the span is buffered, so neither
 * the queue nor the backend sees an unbounded attribute (LG-04-AC06).
 */

export const DEFAULT_MAX_ATTRIBUTE_BYTES = 2_048
/** Generation content is not a log line: the 8 KiB runtime-log rule does not apply. */
export const DEFAULT_MAX_CONTENT_BYTES = 1_048_576

const CONTENT_ATTRIBUTE_KEYS = new Set([
  "langfuse.observation.input",
  "langfuse.observation.output",
  "langfuse.trace.input",
  "langfuse.trace.output",
  "langfuse.observation.model.parameters",
  "langfuse.observation.usage_details",
  "langfuse.observation.cost_details",
])

const TRUNCATION_SUFFIX = "…[truncated]"

function truncateUtf8(value: string, limitBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes <= limitBytes) return { text: value, truncated: false }
  const budget = Math.max(0, limitBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8"))
  let text = value
  while (Buffer.byteLength(text, "utf8") > budget) {
    // Cut proportionally so multi-byte text converges in a couple of passes.
    const ratio = budget / Buffer.byteLength(text, "utf8")
    text = text.slice(0, Math.max(0, Math.floor(text.length * ratio) - 1))
  }
  return { text: text + TRUNCATION_SUFFIX, truncated: true }
}

function sanitiseAttributes(
  attributes: TracingAttributes,
  limitBytes: number,
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue
      sanitized[key] = value
      continue
    }
    if (typeof value === "boolean") {
      sanitized[key] = value
      continue
    }
    sanitized[key] = truncateUtf8(value, limitBytes).text
  }
  return sanitized
}

export interface OtelRuntimeOptions {
  sampleRate: number
  exporter: SpanExporter
  serviceName?: string
  maxAttributeBytes?: number
  maxContentBytes?: number
  processor?: Pick<BoundedProcessorOptions, "maxQueueSize" | "maxExportBatchSize" | "scheduledDelayMs" | "exportTimeoutMs">
  warnings?: readonly string[]
}

class OtelOperationScope implements OperationScope {
  private ended = false
  private readonly childContext: ReturnType<typeof trace.setSpan>

  constructor(
    private readonly tracer: Tracer,
    private readonly span: Span,
    parentContext: ReturnType<typeof context.active>,
    private readonly limits: { attributeBytes: number; contentBytes: number },
    private readonly onTruncate: () => void,
  ) {
    this.childContext = trace.setSpan(parentContext, span)
  }

  get traceId(): string | undefined {
    if (!this.sampled) return undefined
    const traceId = this.span.spanContext().traceId
    return traceId.length > 0 ? traceId : undefined
  }

  get spanId(): string | undefined {
    if (!this.sampled) return undefined
    const spanId = this.span.spanContext().spanId
    return spanId.length > 0 ? spanId : undefined
  }

  get sampled(): boolean {
    return (this.span.spanContext().traceFlags & 0x1) === 0x1
  }

  setAttributes(attributes: TracingAttributes): void {
    if (this.ended) return
    this.span.setAttributes(this.sanitize(attributes))
  }

  startChild(name: string, attributes?: TracingAttributes): OperationScope {
    if (this.ended) return noopOperationScope()
    const span = this.tracer.startSpan(
      name,
      { kind: SpanKind.INTERNAL, attributes: attributes ? this.sanitize(attributes) : undefined },
      this.childContext,
    )
    return new OtelOperationScope(this.tracer, span, this.childContext, this.limits, this.onTruncate)
  }

  runInContext<T>(fn: () => T): T {
    if (this.ended) return fn()
    return context.with(this.childContext, fn)
  }

  end(options: OperationEndOptions = {}): void {
    if (this.ended) return
    this.ended = true
    if (options.attributes) {
      this.span.setAttributes(this.sanitize(options.attributes))
    }
    if (options.outcome === "error") {
      this.span.setStatus({ code: SpanStatusCode.ERROR, ...(options.message ? { message: options.message } : {}) })
    } else if (options.outcome === "ok") {
      this.span.setStatus({ code: SpanStatusCode.OK })
    }
    this.span.end()
  }

  private sanitize(attributes: TracingAttributes): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined) continue
      if (typeof value === "number") {
        if (!Number.isFinite(value)) continue
        sanitized[key] = value
        continue
      }
      if (typeof value === "boolean") {
        sanitized[key] = value
        continue
      }
      const limit = CONTENT_ATTRIBUTE_KEYS.has(key) ? this.limits.contentBytes : this.limits.attributeBytes
      const { text, truncated } = truncateUtf8(value, limit)
      if (truncated) this.onTruncate()
      sanitized[key] = text
    }
    return sanitized
  }
}

/**
 * LO-07/LO-08: one provider call → one Generation span.
 *
 * The span is created as a child of whatever operation is active (the HTTP
 * root or the Answer run), so a sampled request keeps its model calls inside
 * the same trace. `end` is idempotent: a streaming cancellation racing a
 * terminal chunk records exactly one outcome.
 */
class OtelModelCallScope implements ModelCallScope {
  private ended = false
  private output: unknown
  private usage: ModelUsage | undefined

  constructor(
    private readonly span: Span,
    private readonly limits: { attributeBytes: number; contentBytes: number },
    private readonly onTruncate: () => void,
  ) {}

  get sampled(): boolean {
    return (this.span.spanContext().traceFlags & 0x1) === 0x1
  }

  get traceId(): string | undefined {
    if (!this.sampled) return undefined
    const traceId = this.span.spanContext().traceId
    return traceId.length > 0 ? traceId : undefined
  }

  setOutput(output: unknown): void {
    if (this.ended) return
    this.output = output
  }

  setUsage(usage: ModelUsage): void {
    if (this.ended) return
    this.usage = usage
  }

  setAttributes(attributes: TracingAttributes): void {
    if (this.ended) return
    this.span.setAttributes(sanitiseAttributes(attributes, this.limits.attributeBytes))
  }

  end(outcome: ModelCallOutcome): void {
    if (this.ended) return
    this.ended = true
    const output = outcome.output !== undefined ? outcome.output : this.output
    if (output !== undefined) {
      this.span.setAttribute(
        "langfuse.observation.output",
        this.clip("langfuse.observation.output", scrubModelContent(output)),
      )
    }
    if (outcome.reasoning) {
      this.span.setAttribute("langfuse.observation.reasoning", this.clip("langfuse.observation.output", outcome.reasoning))
    }
    if (outcome.toolCalls !== undefined) {
      this.span.setAttribute("langfuse.observation.tool_calls", this.clip("langfuse.observation.output", scrubModelContent(outcome.toolCalls)))
    }
    const usage = outcome.usage ?? this.usage
    if (usage) {
      // Only provider-reported numbers reach this point; never a character or
      // delta estimate (LG-07-AC08 / LG-08-AC03).
      const usageDetails: Record<string, number> = {}
      if (usage.promptTokens !== undefined) usageDetails["input"] = usage.promptTokens
      if (usage.completionTokens !== undefined) usageDetails["output"] = usage.completionTokens
      if (usage.totalTokens !== undefined) usageDetails["total"] = usage.totalTokens
      this.span.setAttribute("langfuse.observation.usage_details", JSON.stringify(usageDetails))
      if (usage.promptTokens !== undefined) this.span.setAttribute("gen_ai.usage.input_tokens", usage.promptTokens)
      if (usage.completionTokens !== undefined) this.span.setAttribute("gen_ai.usage.output_tokens", usage.completionTokens)
    }
    if (outcome.status === "ok") {
      this.span.setStatus({ code: SpanStatusCode.OK })
    } else {
      this.span.setAttribute("langfuse.observation.level", outcome.status === "error" ? "ERROR" : "WARNING")
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        // Short, and scrubbed: an error message can echo SQL parameters or a
        // key that leaked into the driver error (LG-07-AC06).
        ...(outcome.message ? { message: scrubText(outcome.message).slice(0, 200) } : {}),
      })
    }
    this.span.end()
  }

  private clip(key: string, text: string): string {
    const { text: clipped, truncated } = truncateUtf8(text, this.limits.contentBytes)
    if (truncated) this.onTruncate()
    void key
    return clipped
  }
}

export class OtelTracingRuntime implements TracingRuntime {
  readonly enabled = true
  private readonly processor: BoundedBatchProcessor
  private readonly tracer: Tracer
  private readonly attributeBytes: number
  private readonly contentBytes: number
  private readonly sampleRate: number
  private readonly warnings: string[]
  private closing = false
  private closed = false
  private truncatedAttributes = 0

  constructor(options: OtelRuntimeOptions) {
    this.attributeBytes = options.maxAttributeBytes ?? DEFAULT_MAX_ATTRIBUTE_BYTES
    this.contentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
    this.sampleRate = options.sampleRate
    this.warnings = [...(options.warnings ?? [])]
    this.processor = new BoundedBatchProcessor({ exporter: options.exporter, ...options.processor })
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": options.serviceName ?? "kefu-rag",
        "deployment.environment": process.env.NODE_ENV ?? "development",
      }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRate) }),
      spanProcessors: [this.processor],
    })
    // Deliberately NOT registered globally: the runtime hands its own contexts
    // to children, so nothing else in the process can pick up a stray span.
    this.tracer = provider.getTracer("kefu-rag", "1.0.0")
  }

  startOperation(name: string, attributes?: TracingAttributes): OperationScope {
    if (this.closing) return noopOperationScope()
    const span = this.tracer.startSpan(
      name,
      { root: true, kind: SpanKind.INTERNAL },
      context.active(),
    )
    const scope = new OtelOperationScope(
      this.tracer,
      span,
      context.active(),
      { attributeBytes: this.attributeBytes, contentBytes: this.contentBytes },
      () => {
        this.truncatedAttributes += 1
      },
    )
    if (attributes) scope.setAttributes(attributes)
    return scope
  }

  async runOperation<T>(
    name: string,
    attributes: TracingAttributes | undefined,
    fn: (scope: OperationScope) => Promise<T>,
  ): Promise<T> {
    const scope = this.startOperation(name, attributes)
    try {
      const result = await scope.runInContext(() => fn(scope))
      scope.end({ outcome: "ok" })
      return result
    } catch (error) {
      scope.end({ outcome: "error", message: error instanceof Error ? error.message.slice(0, 200) : "error" })
      throw error
    }
  }

  observeModel(input: ModelCallInput): ModelCallScope | undefined {
    if (this.closing) return undefined
    const parent = context.active()
    const span = this.tracer.startSpan(
      input.name,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "langfuse.observation.type": "generation",
          "langfuse.observation.model.name": input.model,
          "gen_ai.request.model": input.model,
          "gen_ai.system": input.provider ?? "openai",
          "gen_ai.request.stream": input.stream,
          "langfuse.observation.input": truncateUtf8(
            scrubModelContent(input.input),
            this.contentBytes,
          ).text,
          ...(input.attributes ? sanitiseAttributes(input.attributes, this.attributeBytes) : {}),
        },
      },
      parent,
    )
    // Not sampled → the span is non-recording; skip the bookkeeping entirely.
    if ((span.spanContext().traceFlags & 0x1) !== 0x1) {
      span.end()
      return undefined
    }
    return new OtelModelCallScope(span, { attributeBytes: this.attributeBytes, contentBytes: this.contentBytes }, () => {
      this.truncatedAttributes += 1
    })
  }

  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
    return this.processor.flush(timeoutMs)
  }

  async shutdown(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<ShutdownResult> {
    const alreadyClosed = this.closing
    this.closing = true
    const result = await this.processor.close(timeoutMs)
    this.closed = true
    return {
      closed: result.closed,
      timedOut: result.timedOut,
      alreadyClosed,
      droppedPending: result.droppedPending,
    }
  }

  diagnostics(): TracingDiagnostics {
    const snapshot = this.processor.snapshot()
    return {
      enabled: !this.closed,
      sampleRate: this.sampleRate,
      received: snapshot.received,
      exported: snapshot.exported,
      dropped: snapshot.dropped,
      exportErrors: snapshot.exportErrors,
      queued: snapshot.queued,
      ...(snapshot.lastError !== undefined ? { lastError: snapshot.lastError } : {}),
      ...(snapshot.lastErrorAt !== undefined ? { lastErrorAt: snapshot.lastErrorAt } : {}),
      state: this.closed ? "closed" : this.closing ? "closing" : "open",
      warnings: [
        ...this.warnings,
        ...(this.truncatedAttributes > 0 ? [`truncated_attributes=${this.truncatedAttributes}`] : []),
      ],
    }
  }

}
