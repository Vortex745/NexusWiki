import type OpenAI from "openai"

import type { RetrievalResult } from "../types"
import type { AccessContext } from "../access/context"
import type { RetrievalScope } from "../types/retrieval_scope"
import type { Searcher, SearchOptions, RetrievalChannel } from "./search/interface"
// PT-02 AC06: the loop builds its observation Evidence with the AUTHORITATIVE
// builder, not a local stand-in. The previous local version invented
// `ev_<documentId>_<chunkId>` ids and dropped provenance, so a loop observation
// cited a temporary session attachment — whose `chunk.documentId` IS its
// attachmentId — with an identity the route never publishes, which reads back
// as a knowledge-base document. `../answer/evidence` depends on nothing above
// the retrieval layer, so sharing it introduces no cycle.
import { buildEvidence, citationIdsByChunk } from "../answer/evidence"
// PT-07 AC09 — the loop's observation compression is decided by the SAME shared
// material entry point the knowledge runners use. Importing it here (rather
// than writing a second "does this fit?" rule) is the point of the ticket: the
// loop and the final answer can then never disagree about what the same
// material costs against the same budget. `../answer/context_pipeline` only
// depends on the retrieval/context layer below, so this adds no cycle.
import { prepareGenerationContext } from "../answer/context_pipeline"
import type { ContextCompressor } from "../answer/context_compressor"
import type {
  ContextMaterial,
  ContextMaterialOptions,
} from "./context/assembler"
import {
  RETRIEVAL_TOOLS,
  validateToolArgs,
  resolveToolApplicability,
  toolToSearchOptions,
  type RetrievalToolName,
  type RetrievalToolArgs,
} from "./tool_selector"

/**
 * Ticket 08 — Add bounded complex retrieval loop.
 *
 * Spec §13 (bounded complex retrieval loop): allow complex knowledge
 * questions to alternate between LLM retrieval decisions and bounded
 * observations. The loop may combine complementary read-only tools,
 * accumulate Evidence and stop when it believes coverage is sufficient,
 * while deterministic gates retain final authority.
 *
 * The loop runs only for the complex route when a `ComplexLoopController`
 * is wired into the runner dependencies. Without it, the bounded
 * `planner.decompose` multi-query retrieval flow remains available.
 *
 * Budgets (criterion #1):
 * - at most 3 LLM decision iterations
 * - at most 4 retrieval tool calls per Answer run
 *
 * Stop reasons (criterion #6):
 * - `evidence-sufficient` — LLM declared coverage sufficient (does NOT
 *   bypass Citation/Critic gates — criterion #7)
 * - `iteration-budget` — 3 iterations exhausted
 * - `tool-budget` — 4 tool calls exhausted before iterations
 * - `provider-failure` — searcher.search() threw a non-Abort error
 * - `deterministic-fallback` — loop ended with zero usable results
 */

export const COMPLEX_LOOP_MAX_ITERATIONS = 3
export const COMPLEX_LOOP_MAX_TOOL_CALLS = 4

// ---------------------------------------------------------------------------
// Stop reason (criterion #6)
// ---------------------------------------------------------------------------

export type ComplexLoopStopReason =
  | "evidence-sufficient"
  | "iteration-budget"
  | "tool-budget"
  | "provider-failure"
  | "deterministic-fallback"

// ---------------------------------------------------------------------------
// Loop state (criterion #2)
// ---------------------------------------------------------------------------

export interface NormalizedToolCall {
  tool: RetrievalToolName
  /** Stable dedup key — same key means equivalent tool call (criterion #3). */
  argsKey: string
}

export interface ComplexLoopState {
  /** The original standalone query (contextualized). */
  query: string
  /** Coverage criteria from decomposition (optional). */
  coverageCriteria?: string[]
  /** Tool calls already executed (normalized). */
  priorToolCalls: NormalizedToolCall[]
  /** Bounded observations from prior iterations (compressed context string). */
  observations: string
  /** Accumulated Evidence IDs (criterion #2). */
  accumulatedEvidenceIds: string[]
  /** Remaining iteration budget. */
  remainingIterations: number
  /** Remaining tool call budget. */
  remainingToolCalls: number
}

