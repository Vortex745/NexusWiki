import { create } from 'zustand'
// 相对路径 + 显式 .ts 扩展名：本文件被 node --test 直接跑（值导入要能被原生 ESM 解析）
import { markEnter } from '../lib/chat-intro.ts'
import type {
  ChatChunkEvent,
  ChatCompactionEvent,
  ChatHistoryEvent,
  ChatNoticeEvent,
  ChatNoticeKind,
  ChatStopReason,
  ChatStreamEvent,
  ChatSubagentProgress,
  ChatSubagentStepEvent,
  ChatTaskActivityEvent,
  ChatTaskEvent,
  ChatTaskStatus,
  ChatThinkingEvent,
  ThinkingTier
} from '../../../shared/protocol'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming: boolean
  // 压缩/分支摘要条目（重启恢复时来自 pi 会话），非逐字原文
  summary?: boolean
  // 终态语义随 done chunk 到达；缺省渲染层视为 'stop'
  stopReason?: ChatStopReason
}

// 工具步骤行：start=正在调用（带类别名与输入），update=累计输出（行保持运行中），end=终态（输出/失败/耗时）。
// key 由主进程指派且全程稳定；终态只写一次，之后同 key 的事件一律忽略
export interface ToolLine {
  key: string
  phase: 'start' | 'update' | 'end'
  toolName?: string
  summary?: string
  label?: string
  input?: string
  output?: string
  isError?: boolean
  aborted?: boolean
  durationMs?: number
}

// 任务事件行：一个任务一行，状态就地更新（不逐 token）
export interface TaskLine {
  taskId: string
  title: string
  status: ChatTaskStatus
  time: string
}

// Worker 活动预览：每任务一条有界单行（非转录），seq 单调递增
export interface TaskActivity {
  seq: number
  kind: 'tool' | 'text'
  label: string
}

// 上下文压缩行：start=进行中，end 到达时按 seq 就地替换为终态
export interface CompactionLine {
  seq: number
  phase: 'start' | 'end'
  tokensBefore?: number
  error?: string
}

// 思考行：start=流式进行中，delta 只追加单行文本，end=终态。
// 与正文分平面，绝不写进 messagesById（思考不是回答）。
export interface ThinkingLine {
  key: string
  phase: 'start' | 'end'
  text: string
}

// 子代理运行（Worker 内 pi-subagent 的一次调用）：start/update/end 按 key 合并成一条，progress 逐次覆盖合并
export interface SubagentRun {
  key: string
  taskId: string
  callId: string
  agent: string
  task?: string
  phase: 'running' | 'done' | 'failed'
  progress?: ChatSubagentProgress
  finalOutput?: string
  isError?: boolean
  updatedAt: number
}

interface DelegationChip {
  key: string
  text: string
  tone: 'running' | 'done' | 'failed'
}

function subagentRunKey(taskId: string, callId: string): string {
  return `${taskId}:${callId}`
}

// 头部子代理指示：运行中有优先（单个给 agent 名，多个给计数）；否则展示最近一次终态，直到下一次用户发送
export function selectDelegationChip(state: {
  subagentRunsByKey: Record<string, SubagentRun>
  recentSubagentKey: string | null
}): DelegationChip | null {
  const running = Object.values(state.subagentRunsByKey).filter((run) => run.phase === 'running')
  if (running.length > 0) {
    const latest = running.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a))
    return {
      key: latest.key,
      tone: 'running',
      text: running.length === 1 ? `正在调用 ${latest.agent} 子智能体` : `${running.length} 个子智能体运行中`
    }
  }
  const recent = state.recentSubagentKey ? state.subagentRunsByKey[state.recentSubagentKey] : undefined
  if (!recent) return null
  const failed = recent.phase === 'failed'
  return {
    key: recent.key,
    tone: failed ? 'failed' : 'done',
    text: failed ? `子智能体失败 · ${recent.agent}` : `子智能体已完成 · ${recent.agent}`
  }
}

