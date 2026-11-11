import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { MODEL_LLM, SILICONFLOW_BASE_URL } from './config.ts'
import { readRagApiKey } from './siliconflow.ts'

interface PiModelsFile {
  providers?: Record<string, unknown>
}

interface PiModelEntry {
  id?: unknown
  reasoning?: unknown
  compat?: unknown
  [key: string]: unknown
}

interface PiProviderEntry {
  models?: unknown
  [key: string]: unknown
}

// SiliconFlow 官方开思考要 enable_thinking + thinking_budget，而 SDK 对该域名默认发
// reasoning_effort。模型级 compat 可以覆盖 detectCompat 的结果（pi-ai/openai-completions.js
// 的 getCompat），因此这几行配置是「档位真的生效」的前提，不是可选调优。
// supportsDeveloperRole 必须为 false：pi 只在 reasoning 模型上才用 developer 角色，而 SiliconFlow
// 对 role=developer 直接回 400 code 20015（messages invalid），整条真实链路会一条回复都出不来。
const THINKING_COMPAT = {
  thinkingFormat: 'qwen',
  supportsReasoningEffort: false,
  thinkingTokenBudgetField: 'thinking_budget',
  supportsDeveloperRole: false
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 只补缺失字段：用户手写过的 reasoning / compat 是配置，升级不能覆盖。
// 返回 true 表示有字段变化，调用方据此决定是否重写文件（保持幂等）。
function upgradeThinkingSupport(provider: PiProviderEntry): boolean {
  if (!Array.isArray(provider.models)) return false
  let changed = false
  for (const raw of provider.models) {
    if (!isRecord(raw) || raw.id !== MODEL_LLM) continue
    const model = raw as PiModelEntry
    if (model.reasoning !== true) {
      model.reasoning = true
      changed = true
    }
    const compat = isRecord(model.compat) ? model.compat : {}
    if (!isRecord(model.compat)) {
      model.compat = compat
      changed = true
    }
    for (const [key, value] of Object.entries(THINKING_COMPAT)) {
      if (compat[key] === undefined) {
        compat[key] = value
        changed = true
      }
    }
  }
  return changed
}

// 把 SiliconFlow provider 预写进 agentDir/models.json 并兜底 router.model 设置项（无 electron 依赖，测试可用 :memory:）。
// 必须在首次 createAgentSession 之前跑：pi 读 models.json 只发生在建会话时
export function ensurePiProviderSeed(db: DatabaseSync, agentDir: string): void {
  const modelsPath = join(agentDir, 'models.json')
  const current = existsSync(modelsPath) ? readFileSync(modelsPath, 'utf8') : undefined
  let parsed: unknown
  try {
    parsed = current !== undefined ? JSON.parse(current) : {}
  } catch {
    // 解析失败的用户文件绝不覆盖（宁可这轮不 seed，也不能毁掉手写配置）
    return
  }
  // 非 JSON 对象（null/数组/标量）同样不写——没有可安全合并的形状
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const file = parsed as PiModelsFile

  if (!file.providers || typeof file.providers !== 'object' || Array.isArray(file.providers)) {
    file.providers = {}
  }
  if (!file.providers.siliconflow) {
    // api 字面量取自 pi-ai 的 KnownApi（OpenAI 兼容 completions 通道）；模型条目字段为 ProviderConfigSchema 允许的最小集
    file.providers.siliconflow = {
      name: 'SiliconFlow',
      baseUrl: SILICONFLOW_BASE_URL,
      apiKey: readRagApiKey(db),
      api: 'openai-completions',
      models: [{ id: MODEL_LLM, name: 'DeepSeek V4.1 Flash', contextWindow: 131072, maxTokens: 8192 }]
    }
  }
  // 已存在的 provider 也要升级：早期版本写入的模型条目没有 reasoning，SDK 会把所有档位 clamp 成 off。
  // 只对 siliconflow 生效，其他 provider 与手写字段一律保留。
  const siliconflow = file.providers.siliconflow
  if (isRecord(siliconflow)) upgradeThinkingSupport(siliconflow as PiProviderEntry)

  const serialized = JSON.stringify(file, null, 2)
  if (serialized !== current) {
    // 全新 --user-data-dir 首启时 agentDir 不存在，先建目录（SessionManager.create 也会建，但 seed 先于它跑）
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(modelsPath, serialized, 'utf8')
  }

  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('router.model') as { value: string } | undefined
  if (!row) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('router.model', `siliconflow/${MODEL_LLM}`)
  }
}
