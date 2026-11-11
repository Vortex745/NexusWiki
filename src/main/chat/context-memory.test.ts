import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatChunkEvent } from '../../shared/protocol.ts'
import { createRouter, type Router } from './router.ts'

// 引入 pi 上下文管理与记忆策略的验收测试：
// - 记忆（B1）：agentDir/cwd 的 AGENTS.md 上下文文件注入 Router 系统提示词
// - 上下文管理（A2）：fake 模式长对话（usage 按 chars/4 造数）真实触发 pi 自动压缩并透传事件

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

interface CompactionEvent {
  phase: 'start' | 'end'
  tokensBefore?: number
  error?: string
}

interface Harness {
  router: Router
  chunks: ChatChunkEvent[]
  compactions: CompactionEvent[]
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

async function makeFakeRouter(agentDir: string, cwd: string): Promise<Harness> {
  const chunks: ChatChunkEvent[] = []
  const compactions: CompactionEvent[] = []
  const router = await createRouter({
    mode: 'fake',
    cwd,
    agentDir,
    onChunk: (event) => chunks.push(event),
    onNotice: () => {},
    // 契约：RouterOptions.onCompaction 透传 pi 的 compaction_start/end
    onCompaction: (event) => compactions.push(event)
  })
  return { router, chunks, compactions }
}

test('agentDir 与 cwd 的 AGENTS.md 记忆注入 Router 系统提示词', async () => {
  const agentDir = makeTempDir('t-mem-agent-')
  const cwd = makeTempDir('t-mem-cwd-')
  try {
    writeFileSync(join(agentDir, 'AGENTS.md'), '全局记忆标记-MEM-GLOBAL', 'utf8')
    writeFileSync(join(cwd, 'AGENTS.md'), '应用记忆标记-MEM-CWD', 'utf8')
    const { router } = await makeFakeRouter(agentDir, cwd)
    const prompt = router.getSystemPrompt()
    assert.ok(prompt.includes('全局记忆标记-MEM-GLOBAL'), 'agentDir AGENTS.md must reach system prompt')
    assert.ok(prompt.includes('应用记忆标记-MEM-CWD'), 'cwd AGENTS.md must reach system prompt')
    router.dispose()
  } finally {
    cleanup(agentDir, cwd)
  }
})

test('没有 AGENTS.md 时系统提示词与原行为一致', async () => {
  const agentDir = makeTempDir('t-mem-empty-agent-')
  const cwd = makeTempDir('t-mem-empty-cwd-')
  try {
    const { router } = await makeFakeRouter(agentDir, cwd)
    assert.ok(router.getSystemPrompt().includes('Router'), 'base prompt unchanged without context files')
    router.dispose()
  } finally {
    cleanup(agentDir, cwd)
  }
})

test('fake 模式长对话触发 pi 自动压缩并透传事件', async () => {
  const agentDir = makeTempDir('t-compact-agent-')
  const cwd = makeTempDir('t-compact-cwd-')
  try {
    const { router, chunks, compactions } = await makeFakeRouter(agentDir, cwd)
    // 阈值 = 128000(contextWindow) - 16384(reserve 默认) = 111616 tokens ≈ 446K chars。
    // fake usage 按 chars/4 造数：6 轮 × 60K 字符（用户 + "OK: 回显"）累计约 180K tokens，第 5 轮起必过阈值
    const big = '标记-1-'.padEnd(60000, 'x')
    for (let i = 0; i < 6; i++) {
      const id = await router.send(i === 0 ? big : `第${i}轮：${big.slice(0, 60000)}`)
      await untilDone(chunks, id)
    }
    assert.ok(
      compactions.some((e) => e.phase === 'start'),
      `compaction_start must fire for oversized fake context, got: ${JSON.stringify(compactions)}`
    )
    const end = compactions.find((e) => e.phase === 'end' && !e.error)
    assert.ok(end, `compaction_end without error must fire, got: ${JSON.stringify(compactions)}`)
    assert.ok((end!.tokensBefore ?? 0) > 111616, `tokensBefore reflects oversized context, got: ${String(end!.tokensBefore)}`)
    // 压缩后收尾：短消息回复精确（无压缩摘要 delta 泄漏进用户消息的流式回复）
    const finalId = await router.send('压缩后的收尾消息')
    await untilDone(chunks, finalId)
    const finalReply = chunks.filter((c) => c.messageId === finalId).map((c) => c.delta).join('')
    assert.ok(finalReply.startsWith('OK: 压缩后的收尾消息'), `final reply intact, got: ${finalReply.slice(0, 120)}`)
    assert.ok(!finalReply.includes('标记-1-'), 'compaction summary stream must not leak into user reply chunks')
    // 压缩摘要条目进入恢复历史（T6 既有行为：compactionSummary 标注 summary）
    const summaryEntry = router.getHistory().find((m) => m.summary)
    assert.ok(summaryEntry, 'history must contain a compaction summary entry')
    router.dispose()
  } finally {
    cleanup(agentDir, cwd)
  }
})
