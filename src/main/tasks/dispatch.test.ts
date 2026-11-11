import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent, ChatTaskEvent } from '../../shared/protocol.ts'
import { getTask } from './store.ts'
import { createTaskDispatcher, type TaskDispatcher } from './dispatcher.ts'
import { createRouter, type Router } from '../chat/router.ts'

// worker-fake 固定产物内容（独立于实现里的同一字面量，作为期望值来源）
const EXPECTED_ARTIFACT = "console.log('hello from worker');"

interface Harness {
  router: Router
  dispatcher: TaskDispatcher
  db: DatabaseSync
  chunks: ChatChunkEvent[]
  notices: ChatNoticeEvent[]
  taskEvents: ChatTaskEvent[]
  /** 与 taskEvents 一一对应的事件到达时间（并行时间线断言用） */
  taskEventTimes: number[]
  workspaceRoot: string
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 't03-dispatch-'))
}

async function makeHarness(options?: {
  workerDelayMs?: number
  workerMode?: 'fake' | 'real'
}): Promise<Harness> {
  const dir = makeTempDir()
  const db = new DatabaseSync(':memory:')
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const taskEvents: ChatTaskEvent[] = []
  const taskEventTimes: number[] = []
  const workspaceRoot = join(dir, 'workspace')
  const dispatcher = createTaskDispatcher({
    db,
    workspaceRoot,
    agentDir: dir,
    workerMode: options?.workerMode ?? 'fake',
    workerStreamDelayMs: options?.workerDelayMs,
    onTaskEvent: (event) => {
      taskEvents.push(event)
      taskEventTimes.push(Date.now())
    },
    onNotice: (event) => notices.push(event)
  })
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    onDispatchTask: (input) => dispatcher.handleDispatch(input),
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })
  dispatcher.attachRouter(router)
  return { router, dispatcher, db, chunks, notices, taskEvents, taskEventTimes, workspaceRoot }
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

function waitFor(predicate: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = (): void => {
      if (predicate()) resolve()
      else if (Date.now() - started > timeoutMs) reject(new Error(`timeout waiting for ${what}`))
      else setTimeout(check, 10)
    }
    check()
  })
}

function untilTaskEvent(taskEvents: ChatTaskEvent[], status: 'running' | 'done' | 'failed'): Promise<ChatTaskEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = (): void => {
      const found = taskEvents.find((e) => e.status === status)
      if (found) resolve(found)
      else if (Date.now() - started > 10000) {
        reject(new Error(`timeout waiting for ${status} event, got: ${JSON.stringify(taskEvents)}`))
      } else setTimeout(check, 10)
    }
    check()
  })
}

function untilTaskEventCount(
  taskEvents: ChatTaskEvent[],
  status: 'running' | 'done' | 'failed',
  count: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = (): void => {
      if (taskEvents.filter((e) => e.status === status).length >= count) resolve()
      else if (Date.now() - started > 10000) {
        reject(new Error(`timeout waiting for ${count} ${status} events, got: ${JSON.stringify(taskEvents)}`))
      } else setTimeout(check, 10)
    }
    check()
  })
}

// 取某任务某状态事件的到达时间（与 taskEventTimes 按下标对应）
function eventTimeAt(
  h: Harness,
  taskId: string,
  status: 'running' | 'done' | 'failed'
): number {
  const index = h.taskEvents.findIndex((e) => e.taskId === taskId && e.status === status)
  if (index < 0) throw new Error(`no ${status} event for ${taskId}`)
  return h.taskEventTimes[index]!
}

test('task status flows queued -> running -> done in the tasks table', async () => {
  const h = await makeHarness({ workerDelayMs: 100 })
  const { taskId } = h.dispatcher.handleDispatch({ title: '状态流转', prompt: '写一个 status.js 输出 ok' })

  // handleDispatch 同步返回后任务还是 queued（worker 异步启动）
  assert.equal(getTask(h.db, taskId)?.status, 'queued')

  await waitFor(() => getTask(h.db, taskId)?.status === 'running', 'task running')
  const doneEvent = await untilTaskEvent(h.taskEvents, 'done')
  assert.equal(doneEvent.taskId, taskId)
  assert.ok(doneEvent.report?.includes('status.js'), `report mentions the artifact, got: ${doneEvent.report}`)

  const row = getTask(h.db, taskId)
  assert.equal(row?.status, 'done')
  assert.ok(row?.report?.includes('status.js'))
  assert.ok(row?.created)
  assert.ok(row?.finished)
  h.router.dispose()
})

