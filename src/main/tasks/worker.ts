import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  loadProjectContextFiles,
  loadSkills,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type LoadExtensionsResult,
  type LoadSkillsResult
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { ChatNoticeEvent, ChatSubagentProgress, ChatSubagentStepEvent } from '../../shared/protocol.ts'
import {
  asRecord,
  boundText,
  driveFakeAssistantStream,
  errorMessageOf,
  fakeChatModelConfig,
  hasModelConfig,
  loadAppExtensions,
  resolveRealModel,
  stringField,
  SUBAGENT_LINE_LIMIT,
  SUBAGENT_RECENT_LINES,
  textOf,
  TOOL_TEXT_LIMIT,
  toolCallLabel,
  workerResourceLoader,
  type AgentMode,
  type ScriptedTurn
} from '../chat/pi-shared.ts'
import { resolveSubagentExtension } from '../chat/subagent-extension.ts'
import { readMemoryForContext } from '../memory/consolidator.ts'

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>['session']

export interface WorkerOutcome {
  status: 'done' | 'failed' | 'aborted'
  report: string
}

export interface WorkerReport {
  status: 'ok' | 'failed'
  summary: string
  artifacts: string[]
}

// Worker 上报的子代理步骤：taskId 与 seq 由 dispatcher 逐任务赋值，Worker 只产业务字段
export type WorkerSubagentStep = Omit<ChatSubagentStepEvent, 'taskId' | 'seq'>

const SUBAGENT_STEP_INTERVAL_MS = 100

