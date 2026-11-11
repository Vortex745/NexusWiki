import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  hasNewContent,
  readMemoryForContext,
  readMemoryMeta,
  runConsolidation,
  type MemoryChatClient
} from './consolidator.ts'
import { USER_ENVELOPE_MARKER } from '../chat/pi-shared.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function newAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-test-'))
  dirs.push(dir)
  return dir
}

// 计数假客户端：记录调用次数与收到的全部 prompt 内容，固定返回 text
function fakeClient(text: string): {
  client: MemoryChatClient
  calls: () => number
  prompts: () => string[]
} {
  const seen: string[] = []
  return {
    client: {
      async chatComplete(req) {
        seen.push(req.messages.map((m) => m.content).join('\n'))
        return text
      }
    },
    calls: () => seen.length,
    prompts: () => seen
  }
}

// 写一条 pi 会话 jsonl 消息条目
function messageLine(id: string, role: 'user' | 'assistant', content: unknown): string {
  return `${JSON.stringify({ type: 'message', id, parentId: null, timestamp: new Date().toISOString(), message: { role, content } })}\n`
}

describe('runConsolidation', () => {
  it('无会话文件：no-change，不调用模型', async () => {
    const dir = newAgentDir()
    const fake = fakeClient('# 记忆')
    const result = await runConsolidation({ agentDir: dir, client: fake.client, model: 'test-model' })
    assert.equal(result.kind, 'no-change')
    assert.equal(result.content, '')
    assert.equal(fake.calls(), 0)
  })

  it('hasNewContent：无文件 false，写入会话后 true', () => {
    const dir = newAgentDir()
    assert.equal(hasNewContent(dir), false)
    writeFileSync(join(dir, 's1.jsonl'), messageLine('a', 'user', '你好'))
    assert.equal(hasNewContent(dir), true)
  })

  it('有新增：调一次模型，写入 MEMORY.md 与 meta，prompt 带角色标注与既有记忆', async () => {
    const dir = newAgentDir()
    writeFileSync(
      join(dir, 's1.jsonl'),
      messageLine('a', 'user', '你好') + messageLine('b', 'assistant', [{ type: 'text', text: '回复' }])
    )
    const fake = fakeClient('# 用户画像\n- 测试用户')
    const result = await runConsolidation({ agentDir: dir, client: fake.client, model: 'test-model' })
    assert.equal(result.kind, 'ok')
    assert.equal(result.content, '# 用户画像\n- 测试用户')
    assert.equal(fake.calls(), 1)
    assert.ok(fake.prompts()[0].includes('用户：你好'))
    assert.ok(fake.prompts()[0].includes('助手：回复'))
    assert.ok(fake.prompts()[0].includes('既有记忆'))
    const memory = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.equal(memory, '# 用户画像\n- 测试用户')
    const meta = readMemoryMeta(dir)
    assert.ok(meta.updatedAt)
    assert.equal(meta.offsets['s1.jsonl'], statSync(join(dir, 's1.jsonl')).size)
  })

  it('增量续读：第二次整理只带新增尾部，不带首段', async () => {
    const dir = newAgentDir()
    writeFileSync(join(dir, 's1.jsonl'), messageLine('a', 'user', '首段标记'))
    await runConsolidation({ agentDir: dir, client: fakeClient('# 记忆 v1').client, model: 'test-model' })
    // 续读边界由字节偏移保证，与 mtime 无关
    appendFileSync(join(dir, 's1.jsonl'), messageLine('b', 'user', '新增标记'))
    const fake = fakeClient('# 记忆 v2')
    await runConsolidation({ agentDir: dir, client: fake.client, model: 'test-model' })
    assert.ok(fake.prompts()[0].includes('新增标记'))
    assert.ok(!fake.prompts()[0].includes('首段标记'))
    assert.ok(fake.prompts()[0].includes('# 记忆 v1'))
  })

  it('过滤内部协议前缀与非 user/assistant 条目', async () => {
    const dir = newAgentDir()
    const toolResultLine = `${JSON.stringify({ type: 'message', id: 'x', parentId: null, timestamp: '', message: { role: 'toolResult', content: '工具输出' } })}\n`
    writeFileSync(
      join(dir, 's1.jsonl'),
      messageLine('a', 'user', `${USER_ENVELOPE_MARKER}\n主进程合并注入，不是用户说的话`) +
        toolResultLine +
        messageLine('b', 'user', '真话')
    )
    const fake = fakeClient('# 记忆')
    await runConsolidation({ agentDir: dir, client: fake.client, model: 'test-model' })
    assert.ok(fake.prompts()[0].includes('用户：真话'))
    assert.ok(!fake.prompts()[0].includes('主进程合并注入'))
    assert.ok(!fake.prompts()[0].includes('工具输出'))
  })

  it('模型失败：MEMORY.md 与 meta 不动，错误传播', async () => {
    const dir = newAgentDir()
    writeFileSync(join(dir, 's1.jsonl'), messageLine('a', 'user', '你好'))
    const failing: MemoryChatClient = {
      async chatComplete() {
        throw new Error('429 TPM limit')
      }
    }
    await assert.rejects(runConsolidation({ agentDir: dir, client: failing, model: 'test-model' }), /429/)
    assert.ok(!existsSync(join(dir, 'MEMORY.md')))
    assert.equal(readMemoryMeta(dir).updatedAt, null)
    assert.equal(hasNewContent(dir), true)
  })

  it('单文件尾部预算：只保留末尾 12000 字符', async () => {
    const dir = newAgentDir()
    const head = '头'.repeat(9000)
    const tail = '尾'.repeat(13000)
    writeFileSync(join(dir, 's1.jsonl'), messageLine('a', 'user', head + tail))
    const fake = fakeClient('# 记忆')
    await runConsolidation({ agentDir: dir, client: fake.client, model: 'test-model' })
    assert.ok(fake.prompts()[0].includes('尾'.repeat(100)))
    assert.ok(!fake.prompts()[0].includes('头'.repeat(100)))
  })

  it('MEMORY.md 被删：偏移归零全量重读', async () => {
    const dir = newAgentDir()
    writeFileSync(join(dir, 's1.jsonl'), messageLine('a', 'user', '首段标记'))
    await runConsolidation({ agentDir: dir, client: fakeClient('# 记忆 v1').client, model: 'test-model' })
    assert.equal(hasNewContent(dir), false)
    rmSync(join(dir, 'MEMORY.md'))
    assert.equal(hasNewContent(dir), true)
    const fake = fakeClient('# 重建')
    await runConsolidation({ agentDir: dir, client: fake.client, model: 'test-model' })
    assert.ok(fake.prompts()[0].includes('首段标记'))
  })
})

describe('readMemoryForContext', () => {
  it('缺失或空白返回 undefined，超 200 行截断', () => {
    const dir = newAgentDir()
    assert.equal(readMemoryForContext(dir), undefined)
    writeFileSync(join(dir, 'MEMORY.md'), '   \n  ')
    assert.equal(readMemoryForContext(dir), undefined)
    const lines = Array.from({ length: 250 }, (_, i) => `- 条目 ${i}`)
    writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n'))
    const context = readMemoryForContext(dir)
    assert.ok(context)
    assert.equal(context.content.split('\n').length, 200)
    assert.ok(context.path.endsWith('MEMORY.md'))
  })
})
