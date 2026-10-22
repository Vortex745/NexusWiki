import { Router, Request, Response } from "express"
import { v4 as uuid } from "uuid"
import type { AnswerRunOptions } from "../answer/generation"
import { AnswerTraceRepository } from "../answer/trace_repository"
import type { AnswerRunEvent, ReasoningCapability, ReasoningEffort } from "../types"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { SqliteSessionBinder } from "../access/session_binder"
import {
  AssistantArchivedError,
  AssistantNotFoundError,
  defaultAssistantId,
  type AssistantRunSnapshot,
  type AssistantService,
} from "../assistants/assistant_service"
import type { RetrievalScopeResolver } from "../retrieval/scope"
import type { RetrievalScope } from "../types/retrieval_scope"
import { resolveScopeOrRespond } from "./scope_http"
import type { TracingRuntime } from "../tracing/contract"
import { requestScope } from "../tracing/express"
import { tracedAnswerSource } from "../tracing/answer_scopes"
import { currentHttpLogContext } from "../logging/http_lifecycle"
import { withAgentRunLogging, type AgentRunLogContext } from "../logging/agent_run_log"
import type { Logger } from "../logging/logger"

interface ChatRequest {
  message: string
  /** Defaults to true. Set to false only for legacy non-streaming clients. */
  stream?: boolean
  runId?: string
  sessionId?: string
  /** Legacy field; ignored — the deployment-configured model is always used. */
  model?: string
  /**
   * Ticket 05 (KB-03A): the caller's knowledge SELECTION — which knowledge
   * bases to search. It is never a storage filter: the server intersects it
   * with the caller's identity and forwards only the result. Absent → the
   * caller's authorized default knowledge base; `[]` → no knowledge context.
   */
  knowledgeBaseIds?: unknown
  /**
   * Ticket 19 (AST-01B): which assistant to run. The id is the ONLY input —
   * prompt, knowledge binding, rerank binding and tool policy all come from
   * the server-stored immutable version, so a request can never enlarge the
   * assistant's scope through raw parameters. Absent → legacy behavior.
   */
  assistantId?: unknown
  /**
   * Ticket 21 (CONV-01B): the run this one REPLACES. Everything recorded for
   * that run and after it — validated memory and history-only turns — is
   * dropped before the run starts, so an edited question or a regenerated
   * answer cannot reuse the branch it replaces. Set by edit and regenerate;
   * absent on a normal send.
   */
  truncateFromRunId?: unknown
  /**
   * Ticket 33 (MEM-01B): false disables long-term memory recall for this
   * run. Narrowing-only: absent/true keeps the default behavior; nothing a
   * request sends can add memories the owner does not have.
   */
  useMemory?: unknown
  /**
   * Ticket 36 (WEB-01): true opts this run into web search (Tavily, keyed
   * server-side). Opt-in only. The request can never supply a key or a URL
   * list — URLs are extracted server-side from the message itself.
   */
  useWeb?: unknown
  /**
   * The run's reasoning-effort request (low | high | max). Received as
   * `unknown` and validated once at this boundary: anything but the exact
   * three values is a 400, and an explicit value on an unsupported
   * endpoint/model is refused rather than silently dropped.
   */
  reasoningEffort?: unknown
}

/**
 * What a router WITHOUT an injected capability answers. A bare mount must
 * behave exactly like an unsupported endpoint: old requests work, an explicit
 * reasoning effort is refused.
 */
const UNSUPPORTED_REASONING_CAPABILITY: ReasoningCapability = Object.freeze({
  supported: false,
  levels: Object.freeze([] as ReasoningEffort[]),
  defaultEffort: null,
  model: null,
})

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "high" || value === "max"
}

