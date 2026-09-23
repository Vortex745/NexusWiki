import { createContext, useContext } from "react"

import { useMemories, type MemoryEntry } from "../lib/memory"

export interface MemoryApi {
  memories: MemoryEntry[]
  loaded: boolean
  refresh: () => Promise<void>
  addMemory: (text: string, assistantId?: string) => Promise<void>
  editMemory: (id: string, text: string) => Promise<void>
  deleteMemory: (id: string) => Promise<void>
  clearMemories: () => Promise<void>
}

const MemoryContext = createContext<MemoryApi | null>(null)

/**
 * Holds one copy of the memory list so the hero pill, the header pill and the
 * management dialog all read the same state. The list is the SERVER's
 * (ticket 32) — this context only mirrors it; a refresh re-reads the server.
 */
export function MemoryProvider({ children }: { children: React.ReactNode }) {
  const memory = useMemories()
  return (
    <MemoryContext.Provider
      value={{
        memories: memory.memories,
        loaded: memory.loaded,
        refresh: memory.refresh,
        addMemory: memory.addMemory,
        editMemory: memory.editMemory,
        deleteMemory: memory.deleteMemory,
        clearMemories: memory.clearMemories,
      }}
    >
      {children}
    </MemoryContext.Provider>
  )
}

export function useMemoryApi(): MemoryApi {
  const value = useContext(MemoryContext)
  if (!value) throw new Error("useMemoryApi must be used inside <MemoryProvider>")
  return value
}
