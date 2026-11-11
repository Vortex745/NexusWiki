export const CHAT_SEND_CHANNEL = 'chat:send'
export const CHAT_CHUNK_CHANNEL = 'chat:chunk'
export const CHAT_NOTICE_CHANNEL = 'chat:notice'

export interface ChatSendRequest {
  text: string
}

export interface ChatSendResponse {
  messageId: string
}

// 终态语义：done=true 时携带；缺省视为 'stop'。'aborted' 仅用于用户叫停（chat:stop），不是模型错误
export type ChatStopReason = 'stop' | 'error' | 'aborted'

export interface ChatChunkEvent {
  messageId: string
  delta: string
  done: boolean
  stopReason?: ChatStopReason
}

// 低频结构化流事件（工具生命周期），与 chat:chunk 分离——delta 绝不双发，两通道节奏不同。
// key 由主进程指派且对同一工具调用的 start/end 稳定一致（取 `${messageId}:${toolCall id}`，
// id 在 start 的 partial item 与 end 的 toolCall 上同值），渲染层只按 key 懒 upsert 就地更新，不做 key 猜测
export const CHAT_STREAM_CHANNEL = 'chat:stream'

export interface ChatToolStreamEvent {
  kind: 'tool'
  key: string
  // start 带 label/input；update 带累计的部分输出（行保持运行中）；end 带最终输出、isError、durationMs
  phase: 'start' | 'update' | 'end'
  toolName?: string
  callId?: string
  // 主进程格式化的单行摘要（name + 首参截 60 字符）；arguments JSON 不上 UI
  summary?: string
  // 工具类别名（终端命令/编辑文件/…），主进程按工具名映射
  label?: string
  // 有界的单行输入（命令/路径/模式…），空参数时不携带
  input?: string
  // 有界的输出文本（update=累计部分输出，end=最终输出）；纯文本，渲染层不做 markdown
  output?: string
  isError?: boolean
  // 工具在途时被叫停/收尾：end 事件显式标注，UI 显示「已中止」而不是失败
  aborted?: boolean
  durationMs?: number
}

export type ChatStreamEvent = ChatToolStreamEvent

// Worker 内 pi-subagent 的步骤流：start/update/end 按键（taskId+callId）就地合并。
// seq 每任务单调递增（不密集），渲染层丢弃终态后的事件；主进程在渲染层就绪前直接丢弃不缓冲
// （抽屉回放走会话 JSONL，实况步骤不需要补发）
export const CHAT_SUBAGENT_STEP_CHANNEL = 'chat:subagent-step'

export interface ChatSubagentProgress {
  currentTool?: string
  currentToolArgs?: string
  recentOutput?: string[]
  toolCount?: number
  tokens?: number
  turnCount?: number
  status?: string
}

export interface ChatSubagentStepEvent {
  taskId: string
  seq: number
  callId: string
  phase: 'start' | 'update' | 'end'
  agent: string
  task?: string
  progress?: ChatSubagentProgress
  finalOutput?: string
  sessionFile?: string
  isError?: boolean
  durationMs?: number
}

export const CHAT_SUBAGENT_DETAIL_CHANNEL = 'chat:get-subagent-detail'

export interface ChatSubagentDetailRequest {
  taskId: string
  callId: string
}

export interface ChatSubagentDetailStep {
  id: string
  kind: 'tool' | 'thinking'
  label: string
  toolName?: string
  input?: string
  output?: string
  isError?: boolean
}

export interface ChatSubagentDetailResponse {
  agent: string
  task: string
  finalOutput?: string
  // 子会话不可用（文件缺失/未写完/越界）时为空数组，UI 回落实况进展
  steps: ChatSubagentDetailStep[]
}

// Worker 执行活动预览：每任务一行有界单行（≤120 字符），非转录。
// seq 每任务单调递增（不密集），渲染层丢弃 seq <= 已见值；主进程在渲染层就绪前直接丢弃不缓冲；
// 任务终态事件到达时渲染层清空对应条目
export const CHAT_TASK_ACTIVITY_CHANNEL = 'chat:task-activity'

