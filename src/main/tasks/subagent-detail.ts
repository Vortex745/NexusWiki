import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ChatSubagentDetailResponse, ChatSubagentDetailStep } from '../../shared/protocol.ts'
import {
  asRecord,
  boundText,
  stringField,
  SUBAGENT_LINE_LIMIT,
  SUBAGENT_STEP_LIMIT,
  textOf,
  TOOL_TEXT_LIMIT,
  toolDisplayInfo
} from '../chat/pi-shared.ts'

// 子代理过程回放：Worker 会话 JSONL 里的 subagent 工具调用携带子会话文件路径，
// 子会话自身是标准 pi 会话（assistant thinking/toolCall + toolResult），按序映射成步骤。
// 任何缺失（文件、字段、越界、半写）都回退成空步骤，绝不向渲染层抛错；UI 有实况进展兜底

interface LoadSubagentDetailOptions {
  agentDir: string
  taskId: string
  callId: string
}

// 会话里的消息按结构化边界读取（pi 的 AgentMessage 未从包根导出）：只关心 role/content/toolCallId 等
interface SessionMessage {
  role: string
  content?: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

interface ToolCallBlock {
  type: 'toolCall'
  id: string
  name: string
  arguments?: Record<string, unknown>
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== '.' && value !== '..'
}

function isUnder(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
  const record = asRecord(block)
  const args = record?.arguments
  const argsIsRecord = args === undefined || (typeof args === 'object' && args !== null && !Array.isArray(args))
  return record?.type === 'toolCall' && typeof record.id === 'string' && typeof record.name === 'string' && argsIsRecord
}

// Worker 会话目录下的最新 jsonl：同目录可能有历史重跑留下的旧会话，取最后写入的那个
function newestSessionFile(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  let newest: { path: string; mtimeMs: number } | undefined
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs }
    } catch {
      // 文件在枚举与 stat 之间消失：跳过这一个候选，其余照常
    }
  }
  return newest?.path
}

// 会话文件可能仍在写入或损坏：打开失败回放降级为空（不是错误）
function readMessages(path: string): SessionMessage[] {
  try {
    return SessionManager.open(path).buildSessionProjection().messages as SessionMessage[]
  } catch {
    return []
  }
}

function childSteps(messages: SessionMessage[]): ChatSubagentDetailStep[] {
  const steps: ChatSubagentDetailStep[] = []
  const byId = new Map<string, ChatSubagentDetailStep>()
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content as unknown[]) {
        const record = asRecord(block)
        if (record?.type === 'thinking') {
          const text = boundText(typeof record.thinking === 'string' ? record.thinking : '', TOOL_TEXT_LIMIT)
          if (text.length === 0) continue
          steps.push({ id: `thinking-${steps.length}`, kind: 'thinking', label: '已思考', output: text })
        } else if (isToolCallBlock(block)) {
          const info = toolDisplayInfo(block.name, block.arguments)
          const step: ChatSubagentDetailStep = {
            id: block.id,
            kind: 'tool',
            label: info.label,
            toolName: block.name,
            ...(info.input ? { input: info.input } : {})
          }
          byId.set(step.id, step)
          steps.push(step)
        }
      }
      continue
    }
    if (message.role !== 'toolResult') continue
    const output = boundText(textOf({ role: message.role, content: message.content ?? '' }), TOOL_TEXT_LIMIT)
    const existing = message.toolCallId ? byId.get(message.toolCallId) : undefined
    if (existing) {
      existing.output = output
      existing.isError = message.isError === true
      continue
    }
    // 调用块被压缩掉/跨分支时只剩结果：按结果自带的工具名补一条步骤
    const step: ChatSubagentDetailStep = {
      id: message.toolCallId ?? `result-${steps.length}`,
      kind: 'tool',
      label: toolDisplayInfo(message.toolName ?? '', {}).label,
      ...(message.toolName ? { toolName: message.toolName } : {}),
      output,
      isError: message.isError === true
    }
    steps.push(step)
  }
  return steps.slice(0, SUBAGENT_STEP_LIMIT)
}

export function loadSubagentDetail(options: LoadSubagentDetailOptions): ChatSubagentDetailResponse {
  const { agentDir, taskId, callId } = options
  const empty: ChatSubagentDetailResponse = { agent: '', task: '', steps: [] }
  if (!isSafeSegment(taskId) || callId.length === 0) return empty
  const workerSession = newestSessionFile(join(agentDir, 'workers', taskId))
  if (!workerSession) return empty

  const messages = readMessages(workerSession)
  let toolCall: ToolCallBlock | undefined
  let toolResult: SessionMessage | undefined
  for (const message of messages) {
    if (!toolCall && message.role === 'assistant' && Array.isArray(message.content)) {
      toolCall = (message.content as unknown[]).find(
        (block): block is ToolCallBlock => isToolCallBlock(block) && block.id === callId && block.name === 'subagent'
      )
    }
    if (!toolResult && message.role === 'toolResult' && message.toolCallId === callId) toolResult = message
  }

  const args = toolCall?.arguments
  const resultDetails = asRecord(asRecord(toolResult)?.details)
  const resultEntries = Array.isArray(resultDetails?.results) ? (resultDetails.results as unknown[]) : []
  const result = asRecord(resultEntries[0])
  const progressEntries = Array.isArray(resultDetails?.progress) ? (resultDetails.progress as unknown[]) : []
  const progress = asRecord(progressEntries[0] ?? result?.progress)

  const agent = boundText(
    stringField(result, 'agent') ?? stringField(progress, 'agent') ?? stringField(args, 'agent') ?? '',
    SUBAGENT_LINE_LIMIT
  )
  const task = boundText(
    stringField(result, 'task') ?? stringField(progress, 'task') ?? stringField(args, 'task') ?? '',
    TOOL_TEXT_LIMIT
  )
  const finalOutputRaw = stringField(result, 'finalOutput') ?? stringField(result, 'output')
  const response: ChatSubagentDetailResponse = {
    agent,
    task,
    steps: [],
    ...(finalOutputRaw ? { finalOutput: boundText(finalOutputRaw, TOOL_TEXT_LIMIT) } : {})
  }
  const sessionFile = stringField(result, 'sessionFile')
  if (!sessionFile) return response
  const resolvedChild = resolve(sessionFile)
  if (!resolvedChild.endsWith('.jsonl') || !isUnder(resolve(agentDir), resolvedChild)) return response
  return { ...response, steps: childSteps(readMessages(resolvedChild)) }
}
