import assert from "node:assert/strict"
import test from "node:test"
import { performance } from "node:perf_hooks"
import { setImmediate, setTimeout as delay } from "node:timers/promises"
import type { DecisionProviderResult } from "../types/agent"
import { classifyClefError, clefErrorCode } from "../clef/protocol_errors"
import { executeDecisionCall } from "./decision_call"
import {
  RunBudgetAccountingError,
  RunBudgetExceededError,
  createModelCostEstimator,
  createRunContext,
  getRunResourceBudgetSnapshot,
  runWithRunContext,
} from "./run_context"

const modelId = "@cf/cloudflare/clef"

test("decision call settles zero-output usage and exact-model cost before returning payload", async () => {
  const ctx = createRunContext({
    resourceBudget: {
      limits: { maxModelCalls: 1, maxTokens: 4, maxCostMicros: 2 },
      estimateCostMicros: createModelCostEstimator({
        [modelId]: {
          inputCostMicrosPerMillionTokens: 500_000,
          outputCostMicrosPerMillionTokens: 900_000,
        },
      }),
    },
  })
  const expected = {
    payload: { answers: [] },
    usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
  }

  const result = await runWithRunContext(ctx, () => executeDecisionCall(
    modelId,
    async () => expected,
    { timeoutMs: 1_000 }
  ))

  assert.equal(result, expected)
  assert.deepEqual(getRunResourceBudgetSnapshot(ctx), {
    modelCalls: 1,
    promptTokens: 4,
    completionTokens: 0,
    totalTokens: 4,
    costMicros: 2,
    limits: { maxModelCalls: 1, maxTokens: 4, maxCostMicros: 2 },
  })
})

test("pre-aborted caller starts no provider call or reservation", async () => {
  const controller = new AbortController()
  controller.abort("private caller reason")
  const ctx = createRunContext()
  let calls = 0

  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(
    modelId,
    async () => {
      calls += 1
      return { payload: {} }
    },
    { signal: controller.signal, timeoutMs: 1_000 }
  )), { name: "AbortError", message: "decision call aborted" })

  assert.equal(calls, 0)
  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 0)
})

test("pre-aborted run starts no provider call or reservation", async () => {
  const ctx = createRunContext()
  ctx.controller.abort()
  let calls = 0

  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(
    modelId,
    async () => {
      calls += 1
      return { payload: {} }
    },
    { timeoutMs: 1_000 }
  )), { name: "AbortError" })

  assert.equal(calls, 0)
  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 0)
})

test("expired run starts no provider call and propagates cancellation", async () => {
  const ctx = createRunContext({ deadline: Date.now() - 1 })
  let calls = 0

  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(
    modelId,
    async () => {
      calls += 1
      return { payload: {} }
    },
    { timeoutMs: 1_000 }
  )), { name: "AbortError", message: "run deadline exceeded" })

  assert.equal(calls, 0)
  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 0)
  assert.equal(ctx.signal.aborted, true)
})

test("per-call timeout aborts provider work without cancelling the run", { timeout: 1_000 }, async () => {
  const ctx = createRunContext()
  let providerSignal: AbortSignal | undefined
  const result = runWithRunContext(ctx, () => executeDecisionCall(
    modelId,
    async (signal) => {
      providerSignal = signal
      return await new Promise<never>(() => {})
    },
    { timeoutMs: 10 }
  ))

  await assert.rejects(result, { name: "Error", message: "decision request timed out" })
  assert.equal(providerSignal?.aborted, true)
  assert.equal(ctx.signal.aborted, false)
  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 1)
})

test("caller cancellation aborts provider work even when it ignores the signal", async () => {
  const caller = new AbortController()
  let providerSignal: AbortSignal | undefined
  const pending = executeDecisionCall(modelId, async (signal) => {
    providerSignal = signal
    caller.abort("private caller reason")
    return await new Promise<never>(() => {})
  }, { signal: caller.signal, timeoutMs: 50 })

  await assert.rejects(pending, { name: "AbortError", message: "decision call aborted" })
  assert.equal(providerSignal?.aborted, true)
})

test("run cancellation reaches provider work independently of the caller signal", async () => {
  const ctx = createRunContext()
  const caller = new AbortController()
  let providerSignal: AbortSignal | undefined
  const pending = runWithRunContext(ctx, () => executeDecisionCall(modelId, async (signal) => {
    providerSignal = signal
    ctx.controller.abort()
    return await new Promise<never>(() => {})
  }, { signal: caller.signal, timeoutMs: 50 }))

  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(providerSignal?.aborted, true)
  assert.equal(caller.signal.aborted, false)
})

