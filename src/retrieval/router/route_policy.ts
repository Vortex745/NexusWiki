import type { RouterDecision } from "../../types"

/**
 * Ticket DR-11 — the ONE product rule both question-route providers follow.
 *
 * The route decision describes what the question ASKS. It must never be a
 * prediction of whether the authorized knowledge base covers the answer:
 * coverage is decided by the evidence retrieval actually returns, so an
 * uncovered but clear factual question is `simple` and ends as an explicit
 * evidence-gap terminal instead of a generic clarification. `ambiguous` is
 * reserved for a question that itself lacks an essential referent or
 * parameter. There is deliberately no domain keyword list here.
 */
export const ROUTE_DECISIONS = [
  "direct",
  "simple",
  "ambiguous",
  "complex",
] as const satisfies readonly RouterDecision[]

export const ROUTE_CRITERIA: Readonly<Record<RouterDecision, string>> = {
  direct: "Greeting, conversational acknowledgment, or non-knowledge conversational request.",
  simple: "Focused factual knowledge question suitable for one retrieval-and-answer path, whether or not the knowledge base covers it.",
  ambiguous: "The question itself lacks an essential referent or parameter, so it cannot be understood without clarification.",
  complex: "Multi-part question, comparison or synthesis that needs decomposition or multiple retrieval steps.",
}

export const ROUTE_CLASSIFICATION_POLICY =
  "Classify the query into exactly one answer route based only on its intent and complexity, never on whether the knowledge base is likely to contain the answer. Coverage is decided later by the evidence that retrieval actually returns. Use ambiguous only when the question itself lacks an essential referent or parameter that prevents understanding; otherwise choose complex for multi-part reasoning or comparison needing decomposition, simple for a focused factual knowledge question, and direct for greetings or conversational acknowledgements without a factual knowledge request."

/** The same closed-set definitions as a bulleted list (Chat's one-word request). */
export function routeCriteriaText(): string {
  return ROUTE_DECISIONS.map((decision) => `- ${decision}: ${ROUTE_CRITERIA[decision]}`).join("\n")
}
