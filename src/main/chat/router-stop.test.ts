// Router.stopRun（用户叫停）验收测试：实现落地前全部失败（stopRun 不存在），落地后必须全绿。
// 合同（批准方案 C 节）：叫停 = aborted 终结（非 error、无错误文本）+ thinking 行补终态 + 缓冲存活 + 空闲 no-op。
// 可叫停的确定性窗口：假模型流（driveFakeAssistantStream）的 abort 检查点在 delayMs 结束后、
// 全部内容事件同步爆发之前 —— getLLMCallCount() ≥ 1 即流已 start 且停在延迟里，此刻 stopRun 必被兑现；
// 正文 delta 与 done 在同一宏任务内爆发，等首个 chunk 到达再叫停必然太晚。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent, ChatThinkingEvent, ThinkingLevel } from '../../shared/protocol.ts'
import { createRouter, type Router } from './router.ts'

// 延迟窗口：叫停必须落在流开始之后、内容爆发之前；800ms 足够轮询稳定且总时长有界
const ABORT_DELAY_MS = 800
const POLL_TIMEOUT_MS = 8000
// 叫停终态值：实现落地时 ChatStopReason 将扩展出 'aborted'（当前仅 'stop'|'error'）。
// 走 string 常量比较，实现前不产生无重叠比较的类型错误；运行时语义与字面量完全一致
const ABORTED: string = 'aborted'

// chunk 与 thinking 共用一条有序日志：断言 thinking end 先于 aborted 终态 chunk 需要跨通道顺序
type StopLogEvent = { kind: 'chunk'; chunk: ChatChunkEvent } | { kind: 'thinking'; thinking: ChatThinkingEvent }

interface StopHarness {
  router: Router
  chunks: ChatChunkEvent[]
  thinking: ChatThinkingEvent[]
  notices: ChatNoticeEvent[]
  events: StopLogEvent[]
  llmCalls: () => number
  dispose: () => void
}

async function makeStopRouter(options?: { delayMs?: number; thinkingLevel?: ThinkingLevel }): Promise<StopHarness> {
  const chunks: ChatChunkEvent[] = []
  const thinking: ChatThinkingEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const events: StopLogEvent[] = []
  const dir = mkdtempSync(join(tmpdir(), 'router-stop-'))
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    fakeStreamDelayMs: options?.delayMs,
    thinkingLevel: options?.thinkingLevel,
    onChunk: (event) => {
      chunks.push(event)
      events.push({ kind: 'chunk', chunk: event })
    },
    onNotice: (event) => notices.push(event),
    onThinking: (event) => {
      thinking.push(event)
      events.push({ kind: 'thinking', thinking: event })
    }
  })
  return {
    router,
    chunks,
    thinking,
    notices,
    events,
    llmCalls: () => router.getLLMCallCount(),
    dispose: () => router.dispose()
  }
}

function pollUntil(desc: string, probe: () => boolean, timeoutMs = POLL_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const check = (): void => {
      if (probe()) {
        resolve()
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`等待超时（${desc}）`))
        return
      }
      setTimeout(check, 5)
    }
    check()
  })
}

function untilStreamStarted(h: StopHarness): Promise<void> {
  return pollUntil('假模型流进入延迟窗口（LLM 调用 ≥ 1）', () => h.llmCalls() >= 1)
}

function untilDone(chunks: ChatChunkEvent[], messageId: string): Promise<void> {
  return pollUntil(`消息 ${messageId} 的 done`, () => chunks.some((c) => c.messageId === messageId && c.done))
}

function untilStopReason(chunks: ChatChunkEvent[], messageId: string, reason: string): Promise<void> {
  return pollUntil(`消息 ${messageId} 的 ${reason} 终态`, () =>
    chunks.some((c) => c.messageId === messageId && c.done && c.stopReason === reason)
  )
}

test('stopRun mid-stream terminates the reply with stopReason aborted (user stop, not error)', async () => {
  const h = await makeStopRouter({ delayMs: ABORT_DELAY_MS })
  const messageId = await h.router.send('流中叫停')
  await untilStreamStarted(h)
  h.router.stopRun()
  await untilStopReason(h.chunks, messageId, ABORTED)

  const own = h.chunks.filter((c) => c.messageId === messageId)
  assert.ok(
    own.some((c) => c.done && c.stopReason === ABORTED),
    `stream must terminate with a final chunk carrying stopReason 'aborted', got: ${JSON.stringify(own.at(-1))}`
  )
  assert.equal(own.filter((c) => c.done).length, 1, 'exactly one terminal chunk for the stopped message')
  assert.ok(own.every((c) => c.stopReason !== 'error'), 'no chunk may carry stopReason error for a user stop')
  assert.ok(
    !own.some((c) => c.delta.includes('模型调用失败')),
    'a user stop must not surface error text in the deltas'
  )
  assert.equal(
    h.notices.filter((n) => n.kind === 'router-error').length,
    0,
    'a user stop must not be presented as a router error'
  )

  // 叫停后 run 必须真正 settle：下一次发送照常工作，且以正常 stop 终结（stopRequested 已在 settle 清空）
  // 探针文本不能命中假模型意图模式（跑命令/mcp探针等会触发工具分支）
  const nextId = await h.router.send('追问一句')
  await untilDone(h.chunks, nextId)
  const nextOwn = h.chunks.filter((c) => c.messageId === nextId)
  assert.ok(nextOwn.map((c) => c.delta).join('').includes('OK: 追问一句'), 'router still replies after a stop')
  assert.equal(nextOwn.at(-1)?.stopReason, 'stop', 'the next run must end with a normal stop, not aborted')
  h.dispose()
})

