import { useSyncExternalStore } from "react"

import { fetchAssistants, type AssistantPayload } from "../lib/api"

/**
 * Ticket 19 (AST-01B): which assistant a NEW chat runs through. One store per
 * page (same pattern as the knowledge store). The selected id persists to
 * localStorage; the server resolves everything else — prompt, scope, rerank
 * binding and tool policy come from the stored immutable version, so the
 * browser never carries assistant configuration.
 */

const SELECTION_STORAGE_KEY = "nexusrag.assistant.selection"

export type AssistantStatus = "idle" | "loading" | "ready" | "error"

export interface AssistantSnapshot {
  status: AssistantStatus
  /** Exactly what the server returned for this session's role (safe metadata). */
  assistants: AssistantPayload[]
  /** Empty = legacy default path; otherwise the server overlays the run. */
  selectedId: string | null
  error: string | null
}

function readStoredSelection(): string | null {
  try {
    const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

class AssistantStore {
  private snapshot: AssistantSnapshot = {
    status: "idle",
    assistants: [],
    selectedId: typeof window === "undefined" ? null : readStoredSelection(),
    error: null,
  }

  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): AssistantSnapshot => this.snapshot

  private invalidate(next: Partial<AssistantSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  private persistSelection(): void {
    try {
      window.localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(this.snapshot.selectedId))
    } catch {
      // Storage may be unavailable; the selection then simply does not survive.
    }
  }

  ensureLoaded = (): void => {
    if (this.snapshot.status === "loading" || this.snapshot.status === "ready") return
    void this.refresh()
  }

  refresh = async (): Promise<void> => {
    this.invalidate({ status: "loading", error: null })
    try {
      const assistants = await fetchAssistants()
      // Drop a selection this session is no longer allowed to see.
      const listable = new Set(assistants.map((assistant) => assistant.id))
      const selectedId =
        this.snapshot.selectedId && listable.has(this.snapshot.selectedId)
          ? this.snapshot.selectedId
          : null
      this.invalidate({ status: "ready", assistants, selectedId })
      this.persistSelection()
    } catch (error) {
      this.invalidate({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Select an assistant, or clear the selection (null = legacy default). */
  select = (id: string | null): void => {
    this.invalidate({ selectedId: id })
    this.persistSelection()
  }
}

export const assistantStore = new AssistantStore()

export function useAssistants(): AssistantSnapshot {
  return useSyncExternalStore(assistantStore.subscribe, assistantStore.getSnapshot)
}
