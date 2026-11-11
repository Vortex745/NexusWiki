import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { ChatChunkEvent, ChatNoticeEvent, ChatTaskEvent } from '../../shared/protocol.ts'
import { getTask, listTasks } from './store.ts'
import { createTaskDispatcher, type TaskDispatcher } from './dispatcher.ts'
import { createRouter, type Router } from '../chat/router.ts'

// 票 04（叫停与查询）端到端测试：接缝与 dispatch.test.ts 相同（createRouter + createTaskDispatcher + SQLite）

interface Harness {
  router: Router
  dispatcher: TaskDispatcher
  db: DatabaseSync
  chunks: ChatChunkEvent[]
  notices: ChatNoticeEvent[]
  taskEvents: ChatTaskEvent[]
  workspaceRoot: string
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 't04-interrupt-'))
}

async function makeHarness(options?: { workerDelayMs?: number }): Promise<Harness> {
  const dir = makeTempDir()
  const db = new DatabaseSync(':memory:')
  const chunks: ChatChunkEvent[] = []
  const notices: ChatNoticeEvent[] = []
  const taskEvents: ChatTaskEvent[] = []
  const workspaceRoot = join(dir, 'workspace')
  const dispatcher = createTaskDispatcher({
    db,
    workspaceRoot,
    agentDir: dir,
    workerMode: 'fake',
    workerStreamDelayMs: options?.workerDelayMs,
    workerMaxTurns: 100,
    onTaskEvent: (event) => taskEvents.push(event),
    onNotice: (event) => notices.push(event)
  })
  const router = await createRouter({
    mode: 'fake',
    cwd: dir,
    agentDir: dir,
    onDispatchTask: (input) => dispatcher.handleDispatch(input),
    onInterruptTask: (taskId) => dispatcher.interrupt(taskId),
    onTaskStatus: (taskId) => listTasks(db, taskId),
    onChunk: (event) => chunks.push(event),
    onNotice: (event) => notices.push(event)
  })
  dispatcher.attachRouter(router)
  return { router, dispatcher, db, chunks, notices, taskEvents, workspaceRoot }
}

// 兜底清理：叫停所有仍在进行中的任务，避免长任务把测试进程挂死
async function stopAllTasks(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const active = listTasks(h.db).find((t) => t.status === 'queued' || t.status === 'running')
    if (!active) return
    await h.dispatcher.interrupt(active.id)
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

// fake 流按 4 字符分片，断言前先按 messageId 拼接
function textOfChunks(chunks: ChatChunkEvent[], messageId: string): string {
  return chunks
    .filter((c) => c.messageId === messageId)
    .map((c) => c.delta)
    .join('')
}

function untilTaskEvent(taskEvents: ChatTaskEvent[], status: ChatTaskEvent['status']): Promise<ChatTaskEvent> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('task_status answers with the task list consistent with SQLite', async () => {
  const h = await makeHarness()
  try {
    const { taskId } = h.dispatcher.handleDispatch({ title: '状态查询样例', prompt: '写一个 query.js 输出 ok' })
    await waitFor(() => getTask(h.db, taskId)?.status === 'done', 'task done', 15000)

    const replyId = await h.router.send('现在在忙什么？')
    await untilDone(h.chunks, replyId)
    const reply = textOfChunks(h.chunks, replyId)

    const row = getTask(h.db, taskId)
    assert.ok(row, 'task row exists')
    assert.ok(reply.includes(taskId), `reply must contain task id, got: ${reply}`)
    assert.ok(reply.includes(row.title), `reply must contain title, got: ${reply}`)
    assert.ok(reply.includes(row.status), `reply must contain status, got: ${reply}`)
  } finally {
    await stopAllTasks(h)
    h.router.dispose()
  }
})

test('interrupt stops a running worker: DB aborted, no report injected, worker stops producing', async () => {
  const h = await makeHarness({ workerDelayMs: 25 })
  try {
    // worker-fake 遇到"长任务"会每回合写一个 step-N.js 且不汇报，直到被叫停
    const userId = await h.router.send('写一个 长任务 slow.js')
    await untilDone(h.chunks, userId)

    const running = await untilTaskEvent(h.taskEvents, 'running')
    const taskId = running.taskId
    await waitFor(() => existsSync(join(h.workspaceRoot, taskId, 'slow.js')), 'first artifact')

    // 忙时问状态：task_status 显示 running
    const statusId = await h.router.send('现在在忙什么？')
    await untilDone(h.chunks, statusId)
    const statusReply = textOfChunks(h.chunks, statusId)
    assert.ok(statusReply.includes(taskId), `status reply must contain taskId, got: ${statusReply}`)
    assert.ok(statusReply.includes('running'), `status reply must show running, got: ${statusReply}`)

    // 叫停：Router 收到确认并转告用户
    const stopId = await h.router.send('停掉这个任务')
    await untilDone(h.chunks, stopId)
    const stopReply = textOfChunks(h.chunks, stopId)
    assert.ok(stopReply.includes('已中止'), `stop reply must confirm abort, got: ${stopReply}`)

    const row = getTask(h.db, taskId)
    assert.equal(row?.status, 'aborted')
    assert.ok(row?.finished, 'aborted task has finished time')

    // 事件序列：running → aborted，没有 done/failed
    const statuses = h.taskEvents.filter((e) => e.taskId === taskId).map((e) => e.status)
    assert.deepEqual(statuses, ['running', 'aborted'])

    // 无后续汇报注入：静置后 Router 只产出过派活回执、状态回答、中止确认三句
    await sleep(250)
    const doneIds = new Set(h.chunks.filter((c) => c.done).map((c) => c.messageId))
    assert.deepEqual([...doneIds].sort(), [userId, statusId, stopId].sort())
    assert.equal(h.notices.length, 0)

    // Worker 进程性停止：产物文件数不再增长
    const taskDir = join(h.workspaceRoot, taskId)
    const before = readdirSync(taskDir).length
    await sleep(250)
    assert.equal(readdirSync(taskDir).length, before, 'worker must stop producing files after abort')
  } finally {
    await stopAllTasks(h)
    h.router.dispose()
  }
})

test('interrupting a finished task returns an error result and keeps its status', async () => {
  const h = await makeHarness()
  try {
    const { taskId } = h.dispatcher.handleDispatch({ title: '已完成样例', prompt: '写一个 done.js 输出 ok' })
    await waitFor(() => getTask(h.db, taskId)?.status === 'done', 'task done', 15000)

    const replyId = await h.router.send(`停掉任务 ${taskId}`)
    await untilDone(h.chunks, replyId)
    const reply = textOfChunks(h.chunks, replyId)
    assert.ok(reply.includes('无法中止'), `must refuse to abort a finished task, got: ${reply}`)
    assert.equal(getTask(h.db, taskId)?.status, 'done', 'finished task keeps its status')
    assert.equal(h.notices.length, 0)
  } finally {
    await stopAllTasks(h)
    h.router.dispose()
  }
})

test('interrupting an unknown task id returns a clear not-found error', async () => {
  const h = await makeHarness()
  try {
    const ghost = '00000000-0000-4000-8000-000000000000'
    const replyId = await h.router.send(`停掉任务 ${ghost}`)
    await untilDone(h.chunks, replyId)
    const reply = textOfChunks(h.chunks, replyId)
    assert.ok(reply.includes('任务不存在'), `must say task not found, got: ${reply}`)
    assert.equal(h.notices.length, 0)
  } finally {
    await stopAllTasks(h)
    h.router.dispose()
  }
})
