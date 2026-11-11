import type { DatabaseSync } from 'node:sqlite'
import type { ChatTaskEvent } from '../../shared/protocol.ts'

// tasks 表唯一落账点：id/title/status/report/created/finished（票据 03 定义的列）
// interrupted：重启恢复时仍处于 running/queued 的任务（子代理随进程消亡，不会再有终态事件来；区别于用户主动中止的 aborted）
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted' | 'interrupted'

export interface TaskRow {
  id: string
  title: string
  status: TaskStatus
  report: string | null
  created: string
  finished: string | null
}

export function ensureTasksTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    report TEXT,
    created TEXT NOT NULL,
    finished TEXT
  )`)
}

export function insertTask(
  db: DatabaseSync,
  task: { id: string; title: string; status: TaskStatus; createdAt: string }
): void {
  db.prepare('INSERT INTO tasks (id, title, status, report, created, finished) VALUES (?, ?, ?, NULL, ?, NULL)').run(
    task.id,
    task.title,
    task.status,
    task.createdAt
  )
}

export function updateTask(
  db: DatabaseSync,
  id: string,
  patch: { status?: TaskStatus; report?: string; finishedAt?: string }
): void {
  const sets: string[] = []
  const values: string[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.report !== undefined) {
    sets.push('report = ?')
    values.push(patch.report)
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished = ?')
    values.push(patch.finishedAt)
  }
  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function getTask(db: DatabaseSync, id: string): TaskRow | undefined {
  const row = db
    .prepare('SELECT id, title, status, report, created, finished FROM tasks WHERE id = ?')
    .get(id) as { id: string; title: string; status: string; report: string | null; created: string; finished: string | null } | undefined
  if (!row) return undefined
  return { ...row, status: row.status as TaskStatus }
}

// 任务列表（按创建时间升序）；给定 taskId 时只返回该任务
export function listTasks(db: DatabaseSync, taskId?: string): TaskRow[] {
  const sql = 'SELECT id, title, status, report, created, finished FROM tasks'
  const rows = (
    taskId !== undefined
      ? db.prepare(`${sql} WHERE id = ? ORDER BY created, rowid`).all(taskId)
      : db.prepare(`${sql} ORDER BY created, rowid`).all()
  ) as Array<{ id: string; title: string; status: string; report: string | null; created: string; finished: string | null }>
  return rows.map((row) => ({ ...row, status: row.status as TaskStatus }))
}

// 启动恢复：子代理随进程消亡，重启时 running/queued 都是幽灵（不会再有终态事件到达），
// 批量改为 interrupted 并对每条发出 task-event 行；done/failed/aborted 原样保留。
// 返回被恢复的任务数（幂等：再次调用为 0）。
export function recoverInterruptedTasks(db: DatabaseSync, onTaskEvent: (event: ChatTaskEvent) => void): number {
  const rows = db
    .prepare("SELECT id, title FROM tasks WHERE status IN ('running', 'queued')")
    .all() as Array<{ id: string; title: string }>
  const finishedAt = new Date().toISOString()
  for (const row of rows) {
    updateTask(db, row.id, { status: 'interrupted', finishedAt })
    onTaskEvent({ taskId: row.id, title: row.title, status: 'interrupted' })
  }
  return rows.length
}
