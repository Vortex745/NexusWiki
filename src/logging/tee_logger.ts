import type { Logger, LoggerDiagnostics, LogFields, LogLevel, LogLevelSetting } from "./logger"

/**
 * LF-03: one neutral Logger, two independent deliveries.
 *
 * The process logger uses this to send the same record to stdout (JSON) and to
 * the system file (WeKnora text). Each branch owns its own encoder, sink and
 * counters, so a failure in one is contained: `Promise.allSettled` makes sure
 * the other branch still writes and the caller never sees a branch error.
 *
 * `child()` fans out, so both branches keep the correlation fields bound at
 * the call site. `close()` and `flush()` reach every branch, and the merged
 * diagnostics add the two paths together.
 */
export class TeeLogger implements Logger {
  readonly level: LogLevelSetting
  private readonly branches: readonly Logger[]
  private closePromise: Promise<void> | undefined

  constructor(branches: readonly Logger[]) {
    if (branches.length === 0) throw new Error("TeeLogger needs at least one branch")
    this.branches = [...branches]
    this.level = branches[0].level
  }

  debug(event: string, fields?: LogFields): Promise<void> {
    return this.emit("debug", event, fields)
  }

  info(event: string, fields?: LogFields): Promise<void> {
    return this.emit("info", event, fields)
  }

  warn(event: string, fields?: LogFields): Promise<void> {
    return this.emit("warn", event, fields)
  }

  error(event: string, fields?: LogFields): Promise<void> {
    return this.emit("error", event, fields)
  }

  child(bindings: LogFields): Logger {
    return new TeeLogger(this.branches.map((branch) => branch.child(bindings)))
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.branches.map(async (branch) => branch.flush()))
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = Promise.allSettled(
        this.branches.map(async (branch) => branch.close()),
      ).then(() => undefined)
    }
    return this.closePromise
  }

  diagnostics(): LoggerDiagnostics {
    const snapshots = this.branches.map((branch) => branch.diagnostics())
    return {
      level: this.level,
      written: sum(snapshots, (snapshot) => snapshot.written),
      writeErrors: sum(snapshots, (snapshot) => snapshot.writeErrors),
      truncated: sum(snapshots, (snapshot) => snapshot.truncated),
      redacted: sum(snapshots, (snapshot) => snapshot.redacted),
      waits: sum(snapshots, (snapshot) => snapshot.waits),
      totalWaitMs: sum(snapshots, (snapshot) => snapshot.totalWaitMs),
      maxWaitMs: Math.max(...snapshots.map((snapshot) => snapshot.maxWaitMs)),
      // Every branch holds its own pending records; the sum is the real total.
      pendingWrites: sum(snapshots, (snapshot) => snapshot.pendingWrites),
      skippedAfterClose: sum(snapshots, (snapshot) => snapshot.skippedAfterClose),
      closeTimedOut: snapshots.some((snapshot) => snapshot.closeTimedOut),
      closed: snapshots.every((snapshot) => snapshot.closed),
    }
  }

  private async emit(level: LogLevel, event: string, fields?: LogFields): Promise<void> {
    // Calling inside the async closure turns a synchronous throw from a branch
    // into a rejection, so the other branch is always invoked.
    await Promise.allSettled(this.branches.map(async (branch) => branch[level](event, fields)))
  }
}

function sum(
  snapshots: readonly LoggerDiagnostics[],
  pick: (snapshot: LoggerDiagnostics) => number,
): number {
  return snapshots.reduce((total, snapshot) => total + pick(snapshot), 0)
}
