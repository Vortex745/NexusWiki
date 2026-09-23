/**
 * Ticket 34 (TOOL-01A) — the tool-invocation boundary.
 *
 * Every tool a run may execute goes through this one seam, which owns the
 * four bounded properties the ticket pins:
 *
 *  1. Schema: arguments are parsed by a STRICT zod schema — extra fields
 *     (including any attempt to smuggle identity or scope) are rejected, and
 *     only validated data reaches `execute`.
 *  2. Server identity: the environment carries the run's AccessContext and
 *     RetrievalScope; tools read identity/scope from it, never from args.
 *     A request cannot widen what a tool reads.
 *  3. Policy: only tools on the run's explicit allowlist execute; everything
 *     else is refused BEFORE validation touches the tool.
 *  4. Timeout + cancellation: each invocation runs under a linked
 *     AbortController — the run's signal cancels the tool (rethrown as
 *     AbortError so the run converges to its single cancelled terminal), a
 *     deadline expiry surfaces as the bounded "timeout" outcome.
 *
 * Every invocation returns a trace record — outcome, bounded args summary,
 * duration, error — so tool behavior stays visible without leaking content.
 */

import { z } from "zod"
import type { AccessContext } from "../access/context"
import type { RetrievalScope } from "../types/retrieval_scope"

export type ToolInvocationOutcome =
  | "ok"
  | "unknown_tool"
  | "policy_denied"
  | "invalid_args"
  | "timeout"
  | "failed"

/** Per-run resources + authority a tool executes with. */
export interface ToolEnvironment {
  /** The run's AccessContext; absent for scope-less bare callers. */
  accessContext?: AccessContext
  /** The run's server-computed knowledge scope; absent for scope-less callers. */
  retrievalScope?: RetrievalScope
  /** The run's signal — aborting it cancels in-flight tool work. */
  signal?: AbortSignal
  /** Per-run resources tools bind to (e.g. the run's own Searcher). */
  searcher?: unknown
  documentRepo?: unknown
  pageIndexRepo?: unknown
}

export interface ToolTraceRecord {
  tool: string
  /** Bounded, safe summary of the (validated) args. */
  argsSummary: string
  outcome: ToolInvocationOutcome
  durationMs: number
  /** Bounded error reason for non-ok outcomes. */
  error?: string
}

export interface ToolInvocationResult<A = unknown> {
  outcome: ToolInvocationOutcome
  /** Present only when outcome is "ok". */
  result?: A
  trace: ToolTraceRecord
}

export interface ToolDefinition<A, R = unknown> {
  name: string
  description: string
  /** STRICT schema — unknown keys are rejected before execute runs. */
  schema: z.ZodType<A>
  /** Bounded (≤200 chars) one-line summary for traces. */
  summarize(args: A): string
  execute(args: A, env: ToolEnvironment): Promise<R>
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never, unknown>>()

  register<A, R>(definition: ToolDefinition<A, R>): this {
    this.tools.set(definition.name, definition as unknown as ToolDefinition<never, unknown>)
    return this
  }

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }
}

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000

export interface ToolInvocationServiceOptions {
  registry: ToolRegistry
  /** The run's explicit allowlist. Empty → nothing executes. */
  allowedTools: readonly string[]
  /** Per-invocation deadline. Default 30s. */
  timeoutMs?: number
}

function timeoutError(): Error {
  const error = new Error("tool invocation timed out")
  error.name = "ToolTimeoutError"
  return error
}

export class ToolInvocationService {
  private readonly registry: ToolRegistry
  private readonly allowedTools: readonly string[]
  private readonly timeoutMs: number

  constructor(options: ToolInvocationServiceOptions) {
    this.registry = options.registry
    this.allowedTools = options.allowedTools
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  }

  async invoke<A = unknown>(
    rawName: unknown,
    rawArgs: unknown,
    env: ToolEnvironment
  ): Promise<ToolInvocationResult<A>> {
    const started = Date.now()
    const name = typeof rawName === "string" ? rawName : String(rawName ?? "")
    const tool = typeof rawName === "string"
      ? (this.registry.get(rawName) as ToolDefinition<unknown, A> | undefined)
      : undefined
    if (!tool) {
      return {
        outcome: "unknown_tool",
        trace: { tool: name.slice(0, 100), argsSummary: "", outcome: "unknown_tool", durationMs: 0 },
      }
    }
    if (!this.allowedTools.includes(tool.name)) {
      return {
        outcome: "policy_denied",
        trace: {
          tool: tool.name,
          argsSummary: "",
          outcome: "policy_denied",
          durationMs: Date.now() - started,
          error: "tool is not on this run's allowlist",
        },
      }
    }
    const parsed = tool.schema.safeParse(rawArgs ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return {
        outcome: "invalid_args",
        trace: {
          tool: tool.name,
          argsSummary: "",
          outcome: "invalid_args",
          durationMs: Date.now() - started,
          error: `${issue?.path?.join(".") || "args"}: ${issue?.message ?? "validation failed"}`.slice(0, 200),
        },
      }
    }
    const args = parsed.data as A

    // Linked cancellation + REAL deadline: the run's signal OR the deadline
    // aborts the tool's own operations, and the deadline is a race, not
    // advisory — a tool that ignores its signal still converges to the
    // bounded "timeout" outcome instead of hanging the run. User abort
    // rethrows as AbortError (the run's single cancelled terminal).
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    env.signal?.addEventListener("abort", onOuterAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(timeoutError())
      }, this.timeoutMs)
    })
    void deadline.catch(() => {})
    try {
      const pending = tool.execute(args, {
        ...env,
        signal: controller.signal,
      }) as Promise<A>
      // The race's loser may reject late — mark it handled so a signal-blind
      // tool's late failure after a deadline win cannot surface as
      // an unhandled rejection.
      void pending.catch(() => {})
      const result = await Promise.race([pending, deadline])
      return {
        outcome: "ok",
        result,
        trace: {
          tool: tool.name,
          argsSummary: tool.summarize(args).slice(0, 200),
          outcome: "ok",
          durationMs: Date.now() - started,
        },
      }
    } catch (error) {
      if (env.signal?.aborted) throw error
      const timedOut =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "ToolTimeoutError")
      if (timedOut) {
        return {
          outcome: "timeout",
          trace: {
            tool: tool.name,
            argsSummary: tool.summarize(args).slice(0, 200),
            outcome: "timeout",
            durationMs: Date.now() - started,
            error: `exceeded ${this.timeoutMs}ms deadline`,
          },
        }
      }
      return {
        outcome: "failed",
        trace: {
          tool: tool.name,
          argsSummary: tool.summarize(args).slice(0, 200),
          outcome: "failed",
          durationMs: Date.now() - started,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        },
      }
    } finally {
      env.signal?.removeEventListener("abort", onOuterAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * A shared strict-string schema fragment: bounded, non-empty text.
 */
export const boundedQuery = (maxChars: number) =>
  z.string().trim().min(1).max(maxChars)
