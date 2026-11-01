import type { Query } from "./retrieval"

export type RouterDecision = "direct" | "simple" | "ambiguous" | "complex"

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Safe, per-call routing metadata; never stores the query or credentials. */
export interface RoutingModelDetails {
  provider: "chat" | "typesafe" | "clef"
  modelId: string
  actualModel: string
  probabilities: Record<RouterDecision, number>
  confidence: number
  usage: TokenUsage
  durationMs: number
}

export interface RouterCallOptions {
  signal?: AbortSignal
  onDecision?: (details: RoutingModelDetails) => void
}

/** Injected by Runtime so routing services do not depend on run accounting. */
export interface DecisionProviderResult {
  payload: unknown
  usage?: TokenUsage
}

export type DecisionCallExecutor = (
  modelId: string,
  operation: (signal: AbortSignal) => Promise<DecisionProviderResult>,
  options: { signal?: AbortSignal; timeoutMs: number; provider?: "chat" | "typesafe" | "clef" }
) => Promise<DecisionProviderResult>

export interface AgentMessage {
  role: "user" | "assistant" | "system"
  content: string
}

/** Public, concise evidence summary; never an internal reasoning transcript. */
export interface AnswerBasis {
  text: string
  referenceIds: string[]
}

export interface CriticVerdict {
  passed: boolean
  hallucination: boolean
  completeness: boolean
  missingGap?: string
  suggestion?: Query
  answerBasis?: AnswerBasis
}
