import { useCallback, useEffect, useMemo, useState } from "react"

import {
  createMemory as createMemoryApi,
  fetchMemories,
  forgetAllMemories as forgetAllMemoriesApi,
  forgetMemory as forgetMemoryApi,
  updateMemory as updateMemoryApi,
  type ServerMemory,
} from "./api"

/**
 * Ticket 32 (MEM-01A): the browser does NOT own memory anymore. The list is
 * the server's (one owner = the signed-in (tenant, subject)); this module
 * only mirrors it for the UI. The old localStorage copy — including the
 * seed entries that resurrected after every clear — is read by nothing and
 * purged once on load.
 */
export interface MemoryEntry {
  id: string
  text: string
  /** null → applies across assistants; otherwise pinned to one assistant. */
  assistantId: string | null
  createdAt: string
  updatedAt: string
}

const LEGACY_STORAGE_KEY = "kefu_rag_memories"

function fromServer(memory: ServerMemory): MemoryEntry {
  return {
    id: memory.id,
    text: memory.content,
    assistantId: memory.assistantId,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }
}

export function formatMemoryDate(isoString?: string): string {
  if (!isoString) return ""
  try {
    const date = new Date(isoString)
    return `${date.getMonth() + 1}月${date.getDate()}日`
  } catch {
    return ""
  }
}

export function getMemoriesPromptContext(memories: MemoryEntry[]): string {
  if (!memories.length) return ""
  const lines = memories.map((entry, index) => `${index + 1}. ${entry.text}`)
  return `\n\n[持久记忆与偏好]:\n${lines.join("\n")}`
}

export function useMemories() {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const server = await fetchMemories()
      setMemories(server.map(fromServer))
    } catch {
      // The list keeps its last known state; the server stays the source.
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    // One-time purge of the browser-owned copy this feature replaced.
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      // Storage may be blocked; nothing depends on it anymore.
    }
    void refresh()
  }, [refresh])

  const addMemory = useCallback(
    async (text: string, assistantId?: string) => {
      const created = await createMemoryApi(text.trim(), assistantId)
      setMemories((prev) => [fromServer(created), ...prev])
    },
    [],
  )

  const editMemory = useCallback(async (id: string, text: string) => {
    const updated = await updateMemoryApi(id, text.trim())
    setMemories((prev) =>
      prev.map((entry) => (entry.id === id ? fromServer(updated) : entry))
    )
  }, [])

  const deleteMemory = useCallback(async (id: string) => {
    await forgetMemoryApi(id)
    setMemories((prev) => prev.filter((entry) => entry.id !== id))
  }, [])

  const clearMemories = useCallback(async () => {
    await forgetAllMemoriesApi()
    setMemories([])
  }, [])

  return { memories, loaded, refresh, addMemory, editMemory, deleteMemory, clearMemories }
}

export function useMemoryFilter(memories: MemoryEntry[], query: string): MemoryEntry[] {
  return useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return memories
    return memories.filter(
      (entry) =>
        entry.text.toLowerCase().includes(needle) ||
        (entry.assistantId ?? "").toLowerCase().includes(needle),
    )
  }, [memories, query])
}
