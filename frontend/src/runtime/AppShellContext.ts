import { createContext, useContext } from "react"

export interface DocumentViewTarget {
  documentId: string
  chunkId?: string
}

export interface AppShellActions {
  /** Opens the 执行链路 panel pinned to one answer; clicking it again closes it. */
  openTrace: (messageId: string) => void
  openMemory: () => void
  openImport: () => void
  /** Ticket 08 (KB-04): the knowledge-base workspace (admin). */
  openKnowledge: () => void
  /** Ticket 16 (MODEL-01A): the model-profile settings workspace (admin). */
  openSettings: () => void
  /** Ticket 18 (AST-01A): the assistant workspace (admin). */
  openAssistants: () => void
  /** AC-02 (admin console): the fullscreen operator console. */
  openAdmin: () => void
  /** Ticket 13 (DOC-02): the exact document version behind a citation/row. */
  openDocument: (target: DocumentViewTarget) => void
  showToast: (message: string, tone?: "success" | "error") => void
}

/** Shell STATE alongside the actions: projections the sidebar renders. */
export interface AppShellState {
  /** Ticket 08: import rows still owing an outcome — the 导入中 N badge. */
  activeImportCount: number
}

const noop = () => {}

const AppShellContext = createContext<AppShellActions & AppShellState>({
  activeImportCount: 0,
  openTrace: noop,
  openMemory: noop,
  openImport: noop,
  openKnowledge: noop,
  openSettings: noop,
  openAssistants: noop,
  openAdmin: noop,
  openDocument: noop,
  showToast: noop,
})

export const AppShellProvider = AppShellContext.Provider

export function useAppShell(): AppShellActions & AppShellState {
  return useContext(AppShellContext)
}