// 任一平面说「有运行中的流」：流式 assistant、进行中的工具、进行中的思考。
// 判活用 streaming 布尔而非 stopReason 缺省——历史恢复的 assistant 消息无 stopReason 但不在流式，
// done chunk 也可能不带 stopReason；两者都不能算活。
export function selectStreamingActive(state: ChatState): boolean {
  for (const message of Object.values(state.messagesById)) {
    if (message.role === 'assistant' && message.streaming) return true
  }
  for (const line of Object.values(state.toolLinesByKey)) {
    if (line.phase !== 'end') return true
  }
  for (const line of Object.values(state.thinkingByKey)) {
    if (line.phase === 'start') return true
  }
  return false
}

// 时间线结构 ref：内容分平面存放（高频 chunk 只写单条内容，结构 ref 引用稳定）
export type TimelineRef =
  | { kind: 'message'; id: string }
  | { kind: 'tool'; key: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'compaction'; seq: number }
  | { kind: 'thinking'; key: string }

function nowTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// 时间线 key：App 的 React key 与线程 FLIP 行注册共用
export function timelineKey(entry: TimelineRef): string {
  if (entry.kind === 'message') return entry.id
  if (entry.kind === 'tool') return entry.key
  if (entry.kind === 'task') return entry.taskId
  if (entry.kind === 'thinking') return entry.key
  return `compaction-${entry.seq}`
}

// 消息分组（第 1 节）：相邻同角色气泡成组，驱动组角收紧与 4/16px 节奏。
// 纯函数：同一角色的相邻消息 first→mid→last，孤行为 single；摘要行与非消息行不参与
export type GroupPos = 'single' | 'first' | 'mid' | 'last' | null

export function groupPositions(refs: TimelineRef[], messagesById: Record<string, ChatMessage>): GroupPos[] {
  const roleOf = (ref: TimelineRef): 'user' | 'assistant' | null => {
    if (ref.kind !== 'message') return null
    const message = messagesById[ref.id]
    return message && !message.summary ? message.role : null
  }
  return refs.map((ref, i) => {
    const role = roleOf(ref)
    if (!role) return null
    const prevSame = i > 0 && roleOf(refs[i - 1]!) === role
    const nextSame = i < refs.length - 1 && roleOf(refs[i + 1]!) === role
    if (prevSame && nextSame) return 'mid'
    if (nextSame) return 'first'
    if (prevSame) return 'last'
    return 'single'
  })
}

interface ChatState {
  timelineRefs: TimelineRef[]
  messagesById: Record<string, ChatMessage>
  toolLinesByKey: Record<string, ToolLine>
  taskLinesById: Record<string, TaskLine>
  compactionsBySeq: Record<number, CompactionLine>
  activityByTaskId: Record<string, TaskActivity>
  thinkingByKey: Record<string, ThinkingLine>
  subagentRunsByKey: Record<string, SubagentRun>
  recentSubagentKey: string | null
  detailSubagentKey: string | null
  thinkingTier: ThinkingTier
  availableTiers: ThinkingTier[]
  notice: { kind: ChatNoticeKind; message: string } | null
  // 等待回复中（发送/重新生成后、首个 chunk 前）：水纹点阵挂时间线末尾
  awaitingReply: boolean
  sendMessage: (text: string) => void
  changeThinkingTier: (tier: ThinkingTier) => void
  applyChatChunk: (event: ChatChunkEvent) => void
  applyChatThinking: (event: ChatThinkingEvent) => void
  applyChatStream: (event: ChatStreamEvent) => void
  applyChatSubagentStep: (event: ChatSubagentStepEvent) => void
  openSubagentDetail: (key: string) => void
  closeSubagentDetail: () => void
  dismissRecentSubagent: () => void
  applyChatTaskActivity: (event: ChatTaskActivityEvent) => void
  applyChatNotice: (event: ChatNoticeEvent) => void
  applyChatTaskEvent: (event: ChatTaskEvent) => void
  applyChatCompaction: (event: ChatCompactionEvent) => void
  applyChatHistory: (event: ChatHistoryEvent) => void
  dropLastAssistantTurn: () => void
  deleteMessage: (id: string) => void
}

