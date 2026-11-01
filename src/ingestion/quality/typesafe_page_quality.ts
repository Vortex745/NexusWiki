import { Image, choice, TypeSafeClient } from "@typesafe-ai/sdk"
import { performance } from "node:perf_hooks"
import type { DecisionCallExecutor } from "../../types"
import { normalizeTypeSafeBaseUrl } from "../../typesafe/base_url"
import { ClefProtocolError, tagClefErrorCode } from "../../clef/protocol_errors"
import { QualityContractError } from "./contract"
import { validateQualityPages, type QualityPageEvidence } from "./evidence"
import { qualityJointCriteria, qualityVerdictInstructions, type QualityRequestInput } from "./request"
import { parseQualityAnswers } from "./response"
import type { QualityBatchOutcome } from "./clef_page_quality"
import type { TokenUsage } from "../../types"

export interface TypeSafePageQualityClientOptions {
  apiKey: string
  baseURL: string
  model: string
  timeoutMs: number
  execute: DecisionCallExecutor
  client?: TypeSafeClient
}

interface PreparedQualityRequest {
  state: {
    ruleVersion: string
    documentPageCount: number
    pages: Array<{
      page: number
      image: Image
      extractedText: string
      textLayerAbsent: boolean
      mediaType: string
    }>
  }
  questions: Record<string, ReturnType<typeof choice>>
  pages: readonly QualityPageEvidence[]
  bodyBytes: number
}

function prepareQualityRequest(input: QualityRequestInput): PreparedQualityRequest {
  const pages = validateQualityPages(input.pages)
  if (pages.length !== 1) {
    throw new QualityContractError("batch_page_limit_exceeded", "TypeSafe quality requests judge exactly one page")
  }
  const ruleVersion = input.ruleVersion ?? "pdf-page-quality-v2"
  const ordered = [...pages].sort((left, right) => left.page - right.page)
  const page = ordered[0]
  const name = `page_${page.page}`
  const state = {
    ruleVersion,
    documentPageCount: input.documentPageCount,
    pages: [{
      page: page.page,
      image: Image.fromBase64(page.image.dataBase64),
      extractedText: page.extractedText,
      textLayerAbsent: page.textLayerAbsent,
      mediaType: page.image.mediaType,
    }],
  }
  const instructions = qualityVerdictInstructions(page.page, 0) + " Return exactly one joint verdict and issue label."
  const criteria = qualityJointCriteria()
  const questions = {
    [name]:
    choice(
      instructions,
      criteria,
    ),
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify({
    state: { ...state, pages: state.pages.map((item) => ({ ...item, image: page.image.dataBase64 })) },
    questions: { [name]: { instructions, criteria } },
  }), "utf8")
  return { state, questions, pages: Object.freeze(ordered), bodyBytes }
}

function usageFrom(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new QualityContractError("response_usage_invalid", "TypeSafe quality provider returned invalid or missing usage")
  }
  const usage = raw as { input_tokens?: unknown; output_tokens?: unknown }
  const promptTokens = usage.input_tokens
  const completionTokens = usage.output_tokens
  if (typeof promptTokens !== "number" || !Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
    typeof completionTokens !== "number" || !Number.isSafeInteger(completionTokens) || completionTokens < 0 ||
    !Number.isSafeInteger(promptTokens + completionTokens)) {
    throw new QualityContractError("response_usage_invalid", "TypeSafe quality provider returned invalid or missing usage")
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

function tagContractFailure(error: unknown): never {
  if (error instanceof QualityContractError) {
    tagClefErrorCode(error, "invalid_typed_response")
    throw error
  }
  throw error
}

export class TypeSafePageQualityClient {
  private readonly client: TypeSafeClient

  constructor(private readonly options: TypeSafePageQualityClientOptions) {
    this.client = options.client ?? new TypeSafeClient({
      apiKey: options.apiKey,
      baseURL: normalizeTypeSafeBaseUrl(options.baseURL),
      defaultModel: options.model,
      timeout: options.timeoutMs,
      retry: { maxRetries: 0 },
      compression: false,
      defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" },
    })
  }

  async evaluateBatch(
    input: QualityRequestInput,
    callOptions?: { signal?: AbortSignal },
  ): Promise<QualityBatchOutcome> {
    const request = prepareQualityRequest(input)
    const startedAt = performance.now()
    const result = await this.options.execute(this.options.model, async (signal) => {
      try {
        const response = await this.client.systemOne({
          state: request.state,
          questions: request.questions,
          model: this.options.model,
        }, {
          signal,
          timeout: this.options.timeoutMs,
          retry: { maxRetries: 0 },
        })
        const usage = usageFrom(response.usage)
        let parsed: ReturnType<typeof parseQualityAnswers>
        try {
          parsed = parseQualityAnswers({
            model: response.model,
            answers: response.answers,
            usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens },
          }, request.pages.map((page) => page.page))
        } catch (error) {
          tagContractFailure(error)
        }
        return { payload: { actualModel: response.model, verdicts: parsed.verdicts }, usage }
      } catch (error) {
        if (error instanceof QualityContractError) throw error
        if (signal.aborted) {
          throw tagClefErrorCode(new DOMException("TypeSafe quality request cancelled", "AbortError"), "cancelled")
        }
        if (error instanceof Error && error.name === "APITimeoutError") {
          throw new ClefProtocolError("timeout", "TypeSafe quality request timed out")
        }
        if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
          throw new ClefProtocolError("http_status", `TypeSafe quality provider returned HTTP ${error.status}`, { status: error.status })
        }
        if (error instanceof Error && /connection|fetch|network/i.test(error.name + error.message)) {
          throw new ClefProtocolError("transport", "TypeSafe quality provider request failed")
        }
        throw new ClefProtocolError("provider_failure", "TypeSafe quality provider request failed")
      }
    }, { signal: callOptions?.signal, timeoutMs: this.options.timeoutMs, provider: "typesafe" })

    const payload = result.payload as { actualModel: string; verdicts: ReturnType<typeof parseQualityAnswers>["verdicts"] }
    return {
      ruleVersion: input.ruleVersion ?? "pdf-page-quality-v2",
      requestedPages: request.pages.map((page) => page.page),
      verdicts: payload.verdicts,
      usage: result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelId: this.options.model,
      actualModel: payload.actualModel,
      bodyBytes: request.bodyBytes,
      durationMs: performance.now() - startedAt,
    }
  }
}
