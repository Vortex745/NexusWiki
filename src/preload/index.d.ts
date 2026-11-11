import type { ChatApi, MemoryApi, RagApi, WindowApi } from '../shared/protocol'

declare global {
  interface Window {
    api: ChatApi & RagApi & WindowApi & MemoryApi
  }
}

export {}
