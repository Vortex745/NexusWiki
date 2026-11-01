import { useSyncExternalStore } from "react"

import type { ConversationSnapshot, ConversationStore } from "./store"
import { createConversationStore } from "./store"

/**
 * One store per page. The conversation core persists to localStorage, so this
 * is the single owner of chat state for the lifetime of the document.
 */
export const conversationStore: ConversationStore = createConversationStore()

export type { ConversationSnapshot, ConversationStore }

export function useConversation(): ConversationSnapshot {
  return useSyncExternalStore(conversationStore.subscribe, conversationStore.getSnapshot)
}
