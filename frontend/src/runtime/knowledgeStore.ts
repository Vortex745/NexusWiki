import { useSyncExternalStore } from "react"

import {
  archiveKnowledgeBase,
  createKnowledgeBase,
  fetchKnowledgeBases,
  renameKnowledgeBase,
  restoreKnowledgeBase,
  type KnowledgeBaseCommandError,
  type KnowledgeBasePayload,
} from "../lib/api"

/**
 * Ticket 08 (KB-04): the workspace knowledge-base state — one store per page
 * (the same pattern as the conversation store).
 *
 * Two concerns live here:
 *
 * 1. Browse: the server returns active bases for a reader and all bases for
 *    an admin. Loading/empty/error are explicit states so the workspace and
 *    the selector can render each of them.
 *
 * 2. Selection: which of the ACTIVE bases a NEW chat may search. An empty
 *    selection means "the server's default behavior" (the tenant's default
 *    base) — never "all bases"; the selection only ever narrows, and the
 *    server validates every id against the session's tenant anyway. The
 *    selection persists to localStorage so a reload keeps it.
 */

const SELECTION_STORAGE_KEY = "nexusrag.kb.selection"

export type KnowledgeStatus = "idle" | "loading" | "ready" | "error"

export interface KnowledgeSnapshot {
  status: KnowledgeStatus
  /** Exactly what the server returned for this session's role. */
  knowledgeBases: KnowledgeBasePayload[]
  /** Derived: the bases a chat selection may narrow to. */
  activeKnowledgeBases: KnowledgeBasePayload[]
  /** Empty = use the server default; otherwise a narrowing subset. */
  selectedIds: string[]
  error: string | null
}

function readStoredSelection(): string[] {
  try {
    const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

class KnowledgeStore {
  private snapshot: KnowledgeSnapshot = {
    status: "idle",
    knowledgeBases: [],
    activeKnowledgeBases: [],
    selectedIds: typeof window === "undefined" ? [] : readStoredSelection(),
    error: null,
  }

  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): KnowledgeSnapshot => this.snapshot

  private invalidate(next: Partial<KnowledgeSnapshot>): void {
    const knowledgeBases = next.knowledgeBases ?? this.snapshot.knowledgeBases
    this.snapshot = {
      ...this.snapshot,
      ...next,
      knowledgeBases,
      activeKnowledgeBases: knowledgeBases.filter(
        (base) => base.status === "active",
      ),
    }
    for (const listener of this.listeners) listener()
  }

  private persistSelection(): void {
    try {
      window.localStorage.setItem(
        SELECTION_STORAGE_KEY,
        JSON.stringify(this.snapshot.selectedIds),
      )
    } catch {
      // Storage may be unavailable (private mode); the selection then simply
      // does not survive a reload.
    }
  }

  /** Fetch the list once per page unless a command already refreshed it. */
  ensureLoaded = (): void => {
    if (this.snapshot.status === "loading" || this.snapshot.status === "ready") return
    void this.refresh()
  }

  refresh = async (): Promise<void> => {
    this.invalidate({ status: "loading", error: null })
    try {
      const knowledgeBases = await fetchKnowledgeBases()
      // Drop selections the session is no longer allowed to see (a base this
      // role cannot list can never be a legal selection).
      const listable = new Set(knowledgeBases.map((base) => base.id))
      const selectedIds = this.snapshot.selectedIds.filter((id) => listable.has(id))
      this.invalidate({
        status: "ready",
        knowledgeBases,
        selectedIds,
      })
      this.persistSelection()
    } catch (error) {
      this.invalidate({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  toggleSelected = (id: string): void => {
    const selectedIds = this.snapshot.selectedIds.includes(id)
      ? this.snapshot.selectedIds.filter((selected) => selected !== id)
      : [...this.snapshot.selectedIds, id]
    this.invalidate({ selectedIds })
    this.persistSelection()
  }

  create = async (name: string, description?: string): Promise<void> => {
    await createKnowledgeBase(name, description)
    await this.refresh()
  }

  rename = async (id: string, name: string): Promise<void> => {
    await renameKnowledgeBase(id, name)
    await this.refresh()
  }

  archive = async (id: string): Promise<void> => {
    await archiveKnowledgeBase(id)
    // An archived base can no longer be part of a legal selection.
    this.invalidate({
      selectedIds: this.snapshot.selectedIds.filter((selected) => selected !== id),
    })
    await this.refresh()
    this.persistSelection()
  }

  restore = async (id: string): Promise<void> => {
    await restoreKnowledgeBase(id)
    await this.refresh()
  }
}

export const knowledgeStore = new KnowledgeStore()

export type { KnowledgeBaseCommandError }

export function useKnowledgeBases(): KnowledgeSnapshot {
  return useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot)
}
