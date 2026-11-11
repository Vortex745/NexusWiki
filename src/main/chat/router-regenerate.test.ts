// Router.regenerate（重新生成）验收测试：实现落地前全部失败（regenerate 不存在），落地后必须全绿。
// 合同（批准方案 D 节）：重新生成 = SessionManager.branch 回溯到最后一条 user 条目之前，
// 以正常 send 路径重发同一原文，返回新 assistant messageId。
// 上下文截断的可观测证据：假模型首轮回显「OK: <原文>」不带「首轮」引用标记——
// 若 branch 后旧回复仍泄漏进上下文，重发会命中第二轮引用分支，回显必然携带「首轮: …」。
// pi 语义（dist 实证）：AgentSession 每次运行都经 buildSessionProjection()（root→leaf）取上下文，
// branch 只移动 leaf，下一次 prompt 自动跟随新分支，无需重建会话。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent, ChatThinkingEvent } from '../../shared/protocol.ts'
import { createRouter, type Router } from './router.ts'

const DELAY_MS = 800
const POLL_TIMEOUT_MS = 8000

interface RegenHarness {
  router: Router
  chunks: ChatChunkEvent[]
  thinking: ChatThinkingEvent[]
  notices: ChatNoticeEvent[]
  llmCalls: () => number
  dispose: () => void
}

async function makeRegenRouter(options?: { delayMs?: number }): Promise<RegenHarness> {
  const chunks: ChatChunkEvent[] = []
  const thinking: ChatThinkingEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const dir = mkdtempSync(join(tmpdir(), 'router-regen-'))
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    fakeStreamDelayMs: options?.delayMs,
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event),
    onThinking: (event) => thinking.push(event)
  })
  return { router, chunks, thinking, notices, llmCalls: () => router.getLLMCallCount(), dispose: () => router.dispose() }
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

function untilStreamStarted(h: RegenHarness): Promise<void> {
  return pollUntil('假模型流进入延迟窗口（LLM 调用 ≥ 1）', () => h.llmCalls() >= 1)
}

function untilDone(chunks: ChatChunkEvent[], messageId: string): Promise<void> {
  return pollUntil(`消息 ${messageId} 的 done`, () => chunks.some((c) => c.messageId === messageId && c.done))
}

function replyOf(chunks: ChatChunkEvent[], messageId: string): string {
  return chunks.filter((c) => c.messageId === messageId).map((c) => c.delta).join('')
}

test('regenerate re-runs the last user turn on a branch without the abandoned reply', async () => {
  const h = await makeRegenRouter()
  const firstId = await h.router.send('第一条')
  await untilDone(h.chunks, firstId)
  assert.equal(replyOf(h.chunks, firstId), 'OK: 第一条', 'sanity: first reply echoes the prompt')

  const newId = await h.router.regenerate()
  await untilDone(h.chunks, newId)
  assert.notEqual(newId, firstId, 'regenerate must stream a fresh assistant message id')

  // 旧回复的 chunk 不被重放：旧 id 的事件集合在 regenerate 前后完全一致
  const before = h.chunks.filter((c) => c.messageId === firstId)
  // （先记录 regenerate 前的切片数，再等新消息完成后重新取，长度必须相等）
  const after = h.chunks.filter((c) => c.messageId === firstId)
  assert.equal(after.length, before.length, 'regenerate must not re-emit chunks for the abandoned message')

  // 上下文截断证据：重发是全新首轮 —— 精确回显，不带第二轮的「首轮: …」引用标记
  const reply = replyOf(h.chunks, newId)
  assert.equal(reply, 'OK: 第一条', `branched re-run must not see the abandoned reply in context, got: ${reply}`)
  assert.ok(!reply.includes('首轮'), 'no first-round quote marker may appear after branching')
  assert.equal(h.notices.length, 0, 'regenerate is not an error path')
  h.dispose()
})

test('regenerate after a later turn re-runs only that turn', async () => {
  const h = await makeRegenRouter()
  const firstId = await h.router.send('第一条')
  await untilDone(h.chunks, firstId)
  const secondId = await h.router.send('第二条')
  await untilDone(h.chunks, secondId)

  const newId = await h.router.regenerate()
  await untilDone(h.chunks, newId)
  const reply = replyOf(h.chunks, newId)
  // branch 回到最后一条 user 条目之前（其 parentId）：上下文保留第一轮完整对话（第一条→OK: 第一条），
  // 重发「第二条」命中第二轮回显格式（带「首轮」引用标记）——前文必须在场，重新生成不得让模型失忆；
  // 被放弃的第二条旧回复不重复出现（引用标记引用的是第一轮 user 文本，不是旧回复）
  assert.ok(reply.includes('OK: 第二条'), `regenerate must re-run the last turn, got: ${reply}`)
  assert.ok(reply.includes('首轮: 第一条'), `prior turns must stay in context after branching, got: ${reply}`)
  h.dispose()
})

test('regenerate with no assistant reply yet rejects cleanly', async () => {
  const h = await makeRegenRouter()
  await assert.rejects(() => h.router.regenerate(), /无可重新生成的回复/)
  assert.equal(h.chunks.length, 0, 'the failed regenerate must not emit any chunks')
  assert.equal(h.notices.length, 0, 'the failed regenerate must not emit notices')
  // 失败后路由仍可用
  const messageId = await h.router.send('空闲探针')
  await untilDone(h.chunks, messageId)
  assert.equal(replyOf(h.chunks, messageId), 'OK: 空闲探针', 'the router still works after a rejected regenerate')
  h.dispose()
})

test('regenerate while a run is active rejects and leaves the run untouched', async () => {
  const h = await makeRegenRouter({ delayMs: DELAY_MS })
  const messageId = await h.router.send('流中再生成')
  await untilStreamStarted(h)
  await assert.rejects(() => h.router.regenerate(), /进行中/)
  await untilDone(h.chunks, messageId)
  assert.equal(replyOf(h.chunks, messageId), 'OK: 流中再生成', 'the in-flight run completes normally after the rejection')
  assert.equal(h.chunks.filter((c) => c.done).length, 1, 'exactly one done: the untouched run, nothing from regenerate')
  h.dispose()
})
