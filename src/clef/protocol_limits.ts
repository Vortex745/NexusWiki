/**
 * Client-side Clef request limits, enforced before anything is transmitted.
 *
 * Re-derived from live measurement (2026-10-08 probes, `.scratch/pdf-quality-audit/`): the
 * endpoint accepts a 511,770-byte body and rejects ~530,000 bytes with 413 (its estimate is
 * body/4 against a 65,536-token window, exact on five measured points — the boundary is the
 * 2^19 = 524,288-byte body). Four images pass, five are rejected. The per-image and aggregate
 * budgets keep one full scale-2 page render (378,899 raw bytes) inside the body budget, and
 * any multi-image request fails here explicitly instead of as a provider 413.
 */
import { ClefProtocolError } from "./protocol_errors"

export const CLEF_REQUEST_LIMITS = Object.freeze({
  maxImagesPerRequest: 4,
  maxImageBytes: 384 * 1024,
  maxAggregateImageBytes: 384 * 1024,
  maxRequestBytes: 512 * 1024,
})

export type ClefRequestLimits = Readonly<typeof CLEF_REQUEST_LIMITS>

/** `body.model` names the decision model on the wire; the URL path uses the full `CLEF_MODEL_ID`. */
export const CLEF_REQUEST_MODEL_NAME = "clef"

/** The Clef multimodal request shape. `images` carries embedded base64 data URIs; `state` the text under review. */
export interface ClefRequestPayload {
  model: string
  images?: readonly string[]
  state?: unknown
  questions?: Record<string, unknown>
}

export interface ClefRequestDeclaration {
  /** the exact payload that will be serialized and transmitted */
  body: ClefRequestPayload
  /** caller-facing label used in every failure message, e.g. `Clef` or `Clef quality` */
  label: string
  limits?: ClefRequestLimits
  /** image slots the caller declared; a payload carrying fewer is a silent truncation */
  declaredImageCount?: number
  /** decoded byte length declared for each transmitted image, index-aligned with `body.images` */
  declaredImageBytes?: readonly number[]
  /** image slots the request state points at; each must address a transmitted image */
  referencedImageIndices?: readonly number[]
}

export interface PreparedClefRequest {
  /** the serialized JSON actually transmitted — identical to what was measured */
  serialized: string
  bodyBytes: number
  imageCount: number
  aggregateImageBytes: number
}

function refuse(label: string, message: string): never {
  throw new ClefProtocolError("invalid_request_payload", `${label} request payload is not a transmittable Clef request: ${message}`)
}

function decodedLength(image: string): number {
  const separator = image.indexOf(",")
  const payload = image.startsWith("data:") && separator !== -1 ? image.slice(separator + 1) : image
  return Buffer.from(payload, "base64").length
}

/**
 * Measures the payload against every Clef wire limit and returns the exact bytes that may be
 * transmitted. Called before the request is handed to the transport, so an over-limit or
 * truncated payload can never open a connection or consume a run budget.
 */
export function prepareClefRequest(request: ClefRequestDeclaration): PreparedClefRequest {
  const label = request.label
  const limits = request.limits ?? CLEF_REQUEST_LIMITS
  const body = request.body
  if (!body || typeof body !== "object" || Array.isArray(body)) refuse(label, "the request is not an object")
  if (body.model !== CLEF_REQUEST_MODEL_NAME) refuse(label, `model must be "${CLEF_REQUEST_MODEL_NAME}"`)
  if (body.state === undefined || body.state === null) refuse(label, "state is missing")
  const questions = body.questions
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
    refuse(label, "questions must carry at least one question")
  }

  const images = body.images
  if (images !== undefined && (!Array.isArray(images) || images.some((image) => typeof image !== "string"))) {
    refuse(label, "images must be a list of base64 strings")
  }
  const slots = images ?? []

  if (request.declaredImageCount !== undefined && request.declaredImageCount !== slots.length) {
    throw new ClefProtocolError(
      "input_truncated",
      `${label} request declared ${request.declaredImageCount} page images but carries ${slots.length}; the payload was truncated and was not sent`
    )
  }
  if (slots.length > limits.maxImagesPerRequest) {
    throw new ClefProtocolError(
      "image_count_exceeded",
      `${label} request carries ${slots.length} images over the ${limits.maxImagesPerRequest} image per-request Clef limit; nothing was dropped`
    )
  }

  let aggregate = 0
  slots.forEach((image, index) => {
    const decoded = decodedLength(image)
    if (decoded === 0) {
      throw new ClefProtocolError("input_truncated", `${label} request image slot ${index} carries no bytes`)
    }
    const declared = request.declaredImageBytes?.[index]
    if (declared !== undefined && declared !== decoded) {
      throw new ClefProtocolError(
        "input_truncated",
        `${label} request image slot ${index} declares ${declared} decoded bytes but carries ${decoded}`
      )
    }
    if (decoded > limits.maxImageBytes) {
      throw new ClefProtocolError(
        "image_too_large",
        `${label} request image slot ${index} is ${decoded} decoded bytes over the ${limits.maxImageBytes} byte Clef limit`
      )
    }
    aggregate += decoded
    if (aggregate > limits.maxAggregateImageBytes) {
      throw new ClefProtocolError(
        "image_aggregate_too_large",
        `${label} request images total ${aggregate} decoded bytes over the Clef ${limits.maxAggregateImageBytes} byte aggregate limit; nothing was dropped`
      )
    }
  })

  for (const referenced of request.referencedImageIndices ?? []) {
    if (!Number.isInteger(referenced) || referenced < 0 || referenced >= slots.length) {
      throw new ClefProtocolError(
        "input_truncated",
        `${label} request state references image slot ${referenced} of ${slots.length} transmitted images`
      )
    }
  }

  let serialized: string
  try {
    serialized = JSON.stringify(body)
  } catch {
    refuse(label, "the request cannot be serialized")
  }
  if (typeof serialized !== "string" || serialized === "{}") refuse(label, "the request has no transmittable content")
  const bodyBytes = Buffer.byteLength(serialized, "utf8")
  if (bodyBytes > limits.maxRequestBytes) {
    throw new ClefProtocolError(
      "request_body_too_large",
      `${label} request body is ${bodyBytes} bytes over the ${limits.maxRequestBytes} byte Clef limit; no evidence was dropped`
    )
  }
  return Object.freeze({ serialized, bodyBytes, imageCount: slots.length, aggregateImageBytes: aggregate })
}
