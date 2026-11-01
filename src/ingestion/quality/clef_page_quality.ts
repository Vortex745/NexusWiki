import type { DecisionCallExecutor, TokenUsage } from "../../types"
import { performance } from "node:perf_hooks"
import { classifyClefError, type ClefProtocolErrorCode } from "../../clef/protocol_errors"
import { ClefProtocolClient, type ClefDecodedPayload, type ClefProtocolClientOptions } from "../../clef/protocol_client"
import {
  QUALITY_CLEF_MODEL_ID,
  QualityContractError,
  type QualityContractErrorCode,
  type PageQualityVerdict,
} from "./contract"
import { buildQualityClefRequest, type QualityRequestInput } from "./request"
import { parseQualityAnswers, parseQualityResponseEnvelope, parseQualityUsage } from "./response"

export interface ClefPageQualityClientOptions {
  accountId: string
  apiToken: string
  timeoutMs: number
  execute: DecisionCallExecutor
  fetchImpl?: typeof fetch
}

export interface QualityBatchOutcome {
  ruleVersion: string
  requestedPages: readonly number[]
  verdicts: readonly PageQualityVerdict[]
  usage: TokenUsage
  modelId: string
  actualModel: string
  bodyBytes: number
  durationMs: number
}

/**
 * Every quality contract failure also names itself in the shared Clef protocol taxonomy, so one
 * fault means the same thing to the question route, the quality route and the release evidence
 * that reads them. The mapping is exhaustive by type: a new quality code fails to compile until
 * it is classified.
 */
const QUALITY_TO_CLEF_CLASSIFICATION: Readonly<Record<QualityContractErrorCode, ClefProtocolErrorCode>> = Object.freeze({
  empty_page_set: "invalid_request_payload",
  page_number_invalid: "invalid_request_payload",
  page_not_declared: "invalid_typed_response",
  page_out_of_document: "invalid_request_payload",
  duplicate_page: "invalid_request_payload",
  duplicate_page_verdict: "invalid_typed_response",
  verdict_invalid: "invalid_typed_response",
  issue_label_invalid: "invalid_typed_response",
  issue_label_conflict: "invalid_typed_response",
  observation_missing: "invalid_typed_response",
  image_bytes_missing: "input_truncated",
  image_base64_invalid: "invalid_request_payload",
  image_size_mismatch: "input_truncated",
  image_digest_mismatch: "input_truncated",
  image_media_type_invalid: "invalid_request_payload",
  image_media_type_mismatch: "invalid_request_payload",
  image_content_invalid: "invalid_request_payload",
  image_content_truncated: "input_truncated",
  image_page_mismatch: "invalid_request_payload",
  image_resolution_mismatch: "invalid_request_payload",
  image_resolution_invalid: "invalid_request_payload",
  image_resolution_too_large: "image_too_large",
  image_too_large: "image_too_large",
  image_aggregate_too_large: "image_aggregate_too_large",
  text_declaration_conflict: "invalid_request_payload",
  text_placeholder: "invalid_request_payload",
  batch_page_limit_exceeded: "image_count_exceeded",
  request_body_too_large: "request_body_too_large",
  response_envelope_invalid: "invalid_response",
  response_usage_invalid: "invalid_response",
  answer_missing: "invalid_typed_response",
  answer_question_invalid: "invalid_typed_response",
  answer_page_unrequested: "invalid_typed_response",
  answer_page_missing: "invalid_typed_response",
  answer_issue_missing: "invalid_typed_response",
  answer_type_invalid: "invalid_typed_response",
  answer_verdict_invalid: "invalid_typed_response",
  answer_issue_label_invalid: "invalid_typed_response",
  answer_probability_invalid: "invalid_typed_response",
  answer_confidence_invalid: "invalid_typed_response",
  answer_verdict_incoherent: "invalid_typed_response",
  answer_issue_incoherent: "invalid_typed_response",
})

/** Classifies any quality failure — contract, transport or budget — through the shared taxonomy. */
export function classifyQualityError(error: unknown): ClefProtocolErrorCode {
  if (error instanceof QualityContractError) {
    const table = QUALITY_TO_CLEF_CLASSIFICATION as Partial<Record<string, ClefProtocolErrorCode>>
    return table[error.code] ?? "unknown"
  }
  return classifyClefError(error)
}

/** Transport-level envelope and usage validation, phrased in quality's own contract failures. */
function decodeQualityResponse(json: unknown): ClefDecodedPayload {
  const { result } = parseQualityResponseEnvelope(json)
  return { payload: result, usage: parseQualityUsage(result.usage) }
}

/**
 * Sends one grounded page batch through the shared Clef protocol client, so the quality route
 * inherits the question route's image ceilings, wire envelope validation, budgets, timeout and
 * cancellation instead of owning a second transport — and imports no question-routing module.
 */
export class ClefPageQualityClient {
  private readonly client: ClefProtocolClient

  constructor(options: ClefPageQualityClientOptions) {
    const clientOptions: ClefProtocolClientOptions = {
      accountId: options.accountId,
      apiToken: options.apiToken,
      timeoutMs: options.timeoutMs,
      execute: options.execute,
      label: "Clef quality",
      modelId: QUALITY_CLEF_MODEL_ID,
      decodeResponse: decodeQualityResponse,
    }
    if (options.fetchImpl !== undefined) clientOptions.fetchImpl = options.fetchImpl
    this.client = new ClefProtocolClient(clientOptions)
  }

  async evaluateBatch(
    input: QualityRequestInput,
    callOptions?: { signal?: AbortSignal }
  ): Promise<QualityBatchOutcome> {
    const startedAt = performance.now()
    const request = buildQualityClefRequest(input)
    const result = await this.client.send({
      body: request.body,
      declaredImageCount: request.requestedPages.length,
      declaredImageBytes: request.imageByteLengths,
      referencedImageIndices: request.imageIndexes,
    }, { signal: callOptions?.signal })

    const parsed = parseQualityAnswers(result.payload, request.requestedPages)
    if (parsed.usage.totalTokens !== result.usage?.totalTokens) {
      throw new QualityContractError("response_usage_invalid", "Clef quality provider usage changed between send and parse")
    }
    return {
      ruleVersion: request.body.state.ruleVersion,
      requestedPages: request.requestedPages,
      verdicts: parsed.verdicts,
      usage: parsed.usage,
      modelId: this.client.modelId,
      actualModel: parsed.actualModel,
      bodyBytes: request.bodyBytes,
      durationMs: performance.now() - startedAt,
    }
  }
}
