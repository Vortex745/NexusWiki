import { LogCounters } from "./logger"

/**
 * LO-03: bounded, backpressure-aware delivery of already-serialized lines.
 *
 * Why this exists: Node's `process.stdout` buffers in memory when the reader
 * is slow — writing without checking the boolean return value turns a slow
 * pipe into an unbounded buffer. This sink inspects `write()` and, when the
 * pipe is full, makes the producer wait for `drain` instead of queueing the
 * line itself. At most one line per pending `write()` call is in flight, so
 * the logger never owns an unbounded queue.
 *
 * The sink deliberately does NOT destroy `process.stdout` on close: stdout is
 * process-owned and shared. It only stops accepting new lines and waits (with
 * a budget) for the accepted ones to reach the pipe.
 */

/** The minimal destination surface the sink needs (stdout-compatible). */
export interface LogDestination {
  write(chunk: string): boolean
  once?(event: "drain", listener: () => void): unknown
  removeListener?(event: "drain", listener: () => void): unknown
  on?(event: "error", listener: (error: Error) => void): unknown
  readonly writableLength?: number
  readonly destroyed?: boolean
}

export interface LogSink {
  write(line: string): Promise<void>
  /** true when every accepted line reached the destination within the budget. */
  flush(timeoutMs?: number): Promise<boolean>
  close(timeoutMs?: number): Promise<void>
  readonly counters: LogCounters
  pendingWrites(): number
}

interface Waiter {
  resolve: () => void
  startedAt: number
}

export interface BackpressureSinkOptions {
  /**
   * Called once per sink lifetime when a write fails (EPIPE, destroyed
   * stream, thrown error). Must not log through the same sink — the default
   * writes a single line to stderr instead.
   */
  onFailure?: (error: unknown) => void
  closeTimeoutMs?: number
}

export class BackpressureSink implements LogSink {
  readonly counters: LogCounters
  private readonly destination: LogDestination
  private readonly options: BackpressureSinkOptions
  private readonly waiters = new Set<Waiter>()
  private drainHooked = false
  private failureReported = false
  private closed = false
  private closePromise: Promise<void> | undefined
  private drainedPromise: Promise<void> | undefined
  private drainedResolve: (() => void) | undefined

  constructor(destination: LogDestination, counters?: LogCounters, options?: BackpressureSinkOptions) {
    this.destination = destination
    this.counters = counters ?? new LogCounters()
    this.options = options ?? {}
    // An unhandled 'error' on stdout would crash the process; attach a
    // reporting listener so a broken pipe degrades to a diagnostics counter.
    this.destination.on?.("error", (error: Error) => this.recordFailure(error))
  }

  pendingWrites(): number {
    return this.waiters.size
  }

  write(line: string): Promise<void> {
    if (this.closed) {
      this.counters.skippedAfterClose += 1
      return Promise.resolve()
    }
    if (this.destination.destroyed) {
      this.recordFailure(new Error("log destination destroyed"))
      return Promise.resolve()
    }
    let accepted: boolean
    try {
      accepted = this.destination.write(line)
    } catch (error) {
      this.recordFailure(error)
      return Promise.resolve()
    }
    this.counters.written += 1
    if (accepted) return Promise.resolve()
    // The pipe is full: hand the wait to the producer, not to a buffer.
    return new Promise<void>((resolve) => {
      this.waiters.add({ resolve, startedAt: Date.now() })
      this.counters.waits += 1
      this.counters.pendingWrites = this.waiters.size
      this.hookDrain()
    })
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    if (this.waiters.size === 0) return true
    const drained = this.drainedPromise ?? this.createDrainedPromise()
    return Promise.race([
      drained.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs)
        if (typeof timer.unref === "function") timer.unref()
      }),
    ])
  }

  close(timeoutMs = this.options.closeTimeoutMs ?? 2000): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.doClose(timeoutMs)
    return this.closePromise
  }

  private async doClose(timeoutMs: number): Promise<void> {
    const flushed = await this.flush(timeoutMs)
    if (!flushed) {
      this.counters.closeTimedOut = true
      this.recordFailure(
        new Error(`log close budget exhausted after ${timeoutMs}ms with ${this.waiters.size} pending write(s)`),
      )
    }
    this.closed = true
    this.counters.closed = true
    // Release any waiter that outlived the budget so callers do not hang.
    for (const waiter of [...this.waiters]) {
      this.release(waiter)
    }
  }

  private hookDrain(): void {
    if (this.drainHooked || typeof this.destination.once !== "function") return
    this.drainHooked = true
    this.destination.once("drain", () => {
      this.drainHooked = false
      for (const waiter of [...this.waiters]) {
        this.release(waiter)
      }
    })
  }

  private release(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) return
    const waited = Date.now() - waiter.startedAt
    this.counters.totalWaitMs += waited
    this.counters.maxWaitMs = Math.max(this.counters.maxWaitMs, waited)
    this.counters.pendingWrites = this.waiters.size
    waiter.resolve()
    if (this.waiters.size === 0 && this.drainedResolve) {
      const resolve = this.drainedResolve
      this.drainedResolve = undefined
      this.drainedPromise = undefined
      resolve()
    }
  }

  private createDrainedPromise(): Promise<void> {
    this.drainedPromise = new Promise<void>((resolve) => {
      this.drainedResolve = resolve
    })
    return this.drainedPromise
  }

  private recordFailure(error: unknown): void {
    this.counters.writeErrors += 1
    if (this.failureReported) return
    this.failureReported = true
    if (this.options.onFailure) {
      try {
        this.options.onFailure(error)
        return
      } catch {
        // A failing failure-report is still a failure — fall through to stderr.
      }
    }
    try {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[logging] stdout delivery failed: ${message}; further failures are counted only\n`)
    } catch {
      // stderr is unavailable too: counters are the only remaining evidence.
    }
  }
}

/**
 * The production sink: `process.stdout` with real backpressure.
 *
 * A slow reader (container log driver, redirected file, IDE terminal) makes
 * `write()` return false; producers then await `drain`. A permanent failure
 * (EPIPE / destroyed stream) is counted and reported once — never re-entered
 * through the logger itself.
 */
export function createStdoutSink(options?: BackpressureSinkOptions): LogSink {
  return new BackpressureSink(process.stdout as unknown as LogDestination, undefined, options)
}
