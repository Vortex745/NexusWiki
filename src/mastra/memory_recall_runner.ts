/**
 * Long-term memory (2026-10-30) — bounded, traceable profile recall in front
 * of the route dispatch.
 *
 * Recall rules:
 *  - Scope: the caller's own (tenant, subject) via AccessContext. The store's
 *    read IS the scoping rule; a run can never read another account's profile.
 *  - Disable: `useMemory === false` on the run, or `memoryEnabled === false`
 *    on the assistant version being run, skips recall entirely; ordinary
 *    answering is unaffected.
 *  - Trace: when the profile has content, the output carries `memoryUsed`
 *    (section ids + count). Memory never appears in references — it is not
 *    evidence.
 *  - The profile is written by the owner's edits or by the new-session
 *    summarizer, never by an answer run.
 */

import type { MastraRunner } from "./chat_event_adapter"
import type { RecalledMemory } from "./memory_prompt"
import type { MemoryProfileStore } from "../memory/memory_profile_store"
import type { AccessContext } from "../access/context"

export interface MemoryRecallRunnerDeps {
  /** Absent → pure pass-through (evaluation scopes, probes, no deployment). */
  profiles?: MemoryProfileStore
  resolveTenantId: (accessContext: AccessContext) => string
}

/** The three profile sections as labeled, non-citable prompt lines. */
export function recalledProfileSections(profile: {
  workBackground: string
  personalBackground: string
  recentActivity: string
}): RecalledMemory[] {
  const sections: RecalledMemory[] = []
  if (profile.workBackground.trim()) {
    sections.push({
      id: "memory-profile-work",
      content: `工作背景：${profile.workBackground.trim()}`,
    })
  }
  if (profile.personalBackground.trim()) {
    sections.push({
      id: "memory-profile-personal",
      content: `个人背景：${profile.personalBackground.trim()}`,
    })
  }
  if (profile.recentActivity.trim()) {
    sections.push({
      id: "memory-profile-recent",
      content: `近期动态：${profile.recentActivity.trim()}`,
    })
  }
  return sections
}

export function createMemoryRecallRunner(
  deps: MemoryRecallRunnerDeps,
  inner: MastraRunner
): MastraRunner {
  return async function memoryRecallRunner(input) {
    if (
      !deps.profiles ||
      input.useMemory === false ||
      input.assistant?.memoryEnabled === false ||
      input.signal.aborted
    ) {
      return inner(input)
    }
    const tenantId = deps.resolveTenantId(input.accessContext)
    const profile = deps.profiles.get(tenantId, input.accessContext.subjectId)
    const memories = recalledProfileSections(profile)

    const output = await inner(
      memories.length > 0 ? { ...input, longTermMemories: memories } : input
    )

    if (memories.length > 0) {
      output.memoryUsed = { ids: memories.map(({ id }) => id), count: memories.length }
    }
    return output
  }
}
