import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import ChatMessage from '@tdesign-react/chat/es/chat-message'
import ChatActionBar from '@tdesign-react/chat/es/chat-actionbar'
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  Copy,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Volume2
} from 'lucide'
import { MorphIcon } from 'morphicons/react'
import {
  useChatStore,
  selectDelegationChip,
  timelineKey,
  type GroupPos,
  type SubagentRun
} from '@/stores/chat-store'
import type { TimelineRef } from '@/stores/chat-store'
import type { ChatSubagentDetailResponse } from '../../../../shared/protocol'
import { Markdown } from '@/components/chat/markdown'
import { isMenuOpen, openBubbleMenu } from '@/components/chat/chat-menu'
import { cn } from '@/lib/utils'
import { notifyContentGrew } from '@/lib/chat-scroll'
import {
  notifyRemoval,
  registerThreadRow,
  scheduleThreadFlip,
  skipNextThreadFlip,
  unregisterThreadRow
} from '@/lib/chat-flip'
import { playFrostIn, playGhostMelt, pressBubble } from '@/lib/cirrus-fx'
import { peekEnter } from '@/lib/chat-intro'

const ICON = 'h-3.5 w-3.5 shrink-0'

// store stopReason → WC ChatMessageStatus。缺省只出现在流式中与历史恢复（streaming=false），
// 恢复的消息不能按缺省判成流式（否则空正文的恢复行会永远转圈），用 streaming 标志补判
const ASSISTANT_STATUS = { stop: 'complete', error: 'error', aborted: 'stop' } as const

// 长按节奏（第 6 节）：90ms 压至 0.965，420ms 抬至 1.025 并开菜单
const PRESS_MS = 90
const HOLD_MS = 420
const PRESS_SCALE = 0.965
const LIFT_SCALE = 1.025
const CANCEL_RADIUS_PX = 10

function speakText(text: string): void {
  const synth = window.speechSynthesis
  if (!synth) return
  if (synth.speaking) {
    synth.cancel()
    return
  }
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  synth.speak(utterance)
}

