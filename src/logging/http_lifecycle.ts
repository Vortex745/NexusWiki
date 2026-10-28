import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import type { Logger, LogFields, LogLevel } from "./logger"
import type { TracingRuntime } from "../tracing/contract"
import { attachRequestScope } from "../tracing/express"

/**
 * LO-04: HTTP request logging — one request_id per real request, exactly one
 * terminal record per request, accurate classification of success / rejected /
 * error / client-disconnect / timeout.
 *
 * Design rules that come from the spec, not from convenience:
 *  - `request_id` is minted here and is NOT a W3C trace id (D17). No inbound
 *    header can set it, so a caller can never forge correlation.
 *  - The terminal record is emitted once. `finish`, `close` and `timeout`
 *    race in real traffic (an SSE stream finishes and closes; a client that
 *    disconnects after the last byte fires both), so a single `finalized`
 *    guard decides the one record that describes what really happened.
 *  - The record describes what the caller actually received: `statusCode` is
 *    null when no headers were sent, and `outcome` distinguishes a full
 *    success from a partial stream that the client abandoned.
 *  - Correlation travels through AsyncLocalStorage, so nested async work
 *    (the answer runner, ingestion handlers) reuses the request's context
 *    without threading a parameter through every signature.
 *  - Excluded surfaces (assets, health/status, polling reads, auth/session,
 *    capability and config reads, and plain collection GETs) get a request id
 *    but no terminal record — matching the coverage policy frozen in LO-02.
 */

export interface HttpLogContext {
  requestId: string
  operation: string
  method: string
  path: string
  released: boolean
}

export type HttpOutcome = "success" | "rejected" | "error" | "client_closed" | "aborted" | "timeout"

export interface HttpLogPolicy {
  /** Paths that never produce a terminal record, whatever the method. */
  excludedPrefixes: readonly string[]
  /** Exact read-only GETs (`:param` matches one segment). */
  excludedGetPaths: readonly string[]
  /**
   * Read-only GET families, matched as a SEGMENT PREFIX (`:param` matches one
   * segment). A prefix here never touches mutations: `PUT /api/feedback/:id`
   * still gets its root while `GET /api/feedback/:id` stays a plain read.
   */
  excludedGetPrefixes: readonly string[]
  /** Ordered prefix → operation mapping (longest match wins). */
  operations: ReadonlyArray<{ prefix: string; operation: string }>
}

/**
 * Segment-wise match so `:id` matches exactly one path segment. A plain
 * `startsWith` would let `/api/models` swallow `/api/models/profiles/:id/test`
 * and turn a deliberate mutation into a read.
 */
function matchesSegments(pattern: string, path: string, prefix: boolean): boolean {
  const wanted = pattern.split("/").filter(Boolean)
  const actual = path.split("/").filter(Boolean)
  if (prefix ? wanted.length > actual.length : wanted.length !== actual.length) return false
  return wanted.every((segment, index) => segment.startsWith(":") || segment === actual[index])
}

const storage = new AsyncLocalStorage<HttpLogContext>()

/** The live request context, or undefined once the request terminated. */
export function currentHttpLogContext(): HttpLogContext | undefined {
  const context = storage.getStore()
  return context && !context.released ? context : undefined
}

/** A logger bound to the current request, for nested business steps. */
export function currentRequestLogger(logger: Logger): Logger | undefined {
  const context = currentHttpLogContext()
  if (!context) return undefined
  return logger.child({ requestId: context.requestId, operation: context.operation })
}

