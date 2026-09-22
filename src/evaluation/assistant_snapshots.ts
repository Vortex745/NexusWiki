/**
 * Ticket 28 (EVAL-02A) — immutable assistant configuration snapshots used by
 * the evaluation comparison.
 *
 * Two things live here, both deliberately small:
 *
 * 1. {@link evalAssistantConfigDigest} — the canonical digest of the fields an
 *    evaluation run actually executes with (leading system prompt + rerank
 *    binding). Two snapshots with the same digest always produced their runs
 *    under the same configuration, and a comparison can say so.
 * 2. The built-in comparison pair: the SAME configuration with the dedicated
 *    reranker enabled and disabled. Because the two snapshots differ in
 *    nothing else, a reported difference is attributable to the reranker.
 *
 * Credentials never appear here: an assistant version stores profile ids and a
 * prompt, never a key or a base URL.
 */

import { createHash } from "node:crypto"
import type { EvalAssistantSnapshot } from "./contracts"

/** Digest of the execution-relevant subset of a configuration snapshot. */
export function evalAssistantConfigDigest(config: {
  systemPrompt: string
  rerankModelProfileId: "rerank" | null
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        systemPrompt: config.systemPrompt,
        rerankModelProfileId: config.rerankModelProfileId,
      })
    )
    .digest("hex")
}

export const EVAL_BUILTIN_RERANK_ON_ID = "builtin-rerank-on"
export const EVAL_BUILTIN_RERANK_OFF_ID = "builtin-rerank-off"

/**
 * The built-in Rerank enabled/disabled example (ticket 28 acceptance). Both
 * configurations carry the same (empty) prompt and version 1 — only the rerank
 * binding differs.
 */
export const EVAL_BUILTIN_ASSISTANTS: readonly EvalAssistantSnapshot[] = Object.freeze([
  Object.freeze({
    assistantId: EVAL_BUILTIN_RERANK_ON_ID,
    version: 1,
    name: "Rerank 已启用（内置对照）",
    configDigest: evalAssistantConfigDigest({ systemPrompt: "", rerankModelProfileId: "rerank" }),
    systemPrompt: "",
    rerankModelProfileId: "rerank" as const,
  }),
  Object.freeze({
    assistantId: EVAL_BUILTIN_RERANK_OFF_ID,
    version: 1,
    name: "Rerank 已关闭（内置对照）",
    configDigest: evalAssistantConfigDigest({ systemPrompt: "", rerankModelProfileId: null }),
    systemPrompt: "",
    rerankModelProfileId: null,
  }),
])

/** Built-in snapshot for an id, or undefined when the id is not a built-in. */
export function builtinEvalAssistantSnapshot(
  id: string
): EvalAssistantSnapshot | undefined {
  return EVAL_BUILTIN_ASSISTANTS.find((snapshot) => snapshot.assistantId === id)
}

/**
 * Normalize an untrusted snapshot (built-in or resolved by the API layer from a
 * stored assistant version). Unknown fields are dropped and every field is
 * checked, so nothing from a request can reach a run unvalidated.
 */
export function normalizeEvalAssistantSnapshot(
  input: unknown
): EvalAssistantSnapshot {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("assistant snapshot must be an object")
  }
  const record = input as Record<string, unknown>
  const assistantId = record.assistantId
  const name = record.name
  const systemPrompt = record.systemPrompt ?? ""
  const rerankModelProfileId = record.rerankModelProfileId ?? null
  const version = record.version
  const configDigest = record.configDigest
  const issues: string[] = []
  if (typeof assistantId !== "string" || !assistantId.trim()) {
    issues.push("assistantId must be a non-empty string")
  }
  if (typeof name !== "string") issues.push("name must be a string")
  if (typeof systemPrompt !== "string") issues.push("systemPrompt must be a string")
  if (rerankModelProfileId !== null && rerankModelProfileId !== "rerank") {
    issues.push("rerankModelProfileId must be \"rerank\" or null")
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    issues.push("version must be a positive integer")
  }
  if (typeof configDigest !== "string" || !/^[0-9a-f]{64}$/.test(configDigest)) {
    issues.push("configDigest must be a sha256 hex digest")
  }
  if (issues.length > 0) throw new Error(`invalid assistant snapshot: ${issues.join("; ")}`)
  return {
    assistantId: assistantId as string,
    version: version as number,
    name: name as string,
    configDigest: configDigest as string,
    systemPrompt: systemPrompt as string,
    rerankModelProfileId: rerankModelProfileId as "rerank" | null,
  }
}
