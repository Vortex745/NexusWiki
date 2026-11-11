import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { runWorker, WORKER_SUBAGENT_INTENT_MARKER, type WorkerSubagentStep } from './worker.ts'
import { loadSubagentDetail } from './subagent-detail.ts'
import { textOf } from '../chat/pi-shared.ts'

// T1 子代理冒烟（移到 Worker 侧）：fake Worker 意图发 subagent toolCall → 真 pi-subagents 扩展跑 delegate
// 子会话（共享 fake runtime）→ finalOutput 经 toolResult 回流 Worker 转录 → Worker echo 进 report_result。
// 无递归由「任务在预算内 done」证明：子会话任务注入带 "Task: " 前缀，startsWith 锚定不命中即正常收尾；
// 若自递归派发，subagent 工具永不返回，runWorker 不会 done。

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'worker-subagent-'))
}

test('runWorker 内子代理冒烟：真扩展跑 child，finalOutput 回流转录，无递归', async () => {
  const dir = makeTempDir()
  try {
    const agentDir = join(dir, 'agent')
    const workspaceRoot = join(dir, 'workspace')
    const sessionDir = join(agentDir, 'workers', 'subagent-task')
    const notices: Array<{ kind: string; message: string }> = []
    const steps: WorkerSubagentStep[] = []
    const outcome = await runWorker({
      taskId: 'subagent-task',
      prompt: WORKER_SUBAGENT_INTENT_MARKER,
      mode: 'fake',
      agentDir,
      workspaceRoot,
      sessionDir,
      onNotice: (event) => notices.push(event),
      onStep: (step) => steps.push(step)
    })
    assert.equal(outcome.status, 'done', `worker must finish (no recursion), report: ${outcome.report}`)
    assert.ok(outcome.report.includes('子代理完成'), `report echoes child output, got: ${outcome.report}`)
    assert.equal(
      notices.filter((n) => n.kind === 'extension-warning' && n.message.includes('pi-subagents')).length,
      0,
      `no subagent extension warnings, got: ${notices.map((n) => n.message).join('; ')}`
    )

    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
    assert.equal(files.length, 1, `exactly one session file, got: ${files.join('、')}`)
    const replay = SessionManager.open(join(sessionDir, files[0]!))
    const messages = replay.buildSessionProjection().messages as Array<{ role: string; content: unknown; toolName?: string }>
    // 恰好一次 subagent toolCall（无递归）与一条 subagent toolResult（真扩展执行 child 后回流）
    const subagentCalls = messages.filter(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((c) => (c as { type?: string }).type === 'toolCall' && (c as { name?: string }).name === 'subagent')
    )
    assert.equal(subagentCalls.length, 1, `exactly one subagent toolCall (no self-recursion), got: ${subagentCalls.length}`)
    const subagentResults = messages.filter((m) => m.role === 'toolResult' && m.toolName === 'subagent')
    assert.equal(subagentResults.length, 1, 'exactly one subagent toolResult flowed back')
    const childOutput = textOf(subagentResults[0]!)
    assert.ok(childOutput.length > 0, 'child finalOutput must flow back into the Worker transcript')
    assert.ok(outcome.report.includes(childOutput.trim()), `report carries the child finalOutput, got: ${outcome.report}`)

    const start = steps.find((step) => step.phase === 'start')
    const end = steps.find((step) => step.phase === 'end')
    assert.ok(start, `subagent start step expected, got ${JSON.stringify(steps)}`)
    assert.equal(start.agent, 'delegate')
    assert.ok(start.task?.includes(WORKER_SUBAGENT_INTENT_MARKER), `start carries the task, got ${start.task}`)
    assert.ok(end, `subagent end step expected, got ${JSON.stringify(steps)}`)
    assert.equal(end.isError, false)
    assert.ok(end.finalOutput && end.finalOutput.length > 0, 'end carries finalOutput')
    assert.ok(end.sessionFile?.endsWith('.jsonl'), `end carries the child session file, got ${end.sessionFile}`)
    assert.ok(existsSync(end.sessionFile!), 'child session file must exist after the run')

    const detail = loadSubagentDetail({ agentDir, taskId: 'subagent-task', callId: end.callId })
    assert.equal(detail.finalOutput, end.finalOutput, 'replay carries the same final output')
    assert.ok(
      detail.steps.some((step) => step.toolName === 'write'),
      `child tool steps expected, got ${JSON.stringify(detail.steps)}`
    )
    assert.ok(
      detail.steps.every((step) => (step.output?.length ?? 0) <= 4000),
      'replayed outputs stay bounded'
    )

    const unsafe = loadSubagentDetail({ agentDir, taskId: '../escape', callId: 'x' })
    assert.equal(unsafe.steps.length, 0, 'invalid task id must not read outside agentDir')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})