// ---------------------------------------------------------------------------
// LLM decision (per iteration)
// ---------------------------------------------------------------------------

export interface ComplexLoopDecision {
  /** When true, LLM declares coverage sufficient — loop stops with "evidence-sufficient". */
  sufficient: boolean
  /** Present when sufficient=false. Validated tool name. */
  tool?: RetrievalToolName
  /** Present when sufficient=false. Validated tool args. */
  args?: RetrievalToolArgs
  /** Present when the LLM's choice was invalid and fell back to semantic_lexical_hybrid. */
  fallbackReason?: string
}

export interface ComplexLoopController {
  /**
   * Ask the LLM for the next tool decision given the current loop state.
   * Always returns a decision — falls back to `semantic_lexical_hybrid`
   * with `state.query` on any malformed/absent/forbidden choice (mirrors
   * ToolSelectorImpl's fallback semantics from Ticket 07). AbortError is
   * re-thrown to preserve user-cancellation.
   */
  decide(
    state: ComplexLoopState,
    signal?: AbortSignal
  ): Promise<ComplexLoopDecision>
}

// ---------------------------------------------------------------------------
// Per-tool-call trace (for retrieval events in generation.ts)
// ---------------------------------------------------------------------------

export interface ComplexLoopToolCallTrace {
  tool: RetrievalToolName
  args: RetrievalToolArgs
  argsKey: string
  /** True when this call was a duplicate and skipped (criterion #3). */
  duplicate: boolean
  /** Result count from this call (0 if duplicate). */
  resultCount: number
  /** Channels that were unavailable during this call. */
  unavailableChannels: RetrievalChannel[]
  /** Search call duration in ms (0 if duplicate). */
  durationMs: number
  /** Whether observation compression ran after this call. */
  compressionRan: boolean
  compressionInputTokens?: number
  compressionOutputTokens?: number
  compressionRetainedEvidenceIds?: string[]
  compressionDroppedEvidenceIds?: string[]
  /** Present when the LLM's tool choice was a fallback. */
  fallbackReason?: string
  /**
   * Ticket 34 (TOOL-01A): present when the call did NOT execute because the
   * tool-invocation boundary refused it (unknown tool, not allowlisted,
   * invalid arguments) or bounded it (timeout, failure). Absent for executed
   * calls (outcome ok is implied) and duplicates.
   */
  toolOutcome?: "unknown_tool" | "policy_denied" | "invalid_args" | "timeout" | "failed"
  toolOutcomeError?: string
}

export interface ComplexLoopResult {
  /** All accumulated retrieval results (deduplicated by chunk ID — criterion #4). */
  results: RetrievalResult[]
  /** Per-tool-call metadata for trace events. */
  toolCalls: ComplexLoopToolCallTrace[]
  /** Stop reason (criterion #6). */
  stopReason: ComplexLoopStopReason
  /** Iterations actually executed (counts duplicates). */
  iterationsExecuted: number
  /** Tool calls actually executed (excludes duplicates). */
  toolCallsExecuted: number
  /** Final compressed observation context. */
  finalObservation: string
}

// ---------------------------------------------------------------------------
// Assembler — minimal interface matching ContextAssemblerImpl.assemble
// ---------------------------------------------------------------------------

export interface ComplexLoopAssembler {
  assemble(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>
  ): Promise<string>
  /**
   * PT-07 AC09 — OPTIONAL, exactly like `ContextAssembler.assembleMaterial`:
   * a string-only assembler (the loop's older test fakes, any pre-ticket caller)
   * keeps compiling and keeps the legacy preview accounting, while the real
   * `ContextAssemblerImpl` reports the complete authorized material so the
   * observation's budget decision is made on the real counts.
   */
  assembleMaterial?(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>,
    options?: ContextMaterialOptions
  ): Promise<ContextMaterial>
}