// 内容订阅：每 chunk 只有正在流式的那一行重渲染。高度变化由行级 ResizeObserver
// 兜住（含 WC 内部动画），线程 FLIP 统一在 chat-flip 里调度
function MessageRow({ id, groupPos, isLastAssistant }: { id: string; groupPos: GroupPos; isLastAssistant: boolean }) {
  const message = useChatStore((s) => s.messagesById[id])
  useLayoutEffect(() => {
    notifyContentGrew()
  }, [message.content])
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const pressPoint = useRef<{ x: number; y: number } | null>(null)
  const pressedRef = useRef(false)
  const pressTimer = useRef(0)
  const liftTimer = useRef(0)

  const isUser = message.role === 'user'
  const streaming = !isUser && message.streaming
  const status = message.stopReason ? ASSISTANT_STATUS[message.stopReason] : streaming ? 'streaming' : 'complete'
  // 动作条只挂最后一个 assistant 回合的终态消息（流式/中间回合/错误不出现）。
  // 历史恢复的消息 stopReason 为 undefined（store 惯例缺省视为 stop），重启后最后一答仍可复制/重新生成
  const canAct =
    !isUser && isLastAssistant && message.content.length > 0 && !streaming && message.stopReason !== 'error'
  const pressable = !streaming && message.content.length > 0

  const copyReply = () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  // 先 invoke 后回撤：invoke 失败（进行中/无可重生成）时保持现状；新回合 chunk 在 invoke
  // 回执之后到达，懒 upsert 落在回撤后的时间线末尾
  const regenerateReply = () => {
    void window.api
      .regenerateChat()
      .then((newId) => {
        void newId
        useChatStore.getState().dropLastAssistantTurn()
      })
      .catch(() => {})
  }

  const endPress = () => {
    clearTimeout(pressTimer.current)
    clearTimeout(liftTimer.current)
    pressPoint.current = null
    if (pressedRef.current) {
      pressedRef.current = false
      bubbleRef.current?.classList.remove('cirrus-pressed')
      if (!isMenuOpen() && bubbleRef.current) pressBubble(bubbleRef.current, 1)
    }
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (!pressable || e.button !== 0) return
    if (isMenuOpen()) return
    if ((e.target as HTMLElement).closest('button')) return // 按钮上的按下不进长按（memory-card 同款守卫）
    pressPoint.current = { x: e.clientX, y: e.clientY }
    pressTimer.current = window.setTimeout(() => {
      if (!pressPoint.current || !bubbleRef.current) return
      pressedRef.current = true
      bubbleRef.current.classList.add('cirrus-pressed')
      pressBubble(bubbleRef.current, PRESS_SCALE)
    }, PRESS_MS)
    liftTimer.current = window.setTimeout(() => {
      if (!pressedRef.current || !bubbleRef.current) return
      pressBubble(bubbleRef.current, LIFT_SCALE)
      openBubbleMenu({
        anchor: bubbleRef.current.getBoundingClientRect(),
        side: isUser ? 'right' : 'left',
        items: menuItems,
        onClosed: endPress
      })
    }, HOLD_MS)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pressPoint.current
    if (!p) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CANCEL_RADIUS_PX) endPress()
  }
  const onPointerUp = () => {
    if (isMenuOpen()) return // 菜单开着时保持抬起，关闭时由 onClosed 回弹
    endPress()
  }

  // 入场（第 4 节）：发送=果冻+升起（升起由 chat-flip 的 rise 驱动）
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!el) return
    if (!isUser) return
    if (peekEnter(id)) playFrostIn(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 删除（第 6 节）：行即刻移出布局（幽灵克隆接管视觉），上方行按级联弹簧填隙
  const removeSelf = () => {
    if (bubbleRef.current) playGhostMelt(bubbleRef.current)
    const refs = useChatStore.getState().timelineRefs
    const idx = refs.findIndex((r) => r.kind === 'message' && r.id === id)
    const prev = idx > 0 ? refs[idx - 1] : null
    notifyRemoval(prev ? timelineKey(prev) : null)
    useChatStore.getState().deleteMessage(id)
  }

  const menuItems = [
    { key: 'copy', icon: Copy, label: '复制', onClick: copyReply },
    ...(canAct ? [{ key: 'replay', icon: RefreshCw, label: '重新生成', onClick: regenerateReply }] : []),
    { key: 'speak', icon: Volume2, label: '朗读', onClick: () => speakText(message.content) },
    { key: 'delete', icon: Trash2, label: '删除', danger: true, onClick: removeSelf }
  ]

  if (message.summary) {
    return (
      <div className="text-sm leading-relaxed break-words whitespace-pre-wrap text-muted-foreground italic" data-test="message-assistant">
        {message.content}
      </div>
    )
  }

  const pressHandlers = pressable
    ? {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: endPress,
        onPointerLeave: () => {
          if (!isMenuOpen()) endPress()
        }
      }
    : undefined

  return (
    <div className="chat-message-row" data-test={isUser ? 'message-user' : 'message-assistant'}>
      {isUser ? (
        <ChatMessage
          role="user"
          placement="right"
          content={[{ type: 'text', data: message.content }]}
        >
          <div
            ref={bubbleRef}
            slot="text-0"
            className="cirrus-bubble cirrus-me"
            data-gpos={groupPos ?? undefined}
            {...pressHandlers}
          >
            {message.content}
          </div>
        </ChatMessage>
      ) : (
        <ChatMessage
          role="assistant"
          placement="left"
          status={status}
          content={[{ type: 'markdown', data: message.content, status }]}
        >
          {message.content.length > 0 && (
            <div
              ref={bubbleRef}
              slot="markdown-0"
              className="cirrus-plain"
              {...pressHandlers}
            >
              <Markdown content={message.content} streaming={streaming} />
            </div>
          )}
          {canAct && (
            <ChatActionBar
              {...{ slot: 'actionbar' }}
              className="chat-message-actions"
              actionBar={[
                <button key="copy" type="button" className="chat-action-btn" title="复制" data-test="action-copy" onClick={copyReply}>
                  <MorphIcon icon={copied ? Check : Copy} className={ICON} />
                </button>,
                <button key="replay" type="button" className="chat-action-btn" title="重新生成" data-test="action-replay" onClick={regenerateReply}>
                  <MorphIcon icon={RefreshCw} className={ICON} />
                </button>
              ]}
            />
          )}
        </ChatMessage>
      )}
      {/* WC 对带 markdown 正文的 error 状态无任何错误呈现（-chat-error 块仅限纯文本），错误图标保留 */}
      {message.stopReason === 'error' && (
        <div className="mt-1">
          <MorphIcon icon={CircleAlert} className={cn(ICON, 'text-destructive')} label="调用失败" />
        </div>
      )}
    </div>
  )
}