test('stopRun during thinking closes the thinking row with an end phase before the aborted terminal', async () => {
  const h = await makeStopRouter({ delayMs: ABORT_DELAY_MS, thinkingLevel: 'high' })
  const messageId = await h.router.send('思考中叫停')
  await untilStreamStarted(h)
  h.router.stopRun()
  await untilStopReason(h.chunks, messageId, ABORTED)

  const own = h.chunks.filter((c) => c.messageId === messageId)
  assert.ok(
    own.some((c) => c.done && c.stopReason === ABORTED),
    `message must terminate aborted while thinking, got: ${JSON.stringify(own.at(-1))}`
  )
  assert.ok(own.every((c) => c.stopReason !== 'error'), 'no error terminal while stopping')

  // 思考行不得悬挂在流式态：凡 start 过的 key 必须恰好补一个 end，且 end 先于 aborted 终态 chunk。
  // 注：现假模型的 abort 检查点在全部思考/正文事件之前，此场景下思考事件为零，不变量空真成立；
  // 假模型一旦支持思考中叫停（thinking 事件在 abort 前已在途），本断言即逐 key 生效
  const abortIndex = h.events.findIndex(
    (e) => e.kind === 'chunk' && e.chunk.messageId === messageId && e.chunk.done && e.chunk.stopReason === ABORTED
  )
  assert.ok(abortIndex >= 0, 'the aborted terminal chunk must exist in the ordered event log')
  const keys = new Set(h.thinking.map((e) => e.key))
  for (const key of keys) {
    const mine = h.thinking.filter((e) => e.key === key)
    assert.equal(
      mine.filter((e) => e.phase === 'start').length,
      mine.filter((e) => e.phase === 'end').length,
      `thinking row ${key} must not dangle: every start needs an end when the run is stopped`
    )
    const lastEndIndex = h.events.findLastIndex(
      (e) => e.kind === 'thinking' && e.thinking.key === key && e.thinking.phase === 'end'
    )
    if (lastEndIndex >= 0) {
      assert.ok(
        lastEndIndex < abortIndex,
        `thinking end for ${key} must precede the aborted terminal chunk so the UI row settles first`
      )
    }
  }
  h.dispose()
})

test('stopRun preserves the pending buffer: the queued message is pumped and answered after the aborted run', async () => {
  const h = await makeStopRouter({ delayMs: ABORT_DELAY_MS })
  const firstId = await h.router.send('第一条')
  await untilStreamStarted(h)
  const secondId = await h.router.send('第二条')
  h.router.stopRun()
  await untilStopReason(h.chunks, firstId, ABORTED)
  await untilDone(h.chunks, secondId)

  const firstOwn = h.chunks.filter((c) => c.messageId === firstId)
  assert.ok(
    firstOwn.some((c) => c.done && c.stopReason === ABORTED),
    'run A must terminate aborted when the user stops it'
  )
  assert.ok(firstOwn.every((c) => c.stopReason !== 'error'), 'no error terminal for the stopped run')

  // 缓冲存活：叫停 settle 之后缓冲泵出，B 拿到正常的流式回复与 done（非 aborted、非 error）
  const secondOwn = h.chunks.filter((c) => c.messageId === secondId)
  const secondReply = secondOwn.map((c) => c.delta).join('')
  assert.ok(secondOwn.length > 1, 'the buffered message keeps its own streaming reply')
  assert.ok(secondReply.includes('OK: 第二条'), `buffered message must be pumped and answered, got: ${secondReply}`)
  assert.equal(secondOwn.filter((c) => c.done).length, 1, 'exactly one done for the pumped message')
  assert.equal(secondOwn.at(-1)?.stopReason, 'stop', 'the pumped reply ends with a normal stop, not aborted')
  assert.equal(h.notices.filter((n) => n.kind === 'router-error').length, 0, 'neither the stop nor the pump is an error')
  h.dispose()
})

test('stopRun with no active run is a no-op and leaves later sends intact', async () => {
  const h = await makeStopRouter()
  await h.router.stopRun()
  assert.equal(h.chunks.length, 0, 'an idle stop must not emit chunk events')
  assert.equal(h.thinking.length, 0, 'an idle stop must not emit thinking events')
  assert.equal(h.notices.length, 0, 'an idle stop must not emit notices')

  const messageId = await h.router.send('空闲探针')
  await untilDone(h.chunks, messageId)
  const own = h.chunks.filter((c) => c.messageId === messageId)
  assert.equal(own.map((c) => c.delta).join(''), 'OK: 空闲探针', 'a later send behaves normally after an idle stop')
  assert.equal(own.at(-1)?.stopReason, 'stop', 'the later run ends with a normal stop (idle stop set no stopRequested)')
  assert.equal(
    h.chunks.filter((c) => c.messageId !== messageId).length,
    0,
    'the idle stop left no stray chunks behind'
  )
  h.dispose()
})
