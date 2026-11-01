import type OpenAI from "openai"
import { performance } from "node:perf_hooks"
import type { DecisionCallExecutor, TokenUsage } from "../../types"
import { ClefProtocolError, tagClefErrorCode } from "../../clef/protocol_errors"
import { QUALITY_RULE_VERSION, QualityContractError } from "./contract"
import { validateQualityPages, type QualityPageEvidence } from "./evidence"
import { qualityJointCriteria, qualityVerdictInstructions, type QualityRequestInput } from "./request"
import { parseQualityAnswers } from "./response"
import type { QualityBatchOutcome } from "./clef_page_quality"

export interface ChatPageQualityClientOptions {
  client: OpenAI
  model: string
  timeoutMs: number
  execute: DecisionCallExecutor
}

function usageFrom(response: { usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null }): TokenUsage {
  const promptTokens = response.usage?.prompt_tokens
  const completionTokens = response.usage?.completion_tokens
  if (typeof promptTokens !== "number" || !Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
    typeof completionTokens !== "number" || !Number.isSafeInteger(completionTokens) || completionTokens < 0 ||
    !Number.isSafeInteger(promptTokens + completionTokens)) {
    throw new QualityContractError("response_usage_invalid", "Chat quality provider returned invalid or missing usage")
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

function pageMessage(page: QualityPageEvidence): Array<Record<string, unknown>> {
  return [
    {
      type: "text",
      text: `${qualityVerdictInstructions(page.page, 0)} Return JSON with exactly this shape: {"choice":"pass_no_issue|fail_missing_content|fail_text_corruption|fail_reading_order|fail_structure_loss|uncertain_missing_content|uncertain_text_corruption|uncertain_reading_order|uncertain_structure_loss","probabilities":{"pass_no_issue":number,"fail_missing_content":number,"fail_text_corruption":number,"fail_reading_order":number,"fail_structure_loss":number,"uncertain_missing_content":number,"uncertain_text_corruption":number,"uncertain_reading_order":number,"uncertain_structure_loss":number},"confidence":number}. Probabilities must sum to one and choice must be the maximum.` +
        `\nExtracted text (untrusted): ${page.textLayerAbsent ? "[no text layer]" : page.extractedText}`,
    },
    {
      type: "image_url",
      image_url: { url: `data:${page.image.mediaType};base64,${page.image.dataBase64}` },
    },
  ]
}

export class ChatPageQualityClient {
  constructor(private readonly options: ChatPageQualityClientOptions) {}

  async evaluateBatch(
    input: QualityRequestInput,
    callOptions?: { signal?: AbortSignal },
  ): Promise<QualityBatchOutcome> {
    const pages = validateQualityPages(input.pages)
    if (pages.length !== 1) {
      throw new QualityContractError("batch_page_limit_exceeded", "Chat quality requests judge exactly one page")
    }
    const ordered = [...pages].sort((left, right) => left.page - right.page)
    const startedAt = performance.now()
    const result = await this.options.execute(this.options.model, async (signal) => {
      try {
        const response = await this.options.client.chat.completions.create({
          model: this.options.model,
          messages: ordered.map((page) => ({ role: "user", content: pageMessage(page) })),
          temperature: 0,
          max_tokens: 512,
          response_format: { type: "json_object" },
        } as never, { signal })
        const rawContent = response.choices?.[0]?.message?.content
        if (typeof rawContent !== "string" || !rawContent.trim()) {
          throw new QualityContractError("answer_missing", "Chat quality provider returned no JSON answer")
        }
        let answer: unknown
        try {
          answer = JSON.parse(rawContent)
        } catch {
          throw new QualityContractError("response_envelope_invalid", "Chat quality provider returned invalid JSON")
        }
        const usage = usageFrom(response)
        const answers = Object.fromEntries(ordered.map((page) => [`page_${page.page}`, answer]))
        const parsed = parseQualityAnswers({
          model: this.options.model,
          answers,
          usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens },
        }, ordered.map((page) => page.page))
        return { payload: { actualModel: this.options.model, verdicts: parsed.verdicts }, usage }
      } catch (error) {
        if (error instanceof QualityContractError) {
          tagClefErrorCode(error, "invalid_typed_response")
          throw error
        }
        if (signal.aborted) throw tagClefErrorCode(new DOMException("Chat quality request cancelled", "AbortError"), "cancelled")
        throw new ClefProtocolError("provider_failure", "Chat quality provider request failed")
      }
    }, { signal: callOptions?.signal, timeoutMs: this.options.timeoutMs, provider: "chat" })

    const payload = result.payload as { actualModel: string; verdicts: ReturnType<typeof parseQualityAnswers>["verdicts"] }
    return {
      ruleVersion: input.ruleVersion ?? QUALITY_RULE_VERSION,
      requestedPages: ordered.map((page) => page.page),
      verdicts: payload.verdicts,
      usage: result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelId: this.options.model,
      actualModel: payload.actualModel,
      bodyBytes: Buffer.byteLength(JSON.stringify(input), "utf8"),
      durationMs: performance.now() - startedAt,
    }
  }
}