const TOOL_RUNNING = '运行中'
const TOOL_ABORTED = '已中止'
const TOOL_FAILED = '运行失败'

function ToolRow({ toolKey }: { toolKey: string }) {
  const line = useChatStore((s) => s.toolLinesByKey[toolKey])
  const [expanded, setExpanded] = useState(false)
  const running = line.phase !== 'end'
  const aborted = !running && line.aborted === true
  const failed = !running && !aborted && line.isError === true
  const statusIcon = running ? LoaderCircle : aborted ? CircleStop : failed ? CircleX : CircleCheck
  const statusText = running
    ? TOOL_RUNNING
    : aborted
      ? TOOL_ABORTED
      : failed
        ? TOOL_FAILED
        : line.toolName === 'bash'
          ? '已运行'
          : '已完成'
  const label = line.label ?? line.toolName ?? '工具'
  const preview = (line.input ?? '').trim().split('\n')[0] ?? ''
  const hasBody = Boolean(line.input || line.output)
  useLayoutEffect(() => {
    notifyContentGrew()
  }, [line.output, expanded])
  return (
    <div className="chat-step" data-test="tool-row">
      <button
        type="button"
        className="chat-step-head"
        aria-expanded={hasBody ? expanded : undefined}
        onClick={() => {
          if (!hasBody) return
          skipNextThreadFlip()
          setExpanded((v) => !v)
        }}
      >
        <MorphIcon
          icon={statusIcon}
          className={cn(ICON, running && 'animate-spin', failed && 'text-destructive')}
        />
        <span className="chat-step-label shrink-0">{label}</span>
        <span className={cn('chat-step-status shrink-0', failed && 'chat-step-failed')}>{statusText}</span>
        {!expanded && preview && <span className="min-w-0 truncate">{preview}</span>}
        {hasBody && (
          <MorphIcon
            icon={ChevronDown}
            className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
          />
        )}
      </button>
      {expanded && hasBody && (
        <div className="chat-step-body">
          {line.input && <pre className="chat-step-pre">{line.input}</pre>}
          {line.output && <pre className="chat-step-pre">{line.output}</pre>}
        </div>
      )}
    </div>
  )
}

function TaskRow({ taskId }: { taskId: string }) {
  const line = useChatStore((s) => s.taskLinesById[taskId])
  const activity = useChatStore((s) => s.activityByTaskId[taskId])
  const running = line.status === 'running'
  const failed = line.status === 'failed'
  const aborted = line.status === 'aborted'
  const interrupted = line.status === 'interrupted'
  const statusLabel = running ? '进行中' : failed ? '已失败' : aborted ? '已中止' : interrupted ? '已中断' : '已完成'
  const statusIcon = running ? LoaderCircle : failed ? CircleX : aborted ? CircleStop : interrupted ? CircleAlert : CircleCheck
  return (
    <div className="flex flex-col" data-test="task-row">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MorphIcon icon={statusIcon} className={cn(ICON, running && 'animate-spin', failed && 'text-destructive')} />
        <span className="sr-only">{statusLabel}</span>
        <span>{line.time}</span>
        <span className="truncate">{line.title}</span>
      </div>
      {running && activity && (
        <div className="flex items-center gap-2 pl-6 text-xs text-muted-foreground/70">
          <span className="truncate">{activity.label}</span>
        </div>
      )}
    </div>
  )
}

