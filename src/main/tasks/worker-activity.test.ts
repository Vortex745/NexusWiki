import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runWorker } from './worker.ts'

// Worker 执行活动预览验收（.tmp/design-synthesis.md）：
// onActivity 产出有界单行预览（tool 标签 / text 尾部 ≤120 字符），seq 由 dispatcher 赋值（本层只断言产出与边界）。

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'worker-activity-'))
}

test('runWorker onActivity 产出有界活动预览', async () => {
  const dir = makeTempDir()
  try {
    const activities: Array<{ kind: 'tool' | 'text'; label: string }> = []
    const outcome = await runWorker({
      taskId: 'activity-task',
      prompt: '写一个 activity.js',
      mode: 'fake',
      workspaceRoot: join(dir, 'workspace'),
      onActivity: (activity) => activities.push(activity)
    })
    assert.equal(outcome.status, 'done')

    assert.ok(activities.length > 0, 'at least one activity event expected for a task that writes files')
    for (const activity of activities) {
      assert.ok(
        activity.kind === 'tool' || activity.kind === 'text',
        `kind must be tool|text, got: ${activity.kind}`
      )
      assert.ok(activity.label.length > 0, 'label must be non-empty (empty labels are not emitted)')
      assert.ok(activity.label.length <= 120, `label must stay bounded to 120 chars, got ${activity.label.length}`)
    }
    const toolLabels = activities.filter((a) => a.kind === 'tool').map((a) => a.label)
    assert.ok(
      toolLabels.some((label) => label.includes('write')),
      `tool activity expected for the fake script's write step, got: ${JSON.stringify(toolLabels)}`
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
