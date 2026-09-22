import { createContext, useContext } from "react"

export interface AppShellActions {
  openInsight: (messageId?: string) => void
  openMemory: () => void
  openImport: () => void
  openEvaluation: () => void
  /** Ticket 08 (KB-04): the knowledge-base workspace (admin). */
  openKnowledge: () => void
  showToast: (message: string) => void
}

const noop = () => {}

const AppShellContext = createContext<AppShellActions>({
  openInsight: noop,
  openMemory: noop,
  openImport: noop,
  openEvaluation: noop,
  openKnowledge: noop,
  showToast: noop,
})

export const AppShellProvider = AppShellContext.Provider

export function useAppShell(): AppShellActions {
  return useContext(AppShellContext)
}