// 思考行：紧凑单行，默认收起（流式中也不自动展开）。头部常驻状态图标 + 文案 + 预览，
// 点开在下方显示完整思考文本。
function ThinkingRow({ thinkingKey }: { thinkingKey: string }) {
  const line = useChatStore((s) => s.thinkingByKey[thinkingKey])
  const streaming = line.phase === 'start'
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    notifyContentGrew()
  }, [line.text, expanded])
  // 流式中取尾部作实时预览，终态取首个非空行
  const preview = streaming
    ? line.text.replace(/\s+/g, ' ').slice(-72)
    : (line.text.trim().split('\n')[0] ?? '')
  return (
    <div className="chat-thinking-row" data-test="thinking-row">
      <button
        type="button"
        className="chat-thinking-head"
        aria-expanded={expanded}
        onClick={() => {
          // 展开/折叠是用户主动的布局跳变：跳过 FLIP 补偿，避免整块时间线被弹簧拽着滑一下
          skipNextThreadFlip()
          setExpanded((v) => !v)
        }}
      >
        <MorphIcon
          icon={streaming ? LoaderCircle : CircleCheck}
          className={cn(ICON, streaming && 'animate-spin')}
        />
        <span className="shrink-0">{streaming ? '正在思考' : '已思考'}</span>
        {!expanded && (
          <>
            <span className="shrink-0">·</span>
            <span className="min-w-0 truncate">{preview}</span>
          </>
        )}
        <MorphIcon
          icon={ChevronDown}
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      {expanded && <div className="chat-thinking-body">{line.text}</div>}
    </div>
  )
}

// 上下文压缩行：与任务事件行同款轻量文本，start/end 同 seq 就地替换
function CompactionRow({ seq }: { seq: number }) {
  const line = useChatStore((s) => s.compactionsBySeq[seq])
  const text =
    line.phase === 'start'
      ? '正在压缩上下文…'
      : line.error
        ? `上下文压缩失败：${line.error}`
        : `上下文已压缩（此前约 ${Math.round((line.tokensBefore ?? 0) / 1000)}k tokens）`
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-test="compaction-row">
      <MorphIcon
        icon={line.phase === 'start' ? LoaderCircle : line.error ? CircleAlert : CircleCheck}
        className={cn(ICON, line.phase === 'start' && 'animate-spin')}
      />
      <span className="truncate">{text}</span>
    </div>
  )
}

type ProcessBlock =
  | { kind: 'entry'; entry: TimelineRef; index: number }
  | { kind: 'group'; anchor: string; entries: Array<{ entry: TimelineRef; index: number }> }

export function groupProcessRefs(refs: TimelineRef[]): ProcessBlock[] {
  const blocks: ProcessBlock[] = []
  for (let index = 0; index < refs.length; index++) {
    const entry = refs[index]!
    if (entry.kind !== 'thinking' && entry.kind !== 'tool') {
      blocks.push({ kind: 'entry', entry, index })
      continue
    }
    const colon = entry.key.indexOf(':')
    const anchor = colon > 0 ? entry.key.slice(0, colon) : entry.key
    const last = blocks.at(-1)
    if (last?.kind === 'group' && last.anchor === anchor) last.entries.push({ entry, index })
    else blocks.push({ kind: 'group', anchor, entries: [{ entry, index }] })
  }
  return blocks
}

