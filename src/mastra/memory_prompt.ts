/**
 * Ticket 33 (MEM-01B) — how recalled memories enter a run's prompts.
 *
 * Memory is BACKGROUND, not evidence: it rides the system prompt, clearly
 * labeled as ignorable preference context, and it never becomes a citation —
 * references still come exclusively from retrieval evidence. The label tells
 * the model (and, via the trace, the reader) that memory must not be
 * presented as a factual source.
 */

export interface RecalledMemory {
  id: string
  content: string
}

/** How many memories one run may fold into its prompts. */
export const MEMORY_RECALL_LIMIT = 8

/**
 * The system-prompt suffix carrying the recalled memories, or "" when none.
 * Every knowledge route (simple/complex) and the direct route append this to
 * their system message, so memory behaves identically on all routes.
 */
export function renderMemoryPromptSuffix(memories?: RecalledMemory[]): string {
  if (!memories || memories.length === 0) return ""
  const lines = memories
    .slice(0, MEMORY_RECALL_LIMIT)
    .map((memory, index) => `${index + 1}. ${memory.content}`)
  if (lines.length === 0) return ""
  return `\n\n[用户长期记忆]（以下是该用户的偏好与背景信息，仅供个性化参考。它不是知识库证据，禁止作为事实引用或标注来源）：\n${lines.join("\n")}`
}
