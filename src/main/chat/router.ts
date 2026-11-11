import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAgentSession,
  createBashToolDefinition,
  defineTool,
  type AgentSessionEvent,
  loadProjectContextFiles,
  loadSkills,
  ModelRuntime,
  type SessionMessageEntry,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type { Api, AssistantMessageEvent, Model, UserMessage } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import type {
  ChatChunkEvent,
  ChatCompactionEvent,
  ChatHistoryMessage,
  ChatNoticeEvent,
  ChatStopReason,
  ChatStreamEvent,
  ChatThinkingEvent,
  ThinkingLevel
} from '../../shared/protocol.ts'
import {
  asRecord,
  boundText,
  driveFakeAssistantStream,
  errorMessageOf,
  fakeChatModelConfig,
  hasModelConfig,
  loadAppExtensions,
  minimalResourceLoader,
  resolveRealModel,
  TASK_EVENT_ENVELOPE_MARKER,
  TASK_REPORT_PREFIX,
  textOf,
  TOOL_TEXT_LIMIT,
  toHistoryMessages,
  toolCallLabel,
  toolDisplayInfo,
  toolResultText,
  USER_ENVELOPE_MARKER,
  type AgentMode,
  type ScriptedTurn
} from './pi-shared.ts'
import { loadAppMcpConfig } from './mcp-config.ts'
import { readMemoryForContext } from '../memory/consolidator.ts'

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>['session']

interface ToolExecutionEvent {
  type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
  toolCallId: string
  toolName: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  durationMs?: number
  parentToolCallId?: string
}

export interface DispatchInput {
  title: string
  prompt: string
}

export type OnDispatchTask = (input: DispatchInput) => { taskId: string } | Promise<{ taskId: string }>

// task_status 工具需要的任务行最小面（store.TaskRow 结构兼容即可，避免 chat → tasks 类型耦合）
export interface TaskStatusRow {
  id: string
  title: string
  status: string
  created: string
  finished: string | null
}

export type OnTaskStatus = (taskId?: string) => TaskStatusRow[] | Promise<TaskStatusRow[]>

export type OnSearchKnowledge = (query: string) => Promise<string>

export type OnInterruptTask = (taskId?: string) => Promise<{ ok: boolean; message: string }>

export interface RouterOptions {
  mode: AgentMode
  cwd?: string
  agentDir?: string
  /** 提供时启用持久会话（continueRecent：有则继续最近会话、无则新建，文件直接落在该目录）；缺省 inMemory */
  sessionDir?: string
  /** true 时强制新建会话（"新会话"功能）；缺省 false=continueRecent 续最近会话 */
  newSession?: boolean
  /** 启动恢复：按 id 精确续接会话（db 记录的当前会话）；文件未命中（被删等）回落 continueRecent */
  resumeSessionId?: string
  fakeStreamDelayMs?: number
  /** real 模式：settings 键 router.model 的值（"provider/model-id"），缺省取第一个可用模型 */
  realModelId?: string
  /** 全局思考档位（app.db settings）；缺省 off，避免 SDK 默认的 medium 悄悄打开思考 */
  thinkingLevel?: ThinkingLevel
  onDispatchTask?: OnDispatchTask
  onInterruptTask?: OnInterruptTask
  onTaskStatus?: OnTaskStatus
  onSearchKnowledge?: OnSearchKnowledge
  onChunk: (event: ChatChunkEvent) => void
  onNotice: (event: ChatNoticeEvent) => void
  /** 低频结构化流事件（工具生命周期 start/end）透传；缺省不订阅。与 onChunk 分通道：delta 绝不双发 */
  onStreamEvent?: (event: ChatStreamEvent) => void
  /** 思考内容流透传；与 onChunk 分通道独立合批，delta 绝不双发 */
  onThinking?: (event: ChatThinkingEvent) => void
  /** 上下文压缩事件透传（pi 的 compaction_start/end）；缺省不订阅 */
  onCompaction?: (event: ChatCompactionEvent) => void
}

export interface ThinkingStatus {
  thinkingLevel: ThinkingLevel
  availableLevels: ThinkingLevel[]
}

export interface Router {
  send: (text: string) => Promise<string>
  /** 用户叫停当前 run：无活跃 run 时 no-op；被叫停的消息以 stopReason='aborted' 终结（非 error），缓冲照常泵出 */
  stopRun: () => Promise<void>
  /** 重新生成：把最后一条 user 原文经 send 路径重发一次，返回新 assistant messageId；忙碌或无可重发时抛错 */
  regenerate: () => Promise<string>
  /** 恢复的历史消息（user/assistant + 摘要条目），渲染层就绪后经 chat:history 一次性推送 */
  getHistory: () => ChatHistoryMessage[]
  /** 当前会话 id（db 落账与切换校验用） */
  getSessionId: () => string
  /** 当前生效的系统提示词（pi 只读 getter）。AGENTS.md 记忆在 createRouter 时读定，改动要等 Router 重建才生效 */
  getSystemPrompt: () => string
  getActiveToolNames: () => string[]
  /** 当前生效档位与模型支持的档位（clamp 后的真实结果，UI 据此生成选项） */
  getThinkingStatus: () => ThinkingStatus
  /** 即时切换档位；SDK 会 clamp 并写入会话记录，不重建 Router */
  setThinkingLevel: (level: ThinkingLevel) => void
  /** fake 模式下 streamSimple 被调用次数（合并批处理断言用）；real 模式恒 0 */
  getLLMCallCount: () => number
  /** 空闲判定（记忆整理后的热重建门卫）：无运行中回合、无压缩、无攒批积压 */
  isIdle: () => boolean
  dispose: () => void
}

// 任务意图：匹配则派发 dispatch_task
const INTENT_PATTERN = /做个|写一个|创建/

// 叫停意图：匹配则调用 interrupt_task
const INTERRUPT_PATTERN = /停|叫停|取消/

// 查询意图：匹配则调用 task_status
const STATUS_PATTERN = /忙|状态|在干什么/

