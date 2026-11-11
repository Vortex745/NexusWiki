import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatThinkingEvent, ThinkingLevel } from '../../shared/protocol.ts'
import { createRouter } from './router.ts'

interface Harness {
  chunks: ChatChunkEvent[]
  thinking: ChatThinkingEvent[]
  send: (text: string) => Promise<string>
  status: () => { thinkingLevel: ThinkingLevel; availableLevels: ThinkingLevel[] }
  setLevel: (level: ThinkingLevel) => void
  dispose: () => void
}

async function makeRouter(thinkingLevel: ThinkingLevel): Promise<Harness> {
  const chunks: ChatChunkEvent[] = []
  const thinking: ChatThinkingEvent[] = []
  const dir = mkdtempSync(join(tmpdir(), 'thinking-stream-'))
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    thinkingLevel,
    onChunk: (event) => chunks.push(event),
    onNotice: () => {},
    onThinking: (event) => thinking.push(event)
  })
  return {
    chunks,
    thinking,
    send: (text) => router.send(text),
    status: () => router.getThinkingStatus(),
    setLevel: (level) => router.setThinkingLevel(level),
    dispose: () => router.dispose()
  }
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

test('off produces no thinking events and leaves the answer unchanged', async () => {
  const h = await makeRouter('off')
  const id = await h.send('hello')
  await untilDone(h.chunks, id)
  assert.equal(h.thinking.length, 0, 'off must not emit any thinking event')
  assert.equal(h.chunks.filter((c) => c.messageId === id).map((c) => c.delta).join(''), 'OK: hello')
  assert.equal(h.status().thinkingLevel, 'off')
  h.dispose()
})

// 核心不变量：thinking delta 按序拼接 === 模型原文；start/end 各恰好一个，end 最后。
test('thinking deltas concatenate losslessly and end flushes the tail', async () => {
  const h = await makeRouter('high')
  const id = await h.send('hello')
  await untilDone(h.chunks, id)

  const own = h.thinking.filter((e) => e.key.startsWith(`${id}:`))
  assert.equal(own.filter((e) => e.phase === 'start').length, 1, 'exactly one start')
  assert.equal(own.filter((e) => e.phase === 'end').length, 1, 'exactly one end')
  assert.equal(own.at(0)?.phase, 'start', 'start comes first')
  assert.equal(own.at(-1)?.phase, 'end', 'end must be last, after every delta')
  assert.equal(
    own.filter((e) => e.phase === 'delta').map((e) => e.delta).join(''),
    '思考档位 high：先拆解问题，再给出回答。',
    'no delta lost or reordered by the 16ms batcher'
  )
  assert.equal(
    h.chunks.filter((c) => c.messageId === id).map((c) => c.delta).join(''),
    'OK: hello',
    'thinking never leaks into the answer channel'
  )
  h.dispose()
})

test('available levels come from the model and exclude undeclared xhigh/max', async () => {
  const h = await makeRouter('medium')
  const status = h.status()
  assert.equal(status.thinkingLevel, 'medium')
  assert.ok(status.availableLevels.includes('off'))
  assert.ok(status.availableLevels.includes('high'))
  assert.ok(!status.availableLevels.includes('xhigh'), 'xhigh needs an explicit thinkingLevelMap entry')
  assert.ok(!status.availableLevels.includes('max'), 'max needs an explicit thinkingLevelMap entry')
  h.dispose()
})

// handoff 验收清单：请求超出模型能力的档位时，SDK 必须就近收敛而不是原样发出。
test('requesting max clamps down to the highest supported level', async () => {
  const h = await makeRouter('max')
  const status = h.status()
  assert.equal(status.thinkingLevel, 'high', 'max is undeclared, so it must clamp to high')
  assert.ok(!status.availableLevels.includes('max'))
  const id = await h.send('clamp probe')
  await untilDone(h.chunks, id)
  assert.ok(
    h.thinking.some((e) => e.delta?.includes('high')),
    'the stream must carry the clamped level, not max'
  )
  h.dispose()
})

test('setThinkingLevel takes effect immediately without rebuilding the router', async () => {
  const h = await makeRouter('off')
  h.setLevel('low')
  assert.equal(h.status().thinkingLevel, 'low', 'session state changes immediately')
  const id = await h.send('after switch')
  await untilDone(h.chunks, id)
  assert.ok(
    h.thinking.some((e) => e.delta?.includes('low')),
    'the very next turn must stream thinking at the new level'
  )
  h.dispose()
})