test('full dispatch loop: user message -> worker artifact -> tasks table -> router report', async () => {
  const h = await makeHarness()
  const userId = await h.router.send('写一个 hello.js 并运行')
  await untilDone(h.chunks, userId)

  const doneEvent = await untilTaskEvent(h.taskEvents, 'done')
  const taskId = doneEvent.taskId

  // Worker 产物文件落在 workspace/<taskId>/
  const artifact = join(h.workspaceRoot, taskId, 'hello.js')
  assert.ok(existsSync(artifact), `artifact must exist at ${artifact}`)
  assert.equal(readFileSync(artifact, 'utf8'), EXPECTED_ARTIFACT)

  // 事件序列：running 先于 done
  const statuses = h.taskEvents.filter((e) => e.taskId === taskId).map((e) => e.status)
  assert.deepEqual(statuses, ['running', 'done'])

  // tasks 表
  const row = getTask(h.db, taskId)
  assert.equal(row?.status, 'done')
  assert.ok(row?.report?.includes('hello.js'), `report mentions artifact, got: ${row?.report}`)
  assert.ok(row?.title.includes('hello.js'), `title derived from user text, got: ${row?.title}`)

  // Router 收到汇报后产生面向用户的回复（另一条 assistant 消息，含结果内容）
  await waitFor(
    () => {
      const textById = new Map<string, string>()
      const doneIds = new Set<string>()
      for (const c of h.chunks) {
        textById.set(c.messageId, (textById.get(c.messageId) ?? '') + c.delta)
        if (c.done) doneIds.add(c.messageId)
      }
      return [...doneIds].some((id) => id !== userId && (textById.get(id) ?? '').includes('hello.js'))
    },
    'router user-facing report after task completion'
  )
  assert.equal(h.notices.length, 0)
  h.router.dispose()
})

test('worker reporting failed marks the task failed and the router tells the user', async () => {
  const h = await makeHarness()
  const userId = await h.router.send('做个 强制失败 的任务')
  await untilDone(h.chunks, userId)

  const failed = await untilTaskEvent(h.taskEvents, 'failed')
  const row = getTask(h.db, failed.taskId)
  assert.equal(row?.status, 'failed')
  assert.ok(row?.report?.includes('模拟失败'), `report carries failure text, got: ${row?.report}`)
  assert.ok(row?.finished)

  // 失败任务没有产物文件
  assert.ok(!existsSync(join(h.workspaceRoot, failed.taskId, 'task.js')))

  // Router 向用户转述失败
  await waitFor(
    () => {
      const textById = new Map<string, string>()
      const doneIds = new Set<string>()
      for (const c of h.chunks) {
        textById.set(c.messageId, (textById.get(c.messageId) ?? '') + c.delta)
        if (c.done) doneIds.add(c.messageId)
      }
      return [...doneIds].some((id) => id !== userId && (textById.get(id) ?? '').includes('模拟失败'))
    },
    'router user-facing failure report'
  )
  h.router.dispose()
})

test('worker session ending in a stream error reports the real error, not just a missing report', async () => {
  const h = await makeHarness()
  const userId = await h.router.send('做个 错误收尾 的任务')
  await untilDone(h.chunks, userId)

  const failed = await untilTaskEvent(h.taskEvents, 'failed')
  const row = getTask(h.db, failed.taskId)
  assert.equal(row?.status, 'failed')
  assert.ok(
    row?.report?.includes('模拟错误'),
    `report must carry the underlying LLM error, got: ${row?.report}`
  )
  h.router.dispose()
})

test('worker report with a missing artifact is rejected and the task records the reason', async () => {
  const h = await makeHarness()
  const userId = await h.router.send('做个 产物校验 的任务')
  await untilDone(h.chunks, userId)

  const failed = await untilTaskEvent(h.taskEvents, 'failed')
  const row = getTask(h.db, failed.taskId)
  assert.equal(row?.status, 'failed')
  assert.ok(
    row?.report?.includes('汇报被拒绝'),
    `report must carry the artifact validation reason, got: ${row?.report}`
  )
  assert.ok(!existsSync(join(h.workspaceRoot, failed.taskId, 'missing.js')))
  h.router.dispose()
})

test('unconfigured real worker fails the task with a clear report', async () => {
  const h = await makeHarness({ workerMode: 'real' })
  const userId = await h.router.send('写一个 never.js')
  await untilDone(h.chunks, userId)

  const failed = await untilTaskEvent(h.taskEvents, 'failed')
  const row = getTask(h.db, failed.taskId)
  assert.equal(row?.status, 'failed')
  assert.ok(
    row?.report?.includes('未配置模型'),
    `session error path produces a clear report, got: ${row?.report}`
  )
  // 会话没能启动：没有 running 事件，直接 failed
  const statuses = h.taskEvents.filter((e) => e.taskId === failed.taskId).map((e) => e.status)
  assert.deepEqual(statuses, ['failed'])
  h.router.dispose()
})

