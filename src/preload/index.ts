import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CHAT_CHUNK_CHANNEL,
  CHAT_COMPACTION_CHANNEL,
  CHAT_HISTORY_CHANNEL,
  CHAT_LIST_SESSIONS_CHANNEL,
  CHAT_NEW_SESSION_CHANNEL,
  CHAT_NOTICE_CHANNEL,
  CHAT_REGENERATE_CHANNEL,
  CHAT_SEND_CHANNEL,
  CHAT_SET_THINKING_LEVEL_CHANNEL,
  CHAT_STOP_CHANNEL,
  CHAT_STATUS_CHANNEL,
  CHAT_STREAM_CHANNEL,
  CHAT_SUBAGENT_DETAIL_CHANNEL,
  CHAT_SUBAGENT_STEP_CHANNEL,
  CHAT_SWITCH_SESSION_CHANNEL,
  CHAT_TASK_ACTIVITY_CHANNEL,
  CHAT_TASK_EVENT_CHANNEL,
  CHAT_THINKING_CHANNEL,
  RAG_GET_DOCS_CHANNEL,
  RAG_IMPORT_EVENT_CHANNEL,
  RAG_IMPORT_PICK_CHANNEL,
  RAG_LOGIN_CHANNEL,
  RAG_REMOVE_DOC_CHANNEL,
  RAG_SEARCH_TEST_CHANNEL,
  WIN_SET_OVERLAY_CHANNEL,
  MEMORY_EVENT_CHANNEL,
  MEMORY_RUN_CHANNEL,
  MEMORY_SET_PINNED_CHANNEL,
  MEMORY_STATE_CHANNEL,
  type ChatApi,
  type ChatChunkEvent,
  type ChatCompactionEvent,
  type ChatHistoryEvent,
  type ChatNoticeEvent,
  type ChatStreamEvent,
  type ChatSubagentStepEvent,
  type ChatTaskActivityEvent,
  type ChatTaskEvent,
  type ChatThinkingEvent,
  type MemoryApi,
  type MemoryEvent,
  type ThinkingTier,
  type RagApi,
  type RagImportEvent,
  type WindowApi
} from '../shared/protocol.ts'

// 四个 onChat* 通道的同构包装：注册丢弃 IpcRendererEvent 的转发器，返回退订函数
function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const forward = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, forward)
  return () => {
    ipcRenderer.removeListener(channel, forward)
  }
}

const api: ChatApi & RagApi & WindowApi & MemoryApi = {
  sendChatMessage: (text) => ipcRenderer.invoke(CHAT_SEND_CHANNEL, { text }),
  getChatStatus: () => ipcRenderer.invoke(CHAT_STATUS_CHANNEL),
  setThinkingTier: (tier: ThinkingTier) => ipcRenderer.invoke(CHAT_SET_THINKING_LEVEL_CHANNEL, { tier }),
  newChatSession: () => ipcRenderer.invoke(CHAT_NEW_SESSION_CHANNEL),
  stopChat: () => ipcRenderer.invoke(CHAT_STOP_CHANNEL),
  listChatSessions: () => ipcRenderer.invoke(CHAT_LIST_SESSIONS_CHANNEL),
  switchChatSession: (id: string) => ipcRenderer.invoke(CHAT_SWITCH_SESSION_CHANNEL, { id }),
  regenerateChat: () => ipcRenderer.invoke(CHAT_REGENERATE_CHANNEL),
  onChatChunk: (listener) => listen<ChatChunkEvent>(CHAT_CHUNK_CHANNEL, listener),
  onChatThinking: (listener) => listen<ChatThinkingEvent>(CHAT_THINKING_CHANNEL, listener),
  onChatStream: (listener) => listen<ChatStreamEvent>(CHAT_STREAM_CHANNEL, listener),
  onChatSubagentStep: (listener) => listen<ChatSubagentStepEvent>(CHAT_SUBAGENT_STEP_CHANNEL, listener),
  getSubagentDetail: (taskId: string, callId: string) =>
    ipcRenderer.invoke(CHAT_SUBAGENT_DETAIL_CHANNEL, { taskId, callId }),
  onChatTaskActivity: (listener) => listen<ChatTaskActivityEvent>(CHAT_TASK_ACTIVITY_CHANNEL, listener),
  onChatNotice: (listener) => listen<ChatNoticeEvent>(CHAT_NOTICE_CHANNEL, listener),
  onChatTaskEvent: (listener) => listen<ChatTaskEvent>(CHAT_TASK_EVENT_CHANNEL, listener),
  onChatCompaction: (listener) => listen<ChatCompactionEvent>(CHAT_COMPACTION_CHANNEL, listener),
  onChatHistory: (listener) => listen<ChatHistoryEvent>(CHAT_HISTORY_CHANNEL, listener),
  ragLogin: (username, password) => ipcRenderer.invoke(RAG_LOGIN_CHANNEL, { username, password }),
  ragGetDocs: (token) => ipcRenderer.invoke(RAG_GET_DOCS_CHANNEL, { token }),
  ragImportPick: (token) => ipcRenderer.invoke(RAG_IMPORT_PICK_CHANNEL, { token }),
  ragRemoveDoc: (token, docId) => ipcRenderer.invoke(RAG_REMOVE_DOC_CHANNEL, { token, docId }),
  ragSearchTest: (token, query) => ipcRenderer.invoke(RAG_SEARCH_TEST_CHANNEL, { token, query }),
  onRagImportEvent: (listener) => listen<RagImportEvent>(RAG_IMPORT_EVENT_CHANNEL, listener),
  setOverlayTheme: (theme) => ipcRenderer.invoke(WIN_SET_OVERLAY_CHANNEL, { theme }),
  getMemoryState: () => ipcRenderer.invoke(MEMORY_STATE_CHANNEL),
  runMemory: () => ipcRenderer.invoke(MEMORY_RUN_CHANNEL),
  setMemoryPinned: (pinned, x?, y?, w?, h?) => ipcRenderer.invoke(MEMORY_SET_PINNED_CHANNEL, { pinned, x, y, w, h }),
  onMemoryEvent: (listener) => listen<MemoryEvent>(MEMORY_EVENT_CHANNEL, listener)
}

contextBridge.exposeInMainWorld('api', api)
