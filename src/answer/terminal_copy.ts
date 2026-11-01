import type { AnswerTerminalStatus } from "../types/answer"

// ---------------------------------------------------------------------------
// PL-01: the public text of a knowledge answer that was NOT approved.
// A draft that failed the Critic is never published — the reply a client sees
// is chosen by the BUSINESS terminal status, independently of transport success.
// Both transports (SSE `done.reply` and JSON `reply`) read the same map, so a
// route can never disagree with itself by transport.
// ---------------------------------------------------------------------------

export const INSUFFICIENT_RETRIEVAL_MESSAGE =
  "未检索到足够的可用资料，请补充资料或调整问题。"
export const INSUFFICIENT_EVIDENCE_MESSAGE =
  "现有证据不足以支持可靠回答，请补充资料或调整问题。"
export const INVALID_CITATION_MESSAGE = "回答引用无法验证，请重试。"
export const PROVIDER_ERROR_MESSAGE = "服务暂时不可用，请稍后重试。"
export const CANCELLED_MESSAGE = "本次回答已取消。"
export const HANDOFF_MESSAGE = "当前资料不足以形成可靠回答，已转交人工处理。"
/** A status the running protocol does not define: publish no facts at all. */
export const UNCONFIRMED_MESSAGE = "无法确认本次回答的结果，请重试。"

/**
 * Terminals whose reply is the approved answer itself (clarification asks a
 * question, completion carries the validated draft). Every other terminal must
 * publish `publicTerminalCopy` instead of whatever the draft said.
 */
export function isDraftPublishable(status: AnswerTerminalStatus): boolean {
  return status === "completed" || status === "clarification_required"
}

export function publicTerminalCopy(status: AnswerTerminalStatus): string {
  switch (status) {
    case "insufficient_retrieval":
      return INSUFFICIENT_RETRIEVAL_MESSAGE
    case "insufficient_evidence":
      return INSUFFICIENT_EVIDENCE_MESSAGE
    case "invalid_citation":
      return INVALID_CITATION_MESSAGE
    case "provider_error":
      return PROVIDER_ERROR_MESSAGE
    case "cancelled":
      return CANCELLED_MESSAGE
    case "handoff_required":
      return HANDOFF_MESSAGE
    default:
      return UNCONFIRMED_MESSAGE
  }
}
