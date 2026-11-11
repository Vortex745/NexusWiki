import type { DatabaseSync } from 'node:sqlite'
import { SILICONFLOW_BASE_URL } from './config.ts'

// SiliconFlow HTTP 客户端（零依赖，fetch 注入便于测试）：camelCase 入参 → snake_case API 字段
// 503 共试 3 次、429 共试 4 次（递增退避，429 退避 ×10——TPM 窗口按分钟滚动，503 过载恢复快）；其余非 2xx 或重试耗尽 → 带 status+path+响应体的 Error

export type ChatContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: ChatContent
}

export interface NoulQuestion {
  type: 'noul'
  instructions: string
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string> | string[]
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion

export type SystemOneAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice?: unknown }
  | Record<string, unknown>

export interface SystemOneRequest {
  model: string
  state: unknown
  questions: Record<string, SystemOneQuestion>
}

export interface ChatCompleteRequest {
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

export interface SiliconFlowClient {
  chatComplete(req: ChatCompleteRequest): Promise<string>
  systemOne(req: SystemOneRequest): Promise<Record<string, SystemOneAnswer>>
}

const RETRYABLE_STATUSES = new Set([429, 503])

export function createSiliconFlowClient(opts: {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  retryDelayMs?: number
}): SiliconFlowClient {
  const baseUrl = opts.baseUrl ?? SILICONFLOW_BASE_URL
  const doFetch = opts.fetchImpl ?? fetch
  const retryDelayMs = opts.retryDelayMs ?? 1000

  const requestJson = async (path: string, body: unknown): Promise<unknown> => {
    if (opts.apiKey.trim().length === 0) {
      throw new Error('SILICONFLOW_API_KEY 未配置：请在 .env 设置，或在后台设置 rag.apiKey')
    }
    let lastError = ''
    let lastStatus = 0
    // 503 过载恢复快共试 3 次；429 是按分钟滚动的 TPM 窗口，多给一轮共试 4 次且退避 ×10
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        if (attempt >= (lastStatus === 429 ? 4 : 3)) break
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt * (lastStatus === 429 ? 10 : 1)))
      }
      const response = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body)
      })
      const bodyText = await response.text()
      if (response.ok) return JSON.parse(bodyText) as unknown
      lastStatus = response.status
      lastError = `SiliconFlow ${response.status} ${path}: ${bodyText.slice(0, 200)}`
      if (!RETRYABLE_STATUSES.has(response.status)) throw new Error(lastError)
    }
    throw new Error(lastError)
  }

  return {
    async chatComplete(req: ChatCompleteRequest): Promise<string> {
      const body: Record<string, unknown> = { model: req.model, messages: req.messages }
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
      if (req.temperature !== undefined) body.temperature = req.temperature
      const data = await requestJson('/chat/completions', body)
      const content = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error('SiliconFlow chat response missing choices[0].message.content')
      }
      return content
    },

    async systemOne(req: SystemOneRequest): Promise<Record<string, SystemOneAnswer>> {
      const data = await requestJson('/systemone', { model: req.model, state: req.state, questions: req.questions })
      const answers = (data as { answers?: unknown }).answers
      if (answers === null || typeof answers !== 'object') {
        throw new Error('SiliconFlow systemone response missing answers')
      }
      return answers as Record<string, SystemOneAnswer>
    }
  }
}

// settings 行直接查（不 import ../db.ts——它拉 electron 进来，node --test 跑不了）
export function readRagApiKey(db: DatabaseSync): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('rag.apiKey') as { value: string } | undefined
  return row?.value?.trim() || process.env.SILICONFLOW_API_KEY?.trim() || ''
}

export function createRagClientFromSettings(db: DatabaseSync): SiliconFlowClient {
  return createSiliconFlowClient({ apiKey: readRagApiKey(db) })
}