interface ToolExecutionEvent {
  type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
  toolCallId: string
  toolName: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  durationMs?: number
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function subagentProgressOf(raw: unknown): ChatSubagentProgress | undefined {
  const progress = asRecord(raw)
  if (!progress) return undefined
  const recentRaw = progress.recentOutput
  const recentOutput = Array.isArray(recentRaw)
    ? recentRaw
        .filter((line): line is string => typeof line === 'string')
        .slice(-SUBAGENT_RECENT_LINES)
        .map((line) => boundText(line, SUBAGENT_LINE_LIMIT))
    : []
  const argsRaw = progress.currentToolArgs
  const currentToolArgs =
    typeof argsRaw === 'string' ? argsRaw : argsRaw === undefined || argsRaw === null ? undefined : JSON.stringify(argsRaw)
  const currentTool = stringField(progress, 'currentTool')
  const status = stringField(progress, 'status')
  const toolCount = numberField(progress, 'toolCount')
  const tokens = numberField(progress, 'tokens')
  const turnCount = numberField(progress, 'turnCount')
  const mapped: ChatSubagentProgress = {
    ...(currentTool ? { currentTool } : {}),
    ...(currentToolArgs ? { currentToolArgs: boundText(currentToolArgs, SUBAGENT_LINE_LIMIT) } : {}),
    ...(recentOutput.length > 0 ? { recentOutput } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(status ? { status } : {})
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined
}

// 子代理工具结果/进度的载荷：details.results[0] 是终态结果，details.progress[0] 或 results[0].progress 是进度快照
function subagentDetailsOf(payload: unknown): {
  result: Record<string, unknown> | undefined
  progress: ChatSubagentProgress | undefined
} {
  const details = asRecord(asRecord(payload)?.details)
  const results = Array.isArray(details?.results) ? (details.results as unknown[]) : []
  const result = asRecord(results[0])
  const progressEntries = Array.isArray(details?.progress) ? (details.progress as unknown[]) : []
  return { result, progress: subagentProgressOf(progressEntries[0] ?? result?.progress) }
}

export interface RunWorkerOptions {
  taskId: string
  prompt: string
  mode: AgentMode
  agentDir?: string
  workspaceRoot: string
  /** 提供时会话 JSONL 落盘该目录（目录由 runWorker 自建）；缺省 inMemory 不落盘 */
  sessionDir?: string
  /** real 模式：settings 键 worker.model 的值（"provider/model"），缺省取第一个可用模型 */
  realModelId?: string
  streamDelayMs?: number
  /** 外部叫停信号：触发后立即 session.abort() 并等空闲，Worker 不再有产出 */
  signal?: AbortSignal
  /** Worker 会话创建成功、即将开始干活时回调（任务置 running） */
  onStart?: () => void
  /** 执行活动预览回调：tool=工具单行标签，text=当前输出尾部 ≤120 字符（整行替换，非转录）；缺省不订阅 */
  onActivity?: (activity: { kind: 'tool' | 'text'; label: string }) => void
  /** 子代理生命周期步骤（start/update/end），taskId/seq 由 dispatcher 赋值；缺省不订阅 */
  onStep?: (step: WorkerSubagentStep) => void
  /** 扩展加载/事件告警（pi-subagents 缺失或加载失败降级通知）；缺省不上报 */
  onNotice?: (event: ChatNoticeEvent) => void
  /** 模型回合预算，缺省 WORKER_MAX_TURNS */
  maxTurns?: number
}

export const WORKER_MAX_TURNS = 12

const WORKER_SYSTEM_PROMPT = [
  '你是独立 Worker，在任务目录内完成分派的任务。',
  '只读写任务目录内的文件；不要读取模型凭据、应用数据库或 Router 会话文件。',
  '先写一句计划（要做什么、怎么做），再调用工具；根据工具结果修改计划。',
  '改文件前先读取原文，改完后读回确认；执行命令后读取输出再判断成败。',
  '结束时必须调用 report_result，把实际产生或修改的文件路径填进 artifacts；没有产物就在 summary 里说明。',
  '不要声称未确认的结果。'
].join('\n')

const BUDGET_REMINDER =
  '已达到回合预算的收尾回合：立即停止扩展工作，调用 report_result 汇报已完成的内容、未完成的部分和实际产物路径。'

export const REPORT_RESULT_TOOL_NAME = 'report_result'

// worker-fake 固定产物内容（测试以同一字面量作为独立期望值）
export const WORKER_FAKE_FILE_CONTENT = "console.log('hello from worker');"

// 从任务 prompt 派生要写的文件名：取第一个出现的 xxx.js，否则 task.js
function deriveFakeFilename(prompt: string): string {
  return /[\w.-]+\.js/.exec(prompt)?.[0] ?? 'task.js'
}

// 强制失败触发词：worker-fake 直接以 failed 汇报，不写文件
const FAIL_TRIGGER = '强制失败'

// 长任务触发词：worker-fake 每回合写一个 step-N.js 且永不汇报，直到被叫停（票 04 的 interrupt 测试用）
const LONG_TRIGGER = '长任务'

const STREAM_ERROR_TRIGGER = '错误收尾'

// 产物校验触发词：首回合报 ok 但产物不存在，用于验证 report_result 的代码校验
const ARTIFACT_CHECK_TRIGGER = '产物校验'

// 子代理冒烟意图（T1 移到 Worker 侧）：fake 命中即发 subagent toolCall，由真扩展跑 delegate 子代理，
// finalOutput 经 toolResult 回流 Worker 转录。锚定见 scriptedWorkerTurn 的 startsWith 注释
export const WORKER_SUBAGENT_INTENT_MARKER = '子代理帮我写个 hello'

const SKILL_FILES: Record<string, string> = {
  'file-edit': [
    '---',
    'name: file-edit',
    'description: 修改文件前先读取原文，改动后读回确认内容已落盘。',
    '---',
    '',
    '1. 修改前先 read 目标文件；文件不存在时先确认路径，不要凭猜测创建。',
    '2. 用 edit 做精确替换或 write 整体改写，一次只改一处语义。',
    '3. 改完必须 read 回读，确认新内容存在且旧内容已消失。',
    '4. 把改动的每个文件路径填进 report_result.artifacts（相对任务目录）。'
  ].join('\n'),
  'command-run': [
    '---',
    'name: command-run',
    'description: 执行命令时确认工作目录与参数，读取退出码和输出后再判断成败。',
    '---',
    '',
    '1. 命令在任务目录内执行，路径用相对路径。',
    '2. 一次只跑一条命令，拿到退出码和输出后再决定下一步。',
    '3. 退出码非零时读 stderr，不要假设命令成功。',
    '4. 命令生成的产物路径填进 report_result.artifacts。'
  ].join('\n')
}

// 幂等播种 Worker 技能：文件已存在就不覆盖，用户改过的内容保留
export function ensureWorkerSkills(agentDir: string): void {
  const skillsDir = join(agentDir, 'skills')
  for (const [name, content] of Object.entries(SKILL_FILES)) {
    const filePath = join(skillsDir, name, 'SKILL.md')
    if (existsSync(filePath)) continue
    mkdirSync(join(skillsDir, name), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }
}

export function loadWorkerSkills(taskDir: string, agentDir: string): LoadSkillsResult {
  ensureWorkerSkills(agentDir)
  return loadSkills({
    cwd: taskDir,
    agentDir,
    skillPaths: [join(agentDir, 'skills')],
    includeDefaults: false
  })
}

// 显式加载 Worker 记忆（AGENTS.md/CLAUDE.md）：agentDir 全局 + 任务目录祖先链（pi 的 loadProjectContextFiles），
// 再追加长期记忆 MEMORY.md（每个 Worker 会话按当前磁盘内容现读，天然取到最新整理产物）；
// agentDir 缺省返回空（与技能加载同语义：无 agentDir 不加载记忆）
export function loadWorkerContextFiles(taskDir: string, agentDir?: string): Array<{ path: string; content: string }> {
  if (!agentDir) return []
  const files = loadProjectContextFiles({ cwd: taskDir, agentDir })
  const memory = readMemoryForContext(agentDir)
  return memory ? [...files, memory] : files
}

// status=ok 的产物校验：每个路径必须存在、可读、是文件，且落在任务目录内。
// 返回中文原因列表（空数组即通过）；校验在工具执行里做，不靠模型自觉
export function validateArtifacts(taskDir: string, artifacts: string[]): string[] {
  const root = resolve(taskDir)
  const problems: string[] = []
  for (const artifact of artifacts) {
    const target = resolve(root, artifact)
    const rel = relative(root, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      problems.push(`${artifact} 越界：不在任务目录内`)
      continue
    }
    try {
      if (!statSync(target).isFile()) {
        problems.push(`${artifact} 不是文件`)
        continue
      }
      accessSync(target, constants.R_OK)
    } catch {
      problems.push(`${artifact} 不存在或不可读`)
    }
  }
  return problems
}

function createReportResultTool(taskDir: string, onReport: (report: WorkerReport) => void) {
  return defineTool({
    name: REPORT_RESULT_TOOL_NAME,
    label: '汇报结果',
    description:
      '任务结束时调用：status=ok 表示任务已完成，failed 表示无法完成。artifacts 是产生或修改的文件路径（相对任务目录），没有产物给空数组。',
    promptSnippet: '任务结束时汇报结果',
    parameters: Type.Object({
      status: Type.Union([Type.Literal('ok'), Type.Literal('failed')]),
      summary: Type.String({ description: '给用户看的一句话结果；没有产物时说明没有产生文件' }),
      artifacts: Type.Array(Type.String(), {
        description: '产生或修改的文件路径列表，相对任务目录；没有产物填空数组'
      })
    }),
    execute: async (_toolCallId, params) => {
      if (params.status === 'ok') {
        const problems = validateArtifacts(taskDir, params.artifacts)
        if (problems.length > 0) {
          return {
            content: [{ type: 'text' as const, text: `汇报被拒绝：${problems.join('；')}` }],
            details: undefined,
            isError: true
          }
        }
      }
      onReport({ status: params.status, summary: params.summary, artifacts: params.artifacts })
      return { content: [{ type: 'text' as const, text: '汇报已记录' }], details: undefined }
    }
  })
}

// worker-fake 确定性脚本：无 toolResult → 子代理冒烟意图发 subagent，否则 write 工具（失败/产物校验触发时直接 report_result）；
// 最近一个 toolResult 是 subagent → 把子代理输出 echo 进 report_result；是 write → 长任务则继续写 step-N.js（永不汇报），否则 report_result ok；
// 是 report_result → 结束文本。
// 注意必须看"最近一个"而不是第一个：否则成功路径会在 write 结果之后无限重复 report_result。
// 触发词取自原始任务 prompt：预算提醒会作为 user 消息注入，最后一条 user 不再可靠
function scriptedWorkerTurn(messages: { role: string; content: unknown }[], prompt: string): ScriptedTurn {
  const toolResults = messages.filter((m) => m.role === 'toolResult')
  const lastToolResult = toolResults.at(-1)
  const filename = deriveFakeFilename(prompt)
  // 子会话的任务注入带 "Task: " 前缀；子会话没有 Worker 的 report_result，写完直接以文本收尾
  const isChildSession = messages
    .filter((m) => m.role === 'user')
    .map(textOf)
    .some((text) => text.startsWith('Task: '))
  if (!lastToolResult) {
    // 子代理意图用最近一条 user 文本 startsWith 锚定（不用闭包 prompt/includes）：子会话共享本 fake runtime，
    // 其任务注入带 "Task: " 前缀，startsWith 不命中 → 子会话落到 write 分支正常收尾，避免自递归派发
    const lastUser = messages.filter((m) => m.role === 'user').map(textOf).at(-1) ?? ''
    if (lastUser.startsWith(WORKER_SUBAGENT_INTENT_MARKER)) {
      return { kind: 'toolCall', name: 'subagent', arguments: { agent: 'delegate', task: lastUser } }
    }
    if (prompt.includes(ARTIFACT_CHECK_TRIGGER)) {
      return {
        kind: 'toolCall',
        name: REPORT_RESULT_TOOL_NAME,
        arguments: { status: 'ok', summary: '已生成产物', artifacts: ['missing.js'] }
      }
    }
    if (prompt.includes(FAIL_TRIGGER)) {
      return {
        kind: 'toolCall',
        name: REPORT_RESULT_TOOL_NAME,
        arguments: { status: 'failed', summary: '模拟失败：任务无法完成', artifacts: [] }
      }
    }
    if (prompt.includes(STREAM_ERROR_TRIGGER)) {
      // 不含 pi 重试模式词（429/rate limit/timeout 等），保证测试不触发自动重试退避
      return { kind: 'error', errorMessage: '模拟错误：上游模型拒绝响应' }
    }
    return { kind: 'toolCall', name: 'write', arguments: { path: filename, content: WORKER_FAKE_FILE_CONTENT } }
  }
  const toolName = (lastToolResult as { toolName?: string }).toolName
  if (toolName === 'subagent') {
    return {
      kind: 'toolCall',
      name: REPORT_RESULT_TOOL_NAME,
      arguments: { status: 'ok', summary: `子代理完成：${textOf(lastToolResult)}`, artifacts: [] }
    }
  }
  if (toolName === 'write') {
    if (isChildSession) {
      return { kind: 'text', text: `child done: ${filename}` }
    }
    if (prompt.includes(LONG_TRIGGER)) {
      return {
        kind: 'toolCall',
        name: 'write',
        arguments: { path: `step-${toolResults.length}.js`, content: WORKER_FAKE_FILE_CONTENT }
      }
    }
    return {
      kind: 'toolCall',
      name: REPORT_RESULT_TOOL_NAME,
      arguments: { status: 'ok', summary: `已写入 ${filename}`, artifacts: [filename] }
    }
  }
  return { kind: 'text', text: '任务完成' }
}

async function createFakeWorkerModelRuntime(prompt: string, streamDelayMs: number): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null })
  modelRuntime.registerProvider('fake-worker', {
    name: 'Fake Worker',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test',
    api: 'fake-api',
    // 事件序列（start→延迟→abort 终结→toolcall/text→done）由 pi-shared 的驱动统一保证
    streamSimple: (model, context, options) => {
      return driveFakeAssistantStream({
        model,
        getTurn: () => scriptedWorkerTurn(context.messages, prompt),
        delayMs: streamDelayMs,
        signal: options?.signal,
        // 透传请求上下文：usage 按 chars/4 造数，与 Router 的假模型压缩行为一致
        context
      })
    },
    models: [fakeChatModelConfig('worker-scripted-1', 'Worker Scripted')]
  })
  return modelRuntime
}

async function createWorkerSession(options: {
  taskDir: string
  prompt: string
  agentDir?: string
  mode: AgentMode
  sessionDir?: string
  realModelId?: string
  streamDelayMs: number
  skills: LoadSkillsResult
  extensions: LoadExtensionsResult
  reportTool: ReturnType<typeof createReportResultTool>
}): Promise<AgentSession> {
  const { taskDir, prompt, agentDir, mode, sessionDir, realModelId, streamDelayMs, skills, extensions, reportTool } = options
  const base = {
    cwd: taskDir,
    agentDir,
    sessionManager: sessionDir ? SessionManager.create(taskDir, sessionDir) : SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    resourceLoader: workerResourceLoader(WORKER_SYSTEM_PROMPT, skills, loadWorkerContextFiles(taskDir, agentDir), extensions),
    customTools: [reportTool]
  }
  if (mode === 'fake') {
    const modelRuntime = await createFakeWorkerModelRuntime(prompt, streamDelayMs)
    const model = modelRuntime.getModel('fake-worker', 'worker-scripted-1')
    if (!model) throw new Error('fake worker model worker-scripted-1 not registered')
    const { session } = await createAgentSession({ ...base, model, modelRuntime })
    return session
  }
  if (!agentDir || !hasModelConfig(agentDir)) {
    throw new Error(
      `Worker 未配置模型：请将 models.json 与 auth.json 放入 ${agentDir ?? '(未设置 agentDir)'}（OpenAI 兼容 provider 格式），或改用 fake 模式`
    )
  }
  if (realModelId) {
    const resolved = await resolveRealModel(agentDir, realModelId)
    if (resolved) {
      const { session } = await createAgentSession({ ...base, model: resolved.model, modelRuntime: resolved.modelRuntime })
      return session
    }
    console.warn(`[tasks] worker.model "${realModelId}" not found, falling back to first available model`)
  }
  const { session } = await createAgentSession(base)
  return session
}

// 任务目录内文件清单（递归，跳过点开头目录，最多 20 个，相对路径排序）——预算收尾汇报用
function listTaskFiles(taskDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(taskDir, full))
    }
  }
  walk(taskDir)
  return out.sort().slice(0, 20)
}