export const useChatStore = create<ChatState>((set) => ({
  timelineRefs: [],
  messagesById: {},
  toolLinesByKey: {},
  taskLinesById: {},
  compactionsBySeq: {},
  activityByTaskId: {},
  thinkingByKey: {},
  subagentRunsByKey: {},
  recentSubagentKey: null,
  detailSubagentKey: null,
  thinkingTier: 'high',
  availableTiers: [],
  notice: null,
  awaitingReply: false,
  sendMessage: (text) => {
    const id = crypto.randomUUID()
    markEnter(id)
    set((state) => ({
      timelineRefs: [...state.timelineRefs, { kind: 'message', id }],
      messagesById: {
        ...state.messagesById,
        [id]: { id, role: 'user', content: text, streaming: false }
      },
      recentSubagentKey: null,
      awaitingReply: true
    }))
    void window.api.sendChatMessage(text)
  },
  // 档位切换：主进程回执是 clamp 后的真实值，用它校准 UI（要 max 但模型只到 medium 时显示 high）；
  // 失败回落 getChatStatus 重取真实状态
  changeThinkingTier: (tier) => {
    set({ thinkingTier: tier })
    window.api
      .setThinkingTier(tier)
      .then((r) => useChatStore.setState({ thinkingTier: r.thinkingTier, availableTiers: r.availableTiers }))
      .catch(() => {
        window.api.getChatStatus().then((s) => {
          useChatStore.setState({ thinkingTier: s.thinkingTier, availableTiers: s.availableTiers })
        }).catch(() => {})
      })
  },
  // chunk 高频路径只写 messagesById 单 entry，不触碰 timelineRefs；未知 id 才追加 ref（懒 upsert，
  // 流式推送与 invoke 回复顺序不保证）。任何 chunk（含 done）都终结等待态
  applyChatChunk: (event) => {
    set((state) => {
      const prev = state.messagesById[event.messageId]
      const entry: ChatMessage = prev
        ? {
            ...prev,
            content: prev.content + event.delta,
            streaming: !event.done,
            stopReason: event.done ? event.stopReason : prev.stopReason
          }
        : {
            id: event.messageId,
            role: 'assistant',
            content: event.delta,
            streaming: !event.done,
            stopReason: event.done ? event.stopReason : undefined
          }
      return {
        timelineRefs: prev ? state.timelineRefs : [...state.timelineRefs, { kind: 'message', id: event.messageId }],
        messagesById: { ...state.messagesById, [event.messageId]: entry },
        awaitingReply: false
      }
    })
  },
  // 思考 delta 与 chunk 同为高频：只写 thinkingByKey 的单条 entry，不触碰 timelineRefs（懒 upsert）。
  // start/end 就地替换同一 key，终态行仍保留完整文本供回看。
  // 顺序不变量：思考行永远排在它所属 assistant 消息之前（提问 → 思考 → 回答）。正常流式下
  // thinking 事件先到、消息 ref 还不存在，直接追加即可；若消息行先到（事件交错），插到它前面。
  applyChatThinking: (event) =>
    set((state) => {
      const prev = state.thinkingByKey[event.key]
      const line: ThinkingLine = {
        key: event.key,
        phase: event.phase === 'end' ? 'end' : 'start',
        text: (prev?.text ?? '') + (event.delta ?? '')
      }
      let timelineRefs = state.timelineRefs
      if (!prev) {
        const messageId = event.key.slice(0, event.key.indexOf(':'))
        const index = state.timelineRefs.findIndex((ref) => ref.kind === 'message' && ref.id === messageId)
        const ref = { kind: 'thinking' as const, key: event.key }
        timelineRefs =
          index < 0
            ? [...state.timelineRefs, ref]
            : [...state.timelineRefs.slice(0, index), ref, ...state.timelineRefs.slice(index)]
      }
      return {
        timelineRefs,
        thinkingByKey: { ...state.thinkingByKey, [event.key]: line }
      }
    }),
  applyChatStream: (event) =>
    set((state) => {
      const prev = state.toolLinesByKey[event.key]
      if (prev?.phase === 'end') return state
      const line: ToolLine = {
        key: event.key,
        phase: event.phase,
        toolName: event.toolName ?? prev?.toolName,
        summary: event.summary ?? prev?.summary,
        label: event.label ?? prev?.label,
        input: event.input ?? prev?.input,
        output: event.output ?? prev?.output,
        isError: event.isError ?? prev?.isError,
        aborted: event.aborted ?? prev?.aborted,
        durationMs: event.durationMs ?? prev?.durationMs
      }
      return {
        timelineRefs: prev ? state.timelineRefs : [...state.timelineRefs, { kind: 'tool', key: event.key }],
        toolLinesByKey: { ...state.toolLinesByKey, [event.key]: line }
      }
    }),
  applyChatSubagentStep: (event) =>
    set((state) => {
      const key = subagentRunKey(event.taskId, event.callId)
      const prev = state.subagentRunsByKey[key]
      if (prev && prev.phase !== 'running') return state
      const phase: SubagentRun['phase'] =
        event.phase === 'end' ? (event.isError === true ? 'failed' : 'done') : 'running'
      const task = event.task ?? prev?.task
      const progress = event.progress ?? prev?.progress
      const finalOutput = event.finalOutput ?? prev?.finalOutput
      const isError = event.phase === 'end' ? event.isError === true : prev?.isError
      const run: SubagentRun = {
        key,
        taskId: event.taskId,
        callId: event.callId,
        agent: event.agent || prev?.agent || '',
        phase,
        ...(task !== undefined ? { task } : {}),
        ...(progress !== undefined ? { progress: { ...prev?.progress, ...event.progress } } : {}),
        ...(finalOutput !== undefined ? { finalOutput } : {}),
        ...(isError !== undefined ? { isError } : {}),
        updatedAt: Date.now()
      }
      return {
        subagentRunsByKey: { ...state.subagentRunsByKey, [key]: run },
        recentSubagentKey: event.phase === 'end' ? key : state.recentSubagentKey
      }
    }),
  openSubagentDetail: (key) =>
    set((state) => (state.subagentRunsByKey[key] ? { detailSubagentKey: key } : state)),
  closeSubagentDetail: () => set({ detailSubagentKey: null }),
  dismissRecentSubagent: () => set({ recentSubagentKey: null }),
  // 活动预览 seq 门卫：seq <= 已见值丢弃（seq 单调不密集，按比较去重）
  applyChatTaskActivity: (event) =>
    set((state) => {
      const seen = state.activityByTaskId[event.taskId]
      if (seen && event.seq <= seen.seq) return state
      return {
        activityByTaskId: {
          ...state.activityByTaskId,
          [event.taskId]: { seq: event.seq, kind: event.kind, label: event.label }
        }
      }
    }),
  applyChatNotice: (event) => set({ notice: { kind: event.kind, message: event.message }, awaitingReply: false }),
  // 任务事件落时间线：一任务一行就地更新，未知 taskId 追加到末尾（到达顺序）；
  // 任务终态时清空该任务的活动预览
  applyChatTaskEvent: (event) =>
    set((state) => {
      const prev = state.taskLinesById[event.taskId]
      const line: TaskLine = prev
        ? { ...prev, status: event.status, time: nowTime() }
        : { taskId: event.taskId, title: event.title, status: event.status, time: nowTime() }
      const activityByTaskId = { ...state.activityByTaskId }
      if (event.status !== 'running') delete activityByTaskId[event.taskId]
      return {
        timelineRefs: prev ? state.timelineRefs : [...state.timelineRefs, { kind: 'task', taskId: event.taskId }],
        taskLinesById: { ...state.taskLinesById, [event.taskId]: line },
        activityByTaskId
      }
    }),
  // 压缩事件落时间线：同一对 start/end 共用 seq，end 到达时就地替换 start 行；未知 seq 追加到末尾
  applyChatCompaction: (event) =>
    set((state) => {
      const prev = state.compactionsBySeq[event.seq]
      const line: CompactionLine = {
        seq: event.seq,
        phase: event.phase,
        tokensBefore: event.tokensBefore,
        error: event.error
      }
      return {
        timelineRefs: prev ? state.timelineRefs : [...state.timelineRefs, { kind: 'compaction', seq: event.seq }],
        compactionsBySeq: { ...state.compactionsBySeq, [event.seq]: line }
      }
    }),
  applyChatHistory: (event) =>
    set((state) => {
      // reset=true：主进程刚重建了空会话，旧会话内容全属上一段对话，全平面清空不合并
      if (event.reset === true) {
        return {
          timelineRefs: [],
          messagesById: {},
          toolLinesByKey: {},
          taskLinesById: {},
          compactionsBySeq: {},
          activityByTaskId: {},
          thinkingByKey: {},
          subagentRunsByKey: {},
          recentSubagentKey: null,
          detailSubagentKey: null,
          awaitingReply: false
        }
      }
      // 历史早于一切在线内容，整体前置；历史到达前已产生的条目（按 id 去重）保留在其后。
      // 带思考块的历史消息额外生成一条终态思考行，排在消息之前（提问 → 思考 → 回答）
      const known = new Set(event.messages.map((m) => m.id))
      const history: Record<string, ChatMessage> = {}
      const restoredThinking: Record<string, ThinkingLine> = {}
      const refs: TimelineRef[] = []
      for (const m of event.messages) {
        if (m.thinking) {
          const key = `${m.id}:history`
          restoredThinking[key] = { key, phase: 'end', text: m.thinking }
          refs.push({ kind: 'thinking', key })
        }
        history[m.id] = { id: m.id, role: m.role, content: m.content, streaming: false, summary: m.summary }
        refs.push({ kind: 'message', id: m.id })
      }
      return {
        timelineRefs: [
          ...refs,
          ...state.timelineRefs.filter((ref) => ref.kind !== 'message' || !known.has(ref.id))
        ],
        messagesById: { ...state.messagesById, ...history },
        thinkingByKey: { ...state.thinkingByKey, ...restoredThinking }
      }
    }),
  // 重新生成成功后的回撤：丢弃最后一个 assistant 回合（消息 + 其思考/工具行），
  // 让 regenerateChat 新回合的 chunk 懒 upsert 到原位置之后。任务/压缩行按 taskId/seq
  // 归属不到消息，原样保留；无 assistant 消息时 no-op。回撤即进入等待态（点阵）。
  dropLastAssistantTurn: () =>
    set((state) => {
      let lastId: string | null = null
      for (let i = state.timelineRefs.length - 1; i >= 0; i--) {
        const ref = state.timelineRefs[i]
        if (ref.kind !== 'message') continue
        const message = state.messagesById[ref.id]
        if (message && message.role === 'assistant' && !message.summary) {
          lastId = ref.id
          break
        }
      }
      if (!lastId) return state
      const droppedId = lastId
      const belongsToTurn = (key: string) => key.startsWith(`${droppedId}:`)
      const messagesById = { ...state.messagesById }
      delete messagesById[droppedId]
      const thinkingByKey = { ...state.thinkingByKey }
      for (const key of Object.keys(thinkingByKey)) if (belongsToTurn(key)) delete thinkingByKey[key]
      const toolLinesByKey = { ...state.toolLinesByKey }
      for (const key of Object.keys(toolLinesByKey)) if (belongsToTurn(key)) delete toolLinesByKey[key]
      return {
        timelineRefs: state.timelineRefs.filter(
          (ref) =>
            !(ref.kind === 'message' && ref.id === droppedId) &&
            !(ref.kind === 'thinking' && belongsToTurn(ref.key)) &&
            !(ref.kind === 'tool' && belongsToTurn(ref.key))
        ),
        messagesById,
        thinkingByKey,
        toolLinesByKey,
        awaitingReply: true
      }
    }),
  // UI 删除（用户裁决的语义：pi 会话上下文保留该消息）：移除消息与其思考/工具行，
  // 任务/压缩行归属不到消息，原样保留；无此消息时 no-op
  deleteMessage: (id) =>
    set((state) => {
      if (!state.messagesById[id]) return state
      const belongsTo = (key: string) => key.startsWith(`${id}:`)
      const messagesById = { ...state.messagesById }
      delete messagesById[id]
      const thinkingByKey = { ...state.thinkingByKey }
      for (const key of Object.keys(thinkingByKey)) if (belongsTo(key)) delete thinkingByKey[key]
      const toolLinesByKey = { ...state.toolLinesByKey }
      for (const key of Object.keys(toolLinesByKey)) if (belongsTo(key)) delete toolLinesByKey[key]
      return {
        timelineRefs: state.timelineRefs.filter(
          (ref) =>
            !(ref.kind === 'message' && ref.id === id) &&
            !(ref.kind === 'thinking' && belongsTo(ref.key)) &&
            !(ref.kind === 'tool' && belongsTo(ref.key))
        ),
        messagesById,
        thinkingByKey,
        toolLinesByKey
      }
    })
}))