test("whole-run deadline aborts provider without requiring an outer deadline wrapper", { timeout: 1_000 }, async () => {
  const ctx = createRunContext({ budgetMs: 10 })
  let providerSignal: AbortSignal | undefined
  const pending = runWithRunContext(ctx, () => executeDecisionCall(modelId, async (signal) => {
    providerSignal = signal
    return await new Promise<never>(() => {})
  }, { timeoutMs: 100 }))

  await assert.rejects(pending, { name: "AbortError", message: "run deadline exceeded" })
  assert.equal(providerSignal?.aborted, true)
  assert.equal(ctx.signal.aborted, true)
})

test("provider failures do not expose operation error messages", async () => {
  await assert.rejects(executeDecisionCall(modelId, async () => {
    throw new Error("https://private-account.example/ secret-api-token")
  }, { timeoutMs: 1_000 }), { name: "Error", message: "decision provider call failed" })
})

test("result cannot settle usage after the run deadline elapses before timers fire", async (t) => {
  const ctx = createRunContext({ budgetMs: 1_000 })
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => {
    t.mock.method(Date, "now", () => ctx.deadline)
    return { payload: {}, usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } }
  }, { timeoutMs: 2_000 })), { name: "AbortError", message: "run deadline exceeded" })

  assert.equal(ctx.signal.aborted, true)
  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 0)
})

test("zero call budget rejects before any outbound decision work", async () => {
  const ctx = createRunContext({ resourceBudget: { limits: { maxModelCalls: 0 } } })
  let calls = 0
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => {
    calls += 1
    return { payload: {} }
  }, { timeoutMs: 1_000 })), (error: unknown) => {
    assert.ok(error instanceof RunBudgetExceededError)
    assert.equal(error.dimension, "model_calls")
    assert.equal(error.actual, 1)
    return true
  })
  assert.equal(calls, 0)
  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 0)
})

test("decision token overage preserves the run budget error and settled usage", async () => {
  const ctx = createRunContext({ resourceBudget: { limits: { maxTokens: 3 } } })
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => ({
    payload: {},
    usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
  }), { timeoutMs: 1_000 })), (error: unknown) => {
    assert.ok(error instanceof RunBudgetExceededError)
    assert.equal(error.dimension, "tokens")
    assert.equal(error.actual, 4)
    return true
  })
  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 4)
  assert.equal(ctx.signal.aborted, true)
})

test("decision cost overage preserves exact-model cost and the budget error", async () => {
  const ctx = createRunContext({
    resourceBudget: {
      limits: { maxCostMicros: 1 },
      estimateCostMicros: createModelCostEstimator({
        [modelId]: {
          inputCostMicrosPerMillionTokens: 500_000,
          outputCostMicrosPerMillionTokens: 900_000,
        },
      }),
    },
  })
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => ({
    payload: {},
    usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
  }), { timeoutMs: 1_000 })), (error: unknown) => {
    assert.ok(error instanceof RunBudgetExceededError)
    assert.equal(error.dimension, "cost_micros")
    assert.equal(error.actual, 2)
    return true
  })
  assert.equal(getRunResourceBudgetSnapshot(ctx).costMicros, 2)
})

test("decision cost budget fails closed when only the chat model has a price", async () => {
  const ctx = createRunContext({
    resourceBudget: {
      limits: { maxCostMicros: 1_000 },
      estimateCostMicros: createModelCostEstimator({
        "chat-model": {
          inputCostMicrosPerMillionTokens: 500_000,
          outputCostMicrosPerMillionTokens: 900_000,
        },
      }),
    },
  })
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => ({
    payload: {},
    usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
  }), { timeoutMs: 1_000 })), RunBudgetAccountingError)
  assert.equal(ctx.signal.aborted, true)
})

test("missing decision usage fails closed when a token budget is configured", async () => {
  const ctx = createRunContext({ resourceBudget: { limits: { maxTokens: 1_000 } } })
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId,
    async () => ({ payload: {} }),
    { timeoutMs: 1_000 }
  )), RunBudgetAccountingError)
  assert.equal(ctx.signal.aborted, true)
})

test("provider-originated resource errors retain their exact identity", async () => {
  const expected = new RunBudgetAccountingError("known accounting failure")
  await assert.rejects(executeDecisionCall(modelId, async () => { throw expected }, {
    timeoutMs: 1_000,
  }), (error: unknown) => error === expected)
})

