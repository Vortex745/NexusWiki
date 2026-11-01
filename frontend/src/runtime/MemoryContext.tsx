import { createContext, useContext } from "react"

import { useMemoryProfile, type MemoryProfileView } from "../lib/memory"
import type { MemorySections } from "../lib/api"

export interface MemoryApi {
  profile: MemoryProfileView
  loaded: boolean
  /** The last read failed; the panel shows it instead of a fake empty state. */
  failed: boolean
  /** Re-read the server (used when the panel opens). */
  refresh: () => Promise<void>
  save: (sections: Partial<MemorySections>) => Promise<void>
  reset: () => Promise<void>
}

const MemoryContext = createContext<MemoryApi | null>(null)

/**
 * Holds the account's one long-term profile so every surface reads the same
 * state. The profile is the SERVER's — this context only mirrors it.
 */
export function MemoryProvider({ children }: { children: React.ReactNode }) {
  const memory = useMemoryProfile()
  return (
    <MemoryContext.Provider
      value={{
        profile: memory.profile,
        loaded: memory.loaded,
        failed: memory.failed,
        refresh: memory.refresh,
        save: memory.save,
        reset: memory.reset,
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
