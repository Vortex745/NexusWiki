import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { LogCounters } from "./logger"
import { BackpressureSink, type LogDestination } from "./sink"

/**
 * LO-03-AC03/AC04: a controlled slow pipe.
 *
 * `write()` returns false exactly like a full OS pipe; the sink must make the
 * producer wait for `drain` instead of queueing the line in memory. The test
 * grants capacity explicitly, so "slow" is deterministic rather than timing
 * dependent.
 */
class ControlledDestination extends EventEmitter implements LogDestination {
  readonly lines: string[] = []
  destroyed = false
  failures = 0
  private credit: number

  constructor(credit = 0) {
    super()
    this.credit = credit
  }

  write(chunk: string): boolean {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error("EPIPE: broken pipe")
    }
    if (this.destroyed) throw new Error("stream destroyed")
    this.lines.push(chunk)
    if (this.credit > 0) {
      this.credit -= 1
      return true
    }
    return false
  }

  drain(): void {
    this.emit("drain")
  }

  grant(credits = 1): void {
    this.credit += credits
  }
}

test("LO-03-AC03: a full pipe makes the producer wait for drain — the line is delivered once", async () => {
  const destination = new ControlledDestination(1)
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)

  assert.equal(await sink.write("first\n"), undefined)
  assert.equal(counters.waits, 0)

  const startedAt = Date.now()
  const pending = sink.write("second\n")
  assert.equal(sink.pendingWrites(), 1, "the pending line is held by the caller, not buffered by the sink")
  assert.equal(counters.pendingWrites, 1)
  setTimeout(() => destination.drain(), 40)
  await pending

  const waited = Date.now() - startedAt
  assert.ok(waited >= 20, `producer must have waited for drain, waited ${waited}ms`)
  assert.equal(counters.waits, 1)
  assert.ok(counters.totalWaitMs >= 20)
  assert.deepEqual(destination.lines, ["first\n", "second\n"], "no drop and no reordering")
  assert.equal(sink.pendingWrites(), 0)
})

test("LO-03-AC03: recoverable slow consumption loses nothing across many records", async () => {
  const destination = new ControlledDestination(1)
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)

  for (let index = 0; index < 12; index += 1) {
    const pending = sink.write(`line-${index}\n`)
    assert.ok(sink.pendingWrites() <= 1, "never more than one line waits per producer")
    if (sink.pendingWrites() === 1) {
      destination.grant(1)
      setTimeout(() => destination.drain(), 1)
    }
    await pending
  }

  assert.equal(counters.written, 12)
  assert.equal(counters.writeErrors, 0)
  assert.equal(destination.lines.length, 12)
  assert.deepEqual(
    destination.lines.map((line) => line.trim()),
    Array.from({ length: 12 }, (_, index) => `line-${index}`),
  )
})

test("LO-03-AC05: write failures are counted, reported once, and never thrown at the caller", async () => {
  const destination = new ControlledDestination(1)
  const failures: unknown[] = []
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters, {
    onFailure: (error) => failures.push(error),
  })

  destination.failures = 3
  await sink.write("one\n")
  await sink.write("two\n")
  await sink.write("three\n")

  assert.equal(counters.writeErrors, 3)
  assert.equal(failures.length, 1, "one independent report, no storm and no recursion")
  assert.match(String((failures[0] as Error).message), /EPIPE/)

  destination.destroyed = true
  await sink.write("after-destroy\n")
  assert.equal(counters.writeErrors, 4)
  assert.equal(failures.length, 1)
})

test("LO-03-AC09: close flushes, is idempotent, and refuses later records", async () => {
  const destination = new ControlledDestination(4)
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)

  await sink.write("accepted\n")
  const first = sink.close(200)
  const second = sink.close(200)
  assert.equal(first, second, "repeated close returns the same promise")
  await first

  assert.equal(counters.closed, true)
  await sink.write("late\n")
  assert.equal(counters.skippedAfterClose, 1)
  assert.deepEqual(destination.lines, ["accepted\n"])
})

test("LO-03-AC09: a pipe that never drains exhausts the close budget visibly", async () => {
  const destination = new ControlledDestination(0)
  const counters = new LogCounters()
  const failures: unknown[] = []
  const sink = new BackpressureSink(destination, counters, { onFailure: (error) => failures.push(error) })

  const pending = sink.write("stuck\n")
  const startedAt = Date.now()
  await sink.close(60)
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed >= 40 && elapsed < 2000, `close must respect its budget, took ${elapsed}ms`)
  assert.equal(counters.closeTimedOut, true)
  assert.equal(counters.closed, true)
  assert.equal(sink.pendingWrites(), 0, "waiters are released so shutdown does not hang")
  assert.equal(failures.length, 1)
  await pending
})

test("LO-03-AC09: flush reports whether the accepted records reached the pipe", async () => {
  const destination = new ControlledDestination(0)
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)

  assert.equal(await sink.flush(10), true, "idle sink flushes immediately")

  const pending = sink.write("queued\n")
  assert.equal(await sink.flush(20), false, "a stuck pipe is reported, not hidden")
  destination.grant(1)
  destination.drain()
  await pending
  assert.equal(await sink.flush(20), true)
})
