import type { Response } from "express"
import type { OperationScope, TracingAttributes, TracingRuntime } from "./contract"

/**
 * LO-06: the seam between the HTTP root span and a business step.
 *
 * The request root is attached to `res.locals` by the HTTP lifecycle
 * middleware (explicit, per-response — not a global/ALS lookup). Handlers ask
 * this helper for their operation, so when a root exists the step becomes a
 * CHILD and inherits the sampling decision instead of opening a second root
 * (LG-05-AC04). When no root exists (tracing off, excluded route, or a model
 * call outside HTTP) the runtime's own root policy applies (LG-05-AC05).
 */

export const REQUEST_TRACING_SCOPE = "tracingScope"

export function requestOperation(
  tracing: TracingRuntime,
  res: Response,
  name: string,
  attributes?: TracingAttributes,
): OperationScope {
  const locals = res.locals as Record<string, unknown>
  const candidate = locals[REQUEST_TRACING_SCOPE]
  if (candidate && typeof (candidate as OperationScope).startChild === "function") {
    return (candidate as OperationScope).startChild(name, attributes)
  }
  return tracing.startOperation(name, attributes)
}

/** Attach the request root so handlers can find it (used by the middleware). */
export function attachRequestScope(res: Response, scope: OperationScope): void {
  ;(res.locals as Record<string, unknown>)[REQUEST_TRACING_SCOPE] = scope
}

/**
 * The request root, when one was attached. Handlers that hand work to a
 * background task use this to CAPTURE the correlation explicitly — the task
 * record then carries neutral ids and the worker never reads a global.
 */
export function requestScope(res: Response): OperationScope | undefined {
  const candidate = (res.locals as Record<string, unknown>)[REQUEST_TRACING_SCOPE]
  return candidate && typeof (candidate as OperationScope).startChild === "function"
    ? (candidate as OperationScope)
    : undefined
}