function streamPayload(event: AnswerRunEvent, sessionId: string) {
  return {
    sessionId,
    runId: event.runId,
    event,
    ...(event.type === "answer_delta" ? { token: event.token } : {}),
    ...(event.type === "done" ? {
      done: true,
      status: event.result.status,
      references: event.result.references,
      degradation: event.result.degradation,
      // The authoritative value is event.result; this shortcut exists only
      // when the run actually requested a level.
      ...(event.result.requestedReasoningEffort
        ? { requestedReasoningEffort: event.result.requestedReasoningEffort }
        : {}),
    } : {}),
  }
}

/**
 * Source of answer-run events for the HTTP transport. The composition root
 * must inject the Mastra-backed source.
 */
export type AnswerEventsSource = (
  message: string,
  options: AnswerRunOptions
) => AsyncIterable<AnswerRunEvent>

/**
 * T49: createChatRouter only needs traceRepository for the GET /chat/runs/:runId
 * endpoint (reading history). Trace persistence and export fanout are now owned
 * by the Answer run module via AnswerRunObserver — the HTTP route no longer
 * appends events or calls LangfuseExporter.
 *
 * Transport tests inject a stub to verify encoding without live providers.
 */
export function createChatRouter(
  traceRepository: AnswerTraceRepository,
  eventsSource: AnswerEventsSource,
  sessionBinder?: SqliteSessionBinder,
  /**
   * Ticket 05 (KB-03A): the server-side retrieval-scope resolver. The
   * composition root wires it so every chat request runs inside a
   * server-computed knowledge scope. Absent in bare router mounts (transport
   * tests): a request that carries `knowledgeBaseIds` is then rejected rather
   * than silently widened to an unfiltered read.
   */
  retrievalScopeResolver?: RetrievalScopeResolver,
  /**
   * Ticket 19 (AST-01B): the assistant workspace service. When wired, a
   * request may name an `assistantId`; the overlay (prompt/scope/tool/rerank)
   * is resolved server-side from the stored immutable version.
   */
  assistants?: AssistantService,
  /**
   * Ticket 20 (CONV-01A): the server-owned conversation history. When wired,
   * the transport appends the user turn (run start) and the assistant turn
   * (terminal event, with its terminal status) to the caller's directory.
   */
  conversationHistory?: import("../answer/conversation_history_store").SqliteConversationHistoryStore,
  /**
   * LO-09: the neutral tracing runtime. When wired, the run's REAL events
   * drive round/tool/stage spans under the request root. The event stream the
   * client receives is byte-for-byte the same; tracing off or failing cannot
   * change it.
   */
  tracing?: TracingRuntime,
  /**
   * LF-07: the Agent-file logger (Answer run metadata). Injected by the
   * composition root and never built here; absent in bare mounts, where no
   * Agent file is created and the event stream is returned unchanged.
   */
  agentLogger?: Logger,
  /**
   * The composition's frozen reasoning-effort capability. Absent → an
   * unsupported router: GET reports no support and an explicit effort is a
   * 400, while every old request keeps its exact shape.
   */
  reasoningCapability?: ReasoningCapability,
): Router {
  const router = Router()
  const capability = reasoningCapability ?? UNSUPPORTED_REASONING_CAPABILITY

  /** LO-09: stage/round/tool scopes, only when the request root was sampled. */
  const answerSource = (
    res: Response,
  ): AnswerEventsSource =>
    tracing
      ? tracedAnswerSource(eventsSource, () => requestScope(res))
      : eventsSource

  /**
   * LF-07: capture the run's correlation once, at run start. The HTTP log
   * context owns `request_id`; the request root owns `trace_id`/`span_id`.
   * Missing ids stay absent — nothing is minted or guessed.
   */
  const runLogContext = (res: Response, stream: boolean): AgentRunLogContext => {
    const scope = requestScope(res)
    const requestId = currentHttpLogContext()?.requestId
    return {
      ...(requestId ? { requestId } : {}),
      ...(scope?.traceId ? { traceId: scope.traceId } : {}),
      ...(scope?.spanId ? { spanId: scope.spanId } : {}),
      stream,
    }
  }

  // Ticket 21 (CONV-01B): one active run per session, per process. A second
  // run for a session that already has one in flight is refused BEFORE the
  // branch truncation and before any answer work, so two overlapping runs can
  // never interleave rows into the same conversation (or race its branch).
  const activeRuns = new Map<string, string>()

  router.get("/chat/reasoning", (_req: Request, res: Response) => {
    // Composition-time memory only: no provider, model list, MCP, database or
    // filesystem read, and never a value re-derived from the environment.
    res.setHeader("Cache-Control", "no-store")
    res.json(capability)
  })

  router.get("/chat/runs/:runId", (req: Request, res: Response) => {
    const runId = String(req.params.runId)
    const context = (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
    // DR-18: a bound conversation exposes only its owner's run. The directory
    // check still covers runs created before an assistant/KB lock exists.
    const history = sessionBinder
      ? traceRepository.getRunForOwner(runId, context.tenantId, context.subjectId)
      : traceRepository.getRun(runId)
    if (
      !history ||
      (conversationHistory &&
        !conversationHistory.ownsSession(history.sessionId, context.tenantId, context.subjectId))
    ) {
      res.status(404).json({ error: "Answer run not found" })
      return
    }
    res.json(history)
  })

  router.post("/chat", async (req: Request, res: Response) => {
    const {
      message,
      stream: requestedStream,
      runId: requestedRunId,
      sessionId: requestedSessionId,
      knowledgeBaseIds: requestedKnowledgeBaseIds,
      assistantId: requestedAssistantId,
      truncateFromRunId: requestedTruncateFromRunId,
    } = req.body as ChatRequest
    // Default to streaming so legacy callers and the in-app UI get instant
    // token-by-token output without an opt-in field. Explicit false is honored
    // for the non-streaming JSON transport.
    const stream = requestedStream !== false
    if (!message?.trim()) {
      res.status(400).json({ error: "message is required" })
      return
    }

    // The reasoning-effort request is validated HERE, before any session
    // binding, history write, run-slot claim or event source call: a rejected
    // request must leave zero side effects. Shape first, capability second.
    const requestedReasoningEffort = (req.body as ChatRequest).reasoningEffort
    let reasoningEffort: ReasoningEffort | undefined
    if (requestedReasoningEffort !== undefined) {
      if (!isReasoningEffort(requestedReasoningEffort)) {
        res.status(400).json({ error: "reasoningEffort must be one of: low, high, max" })
        return
      }
      if (!capability.supported) {
        res.status(400).json({
          error: "reasoningEffort is not supported by the running model",
        })
        return
      }
      reasoningEffort = requestedReasoningEffort
    }

    const sessionId = typeof requestedSessionId === "string"
      && /^[a-zA-Z0-9-]{1,100}$/.test(requestedSessionId)
      ? requestedSessionId
      : uuid()
    const runId = typeof requestedRunId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(requestedRunId)
      ? requestedRunId
      : uuid()
    if (
      requestedTruncateFromRunId !== undefined &&
      requestedTruncateFromRunId !== null &&
      (typeof requestedTruncateFromRunId !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(requestedTruncateFromRunId))
    ) {
      res.status(400).json({ error: "truncateFromRunId must be a run id" })
      return
    }

    const accessContext: AccessContext =
      (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()

    // Ticket 05 (KB-03A): resolve the caller's knowledge selection into a
    // server-computed RetrievalScope BEFORE any side effect — no session
    // binding and no Answer run on a rejected scope. A missing field selects
    // the caller's authorized DEFAULT knowledge base (never "all knowledge
    // bases"); an explicit `[]` is "no knowledge context"; a malformed
    // selection is a 400 and an unknown or cross-tenant id a 404. The client
    // cannot widen its scope, because the only input it supplies is a set of
    // ids that must already belong to its own tenant.
    let retrievalScope: RetrievalScope | undefined
    if (retrievalScopeResolver) {
      // Ticket 14: the ONE shared HTTP mapping for knowledge-scope
      // resolution — identical statuses, no drift.
      const resolved = resolveScopeOrRespond(res, retrievalScopeResolver, accessContext, requestedKnowledgeBaseIds)
      if (!resolved) return
      retrievalScope = resolved
    } else if (requestedKnowledgeBaseIds !== undefined) {
      // No resolver wired: the server cannot honour a knowledge selection, and
      // ignoring it would answer from knowledge the caller did not ask for.
      res.status(400).json({
        error: "knowledge-base scope is not supported by this deployment",
      })
      return
    }

    // Ticket 19 (AST-01B): resolve the assistant overlay SERVER-side. The
    // request supplies only an id — the prompt, knowledge binding, rerank
    // binding and tool policy come from the stored immutable version, so raw
    // parameters can never enlarge the assistant's scope or enable tools.
    //
    // Ticket 21/23: the DEFAULT assistant is resolved for every request that
    // names none — the session still records which assistant (and version) it
    // ran under, without scanning the workspace.
    let assistantSnapshot: AssistantRunSnapshot | undefined
    let sessionAssistant: { id: string; version: number } | undefined
    const tenantDefaultAssistantId = defaultAssistantId(accessContext.tenantId)
    if (assistants) {
      const namingAssistant = requestedAssistantId !== undefined && requestedAssistantId !== null
      if (namingAssistant && (typeof requestedAssistantId !== "string" || requestedAssistantId.trim().length === 0)) {
        res.status(400).json({ error: "assistantId must be a non-empty string" })
        return
      }
      const assistantId = namingAssistant
        ? (requestedAssistantId as string).trim()
        : tenantDefaultAssistantId
      const assistant =
        assistantId === tenantDefaultAssistantId
          ? assistants.ensureDefault(accessContext.tenantId)
          : assistants.get(assistantId, accessContext.tenantId)
      if (!assistant) {
        res.status(404).json({ error: "assistant not found" })
        return
      }
      if (namingAssistant) {
        // Unknown, cross-tenant and group-invisible are the same 404.
        if (!assistants.visibleTo(assistant, accessContext)) {
          res.status(404).json({ error: "assistant not found" })
          return
        }
        if (assistant.status === "archived") {
          res.status(409).json({ error: "assistant is archived" })
          return
        }
      }
      sessionAssistant = { id: assistantId, version: assistant.version.version }
      // The deterministic default assistant IS the legacy path: its config is
      // the overlay-free shape, so naming it (or omitting the field entirely)
      // preserves existing chat behavior without a second execution engine.
      if (assistantId !== tenantDefaultAssistantId) {
        const config = assistant.version.config
        assistantSnapshot = {
          id: assistant.id,
          version: assistant.version.version,
          systemPrompt: config.systemPrompt,
          rerankModelProfileId: config.rerankModelProfileId,
          toolPolicy: config.toolPolicy,
          memoryEnabled: config.memoryEnabled,
        }
        // Bound scope: the assistant's own binding REPLACES the request's
        // knowledge selection (the request cannot influence it at all — it
        // can neither widen nor narrow the assistant). The binding was
        // validated at save time; re-resolving here re-checks existence and
        // archived state against the caller's identity (404/409 mapped like
        // any selection). An empty binding means "no knowledge context"
        // (ticket 18's contract); toolPolicy "none" forbids retrieval
        // entirely (retrieval is the only tool chat exposes).
        if (config.toolPolicy === "none" || config.knowledgeBaseIds.length === 0) {
          retrievalScope = { knowledgeBaseIds: [] }
        } else if (retrievalScopeResolver) {
          const resolved = resolveScopeOrRespond(
            res,
            retrievalScopeResolver,
            accessContext,
            config.knowledgeBaseIds
          )
          if (!resolved) return
          retrievalScope = resolved
        } else {
          res.status(400).json({
            error: "knowledge-base scope is not supported by this deployment",
          })
          return
        }
      }
    }

    // The legacy `model` field is accepted but ignored — the deployment-
    // configured model (cfg.openaiChatModel) is always used. Trace and export
    // metadata name that configured model, not a per-request override.
    const runOptions: AnswerRunOptions = {
      runId,
      sessionId,
      signal: undefined,
      accessContext: undefined,
      // Ticket 33 (MEM-01B): only an explicit false disables memory recall.
      ...(req.body?.useMemory === false ? { useMemory: false } : {}),
      // Ticket 36 (WEB-01): only an explicit true opts into web search.
      ...(req.body?.useWeb === true ? { useWeb: true } : {}),
      // The frozen reasoning-effort request (absent = never asked).
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(retrievalScope ? { retrievalScope } : {}),
      ...(assistantSnapshot ? { assistant: assistantSnapshot } : {}),
    }

    // Ticket 05 follow-up wiring: bind sessionId → (tenantId, subjectId)
    // before any side effect. The identity comes from the access middleware
    // (res.locals.accessContext) when mounted; otherwise fall back to the
    // single-tenant deterministic identity so the binder always receives a
    // non-empty tenant/subject even in bare-router mode (backward compat).
    // On conflict, return 409 WITHOUT calling eventsSource — no Answer run
    // may be created on a rejected binding (side-effect gating).
    //
    // Ticket 07 P6: the same accessContext is propagated to the Answer run
    // (eventsSource → Mastra runner → Searcher.search) so the
    // retrieval-layer ACL filters (P1-P5) receive a non-undefined context.
    // In single_tenant mode the middleware already injects the deterministic
    // AccessContext, so this wiring is a behavior no-op there; it activates
    // under enforced mode where res.locals.accessContext carries the real
    // tenant/subject/groups resolved by the IdentityAdapter.
    if (sessionBinder) {
      const bindResult = sessionBinder.bindOrCheck(
        sessionId,
        accessContext.tenantId,
        accessContext.subjectId
      )
      if (!bindResult.ok) {
        res.status(409).json({
          error: "session binding conflict",
          sessionId,
          existing: {
            tenantId: bindResult.conflict.existing.tenantId,
            subjectId: bindResult.conflict.existing.subjectId,
          },
        })
        return
      }
    }

    // Ticket 21 (CONV-01B): refuse an overlapping run for this session before
    // the branch truncation and before any answer work. The release runs at
    // the end of every path AND on response close (belt and braces), so a
    // failed request cannot wedge its session.
    if (activeRuns.has(sessionId)) {
      res.status(409).json({ error: "a run is already active for this session", sessionId })
      return
    }
    activeRuns.set(sessionId, runId)
    // Released only AFTER the run converged (the loop ended, the terminal turn
    // was recorded, the response closed). Releasing on `close` would let a new
    // run start while this one is still writing its terminal turn — and a new
    // branch truncation could then be undone by the old run's late write.
    const releaseRun = () => {
      if (activeRuns.get(sessionId) === runId) activeRuns.delete(sessionId)
    }

    // DR-17: an event may only be published by the run/session that produced
    // it. A shared or replayed source that hands this request another
    // session's answer, citation or terminal must never leak it into this
    // response — the same identity rule the run trace already enforces.
    const ownsEvent = (event: AnswerRunEvent): boolean =>
      event.runId === runId &&
      event.sessionId === sessionId &&
      (event.type !== "done" || event.result.runId === runId)

    // Ticket 20 (CONV-01A): server-owned history — the directory is ensured
    // when the run starts (title from the first message). The turns
    // themselves are recorded once the run settles: completed runs are
    // already persisted by the memory layer (validated pairs), so only
    // NON-completed terminals are written to the history-only table.
    if (conversationHistory) {
      try {
        conversationHistory.ensureDirectory(sessionId, accessContext.tenantId, accessContext.subjectId, message)
        // Ticket 21: the first message freezes assistant version and the
        // authorized knowledge subset. A saved session keeps that snapshot
        // even after the assistant is edited or the selection changes.
        const locked = conversationHistory.lockSession(
          sessionId,
          accessContext.tenantId,
          accessContext.subjectId,
          {
            assistantId: sessionAssistant?.id ?? null,
            assistantVersion: sessionAssistant?.version ?? null,
            knowledgeBaseIds: [...(retrievalScope?.knowledgeBaseIds ?? [])],
          }
        )
        // The locked version is authoritative for the whole session: it is
        // re-read from the immutable version store, never from the request.
        // The default assistant contributes no overlay (it IS the legacy
        // path), so a session locked to it keeps legacy behavior.
        if (
          locked.assistantId &&
          locked.assistantVersion != null &&
          assistants &&
          locked.assistantId !== tenantDefaultAssistantId
        ) {
          const version = assistants.getVersion(
            locked.assistantId,
            accessContext.tenantId,
            locked.assistantVersion
          )
          if (version) {
            assistantSnapshot = {
              id: locked.assistantId,
              version: locked.assistantVersion,
              systemPrompt: version.config.systemPrompt,
              rerankModelProfileId: version.config.rerankModelProfileId,
              toolPolicy: version.config.toolPolicy,
              memoryEnabled: version.config.memoryEnabled,
            }
            runOptions.assistant = assistantSnapshot
          }
        }
        if (retrievalScope && locked.knowledgeBaseIds.length > 0 && retrievalScopeResolver) {
          // The locked subset is authoritative: a later request cannot widen
          // it. If it can no longer be resolved (archived/removed base), the
          // run falls back to NO knowledge context instead of the request's
          // selection — fail closed, never widen.
          let lockedScope: RetrievalScope
          try {
            lockedScope = retrievalScopeResolver(accessContext, locked.knowledgeBaseIds)
          } catch {
            lockedScope = { knowledgeBaseIds: [] }
          }
          retrievalScope = lockedScope
          runOptions.retrievalScope = lockedScope
        } else if (retrievalScope && locked.knowledgeBaseIds.length === 0) {
          retrievalScope = { knowledgeBaseIds: [] }
          runOptions.retrievalScope = retrievalScope
        }
        if (
          typeof requestedTruncateFromRunId === "string" &&
          requestedTruncateFromRunId.length > 0
        ) {
          conversationHistory.truncateFromRun(
            sessionId,
            accessContext.tenantId,
            accessContext.subjectId,
            requestedTruncateFromRunId
          )
        }
      } catch (err) {
        console.error("[chat] history write failed:", err)
      }
    }
    const recordTerminal = (
      terminal: Extract<AnswerRunEvent, { type: "done" }> | undefined,
      runFailed: boolean,
      aborted: boolean
    ): void => {
      if (!conversationHistory) return
      try {
        if (terminal && terminal.result.status === "completed") return
        // Ticket 21: a terminal event may only be attached to the run that
        // produced it. A foreign runId (overlapping run, stale stream) is a
        // bug or a forged event — fail closed instead of writing it here.
        if (terminal && terminal.result.runId !== runId) {
          console.error("[chat] terminal event runId does not match the request; not recorded")
          return
        }
        const status = terminal
          ? terminal.result.status
          : aborted
            ? "cancelled"
            : "provider_error"
        conversationHistory.recordUnvalidatedRun(
          sessionId,
          accessContext.tenantId,
          accessContext.subjectId,
          message,
          terminal?.result.reply ?? "",
          terminal?.result.runId ?? runId,
          status
        )
      } catch (err) {
        console.error("[chat] history write failed:", err)
      }
    }

    // Ticket 23 (CORE-01A): the shared answer entry receives IMMUTABLE
    // snapshots — identity, knowledge scope and assistant are frozen here, at
    // the transport, so no layer beneath the entry can widen, swap or mutate
    // the run's authority mid-flight. (The model snapshot is frozen by the
    // entry itself, once per composition.)
    const runSnapshot: AnswerRunOptions = Object.freeze({
      ...runOptions,
      ...(runOptions.retrievalScope
        ? {
            retrievalScope: Object.freeze({
              knowledgeBaseIds: Object.freeze([...runOptions.retrievalScope.knowledgeBaseIds]),
            }),
          }
        : {}),
      ...(runOptions.assistant ? { assistant: Object.freeze({ ...runOptions.assistant }) } : {}),
    })
    const runIdentity: AccessContext = Object.freeze({
      ...accessContext,
      groups: Object.freeze([...accessContext.groups]),
      scopes: Object.freeze([...accessContext.scopes]),
    }) as AccessContext

    const source = withAgentRunLogging(answerSource(res), agentLogger, {
      context: runLogContext(res, stream),
    })

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream")
      res.setHeader("Cache-Control", "no-cache")
      res.setHeader("Connection", "keep-alive")
      res.setHeader("X-Accel-Buffering", "no")

      const clientGone = { value: false }
      const abortController = new AbortController()
      const onClientClose = () => {
        clientGone.value = true
        abortController.abort()
      }
      res.on("close", onClientClose)
      let streamTerminal: Extract<AnswerRunEvent, { type: "done" }> | undefined
      let streamFailed = false
      let sawForeignTerminal = false
      try {
        // The injected source guarantees a terminal event on every path.
        // HTTP only encodes events to SSE.
        for await (const event of source(message, {
          ...runSnapshot,
          signal: abortController.signal,
          accessContext: runIdentity,
        })) {
          if (!ownsEvent(event)) {
            if (event.type === "done") sawForeignTerminal = true
            console.error("[chat] event run/session does not match this request; not published")
            continue
          }
          if (event.type === "done") streamTerminal = event
          if (clientGone.value || res.writableEnded) break
          res.write(`data: ${JSON.stringify(streamPayload(event, sessionId))}\n\n`)
        }
      } catch (err) {
        streamFailed = true
        if (!clientGone.value) console.error("[chat] Error:", err)
      }
      // A foreign terminal means this request produced no terminal of its own;
      // recording one would invent a run, and it was never published.
      if (streamTerminal || !sawForeignTerminal) {
        recordTerminal(streamTerminal, streamFailed, abortController.signal.aborted)
      }
      res.off("close", onClientClose)
      if (!res.writableEnded) res.end()
    } else {
      const clientGone = { value: false }
      const abortController = new AbortController()
      const onClientClose = () => {
        if (res.writableEnded) return
        clientGone.value = true
        abortController.abort()
      }
      const events: AnswerRunEvent[] = []
      let sawForeignTerminal = false
      res.on("close", onClientClose)
      try {
        let terminal: Extract<AnswerRunEvent, { type: "done" }> | undefined
        for await (const event of source(message, {
          ...runSnapshot,
          signal: abortController.signal,
          accessContext: runIdentity,
        })) {
          if (!ownsEvent(event)) {
            if (event.type === "done") sawForeignTerminal = true
            console.error("[chat] event run/session does not match this request; not published")
            continue
          }
          events.push(event)
          if (event.type === "done") terminal = event
        }
        if (!terminal) throw new Error("Answer run ended without a terminal event")
        recordTerminal(terminal, false, abortController.signal.aborted)
        res.json({
          reply: terminal.result.reply,
          sessionId,
          runId: terminal.result.runId,
          status: terminal.result.status,
          references: terminal.result.references,
          degradation: terminal.result.degradation,
          ...(terminal.result.requestedReasoningEffort
            ? { requestedReasoningEffort: terminal.result.requestedReasoningEffort }
            : {}),
          events,
        })
      } catch (err) {
        if (!clientGone.value) console.error("[chat] Error:", err)
        if (!sawForeignTerminal) {
          recordTerminal(undefined, true, abortController.signal.aborted)
        }
        if (!clientGone.value && !res.writableEnded) {
          res.status(500).json({
            error: "Internal error",
            sessionId,
            runId,
            events,
          })
        }
      } finally {
        res.off("close", onClientClose)
      }
    }
    releaseRun()
  })

  return router
}