test('two concurrent dispatches both complete without interfering', async () => {
  const h = await makeHarness()
  const id1 = await h.router.send('写一个 alpha.js')
  const id2 = await h.router.send('写一个 beta.js')
  assert.notEqual(id1, id2)
  await untilDone(h.chunks, id1)
  await untilDone(h.chunks, id2)

  await waitFor(() => h.taskEvents.filter((e) => e.status === 'done').length >= 2, 'both tasks done')

  const taskIds = new Set(h.taskEvents.filter((e) => e.status === 'done').map((e) => e.taskId))
  assert.equal(taskIds.size, 2, 'two distinct tasks completed')
  for (const taskId of taskIds) {
    assert.equal(getTask(h.db, taskId)?.status, 'done')
  }
  // 两个产物文件都落了盘
  const files = readdirSync(h.workspaceRoot).flatMap((d) => readdirSync(join(h.workspaceRoot, d)))
  assert.ok(files.includes('alpha.js'), `alpha.js must exist, got: ${files.join(',')}`)
  assert.ok(files.includes('beta.js'), `beta.js must exist, got: ${files.join(',')}`)
  assert.equal(h.notices.length, 0)
  h.router.dispose()
})

test('two workers overlap in time and a user interjection during them is answered', async () => {
  const h = await makeHarness({ workerDelayMs: 50 })
  await h.router.send('写一个 alpha.js') // run 1：派发任务 A，Worker A 立即开工
  await h.router.send('写一个 beta.js') // Router 忙 → 攒批缓冲，settled 后派发任务 B
  await untilTaskEventCount(h.taskEvents, 'running', 2)

  // 两个 Worker 都已开工期间用户插话：必须被接受并在下一轮得到回复
  const interjectionId = await h.router.send('现在进展如何？')
  await untilTaskEventCount(h.taskEvents, 'done', 2)
  await waitFor(
    () => h.chunks.some((c) => c.messageId === interjectionId && c.done),
    'interjection answered'
  )

  // 时间线交错：A 的 [start, end] 与 B 的 [start, end] 区间相交
  const [taskA, taskB] = h.taskEvents.filter((e) => e.status === 'done').map((e) => e.taskId)
  const startA = eventTimeAt(h, taskA!, 'running')
  const endA = eventTimeAt(h, taskA!, 'done')
  const startB = eventTimeAt(h, taskB!, 'running')
  const endB = eventTimeAt(h, taskB!, 'done')
  assert.ok(endA > startB, `worker A (end ${endA}) must still run when worker B starts (${startB})`)
  assert.ok(endB > startA, `worker B (end ${endB}) must still run after worker A started (${startA})`)

  // 插话有响应：回复内容覆盖插话文本
  const interjectionReply = h.chunks
    .filter((c) => c.messageId === interjectionId)
    .map((c) => c.delta)
    .join('')
  assert.ok(
    interjectionReply.includes('进展如何'),
    `interjection must get a covering reply, got: ${interjectionReply}`
  )
  assert.equal(getTask(h.db, taskA!)?.status, 'done')
  assert.equal(getTask(h.db, taskB!)?.status, 'done')
  assert.equal(h.notices.length, 0)
  h.router.dispose()
})

test('worker workspaces are isolated per task id and artifacts never cross', async () => {
  const h = await makeHarness()
  const { taskId: idA } = h.dispatcher.handleDispatch({ title: '隔离 A', prompt: '写一个 solo-a.js' })
  const { taskId: idB } = h.dispatcher.handleDispatch({ title: '隔离 B', prompt: '写一个 solo-b.js' })
  assert.notEqual(idA, idB)

  await untilTaskEventCount(h.taskEvents, 'done', 2)
  assert.equal(getTask(h.db, idA)?.status, 'done')
  assert.equal(getTask(h.db, idB)?.status, 'done')

  // 每个 Worker 的产物只落在自己的 workspace/<taskId>/ 里（即其 session cwd），互不包含
  const dirA = join(h.workspaceRoot, idA)
  const dirB = join(h.workspaceRoot, idB)
  assert.deepEqual(readdirSync(dirA).sort(), ['solo-a.js'], `task A dir must hold only its own artifact, got: ${readdirSync(dirA).join(',')}`)
  assert.deepEqual(readdirSync(dirB).sort(), ['solo-b.js'], `task B dir must hold only its own artifact, got: ${readdirSync(dirB).join(',')}`)
  assert.equal(readFileSync(join(dirA, 'solo-a.js'), 'utf8'), EXPECTED_ARTIFACT)
  assert.equal(readFileSync(join(dirB, 'solo-b.js'), 'utf8'), EXPECTED_ARTIFACT)
  assert.ok(!existsSync(join(dirA, 'solo-b.js')), 'A must not see B artifact')
  assert.ok(!existsSync(join(dirB, 'solo-a.js')), 'B must not see A artifact')
  assert.equal(h.notices.length, 0)
  h.router.dispose()
})
