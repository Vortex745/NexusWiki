import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent } from '../../shared/protocol.ts'
import { createRouter, SKILL_PROBE_DIR, type Router } from './router.ts'
import { loadAppExtensions } from './pi-shared.ts'

interface Harness {
  router: Router
  chunks: ChatChunkEvent[]
  notices: ChatNoticeEvent[]
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 't02-router-'))
}

// 探针 stdio MCP server（30 行独立 node 脚本，echo 工具回显输入）；用 process.execPath 绝对路径 spawn，不依赖 PATH
const MCP_PROBE_SERVER = join(import.meta.dirname, '__fixtures__', 'mcp-probe-server.mjs')

// 技能探针的种子技能正文：唯一标记文本是独立期望值（与 T3 bash 探针同一约定）
const SKILL_PROBE_MARKER = 'SKILL-PROBE-MARKER-7f3a9c'
const SKILL_PROBE_CONTENT = [
  '---',
  'name: probe-skill',
  'description: 探针技能：确认 Router 技能注入与 bash 渐进披露读取环。',
  '---',
  '',
  SKILL_PROBE_MARKER
].join('\n')

async function makeFakeRouter(options?: { delayMs?: number }): Promise<Harness> {
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const dir = makeTempDir()
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    fakeStreamDelayMs: options?.delayMs,
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })
  return { router, chunks, notices }
}

function untilDone(chunks: ChatChunkEvent[], messageId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (chunks.some((c) => c.messageId === messageId && c.done)) resolve()
      else setTimeout(check, 5)
    }
    check()
  })
}

test('fake mode streams a deterministic reply and terminates with done', async () => {
  const { router, chunks, notices } = await makeFakeRouter()
  const messageId = await router.send('hello')
  await untilDone(chunks, messageId)

  const own = chunks.filter((c) => c.messageId === messageId)
  assert.ok(own.length > 1, `long reply should stream multiple deltas, got ${own.length}`)
  assert.equal(own.map((c) => c.delta).join(''), 'OK: hello', 'deltas concatenate to the scripted reply')
  assert.ok(own.slice(0, -1).every((c) => !c.done), 'done only on the last event')
  assert.equal(own.at(-1)?.done, true)
  assert.equal(notices.length, 0, 'fake mode must not emit notices')
  router.dispose()
})

test('second turn references the first turn (session context is continuous)', async () => {
  const { router, chunks } = await makeFakeRouter()
  const firstId = await router.send('我叫张三')
  await untilDone(chunks, firstId)
  assert.equal(chunks.filter((c) => c.messageId === firstId).map((c) => c.delta).join(''), 'OK: 我叫张三')

  const secondId = await router.send('我第一轮说了什么？')
  await untilDone(chunks, secondId)
  const secondReply = chunks.filter((c) => c.messageId === secondId).map((c) => c.delta).join('')
  assert.ok(
    secondReply.includes('张三'),
    `persistent session should carry turn 1 context into turn 2, got: ${secondReply}`
  )
  router.dispose()
})

test('real mode without any model config emits a notice and stays alive', async () => {
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const emptyAgentDir = makeTempDir()
  const dir = makeTempDir()
  const router = await createRouter({
    mode: 'real',
    cwd: dir,
    agentDir: emptyAgentDir,
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })

  assert.ok(
    notices.some((n) => n.kind === 'model-not-configured'),
    `startup should emit a model-not-configured notice, got: ${JSON.stringify(notices)}`
  )

  // 未配置时发送消息：不得抛出未捕获异常，消息必须以 done 终止
  const messageId = await router.send('hi')
  await untilDone(chunks, messageId)
  assert.ok(chunks.some((c) => c.messageId === messageId && c.done), 'pending message must terminate with done')
  router.dispose()
})

test('router toolset exposes bash/search_knowledge plus the three Worker dispatch tools; subagent stays out of Router', async () => {
  const { router } = await makeFakeRouter()
  const names = router.getActiveToolNames()
  for (const exec of ['read', 'edit', 'write', 'powershell', 'grep', 'find', 'ls']) {
    assert.ok(!names.includes(exec), `router must not have the builtin tool "${exec}", got: ${names.join(',')}`)
  }
  for (const live of ['bash', 'search_knowledge', 'dispatch_task', 'interrupt_task', 'task_status']) {
    assert.ok(names.includes(live), `router must expose ${live} to the model, got: ${names.join(',')}`)
  }
  // subagent 只挂 Worker：Router 不注入子代理扩展，也不留重叠委派路径
  assert.ok(!names.includes('subagent'), `subagent must not be registered on Router, got: ${names.join(',')}`)
  assert.ok(names.indexOf('search_knowledge') > names.indexOf('bash'), 'bash precedes search_knowledge')
  router.dispose()
})

test('fake bash intent runs the real bash tool and its output flows back to the model', async () => {
  const { router, chunks } = await makeFakeRouter()
  const messageId = await router.send('跑命令')
  await untilDone(chunks, messageId)
  const reply = chunks.filter((c) => c.messageId === messageId).map((c) => c.delta).join('')
  assert.ok(
    reply.includes('PI-BASH-OK-42'),
    `real bash execution must round-trip through the session (echo PI-BASH-OK-$((41+1))), got: ${reply}`
  )
  router.dispose()
})