export function ProcessGroup({ entries }: { entries: Array<{ entry: TimelineRef; index: number }> }) {
  const [collapsed, setCollapsed] = useState(false)
  // 计数签名用字符串：工具输出增长不会改变 "N:K"，组头不跟着每一步重渲染
  const counts = useChatStore((s) => {
    let tools = 0
    let failed = 0
    for (const { entry } of entries) {
      if (entry.kind !== 'tool') continue
      tools += 1
      const line = s.toolLinesByKey[entry.key]
      if (line?.isError && line.aborted !== true) failed += 1
    }
    return `${tools}:${failed}`
  })
  const [toolCount, failedCount] = counts.split(':').map(Number)
  const title =
    toolCount! > 0
      ? `执行工具 ${toolCount} 次${failedCount! > 0 ? `，其中 ${failedCount} 次失败` : ''}`
      : '思考过程'
  return (
    <div className="chat-process-group" data-test="process-group">
      <button
        type="button"
        className="chat-process-head"
        aria-expanded={!collapsed}
        onClick={() => {
          skipNextThreadFlip()
          setCollapsed((v) => !v)
        }}
      >
        <span className="shrink-0">{title}</span>
        <MorphIcon
          icon={ChevronDown}
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', !collapsed && 'rotate-180')}
        />
      </button>
      {!collapsed &&
        entries.map(({ entry }) => (
          <TimelineEntry key={timelineKey(entry)} entry={entry} groupPos={null} isLastAssistant={false} />
        ))}
    </div>
  )
}

export function DelegationChip() {
  const runs = useChatStore((s) => s.subagentRunsByKey)
  const recentKey = useChatStore((s) => s.recentSubagentKey)
  const openDetail = useChatStore((s) => s.openSubagentDetail)
  const chip = selectDelegationChip({ subagentRunsByKey: runs, recentSubagentKey: recentKey })
  if (!chip) return null
  return (
    <button
      type="button"
      className={cn('delegation-chip', chip.tone === 'failed' && 'delegation-chip-failed')}
      data-test="delegation-chip"
      data-tone={chip.tone}
      onClick={() => openDetail(chip.key)}
    >
      <MorphIcon
        icon={chip.tone === 'running' ? LoaderCircle : chip.tone === 'failed' ? CircleAlert : CircleCheck}
        className={cn(ICON, chip.tone === 'running' && 'animate-spin')}
      />
      <span className="truncate">{chip.text}</span>
    </button>
  )
}

