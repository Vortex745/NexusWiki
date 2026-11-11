import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { ChatTaskEvent } from '../../shared/protocol.ts'
import { ensureTasksTable, getTask, insertTask, recoverInterruptedTasks } from './store.ts'

// T6：重启恢复。SQLite 里 status=running/queued 的任务批量改为 interrupted 并发出事件行；终态原样保留
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  ensureTasksTable(db)
  return db
}

function seed(db: DatabaseSync, id: string, title: string, status: string): void {
  insertTask(db, { id, title, status: status as never, createdAt: '2026-01-01T00:00:00.000Z' })
}

test('running and queued tasks become interrupted on startup recovery; terminal states are untouched', () => {
  const db = makeDb()
  seed(db, 'a', '运行中', 'running')
  seed(db, 'b', '已完成', 'done')
  seed(db, 'c', '已失败', 'failed')
  seed(db, 'd', '排队中', 'queued')
  seed(db, 'e', '已中止', 'aborted')

  const events: ChatTaskEvent[] = []
  const count = recoverInterruptedTasks(db, (event) => events.push(event))

  assert.equal(count, 2, 'running and queued tasks are both recovered')
  const recovered = getTask(db, 'a')
  assert.equal(recovered?.status, 'interrupted')
  assert.ok(recovered?.finished, 'interrupted task is stamped as finished')
  for (const [id, status] of [
    ['b', 'done'],
    ['c', 'failed'],
    ['d', 'interrupted'],
    ['e', 'aborted']
  ] as const) {
    assert.equal(getTask(db, id)?.status, status, `${status} task must be preserved as-is`)
  }
  assert.deepEqual(events, [
    { taskId: 'a', title: '运行中', status: 'interrupted' },
    { taskId: 'd', title: '排队中', status: 'interrupted' }
  ])
})

test('queued tasks are ghosts too — a pre-restart queued task is recovered to interrupted', () => {
  const db = makeDb()
  seed(db, 'q1', '排队一', 'queued')
  seed(db, 'q2', '排队二', 'queued')
  seed(db, 'k', '已完成', 'done')

  const events: ChatTaskEvent[] = []
  const count = recoverInterruptedTasks(db, (event) => events.push(event))

  assert.equal(count, 2, 'both queued tasks are recovered')
  assert.equal(getTask(db, 'q1')?.status, 'interrupted')
  assert.equal(getTask(db, 'q2')?.status, 'interrupted')
  assert.ok(getTask(db, 'q1')?.finished, 'recovered queued task is stamped as finished')
  assert.equal(getTask(db, 'k')?.status, 'done', 'terminal state stays untouched')
  assert.deepEqual(
    events,
    [
      { taskId: 'q1', title: '排队一', status: 'interrupted' },
      { taskId: 'q2', title: '排队二', status: 'interrupted' }
    ],
    'one interrupted event row per recovered queued task'
  )
})

test('recovery is idempotent — a second run changes nothing and emits nothing', () => {
  const db = makeDb()
  seed(db, 'a', '运行中', 'running')

  const first: ChatTaskEvent[] = []
  assert.equal(recoverInterruptedTasks(db, (event) => first.push(event)), 1)

  const second: ChatTaskEvent[] = []
  assert.equal(recoverInterruptedTasks(db, (event) => second.push(event)), 0)
  assert.equal(second.length, 0)
  assert.equal(getTask(db, 'a')?.status, 'interrupted')
})