export const DEFAULT_HTTP_LOG_POLICY: HttpLogPolicy = {
  excludedPrefixes: [
    "/api/assets",
    "/api/status",
    "/api/capabilities",
    "/api/session",
    "/api/auth",
    "/api/demo-config",
    "/api/health",
    "/api/model-profiles",
  ],
  // Exact: the collection read only. A prefix would swallow the graph reads,
  // which ARE whitelisted operations (they load a whole subgraph).
  excludedGetPaths: ["/api/knowledge-bases", "/api/documents"],
  excludedGetPrefixes: [
    "/api/chat/runs",
    "/api/chat/sessions/:sessionId/attachments",
    "/api/knowledge-bases/:id/document-folders",
    "/api/knowledge-bases/:id/wiki",
    "/api/knowledge-bases/:id/sync-data-sources",
    "/api/knowledge-base-folders",
    "/api/sync-data-sources",
    "/api/ingest",
    "/api/sources",
    "/api/assistants",
    "/api/conversations",
    "/api/feedback",
    "/api/handoffs",
    "/api/memories",
    "/api/memory-suggestions",
    "/api/models/profiles",
  ],
  operations: [
    { prefix: "/api/chat", operation: "chat.run" },
    { prefix: "/api/ingest", operation: "ingest.submit" },
    { prefix: "/api/documents", operation: "documents.maintain" },
    { prefix: "/api/document-folders", operation: "documents.maintain" },
    { prefix: "/api/knowledge-bases", operation: "knowledge_base.manage" },
    { prefix: "/api/knowledge-base-folders", operation: "knowledge_base.manage" },
    { prefix: "/api/sync", operation: "sync.run" },
    { prefix: "/api/wiki", operation: "wiki.run" },
    { prefix: "/api/memories", operation: "memory.manage" },
    { prefix: "/api/memory-suggestions", operation: "memory.manage" },
    { prefix: "/api/assistants", operation: "assistants.manage" },
    { prefix: "/api/attachments", operation: "attachments.submit" },
    { prefix: "/api/handoffs", operation: "handoff.manage" },
    { prefix: "/api/feedback", operation: "feedback.submit" },
    { prefix: "/api/conversations", operation: "conversations.manage" },
  ],
}

export interface HttpLogDecision {
  logged: boolean
  operation: string
}

export function decideHttpLog(
  method: string,
  path: string,
  policy: HttpLogPolicy = DEFAULT_HTTP_LOG_POLICY,
): HttpLogDecision {
  const normalizedMethod = method.toUpperCase()
  const normalizedPath = path.replace(/\/+$/, "") || "/"
  const operation = [...policy.operations]
    .filter((entry) => normalizedPath === entry.prefix || normalizedPath.startsWith(`${entry.prefix}/`))
    .sort((left, right) => right.prefix.length - left.prefix.length)[0]

  if (!normalizedPath.startsWith("/api/")) {
    return { logged: false, operation: operation?.operation ?? "http.request" }
  }
  if (policy.excludedPrefixes.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return { logged: false, operation: operation?.operation ?? "http.request" }
  }
  if (
    normalizedMethod === "GET" &&
    (policy.excludedGetPaths.some((path) => matchesSegments(path, normalizedPath, false)) ||
      policy.excludedGetPrefixes.some((path) => matchesSegments(path, normalizedPath, true)))
  ) {
    return { logged: false, operation: operation?.operation ?? "http.request" }
  }
  return { logged: true, operation: operation?.operation ?? "http.request" }
}

export interface HttpLogLifecycleOptions {
  policy?: HttpLogPolicy
  /**
   * LO-06: request-level tracing. When present and enabled, every whitelisted
   * request opens exactly one root span, exposes it to handlers via
   * `res.locals.tracingScope`, and ends it exactly once with the same terminal
   * classification as the log record.
   */
  tracing?: TracingRuntime
  /**
   * Optional idle deadline for the request socket. Off by default — enabling
   * it changes connection behaviour, so it is opt-in per deployment. When
   * set, an idle request is classified as `timeout` exactly once.
   */
  idleTimeoutMs?: number
}

type TerminalReason = "finish" | "close" | "timeout" | "error"

function outcomeFor(reason: TerminalReason, res: Response): HttpOutcome {
  if (reason === "timeout") return "timeout"
  if (reason === "error") return "error"
  if (reason === "finish") {
    if (res.statusCode >= 500) return "error"
    if (res.statusCode >= 400) return "rejected"
    return "success"
  }
  // close without finish: the connection ended before the response completed.
  return res.headersSent ? "client_closed" : "aborted"
}

function levelFor(outcome: HttpOutcome): LogLevel {
  if (outcome === "success") return "info"
  if (outcome === "rejected" || outcome === "client_closed" || outcome === "aborted") return "warn"
  return "error"
}

