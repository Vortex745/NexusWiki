import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ChatCompleteRequest } from '../rag/siliconflow.ts'
import { USER_ENVELOPE_MARKER, textOf } from '../chat/pi-shared.ts'

// 长期记忆整理器（无 electron 依赖，node --test 直跑）：
// 启动/手动触发时扫描 pi 会话 jsonl 增量 → 一次 chatComplete 浓缩 → 原子写 MEMORY.md。
// 记忆边界按 Anthropic《Components of Agent Memory》：只记"不重新推导就无法恢复"的信息
// （用户画像、偏好、决定、教训），不记当前会话能随时重新读出的临时状态与流水账。

export interface MemoryChatClient {
  chatComplete(req: ChatCompleteRequest): Promise<string>
}

// 续读账本：offsets 记每个会话 jsonl 已读到的字节，updatedAt 是上次整理成功时间
export interface MemoryMeta {
  offsets: Record<string, number>
  updatedAt: string | null
}

export interface ConsolidationResult {
  kind: 'ok' | 'no-change'
  content: string
  updatedAt: string | null
}

export const MEMORY_FILE_NAME = 'MEMORY.md'
const MEMORY_META_NAME = 'memory.meta.json'
// 摘录预算：单文件取尾部，总量超限丢最旧会话（最新会话的信息价值最高）
const PER_FILE_CHARS = 12000
const TOTAL_CHARS = 48000
// 注入预算（Claude Code 同款）：MEMORY.md 只取前 200 行 / 25KB 进系统上下文
const CONTEXT_MAX_LINES = 200
const CONTEXT_MAX_CHARS = 25 * 1024
const MEMORY_MAX_RESPONSE_CHARS = 65536

// 主进程注入的内部协议用户消息（合并信封）不是用户说的话，不进记忆摘录
const INTERNAL_USER_PREFIXES = [USER_ENVELOPE_MARKER]

export function readMemoryMeta(agentDir: string): MemoryMeta {
  const file = join(agentDir, MEMORY_META_NAME)
  if (!existsSync(file)) return { offsets: {}, updatedAt: null }
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')) as Partial<MemoryMeta>
    // 坏 meta 回落全量重读（安全方向：只多读，不漏读）；偏移值逐个校验，坏值当没读过
    const offsets: Record<string, number> = {}
    if (typeof meta.offsets === 'object' && meta.offsets !== null) {
      for (const [name, value] of Object.entries(meta.offsets)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) offsets[name] = value
      }
    }
    return { offsets, updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : null }
  } catch {
    return { offsets: {}, updatedAt: null }
  }
}

// 会话快照：agentDir 下每个 jsonl 的字节大小（启动判断零成本，只做 fs.stat）
export function snapshotSessions(agentDir: string): Record<string, number> {
  if (!existsSync(agentDir)) return {}
  const snapshot: Record<string, number> = {}
  for (const name of readdirSync(agentDir)) {
    if (!name.endsWith('.jsonl')) continue
    const target = join(agentDir, name)
    const stat = statSync(target)
    if (stat.isFile()) snapshot[name] = stat.size
  }
  return snapshot
}

// 按快照与账本算待读区间；文件变小（被重建）偏移归零全量重读。null = 无新增
function pendingReads(
  snapshot: Record<string, number>,
  meta: MemoryMeta
): Record<string, { from: number; to: number }> | null {
  const reads: Record<string, { from: number; to: number }> = {}
  for (const [name, size] of Object.entries(snapshot)) {
    const prev = meta.offsets[name] ?? 0
    const from = size < prev ? 0 : prev
    if (size > from) reads[name] = { from, to: size }
  }
  return Object.keys(reads).length > 0 ? reads : null
}

// 有效账本：MEMORY.md 缺失（被删）时偏移归零——旧内容必须能全量重读回来。
// 判断与续读共用这一个口径，hasNewContent 与 runConsolidation 不会各说各话
function effectiveMeta(agentDir: string): MemoryMeta {
  const meta = readMemoryMeta(agentDir)
  if (readMemoryFileText(agentDir) === '' && Object.keys(meta.offsets).length > 0) {
    return { offsets: {}, updatedAt: null }
  }
  return meta
}

export function hasNewContent(agentDir: string): boolean {
  return pendingReads(snapshotSessions(agentDir), effectiveMeta(agentDir)) !== null
}

