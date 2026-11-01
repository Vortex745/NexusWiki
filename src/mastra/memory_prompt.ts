/**
 * Long-term memory (2026-10-30) — how the account profile enters a run's
 * prompts.
 *
 * Memory is BACKGROUND, not evidence: it rides the system prompt, clearly
 * labeled as ignorable personalization context, and it never becomes a
 * citation — references still come exclusively from retrieval evidence. The
 * label tells the model (and, via the trace, the reader) that memory must not
 * be presented as a factual source.
 */

export interface RecalledMemory {
  id: string
  content: string
}

/**
 * Recognise explicit requests to inspect saved long-term memories.
 *
 * This is deliberately narrower than a general "memory" topic classifier:
 * only queries that ask what was saved are diverted away from knowledge
 * retrieval. Questions about how the memory feature works remain ordinary
 * knowledge questions.
 */
export function isLongTermMemoryQuery(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase()
  if (!normalized) return false
  return [
    /长期记忆(?:里|中)?(?:记录|保存|存了|有什么|有啥|内容)/u,
    /(?:查看|看看|提醒我).*(?:长期记忆|记忆)(?:里|中)?(?:记录|保存|存了|有什么|有啥|内容)?/u,
    /(?:你还记得我什么|你记得我什么|我让你记住了什么|你保存了我什么)/u,
    /what(?:'s| is)? in my (?:long[- ]term )?memories/i,
    /what do you remember about me/i,
    /show my saved memories/i,
  ].some((pattern) => pattern.test(normalized))
}

/**
 * The system-prompt suffix carrying the recalled profile sections, or "" when
 * none. Every knowledge route (simple/complex) and the direct route append
 * this to their system message, so memory behaves identically on all routes.
 */
export function renderMemoryPromptSuffix(memories?: RecalledMemory[]): string {
  if (!memories || memories.length === 0) return ""
  const lines = memories.map((memory, index) => `${index + 1}. ${memory.content}`)
  if (lines.length === 0) return ""
  return `\n\n[用户长期记忆]（以下是该用户的工作背景、个人背景与近期动态，仅供个性化参考。它不是知识库证据，禁止作为事实引用或标注来源）：\n${lines.join("\n")}`
}
