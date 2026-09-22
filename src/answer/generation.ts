import type OpenAI from "openai"
import type { AccessContext } from "../access/context"
import type { AgentMessage, AnswerRunEvent } from "../types"
import type { RetrievalScope } from "../types/retrieval_scope"

export interface AnswerModel {
  stream(messages: AgentMessage[], signal?: AbortSignal): AsyncIterable<string>
}

export interface AnswerRunObserver {
  onEvent(event: AnswerRunEvent): void
}

export interface AnswerRunOptions {
  runId?: string
  sessionId?: string
  /**
   * Eval refactor Ticket 01: optional evaluation-case correlation id. When
   * set, it is stamped on every emitted AnswerRunEvent (base.caseId) so
   * injected observers can correlate observation data to run, case, and
   * round. Normal chat never sets it.
   */
  caseId?: string
  signal?: AbortSignal
  accessContext?: AccessContext
  /**
   * Ticket 05 (KB-03A): the server-computed knowledge scope of this run. Set
   * by the transport after it resolved the request's knowledge selection
   * against the caller's identity; omitted by callers that carry no knowledge
   * scope (isolated evaluation runs, release probes).
   */
  retrievalScope?: RetrievalScope
}

export class OpenAIAnswerModel implements AnswerModel {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async *stream(
    messages: AgentMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    }, { signal })

    for await (const chunk of response) {
      const token = chunk.choices[0]?.delta?.content || ""
      if (token) yield token
    }
  }
}