// ---------------------------------------------------------------------------
// Compressor — adapter-friendly interface for bounding observation memory.
// The loop passes accumulated RetrievalResult[] so generation.ts can build
// full Evidence[] (via buildEvidence) before calling ContextCompressor.
// ---------------------------------------------------------------------------

export interface ComplexLoopCompressor {
  compress(
    results: RetrievalResult[],
    query: string,
    budget: { maxContextTokens: number },
    signal?: AbortSignal
  ): Promise<{
    context: string
    inputTokens: number
    outputTokens: number
    retainedEvidenceIds: string[]
    droppedEvidenceIds: string[]
  } | null>
}

/**
 * PT-07 AC01/AC03/AC09/AC10 — the material-backed observation compressor the
 * complex runner supplies to `runComplexLoop`.
 *
 * Before this adapter the loop's observation was compressed on the sum of the
 * 600-character display previews (finding F4): a 30,000-token parent looked
 * cheap, no compression ran, and the tail of the material — where the audited
 * "关键例外" lives — never reached the model that writes the next tool decision.
 *
 * The adapter adds no second rule. It hands the loop's own accumulated results
 * to the ONE shared entry point (`prepareGenerationContext`, PT-06), which
 *   - assembles the complete authorized material through the wired assembler's
 *     `assembleMaterial` when it has one (and falls back to the legacy string
 *     contract, reporting `preview_only`, when it does not);
 *   - triggers compression only when the per-parent candidate windows plus all
 *     fixed framing exceed the SAME budget the final answer is measured against;
 *   - pays no model call when the material already fits;
 *   - returns `null` on every refusal (`all_groups_failed`,
 *     `still_over_budget`, `unknown_citation`, `provider_error`), which is the
 *     loop's documented signal to keep its deterministic observation text;
 *   - re-throws `AbortError`, so a cancelled or budget-exhausted run still
 *     cancels through the same seam.
 *
 * Nothing here touches the loop's iteration/tool-call budgets or its ACL: the
 * adapter is only called at the observation point the loop already had.
 */
export function createComplexLoopObservationCompressor(deps: {
  assembler: ComplexLoopAssembler
  compressor: ContextCompressor
  maxContextTokens?: number
}): ComplexLoopCompressor {
  const maxContextTokens = deps.maxContextTokens ?? 6_000
  return {
    async compress(results, query, budget, signal) {
      const evidence = buildEvidence(results)
      const prepared = await prepareGenerationContext({
        assembler: deps.assembler,
        results,
        citationIds: citationIdsByChunk(evidence),
        evidence,
        query,
        compressor: deps.compressor,
        // Never raised above the run's budget here — the caller's number wins.
        maxContextTokens: budget.maxContextTokens ?? maxContextTokens,
        ...(signal ? { signal } : {}),
      })
      // Only an ADOPTED compression is published to the loop; every refusal
      // leaves `compression` null and the loop keeps its in-budget text.
      return prepared.compression
    },
  }
}

// ---------------------------------------------------------------------------
// Loop entry point
// ---------------------------------------------------------------------------

export interface ComplexLoopDeps {
  controller: ComplexLoopController
  searcher: Searcher
  assembler: ComplexLoopAssembler
  /** Optional compressor for bounding observation memory (criterion #5). */
  compressor?: ComplexLoopCompressor
  /**
   * Ticket 34 (TOOL-01A): the schema-validated tool-invocation boundary.
   * When wired, every loop tool call executes THROUGH it — strict argument
   * validation, the run's allowlist, a per-call deadline and trace records —
   * instead of hitting the searcher directly. Absent → the legacy direct
   * search path (backward compat with pre-ticket callers and tests).
   */
  toolInvoker?: ToolInvoker
}

/**
 * Ticket 34 (TOOL-01A): the loop-facing shape of one validated tool call.
 * `ok` carries the search outcome; every refusal/failure carries a bounded
 * reason and records a trace entry instead of executing.
 */