// 知识检索意图：匹配则调用 search_knowledge（排在任务意图之后判定，"写一个知识库工具"仍走派发）
const KNOWLEDGE_PATTERN = /查资料|知识库|帮我查/

const TOOL_UPDATE_INTERVAL_MS = 100

// bash 意图：匹配则调用 bash（探针命令里 $(( )) 算术只有真 bash 能算，回显即证明真实执行链路）
const BASH_PATTERN = /跑命令|执行命令/
const BASH_PROBE_COMMAND = 'echo PI-BASH-OK-$((41+1))'

// MCP 探针意图：匹配则调用 MCP 扩展注册的 mcp__probe__echo 工具（server 由测试种进 mcp.json，exposure 缺省 direct）
const MCP_PATTERN = /mcp探针/
const MCP_PROBE_PAYLOAD = 'MCP-PROBE-PAYLOAD'

// 技能探针意图：匹配则用 bash 读种子技能全文（验证渐进披露的读取环：提示词只放 name+description，正文靠 bash）
const SKILL_PATTERN = /技能探针/
export const SKILL_PROBE_DIR = 'probe-skill'

// 从用户文本派生 taskId（有则精确叫停，无则由主进程取最近运行任务）
const TASK_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i

// pi 把压缩摘要注回上下文时的 user 消息前缀（pi 的 COMPACTION_SUMMARY_PREFIX 未从包根导出，按文本识别）：
// 上下文出现该前缀即表示压缩前历史已被摘要取代
const COMPACTION_SUMMARY_MARKER = 'The conversation history before this point was compacted into the following summary:'

interface BufferedItem {
  id: string
  text: string
}

// 单条直投原文（保持既有行为）；多条才拼信封，一次 LLM 调用覆盖全部
function mergeBufferItems(items: BufferedItem[]): string {
  if (items.length === 1) return items[0]!.text
  return items
    .map((item) => {
      const marker = item.text.startsWith(TASK_REPORT_PREFIX) ? TASK_EVENT_ENVELOPE_MARKER : USER_ENVELOPE_MARKER
      return `${marker}\n${item.text}`
    })
    .join('\n')
}

// 解析合并信封；非信封文本返回 undefined
function parseEnvelope(text: string): { userTexts: string[]; taskTexts: string[] } | undefined {
  const lines = text.split('\n')
  if (lines[0] !== USER_ENVELOPE_MARKER && lines[0] !== TASK_EVENT_ENVELOPE_MARKER) return undefined
  const buckets: Array<{ kind: 'user' | 'task'; lines: string[] }> = []
  for (const line of lines) {
    if (line === USER_ENVELOPE_MARKER) buckets.push({ kind: 'user', lines: [] })
    else if (line === TASK_EVENT_ENVELOPE_MARKER) buckets.push({ kind: 'task', lines: [] })
    else buckets.at(-1)?.lines.push(line)
  }
  return {
    userTexts: buckets.filter((b) => b.kind === 'user').map((b) => b.lines.join('\n')),
    taskTexts: buckets.filter((b) => b.kind === 'task').map((b) => b.lines.join('\n'))
  }
}

// 确定性脚本（按转录末尾状态分流）：
// 1. 末条是 toolResult → 转述任务回执（含 taskId）
// 2. 末条用户消息是 [task-report] 注入 → 向用户转述任务结果
// 3. 末条是合并信封 → 含任务汇报则转述；含叫停/查询/任务意图则分别派发对应工具
// 4. 末条用户消息命中叫停/查询/bash/MCP/技能意图 → 分别派发对应工具
// 5. 末条用户消息命中任务意图 → emit dispatch_task toolCall（title/prompt 从用户文本派生）
// 6. 末条用户消息命中知识检索意图 → emit search_knowledge toolCall（query 用原文整句）
// 7. 其余 → "OK: <原文>"（多轮时引用首轮；信封原样回显，便于断言注入内容）
function scriptedTurn(messages: { role: string; content: unknown }[], skillProbeCommand?: string): ScriptedTurn {
  const last = messages.at(-1)
  if (last && last.role === 'toolResult') {
    return { kind: 'text', text: `已收到任务回执：${textOf(last)}` }
  }
  const userTexts = messages.filter((m) => m.role === 'user').map(textOf)
  const lastUser = userTexts.at(-1) ?? ''
  if (lastUser.startsWith(TASK_REPORT_PREFIX)) {
    return { kind: 'text', text: lastUser.slice(TASK_REPORT_PREFIX.length).trim() }
  }
  const envelope = parseEnvelope(lastUser)
  if (envelope) {
    if (envelope.taskTexts.length > 0) {
      const reports = envelope.taskTexts.map((t) =>
        t.startsWith(TASK_REPORT_PREFIX) ? t.slice(TASK_REPORT_PREFIX.length).trim() : t
      )
      return { kind: 'text', text: reports.join('；') }
    }
    const interruptUser = envelope.userTexts.find((t) => INTERRUPT_PATTERN.test(t))
    if (interruptUser) {
      const taskId = TASK_ID_PATTERN.exec(interruptUser)?.[0]
      return { kind: 'toolCall', name: 'interrupt_task', arguments: taskId ? { taskId } : {} }
    }
    const statusUser = envelope.userTexts.find((t) => STATUS_PATTERN.test(t))
    if (statusUser) {
      return { kind: 'toolCall', name: 'task_status', arguments: {} }
    }
    const bashUser = envelope.userTexts.find((t) => BASH_PATTERN.test(t))
    if (bashUser) {
      return { kind: 'toolCall', name: 'bash', arguments: { command: BASH_PROBE_COMMAND } }
    }
    const mcpUser = envelope.userTexts.find((t) => MCP_PATTERN.test(t))
    if (mcpUser) {
      return { kind: 'toolCall', name: 'mcp__probe__echo', arguments: { text: MCP_PROBE_PAYLOAD } }
    }
    const skillUser = envelope.userTexts.find((t) => SKILL_PATTERN.test(t))
    if (skillUser && skillProbeCommand) {
      return { kind: 'toolCall', name: 'bash', arguments: { command: skillProbeCommand } }
    }
    const intentUser = envelope.userTexts.find((t) => INTENT_PATTERN.test(t))
    if (intentUser) {
      return {
        kind: 'toolCall',
        name: 'dispatch_task',
        arguments: { title: intentUser.slice(0, 20), prompt: intentUser }
      }
    }
    const knowledgeUser = envelope.userTexts.find((t) => KNOWLEDGE_PATTERN.test(t))
    if (knowledgeUser) {
      return { kind: 'toolCall', name: 'search_knowledge', arguments: { query: knowledgeUser } }
    }
  } else {
    if (INTERRUPT_PATTERN.test(lastUser)) {
      const taskId = TASK_ID_PATTERN.exec(lastUser)?.[0]
      return { kind: 'toolCall', name: 'interrupt_task', arguments: taskId ? { taskId } : {} }
    }
    if (STATUS_PATTERN.test(lastUser)) {
      return { kind: 'toolCall', name: 'task_status', arguments: {} }
    }
    if (BASH_PATTERN.test(lastUser)) {
      return { kind: 'toolCall', name: 'bash', arguments: { command: BASH_PROBE_COMMAND } }
    }
    if (MCP_PATTERN.test(lastUser)) {
      return { kind: 'toolCall', name: 'mcp__probe__echo', arguments: { text: MCP_PROBE_PAYLOAD } }
    }
    if (SKILL_PATTERN.test(lastUser) && skillProbeCommand) {
      return { kind: 'toolCall', name: 'bash', arguments: { command: skillProbeCommand } }
    }
  }
  if (INTENT_PATTERN.test(lastUser)) {
    return {
      kind: 'toolCall',
      name: 'dispatch_task',
      arguments: { title: lastUser.slice(0, 20), prompt: lastUser }
    }
  }
  if (KNOWLEDGE_PATTERN.test(lastUser)) {
    return { kind: 'toolCall', name: 'search_knowledge', arguments: { query: lastUser } }
  }
  const hadAssistantReply = messages.some((m) => m.role === 'assistant')
  // 压缩后上下文的首条 user 是压缩摘要回执（非真实发言，且回显含压缩前全文）：
  // "首轮"已被摘要取代，不再引用，否则回复会把压缩前内容原样带回
  const compacted = userTexts.some((t) => t.startsWith(COMPACTION_SUMMARY_MARKER))
  const text =
    hadAssistantReply && userTexts.length > 1 && !compacted ? `OK: ${lastUser} | 首轮: ${userTexts[0]}` : `OK: ${lastUser}`
  return { kind: 'text', text }
}

