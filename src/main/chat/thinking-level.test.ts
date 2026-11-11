import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePiProviderSeed } from '../rag/pi-seed.ts'
import {
  parseThinkingTier,
  SDK_LEVEL_BY_TIER,
  THINKING_TIERS,
  tierForLegacyLevel,
  tierForSdkLevel
} from '../../shared/protocol.ts'
import { toHistoryMessages } from './pi-shared.ts'

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function setupAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 'thinking-level-'))
}

function readModels(agentDir: string): {
  providers: Record<string, { models: Array<Record<string, unknown>>; [k: string]: unknown }>
} {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))
}

// 已存在的 models.json 必须被升级：不写 reasoning 时 SDK 把任何档位 clamp 成 off，档位功能等于没做。
// 这是本任务最不确定的一步，单独用回归测试锁住。
test('existing siliconflow provider is upgraded with reasoning capability and SiliconFlow compat', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  const legacy = {
    providers: {
      siliconflow: {
        name: 'SiliconFlow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'sk-legacy',
        api: 'openai-completions',
        models: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash', contextWindow: 131072, maxTokens: 8192 }]
      }
    }
  }
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(legacy, null, 2))

  ensurePiProviderSeed(db, agentDir)

  const model = readModels(agentDir).providers.siliconflow!.models[0]!
  assert.equal(model.reasoning, true, 'existing model must gain reasoning:true')
  const compat = model.compat as Record<string, unknown> | undefined
  assert.equal(compat?.thinkingFormat, 'qwen', 'SiliconFlow needs enable_thinking, not reasoning_effort')
  assert.equal(compat?.supportsReasoningEffort, false, 'must not send reasoning_effort')
  assert.equal(compat?.thinkingTokenBudgetField, 'thinking_budget', 'must send the official budget field')
  // pi 只在 reasoning 模型上用 developer 角色，而 SiliconFlow 对它回 400 20015：这条一旦丢失真实链路全哑
  assert.equal(compat?.supportsDeveloperRole, false, 'must keep the instruction role as system')
  assert.equal(readModels(agentDir).providers.siliconflow!.apiKey, 'sk-legacy', 'existing key must not be overwritten')
})

// 手写的 reasoning/compat 是用户配置，升级只能补缺失字段，不能覆盖。
test('upgrade preserves user-authored reasoning fields and other providers', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  const custom = { name: 'Custom', baseUrl: 'https://example.com/v1', apiKey: 'k', models: [{ id: 'x' }] }
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          custom,
          siliconflow: {
            name: 'SiliconFlow',
            baseUrl: 'https://api.siliconflow.cn/v1',
            apiKey: 'sk-legacy',
            api: 'openai-completions',
            models: [
              {
                id: 'deepseek-ai/DeepSeek-V4.1-Flash',
                reasoning: true,
                compat: { thinkingFormat: 'deepseek' },
                contextWindow: 131072,
                maxTokens: 8192
              }
            ]
          }
        }
      },
      null,
      2
    )
  )

  ensurePiProviderSeed(db, agentDir)

  const parsed = readModels(agentDir)
  assert.deepEqual(parsed.providers.custom, custom, 'other providers stay untouched')
  const model = parsed.providers.siliconflow!.models[0]!
  assert.equal((model.compat as Record<string, unknown>).thinkingFormat, 'deepseek', 'user-authored compat wins')
})

test('upgrade is idempotent for an already-upgraded provider', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  ensurePiProviderSeed(db, agentDir)
  const first = readFileSync(join(agentDir, 'models.json'), 'utf8')
  ensurePiProviderSeed(db, agentDir)
  assert.equal(readFileSync(join(agentDir, 'models.json'), 'utf8'), first)
})

test('thinking tier parsing keeps product tiers and rejects unknown values', () => {
  assert.equal(parseThinkingTier('low'), 'low')
  assert.equal(parseThinkingTier('high'), 'high')
  assert.equal(parseThinkingTier('max'), 'max')
  assert.equal(parseThinkingTier(undefined), 'high', 'absent key defaults to high')
  assert.equal(parseThinkingTier('nonsense'), 'high', 'invalid stored value must not reach the SDK')
  assert.equal(parseThinkingTier(''), 'high')
})

// 旧键 thinking.level 存的是 SDK 档位；high 与新档位同名，迁移必须走独立函数，不能混进 parseThinkingTier
test('legacy SDK levels migrate by strength, old high lands on max', () => {
  assert.equal(tierForLegacyLevel('off'), 'low')
  assert.equal(tierForLegacyLevel('minimal'), 'low')
  assert.equal(tierForLegacyLevel('low'), 'low')
  assert.equal(tierForLegacyLevel('medium'), 'high')
  assert.equal(tierForLegacyLevel('high'), 'max')
  assert.equal(tierForLegacyLevel('xhigh'), 'max')
  assert.equal(tierForLegacyLevel('max'), 'max')
  assert.equal(tierForLegacyLevel(undefined), undefined, 'no legacy value means fall back to the default tier')
  assert.equal(tierForLegacyLevel('nonsense'), undefined)
})

test('SDK_LEVEL_BY_TIER maps three distinct levels and tierForSdkLevel inverts it', () => {
  const levels = THINKING_TIERS.map((tier) => SDK_LEVEL_BY_TIER[tier])
  assert.equal(new Set(levels).size, THINKING_TIERS.length, 'each tier owns its own SDK level')
  assert.equal(tierForSdkLevel('low'), 'low')
  assert.equal(tierForSdkLevel('medium'), 'high')
  assert.equal(tierForSdkLevel('high'), 'max')
})

// 历史恢复：pi 把 thinking 块留在 assistant.content 里，旧实现只取 text 块，重启后思考内容消失。
test('toHistoryMessages carries thinking blocks from assistant content', () => {
  const history = toHistoryMessages([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先比较两种做法' },
        { type: 'text', text: '结论' }
      ]
    }
  ])
  assert.equal(history.length, 1)
  assert.equal(history[0]!.content, '结论', 'answer text is unchanged')
  assert.equal(history[0]!.thinking, '先比较两种做法', 'thinking text must survive restart')
})