export type ToolInvoker = (
  call: { tool: RetrievalToolName; args: RetrievalToolArgs }
) => Promise<
  | {
      outcome: "ok"
      results: RetrievalResult[]
      unavailableChannels: RetrievalChannel[]
      observation?: string
    }
  | { outcome: "unknown_tool" | "policy_denied" | "invalid_args" | "timeout" | "failed"; error?: string }
>

export interface ComplexLoopInput {
  query: string
  coverageCriteria?: string[]
  accessContext?: AccessContext
  /** Ticket 05 (KB-03A): server-computed knowledge scope, forwarded to every
   * `searcher.search()` the loop issues. Omitted when the run carries none. */
  retrievalScope?: RetrievalScope
  /**
   * PT-02 (ATT on the complex route): the run's OWN session, forwarded verbatim
   * to every search the loop issues — the loop cannot read another session's
   * attachments and a caller without a session opens no attachment channel.
   * Same option shape as `SearchOptions.attachments`.
   */
  attachments?: { sessionId: string }
  /**
   * PT-03 (WEB on the complex route): the run's explicit web-search opt-in
   * (the transport's `useWeb`), forwarded to every search the loop issues.
   * A URL pasted in the query text still follows the existing read/reject
   * policy either way.
   */
  webRequested?: boolean
  signal?: AbortSignal
  /**
   * Ticket 09 (spec §13 correction-round reuse): remaining iteration budget
   * carried over from a prior loop run (initial complex run). When omitted,
   * defaults to `COMPLEX_LOOP_MAX_ITERATIONS` (3) — the initial-run case.
   * When provided (correction round), the loop respects the reduced budget
   * so the Answer run's total iterations across initial + correction stays
   * within the spec-declared ceiling (criterion #2).
   */
  remainingIterations?: number
  /**
   * Ticket 09: remaining tool-call budget carried over from a prior loop run.
   * Same semantics as `remainingIterations` but for tool calls.
   */
  remainingToolCalls?: number
  /**
   * Ticket 09 (criterion #6): prior normalized tool calls from earlier loop
   * runs in the same Answer run. The loop treats these as already-seen for
   * dedup purposes, so a tool call made in the initial complex run is not
   * repeated in the correction round. When omitted, defaults to `[]`.
   */
  priorToolCalls?: NormalizedToolCall[]
}

// ---------------------------------------------------------------------------
// normalizeToolCall — dedup key (criterion #3)
// ---------------------------------------------------------------------------

/**
 * Build a stable dedup key for a tool call. Two calls are "equivalent"
 * (criterion #3) when they have the same tool name, same normalized query
 * (trim + lowercase + collapse whitespace), and same normalized seed set
 * (deduped + sorted).
 *
 * Equivalent calls are rejected as duplicates without backend execution.
 */
export function normalizeToolCall(
  tool: RetrievalToolName,
  args: RetrievalToolArgs
): NormalizedToolCall {
  const normalizedQuery = args.query.trim().toLowerCase().replace(/\s+/g, " ")
  const seeds =
    args.seeds && args.seeds.length > 0
      ? [...new Set(args.seeds.map((s) => s.trim()).filter((s) => s.length > 0))].sort()
      : []
  const argsKey =
    seeds.length > 0
      ? `q=${normalizedQuery};s=${seeds.join(",")}`
      : `q=${normalizedQuery}`
  return { tool, argsKey }
}

// ---------------------------------------------------------------------------
// STOP_LOOP_TOOL — additional function for the LLM to declare sufficiency
// ---------------------------------------------------------------------------

const STOP_LOOP_TOOL = {
  type: "function" as const,
  function: {
    name: "stop_loop" as const,
    description:
      "Stop the retrieval loop because the accumulated observations already cover the user's question. " +
      "This does NOT bypass downstream Citation/Critic gates — they still run after the loop terminates.",
    parameters: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string" as const,
          enum: ["evidence-sufficient"] as const,
          description: "The reason for stopping the loop.",
        },
      },
      required: ["reason"],
      additionalProperties: false as const,
    },
  },
}