test("deadline expiry before deferred provider invocation starts no outbound work", async (t) => {
  const ctx = createRunContext({ budgetMs: 1_000 })
  let calls = 0
  const pending = runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => {
    calls += 1
    return { payload: {} }
  }, { timeoutMs: 2_000 }))
  t.mock.method(Date, "now", () => ctx.deadline)

  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(calls, 0)
})

test("late provider success after cancellation never settles usage", async () => {
  const ctx = createRunContext()
  const caller = new AbortController()
  let resolveProvider!: (result: DecisionProviderResult) => void
  const provider = new Promise<DecisionProviderResult>((resolve) => { resolveProvider = resolve })
  const pending = runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => {
    caller.abort()
    return await provider
  }, { signal: caller.signal, timeoutMs: 1_000 }))

  await assert.rejects(pending, { name: "AbortError" })
  resolveProvider({ payload: {}, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 } })
  await setImmediate()
  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 0)
  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 1)
})

test("late provider rejection after cancellation is handled", async () => {
  const caller = new AbortController()
  let rejectProvider!: (error: Error) => void
  const provider = new Promise<never>((_resolve, reject) => { rejectProvider = reject })
  const pending = executeDecisionCall(modelId, async () => {
    caller.abort()
    return await provider
  }, { signal: caller.signal, timeoutMs: 1_000 })

  await assert.rejects(pending, { name: "AbortError" })
  rejectProvider(new Error("late private provider error"))
  await setImmediate()
})

test("concurrent decision runs keep payload and usage isolated when calls complete out of order", async () => {
  const first = createRunContext({ resourceBudget: { limits: { maxModelCalls: 1, maxTokens: 4 } } })
  const second = createRunContext({ resourceBudget: { limits: { maxModelCalls: 1, maxTokens: 9 } } })
  const [firstResult, secondResult] = await Promise.all([
    runWithRunContext(first, () => executeDecisionCall(modelId, async () => {
      await setImmediate()
      return { payload: "first", usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 } }
    }, { timeoutMs: 1_000 })),
    runWithRunContext(second, () => executeDecisionCall(modelId, async () => ({
      payload: "second", usage: { promptTokens: 8, completionTokens: 1, totalTokens: 9 },
    }), { timeoutMs: 1_000 })),
  ])

  assert.equal(firstResult.payload, "first")
  assert.equal(secondResult.payload, "second")
  assert.equal(getRunResourceBudgetSnapshot(first).totalTokens, 4)
  assert.equal(getRunResourceBudgetSnapshot(second).totalTokens, 9)
  assert.equal(getRunResourceBudgetSnapshot(first).modelCalls, 1)
  assert.equal(getRunResourceBudgetSnapshot(second).modelCalls, 1)
})

test("completed decision calls release timeout, deadline, and cancel propagation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const ctx = createRunContext({ budgetMs: 100 })
  const caller = new AbortController()
  let providerSignal: AbortSignal | undefined
  await runWithRunContext(ctx, () => executeDecisionCall(modelId, async (signal) => {
    providerSignal = signal
    return { payload: {} }
  }, { signal: caller.signal, timeoutMs: 1_000 }))

  t.mock.timers.tick(2_000)
  assert.equal(ctx.signal.aborted, false)
  caller.abort()
  ctx.controller.abort()
  assert.equal(providerSignal?.aborted, false)
})

test("distant run deadlines do not overflow the decision request timer", async () => {
  const ctx = createRunContext({ budgetMs: 3_000_000_000 })
  const result = await runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => {
    await delay(20)
    return { payload: "completed" }
  }, { timeoutMs: 1_000 }))

  assert.equal(result.payload, "completed")
  assert.equal(ctx.signal.aborted, false)
})

test("whole-run expiry wins when the request timeout timer fires at the same deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let wallClock = 1_000
  t.mock.method(Date, "now", () => wallClock)
  const ctx = createRunContext({ budgetMs: 10 })
  let providerSignal: AbortSignal | undefined
  const pending = runWithRunContext(ctx, () => executeDecisionCall(modelId, async (signal) => {
    providerSignal = signal
    return await new Promise<never>(() => {})
  }, { timeoutMs: 10 }))
  await Promise.resolve()
  wallClock = ctx.deadline
  t.mock.timers.tick(10)

  await assert.rejects(pending, { name: "AbortError", message: "run deadline exceeded" })
  assert.equal(ctx.signal.aborted, true)
  assert.equal(providerSignal?.aborted, true)
})