test('messages sent while busy are merged into a single follow-up LLM call', async () => {
  const { router, chunks, notices } = await makeFakeRouter({ delayMs: 40 })
  const firstId = await router.send('占位第一条')
  const burstTexts = ['批量消息一', '批量消息二', '批量消息三', '批量消息四', '批量消息五']
  const burstIds: string[] = []
  for (const text of burstTexts) burstIds.push(await router.send(text))

  for (const id of [firstId, ...burstIds]) await untilDone(chunks, id)

  assert.equal(
    router.getLLMCallCount(),
    2,
    `busy burst must merge into exactly one new LLM call (run 1 + merged flush), got ${router.getLLMCallCount()}`
  )

  // 5 条都在注入内容里：假模型按脚本原样回显注入的 prompt，合并后的回显必须覆盖全部 5 条
  const mergedReply = chunks.filter((c) => c.messageId === burstIds[0]).map((c) => c.delta).join('')
  for (const text of burstTexts) {
    assert.ok(mergedReply.includes(text), `merged injection must contain "${text}", got: ${mergedReply}`)
  }

  // IPC 契约不变：每条缓冲消息仍拿到自己的流式回复并以恰好一个 done 收尾
  for (const id of burstIds) {
    const own = chunks.filter((c) => c.messageId === id)
    assert.ok(own.length > 1, `each buffered message keeps its own streaming reply (${id})`)
    assert.equal(own.filter((c) => c.done).length, 1, `exactly one done for ${id}`)
    assert.equal(own.at(-1)?.done, true, `stream ends with done for ${id}`)
  }
  assert.equal(chunks.filter((c) => c.done).length, 6, 'one done per message')
  assert.equal(notices.length, 0)
  router.dispose()
})

test('search_knowledge tool calls the injected retriever and the result reaches the model', async () => {
  const calls: string[] = []
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const dir = makeTempDir()
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    onSearchKnowledge: async (query) => {
      calls.push(query)
      return '知识片段：检索延迟由层级深度决定'
    },
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })

  assert.ok(router.getActiveToolNames().includes('search_knowledge'), 'search_knowledge must be declared to the model')
  const messageId = await router.send('帮我查资料：检索延迟由什么决定')
  await untilDone(chunks, messageId)

  assert.equal(calls.length, 1, 'exactly one search_knowledge call')
  assert.ok(calls[0]!.includes('检索延迟'), `query forwarded verbatim, got: ${calls[0]}`)
  const reply = chunks.filter((c) => c.messageId === messageId).map((c) => c.delta).join('')
  assert.ok(reply.includes('检索延迟由层级深度决定'), `tool result must reach the model turn, got: ${reply}`)
  assert.equal(notices.length, 0)
  router.dispose()
})

test('newSession starts a fresh conversation; continueRecent then picks the newest', async () => {
  const dir = makeTempDir()
  const base = { mode: 'fake' as const, cwd: dir, agentDir: dir, sessionDir: dir, onNotice: () => {} }

  const chunks1: ChatChunkEvent[] = []
  const r1 = await createRouter({ ...base, newSession: true, onChunk: (e) => chunks1.push(e) })
  const id1 = await r1.send('marker-one')
  await untilDone(chunks1, id1)
  r1.dispose()

  const chunks2: ChatChunkEvent[] = []
  const r2 = await createRouter({ ...base, onChunk: (e) => chunks2.push(e) })
  assert.ok(r2.getHistory().some((h) => h.content.includes('marker-one')), 'continueRecent must pick the brand-new session')
  const id2 = await r2.send('marker-two')
  await untilDone(chunks2, id2)
  r2.dispose()

  const chunks3: ChatChunkEvent[] = []
  const r3 = await createRouter({ ...base, newSession: true, onChunk: (e) => chunks3.push(e) })
  assert.equal(r3.getHistory().length, 0, 'new session must not carry prior messages')
  const id3 = await r3.send('marker-three')
  await untilDone(chunks3, id3)
  r3.dispose()

  const chunks4: ChatChunkEvent[] = []
  const r4 = await createRouter({ ...base, onChunk: (e) => chunks4.push(e) })
  const history = r4.getHistory()
  assert.ok(history.some((h) => h.content.includes('marker-three')), 'the newest session is continued afterwards')
  assert.ok(!history.some((h) => h.content.includes('marker-one')), 'the old session must not leak into history')
  r4.dispose()
})

