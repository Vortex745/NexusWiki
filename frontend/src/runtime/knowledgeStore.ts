import { useSyncExternalStore } from "react"

import {
  archiveKnowledgeBase,
  createKnowledgeBase,
  createKnowledgeBaseFolder,
  deleteKnowledgeBaseFolder,
  fetchKnowledgeBaseFolders,
  fetchKnowledgeBases,
  moveKnowledgeBaseToFolder,
  renameKnowledgeBase,
  renameKnowledgeBaseFolder,
  retireKnowledgeBaseContents,
  restoreKnowledgeBase,
  type KnowledgeBaseCommandError,
  type KnowledgeBaseContentWipeResult,
  type KnowledgeBaseFolderPayload,
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
 *
 * 3. Folders: a tenant-shared grouping of bases. Selection stays PER BASE —
 *    checking a folder writes its current members into `selectedIds`, so the
 *    chat request still carries only knowledge-base ids and no folder id ever
 *    reaches the server as a scope.
 */

const SELECTION_STORAGE_KEY = "nexusrag.kb.selection"
const COLLAPSED_STORAGE_KEY = "nexusrag.kb.collapsed"

export type KnowledgeStatus = "idle" | "loading" | "ready" | "error"

export interface KnowledgeSnapshot {
  status: KnowledgeStatus
  /** Exactly what the server returned for this session's role. */
  knowledgeBases: KnowledgeBasePayload[]
  /** Derived: the bases a chat selection may narrow to. */
  activeKnowledgeBases: KnowledgeBasePayload[]
  /** The tenant's folder taxonomy, oldest first. */
  folders: KnowledgeBaseFolderPayload[]
  /** Empty = use the server default; otherwise a narrowing subset. */
  selectedIds: string[]
  /** Whether the sidebar's 知识库 section is folded. */
  collapsed: boolean
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

/**
 * The fold is persisted because a section that reopens on every load is not
 * folded at all. Absent the key, the section starts expanded.
 */
function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

/** The ACTIVE bases one folder currently holds, in the server's list order. */
function folderMemberIds(
  bases: readonly KnowledgeBasePayload[],
  folderId: string,
): string[] {
  return bases.filter((base) => base.status === "active" && base.folderId === folderId).map((base) => base.id)
}

class KnowledgeStore {
  private snapshot: KnowledgeSnapshot = {
    status: "idle",
    knowledgeBases: [],
    activeKnowledgeBases: [],
    folders: [],
    selectedIds: typeof window === "undefined" ? [] : readStoredSelection(),
    collapsed: typeof window === "undefined" ? false : readStoredCollapsed(),
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
      const [knowledgeBases, folders] = await Promise.all([
        fetchKnowledgeBases(),
        fetchKnowledgeBaseFolders(),
      ])
      // Drop selections the session is no longer allowed to see (a base this
      // role cannot list can never be a legal selection).
      const listable = new Set(knowledgeBases.map((base) => base.id))
      const selectedIds = this.snapshot.selectedIds.filter((id) => listable.has(id))
      this.invalidate({
        status: "ready",
        knowledgeBases,
        folders,
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

  /**
   * Check a folder = put its CURRENT members into the selection; uncheck = take
   * the ones it holds now back out. A partly-selected folder flips to fully
   * selected, the way a tri-state parent does everywhere else.
   *
   * The selection stays per base on purpose: a folder id never becomes a
   * retrieval scope, so the chat request, the assistant-bound scope and the
   * conversation-locked scope all keep working on plain knowledge-base ids.
   */
  toggleFolder = (folderId: string): void => {
    const members = folderMemberIds(this.snapshot.activeKnowledgeBases, folderId)
    if (members.length === 0) return
    const selected = new Set(this.snapshot.selectedIds)
    const allOn = members.every((id) => selected.has(id))
    const selectedIds = allOn
      ? this.snapshot.selectedIds.filter((id) => !members.includes(id))
      : [...new Set([...this.snapshot.selectedIds, ...members])]
    this.invalidate({ selectedIds })
    this.persistSelection()
  }

  /** Fold/unfold the sidebar's 知识库 section. Persisted across reloads. */
  toggleCollapsed = (): void => {
    const collapsed = !this.snapshot.collapsed
    this.invalidate({ collapsed })
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0")
    } catch {
      // Private mode: the fold simply does not survive a reload.
    }
  }

  /**
   * Run a workspace command, then re-read the taxonomy EITHER WAY. A command can
   * fail against an id the server no longer holds — the database was rebuilt
   * under an open session, for instance — and a rejected row left on screen is
   * unfixable from there: every retry sends the same dead id. Re-reading after a
   * failure brings the list back in line with the server so the next click acts
   * on something real. (`refresh` swallows its own errors, so it cannot mask the
   * command failure the caller still has to show.)
   */
  private resyncAfter = async <T>(command: () => Promise<T>): Promise<T> => {
    try {
      return await command()
    } finally {
      await this.refresh()
    }
  }

  createFolder = async (name: string): Promise<void> => {
    await this.resyncAfter(() => createKnowledgeBaseFolder(name))
  }

  renameFolder = async (id: string, name: string): Promise<void> => {
    await this.resyncAfter(() => renameKnowledgeBaseFolder(id, name))
  }

  /**
   * Delete a folder. Its members become ungrouped and stay active — and stay
   * SELECTED: a folder delete is a naming change, not a reason to widen or
   * narrow what the next chat searches.
   */
  deleteFolder = async (id: string): Promise<void> => {
    await this.resyncAfter(() => deleteKnowledgeBaseFolder(id))
  }

  /** `null` takes the base out of every folder. See `deleteFolder` on why the
   * selection is left alone when a base moves. */
  moveKnowledgeBase = async (id: string, folderId: string | null): Promise<void> => {
    await this.resyncAfter(() => moveKnowledgeBaseToFolder(id, folderId))
  }

  /**
   * Retire every source of one knowledge base. Irreversible, and the caller is
   * expected to have put a confirmation dialog in front of it already.
   *
   * The selection is NOT pruned: the knowledge base itself stays active and
   * selectable — it simply has nothing in it until the next import.
   */
  wipeContents = async (id: string, reason: string): Promise<KnowledgeBaseContentWipeResult> => {
    return this.resyncAfter(() => retireKnowledgeBaseContents(id, reason))
  }

  create = async (name: string, description?: string): Promise<void> => {
    await this.resyncAfter(() => createKnowledgeBase(name, description))
  }

  rename = async (id: string, name: string): Promise<void> => {
    await this.resyncAfter(() => renameKnowledgeBase(id, name))
  }

  archive = async (id: string): Promise<void> => {
    try {
      await archiveKnowledgeBase(id)
    } finally {
      // An archived base can no longer be part of a legal selection. The prune
      // runs on the failure path too: a 404 here means the base may be gone, and
      // keeping it selected would send a dead id with the next chat.
      this.invalidate({
        selectedIds: this.snapshot.selectedIds.filter((selected) => selected !== id),
      })
      await this.refresh()
      this.persistSelection()
    }
  }

  restore = async (id: string): Promise<void> => {
    await this.resyncAfter(() => restoreKnowledgeBase(id))
  }
}

export const knowledgeStore = new KnowledgeStore()

export type { KnowledgeBaseCommandError }

export function useKnowledgeBases(): KnowledgeSnapshot {
  return useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot)
}