function buildBudgetReport(taskDir: string, session: AgentSession, maxTurns: number): string {
  const lastAssistantText = [...session.messages]
    .reverse()
    .filter((m) => (m as { role: string }).role === 'assistant')
    .map((m) => textOf(m as { role: string; content: unknown }).trim())
    .find((text) => text.length > 0)
  const files = listTaskFiles(taskDir)
  const lines = [`未完成：达到 ${maxTurns} 回合预算`]
  if (lastAssistantText) lines.push('', `最后一轮输出：${lastAssistantText}`)
  lines.push('', files.length > 0 ? `任务目录文件：${files.join('、')}` : '任务目录没有文件')
  return lines.join('\n')
}

// 运行一个 Worker 会话直到其结束（汇报/异常/无汇报/预算耗尽/叫停），返回最终结果；会话保证被 dispose
export async function runWorker(options: RunWorkerOptions): Promise<WorkerOutcome> {
  const taskDir = join(options.workspaceRoot, options.taskId)
  mkdirSync(taskDir, { recursive: true })
  const maxTurns = Math.max(1, options.maxTurns ?? WORKER_MAX_TURNS)
  const skills: LoadSkillsResult = options.agentDir
    ? loadWorkerSkills(taskDir, options.agentDir)
    : { skills: [], diagnostics: [] }

  // 用对象属性而非裸 let：TS 不会跨闭包追踪 let 赋值，属性读取在 await 后会重新取值
  const box: { reported: WorkerReport | null } = { reported: null }
  const reportTool = createReportResultTool(taskDir, (report) => {
    if (!box.reported) box.reported = report
  })

  let session: AgentSession | undefined
  let unsubscribe: (() => void) | undefined
  const onAbort = (): void => {
    void session?.abort().catch(() => {})
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  // 活动预览合批（与 Router 侧 text_delta 合批同款 16ms 节奏的简化版）：text_delta 累积，
  // 定时器与回合边界统一冲刷。预览事件是整行替换（非增量拼接），无需按 id 保留缓冲；
  // 声明在 try 外，finally 要清滞留定时器
  const onActivity = options.onActivity
  let textBuf = ''
  let previewTimer: ReturnType<typeof setTimeout> | null = null
  const flushTextPreview = (): void => {
    if (previewTimer) {
      clearTimeout(previewTimer)
      previewTimer = null
    }
    if (!onActivity || textBuf.length === 0) return
    onActivity({ kind: 'text', label: textBuf.slice(-120) })
    textBuf = ''
  }
  const onStep = options.onStep
  const subagentCalls = new Map<
    string,
    { agent: string; task?: string; lastEmittedAt: number; pending: WorkerSubagentStep | null }
  >()
  const onSubagentEvent = (event: ToolExecutionEvent): void => {
    const callId = event.toolCallId
    if (event.type === 'tool_execution_start') {
      const args = asRecord(event.args)
      const agent = boundText(stringField(args, 'agent') ?? '', SUBAGENT_LINE_LIMIT)
      const taskRaw = stringField(args, 'task')
      const task = taskRaw ? boundText(taskRaw, TOOL_TEXT_LIMIT) : undefined
      onActivity?.({ kind: 'tool', label: `正在调用 ${agent} 子智能体` })
      subagentCalls.set(callId, { agent, ...(task ? { task } : {}), lastEmittedAt: 0, pending: null })
      onStep?.({ callId, phase: 'start', agent, ...(task ? { task } : {}) })
      return
    }
    const entry = subagentCalls.get(callId)
    if (event.type === 'tool_execution_update') {
      const { progress } = subagentDetailsOf(event.partialResult)
      if (!progress || !onStep) return
      const step: WorkerSubagentStep = {
        callId,
        phase: 'update',
        agent: entry?.agent ?? '',
        ...(entry?.task ? { task: entry.task } : {}),
        progress
      }
      if (!entry) {
        onStep(step)
        return
      }
      const now = Date.now()
      if (now - entry.lastEmittedAt >= SUBAGENT_STEP_INTERVAL_MS) {
        entry.lastEmittedAt = now
        entry.pending = null
        onStep(step)
      } else {
        entry.pending = step
      }
      return
    }
    const { result, progress } = subagentDetailsOf(event.result)
    const exitCode = numberField(result, 'exitCode')
    const error = stringField(result, 'error')
    const finalOutput = stringField(result, 'finalOutput') ?? stringField(result, 'output')
    const sessionFile = stringField(result, 'sessionFile')
    const isError = event.isError === true || (exitCode !== undefined && exitCode !== 0) || error !== undefined
    if (entry?.pending) onStep?.(entry.pending)
    const resultAgent = stringField(result, 'agent')
    onStep?.({
      callId,
      phase: 'end',
      agent: entry?.agent ?? (resultAgent ? boundText(resultAgent, SUBAGENT_LINE_LIMIT) : ''),
      ...(entry?.task ? { task: entry.task } : {}),
      ...(progress ? { progress } : {}),
      ...(finalOutput ? { finalOutput: boundText(finalOutput, TOOL_TEXT_LIMIT) } : {}),
      ...(sessionFile ? { sessionFile } : {}),
      isError,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
    })
    subagentCalls.delete(callId)
  }
  try {
    // 会话目录由 runWorker 自建兜底（调用方无需预创建）；SessionManager.create 随后在其中落 jsonl
    const sessionDir = options.sessionDir
    if (sessionDir) mkdirSync(sessionDir, { recursive: true })
    // pi-subagents 只挂 Worker：agentDir 缺省（inMemory 测试）→ 跳过，同 Router 语义；包未装 → resolve
    // 返回 undefined，路径加载失败 → extensions.errors，两者都降级为无子代理会话（errors 走 notice）。
    // resolve 需先于 loadAppExtensions：扩展模块 import 时就读 PI_CODING_AGENT_DIR 定位 config/agent 定义
    let extensions: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() }
    if (options.agentDir) {
      const subagentPath = resolveSubagentExtension(options.agentDir)
      extensions = await loadAppExtensions({
        cwd: taskDir,
        loadConfig: () => ({ servers: [], errors: [] }),
        ...(subagentPath ? { extensionPaths: [subagentPath] } : {})
      })
      for (const error of extensions.errors) {
        options.onNotice?.({ kind: 'extension-warning', message: `扩展 ${error.path} 加载失败：${error.error}` })
      }
    }
    session = await createWorkerSession({
      taskDir,
      prompt: options.prompt,
      agentDir: options.agentDir,
      mode: options.mode,
      sessionDir,
      realModelId: options.realModelId,
      streamDelayMs: options.streamDelayMs ?? 0,
      skills,
      extensions,
      reportTool
    })
    // 扩展绑定（同 Router 的 print 模式先例）：发 session_start 激活扩展，事件处理器异常映射为 notice
    await session.bindExtensions({
      mode: 'print',
      onError: (error) => {
        options.onNotice?.({ kind: 'extension-warning', message: `扩展 ${error.extensionPath} 事件 ${error.event} 失败：${error.error}` })
      }
    })
    if (options.signal?.aborted) return { status: 'aborted', report: '任务已中止' }

    // 回合预算：收尾回合前提醒一次，收尾回合结束仍未汇报则中止，由 runWorker 生成失败汇报
    let turns = 0
    // 用对象属性而非裸 let：赋值发生在事件回调里，裸 let 在 await 之后会被 TS 收紧成字面量
    const budget: { stopped: boolean } = { stopped: false }
    const workerSession = session
    unsubscribe = workerSession.subscribe((event) => {
      if (event.type === 'turn_start') {
        turns++
        return
      }
      if (event.type === 'message_update') {
        if (!onActivity) return
        const a = event.assistantMessageEvent
        if (a.type === 'text_delta') {
          textBuf += a.delta
          previewTimer ??= setTimeout(flushTextPreview, 16)
        } else if (a.type === 'text_start') {
          // 上一文本块的尾巴先出，预览从新块重新累积
          flushTextPreview()
        } else if (a.type === 'toolcall_end') {
          onActivity({ kind: 'tool', label: toolCallLabel(a.toolCall.name, a.toolCall.arguments) })
        }
        return
      }
      if (
        event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_update' ||
        event.type === 'tool_execution_end'
      ) {
        if (event.toolName === 'subagent') onSubagentEvent(event)
        return
      }
      if (event.type !== 'turn_end') return
      flushTextPreview()
      if (box.reported) return
      if (turns >= maxTurns) {
        budget.stopped = true
        void workerSession.abort().catch(() => {})
      } else if (turns === maxTurns - 1) {
        void workerSession.steer(BUDGET_REMINDER).catch(() => {})
      }
    })

    options.onStart?.()
    await workerSession.prompt(options.prompt)
    if (options.signal?.aborted) return { status: 'aborted', report: '任务已中止' }
    if (box.reported) {
      const { status, summary, artifacts } = box.reported
      const report = artifacts.length > 0 ? `${summary}\n产物：${artifacts.join('、')}` : summary
      return { status: status === 'ok' ? 'done' : 'failed', report }
    }
    if (budget.stopped) {
      return { status: 'failed', report: buildBudgetReport(taskDir, workerSession, maxTurns) }
    }
    // pi 在流错误（限流重试耗尽等）时正常结束 run 不抛错，错误只留在最后一条 assistant 消息上，取出来落账
    const lastAssistant = [...workerSession.messages]
      .reverse()
      .find((m) => (m as { role: string }).role === 'assistant') as
      | { stopReason?: string; errorMessage?: string }
      | undefined
    if (lastAssistant?.stopReason === 'error') {
      return { status: 'failed', report: `LLM 调用失败：${lastAssistant.errorMessage ?? '未知错误'}` }
    }
    // 最后一个工具结果是错误（如 report_result 的产物校验被拒绝）：把拒绝原因带回任务记录
    const lastToolResult = [...workerSession.messages]
      .reverse()
      .find((m) => (m as { role: string }).role === 'toolResult') as
      | { content: unknown; isError?: boolean; toolName?: string }
      | undefined
    if (lastToolResult?.isError) {
      const toolName = lastToolResult.toolName ? `（${lastToolResult.toolName}）` : ''
      return {
        status: 'failed',
        report: `最后一个工具调用失败${toolName}：${textOf({ role: 'toolResult', content: lastToolResult.content })}`
      }
    }
    return { status: 'failed', report: '会话结束但 Worker 未调用 report_result' }
  } catch (err) {
    if (options.signal?.aborted) return { status: 'aborted', report: '任务已中止' }
    return { status: 'failed', report: `Worker 异常：${errorMessageOf(err)}` }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    unsubscribe?.()
    if (previewTimer) clearTimeout(previewTimer)
    // AgentSession.dispose 不发 session_shutdown，而扩展只在 session_shutdown 里释放资源（同 RouterLoop.dispose）：
    // 不发的话扩展持有的连接/子进程会泄漏，node --test 也可能被孙进程挂住
    const runner = session?.extensionRunner
    if (runner?.hasHandlers('session_shutdown')) {
      void runner.emit({ type: 'session_shutdown', reason: 'quit' }).catch(() => {})
    }
    // 速查表第 10 节：dispose 报废会话（中止在途工作），不删会话文件
    session?.dispose()
  }
}
