import { randomUUID } from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import type { Logger } from "./logger"

/**
 * LO-03: the first structured-log slice — one existing JSON business
 * operation (knowledge-base writes) through the injected neutral logger.
 *
 * Deliberately narrow: LO-04 generalises the HTTP lifecycle (request_id
 * propagation, terminal-status classification, SSE single-terminal). This
 * slice only proves the pipe end-to-end: real request → injected logger →
 * Pino → one parseable JSON line on stdout, with credentials absent and the
 * response untouched.
 */

export interface LogSliceOptions {
  /** Stable operation name recorded on every line. */
  operation: string
  /** Methods that carry business meaning; reads are excluded (LO-02). */
  methods?: readonly string[]
}

export function createOperationLogSlice(logger: Logger, options: LogSliceOptions) {
  const methods = new Set((options.methods ?? ["POST"]).map((method) => method.toUpperCase()))
  return function operationLogSlice(req: Request, res: Response, next: NextFunction): void {
    if (!methods.has(req.method.toUpperCase())) {
      next()
      return
    }
    // A request id is minted here, independent from any tracing id (D17):
    // headers never decide identity, and request_id ≠ trace_id.
    const requestId = randomUUID()
    res.locals.logRequestId = requestId
    const startedAt = process.hrtime.bigint()
    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      // Fire-and-forget by design: a slow stdout must not hold the response
      // socket open. Delivery still honours backpressure inside the sink.
      void logger
        .info("http.request.completed", {
          operation: options.operation,
          requestId,
          requestIdSource: "generated",
          method: req.method,
          path: req.originalUrl.split("?")[0],
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 1000) / 1000,
          outcome: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "rejected" : "success",
        })
        .catch(() => {
          // The logger never rejects; this guards a third-party Logger impl.
        })
    })
    next()
  }
}