async function createFakeModelRuntime(
  fakeStreamDelayMs: number,
  thinkingLevel: ThinkingLevel,
  onLLMCall: () => void,
  skillProbeCommand?: string
): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null })
  modelRuntime.registerProvider('fake', {
    name: 'Fake',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test',
    api: 'fake-api',
    // 事件序列（start→延迟→abort 终结→toolcall/text→done）由 pi-shared 的驱动统一保证
    streamSimple: (model, context, options) => {
      onLLMCall()
      // off 不产生思考块；其余档位按档位名生成可辨认的思考文本，便于离线断言档位确实传到流里
      const level = (options?.reasoning ?? thinkingLevel) as ThinkingLevel
      return driveFakeAssistantStream({
        model,
        getTurn: () => scriptedTurn(context.messages, skillProbeCommand),
        delayMs: fakeStreamDelayMs,
        signal: options?.signal,
        thinkingText: level === 'off' ? undefined : `思考档位 ${level}：先拆解问题，再给出回答。`,
        // 透传请求上下文：usage 按 chars/4 造数，让 pi 的自动压缩在 fake 模式下真实触发
        context
      })
    },
    models: [fakeChatModelConfig('scripted-1', 'Scripted', true)]
  })
  return modelRuntime
}

function isUnconfiguredError(message: string): boolean {
  return /api key/i.test(message)
}

const ROUTER_SYSTEM_PROMPT =
  '你是本地 Super-agent 的 Router，常驻主会话，负责理解用户意图、规划与记忆。分工：问答、知识检索、单步只读命令（查看状态/列目录等）自己直接做；写文件、改代码、多步执行、并行任务用 dispatch_task 派发给独立 Worker，不要自己执行。派发后任务异步执行，结果以 [task-report] 开头注回本会话，届时向用户简短转述；期间可用 task_status 查询、interrupt_task 叫停。'

// Router 三档预算：配合 protocol 的 SDK_LEVEL_BY_TIER（UI low→SDK low、high→medium、max→high）。
// 模型 maxTokens 8192 给正文留 1024，因此 high 档 7168 已是上限；medium 4096 与它拉开距离。
const ROUTER_THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 4096, high: 7168 }

// dispatch_task：把重活派给独立 Worker。taskId 由主进程生成，通过工具返回值回给模型
function createDispatchTool(onDispatchTask: OnDispatchTask | undefined) {
  return defineTool({
    name: 'dispatch_task',
    label: '派发任务',
    description: '把实际执行任务派发给独立 Worker（具备读写文件、执行命令的完整工具）。返回 taskId；任务结果完成后会自动注入本会话，届时再向用户汇报。',
    promptSnippet: '派发实际执行任务给独立 Worker',
    parameters: Type.Object({
      title: Type.String({ description: '任务的简短标题' }),
      prompt: Type.String({ description: '给 Worker 的完整任务指令' })
    }),
    execute: async (_toolCallId, params) => {
      if (!onDispatchTask) {
        return { content: [{ type: 'text', text: '任务派发未配置，无法执行' }], details: undefined }
      }
      const { taskId } = await onDispatchTask({ title: params.title, prompt: params.prompt })
      return { content: [{ type: 'text', text: `任务已启动（id: ${taskId}）` }], details: undefined }
    }
  })
}

