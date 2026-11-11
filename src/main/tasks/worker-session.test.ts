import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { runWorker } from './worker.ts'
import { textOf } from '../chat/pi-shared.ts'

// Worker 会话持久化（引入 pi 记忆策略补齐）：sessionDir 提供时会话 JSONL 落盘、可回放；
// 缺省保持 inMemory（fake 测试零副作用路径不变）。sessionDir 由 runWorker 自建，调用方无需预创建。

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'worker-session-'))
}

test('runWorker 按会话目录落盘并可经 SessionManager.open 回放', async () => {
  const dir = makeTempDir()
  try {
    const workspaceRoot = join(dir, 'workspace')
    const sessionDir = join(dir, 'agent', 'workers', 'persist-task')
    const outcome = await runWorker({
      taskId: 'persist-task',
      prompt: '写一个 persist.js',
      mode: 'fake',
      workspaceRoot,
      sessionDir
    })
    assert.equal(outcome.status, 'done')

    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
    assert.equal(files.length, 1, `exactly one session file expected, got: ${files.join('、')}`)
    const replay = SessionManager.open(join(sessionDir, files[0]!))
    const messages = replay.buildSessionProjection().messages
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => textOf(m as { role: string; content: unknown }))
    assert.ok(userTexts.some((t) => t.includes('写一个 persist.js')), 'user prompt persisted')
    assert.ok(
      messages.some((m) => m.role === 'assistant' && textOf(m as { role: string; content: unknown }).includes('任务完成')),
      'assistant closing text persisted'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorker 缺省 sessionDir 保持会话不落盘', async () => {
  const dir = makeTempDir()
  try {
    const workspaceRoot = join(dir, 'workspace')
    const outcome = await runWorker({
      taskId: 'memory-task',
      prompt: '写一个 memory.js',
      mode: 'fake',
      workspaceRoot
    })
    assert.equal(outcome.status, 'done')
    // workspace 下只有任务目录，不存在会话文件
    const taskDir = join(workspaceRoot, 'memory-task')
    const leftovers = readdirSync(taskDir).filter((f) => f.endsWith('.jsonl'))
    assert.deepEqual(leftovers, [], 'no session file inside task dir by default')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