export interface ChatTaskActivityEvent {
  taskId: string
  seq: number
  kind: 'tool' | 'text'
  label: string
}

// extension-warning：MCP 配置/连接与 skills 校验的诊断（Router 启动期或扩展运行期），不中断会话
export type ChatNoticeKind = 'model-not-configured' | 'router-error' | 'extension-warning'

export interface ChatNoticeEvent {
  kind: ChatNoticeKind
  message: string
}

export const CHAT_TASK_EVENT_CHANNEL = 'chat:task-event'

// 任务事件行：running=开始，done/failed/aborted/interrupted=终态（report 为 Worker 汇报文本；aborted=被叫停，interrupted=重启时仍运行/排队被标记中断）
export type ChatTaskStatus = 'running' | 'done' | 'failed' | 'aborted' | 'interrupted'

export interface ChatTaskEvent {
  taskId: string
  title: string
  status: ChatTaskStatus
  report?: string
}

export const CHAT_COMPACTION_CHANNEL = 'chat:compaction'

// 上下文压缩事件行：start=开始压缩，end=压缩终态（tokensBefore=压缩前上下文 token 估算；error=失败/中止原因）
// 同一对 start/end 共用一个 seq，渲染层按 seq 就地替换
export interface ChatCompactionEvent {
  seq: number
  phase: 'start' | 'end'
  tokensBefore?: number
  error?: string
}

export const CHAT_HISTORY_CHANNEL = 'chat:history'

// 恢复的历史消息（主进程在渲染层就绪后一次性推送）；summary=true 表示压缩/分支摘要条目，非逐字原文
export interface ChatHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  summary?: boolean
  // 恢复的助手消息里若含 thinking 块，作为独立的思考行展示（内容不与正文混排）
  thinking?: string
}

export interface ChatHistoryEvent {
  messages: ChatHistoryMessage[]
  // reset=true 表示主进程刚重建了空会话，渲染层应清空时间线而不是合并
  reset?: boolean
}

export const CHAT_NEW_SESSION_CHANNEL = 'chat:new-session'
export const CHAT_STOP_CHANNEL = 'chat:stop'

// 会话列表与切换：modified 是 ISO 字符串（Date 不进协议）；current 标记打在每个 summary 上，不另发 currentId
export const CHAT_LIST_SESSIONS_CHANNEL = 'chat:list-sessions'

export interface ChatSessionSummary {
  id: string
  title: string
  messageCount: number
  modified: string
  current: boolean
}

export interface ChatListSessionsResponse {
  sessions: ChatSessionSummary[]
}

// 切换会话：切到当前会话 no-op；未命中（会话文件被删等）走 invoke reject，不重建 Router
export const CHAT_SWITCH_SESSION_CHANNEL = 'chat:switch-session'

export interface ChatSwitchSessionRequest {
  id: string
}

// 重新生成：无请求体，resolve 值为新 assistant messageId；忙碌/无可重发时 invoke reject
export const CHAT_REGENERATE_CHANNEL = 'chat:regenerate'

// Router 模型模式（fake=脚本化假模型，real=OpenAI 兼容 provider）：协议层为唯一定义点
export type AgentMode = 'fake' | 'real'

// SDK 边界档位：与 pi-agent-core 的 ThinkingLevel 同名同值，协议层为唯一定义点。
// 产品档位见下方 THINKING_TIERS；SDK 会按模型能力 clamp 到 availableLevels 内。
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

// 产品档位：UI 与 app.db 的唯一真相源。SDK 的 max/xhigh 需要模型声明 thinkingLevelMap 才可用，
// 且预算会被 clampThinkingLevel/clampReasoning 折回 high，所以三档落在 SDK 的 low/medium/high 上，
// 由 Router 的自定义 thinkingBudgets 拉开实际预算。
export const THINKING_TIERS = ['low', 'high', 'max'] as const
export type ThinkingTier = (typeof THINKING_TIERS)[number]
export const DEFAULT_THINKING_TIER: ThinkingTier = 'high'
export const SDK_LEVEL_BY_TIER: Record<ThinkingTier, ThinkingLevel> = {
  low: 'low',
  high: 'medium',
  max: 'high'
}
// SDK 档位 → 产品档位（状态回报与会话恢复用）：off/minimal 归 low，medium 归 high，high/xhigh/max 归 max
export function tierForSdkLevel(level: ThinkingLevel): ThinkingTier {
  if (level === 'off' || level === 'minimal' || level === 'low') return 'low'
  if (level === 'medium') return 'high'
  return 'max'
}
// settings 存产品档位名；只有三档，非法值回落默认 high
export function parseThinkingTier(value: string | undefined): ThinkingTier {
  return THINKING_TIERS.find((tier) => tier === value) ?? DEFAULT_THINKING_TIER
}