// task_status：读 SQLite 任务列表，让 Router 能回答"在忙什么"
function createTaskStatusTool(onTaskStatus: OnTaskStatus | undefined) {
  return defineTool({
    name: 'task_status',
    label: '任务状态',
    description: '查询任务列表与状态（id/标题/状态/创建与结束时间）。不传 taskId 返回全部任务。',
    promptSnippet: '查询任务列表与状态',
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: '只查这一个任务' }))
    }),
    execute: async (_toolCallId, params) => {
      if (!onTaskStatus) {
        return { content: [{ type: 'text', text: '任务查询未配置' }], details: undefined, isError: true }
      }
      const rows = await onTaskStatus(params.taskId || undefined)
      if (rows.length === 0) {
        const message = params.taskId ? `任务不存在：${params.taskId}` : '当前没有任务'
        return { content: [{ type: 'text', text: message }], details: undefined, isError: params.taskId !== undefined }
      }
      const lines = rows.map(
        (r) => `${r.id} | ${r.title} | ${r.status} | 创建 ${r.created}${r.finished ? ` | 结束 ${r.finished}` : ''}`
      )
      return { content: [{ type: 'text', text: `任务列表（${rows.length} 个）：\n${lines.join('\n')}` }], details: undefined }
    }
  })
}

// interrupt_task：叫停指定任务。错误（不存在/已结束）以 isError 结果返回，不抛给 UI
function createInterruptTool(onInterruptTask: OnInterruptTask | undefined) {
  return defineTool({
    name: 'interrupt_task',
    label: '中止任务',
    description: '立即中止一个进行中的任务：Worker 会被叫停，状态置为 aborted，不再有任何产出。不传 taskId 时中止最近一个进行中的任务。',
    promptSnippet: '中止进行中的任务',
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: '要中止的任务 id，缺省取最近一个进行中的任务' }))
    }),
    execute: async (_toolCallId, params) => {
      if (!onInterruptTask) {
        return { content: [{ type: 'text', text: '任务中止未配置' }], details: undefined, isError: true }
      }
      const result = await onInterruptTask(params.taskId || undefined)
      return { content: [{ type: 'text', text: result.message }], details: undefined, isError: !result.ok }
    }
  })
}

