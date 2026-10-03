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
  openEvaluation: () => void
  /** Ticket 08 (KB-04): the knowledge-base workspace (admin). */
  openKnowledge: () => void
  /** Ticket 16 (MODEL-01A): the model-profile settings workspace (admin). */
  openSettings: () => void
  /** Ticket 18 (AST-01A): the assistant workspace (admin). */
  openAssistants: () => void
  /** Ticket 29 (EVAL-02B): the answer-feedback review surface (review/admin). */
  openFeedback: () => void
  /** Ticket 30 (FAQ-01A): the versioned FAQ workspace (admin). */
  openFaqs: () => void
  /** Ticket 13 (DOC-02): the exact document version behind a citation/row. */
  openDocument: (target: DocumentViewTarget) => void
  showToast: (message: string) => void
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
  openEvaluation: noop,
  openKnowledge: noop,
  openSettings: noop,
  openAssistants: noop,
  openFeedback: noop,
  openFaqs: noop,
  openDocument: noop,
  showToast: noop,
})

export const AppShellProvider = AppShellContext.Provider

export function useAppShell(): AppShellActions & AppShellState {
  return useContext(AppShellContext)
}