const COMPLEX_LOOP_TOOLS = [...RETRIEVAL_TOOLS,
  ...["wiki_search", "wiki_read_page"].map((name) => ({ type: "function" as const,
    function: { name, description: name === "wiki_search"
      ? "Search Wiki topics and retrieve their original source evidence."
      : "Read a Wiki page and its original evidence. query must be an exact page slug returned by wiki_search.",
    parameters: { type: "object", properties: { query: { type: "string" } },
      required: ["query"], additionalProperties: false } } })), STOP_LOOP_TOOL]

const COMPLEX_LOOP_SYSTEM_PROMPT =
  "You are a retrieval planner for a knowledge-grounded answer system. " +
  "Your job is to drive a bounded retrieval loop by choosing ONE action per turn: " +
  "either call a retrieval tool to gather more Evidence, or call stop_loop when the " +
  "accumulated observations already cover the user's question.\n\n" +
  "Available retrieval tools (call ONE per turn):\n" +
  "- semantic_lexical_hybrid({query}): vector + BM25 hybrid search — best for factual/keyword queries\n" +
  "- graph_navigation({query, seeds?}): knowledge-graph traversal — best for multi-hop relational queries\n" +
  "- pageindex_hierarchy({query}): PageIndex hierarchical lookup — ONLY for questions naming a page, section, chapter, or table-of-contents location; definitional, conceptual and general-procedure questions use semantic_lexical_hybrid\n\n" +
  "- wiki_search({query}): search reusable Wiki topics and their source evidence\n" +
  "- wiki_read_page({query}): read a Wiki page using its exact slug from wiki_search\n\n" +
  "Stop tool:\n" +
  "- stop_loop({reason: \"evidence-sufficient\"}): stop the loop because observations cover the question. " +
  "NOTE: this does NOT bypass downstream Citation/Critic gates — they still run after the loop terminates.\n\n" +
  "Rules:\n" +
  "- Do NOT repeat a tool call with equivalent arguments you have already made.\n" +
  "- If observations cover the question, call stop_loop.\n" +
  "- If you need more evidence, call ONE retrieval tool with a focused query."

