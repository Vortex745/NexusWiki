import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent } from '../../shared/protocol.ts'
import { createRouter } from './router.ts'

// SiliconFlow 对 role=developer 的真实回执：整条链路一条回复都出不来
const INVALID_ROLE_BODY = JSON.stringify({
  code: 20015,
  message: 'The request parameter messages is invalid or missing. Please check the value of this parameter.',
  data: null
})

interface CapturedBody {
  model: string
  messages: Array<{ role: string }>
}

async function startMockServer(): Promise<{ server: Server; baseUrl: string; captured: CapturedBody[] }> {
  const captured: CapturedBody[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      captured.push(JSON.parse(raw) as CapturedBody)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(INVALID_ROLE_BODY)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, captured }
}

// 两个模型：显式选中的那个排在后面，解析（含带斜杠的 id）错了就会落到第一个
function writeModels(agentDir: string, baseUrl: string, compat: Record<string, unknown>): void {
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          siliconflow: {
            name: 'SiliconFlow',
            baseUrl,
            apiKey: 'sk-test',
            api: 'openai-completions',
            models: [
              { id: 'deepseek-ai/First', name: 'First', contextWindow: 8192, maxTokens: 1024 },
              {
                id: 'deepseek-ai/DeepSeek-V4.1-Flash',
                name: 'Target',
                contextWindow: 8192,
                maxTokens: 1024,
                reasoning: true,
                compat
              }
            ]
          }
        }
      },
      null,
      2
    )
  )
}

interface Outcome {
  answer: string
  stopReason: string | undefined
  notices: ChatNoticeEvent[]
  captured: CapturedBody[]
}

async function ask(compat: Record<string, unknown>): Promise<Outcome> {
  const { server, baseUrl, captured } = await startMockServer()
  const agentDir = mkdtempSync(join(tmpdir(), 'router-real-failure-'))
  writeModels(agentDir, baseUrl, compat)
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const router = await createRouter({
    mode: 'real',
    cwd: agentDir,
    agentDir,
    realModelId: 'siliconflow/deepseek-ai/DeepSeek-V4.1-Flash',
    thinkingLevel: 'high',
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })
  try {
    const id = await router.send('hi')
    const deadline = Date.now() + 15000
    while (!chunks.some((chunk) => chunk.messageId === id && chunk.done) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return {
      answer: chunks.filter((chunk) => chunk.messageId === id).map((chunk) => chunk.delta).join(''),
      stopReason: chunks.find((chunk) => chunk.messageId === id && chunk.done)?.stopReason,
      notices,
      captured
    }
  } finally {
    router.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// 回归：SiliconFlow 拒收 developer 角色时，整条真实链路必须落到 system，否则一条回复都没有
test('real mode sends the instruction as system when the provider rejects the developer role', async () => {
  const outcome = await ask({
    thinkingFormat: 'qwen',
    supportsReasoningEffort: false,
    thinkingTokenBudgetField: 'thinking_budget',
    supportsDeveloperRole: false
  })

  assert.equal(outcome.captured.length > 0, true, 'the request must reach the provider')
  assert.equal(
    outcome.captured[0]!.model,
    'deepseek-ai/DeepSeek-V4.1-Flash',
    'router.model with slashes in the id must resolve to the explicit model, not fall back to the first'
  )
  assert.equal(outcome.captured[0]!.messages[0]!.role, 'system', 'SiliconFlow rejects role=developer with 400')
})

// 回归：pi 对 LLM 错误是「正常结束 run」，错误只挂在 message_end 上；
// 这里锁住它必须变成一条错误气泡 + notice，不能静默吞掉（真实故障的表现是界面毫无反应）
test('a provider error surfaces as an error chunk and a notice instead of silence', async () => {
  const outcome = await ask({ supportsDeveloperRole: false })

  assert.equal(outcome.stopReason, 'error')
  assert.match(outcome.answer, /模型调用失败/)
  assert.equal(outcome.notices.length, 1, 'exactly one notice per failed run')
  assert.equal(outcome.notices[0]!.kind, 'router-error')
  assert.match(outcome.notices[0]!.message, /20015/)
})