function readMemoryFileText(agentDir: string): string {
  const file = join(agentDir, MEMORY_FILE_NAME)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

// 整理提示词：结构固定四节，总量压在 150 行内（注入层要进每次会话的上下文，必须小）
const CONSOLIDATION_SYSTEM_PROMPT = `你是长期记忆整理器。输入是既有记忆与本轮新增对话摘录，输出更新后的完整 MEMORY.md（markdown）。
只记录不重新推导就无法恢复的信息：用户画像与偏好、明确决定、进行中的项目与目标、被纠正的错误与验证过的教训。
不要记录：当前会话随时能重新读出的临时状态、任务中间产物、文件内容流水账。
结构固定四节：## 用户画像 / ## 偏好 / ## 项目与决策 / ## 经验教训，每条一行，尽量短。
新信息与旧条目冲突时以新信息为准，删掉被推翻的条目；每条规则尽量带上如何验证或踩过的坑。
总长度不超过 150 行。没有新增信息时原样返回既有记忆。直接输出 markdown，不要解释。`

function buildMessages(prior: string, transcript: string): ChatCompleteRequest['messages'] {
  return [
    { role: 'system', content: CONSOLIDATION_SYSTEM_PROMPT },
    { role: 'user', content: `# 既有记忆\n${prior || '（尚无记忆）'}\n\n# 新对话摘录\n${transcript}` }
  ]
}

// jsonl 行 → "用户：…/助手：…" 摘录。防御式解析：坏行（半行/格式升级）跳过不炸
function extractTranscriptText(raw: string): string {
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: { type?: string; message?: { role?: string; content?: unknown } }
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (entry?.type !== 'message') continue
    const { role, content } = entry.message ?? {}
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf({ role, content }).trim()
    if (!text) continue
    if (role === 'user' && INTERNAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) continue
    lines.push(`${role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines.join('\n')
}

// 按待读区间提取摘录：最新会话优先保留，总量超限丢最旧；
// 被丢弃的会话偏移照样前进（旧流水账按设计不回头补读）
function extractNewContent(agentDir: string, reads: Record<string, { from: number; to: number }>): string {
  const parts: Array<{ mtime: number; text: string }> = []
  for (const [name, range] of Object.entries(reads)) {
    const text = extractTranscriptText(readRange(join(agentDir, name), range.from, range.to))
    parts.push({ mtime: statSync(join(agentDir, name)).mtimeMs, text })
  }
  parts.sort((a, b) => b.mtime - a.mtime)
  const kept: string[] = []
  let total = 0
  for (const part of parts) {
    const text = part.text.length > PER_FILE_CHARS ? part.text.slice(-PER_FILE_CHARS) : part.text
    if (total + text.length > TOTAL_CHARS) break
    kept.push(text)
    total += text.length
  }
  return kept.filter((text) => text.length > 0).join('\n')
}

function writeAtomically(target: string, text: string): void {
  mkdirSync(join(target, '..'), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, target)
}

export async function runConsolidation(options: {
  agentDir: string
  client: MemoryChatClient
  model: string
}): Promise<ConsolidationResult> {
  const { agentDir, client, model } = options
  const meta = effectiveMeta(agentDir)
  const prior = readMemoryFileText(agentDir)
  const snapshot = snapshotSessions(agentDir)
  const reads = pendingReads(snapshot, meta)
  if (reads === null) return { kind: 'no-change', content: prior, updatedAt: meta.updatedAt }
  const transcript = extractNewContent(agentDir, reads)
  // 落账偏移：读过的推进到 EOF，孤儿条目（会话文件已删）清除，未读的保留
  const offsets: Record<string, number> = {}
  for (const name of Object.keys(snapshot)) {
    const end = reads[name]?.to ?? meta.offsets[name]
    if (end !== undefined) offsets[name] = end
  }
  if (transcript === '') {
    writeAtomically(join(agentDir, MEMORY_META_NAME), JSON.stringify({ offsets, updatedAt: meta.updatedAt }))
    return { kind: 'no-change', content: prior, updatedAt: meta.updatedAt }
  }
  const reply = (await client.chatComplete({ model, messages: buildMessages(prior, transcript) })).trim()
  if (reply.length === 0 || reply.length > MEMORY_MAX_RESPONSE_CHARS) {
    throw new Error(`整理结果非法：长度 ${reply.length}`)
  }
  const updatedAt = new Date().toISOString()
  writeAtomically(join(agentDir, MEMORY_FILE_NAME), reply)
  writeAtomically(join(agentDir, MEMORY_META_NAME), JSON.stringify({ offsets, updatedAt }))
  return { kind: 'ok', content: reply, updatedAt }
}

// 系统上下文注入用：MEMORY.md 前 200 行 / 25KB（注入层错误会传播到每个会话，必须小）
export function readMemoryForContext(agentDir: string): { path: string; content: string } | undefined {
  const file = join(agentDir, MEMORY_FILE_NAME)
  if (!existsSync(file)) return undefined
  const raw = readFileSync(file, 'utf8')
  if (raw.trim().length === 0) return undefined
  const content = raw.split('\n').slice(0, CONTEXT_MAX_LINES).join('\n').slice(0, CONTEXT_MAX_CHARS)
  return { path: file, content }
}

// fake 整理客户端：SUPER_AGENT_MODE=fake 的离线验收走这条，延迟给 UI 留出可观测的整理中窗口
export function createFakeMemoryClient(delayMs: number, text?: string): MemoryChatClient {
  const reply = text ?? [
    '## 用户画像',
    '- 测试用户，使用 Super Agent 桌面端',
    '## 偏好',
    '- 偏好中文交流',
    '## 项目与决策',
    '- 长期记忆功能离线验收中',
    '## 经验教训',
    '- fake 模式不发起真实网络调用'
  ].join('\n')
  return {
    async chatComplete() {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return reply
    }
  }
}

// 读 [from, to) 字节区间（jsonl 只追加，偏移恒落在完整行边界）
function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, 'r')
  try {
    const length = to - from
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, from)
    return buffer.toString('utf8', 0, read)
  } finally {
    closeSync(fd)
  }
}