// search_knowledge：检索导入的知识库，把编号片段交回模型作答；检索失败以 isError 结果返回，不抛给 UI
function createSearchKnowledgeTool(onSearchKnowledge: OnSearchKnowledge | undefined) {
  return defineTool({
    name: 'search_knowledge',
    label: '知识检索',
    description: '检索已导入的知识库，返回与查询相关的编号片段（含文档标题与段落标题）。回答需要资料支撑时先调用它。',
    promptSnippet: '检索知识库',
    parameters: Type.Object({
      query: Type.String({ description: '要检索的问题或关键词' })
    }),
    execute: async (_toolCallId, params) => {
      if (!onSearchKnowledge) {
        return { content: [{ type: 'text', text: '知识检索未配置' }], details: undefined, isError: true }
      }
      try {
        const text = await onSearchKnowledge(params.query)
        return { content: [{ type: 'text', text }], details: undefined }
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessageOf(err) }], details: undefined, isError: true }
      }
    }
  })
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { mode, cwd, agentDir, onChunk, onNotice, onStreamEvent, onThinking, onDispatchTask, onInterruptTask, onTaskStatus, onSearchKnowledge } = options
  // 全局档位是唯一真相源：每次建会话都传，缺省 off。SDK 默认 medium 会在未设置时悄悄打开思考。
  const thinkingLevel = options.thinkingLevel ?? 'off'
  // 上下文文件（AGENTS.md/CLAUDE.md 记忆）：agentDir + cwd 祖先链，pi 的 loadProjectContextFiles 显式加载，
  // 无 agentDir 时不加载（空数组 → 系统提示词与原行为一致）
  const contextFiles = agentDir ? loadProjectContextFiles({ cwd: cwd ?? process.cwd(), agentDir }) : []
  // 长期记忆（MEMORY.md，启动整理产物）随上下文文件注入，读定语义与 AGENTS.md 一致：改动要等 Router 重建
  const memoryFile = agentDir ? readMemoryForContext(agentDir) : undefined
  if (memoryFile) contextFiles.push(memoryFile)
  // 内置 exec 四件套仍被 noTools:'builtin' 排除；bash 作为显式注册的自定义工具放行（见 router.test.ts 的工具集契约）
  const sessionCwd = cwd ?? process.cwd()
  const customTools = [
    defineTool(createBashToolDefinition(sessionCwd)),
    createDispatchTool(onDispatchTask),
    createInterruptTool(onInterruptTask),
    createTaskStatusTool(onTaskStatus),
    createSearchKnowledgeTool(onSearchKnowledge)
  ]
  let llmCalls = 0
  // 持久会话三态：newSession 强制新建；resumeSessionId 精确续接（未命中回落 continueRecent）；缺省 continueRecent
  //（continueRecent 有则继续、无则新建；SessionManager.create 会立即落盘，由 continueRecent 统一处理）
  let sessionManager: SessionManager
  if (!options.sessionDir) {
    sessionManager = SessionManager.inMemory()
  } else if (options.newSession) {
    sessionManager = SessionManager.create(sessionCwd, options.sessionDir)
  } else {
    const resumePath = options.resumeSessionId
      ? SessionManager.findById(sessionCwd, options.resumeSessionId, options.sessionDir)
      : undefined
    sessionManager = resumePath
      ? SessionManager.open(resumePath, options.sessionDir, cwd)
      : SessionManager.continueRecent(sessionCwd, options.sessionDir)
  }

  let session: AgentSession
  // MCP 配置与 skills 都随 Router 创建读定一次（配置变更不热载，随 Router 重建生效，同 models.json/AGENTS.md 语义）。
  // 启动期错误（mcp.json 解析/校验、skills 诊断）走 chat:notice，聊天里可见但不中断会话
  const mcpConfig = agentDir ? await loadAppMcpConfig(agentDir) : { servers: [], errors: [] }
  for (const message of mcpConfig.errors) {
    onNotice({ kind: 'extension-warning', message })
  }
  // Router 与 Worker 同读 agentDir/skills（渐进披露：提示词只放 name+description，bash 读全文）；
  // Router 不播种技能（那是 Worker 的幂等播种）。目录缺失时不传该路径——loadSkills 对缺失路径会发
  // "skill path does not exist" 诊断，而首启没有 skills 是常态不是错误
  const skillsDir = agentDir ? join(agentDir, 'skills') : undefined
  const skills =
    agentDir && skillsDir && existsSync(skillsDir)
      ? loadSkills({ cwd: sessionCwd, agentDir, skillPaths: [skillsDir], includeDefaults: false })
      : { skills: [], diagnostics: [] }
  for (const diagnostic of skills.diagnostics) {
    onNotice({ kind: 'extension-warning', message: `技能 ${diagnostic.message}${diagnostic.path ? `（${diagnostic.path}）` : ''}` })
  }
  // MCP 扩展随 Router 注入；pi-subagents 只挂 Worker（Router 不留重叠委派路径），此处不加载子代理扩展
  const extensions = await loadAppExtensions({
    cwd: sessionCwd,
    loadConfig: () => mcpConfig
  })
  for (const error of extensions.errors) {
    onNotice({ kind: 'extension-warning', message: `扩展 ${error.path} 加载失败：${error.error}` })
  }
  if (mode === 'fake') {
    // 技能探针命令：bash 工具在 Git Bash 里跑，反斜杠路径会被当转义符，统一换正斜杠
    const skillProbeCommand = agentDir
      ? `cat ${join(agentDir, 'skills', SKILL_PROBE_DIR, 'SKILL.md').replace(/\\/g, '/')}`
      : undefined
    const modelRuntime = await createFakeModelRuntime(options.fakeStreamDelayMs ?? 0, thinkingLevel, () => {
      llmCalls++
    }, skillProbeCommand)
    const model = modelRuntime.getModel('fake', 'scripted-1')
    if (!model) throw new Error('fake model scripted-1 not registered')
    ;({ session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel,
      sessionManager,
      settingsManager: SettingsManager.inMemory({ thinkingBudgets: ROUTER_THINKING_BUDGETS }),
      resourceLoader: minimalResourceLoader(ROUTER_SYSTEM_PROMPT, contextFiles, extensions, skills),
      noTools: 'builtin',
      customTools
    }))
  } else {
    if (agentDir && !hasModelConfig(agentDir)) {
      onNotice({
        kind: 'model-not-configured',
        message: `未配置模型：请将 models.json 与 auth.json 放入 ${agentDir}（OpenAI 兼容 provider 格式），或改用 fake 模式`
      })
    }
    let explicitModel: { model: Model<Api>; modelRuntime: ModelRuntime } | undefined
    if (options.realModelId && agentDir) {
      explicitModel = await resolveRealModel(agentDir, options.realModelId)
      if (!explicitModel) {
        console.warn(`[router] router.model "${options.realModelId}" not found, falling back to first available model`)
      }
    }
    ;({ session } = await createAgentSession({
      cwd,
      agentDir,
      thinkingLevel,
      ...(explicitModel ? { model: explicitModel.model, modelRuntime: explicitModel.modelRuntime } : {}),
      sessionManager,
      settingsManager: SettingsManager.inMemory({ thinkingBudgets: ROUTER_THINKING_BUDGETS }),
      resourceLoader: minimalResourceLoader(ROUTER_SYSTEM_PROMPT, contextFiles, extensions, skills),
      noTools: 'builtin',
      customTools
    }))
  }
  // 扩展绑定（pi 自家 print 模式先例）：发 session_start 让 MCP 扩展开始连接，之后上报未处理 server；
  // 扩展事件处理器的异常映射为 notice，不终止会话
  await session.bindExtensions({
    mode: 'print',
    onError: (error) => {
      onNotice({ kind: 'extension-warning', message: `扩展 ${error.extensionPath} 事件 ${error.event} 失败：${error.error}` })
    }
  })

  return new RouterLoop({
    session,
    onChunk,
    onNotice,
    onStreamEvent,
    onThinking,
    onCompaction: options.onCompaction,
    getLLMCallCount: () => llmCalls
  })
}

// 压缩事件 seq 用进程级计数：切模式/新会话会重建 RouterLoop 而渲染层时间线不清空，
// 实例字段归零后会与上一代 Router 的压缩行撞 seq（就地替换错行）
let compactionSeqCounter = 0

// 高频 text_delta 合批为低频 onChunk 事件（16ms 一帧窗口 + 512 字符突发保护）。正确性不变量：
// I1 每 messageId 的 delta 按序拼接 === 收到的 delta 拼接（只相接，不重排不丢字）；
// I2 每条消息恰好一个 done 且是该 id 最后一个事件（terminate 先冲刷该 id 缓冲再发终态）；
// I3 跨 id 顺序不保证（渲染层按 messageId 寻址，懒 upsert 语义不需要配合改动）。
// dispose 丢弃不冲刷：Router 已 dispose，旧流按放弃处理（与切模式既有语义一致）
class DeltaBatcher<T> {
  private buffers = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly make: (id: string, delta: string) => T
  private readonly emit: (event: T) => void
  private readonly flushMs: number
  private readonly flushChars: number

  constructor(make: (id: string, delta: string) => T, emit: (event: T) => void, flushMs = 16, flushChars = 512) {
    this.make = make
    this.emit = emit
    this.flushMs = flushMs
    this.flushChars = flushChars
  }

  push(id: string, delta: string): void {
    if (delta === '') return
    const buffered = this.buffers.get(id)
    if (buffered === undefined) {
      this.emit(this.make(id, delta))
      // 空 buffer 标记本窗口已直发首 delta：同窗口内后续 delta 进缓冲等冲刷
      this.buffers.set(id, '')
      this.armTimer()
      return
    }
    const merged = buffered + delta
    this.buffers.set(id, merged)
    if (merged.length >= this.flushChars) {
      this.flush(id)
      return
    }
    this.armTimer()
  }

