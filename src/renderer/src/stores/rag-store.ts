import { create } from 'zustand'
import type { RagDocInfo, RagImportEvent, RagSearchTestResponse } from '../../../shared/protocol'

// RAG 后台状态：token 只存内存（不落 localStorage），view 切换聊天/后台两个面板
export type RagView = 'chat' | 'admin'

// Electron 会给 invoke 错误套上 "Error invoking remote method 'channel':" 前缀，剥掉只留人话
function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

interface RagState {
  view: RagView
  token: string | null
  loginError: string | null
  docs: RagDocInfo[]
  lastEvent: RagImportEvent | null
  searchResult: RagSearchTestResponse | null
  searchError: string | null
  searching: boolean
  setView: (view: RagView) => void
  login: (username: string, password: string) => void
  logout: () => void
  loadDocs: () => void
  applyImportEvent: (event: RagImportEvent) => void
  removeDoc: (id: string) => void
  searchTest: (query: string) => void
}

export const useRagStore = create<RagState>((set, get) => ({
  view: 'chat',
  token: null,
  loginError: null,
  docs: [],
  lastEvent: null,
  searchResult: null,
  searchError: null,
  searching: false,
  setView: (view) => set({ view }),
  login: (username, password) => {
    void window.api
      .ragLogin(username, password)
      .then(({ token }) => {
        set({ token, loginError: null })
        get().loadDocs()
      })
      .catch((err: unknown) => {
        set({ loginError: errText(err) })
      })
  },
  logout: () => set({ token: null, docs: [], lastEvent: null, loginError: null, searchResult: null, searchError: null, searching: false }),
  loadDocs: () => {
    const token = get().token
    if (!token) return
    void window.api
      .ragGetDocs(token)
      .then(({ docs }) => set({ docs }))
      .catch((err: unknown) => {
        if (/unauthorized/.test(errText(err))) get().logout()
      })
  },
  applyImportEvent: (event) => {
    set({ lastEvent: event })
    if (event.stage === 'done' || event.stage === 'failed') get().loadDocs()
  },
  removeDoc: (id) => {
    const token = get().token
    if (!token) return
    void window.api
      .ragRemoveDoc(token, id)
      .then(() => get().loadDocs())
      .catch(() => {})
  },
  searchTest: (query) => {
    const token = get().token
    if (!token) return
    set({ searching: true, searchResult: null, searchError: null })
    void window.api
      .ragSearchTest(token, query)
      .then((result) => set({ searching: false, searchResult: result }))
      .catch((err: unknown) => {
        set({ searching: false, searchError: errText(err) })
      })
  }
}))
