import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent } from '../../shared/protocol.ts'
import { toHistoryMessages } from './pi-shared.ts'
import { createRouter, type Router } from './router.ts'

// T6：重启恢复。同一 sessionDir 重新打开 Router（continueRecent），历史完整且新对话能引用重启前内容
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 't06-recovery-'))
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

interface Harness {
  router: Router
  chunks: ChatChunkEvent[]
  notices: ChatNoticeEvent[]
}

async function openRouter(root: string, sessionDir: string): Promise<Harness> {
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const router = await createRouter({
    mode: 'fake',
    cwd: root,
    agentDir: join(root, 'agent'),
    sessionDir,
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })
  return { router, chunks, notices }
}

test('reopen with the same sessionDir restores history and keeps context continuous', async () => {
  const root = makeTempDir()
  const sessionDir = join(root, 'sessions')

  const first = await openRouter(root, sessionDir)
  const firstId = await first.router.send('我叫张三')
  await untilDone(first.chunks, firstId)
  const secondId = await first.router.send('我第一轮说了什么？')
  await untilDone(first.chunks, secondId)
  first.router.dispose()

  // 模拟重启：释放后以同 sessionDir（同 cwd）重新打开
  const reopened = await openRouter(root, sessionDir)
  const history = reopened.router.getHistory()
  assert.deepEqual(
    history.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
    `restored history must be the full pre-restart conversation, got: ${JSON.stringify(history)}`
  )
  assert.ok(history.some((m) => m.role === 'user' && m.content.includes('张三')), 'first user message restored')
  assert.ok(
    history.some((m) => m.role === 'assistant' && m.content.includes('OK: 我叫张三')),
    'first assistant reply restored'
  )
  assert.ok(history.every((m) => !m.summary), 'plain turns are not marked as summary')

  const thirdId = await reopened.router.send('我第一轮说了什么？')
  await untilDone(reopened.chunks, thirdId)
  const reply = reopened.chunks.filter((c) => c.messageId === thirdId).map((c) => c.delta).join('')
  assert.ok(reply.includes('张三'), `post-restart turn must reference the pre-restart first turn, got: ${reply}`)
  assert.equal(reopened.notices.length, 0)
  reopened.router.dispose()
})

test('continueRecent on an empty sessionDir starts fresh with empty history', async () => {
  const root = makeTempDir()
  const harness = await openRouter(root, join(root, 'sessions'))

  assert.deepEqual(harness.router.getHistory(), [], 'fresh session must have no history')

  const messageId = await harness.router.send('hi')
  await untilDone(harness.chunks, messageId)
  const reply = harness.chunks.filter((c) => c.messageId === messageId).map((c) => c.delta).join('')
  assert.equal(reply, 'OK: hi', 'fresh session still answers normally')
  harness.router.dispose()
})

test('envelope injections stay out of getHistory while normal user messages remain', async () => {
  const root = makeTempDir()
  const harness = await openRouter(root, join(root, 'sessions'))

  const normalId = await harness.router.send('帮我写个脚本')
  await untilDone(harness.chunks, normalId)
  // 模拟主进程注入（Router 攒批合并的实际形态）：信封是内部协议 user 消息，不进 UI 历史
  const envelopeId = await harness.router.send('[USER]\n批量消息')
  await untilDone(harness.chunks, envelopeId)

  const history = harness.router.getHistory()
  const userContents = history.filter((m) => m.role === 'user').map((m) => m.content)
  assert.ok(
    userContents.includes('帮我写个脚本'),
    `normal user message must remain in history, got: ${JSON.stringify(userContents)}`
  )
  assert.ok(
    userContents.every((content) => !content.startsWith('[USER]')),
    `internal protocol user messages must not leak into history, got: ${JSON.stringify(userContents)}`
  )
  harness.router.dispose()
})

test('toHistoryMessages marks compaction/branch summaries and skips non-chat messages', () => {
  const mapped = toHistoryMessages([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: '帮我写个脚本' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'subagent', arguments: {} }] },
    { role: 'toolResult', content: [{ type: 'text', text: '任务已启动' }] },
    { role: 'compactionSummary', summary: '用户请求写脚本，任务已派发' },
    { role: 'branchSummary', summary: '分支摘要文本' },
    { role: 'user', content: '结果呢？' },
    { role: 'assistant', content: [{ type: 'text', text: '任务完成' }] }
  ])

  assert.deepEqual(
    mapped.map((m) => [m.role, m.summary ?? false]),
    [
      ['user', false],
      ['assistant', true],
      ['assistant', true],
      ['user', false],
      ['assistant', false]
    ],
    `tool-only assistant turns, toolResults and system messages are dropped; summaries marked, got: ${JSON.stringify(mapped)}`
  )
  assert.equal(mapped[0]?.content, '帮我写个脚本')
  assert.equal(mapped[1]?.content, '用户请求写脚本，任务已派发')
  assert.equal(mapped[4]?.content, '任务完成')
  assert.ok(mapped.every((m) => m.id.length > 0), 'every history message carries an id')
})