function formatLoopStateForLLM(state: ComplexLoopState): string {
  const lines: string[] = []
  lines.push(`Question: ${state.query}`)
  lines.push(`Coverage criteria: ${state.coverageCriteria?.join("; ") ?? "none"}`)
  lines.push(
    `Prior tool calls: ${
      state.priorToolCalls.length === 0
        ? "none"
        : state.priorToolCalls.map((c) => `${c.tool}(${c.argsKey})`).join("; ")
    }`
  )
  lines.push(`Remaining iteration budget: ${state.remainingIterations}`)
  lines.push(`Remaining tool call budget: ${state.remainingToolCalls}`)
  lines.push("")
  lines.push("Observations from prior iterations:")
  lines.push(state.observations || "(none yet — this is the first iteration)")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// ComplexLoopControllerImpl — LLM call with function-calling
// ---------------------------------------------------------------------------

export class ComplexLoopControllerImpl implements ComplexLoopController {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async decide(
    state: ComplexLoopState,
    signal?: AbortSignal
  ): Promise<ComplexLoopDecision> {
    let res
    try {
      res = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: COMPLEX_LOOP_SYSTEM_PROMPT },
            { role: "user", content: formatLoopStateForLLM(state) },
          ],
          tools: COMPLEX_LOOP_TOOLS,
          tool_choice: "auto",
        },
        signal ? { signal } : undefined
      )
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      // Non-Abort: fallback to semantic_lexical_hybrid with state.query
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `controller_error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }

    const toolCall = res.choices?.[0]?.message?.tool_calls?.[0]
    if (!toolCall || toolCall.type !== "function") {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: "no_tool_call",
      }
    }

    const toolName = toolCall.function?.name

    // stop_loop → sufficient=true
    if (toolName === "stop_loop") {
      return { sufficient: true }
    }

    // Retrieval tool — validate via existing validateToolArgs (Ticket 07)
    if (!isKnownToolName(toolName)) {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `unknown_tool: ${String(toolName)}`,
      }
    }

    let parsedArgs: unknown
    try {
      parsedArgs = JSON.parse(toolCall.function?.arguments || "{}")
    } catch {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `malformed_arguments: ${toolName}`,
      }
    }

    const validatedArgs = validateToolArgs(toolName, parsedArgs)
    if (!validatedArgs) {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `invalid_arguments: ${toolName}`,
      }
    }

    return {
      sufficient: false,
      tool: toolName,
      args: validatedArgs,
    }
  }
}

// ---------------------------------------------------------------------------
// runComplexLoop — the bounded orchestrator (criterion #1)
// ---------------------------------------------------------------------------

/**
 * Run the bounded complex retrieval loop.
 *
 * Iterations: at most `COMPLEX_LOOP_MAX_ITERATIONS` (3).
 * Tool calls: at most `COMPLEX_LOOP_MAX_TOOL_CALLS` (4).
 *
 * Each iteration:
 * 1. Call `controller.decide(state)` — LLM picks next tool OR declares sufficient
 * 2. If sufficient → stop with "evidence-sufficient" (criterion #7 — does NOT bypass gates)
 * 3. Normalize tool call → dedup check (criterion #3)
 * 4. If duplicate → skip execution, continue (don't consume tool budget)
 * 5. If tool budget exhausted → stop with "tool-budget"
 * 6. Execute via `searcher.search()` with `toolToSearchOptions` + accessContext
 * 7. Accumulate results (dedupe by chunk ID — criterion #4)
 * 8. Build observation context (assembler + optional compressor — criterion #5)
 * 9. Update state.observations, state.priorToolCalls, state.accumulatedEvidenceIds
 *
 * AbortError propagates from any step to preserve user-cancellation.
 * Non-Abort searcher error → stop with "provider-failure".
 * Non-Abort controller/compressor error → swallowed (fallback to deterministic).
 */
export async function runComplexLoop(
  deps: ComplexLoopDeps,
  input: ComplexLoopInput
): Promise<ComplexLoopResult> {
  const state: ComplexLoopState = {
    query: input.query,
    ...(input.coverageCriteria ? { coverageCriteria: input.coverageCriteria } : {}),
    // Ticket 09: carry over prior tool calls for cross-loop dedup (criterion #6).
    // Default to empty for the initial complex run; correction rounds pass the
    // accumulated dedup set so a tool call made in the initial run is not
    // repeated in correction.
    priorToolCalls: input.priorToolCalls ? [...input.priorToolCalls] : [],
    observations: "",
    accumulatedEvidenceIds: [],
    // Ticket 09: carry over remaining budgets from a prior loop run
    // (criterion #2 — correction shares the Answer run's total budgets).
    // Default to the full ceilings for the initial complex run.
    remainingIterations:
      input.remainingIterations ?? COMPLEX_LOOP_MAX_ITERATIONS,
    remainingToolCalls:
      input.remainingToolCalls ?? COMPLEX_LOOP_MAX_TOOL_CALLS,
  }

  const toolCalls: ComplexLoopToolCallTrace[] = []
  const accumulatedResults: RetrievalResult[] = []
  const toolObservations: string[] = []
  let stopReason: ComplexLoopStopReason = "iteration-budget"
  let finalObservation = ""
  let iterationsExecuted = 0
  let toolCallsExecuted = 0

  while (state.remainingIterations > 0) {
    // 1. LLM decision
    let decision: ComplexLoopDecision
    try {
      decision = await deps.controller.decide(state, input.signal)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      // Controller threw non-Abort (defensive — impl catches, but be safe)
      stopReason = "provider-failure"
      break
    }

    // Consume iteration budget (criterion #1)
    state.remainingIterations -= 1
    iterationsExecuted += 1

    // 2. LLM declares sufficient → stop (criterion #7 — does NOT bypass gates)
    if (decision.sufficient) {
      stopReason = "evidence-sufficient"
      break
    }

    // 3. Executor-side applicability gate (DR-12): the same intent semantics
    // the prompts state, applied BEFORE this iteration can call any tool. An
    // inapplicable PageIndex pick becomes the default hybrid tool with the
    // original query, so the misselection never reaches a provider.
    const applicable = resolveToolApplicability({
      tool: decision.tool!,
      args: decision.args!,
    })
    const tool = applicable.selection.tool
    const args = applicable.selection.args
    const fallbackReason = applicable.reason ?? decision.fallbackReason

    // 4. Normalize + dedup check (criterion #3)
    const normalized = normalizeToolCall(tool, args)
    const isDuplicate = state.priorToolCalls.some(
      (c) => c.tool === normalized.tool && c.argsKey === normalized.argsKey
    )

    if (isDuplicate) {
      // Reject as duplicate without backend execution (criterion #3).
      // Don't consume tool budget; do consume iteration budget (loop progresses).
      toolCalls.push({
        tool,
        args,
        argsKey: normalized.argsKey,
        duplicate: true,
        resultCount: 0,
        unavailableChannels: [],
        durationMs: 0,
        compressionRan: false,
        ...(fallbackReason ? { fallbackReason } : {}),
      })
      continue
    }

    // 5. Tool budget check
    if (state.remainingToolCalls <= 0) {
      stopReason = "tool-budget"
      // Don't record the call since we didn't execute
      break
    }

    // 6. Execute retrieval — through the schema-validated tool boundary when
    // wired (ticket 34); legacy direct search otherwise. A refusal
    // (unknown/policy/invalid args) records a trace entry and lets the loop
    // continue so the LLM can correct; a bounded failure (timeout/failed)
    // stops the loop with the traceable provider-failure terminal.
    const searchStartedAt = Date.now()
    let outcome
    if (deps.toolInvoker) {
      const invocation = await deps.toolInvoker({ tool, args })
      if (invocation.outcome !== "ok") {
        const bounded =
          invocation.outcome === "timeout" || invocation.outcome === "failed"
        toolCalls.push({
          tool,
          args,
          argsKey: normalized.argsKey,
          duplicate: false,
          resultCount: 0,
          unavailableChannels: [],
          durationMs: Date.now() - searchStartedAt,
          compressionRan: false,
          toolOutcome: invocation.outcome,
          ...(invocation.error ? { toolOutcomeError: invocation.error.slice(0, 200) } : {}),
        })
        if (bounded) {
          stopReason = "provider-failure"
          break
        }
        continue
      }
      outcome = {
        results: invocation.results,
        unavailableChannels: invocation.unavailableChannels,
      }
      if (invocation.observation) toolObservations.push(invocation.observation.slice(0, 4000))
    } else {
      try {
        const searchOptions: SearchOptions = {
          ...toolToSearchOptions({ tool, args }),
          ...(input.accessContext ? { accessContext: input.accessContext } : {}),
          // Ticket 05 (KB-03A): every loop iteration stays inside the run's
          // server-computed knowledge scope.
          ...(input.retrievalScope ? { retrievalScope: input.retrievalScope } : {}),
          // PT-02 / PT-03: the loop's own searches read the run's session and
          // carry its web intent, so the first retrieval, every tool iteration
          // and a gap re-check all use the SAME bound identity — never a
          // rebuilt, wider one. PT-02 AC04/AC06, PT-03 AC06.
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.webRequested === true ? { webRequested: true } : {}),
          // P7.2: the run's cancellation reaches each retrieval stage.
          ...(input.signal ? { signal: input.signal } : {}),
        }
        outcome = await deps.searcher.search({ text: args.query }, searchOptions)
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        stopReason = "provider-failure"
        break
      }
    }
    const durationMs = Date.now() - searchStartedAt

    // Consume tool budget (criterion #1)
    state.remainingToolCalls -= 1
    toolCallsExecuted += 1

    // Record in priorToolCalls (for future dedup checks)
    state.priorToolCalls.push(normalized)

    // 7. Accumulate results (dedupe by chunk ID — criterion #4)
    for (const r of outcome.results) {
      const key = `${r.chunk.documentId}\0${r.chunk.id}`
      if (
        !accumulatedResults.some(
          (existing) =>
            `${existing.chunk.documentId}\0${existing.chunk.id}` === key
        )
      ) {
        accumulatedResults.push(r)
      }
    }

    // 8. Build observation context (deterministic + compressed — criterion #5)
    //
    // PT-02 AC06: the loop cites with the AUTHORITATIVE Evidence identity
    // (`buildEvidence`), not a locally invented `ev_<documentId>_<chunkId>`.
    // A loop observation whose ids drift from the ids the route publishes
    // resolves a temporary attachment (whose `documentId` IS its
    // attachmentId) as if it were a knowledge-base document.
    const evidence = buildEvidence(accumulatedResults)
    state.accumulatedEvidenceIds = evidence.map((e) => e.id)

    let observationContext: string
    try {
      const citationIds = citationIdsByChunk(evidence)
      observationContext = await deps.assembler.assemble(accumulatedResults, citationIds)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      // Assembler failed — use a minimal deterministic fallback
      observationContext = accumulatedResults
        .map((r) => r.chunk.content)
        .join("\n\n")
    }

    let compressionRan = false
    let compressionInputTokens: number | undefined
    let compressionOutputTokens: number | undefined
    let compressionRetainedEvidenceIds: string[] | undefined
    let compressionDroppedEvidenceIds: string[] | undefined

    if (deps.compressor) {
      try {
        const result = await deps.compressor.compress(
          accumulatedResults,
          input.query,
          { maxContextTokens: 6_000 },
          input.signal
        )
        if (result) {
          observationContext = result.context
          compressionRan = true
          compressionInputTokens = result.inputTokens
          compressionOutputTokens = result.outputTokens
          compressionRetainedEvidenceIds = result.retainedEvidenceIds
          compressionDroppedEvidenceIds = result.droppedEvidenceIds
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        // non-Abort: swallow, use deterministic context (criterion #5 fallback)
      }
    }

    // 9. Update state
    state.observations = [...toolObservations, observationContext].join("\n\n")
    finalObservation = state.observations

    toolCalls.push({
      tool,
      args,
      argsKey: normalized.argsKey,
      duplicate: false,
      resultCount: outcome.results.length,
      unavailableChannels: outcome.unavailableChannels,
      durationMs,
      compressionRan,
      ...(compressionInputTokens !== undefined ? { compressionInputTokens } : {}),
      ...(compressionOutputTokens !== undefined ? { compressionOutputTokens } : {}),
      ...(compressionRetainedEvidenceIds !== undefined
        ? { compressionRetainedEvidenceIds }
        : {}),
      ...(compressionDroppedEvidenceIds !== undefined
        ? { compressionDroppedEvidenceIds }
        : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
    })
  }

  // Deterministic-fallback: loop ended with zero usable results
  if (
    accumulatedResults.length === 0 &&
    (stopReason === "iteration-budget" || stopReason === "tool-budget")
  ) {
    stopReason = "deterministic-fallback"
  }

  return {
    results: accumulatedResults,
    toolCalls,
    stopReason,
    iterationsExecuted,
    toolCallsExecuted,
    finalObservation,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isKnownToolName(name: unknown): name is RetrievalToolName {
  return (
    name === "semantic_lexical_hybrid" ||
    name === "graph_navigation" ||
    name === "pageindex_hierarchy" || name === "wiki_search" || name === "wiki_read_page"
  )
}
