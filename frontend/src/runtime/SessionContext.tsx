import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

import {
  fetchAuthConfig,
  fetchSession,
  setAccessToken,
  setUnauthorizedHandler,
  signIn as requestSignIn,
  type AuthConfigPayload,
  type SessionPayload,
} from "../lib/api"

/**
 * Ticket 01 (IAM-01): the server-resolved identity.
 *
 * The browser never decides its own role — it asks `GET /api/session` and
 * renders what the server reports. The state machine below therefore has one
 * rule: without a server-confirmed session there is no application UI.
 *
 * In single-tenant mode the session resolves without a token, so the sign-in
 * screen never appears and the legacy path behaves exactly as before.
 */
export type SessionState =
  | { status: "loading" }
  | { status: "anonymous"; authConfig: AuthConfigPayload }
  | { status: "signed-in"; session: SessionPayload }
  | { status: "error"; message: string }

export interface SessionApi {
  state: SessionState
  signIn(account: string, password: string): Promise<void>
  signOut(): void
}

const SessionContext = createContext<SessionApi | null>(null)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" })

  const load = useCallback(async () => {
    try {
      const session = await fetchSession()
      if (session) {
        setState({ status: "signed-in", session })
        return
      }
      const authConfig = await fetchAuthConfig()
      setState(
        authConfig.demoAuth
          ? { status: "anonymous", authConfig }
          : { status: "error", message: "服务器要求身份认证，但未启用本地登录" }
      )
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "身份读取失败",
      })
    }
  }, [])

  useEffect(() => {
    // A rejected token means the session is gone — drop it and re-resolve
    // rather than leaving the UI in a signed-in state the server no longer
    // honours.
    setUnauthorizedHandler(() => {
      setAccessToken(null)
      void load()
    })
    void load()
    return () => setUnauthorizedHandler(null)
  }, [load])

  const signIn = useCallback(
    async (account: string, password: string) => {
      await requestSignIn(account, password)
      await load()
    },
    [load]
  )

  const signOut = useCallback(() => {
    setAccessToken(null)
    void load()
  }, [load])

  const value = useMemo<SessionApi>(() => ({ state, signIn, signOut }), [state, signIn, signOut])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionApi {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession must be used inside <SessionProvider>")
  return value
}

/** Convenience for components that only render when a session exists. */
export function useSignedInSession(): SessionPayload | null {
  const { state } = useSession()
  return state.status === "signed-in" ? state.session : null
}