export function createHttpLogLifecycle(logger: Logger, options: HttpLogLifecycleOptions = {}) {
  const policy = options.policy ?? DEFAULT_HTTP_LOG_POLICY
  return function httpLogLifecycle(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint()
    const path = req.originalUrl.split("?")[0]
    const decision = decideHttpLog(req.method, path, policy)
    const requestId = randomUUID()
    if (!res.headersSent) {
      res.setHeader("x-request-id", requestId)
    }
    const context: HttpLogContext = {
      requestId,
      operation: decision.operation,
      method: req.method,
      path,
      released: false,
    }
    // LO-06: the HTTP root span. It is a root by construction (no inbound
    // traceparent is ever trusted), sampled once by the runtime, and exposed
    // to handlers through `res.locals` so nested business steps become
    // children instead of opening a second root.
    const operation =
      decision.logged && options.tracing?.enabled
        ? options.tracing.startOperation(`http.${req.method.toLowerCase()}`, {
            "http.request.method": req.method,
            "http.route": path,
            "http.request_id": requestId,
          })
        : undefined
    if (operation) {
      attachRequestScope(res, operation)
      if (operation.sampled && operation.traceId) {
        res.setHeader("x-trace-id", operation.traceId)
      }
    }
    let finalized = false

    const finalize = (reason: TerminalReason): void => {
      if (finalized) return
      finalized = true
      context.released = true
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      const outcome = outcomeFor(reason, res)
      // Exactly one scope end per request (LG-05-AC07): the same guard that
      // makes the log record unique also closes the span once.
      if (operation) {
        operation.end({
          outcome: outcome === "error" || outcome === "timeout" ? "error" : "ok",
          ...(outcome === "error" || outcome === "timeout" ? { message: outcome } : {}),
          attributes: {
            "http.status_code": res.headersSent ? res.statusCode : 0,
            "http.outcome": outcome,
            "http.terminal_reason": reason,
            "http.duration_ms": Math.round(durationMs * 1000) / 1000,
          },
        })
      }
      if (!decision.logged) return
      const fields: LogFields = {
        operation: decision.operation,
        requestId,
        method: req.method,
        path,
        statusCode: res.headersSent ? res.statusCode : null,
        outcome,
        terminalReason: reason,
        durationMs: Math.round(durationMs * 1000) / 1000,
        ...(operation?.traceId ? { traceId: operation.traceId } : {}),
        ...(operation?.spanId ? { spanId: operation.spanId } : {}),
      }
      // Fire-and-forget: a slow stdout must not keep the socket open. The sink
      // still applies backpressure to whoever awaits; the request path does
      // not change its result either way (AC08).
      void logger[levelFor(outcome)]("http.request.completed", fields).catch(() => {
        // A logger implementation must never affect the response path.
      })
    }

    // Optional idle deadline. Node's own socket timeout destroys the socket
    // without telling the request which reason won, so the deadline is owned
    // here: any inbound byte or outbound write re-arms it, and expiry is
    // recorded as `timeout` before the socket goes away.
    const idleTimeoutMs = options.idleTimeoutMs
    let idleTimer: NodeJS.Timeout | undefined
    const disarm = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }
    const arm = (): void => {
      if (idleTimeoutMs === undefined || idleTimeoutMs <= 0 || finalized) return
      disarm()
      idleTimer = setTimeout(() => {
        finalize("timeout")
        req.socket?.destroy()
      }, idleTimeoutMs)
    }
    if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
      const response = res as unknown as {
        write: (...args: unknown[]) => boolean
        end: (...args: unknown[]) => unknown
      }
      const originalWrite = response.write.bind(res)
      const originalEnd = response.end.bind(res)
      response.write = (...args: unknown[]) => {
        arm()
        return originalWrite(...args)
      }
      response.end = (...args: unknown[]) => {
        disarm()
        return originalEnd(...args)
      }
      req.on("data", arm)
      arm()
    }

    res.once("finish", () => {
      disarm()
      finalize("finish")
    })
    res.once("close", () => {
      disarm()
      finalize("close")
    })
    res.once("error", () => {
      disarm()
      finalize("error")
    })

    // Run the handler with the request span active so provider calls made
    // inside it (model observation) attach to this root, not to a new one.
    const runNext = (): void => storage.run(context, () => next())
    if (operation) operation.runInContext(runNext)
    else runNext()
  }
}
