import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  createEventBus,
  createExtensionRuntime,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type ExtensionContext,
  type LoadExtensionsResult,
  type LoadSkillsResult,
  type LoadedMcpConfig,
  type ProviderModelConfig,
  type ResourceLoader
} from '@earendil-works/pi-coding-agent'
import type { Api, AssistantMessage, JsonObject, Model } from '@earendil-works/pi-ai'
import { calculateCost, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AgentMode, ChatHistoryMessage } from '../../shared/protocol.ts'

// 模型模式唯一定义在协议层（shared/protocol.ts），此处转出给 main 侧各模块
export type { AgentMode }

// 任务汇报注入前缀：主进程把 Worker 结果作为该前缀的用户消息注入 Router 会话
export const TASK_REPORT_PREFIX = '[task-report]'
// 攒批信封标记：Router 忙碌期间到达的多条消息在 settled 后合并为一条信封注入，逐块贴标签分隔
export const USER_ENVELOPE_MARKER = '[USER]'
export const TASK_EVENT_ENVELOPE_MARKER = '[TASK_EVENT]'

// 内部协议用户消息前缀：这些消息是主进程注入的任务事件/合并信封，不是用户说的话，不进 UI 历史
const INTERNAL_USER_PREFIXES = [TASK_REPORT_PREFIX, USER_ENVELOPE_MARKER, TASK_EVENT_ENVELOPE_MARKER]

// Router 的 pi 嵌入辅助（与 examples/sdk/12-full-control.ts 相同的最小 ResourceLoader）：
// 不扫描 cwd / ~/.pi/agent 的扩展、技能；上下文文件（AGENTS.md/CLAUDE.md 记忆）由调用方显式传入。
// extensions/skills 可选注入（Router 的 MCP 扩展与 agentDir/skills 技能）；缺省空。
export function minimalResourceLoader(
  systemPrompt: string,
  agentsFiles: Array<{ path: string; content: string }> = [],
  extensions: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() },
  skills: LoadSkillsResult = { skills: [], diagnostics: [] }
): ResourceLoader {
  return {
    getExtensions: () => extensions,
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  }
}

// Worker 专用的最小 ResourceLoader：技能来自显式路径加载的结果，不扫描 cwd / ~/.pi/agent；
// extensions 可选注入（Worker 的 pi-subagents 扩展），缺省空
export function workerResourceLoader(
  systemPrompt: string,
  skills: LoadSkillsResult,
  agentsFiles: Array<{ path: string; content: string }> = [],
  extensions: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() }
): ResourceLoader {
  return { ...minimalResourceLoader(systemPrompt, agentsFiles, extensions), getSkills: () => skills }
}

// MCP 扩展工厂 → Extension 的内联加载。pi 的 loadExtensionFromFactory 未从包根导出（extensions barrel 有、
// 根 index 未转发，exports map 又拦深路径），改用导出面内的 DefaultResourceLoader 完成同一件事：
// 关闭全部发现路径，只加载传入的工厂（pi 内部同走 loadExtensionFromFactory），返回 extensions+共享 runtime。
// systemPrompt 传占位字符串阻止 discoverSystemPromptFile 扫盘；agentDir 用 cwd 顶替（所有发现已关，不会被碰到）
export async function loadAppExtensions(options: {
  cwd: string
  loadConfig: (ctx: ExtensionContext) => LoadedMcpConfig
  /** 额外扩展入口（绝对路径）：透传 pi 的 additionalExtensionPaths，noExtensions:true 下仍会加载 */
  extensionPaths?: string[]
}): Promise<LoadExtensionsResult> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.cwd,
    settingsManager: SettingsManager.inMemory(),
    // bus 只服务扩展间通信（pi.events），不外借；宿主侧订阅走 session.subscribe 的会话事件流
    eventBus: createEventBus(),
    extensionFactories: [createMcpExtension({ loadConfig: options.loadConfig })],
    additionalExtensionPaths: options.extensionPaths,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'unused'
  })
  await loader.reload()
  return loader.getExtensions()
}