  terminate(id: string, terminal: T): void {
    this.flush(id)
    this.emit(terminal)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.buffers.clear()
  }

  private armTimer(): void {
    this.timer ??= setTimeout(() => this.flushAll(), this.flushMs)
  }

  private flush(id: string): void {
    const buffered = this.buffers.get(id)
    if (!buffered) {
      this.buffers.delete(id)
      return
    }
    this.buffers.delete(id)
    this.emit(this.make(id, buffered))
  }

  private flushAll(): void {
    this.timer = null
    for (const id of this.buffers.keys()) this.flush(id)
  }
}

class RouterLoop implements Router {
  private currentIds: string[] = []
  private pendingBuffer: BufferedItem[] = []
  private readonly doneIds = new Set<string>()
  private runActive = false
  private compacting = false
  private errorSeen: string | null = null
  private disposed = false
  // 用户叫停的 run 生命周期状态：stopRun 活跃时置位、settle 清空；settle 仍有未认领 id 则按 aborted 终结
  private stopRequested = false
  private thinkingBlockSeq = 0
  // 在途思考行（已 start 未 end）的 key：叫停时补发 end，思考行不得悬挂在流式态
  private openThinkingKey: string | null = null
  private readonly openTools = new Map<
    string,
    { startedAt: number; summary: string; label: string; lastUpdateAt: number }
  >()
  // 同一对 start/end 共用一个 seq；end 缺 start（防御）时取新 seq
  private openCompactionSeq: number | null = null
  private readonly deps: {
    session: AgentSession
    onChunk: (event: ChatChunkEvent) => void
    onNotice: (event: ChatNoticeEvent) => void
    onStreamEvent?: (event: ChatStreamEvent) => void
    onThinking?: (event: ChatThinkingEvent) => void
    onCompaction?: (event: ChatCompactionEvent) => void
    getLLMCallCount: () => number
  }
  // 合批器的 emit 落到 deps.onChunk（箭头只捕获 this，deps 在构造体内先于任何事件赋值）。
  // thinking 用同一算法但独立实例与独立通道，两个流的 16ms 窗口互不干扰。
  private readonly batcher = new DeltaBatcher<ChatChunkEvent>(
    (id, delta) => ({ messageId: id, delta, done: false }),
    (event) => this.deps.onChunk(event)
  )
  private readonly thinkingBatcher = new DeltaBatcher<ChatThinkingEvent>(
    (key, delta) => ({ key, phase: 'delta', delta }),
    (event) => this.deps.onThinking?.(event)
  )
  private readonly unsubscribe: () => void

  constructor(deps: {
    session: AgentSession
    onChunk: (event: ChatChunkEvent) => void
    onNotice: (event: ChatNoticeEvent) => void
    onStreamEvent?: (event: ChatStreamEvent) => void
    onThinking?: (event: ChatThinkingEvent) => void
    onCompaction?: (event: ChatCompactionEvent) => void
    getLLMCallCount: () => number
  }) {
    this.deps = deps
    this.unsubscribe = deps.session.subscribe((event: AgentSessionEvent) => this.onEvent(event))
  }

  async send(text: string): Promise<string> {
    if (this.disposed) throw new Error('router disposed')
    const id = randomUUID()
    if (this.runActive || this.compacting || this.pendingBuffer.length > 0) {
      // 忙碌（run 进行中 / 压缩中 / 已有排队）：入攒批缓冲，等 agent_settled 后合并为一次注入。
      // 不走 followUp：它逐条开回合（多次 LLM 调用），且空闲时静默吞消息、顺序依赖队列 FIFO。
      this.pendingBuffer.push({ id, text })
    } else {
      this.startRun(text, [id])
    }
    return id
  }

  // 用户叫停：空闲时 no-op（不置位、不 abort，避免污染后续 run）；活跃时置位并 abort，
  // pi 把在流中的消息以 message_end(stopReason='aborted') 收尾（errorSeen 保持空），settle 照常泵出缓冲
  async stopRun(): Promise<void> {
    if (!this.runActive) return
    this.stopRequested = true
    await this.deps.session.abort()
  }

  // 重新生成 = 最后一条 user 原文经 send 路径原样重发（复用 run 启动，返回新 assistant messageId）。
  // 上下文回溯：branch(lastUser.parentId) 把 leaf 挪回该 user 条目之前，更早回合保留在上下文里
  // （pi 每次运行经 buildSessionProjection() 按根→叶取上下文）；该 user 条目本身是根（无前文可留）
  // 时退化为 resetLeaf() 重开新根。会话树是 append-only 的：被放弃的分支（旧 user/reply/工具条目）
  // 原样留存，条目不删不改。
  async regenerate(): Promise<string> {
    if (this.disposed) throw new Error('router disposed')
    if (this.runActive || this.compacting || this.pendingBuffer.length > 0) {
      throw new Error('回复进行中，无法重新生成')
    }
    const entries = this.deps.session.sessionManager.getEntries()
    const messageEntries = entries.filter((entry): entry is SessionMessageEntry => entry.type === 'message')
    const lastUser = messageEntries.findLast(
      (entry): entry is SessionMessageEntry & { message: UserMessage } => entry.message.role === 'user'
    )
    const hasAssistantReply = messageEntries.some((entry) => entry.message.role === 'assistant')
    if (!lastUser || !hasAssistantReply) throw new Error('无可重新生成的回复')
    const branchFromId = lastUser.parentId
    if (branchFromId === null) this.deps.session.sessionManager.resetLeaf()
    else this.deps.session.sessionManager.branch(branchFromId)
    return this.send(textOf(lastUser.message))
  }

  getActiveToolNames(): string[] {
    return [...this.deps.session.getActiveToolNames()]
  }

  getLLMCallCount(): number {
    return this.deps.getLLMCallCount()
  }