// 旧键（thinking.level）里的 SDK 档位 → 产品档位：off/minimal/low→low、medium→high、high/xhigh/max→max。
// high 同时是新档位名，旧值迁移只能走这个函数，不能混进 parseThinkingTier（否则旧 high 会被误读成新 high）。
export function tierForLegacyLevel(value: string | undefined): ThinkingTier | undefined {
  const legacy = THINKING_LEVELS.find((level) => level === value)
  return legacy ? tierForSdkLevel(legacy) : undefined
}

export const CHAT_STATUS_CHANNEL = 'chat:get-status'
export const CHAT_SET_THINKING_LEVEL_CHANNEL = 'chat:set-thinking-level'

export interface ChatStatusResponse {
  thinkingTier: ThinkingTier
  // 当前模型实际可用、且被产品三档覆盖的档位；少于两个时 UI 隐藏控件
  availableTiers: ThinkingTier[]
}

export interface ChatSetThinkingTierRequest {
  tier: ThinkingTier
}

export interface ChatSetThinkingTierResponse {
  thinkingTier: ThinkingTier
  availableTiers: ThinkingTier[]
}

// 思考内容流：与 chat:chunk 同样高频，但独立通道独立合批，delta 绝不双发。
// key 由主进程指派 = `${anchorMessageId}:t${blockSeq}`（run 内单调），渲染层按 key 懒 upsert 就地追加。
export const CHAT_THINKING_CHANNEL = 'chat:thinking'

export interface ChatThinkingEvent {
  key: string
  phase: 'start' | 'delta' | 'end'
  delta?: string
}

export interface ChatApi {
  sendChatMessage: (text: string) => Promise<ChatSendResponse>
  getChatStatus: () => Promise<ChatStatusResponse>
  setThinkingTier: (tier: ThinkingTier) => Promise<ChatSetThinkingTierResponse>
  newChatSession: () => Promise<void>
  stopChat: () => Promise<void>
  listChatSessions: () => Promise<ChatListSessionsResponse>
  switchChatSession: (id: string) => Promise<void>
  /** 重新生成最后一条回复：重发最后一条 user 原文，返回新 assistant messageId */
  regenerateChat: () => Promise<string>
  onChatChunk: (listener: (event: ChatChunkEvent) => void) => () => void
  onChatThinking: (listener: (event: ChatThinkingEvent) => void) => () => void
  onChatStream: (listener: (event: ChatStreamEvent) => void) => () => void
  onChatSubagentStep: (listener: (event: ChatSubagentStepEvent) => void) => () => void
  getSubagentDetail: (taskId: string, callId: string) => Promise<ChatSubagentDetailResponse>
  onChatTaskActivity: (listener: (event: ChatTaskActivityEvent) => void) => () => void
  onChatNotice: (listener: (event: ChatNoticeEvent) => void) => () => void
  onChatTaskEvent: (listener: (event: ChatTaskEvent) => void) => () => void
  onChatCompaction: (listener: (event: ChatCompactionEvent) => void) => () => void
  onChatHistory: (listener: (event: ChatHistoryEvent) => void) => () => void
}

// ---- RAG 后台（登录 / 文档库 / PDF 导入）----

export const RAG_LOGIN_CHANNEL = 'rag:login'
export const RAG_GET_DOCS_CHANNEL = 'rag:get-docs'
export const RAG_IMPORT_PICK_CHANNEL = 'rag:import-pick'
export const RAG_REMOVE_DOC_CHANNEL = 'rag:remove-doc'
export const RAG_IMPORT_EVENT_CHANNEL = 'rag:import-event'

