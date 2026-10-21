import { EventEmitter } from "node:events"
import { promises as fs } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { LogCounters } from "./logger"
import type { LogDestination } from "./sink"
import { formatLocalDateKey } from "./weknora_text"

/**
 * LF-02: the file destination behind the text logger.
 *
 * One destination owns one stream family (`system` or `agent`) in one
 * directory. It rotates by local calendar day, keeps the last seven days and
 * refuses to let any filesystem problem reach the caller: the first failure is
 * reported once on stderr, later ones are counted, and the next write retries
 * the open. Lines are queued and appended one at a time, so concurrent writers
 * can never interleave two records.
 *
 * `write()` returns false while a line is pending, exactly like a full pipe,
 * so the existing backpressure sink waits for `drain` instead of buffering
 * without bound.
 */

export const DEFAULT_LOG_DIR = "logs"
export const DEFAULT_RETENTION_DAYS = 7

/**
 * `LOG_DIR`: blank, missing or containing a NUL byte falls back to `logs`
 * (relative to the cwd); a NUL can never name a real directory.
 */
export function resolveLogDir(raw: string | undefined, fallback = DEFAULT_LOG_DIR): string {
  const value = (raw ?? "").trim()
  return value.length > 0 && !value.includes("\0") ? value : fallback
}

export interface RotatingFileDestinationOptions {
  /** Directory that receives `PREFIX-YYYY-MM-DD.log`. */
  dir: string
  /** Stream family: `system` or `agent`. Other prefixes are never cleaned. */
  prefix: string
  /** Keep today plus the previous N-1 days (default 7). */
  retentionDays?: number
  /** Test seam: wall clock used for rotation, naming and cleanup. */
  now?: () => Date
  counters?: LogCounters
  /** First-failure reporter (tests); the default writes one line to stderr. */
  onFailure?: (error: unknown) => void
}

const ROTATED_FILE = /^(.+)-(\d{4}-\d{2}-\d{2})\.log$/

export class RotatingFileDestination extends EventEmitter implements LogDestination {
  readonly counters: LogCounters
  readonly dir: string
  readonly prefix: string
  private readonly retentionDays: number
  private readonly clock: () => Date
  private readonly onFailure: ((error: unknown) => void) | undefined
  private readonly queue: string[] = []
  private readonly idleResolvers: Array<() => void> = []
  private handle: FileHandle | undefined
  private openDate: string | undefined
  private draining = false
  private failureReported = false
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(options: RotatingFileDestinationOptions) {
    super()
    this.dir = resolveLogDir(options.dir)
    this.prefix = options.prefix
    this.retentionDays = Math.max(1, Math.floor(options.retentionDays ?? DEFAULT_RETENTION_DAYS))
    this.clock = options.now ?? (() => new Date())
    this.counters = options.counters ?? new LogCounters()
    this.onFailure = options.onFailure
  }

  /** Queue a complete line. `false` means "wait for drain" (line not on disk yet). */
  write(chunk: string): boolean {
    if (this.closed) {
      this.counters.skippedAfterClose += 1
      return true
    }
    this.queue.push(chunk)
    void this.drain()
    return false
  }

  /** Resolves once every accepted line has been appended. */
  async flush(): Promise<void> {
    if (this.queue.length === 0 && !this.draining) return
    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  /** Flush, then close the open handle. Idempotent; later writes are refused. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      await this.flush()
      await this.resetHandle()
    })()
    return this.closePromise
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const line = this.queue.shift()
        if (line === undefined) break
        await this.append(line)
      }
    } finally {
      this.draining = false
      if (this.queue.length > 0) {
        void this.drain()
        return
      }
      this.emit("drain")
      const resolvers = this.idleResolvers.splice(0)
      for (const resolve of resolvers) resolve()
    }
  }

  private async append(line: string): Promise<void> {
    try {
      const now = this.clock()
      const dateKey = formatLocalDateKey(now)
      if (!this.handle || this.openDate !== dateKey) {
        await this.openFor(dateKey, now)
      }
      const handle = this.handle
      if (!handle) throw new Error("file log destination is not open")
      await handle.write(line, null, "utf8")
    } catch (error) {
      // Drop this line, count it, and let the next write retry the open.
      await this.resetHandle()
      this.recordFailure(error)
    }
  }

  private async openFor(dateKey: string, now: Date): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const next = await fs.open(this.filePath(dateKey), "a")
    const previous = this.handle
    this.handle = next
    this.openDate = dateKey
    if (previous) {
      await previous.close().catch(() => undefined)
    }
    await this.cleanup(now)
  }

  private filePath(dateKey: string): string {
    return path.join(this.dir, `${this.prefix}-${dateKey}.log`)
  }

  /**
   * Delete only this destination's own files older than the retention window.
   * A cleanup failure is counted, never propagated into the write path.
   */
  private async cleanup(now: Date): Promise<void> {
    const cutoff = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - (this.retentionDays - 1),
    )
    const cutoffKey = formatLocalDateKey(cutoff)
    let entries
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true })
    } catch (error) {
      this.recordFailure(error)
      return
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = ROTATED_FILE.exec(entry.name)
      if (!match) continue
      if (match[1] !== this.prefix) continue
      if (match[2] >= cutoffKey) continue
      try {
        await fs.unlink(path.join(this.dir, entry.name))
      } catch (error) {
        this.recordFailure(error)
      }
    }
  }

  private async resetHandle(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    this.openDate = undefined
    if (!handle) return
    try {
      await handle.close()
    } catch (error) {
      this.recordFailure(error)
    }
  }

  private recordFailure(error: unknown): void {
    this.counters.writeErrors += 1
    if (this.failureReported) return
    this.failureReported = true
    if (this.onFailure) {
      try {
        this.onFailure(error)
        return
      } catch {
        // Fall through to stderr: the reporter itself failed.
      }
    }
    try {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[logging] file log delivery failed: ${message}; further failures are counted only\n`,
      )
    } catch {
      // stderr unavailable: the counters are the only remaining evidence.
    }
  }
}