  getThinkingStatus(): ThinkingStatus {
    return {
      thinkingLevel: this.deps.session.thinkingLevel,
      availableLevels: this.deps.session.getAvailableThinkingLevels()
    }
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.deps.session.setThinkingLevel(level)
  }

  getHistory(): ChatHistoryMessage[] {
    return toHistoryMessages(this.deps.session.messages)
  }

  getSessionId(): string {
    return this.deps.session.sessionId
  }

  isIdle(): boolean {
    return !this.runActive && !this.compacting && this.pendingBuffer.length === 0
  }

  getSystemPrompt(): string {
    return this.deps.session.systemPrompt
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.batcher.dispose()
    this.thinkingBatcher.dispose()
    // AgentSession.dispose 不发 session_shutdown（pi 只在 reload 与 AgentSessionRuntime.dispose 发它），
    // 而 MCP 扩展只在 session_shutdown 里关闭连接——不发的话 stdio server 子进程一直活着：
    // Electron 长驻主进程会泄漏子进程，node --test 的测试进程也会被孙进程挂住
    const runner = this.deps.session.extensionRunner
    if (runner.hasHandlers('session_shutdown')) {
      void runner.emit({ type: 'session_shutdown', reason: 'quit' }).catch(() => {})
    }
    this.deps.session.dispose()
  }