// 工具调用的单行摘要（Router 工具事件与 Worker 活动预览共用）：name + 首参截 60 字符。
// arguments JSON 本体不上 UI；无参或首参序列化为空时只有 name
export function toolCallLabel(name: string, args: Record<string, unknown>): string {
  const first = Object.values(args)[0]
  if (first === undefined) return name
  const text = typeof first === 'string' ? first : (JSON.stringify(first) ?? '')
  return text.length > 0 ? `${name} ${text.slice(0, 60)}` : name
}

export const TOOL_TEXT_LIMIT = 4000
export const SUBAGENT_LINE_LIMIT = 300
export const SUBAGENT_RECENT_LINES = 20
export const SUBAGENT_STEP_LIMIT = 200

// 引导符 ESC(0x1b) 是匹配目标本身，no-control-regex 在这里没有可改的写法
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function boundText(text: string, limit: number): string {
  const clean = stripAnsi(text)
  const points = [...clean]
  if (points.length <= limit) return clean
  return `${points.slice(0, limit).join('')}\n…（已截断）`
}

export function toolResultText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => typeof item === 'object' && item !== null && (item as { type?: string }).type === 'text')
    .map((item) => (item as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

const TOOL_LABELS: Record<string, string> = {
  bash: '终端命令',
  write: '编辑文件',
  edit: '编辑文件',
  read: '读取文件',
  grep: '搜索文件',
  find: '搜索文件',
  ls: '搜索文件',
  dispatch_task: '派发任务',
  interrupt_task: '任务管理',
  task_status: '任务管理',
  search_knowledge: '知识检索',
  subagent: '子代理',
  report_result: '汇报结果'
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function toolDisplayInfo(
  name: string,
  args: Record<string, unknown> | undefined
): { label: string; input?: string } {
  const label = TOOL_LABELS[name] ?? (name.startsWith('mcp__') ? 'MCP 工具' : '工具')
  let raw: string | undefined
  if (name === 'bash') raw = stringField(args, 'command')
  else if (name === 'write' || name === 'edit' || name === 'read') raw = stringField(args, 'path')
  else if (name === 'grep') raw = stringField(args, 'pattern')
  else if (name === 'search_knowledge') raw = stringField(args, 'query')
  else if (name === 'dispatch_task') raw = stringField(args, 'title')
  else if (name === 'subagent') {
    raw = [stringField(args, 'agent'), stringField(args, 'task')].filter(Boolean).join('：') || undefined
  } else if (args && Object.keys(args).length > 0) raw = JSON.stringify(args)
  return raw ? { label, input: boundText(raw, TOOL_TEXT_LIMIT) } : { label }
}

export function textOf(message: { role: string; content: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => (c as { type: string }).type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('')
  }
  return ''
}

// 助手内容里的 thinking 块（pi 的 ThinkingContent）单独取出，供历史恢复渲染思考行。
// 只取文本，正文仍由 textOf 负责，两者绝不混排。
function thinkingOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((c) => (c as { type: string }).type === 'thinking')
    .map((c) => (c as { thinking?: string }).thinking ?? '')
    .join('')
  return text.length > 0 ? text : undefined
}

// 恢复会话的 AgentMessage[]（结构化取参，AgentMessage 类型未从包根导出）→ 渲染层历史。
// 只保留 user/assistant；压缩摘要（compactionSummary）与分支摘要（branchSummary）如实标注 summary，
// system/toolResult/纯工具调用（无文本）一律不进 UI；内部协议注入（任务汇报/合并信封前缀的 user 消息）不泄漏给用户。
export function toHistoryMessages(
  messages: ReadonlyArray<{ role: string; content?: unknown; summary?: string }>
): ChatHistoryMessage[] {
  const out: ChatHistoryMessage[] = []
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      const content = textOf(message as { role: string; content: unknown })
      const thinking = message.role === 'assistant' ? thinkingOf(message.content) : undefined
      // 只有思考块、没有正文的回合也要保留，否则重启后思考记录整行消失
      if (content.length === 0 && !thinking) continue
      if (message.role === 'user' && INTERNAL_USER_PREFIXES.some((prefix) => content.startsWith(prefix))) continue
      out.push({
        id: `history-${out.length}`,
        role: message.role,
        content,
        ...(thinking ? { thinking } : {})
      })
    } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
      if (!message.summary) continue
      out.push({ id: `history-${out.length}`, role: 'assistant', content: message.summary, summary: true })
    }
  }
  return out
}

