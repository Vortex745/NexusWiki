import { createContext, useContext } from "react"

export interface AppShellActions {
  openInsight: (messageId?: string) => void
  openMemory: () => void
  openImport: () => void
  openEvaluation: () => void
  showToast: (message: string) => void
}

const noop = () => {}

const AppShellContext = createContext<AppShellActions>({
  openInsight: noop,
  openMemory: noop,
  openImport: noop,
  openEvaluation: noop,
  showToast: noop,
})

export const AppShellProvider = AppShellContext.Provider

export function useAppShell(): AppShellActions {
  return useContext(AppShellContext)
}