test('resumeSessionId restores the exact recorded session, not just the most recent', async () => {
  const dir = makeTempDir()
  const base = { mode: 'fake' as const, cwd: dir, agentDir: dir, sessionDir: dir, onNotice: () => {} }

  const chunks1: ChatChunkEvent[] = []
  const r1 = await createRouter({ ...base, newSession: true, onChunk: (e) => chunks1.push(e) })
  const id1 = await r1.send('marker-one')
  await untilDone(chunks1, id1)
  const sessionOne = r1.getSessionId()
  r1.dispose()

  const chunks2: ChatChunkEvent[] = []
  const r2 = await createRouter({ ...base, newSession: true, onChunk: (e) => chunks2.push(e) })
  const id2 = await r2.send('marker-two')
  await untilDone(chunks2, id2)
  r2.dispose()

  const r3 = await createRouter({ ...base, resumeSessionId: sessionOne, onChunk: () => {} })
  const history = r3.getHistory()
  assert.ok(history.some((h) => h.content.includes('marker-one')), 'resume must restore session one by id')
  assert.ok(!history.some((h) => h.content.includes('marker-two')), 'session two must not leak into the resumed history')
  assert.equal(r3.getSessionId(), sessionOne, 'getSessionId returns the resumed session id')
  r3.dispose()
})

test('resumeSessionId pointing at a deleted session falls back to continueRecent', async () => {
  const dir = makeTempDir()
  const base = { mode: 'fake' as const, cwd: dir, agentDir: dir, sessionDir: dir, onNotice: () => {} }

  const chunks1: ChatChunkEvent[] = []
  const r1 = await createRouter({ ...base, newSession: true, onChunk: (e) => chunks1.push(e) })
  const id1 = await r1.send('marker-recent')
  await untilDone(chunks1, id1)
  r1.dispose()

  const chunks2: ChatChunkEvent[] = []
  const r2 = await createRouter({ ...base, newSession: true, onChunk: (e) => chunks2.push(e) })
  const id2 = await r2.send('marker-latest')
  await untilDone(chunks2, id2)
  r2.dispose()

  const r3 = await createRouter({ ...base, resumeSessionId: 'no-such-session', onChunk: () => {} })
  const history = r3.getHistory()
  assert.ok(history.some((h) => h.content.includes('marker-latest')), 'fallback continues the most recent session')
  assert.ok(!history.some((h) => h.content.includes('marker-recent')), 'older session must not leak')
  r3.dispose()
})

test('message sent while busy is enqueued and answered after the current run', async () => {
  const { router, chunks, notices } = await makeFakeRouter({ delayMs: 40 })
  const firstId = await router.send('第一条')
  const secondId = await router.send('第二条')
  assert.notEqual(firstId, secondId)

  await untilDone(chunks, secondId)
  await untilDone(chunks, firstId)

  const firstReply = chunks.filter((c) => c.messageId === firstId).map((c) => c.delta).join('')
  const secondReply = chunks.filter((c) => c.messageId === secondId).map((c) => c.delta).join('')
  assert.equal(firstReply, 'OK: 第一条', 'first reply keeps its own messageId')
  assert.ok(secondReply.includes('OK: 第二条'), `second message must not be swallowed, got: ${secondReply}`)
  assert.ok(secondReply.includes('第一条'), 'enqueued turn sees the first turn in context')
  assert.equal(chunks.filter((c) => c.done).length, 2, 'exactly one done per message')
  assert.equal(notices.length, 0)
  router.dispose()
})

test('empty-config extensions result contains the MCP extension', async () => {
  const dir = makeTempDir()
  const result = await loadAppExtensions({ cwd: dir, loadConfig: () => ({ servers: [], errors: [] }) })
  assert.deepEqual(result.errors, [])
  assert.equal(result.extensions.length, 1, 'exactly the inline MCP extension')
  assert.ok(result.extensions[0]!.commands.has('mcp'), 'the loaded extension is the MCP extension (/mcp command)')
})

test('mcp probe: fake intent drives the real mcp__probe__echo tool through the MCP extension', async () => {
  const dir = makeTempDir()
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [MCP_PROBE_SERVER] } } })
  )
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })
  assert.equal(notices.length, 0, 'valid mcp.json must not emit startup notices')

  const messageId = await router.send('mcp探针')
  await untilDone(chunks, messageId)
  const reply = chunks.filter((c) => c.messageId === messageId).map((c) => c.delta).join('')
  assert.ok(
    reply.includes('ECHO:MCP-PROBE-PAYLOAD'),
    `toolResult must round-trip the echo payload (extension connect + tool registration + call pipeline), got: ${reply}`
  )
  assert.equal(notices.length, 0)
  router.dispose()
})

test('skill probe: seeded skill is injected into the prompt and its full text round-trips through bash', async () => {
  const dir = makeTempDir()
  mkdirSync(join(dir, 'skills', SKILL_PROBE_DIR), { recursive: true })
  writeFileSync(join(dir, 'skills', SKILL_PROBE_DIR, 'SKILL.md'), SKILL_PROBE_CONTENT, 'utf8')
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })
  assert.equal(notices.length, 0, 'valid SKILL.md must not emit diagnostics')
  assert.ok(
    router.getSystemPrompt().includes('probe-skill'),
    'progressive disclosure: prompt carries name+description of the seeded skill'
  )

  const messageId = await router.send('技能探针')
  await untilDone(chunks, messageId)
  const reply = chunks.filter((c) => c.messageId === messageId).map((c) => c.delta).join('')
  assert.ok(
    reply.includes(SKILL_PROBE_MARKER),
    `bash must read the seeded skill file and its body must reach the model turn, got: ${reply}`
  )
  router.dispose()
})
