import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatThinkingEvent } from '../../shared/protocol.ts'
import { createRouter } from './router.ts'

function untilDone(chunks: ChatChunkEvent[], messageId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (chunks.some((c) => c.messageId === messageId && c.done)) resolve()
      else setTimeout(check, 5)
    }
    check()
  })
}

// 一轮里工具调用与最终回答是两条 assistant 消息，各自带一个思考块。
// contentIndex 每条消息重置，不能再当跨消息 key，否则两个「已思考」会合并成一行。
test('tool-call turn keeps one thinking key per assistant message', async () => {
  const chunks: ChatChunkEvent[] = []
  const thinking: ChatThinkingEvent[] = []
  const dir = mkdtempSync(join(tmpdir(), 'thinking-block-keys-'))
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    thinkingLevel: 'high',
    onChunk: (event) => chunks.push(event),
    onNotice: () => {},
    onThinking: (event) => thinking.push(event)
  })

  const id = await router.send('跑命令')
  await untilDone(chunks, id)

  const starts = thinking.filter((e) => e.phase === 'start')
  const ends = thinking.filter((e) => e.phase === 'end')
  const keys = new Set(starts.map((e) => e.key))
  assert.equal(keys.size, 2, `expected two distinct thinking keys, got ${[...keys].join(', ')}`)
  assert.equal(starts.length, 2, 'one start per assistant message')
  assert.equal(ends.length, 2, 'one end per assistant message')
  for (const key of keys) {
    const own = thinking.filter((e) => e.key === key)
    assert.equal(own.filter((e) => e.phase === 'start').length, 1, `one start for ${key}`)
    assert.equal(own.filter((e) => e.phase === 'end').length, 1, `one end for ${key}`)
    assert.equal(own.at(0)?.phase, 'start')
    assert.equal(own.at(-1)?.phase, 'end')
    assert.ok(
      own.filter((e) => e.phase === 'delta').map((e) => e.delta).join('').includes('思考档位 high'),
      `thinking text must belong to ${key}`
    )
  }
  router.dispose()
})
