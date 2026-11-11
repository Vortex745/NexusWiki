import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ChatNoticeEvent, ChatSubagentStepEvent, ChatTaskActivityEvent, ChatTaskEvent } from '../../shared/protocol.ts'
import { errorMessageOf, TASK_REPORT_PREFIX, type AgentMode } from '../chat/pi-shared.ts'
import { ensureTasksTable, getTask, insertTask, listTasks, updateTask } from './store.ts'
import { runWorker } from './worker.ts'

// Router 需要暴露的最小面（避免与 chat 模块产生类型耦合）
export interface RouterLike {
  send: (text: string) => Promise<string>
}

export interface InterruptResult {
  ok: boolean
  message: string
}

export interface TaskDispatcherOptions {
  db: DatabaseSync
  workspaceRoot: string
  agentDir?: string
  workerMode: AgentMode
  /** real 模式下 settings 键 worker.model 的值（"provider/model"），缺省第一个可用 */
  workerModel?: string
  workerStreamDelayMs?: number
  /** Worker 模型回合预算，缺省 runWorker 的 12 */
  workerMaxTurns?: number
  onTaskEvent: (event: ChatTaskEvent) => void
  onNotice: (event: ChatNoticeEvent) => void
  /** 任务执行活动预览（seq 由本层逐任务赋值，单调递增不密集）；缺省不订阅 */
  onActivity?: (event: ChatTaskActivityEvent) => void
  /** 子代理步骤（seq 由本层逐任务赋值，单调递增不密集）；缺省不订阅 */
  onSubagentStep?: (event: ChatSubagentStepEvent) => void
}

export interface TaskDispatcher {
  /** 同步落账（queued）并异步启动 Worker，立即返回 taskId 给 dispatch_task 工具 */
  handleDispatch: (input: { title: string; prompt: string }) => { taskId: string }
  /** 叫停任务：taskId 缺省时取最近一个进行中的任务；等 Worker 完全停下后返回 */
  interrupt: (taskId?: string) => Promise<InterruptResult>
  /** Router 创建完成后挂接（任务结果要注回 Router 会话）；传 null 解除挂接 */
  attachRouter: (router: RouterLike | null) => void
}

export function createTaskDispatcher(options: TaskDispatcherOptions): TaskDispatcher {
  ensureTasksTable(options.db)
  let router: RouterLike | null = null
  const finalized = new Set<string>()
  // 进行中的 Worker：叫停句柄（AbortController）+ 完成承诺（interrupt 要等 Worker 完全停下）
  const workers = new Map<string, { controller: AbortController; done: Promise<void> }>()

  function finalize(taskId: string, title: string, status: 'done' | 'failed' | 'aborted', report?: string): void {
    if (finalized.has(taskId)) return
    finalized.add(taskId)
    updateTask(options.db, taskId, {
      status,
      ...(report !== undefined ? { report } : {}),
      finishedAt: new Date().toISOString()
    })
    options.onTaskEvent({ taskId, title, status, ...(report !== undefined ? { report } : {}) })
    // aborted 不注回 Router（Worker 不再有任何产出或汇报）；done/failed 汇报统一注入 Router 的攒批通道
    //（速查表第 4 节）：空闲直接 prompt，忙碌/压缩期间进入 RouterLoop 缓冲，agent_settled 后合并为一次注入
    //（T3 遗留的 followUp FIFO 顺序假设已删除——缓冲顺序即注入顺序）
    if (status === 'done' || status === 'failed') {
      const target = router
      if (target) {
        const text = `${TASK_REPORT_PREFIX} 任务「${title}」${status === 'done' ? '已完成' : '已失败'}：${report}`
        void target.send(text).catch((err) => {
          options.onNotice({ kind: 'router-error', message: `任务结果注入失败：${errorMessageOf(err)}` })
        })
      }
    }
  }

  function handleDispatch(input: { title: string; prompt: string }): { taskId: string } {
    const taskId = randomUUID()
    insertTask(options.db, { id: taskId, title: input.title, status: 'queued', createdAt: new Date().toISOString() })
    const controller = new AbortController()
    // seq 逐任务赋值：每任务单调递增（不密集），并行 Worker 各自独立计数
    const onActivity = options.onActivity
    let activitySeq = 0
    const onSubagentStep = options.onSubagentStep
    let subagentSeq = 0
    const done = (async () => {
      try {
        const outcome = await runWorker({
          taskId,
          prompt: input.prompt,
          mode: options.workerMode,
          agentDir: options.agentDir,
          workspaceRoot: options.workspaceRoot,
          // 会话落盘 agentDir/workers/<taskId>/（fake 模式也落盘：会话文件小，排查有价值）
          sessionDir: options.agentDir ? join(options.agentDir, 'workers', taskId) : undefined,
          realModelId: options.workerModel,
          streamDelayMs: options.workerStreamDelayMs,
          maxTurns: options.workerMaxTurns,
          signal: controller.signal,
          onNotice: options.onNotice,
          onActivity: onActivity
            ? (activity) => {
                activitySeq += 1
                onActivity({ taskId, seq: activitySeq, kind: activity.kind, label: activity.label })
              }
            : undefined,
          onStep: onSubagentStep
            ? (step) => {
                subagentSeq += 1
                onSubagentStep({ taskId, seq: subagentSeq, ...step })
              }
            : undefined,
          onStart: () => {
            // 叫停可能先于 Worker 启动到达：已终态的任务不再翻回 running
            if (finalized.has(taskId)) return
            updateTask(options.db, taskId, { status: 'running' })
            options.onTaskEvent({ taskId, title: input.title, status: 'running' })
          }
        })
        finalize(taskId, input.title, outcome.status, outcome.status === 'aborted' ? undefined : outcome.report)
      } catch (err) {
        finalize(taskId, input.title, 'failed', `任务执行异常：${errorMessageOf(err)}`)
      } finally {
        workers.delete(taskId)
      }
    })()
    workers.set(taskId, { controller, done })
    return { taskId }
  }

  async function interrupt(taskId?: string): Promise<InterruptResult> {
    let row = taskId !== undefined ? getTask(options.db, taskId) : undefined
    if (!row && taskId === undefined) {
      const active = listTasks(options.db).filter((t) => t.status === 'queued' || t.status === 'running')
      row = active.at(-1)
    }
    if (!row) {
      return {
        ok: false,
        message: taskId !== undefined ? `任务不存在：${taskId}` : '当前没有进行中的任务'
      }
    }
    if (row.status !== 'queued' && row.status !== 'running') {
      return { ok: false, message: `任务「${row.title}」已结束（${row.status}），无法中止` }
    }
    const entry = workers.get(row.id)
    if (entry) {
      entry.controller.abort()
      await entry.done // 等 Worker 完全停下（含落账），再向 Router 确认
    } else {
      // 无 Worker 可叫停（如上一进程遗留的任务，恢复属票 06）：直接落账
      finalize(row.id, row.title, 'aborted')
    }
    return { ok: true, message: `任务「${row.title}」已中止` }
  }

  return {
    handleDispatch,
    interrupt,
    attachRouter: (target) => {
      router = target
    }
  }
}