test("provider result beyond the request ceiling cannot settle usage before timeout timers run", async (t) => {
  let monotonicClock = 1_000
  t.mock.method(performance, "now", () => monotonicClock)
  const ctx = createRunContext()
  let providerSignal: AbortSignal | undefined
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async (signal) => {
    providerSignal = signal
    monotonicClock += 6
    return { payload: "late result", usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 } }
  }, { timeoutMs: 5 })), { name: "Error", message: "decision request timed out" })

  assert.equal(providerSignal?.aborted, true)
  assert.equal(ctx.signal.aborted, false)
  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 0)
})

test("request ceiling before deferred provider invocation prevents outbound work", async (t) => {
  let monotonicClock = 1_000
  t.mock.method(performance, "now", () => monotonicClock)
  let calls = 0
  const pending = executeDecisionCall(modelId, async () => {
    calls += 1
    return { payload: {} }
  }, { timeoutMs: 5 })
  monotonicClock += 5

  await assert.rejects(pending, { name: "Error", message: "decision request timed out" })
  assert.equal(calls, 0)
})

test("blocking provider work cannot return success after its request timeout", async () => {
  const ctx = createRunContext()
  let providerSignal: AbortSignal | undefined
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async (signal) => {
    providerSignal = signal
    const blockUntil = performance.now() + 25
    while (performance.now() < blockUntil) {
      // Hold timer callbacks until the provider returns its stale result.
    }
    return { payload: "late", usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 } }
  }, { timeoutMs: 5 })), { name: "Error", message: "decision request timed out" })

  assert.equal(providerSignal?.aborted, true)
  assert.equal(ctx.signal.aborted, false)
  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 0)
})

test("provider failure after request expiry reports timeout despite a backwards wall clock", async (t) => {
  let monotonicClock = 1_000
  t.mock.method(performance, "now", () => monotonicClock)
  const ctx = createRunContext()
  await assert.rejects(runWithRunContext(ctx, () => executeDecisionCall(modelId, async () => {
    monotonicClock += 6
    t.mock.method(Date, "now", () => ctx.createdAt - 10_000)
    throw new Error("private provider failure")
  }, { timeoutMs: 5 })), { name: "Error", message: "decision request timed out" })
  assert.equal(ctx.signal.aborted, false)
})

test("every decision authority fault joins the shared Clef protocol classification", async () => {
  const caller = new AbortController()
  caller.abort()
  await assert.rejects(runWithRunContext(createRunContext(), () => executeDecisionCall(
    modelId, async () => ({ payload: {} }), { signal: caller.signal, timeoutMs: 1_000 }
  )), (error: unknown) => {
    assert.equal(clefErrorCode(error), "cancelled")
    assert.equal(classifyClefError(error), "cancelled")
    return true
  })

  const expired = createRunContext({ deadline: Date.now() - 1 })
  await assert.rejects(runWithRunContext(expired, () => executeDecisionCall(
    modelId, async () => ({ payload: {} }), { timeoutMs: 1_000 }
  )), (error: unknown) => {
    assert.equal(clefErrorCode(error), "run_deadline_exceeded")
    assert.equal(classifyClefError(error), "run_deadline_exceeded")
    return true
  })

  await assert.rejects(executeDecisionCall(modelId, async () => {
    await delay(25)
    return { payload: {} }
  }, { timeoutMs: 5 }), (error: unknown) => {
    assert.equal((error as Error).message, "decision request timed out")
    assert.equal(clefErrorCode(error), "timeout")
    assert.equal(classifyClefError(error), "timeout")
    return true
  })

  await assert.rejects(executeDecisionCall(modelId, async () => {
    throw new Error("https://private-account.example/ secret-api-token")
  }, { timeoutMs: 1_000 }), (error: unknown) => {
    assert.equal((error as Error).message, "decision provider call failed")
    assert.equal(clefErrorCode(error), "provider_failure")
    assert.equal(classifyClefError(error), "provider_failure")
    return true
  })

  const budgeted = createRunContext({ resourceBudget: { limits: { maxModelCalls: 0 } } })
  await assert.rejects(runWithRunContext(budgeted, () => executeDecisionCall(
    modelId, async () => ({ payload: {} }), { timeoutMs: 1_000 }
  )), (error: unknown) => {
    assert.equal(classifyClefError(error), "budget_exceeded")
    return true
  })
})
