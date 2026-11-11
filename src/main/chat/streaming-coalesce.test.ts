import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent, ChatStreamEvent } from '../../shared/protocol.ts'
import { boundText, TOOL_TEXT_LIMIT } from './pi-shared.ts'
import { createRouter, type Router } from './router.ts'

// 合批与 SSE 风格事件流的验收测试。不变量（.tmp/design-synthesis.md）：
// I1 每 messageId 的 delta 按序拼接 === 原文；I2 每条消息恰好一个 done 且它是该 id 最后一个事件；
// I3 乱序容忍保持（跨 id 顺序不保证）。合批本身不得破坏 I1-I3，且要真实减少事件数。

interface Harness {
  router: Router
  chunks: ChatChunkEvent[]
  streamEvents: ChatStreamEvent[]
  notices: ChatNoticeEvent[]
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'streaming-coalesce-'))
}

async function makeFakeRouter(options?: { delayMs?: number }): Promise<Harness> {
  const chunks: ChatChunkEvent[] = []
  const streamEvents: ChatStreamEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const dir = makeTempDir()
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    fakeStreamDelayMs: options?.delayMs,
    onChunk: (event) => chunks.push(event),
    onStreamEvent: (event) => streamEvents.push(event),
    onNotice: (event) => notices.push(event)
  })
  return { router, chunks, streamEvents, notices }
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

test('合批保持拼接不变量并真实合并事件数', async () => {
  const { router, chunks } = await makeFakeRouter({ delayMs: 0 })
  const longInput = '长'.repeat(2000)
  const messageId = await router.send(longInput)
  await untilDone(chunks, messageId)

  const own = chunks.filter((c) => c.messageId === messageId)
  assert.ok(own.length >= 2, `expected multiple events (first-delta immediate + flush + done), got ${own.length}`)
  // fake 分片按 4 字符段：2004+ 字符 ≈ 500+ 段。合批后 ≤10 条事件（首 delta 直发 + ≤512 字符冲刷若干 + done）
  assert.ok(
    own.length <= 10,
    `coalescing must merge the ~500 raw segments into a bounded event count, got ${own.length}`
  )
  const expected = `OK: ${longInput}`
  assert.equal(own.map((c) => c.delta).join(''), expected, 'coalesced deltas concatenate to the scripted reply')
  assert.ok(own.slice(0, -1).every((c) => !c.done), 'done only on the last event')
  assert.equal(own.at(-1)?.done, true)
  assert.equal(own.at(-1)?.stopReason ?? 'stop', 'stop', 'stop terminal carries stop semantics (explicit or default)')
  router.dispose()
})

test('工具生命周期走 onStreamEvent：start/end 同 key，end 带 toolName 与 callId', async () => {
  const { router, chunks, streamEvents } = await makeFakeRouter()
  // bash 意图产生一次真实工具调用回合（dispatch 工具已退役，工具生命周期断言改走存活路径）
  const messageId = await router.send('跑命令')
  await untilDone(chunks, messageId)

  const tools = streamEvents.filter((e) => e.kind === 'tool')
  assert.ok(tools.length >= 2, `expected tool start and end events, got: ${JSON.stringify(streamEvents)}`)
  const startIdx = tools.findIndex((e) => e.phase === 'start')
  const endIdx = tools.findIndex((e) => e.phase === 'end')
  assert.ok(startIdx !== -1 && endIdx !== -1, 'both start and end phases expected')
  assert.ok(startIdx < endIdx, 'start must precede end')
  const start = tools[startIdx]!
  const end = tools[endIdx]!
  assert.equal(start.key, end.key, 'start/end of one tool call share the main-assigned key')
  assert.equal(end.toolName, 'bash', 'end carries the tool name')
  assert.ok(end.callId, 'end carries the pi toolCall id')
  assert.ok(end.summary, 'end carries a single-line summary')
  router.dispose()
})

test('错误终态显式携带 stopReason=error，错误文本仍在 delta 里', async () => {
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

  const messageId = await router.send('hi')
  await untilDone(chunks, messageId)
  const own = chunks.filter((c) => c.messageId === messageId)
  const last = own.at(-1)
  assert.ok(last?.done, 'pending message must terminate with done')
  assert.equal(last.stopReason, 'error', 'error terminal must be explicit, not the stop default')
  assert.ok(last.delta.length > 0, 'error text stays human-readable in the delta')
  router.dispose()
})

test('工具执行事件带 label/input/output/isError/durationMs，失败态显式', async () => {
  const chunks: ChatChunkEvent[] = []
  const streamEvents: ChatStreamEvent[] = []
  const dir = makeTempDir()
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    onChunk: (event) => chunks.push(event),
    onStreamEvent: (event) => streamEvents.push(event),
    onNotice: () => {},
    onInterruptTask: async () => ({ ok: false, message: '任务不存在：probe' })
  })

  const okId = await router.send('跑命令')
  await untilDone(chunks, okId)
  const ok = streamEvents.filter((e) => e.kind === 'tool' && e.toolName === 'bash')
  const okStart = ok.find((e) => e.phase === 'start')
  const okEnd = ok.filter((e) => e.phase === 'end').at(-1)
  assert.ok(okStart && okEnd, `bash lifecycle expected, got ${JSON.stringify(ok)}`)
  assert.equal(okStart.label, '终端命令')
  assert.ok(okStart.input?.includes('echo PI-BASH-OK-$((41+1))'), `start carries the command, got ${okStart.input}`)
  assert.ok(okEnd.output?.includes('PI-BASH-OK-42'), `end carries the output, got ${okEnd.output}`)
  assert.equal(okEnd.isError, false)
  assert.equal(typeof okEnd.durationMs, 'number')
  assert.equal(okStart.key, okEnd.key)

  const failId = await router.send('取消 00000000-0000-4000-8000-000000000000')
  await untilDone(chunks, failId)
  const fail = streamEvents.filter((e) => e.kind === 'tool' && e.toolName === 'interrupt_task')
  const failEnd = fail.filter((e) => e.phase === 'end').at(-1)
  assert.ok(failEnd, `failing tool end expected, got ${JSON.stringify(fail)}`)
  assert.equal(failEnd.label, '任务管理')
  assert.equal(failEnd.isError, true)
  assert.ok(failEnd.output?.includes('任务不存在'), `error output expected, got ${failEnd.output}`)
  router.dispose()
})

test('boundText strips ANSI, counts code points, and marks truncation', () => {
  assert.equal(boundText('\u001b[31mred\u001b[0m', 10), 'red')
  const long = '😀'.repeat(TOOL_TEXT_LIMIT + 1)
  const out = boundText(long, TOOL_TEXT_LIMIT)
  assert.equal([...out].slice(0, TOOL_TEXT_LIMIT).join(''), '😀'.repeat(TOOL_TEXT_LIMIT))
  assert.ok(out.endsWith('…（已截断）'))
  assert.ok(!out.includes('\uFFFD'), 'truncation must not split a surrogate pair')
})
