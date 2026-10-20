/**
 * LO-05: the neutral tracing contract.
 *
 * Business code depends on THIS file only — never on `@opentelemetry/*`. That
 * is what keeps a vendor swap or a complete tracing shutdown a composition
 * concern instead of a refactor. The same contract carries:
 *   - ordinary business operations (`startOperation`),
 *   - nested steps (`OperationScope.startChild`),
 *   - model-shaped observations (LO-07+ pass `langfuse.observation.*`
 *     attributes through `attributes`, which is a string bag and nothing more),
 *   - the no-op implementation used when tracing is off or after shutdown.
 *
 * Deliberately absent: sampling decisions, queue depth, exporters, global
 * context. Those live behind the runtime so a business call site cannot depend
 * on them (LG-04-AC10).
 */

export type TracingAttributeValue = string | number | boolean

export type TracingAttributes = Record<string, TracingAttributeValue | undefined>

export type OperationOutcome = "ok" | "error"

export interface OperationEndOptions {
  outcome?: OperationOutcome
  /** Only meaningful for `outcome: "error"`; kept short (no stack traces). */
  message?: string
  attributes?: TracingAttributes
}

export interface OperationScope {
  /** Sampled trace id, or undefined when this operation is not traced. */
  readonly traceId: string | undefined
  /** Sampled span id of THIS operation (distinct from trace id, LG-05-AC03). */
  readonly spanId: string | undefined
  readonly sampled: boolean
  setAttributes(attributes: TracingAttributes): void
  /** Child step of this operation. Never starts a new root. */
  startChild(name: string, attributes?: TracingAttributes): OperationScope
  end(options?: OperationEndOptions): void
}

export interface TracingDiagnostics {
  readonly enabled: boolean
  readonly sampleRate: number
  /** Spans handed to the runtime (sampled only). */
  readonly received: number
  /** Spans the exporter accepted. */
  readonly exported: number
  /** Spans dropped because the queue was full or the runtime was closed. */
  readonly dropped: number
  readonly exportErrors: number
  readonly queued: number
  readonly lastError?: string
  readonly lastErrorAt?: number
  readonly state: "open" | "closing" | "closed"
  /** Configuration problems (invalid rate, missing credentials). */
  readonly warnings: readonly string[]
}

export interface ShutdownResult {
  closed: boolean
  timedOut: boolean
  /** True when shutdown was already requested — callers can stay idempotent. */
  alreadyClosed: boolean
  droppedPending: number
}

export interface TracingRuntime {
  readonly enabled: boolean
  /**
   * Start a root operation. Returns an unsampled no-op scope when tracing is
   * disabled, the roll dice says no, or the runtime is shutting down. Never
   * throws and never blocks on I/O.
   */
  startOperation(name: string, attributes?: TracingAttributes): OperationScope
  /** Run `fn` inside a root operation, ending it regardless of the result. */
  runOperation<T>(
    name: string,
    attributes: TracingAttributes | undefined,
    fn: (scope: OperationScope) => Promise<T>,
  ): Promise<T>
  /** True when everything queued so far left the process within the budget. */
  flush(timeoutMs?: number): Promise<boolean>
  shutdown(timeoutMs?: number): Promise<ShutdownResult>
  diagnostics(): TracingDiagnostics
}

const NOOP_SCOPE: OperationScope = {
  traceId: undefined,
  spanId: undefined,
  sampled: false,
  setAttributes: () => undefined,
  startChild: () => NOOP_SCOPE,
  end: () => undefined,
}

/**
 * Tracing off. Independent of every vendor package, so "disabled" is not a
 * degraded mode of the real runtime but a first-class implementation.
 */
export class NoopTracingRuntime implements TracingRuntime {
  readonly enabled = false

  startOperation(): OperationScope {
    return NOOP_SCOPE
  }

  async runOperation<T>(
    _name: string,
    _attributes: TracingAttributes | undefined,
    fn: (scope: OperationScope) => Promise<T>,
  ): Promise<T> {
    return fn(NOOP_SCOPE)
  }

  async flush(): Promise<boolean> {
    return true
  }

  async shutdown(): Promise<ShutdownResult> {
    return { closed: true, timedOut: false, alreadyClosed: true, droppedPending: 0 }
  }

  diagnostics(): TracingDiagnostics {
    return {
      enabled: false,
      sampleRate: 0,
      received: 0,
      exported: 0,
      dropped: 0,
      exportErrors: 0,
      queued: 0,
      state: "closed",
      warnings: [],
    }
  }
}

export function noopOperationScope(): OperationScope {
  return NOOP_SCOPE
}