  private startRun(text: string, ids: string[]): void {
    this.runActive = true
    this.currentIds = ids
    this.errorSeen = null
    this.thinkingBlockSeq = 0
    try {
      const run = this.deps.session.prompt(text, { expandPromptTemplates: false })
      void run.then(
        () => {},
        (err: unknown) => this.failRun(err)
      )
    } catch (err) {
      this.failRun(err)
    }
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_update': {
        const a = event.assistantMessageEvent
        if (a.type === 'text_delta' && this.currentIds.length > 0) {
          // 合并回合的回复扇出给每条缓冲消息（对外契约不变：每条消息独立流式回复）
          for (const id of this.currentIds) {
            this.batcher.push(id, a.delta)
          }
        } else if (a.type === 'thinking_start' || a.type === 'thinking_delta' || a.type === 'thinking_end') {
          this.emitThinkingEvent(a)
        } else if (a.type === 'error') {
          this.errorSeen = a.error.errorMessage ?? '模型返回错误'
        }
        break
      }
      // 工具生命周期唯一来源：toolcall_* 只是参数流，不再单独转发（避免重复终态）
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.onToolExecution(event)
        break
      case 'message_end':
        if (event.message.role !== 'assistant' || this.currentIds.length === 0) break
        // 工具调用只是回合中段：工具结果回来后还有面向用户的文本回复，messageId 保持不变
        if (event.message.stopReason === 'toolUse') break
        if (event.message.stopReason === 'error') {
          this.errorSeen = event.message.errorMessage ?? this.errorSeen ?? '模型返回错误'
          // pi 在流错误时正常结束 run（prompt 不抛错），错误只挂在这条 assistant 消息上。
          // 必须当场收尾：先清空 currentIds 再等 settle，已经没人能认领这条错误，
          // 表现就是「发了消息界面毫无反应」。
          this.emitErrorForAll(this.currentIds)
        } else if (event.message.stopReason === 'aborted') {
          // pi 的 abort 路径与 error 分道：被叫停的流以 message_end(stopReason='aborted') 正常终结，
          // errorSeen 全程为空。按用户终结而非失败收尾——补关在途思考行（真实模型可 mid-thinking 被叫停），
          // 所有当前 id 以 aborted 终结，无错误文本、无 router-error，settle 照常泵出缓冲。
          this.terminateAsAborted(this.currentIds)
        } else {
          this.completeAll(this.currentIds)
        }
        this.currentIds = []
        break
      case 'compaction_start': {
        // 压缩进行中 prompt() 会 throw（速查表第 4 节）：该状态下到达的事件进缓冲等 settled
        this.compacting = true
        const seq = ++compactionSeqCounter
        this.openCompactionSeq = seq
        this.deps.onCompaction?.({ seq, phase: 'start' })
        break
      }
      case 'compaction_end': {
        this.compacting = false
        // 无 start 直接 end 的防御分支取新 seq；end 复用 start 已递增的 seq
        const seq = this.openCompactionSeq ?? ++compactionSeqCounter
        this.openCompactionSeq = null
        this.deps.onCompaction?.({
          seq,
          phase: 'end',
          tokensBefore: event.result?.tokensBefore,
          error: event.aborted ? '压缩已中止' : event.errorMessage || undefined
        })
        this.pump()
        break
      }
      case 'agent_settled':
        this.settle()
        break
    }
  }

  // 思考内容转发：key = `${anchorMessageId}:t${本轮序号}`，同一块 start/delta/end 稳定一致。
  // 不能用 contentIndex——每条 assistant 消息重置，工具调用后的最终回答会与工具调用消息共用同一个 0，
  // 两块思考被渲染层合并成一行。扇出回合的多个 messageId 共享同一次思考，anchor 取首个。
  // end 必须先冲刷残留缓冲再发终态，否则最后一个 delta 会丢或乱序。
  private emitThinkingEvent(
    a: Extract<AssistantMessageEvent, { type: 'thinking_start' | 'thinking_delta' | 'thinking_end' }>
  ): void {
    const anchor = this.currentIds[0]
    if (!anchor) return
    if (a.type === 'thinking_start') {
      // 上一块未收尾就开新块（provider 交错）：先补它的终态，思考行不得悬挂
      if (this.openThinkingKey !== null) {
        this.thinkingBatcher.terminate(this.openThinkingKey, { key: this.openThinkingKey, phase: 'end' })
      }
      this.thinkingBlockSeq += 1
      const key = `${anchor}:t${this.thinkingBlockSeq}`
      this.deps.onThinking?.({ key, phase: 'start' })
      this.openThinkingKey = key
    } else if (a.type === 'thinking_delta') {
      this.thinkingBatcher.push(`${anchor}:t${this.thinkingBlockSeq}`, a.delta)
    } else {
      const key = `${anchor}:t${this.thinkingBlockSeq}`
      this.thinkingBatcher.terminate(key, { key, phase: 'end' })
      this.openThinkingKey = null
    }
  }

  // parentToolCallId 非空的是另一个工具执行期间的嵌套调用，不属于本轮步骤，忽略。
  private onToolExecution(event: ToolExecutionEvent): void {
    if (event.parentToolCallId) return
    const anchor = this.currentIds[0]
    if (!anchor) return
    const key = `${anchor}:${event.toolCallId}`
    const args = asRecord(event.args)
    if (event.type === 'tool_execution_start') {
      const info = toolDisplayInfo(event.toolName, args)
      const summary = toolCallLabel(event.toolName, args ?? {})
      this.openTools.set(key, { startedAt: Date.now(), summary, label: info.label, lastUpdateAt: 0 })
      this.deps.onStreamEvent?.({
        kind: 'tool',
        key,
        phase: 'start',
        toolName: event.toolName,
        callId: event.toolCallId,
        summary,
        label: info.label,
        ...(info.input ? { input: info.input } : {})
      })
      return
    }
    if (event.type === 'tool_execution_update') {
      const open = this.openTools.get(key)
      const now = Date.now()
      if (open && now - open.lastUpdateAt < TOOL_UPDATE_INTERVAL_MS) return
      if (open) open.lastUpdateAt = now
      const output = boundText(toolResultText(event.partialResult), TOOL_TEXT_LIMIT)
      if (output.length === 0) return
      this.deps.onStreamEvent?.({
        kind: 'tool',
        key,
        phase: 'update',
        toolName: event.toolName,
        callId: event.toolCallId,
        output
      })
      return
    }
    const open = this.openTools.get(key)
    this.openTools.delete(key)
    this.deps.onStreamEvent?.({
      kind: 'tool',
      key,
      phase: 'end',
      toolName: event.toolName,
      callId: event.toolCallId,
      ...(open ? { summary: open.summary, label: open.label } : {}),
      output: boundText(toolResultText(event.result), TOOL_TEXT_LIMIT),
      isError: event.isError === true,
      ...(event.durationMs !== undefined
        ? { durationMs: event.durationMs }
        : open
          ? { durationMs: Date.now() - open.startedAt }
          : {})
    })
  }

  private closeOpenTools(): void {
    if (this.openTools.size === 0) return
    for (const key of this.openTools.keys()) {
      this.deps.onStreamEvent?.({
        kind: 'tool',
        key,
        phase: 'end',
        isError: true,
        aborted: true,
        output: '工具执行被中止'
      })
    }
    this.openTools.clear()
  }

  // 一次 run 真正收尾：结清本 run 的 messageId，然后把攒批缓冲泵出为下一次（可能合并的）注入
  private settle(): void {
    this.closeOpenTools()
    if (this.currentIds.length > 0) {
      if (this.errorSeen !== null) this.emitErrorForAll(this.currentIds)
      // 叫停后 run 可能不再产生新 assistant 消息就结束（如工具执行中被叫停）：遗留 id 也按 aborted 终结
      else if (this.stopRequested) this.terminateAsAborted(this.currentIds)
      else this.completeAll(this.currentIds)
      this.currentIds = []
    }
    this.errorSeen = null
    this.stopRequested = false
    this.runActive = false
    this.pump()
  }

  // 缓冲非空且空闲时启动下一次 run：单条直投原文，多条合并成一条信封注入（一次 LLM 调用）
  private pump(): void {
    if (this.disposed || this.runActive || this.compacting || this.pendingBuffer.length === 0) return
    const items = this.pendingBuffer.splice(0)
    this.startRun(mergeBufferItems(items), items.map((item) => item.id))
  }

  private failRun(err: unknown): void {
    const ids = this.currentIds
    this.currentIds = []
    this.runActive = false
    this.errorSeen ??= errorMessageOf(err)
    if (ids.length > 0) this.emitErrorForAll(ids)
    else {
      this.deps.onNotice({
        kind: isUnconfiguredError(this.errorSeen) ? 'model-not-configured' : 'router-error',
        message: this.errorSeen
      })
    }
    // 失败时缓冲一并终结（避免渲染层悬挂）；下一次 send 重新起步
    for (const item of this.pendingBuffer) this.complete(item.id)
    this.pendingBuffer = []
    this.errorSeen = null
  }

  private emitErrorForAll(ids: string[]): void {
    for (const id of ids) this.emitErrorFor(id)
  }

  private completeAll(ids: string[]): void {
    for (const id of ids) this.complete(id)
  }

  // 用户叫停的终结（message_end:aborted 与 settle 兜底共用）：先补关在途思考行（end 先冲刷缓冲），
  // 再以 aborted 终结全部 id；复用 complete 的 doneIds 守卫与冲刷逻辑
  private terminateAsAborted(ids: string[]): void {
    if (this.openThinkingKey !== null) {
      this.thinkingBatcher.terminate(this.openThinkingKey, { key: this.openThinkingKey, phase: 'end' })
      this.openThinkingKey = null
    }
    this.closeOpenTools()
    for (const id of ids) this.complete(id, 'aborted')
  }

  private emitErrorFor(id: string): void {
    const message = this.errorSeen ?? '模型返回错误'
    this.deps.onNotice({ kind: isUnconfiguredError(message) ? 'model-not-configured' : 'router-error', message })
    if (!this.doneIds.has(id)) {
      this.doneIds.add(id)
      // 错误文本仍在 delta 里（human-readable 兜底不变），stopReason 显式标 error
      this.batcher.terminate(id, {
        messageId: id,
        delta: `模型调用失败：${message}`,
        done: true,
        stopReason: 'error'
      })
    }
  }

  private complete(id: string, stopReason: ChatStopReason = 'stop'): void {
    if (this.doneIds.has(id)) return
    this.doneIds.add(id)
    this.batcher.terminate(id, { messageId: id, delta: '', done: true, stopReason })
  }
}