export interface RagLoginRequest {
  username: string
  password: string
}

export interface RagLoginResponse {
  token: string
}

export interface RagDocInfo {
  id: string
  title: string
  summary: string
  pageCount: number
  chunkCount: number
  status: 'ok' | 'needs-review' | 'unverified' | 'failed'
  formatIssues: string[]
  createdAt: string
}

export interface RagGetDocsResponse {
  docs: RagDocInfo[]
}

// jobId '' 表示文件对话框被取消
export interface RagImportPickResponse {
  jobId: string
}

// 导入流水线事件：parsing → extracting → chunking → summarizing → judging → done|failed
export interface RagImportEvent {
  jobId: string
  docId?: string
  stage: string
  pageDone?: number
  pageCount?: number
  message?: string
  status?: string
}

export interface RagRemoveDocRequest {
  token: string
  docId: string
}

export const RAG_SEARCH_TEST_CHANNEL = 'rag:search-test'

export interface RagSearchTestRequest {
  token: string
  query: string
}

export interface RagScoredPassage {
  docId: string
  docTitle: string
  heading: string
  content: string
  score: number
}

export interface RagSearchTestResponse {
  passages: RagScoredPassage[]
  answer: string
}

export interface RagApi {
  ragLogin: (username: string, password: string) => Promise<RagLoginResponse>
  ragGetDocs: (token: string) => Promise<RagGetDocsResponse>
  ragImportPick: (token: string) => Promise<RagImportPickResponse>
  ragRemoveDoc: (token: string, docId: string) => Promise<void>
  ragSearchTest: (token: string, query: string) => Promise<RagSearchTestResponse>
  onRagImportEvent: (listener: (event: RagImportEvent) => void) => () => void
}

// ---- 窗口 chrome（titleBarOverlay 主题）----

export const WIN_SET_OVERLAY_CHANNEL = 'win:set-overlay'

// 渲染层只传主题名：overlay 颜色表跟随主进程，不进协议
export type WindowOverlayTheme = 'light' | 'dark'

export interface WindowSetOverlayThemeRequest {
  theme: WindowOverlayTheme
}

export interface WindowApi {
  setOverlayTheme: (theme: WindowOverlayTheme) => Promise<void>
}

// ---- 长期记忆（MEMORY.md）----

export const MEMORY_STATE_CHANNEL = 'memory:get-state'
export const MEMORY_RUN_CHANNEL = 'memory:run'
export const MEMORY_SET_PINNED_CHANNEL = 'memory:set-pinned'
export const MEMORY_EVENT_CHANNEL = 'memory:event'

// 整理状态：idle=空闲（无新内容或整理完成），summarizing=整理中，error=上次整理失败（下次成功或重试前保持）
export type MemoryStatus = 'idle' | 'summarizing' | 'error'

export interface MemoryState {
  status: MemoryStatus
  // MEMORY.md 全文（未生成时为空串）
  content: string
  updatedAt: string | null
  // 浮动卡片钉住态与位置（viewport 坐标），位置随钉住一起持久化
  pinned: boolean
  pos?: { x: number; y: number }
  // 卡片尺寸随钉住一起持久化
  size?: { w: number; h: number }
  error?: string
}

export interface MemorySetPinnedRequest {
  pinned: boolean
  // 同时携带位置时一并持久化（拖动结束时上报）
  x?: number
  y?: number
  w?: number
  h?: number
}

// 事件只推状态迁移：summarizing（开始整理）、idle（完成或无新增）、error（失败）
export interface MemoryEvent {
  status: MemoryStatus
  updatedAt?: string
  error?: string
}

export interface MemoryApi {
  getMemoryState: () => Promise<MemoryState>
  /** 手动重新整理：整理中调用 reject */
  runMemory: () => Promise<MemoryState>
  setMemoryPinned: (pinned: boolean, x?: number, y?: number, w?: number, h?: number) => Promise<void>
  onMemoryEvent: (listener: (event: MemoryEvent) => void) => () => void
}
