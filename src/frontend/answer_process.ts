import { normalizeTraceEvents, type Reference, type TraceEvent } from "./conversation"

export interface AnswerProcessInput {
  events: readonly TraceEvent[]
  isRunning: boolean
  hasError?: boolean
  traceStatus?: string | null
  references?: readonly Reference[]
}

export interface AnswerProcessStep {
  key: string
  stage: string
  label: string
  description: string
  status: string
  round?: number
}

export interface AnswerProcessProjection {
  visible: boolean
  status: "running" | "completed" | "cancelled" | "incomplete" | "recorded"
  statusLabel: string
  currentLabel: string
  steps: AnswerProcessStep[]
  answerBasis: { text: string; referenceIds: string[] } | null
}

const STAGE_LABELS: Record<string, string> = {
  route: "理解问题",
  retrieval: "查找资料",
  context: "整理证据",
  validation: "核对答案",
}

function stageLabel(event: TraceEvent): string {
  if (event.stage === "context" && event.data?.phase === "draft") return "组织回答"
  if (event.stage === "retrieval" && event.data?.correction === true) return "补充查找资料"
  return STAGE_LABELS[event.stage ?? ""] ?? "处理回答"
}

function knownCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** Descriptions are built from safe structured fields, never event summaries. */
export function answerProcessEventLabel(event: TraceEvent): string {
  const data = event.data ?? {}
  const running = event.status === "running"
  if (event.status === "cancelled") return `${stageLabel(event)}已停止`
  if (event.status === "failed" || event.status === "incomplete") return `${stageLabel(event)}未完成`
  if (event.stage === "route") {
    if (data.faqMatch) return "命中 FAQ 标准答案"
    if (data.decision === "direct") return "直接回复"
    if (data.decision === "ambiguous") return "需要补充问题信息"
    if (data.decision === "complex") return "识别为复杂问题"
    if (data.decision === "simple") return "识别为知识问答"
    return running ? "正在理解问题" : "已分析问题"
  }
  if (event.stage === "retrieval") {
    if (running) return data.correction ? "正在补充查找资料" : "正在查找相关资料"
    const prefix = data.correction ? "补充查找资料" : "查找资料"
    return knownCount(data.resultCount) ? `已找到 ${data.resultCount} 条资料` : `已${prefix}`
  }
  if (event.stage === "context") {
    if (data.phase === "draft") return running ? "正在依据材料组织回答" : "已依据材料组织回答"
    const count = knownCount(data.evidenceCount) ? ` ${data.evidenceCount} 条证据` : "证据"
    return `${running ? "正在整理" : "已整理"}${count}`
  }
  if (event.stage === "validation") {
    if (running) return "正在核对答案与引用"
    if (data.passed === true) return "答案与引用核对通过"
    if (data.passed === false) return "发现证据缺口，核对未通过"
    return "已完成核对"
  }
  return "处理回答"
}

function approvedBasis(
  validation: TraceEvent | undefined,
  terminal: TraceEvent | undefined,
  references: readonly Reference[],
): AnswerProcessProjection["answerBasis"] {
  if (terminal?.result?.status !== "completed" || terminal.result.faq ||
      validation?.status !== "completed" || validation.data?.passed !== true) return null
  const basis = validation.data.answerBasis
  if (!basis || typeof basis !== "object" || Array.isArray(basis)) return null
  const { text, referenceIds } = basis as Record<string, unknown>
  if (typeof text !== "string" || !text.trim() || text.trim().length > 240 ||
      !Array.isArray(referenceIds) || referenceIds.length < 1 || referenceIds.length > 8) return null
  const available = new Set(references.map(({ id }) => id))
  if (!referenceIds.every((id): id is string =>
    typeof id === "string" && id.trim().length > 0 && id.length <= 200 && available.has(id))) return null
  return { text: text.trim(), referenceIds: [...new Set(referenceIds)] }
}

/** Public execution steps only; never expose raw prompts, queries, or traces. */
export function projectAnswerProcess(input: AnswerProcessInput): AnswerProcessProjection {
  const normalized = normalizeTraceEvents([...input.events])
  const terminal = normalized.find((event) => event.type === "done")
  const events = terminal ? normalized.filter((event) => event.sequence <= terminal.sequence) : normalized
  const terminalStatus = terminal?.result?.status ?? input.traceStatus
  const status: AnswerProcessProjection["status"] = terminalStatus === "completed"
    ? "completed"
    : terminalStatus === "cancelled"
      ? "cancelled"
      : terminalStatus || input.hasError
        ? "incomplete"
        : input.isRunning && !terminal
          ? "running"
          : "recorded"
  const statusLabel = {
    running: "处理中",
    completed: "已完成",
    cancelled: "已停止",
    incomplete: "未完成",
    recorded: "已记录",
  }[status]
  const grouped = new Map<string, TraceEvent>()
  for (const event of events) {
    if (event.type !== "progress" || !event.stage || !STAGE_LABELS[event.stage]) continue
    const phase = event.stage === "context" ? (event.data?.phase ?? "assembly") : ""
    const key = `${event.stage}:${event.attempt ?? 1}:${event.round ?? 0}:${phase}`
    const previous = grouped.get(key)
    grouped.set(key, { ...event, data: { ...previous?.data, ...event.data } })
  }
  const steps = [...grouped].map(([key, event]) => {
    const stepStatus = event.status === "running" && status !== "running"
      ? status === "cancelled" ? "cancelled" : "incomplete"
      : event.stage === "validation" && event.data?.passed === false
        ? "failed"
        : event.status ?? "recorded"
    return {
      key,
      stage: event.stage!,
      label: stageLabel(event),
      description: answerProcessEventLabel({ ...event, status: event.status === "running" ? stepStatus : event.status }),
      status: stepStatus,
      round: event.round,
    }
  })
  const currentLabel = status === "running"
    ? steps.at(-1)?.description ?? "请求已发送，等待处理"
    : status === "cancelled"
      ? "回答已停止"
      : status === "completed"
        ? terminal?.result?.faq ? "命中 FAQ 标准答案" : "回答已完成"
        : terminalStatus === "clarification_required"
          ? "需要补充问题信息"
          : status === "incomplete"
            ? "回答未完成"
            : "处理已结束，未记录最终状态"
  return {
    visible: input.isRunning || input.hasError === true || steps.length > 0 || !!terminal ||
      status === "cancelled" || status === "incomplete",
    status,
    statusLabel,
    currentLabel,
    steps,
    answerBasis: approvedBasis(
      [...events].reverse().find((event) => event.type === "progress" && event.stage === "validation"),
      terminal,
      input.references ?? terminal?.result?.references ?? [],
    ),
  }
}
