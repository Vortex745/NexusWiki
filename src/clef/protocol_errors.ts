/**
 * Shared Clef protocol error taxonomy.
 *
 * Both Clef callers — the question route in `src/retrieval/router` and the PDF page-quality
 * route in `src/ingestion/quality` — classify provider faults through this one table, so an
 * HTTP, transport, timeout, cancellation, malformed-JSON or invalid-typed-response fault means
 * the same thing whichever caller met it. The classification travels in `code`; `name` is left
 * as the inherited `"Error"` (and `"AbortError"` for cancellations) because both callers'
 * published failure contracts match on it.
 */
export const CLEF_PROTOCOL_ERROR_CODES = Object.freeze([
  /** the caller's AbortSignal (or the run's) cancelled the request before or during transmission */
  "cancelled",
  /** the per-request ceiling expired while the provider was working */
  "timeout",
  /** the whole-run deadline expired before the provider settled usage */
  "run_deadline_exceeded",
  /** the run's model-call / token / cost budget refused or reverted the call */
  "budget_exceeded",
  /** the outbound transport itself failed (connection, DNS, TLS, aborted body) */
  "transport",
  /** the provider answered with a non-2xx status; the error body is never read */
  "http_status",
  /** the provider body was not parseable JSON */
  "invalid_json",
  /** the wire envelope or its usage block failed the shared Clef response schema */
  "invalid_response",
  /** the envelope was usable but the caller's typed answer was not */
  "invalid_typed_response",
  /** more page images than the Clef per-request image ceiling */
  "image_count_exceeded",
  /** one decoded page image over the per-image Clef ceiling */
  "image_too_large",
  /** the decoded page images together over the Clef aggregate ceiling */
  "image_aggregate_too_large",
  /** the serialized request over the Clef request-body ceiling */
  "request_body_too_large",
  /** declared images, byte counts or state references did not survive into the payload */
  "input_truncated",
  /** the payload is not a transmittable Clef request at all */
  "invalid_request_payload",
  /** the client was constructed without usable credentials or a usable timeout */
  "configuration",
  /** the decision authority reported a provider failure whose cause was suppressed */
  "provider_failure",
  /** anything that is not a known Clef protocol fault */
  "unknown",
] as const)

export type ClefProtocolErrorCode = (typeof CLEF_PROTOCOL_ERROR_CODES)[number]

/** Codes that carry a provider-facing message template built from the caller's label. */
export type ClefProviderFaultCode = "cancelled" | "transport" | "http_status" | "invalid_json" | "invalid_response"

/** Tag key used to bring foreign errors (executor timeouts, cancellations) into this taxonomy. */
export const CLEF_ERROR_CODE: unique symbol = Symbol.for("agentic-rag/clef/error-code")

const CODES = new Set<string>(CLEF_PROTOCOL_ERROR_CODES)

/**
 * Faults raised by the decision-call authority rather than by the Clef client. Exact-message
 * matching is the fallback for executors that did not tag their errors with CLEF_ERROR_CODE.
 */
const DECISION_AUTHORITY_FAULTS: Readonly<Record<string, ClefProtocolErrorCode>> = Object.freeze({
  "decision request timed out": "timeout",
  "run deadline exceeded": "run_deadline_exceeded",
  "decision call aborted": "cancelled",
  "decision provider call failed": "provider_failure",
})

export class ClefProtocolError extends Error {
  readonly code: ClefProtocolErrorCode
  readonly status?: number

  constructor(code: ClefProtocolErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    if (options.status !== undefined) this.status = options.status
    ;(this as { [CLEF_ERROR_CODE]?: ClefProtocolErrorCode })[CLEF_ERROR_CODE] = code
  }
}

export function isClefProtocolErrorCode(value: unknown): value is ClefProtocolErrorCode {
  return typeof value === "string" && CODES.has(value)
}

/** Attach a taxonomy code to an error the client did not raise, keeping its name and message. */
export function tagClefErrorCode<T extends Error>(error: T, code: ClefProtocolErrorCode): T {
  ;(error as { [CLEF_ERROR_CODE]?: ClefProtocolErrorCode })[CLEF_ERROR_CODE] = code
  return error
}

export function clefErrorCode(error: unknown): ClefProtocolErrorCode | undefined {
  if (!error || typeof error !== "object") return undefined
  const candidate = error as { [CLEF_ERROR_CODE]?: unknown; code?: unknown }
  if (isClefProtocolErrorCode(candidate[CLEF_ERROR_CODE])) return candidate[CLEF_ERROR_CODE] as ClefProtocolErrorCode
  // DOMException carries a legacy numeric `code`; only a taxonomy string is accepted.
  return isClefProtocolErrorCode(candidate.code) ? (candidate.code as ClefProtocolErrorCode) : undefined
}

export function classifyClefError(error: unknown): ClefProtocolErrorCode {
  const tagged = clefErrorCode(error)
  if (tagged) return tagged
  if (!error || typeof error !== "object") return "unknown"
  const message = typeof (error as Error).message === "string" ? (error as Error).message : ""
  const authorityFault = Object.prototype.hasOwnProperty.call(DECISION_AUTHORITY_FAULTS, message)
    ? DECISION_AUTHORITY_FAULTS[message]
    : undefined
  if (authorityFault) return authorityFault
  // Run-budget failures are raised by the run's resource authority and name themselves AbortError;
  // their own stable `code` marker distinguishes them from a caller cancellation.
  const authorityCode = (error as { code?: unknown }).code
  if (authorityCode === "RUN_BUDGET_EXCEEDED" || authorityCode === "RUN_BUDGET_ACCOUNTING_ERROR") return "budget_exceeded"
  return (error as Error).name === "AbortError" ? "cancelled" : "unknown"
}

/**
 * The provider-facing message for a transport fault, phrased with the caller's own label so a
 * question-route failure and a quality-route failure keep the wording their contracts publish.
 */
export function clefFaultMessage(code: ClefProviderFaultCode, label: string, detail: { status?: number } = {}): string {
  switch (code) {
    case "cancelled":
      return `${label} request cancelled`
    case "transport":
      return `${label} provider request failed`
    case "invalid_json":
      return `${label} provider returned invalid JSON`
    case "invalid_response":
      return `${label} provider returned invalid response or usage`
    case "http_status":
      if (typeof detail.status !== "number") {
        throw new TypeError(`clefFaultMessage needs an HTTP status to describe a ${code} fault`)
      }
      return `${label} provider returned HTTP ${detail.status}`
    default:
      throw new TypeError(`clefFaultMessage has no provider message template for ${String(code)}`)
  }
}

/** A cancellation is an AbortError, not a plain Error, in both callers' published contracts. */
export function clefCancellation(label: string): DOMException {
  return tagClefErrorCode(new DOMException(clefFaultMessage("cancelled", label), "AbortError"), "cancelled")
}
