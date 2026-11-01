/**
 * The shared Clef protocol client: one transport, one wire-envelope validation seam, one
 * limit policy and one error taxonomy for every Cloudflare Workers AI `clef` call.
 *
 * `src/retrieval/router` (question routing) and `src/ingestion/quality` (page-quality
 * evaluation) both send through this client. The client owns no domain vocabulary: callers hand
 * it the exact payload they want transmitted and decode the typed answers themselves, so the
 * quality route never imports question routing and question routing never imports ingestion.
 */
import type { DecisionCallExecutor, TokenUsage } from "../types"
import { CLEF_MODEL_ID } from "./protocol_envelope"
import {
  ClefProtocolError,
  clefCancellation,
  clefFaultMessage,
  type ClefProviderFaultCode,
} from "./protocol_errors"
import {
  CLEF_REQUEST_LIMITS,
  prepareClefRequest,
  type ClefRequestLimits,
  type ClefRequestPayload,
} from "./protocol_limits"

/** Maximum `setTimeout` delay; larger values fire immediately in Node. */
const MAX_TIMER_MS = 2_147_483_647

export interface ClefRequestCall {
  body: ClefRequestPayload
  declaredImageCount?: number
  declaredImageBytes?: readonly number[]
  referencedImageIndices?: readonly number[]
}

export interface ClefDecodedPayload {
  payload: unknown
  usage?: TokenUsage
}

export interface ClefProtocolClientOptions {
  accountId: string
  apiToken: string
  /** per-request ceiling handed to the decision authority, in integer milliseconds */
  timeoutMs: number
  /** the run's resource authority: budgets, deadline and cancellation live behind this seam */
  execute: DecisionCallExecutor
  /** decodes the wire envelope inside the transport seam, before any usage is settled */
  decodeResponse(json: unknown): ClefDecodedPayload
  /** provider-facing label for every failure message: `Clef` or `Clef quality` */
  label?: string
  modelId?: string
  limits?: ClefRequestLimits
  fetchImpl?: typeof fetch
}

export interface ClefSendOutcome {
  payload: unknown
  usage?: TokenUsage
  bodyBytes: number
  imageCount: number
  aggregateImageBytes: number
}

export interface ClefSendOptions {
  signal?: AbortSignal
}

function providerFault(code: ClefProviderFaultCode, label: string, status?: number): ClefProtocolError {
  return new ClefProtocolError(code, clefFaultMessage(code, label, status === undefined ? {} : { status }), {
    ...(status === undefined ? {} : { status }),
  })
}

export class ClefProtocolClient {
  readonly modelId: string
  readonly label: string
  readonly runUrl: string
  private readonly options: ClefProtocolClientOptions
  private readonly fetchImpl: typeof fetch

  constructor(options: ClefProtocolClientOptions) {
    const label = typeof options.label === "string" && options.label.trim() ? options.label.trim() : "Clef"
    const accountId = typeof options.accountId === "string" ? options.accountId.trim() : ""
    const apiToken = typeof options.apiToken === "string" ? options.apiToken.trim() : ""
    if (!accountId || !apiToken) {
      throw new ClefProtocolError("configuration", `${label} requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN`)
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMER_MS) {
      throw new ClefProtocolError("configuration", `${label} requires a positive DECISION_REQUEST_TIMEOUT_MS`)
    }
    const modelId = typeof options.modelId === "string" && options.modelId.trim() ? options.modelId.trim() : CLEF_MODEL_ID
    this.options = { ...options, accountId, apiToken, label, modelId }
    this.modelId = modelId
    this.label = label
    this.runUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Measures the payload against every Clef wire limit, then transmits exactly the measured
   * bytes. An over-limit or truncated payload fails here, before the decision authority reserves
   * a model call and before a single byte reaches the transport.
   */
  async send(call: ClefRequestCall, options?: ClefSendOptions): Promise<ClefSendOutcome> {
    const prepared = prepareClefRequest({
      body: call.body,
      label: this.label,
      limits: this.options.limits ?? CLEF_REQUEST_LIMITS,
      ...(call.declaredImageCount === undefined ? {} : { declaredImageCount: call.declaredImageCount }),
      ...(call.declaredImageBytes === undefined ? {} : { declaredImageBytes: call.declaredImageBytes }),
      ...(call.referencedImageIndices === undefined ? {} : { referencedImageIndices: call.referencedImageIndices }),
    })
    const label = this.label

    const result = await this.options.execute(this.modelId, async (signal) => {
      if (signal.aborted) throw clefCancellation(label)
      let response: Response
      try {
        response = await this.fetchImpl(this.runUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiToken}`,
            "content-type": "application/json",
          },
          body: prepared.serialized,
          signal,
        })
      } catch {
        if (signal.aborted) throw clefCancellation(label)
        throw providerFault("transport", label)
      }
      if (signal.aborted) throw clefCancellation(label)
      if (!response.ok) throw providerFault("http_status", label, response.status)
      let json: unknown
      try {
        json = await response.json()
      } catch {
        if (signal.aborted) throw clefCancellation(label)
        throw providerFault("invalid_json", label)
      }
      if (signal.aborted) throw clefCancellation(label)
      const decoded = this.options.decodeResponse(json)
      return { payload: decoded.payload, usage: decoded.usage }
    }, { signal: options?.signal, timeoutMs: this.options.timeoutMs })

    return {
      payload: result.payload,
      usage: result.usage,
      bodyBytes: prepared.bodyBytes,
      imageCount: prepared.imageCount,
      aggregateImageBytes: prepared.aggregateImageBytes,
    }
  }
}
