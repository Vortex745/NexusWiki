import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createSiliconFlowClient, readRagApiKey } from './siliconflow.ts'

interface ScriptedResponse {
  status: number
  body: unknown
}

function fetchScripted(responses: ScriptedResponse[]): {
  impl: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift() ?? { status: 500, body: { message: 'no scripted response' } }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { impl, calls }
}

test('chatComplete posts chat/completions with bearer auth and returns message content', async () => {
  const { impl, calls } = fetchScripted([{ status: 200, body: { choices: [{ message: { content: '你好' } }] } }])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  const out = await client.chatComplete({
    model: 'some-model',
    messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(out, '你好')
  assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/chat/completions')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer k-test')
  const req = JSON.parse(String(calls[0].init.body))
  assert.equal(req.model, 'some-model')
  assert.deepEqual(req.messages, [{ role: 'user', content: 'hi' }])
})

test('systemOne posts to /systemone and parses noul and choice answers', async () => {
  const { impl, calls } = fetchScripted([
    {
      status: 200,
      body: {
        model: 'SemIf',
        answers: {
          has_title: { type: 'noul', noul: 0.92 },
          pick: { type: 'choice', choice: 'opt2' }
        },
        usage: { input_tokens: 10, output_tokens: 1 }
      }
    }
  ])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  const answers = await client.systemOne({
    model: 'SemIf',
    state: '共享上下文',
    questions: {
      has_title: { type: 'noul', instructions: '标题是否准确？' },
      pick: { type: 'choice', instructions: '哪个更相关？', criteria: { opt1: '一', opt2: '二' } }
    }
  })
  assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/systemone')
  assert.equal((answers.has_title as { noul: number }).noul, 0.92)
  assert.equal((answers.pick as { choice: unknown }).choice, 'opt2')
  const req = JSON.parse(String(calls[0].init.body))
  assert.equal(req.model, 'SemIf')
  assert.equal(req.state, '共享上下文')
  assert.deepEqual(Object.keys(req.questions), ['has_title', 'pick'])
})

test('429 then 200 retries once and succeeds', async () => {
  const { impl, calls } = fetchScripted([
    { status: 429, body: { message: 'rate limited' } },
    { status: 200, body: { model: 'SemIf', answers: { a: { type: 'noul', noul: 0.5 } } } }
  ])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  const answers = await client.systemOne({ model: 'SemIf', state: 's', questions: { a: { type: 'noul', instructions: 'i' } } })
  assert.equal(calls.length, 2)
  assert.equal((answers.a as { noul: number }).noul, 0.5)
})

test('503 twice then 200 rides out the overload on the third attempt', async () => {
  const { impl, calls } = fetchScripted([
    { status: 503, body: { code: 50505, message: 'Model service overloaded.' } },
    { status: 503, body: { code: 50505, message: 'Model service overloaded.' } },
    { status: 200, body: { model: 'SemIf', answers: { a: { type: 'noul', noul: 0.7 } } } }
  ])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  const answers = await client.systemOne({ model: 'SemIf', state: 's', questions: { a: { type: 'noul', instructions: 'i' } } })
  assert.equal(calls.length, 3)
  assert.equal((answers.a as { noul: number }).noul, 0.7)
})

test('three consecutive 503s fail with the last error', async () => {
  const { impl, calls } = fetchScripted([
    { status: 503, body: { message: 'overloaded' } },
    { status: 503, body: { message: 'overloaded' } },
    { status: 503, body: { message: 'overloaded' } }
  ])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  await assert.rejects(
    client.systemOne({ model: 'SemIf', state: 's', questions: { a: { type: 'noul', instructions: 'i' } } }),
    /503/
  )
  assert.equal(calls.length, 3)
})

test('429 gets a fourth attempt and rides out the TPM window', async () => {
  const { impl, calls } = fetchScripted([
    { status: 429, body: { message: 'TPM limit reached' } },
    { status: 429, body: { message: 'TPM limit reached' } },
    { status: 429, body: { message: 'TPM limit reached' } },
    { status: 200, body: { model: 'SemIf', answers: { a: { type: 'noul', noul: 0.6 } } } }
  ])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  const answers = await client.systemOne({ model: 'SemIf', state: 's', questions: { a: { type: 'noul', instructions: 'i' } } })
  assert.equal(calls.length, 4)
  assert.equal((answers.a as { noul: number }).noul, 0.6)
})

test('four consecutive 429s fail with the last error', async () => {
  const { impl, calls } = fetchScripted([
    { status: 429, body: { message: 'TPM' } },
    { status: 429, body: { message: 'TPM' } },
    { status: 429, body: { message: 'TPM' } },
    { status: 429, body: { message: 'TPM' } }
  ])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  await assert.rejects(
    client.systemOne({ model: 'SemIf', state: 's', questions: { a: { type: 'noul', instructions: 'i' } } }),
    /429/
  )
  assert.equal(calls.length, 4)
})

test('400 fails without retry and the error names the status', async () => {
  const { impl, calls } = fetchScripted([{ status: 400, body: { code: 20012, message: 'bad request' } }])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  await assert.rejects(
    client.chatComplete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    /400/
  )
  assert.equal(calls.length, 1)
})

test('malformed chat response (no choices content) throws instead of returning undefined', async () => {
  const { impl } = fetchScripted([{ status: 200, body: { choices: [] } }])
  const client = createSiliconFlowClient({ apiKey: 'k-test', fetchImpl: impl, retryDelayMs: 1 })
  await assert.rejects(client.chatComplete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }))
})

test('empty api key fails before any network call', async () => {
  const { impl, calls } = fetchScripted([])
  const client = createSiliconFlowClient({ apiKey: '   ', fetchImpl: impl, retryDelayMs: 1 })
  await assert.rejects(client.chatComplete({ model: 'm', messages: [] }), /SILICONFLOW_API_KEY/)
  assert.equal(calls.length, 0)
})

test('readRagApiKey prefers settings, then env, then empty', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const previous = process.env.SILICONFLOW_API_KEY
  try {
    delete process.env.SILICONFLOW_API_KEY
    assert.equal(readRagApiKey(db), '')
    process.env.SILICONFLOW_API_KEY = 'sk-env'
    assert.equal(readRagApiKey(db), 'sk-env')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('rag.apiKey', 'sk-settings')
    assert.equal(readRagApiKey(db), 'sk-settings')
  } finally {
    if (previous === undefined) delete process.env.SILICONFLOW_API_KEY
    else process.env.SILICONFLOW_API_KEY = previous
  }
})