export function SubagentDetailDrawer() {
  const detailKey = useChatStore((s) => s.detailSubagentKey)
  const run = useChatStore((s) => (s.detailSubagentKey ? s.subagentRunsByKey[s.detailSubagentKey] : undefined))
  const close = useChatStore((s) => s.closeSubagentDetail)
  const [replay, setReplay] = useState<{
    key: string
    phase: SubagentRun['phase']
    response: ChatSubagentDetailResponse
  } | null>(null)
  const runKey = run?.key
  const taskId = run?.taskId
  const callId = run?.callId
  const phase = run?.phase

  // 运行中先取一次（子会话可能已写出一部分）；进入终态后再取一次，补齐全量步骤。
  // phase 放在依赖里：若打开抽屉时子代理还在跑，结束后必须重新回放，否则永远停在「仅实时进展」
  useEffect(() => {
    if (!runKey || !taskId || !callId || !phase) return
    let cancelled = false
    window.api
      .getSubagentDetail(taskId, callId)
      .then((response) => {
        if (!cancelled) setReplay({ key: runKey, phase, response })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [runKey, taskId, callId, phase])

  useEffect(() => {
    if (!detailKey) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailKey, close])

  if (!run) return null
  const detail = replay && replay.key === run.key && replay.phase === run.phase ? replay.response : null
  const progress = run.progress
  const statusText = run.phase === 'running' ? '运行中' : run.phase === 'failed' ? '失败' : '已完成'
  const finalOutput = run.finalOutput ?? detail?.finalOutput
  return (
    <aside className="subagent-drawer" data-test="subagent-drawer" aria-label="子智能体过程">
      <div className="subagent-drawer-head">
        <span className="truncate">{run.agent}</span>
        <span className="shrink-0 text-muted-foreground">{statusText}</span>
        <button type="button" className="subagent-drawer-close" aria-label="关闭" data-test="subagent-drawer-close" onClick={close}>
          <MorphIcon icon={CircleX} className={ICON} />
        </button>
      </div>
      {run.task && <div className="subagent-drawer-task">{run.task}</div>}
      <div className="subagent-drawer-scroll">
        {progress && (progress.toolCount !== undefined || progress.tokens !== undefined) && (
          <div className="subagent-drawer-meta">
            {progress.toolCount !== undefined && <span>工具 {progress.toolCount}</span>}
            {progress.tokens !== undefined && <span>{progress.tokens} tokens</span>}
          </div>
        )}
        {run.phase === 'running' && (progress?.currentTool || progress?.recentOutput?.length) && (
          <div className="subagent-live" data-test="subagent-live">
            {progress?.currentTool && (
              <div className="subagent-live-tool">
                {progress.currentTool}
                {progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ''}
              </div>
            )}
            {progress?.recentOutput?.map((line, i) => (
              <div key={`${i}:${line}`} className="subagent-live-line">
                {line}
              </div>
            ))}
          </div>
        )}
        {detail && detail.steps.length > 0 ? (
          <div className="subagent-steps" data-test="subagent-steps">
            {detail.steps.map((step) => (
              <div key={step.id} className="subagent-step" data-kind={step.kind}>
                <div className="subagent-step-head">
                  <span className="truncate">{step.label}</span>
                  {step.isError && <MorphIcon icon={CircleAlert} className={cn(ICON, 'text-destructive')} />}
                </div>
                {step.input && <pre className="chat-step-pre">{step.input}</pre>}
                {step.output && <pre className="chat-step-pre">{step.output}</pre>}
              </div>
            ))}
          </div>
        ) : (
          <div className="subagent-note">仅实时进展</div>
        )}
        {finalOutput && (
          <pre className="chat-step-pre subagent-final" data-test="subagent-final">
            {finalOutput}
          </pre>
        )}
      </div>
    </aside>
  )
}


// 结构分发：props 是 ref 对象 + 结构级标记（都只随 refs 变化 → 每 chunk 几乎全跳过）。
// 行包裹层注册线程 FLIP；ResizeObserver 兜住一切高度变化（含 WC 折叠动画）驱动线程弹簧
export const TimelineEntry = memo(function TimelineEntry({
  entry,
  groupPos,
  isLastAssistant
}: {
  entry: TimelineRef
  groupPos: GroupPos
  isLastAssistant: boolean
}) {
  const key = timelineKey(entry)
  const ref = useRef<HTMLDivElement | null>(null)
  const rise =
    entry.kind === 'message' && useChatStore.getState().messagesById[entry.id]?.role === 'user'
  useLayoutEffect(() => {
    const el = ref.current!
    registerThreadRow(key, el, { rise })
    const ro = new ResizeObserver(() => scheduleThreadFlip())
    ro.observe(el)
    return () => {
      ro.disconnect()
      unregisterThreadRow(key)
    }
  }, [key, rise])
  let inner: ReactNode
  if (entry.kind === 'message') inner = <MessageRow id={entry.id} groupPos={groupPos} isLastAssistant={isLastAssistant} />
  else if (entry.kind === 'tool') inner = <ToolRow toolKey={entry.key} />
  else if (entry.kind === 'task') inner = <TaskRow taskId={entry.taskId} />
  else if (entry.kind === 'thinking') inner = <ThinkingRow thinkingKey={entry.key} />
  else inner = <CompactionRow seq={entry.seq} />
  return (
    <div ref={ref} className="chat-thread-row" data-gpos={groupPos ?? undefined}>
      {inner}
    </div>
  )
})
