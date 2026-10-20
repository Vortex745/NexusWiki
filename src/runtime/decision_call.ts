import type { DecisionCallExecutor } from "../types/agent"
import { performance } from "node:perf_hooks"
import { tagClefErrorCode } from "../clef/protocol_errors"
import { getCurrentRunContext, isRunBudgetError, recordModelUsage, reserveModelCall } from "./run_context"

/** Execute the routing provider through the active run's resource authority. */
export const executeDecisionCall: DecisionCallExecutor = async (modelId, operation, options) => {
  const requestDeadline = performance.now() + options.timeoutMs
  if (options.signal?.aborted) throw tagClefErrorCode(new DOMException("decision call aborted", "AbortError"), "cancelled")
  const ctx = getCurrentRunContext()
  if (ctx?.signal.aborted) throw tagClefErrorCode(new DOMException("decision call aborted", "AbortError"), "cancelled")
  if (ctx && Date.now() >= ctx.deadline) {
    ctx.controller.abort()
    throw tagClefErrorCode(new DOMException("run deadline exceeded", "AbortError"), "run_deadline_exceeded")
  }
  const reservation = ctx ? reserveModelCall(ctx, { kind: "decision", model: modelId }) : undefined
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let cancelError: Error | undefined
  let cancel: (error: Error) => void
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = (error) => {
      if (cancelError) return
      cancelError = error
      reject(error)
      controller.abort()
    }
  })
  const onCallerAbort = () => cancel(tagClefErrorCode(new DOMException("decision call aborted", "AbortError"), "cancelled"))
  const checkTimeCeilings = () => {
    if (cancelError) throw cancelError
    if (ctx && Date.now() >= ctx.deadline) {
      cancel(tagClefErrorCode(new DOMException("run deadline exceeded", "AbortError"), "run_deadline_exceeded"))
      ctx.controller.abort()
      throw cancelError
    }
    if (performance.now() >= requestDeadline) {
      cancel(tagClefErrorCode(new Error("decision request timed out"), "timeout"))
      throw cancelError
    }
  }
  options.signal?.addEventListener("abort", onCallerAbort, { once: true })
  ctx?.signal.addEventListener("abort", onCallerAbort, { once: true })
  timer = setTimeout(() => {
    if (ctx && Date.now() >= ctx.deadline) {
      cancel(tagClefErrorCode(new DOMException("run deadline exceeded", "AbortError"), "run_deadline_exceeded"))
      ctx.controller.abort()
      return
    }
    cancel(tagClefErrorCode(new Error("decision request timed out"), "timeout"))
  }, options.timeoutMs)
  if (ctx && Number.isFinite(ctx.deadline) && ctx.deadline - Date.now() <= options.timeoutMs) {
    deadlineTimer = setTimeout(() => {
      cancel(tagClefErrorCode(new DOMException("run deadline exceeded", "AbortError"), "run_deadline_exceeded"))
      ctx.controller.abort()
    }, Math.max(0, ctx.deadline - Date.now()))
  }

  try {
    const work = Promise.resolve()
      .then(() => {
        checkTimeCeilings()
        return operation(controller.signal)
      })
      .then((result) => {
        checkTimeCeilings()
        return result
      })
      .catch((error: unknown) => {
        if (cancelError) throw cancelError
        if (isRunBudgetError(error)) throw error
        checkTimeCeilings()
        throw tagClefErrorCode(new Error("decision provider call failed"), "provider_failure")
      })
    const result = await Promise.race([work, cancellation])
    checkTimeCeilings()
    if (ctx && reservation) recordModelUsage(ctx, reservation, result.usage)
    return result
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    options.signal?.removeEventListener("abort", onCallerAbort)
    ctx?.signal.removeEventListener("abort", onCallerAbort)
  }
}