export function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err ?? '未知错误')
}

export function fakeAssistantMessage(model: { api: string; provider: string; id: string }): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'pending',
    timestamp: Date.now()
  }
}

export function segmentReply(text: string, size = 4): string[] {
  const segments: string[] = []
  for (let i = 0; i < text.length; i += size) segments.push(text.slice(i, i + size))
  return segments
}

// 假模型确定性回合：文本回复或工具调用（Router/Worker 各自的脚本函数返回此结构）
// error 回合：以 LLM 流错误终结（stopReason=error + errorMessage），复刻真实 provider 的错误收尾语义
export type ScriptedTurn =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; name: string; arguments: Record<string, unknown> }
  | { kind: 'error'; errorMessage: string }

// registerProvider 的 models 条目：fake provider 只需 chat 模型的最少字段
export function fakeChatModelConfig(id: string, name: string, reasoning = false): ProviderModelConfig {
  return {
    type: 'chat',
    id,
    name,
    // reasoning=false 时 clampThinkingLevel 只返回 off，档位控件无法离线验收
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192
  }
}

// 假模型流驱动（pi 速查表第 6 节契约）：start → 可选延迟 → abort 协作终结 → toolcall/text 事件 → calculateCost → done。
// Router 与 Worker 的 streamSimple 只需算出各自 ScriptedTurn 交给它，事件序列与终结语义保证一致。
// usage 按 chars/4 造数（pi 自动压缩按 calculateContextTokens 优先取 native totalTokens 判阈值，全 0 永不触发）：
// input ≈ 请求上下文总字符/4（system + 全部消息文本，工具调用参数忽略），output ≈ 本回合回复/4（toolCall 用 arguments JSON）；
// 错误/中止回合不造数（pi 对零 usage 走估算路径）。cacheRead/cacheWrite 恒 0，cost 按 fake 模型费率（全 0）计算。
export function driveFakeAssistantStream(options: {
  model: Model<Api>
  getTurn: () => ScriptedTurn
  delayMs: number
  signal?: AbortSignal
  /** 非空时在该回合的正文前模拟一个 thinking 块，供离线验收思考链路 */
  thinkingText?: string
  context?: { systemPrompt?: string; messages: ReadonlyArray<{ role: string; content: unknown }> }
}): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream()
    void (async () => {
      const { model, delayMs, signal } = options
      const turn = options.getTurn()
      const message = fakeAssistantMessage(model)
      stream.push({ type: 'start', partial: message })
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      // 外部 abort 时必须终结流（推 error 事件且带 errorMessage），否则 run 永不结束、prompt() 永不 resolve
      if (signal?.aborted) {
        message.stopReason = 'aborted'
        message.errorMessage = '任务已中止'
        stream.push({ type: 'error', reason: 'aborted', error: message })
        return
      }
    // usage 按 chars/4 造数（input=上下文总字符含 systemPrompt，output=回复/4）：长对话真实触发 pi 自动压缩；
    // 错误与中止回合不造数（保持 0），对齐"调用没完成就没有 usage"
    if (turn.kind !== 'error') {
      const context = options.context
      const contextChars = context
        ? (context.systemPrompt?.length ?? 0) + context.messages.reduce((sum, m) => sum + textOf(m).length, 0)
        : 0
      const outputChars = turn.kind === 'toolCall' ? JSON.stringify(turn.arguments).length : turn.text.length
      message.usage.input = Math.ceil(contextChars / 4)
      message.usage.output = Math.ceil(outputChars / 4)
      message.usage.totalTokens = message.usage.input + message.usage.output
    }
    if (turn.kind === 'error') {
      message.stopReason = 'error'
      message.errorMessage = turn.errorMessage
      stream.push({ type: 'error', reason: 'error', error: message })
      return
    }
    // 思考块先于正文与工具调用，contentIndex 与真实 provider 一致（thinking=0，正文/工具调用=1）。
    // 事件形状对齐 pi-ai 的 AssistantMessageEvent，agent 层会原样转发。
    // delayMs>0 时逐 delta 步进，把同步爆发拉开成可观测的流式窗口（离线验收停流用）；
    // delayMs=0 保持原同步爆发（事件时序断言依赖它）。窗口内 abort 协作终结，语义同前置检查点。
    const pushSegments = async (
      eventType: 'thinking_delta' | 'text_delta',
      contentIndex: number,
      text: string
    ): Promise<boolean> => {
      for (const delta of segmentReply(text)) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          if (signal?.aborted) {
            message.stopReason = 'aborted'
            message.errorMessage = '任务已中止'
            stream.push({ type: 'error', reason: 'aborted', error: message })
            return false
          }
        }
        stream.push({ type: eventType, contentIndex, delta, partial: message })
      }
      return true
    }
    const thinkingText = options.thinkingText
    if (thinkingText) {
      message.content.push({ type: 'thinking', thinking: thinkingText, thinkingSignature: 'fake' })
      stream.push({ type: 'thinking_start', contentIndex: 0, partial: message })
      if (!(await pushSegments('thinking_delta', 0, thinkingText))) return
      stream.push({ type: 'thinking_end', contentIndex: 0, content: thinkingText, partial: message })
    }
    const bodyIndex = thinkingText ? 1 : 0
    if (turn.kind === 'toolCall') {
      // 工具调用写法（速查表第 6 节）：content push toolCall + toolcall_* 事件 + stopReason toolUse
      const toolCall = {
        type: 'toolCall' as const,
        id: randomUUID(),
        name: turn.name,
        // 脚本回合的参数已按 JSON 可序列化构造（含 string[]）；ToolCall 的类型收窄在此一次性断言
        arguments: turn.arguments as JsonObject
      }
      message.content.push(toolCall)
      stream.push({ type: 'toolcall_start', contentIndex: bodyIndex, partial: message })
      stream.push({ type: 'toolcall_delta', contentIndex: bodyIndex, delta: JSON.stringify(turn.arguments), partial: message })
      stream.push({ type: 'toolcall_end', contentIndex: bodyIndex, toolCall, partial: message })
      message.usage.cost = calculateCost(model, message.usage)
      message.stopReason = 'toolUse'
      stream.push({ type: 'done', reason: 'toolUse', message })
      return
    }
    message.content.push({ type: 'text', text: turn.text })
    stream.push({ type: 'text_start', contentIndex: bodyIndex, partial: message })
    if (!(await pushSegments('text_delta', bodyIndex, turn.text))) return
    stream.push({ type: 'text_end', contentIndex: bodyIndex, content: turn.text, partial: message })
    message.usage.cost = calculateCost(model, message.usage)
    message.stopReason = 'stop'
    stream.push({ type: 'done', reason: 'stop', message })
  })()
  return stream
}

