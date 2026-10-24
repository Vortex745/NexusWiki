/**
 * The Clef wire envelope both callers share: the provider result shape and the token-usage
 * accounting. Validation stays here so a response is either a usable Clef envelope for both
 * the question route and the quality route, or a fault with the same meaning for both.
 */
import { z } from "zod"
import type { TokenUsage } from "../types"

export const CLEF_MODEL_ID = "@cf/cloudflare/clef"

const tokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const clefUsageSchema = z
  .object({ input_tokens: tokenCountSchema, output_tokens: tokenCountSchema })
  .refine((usage) => Number.isSafeInteger(usage.input_tokens + usage.output_tokens))

export const clefProviderResultSchema = z.object({
  model: z.string().min(1).max(128),
  answers: z.unknown().optional(),
  usage: z.unknown().optional(),
})

export const clefEnvelopeSchema = z.object({ success: z.literal(true), result: clefProviderResultSchema })

export type ClefProviderResult = z.infer<typeof clefProviderResultSchema>

export function mapClefUsage(usage: z.infer<typeof clefUsageSchema>): TokenUsage {
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  }
}

export function readClefEnvelope(json: unknown): ClefProviderResult | undefined {
  const envelope = clefEnvelopeSchema.safeParse(json)
  return envelope.success ? envelope.data.result : undefined
}

export function readClefUsage(usage: unknown): TokenUsage | undefined {
  const parsed = clefUsageSchema.safeParse(usage)
  return parsed.success ? mapClefUsage(parsed.data) : undefined
}