// 已配置 = agentDir 下有 models.json，或 auth.json 非空。
// 注意 createAgentSession 会在 agentDir 里生成空的 auth.json/models-store.json，所以必须在创建前判断
export function hasModelConfig(agentDir: string): boolean {
  if (existsSync(join(agentDir, 'models.json'))) return true
  const authPath = join(agentDir, 'auth.json')
  if (!existsSync(authPath)) return false
  try {
    const auth: unknown = JSON.parse(readFileSync(authPath, 'utf8'))
    return typeof auth === 'object' && auth !== null && Object.keys(auth).length > 0
  } catch {
    return false
  }
}

// real 模式的显式模型运行时：只读 agentDir 下的 models.json/auth.json，不碰真实用户目录
export async function createRealModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: join(agentDir, 'models.json'),
    authPath: join(agentDir, 'auth.json'),
    refreshOnCreate: false
  })
}

// 按 "provider/model-id" 解析 real 模型；找不到返回 undefined（调用方回退到第一个可用模型）
export async function resolveRealModel(
  agentDir: string,
  modelId: string
): Promise<{ model: Model<Api>; modelRuntime: ModelRuntime } | undefined> {
  const modelRuntime = await createRealModelRuntime(agentDir)
  // 只切第一个 /：模型 id 本身带斜杠（siliconflow/deepseek-ai/DeepSeek-V4.1-Flash），
  // split('/', 2) 会把 id 截成 "deepseek-ai" 解析不到，再静默回退第一个模型
  const slash = modelId.indexOf('/')
  const model =
    slash > 0 ? modelRuntime.getModel(modelId.slice(0, slash), modelId.slice(slash + 1)) : undefined
  if (!model) return undefined
  return { model, modelRuntime }
}
