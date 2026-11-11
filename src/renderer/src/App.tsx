import { useCallback, useEffect, useLayoutEffect } from 'react'
import Alert from 'tdesign-react/es/alert'
import Button from 'tdesign-react/es/button'
import { RadioGroup } from 'tdesign-react/es/radio'
import { PenLine } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { ChatInput } from '@/components/chat/chat-input'
import {
  DelegationChip,
  ProcessGroup,
  SubagentDetailDrawer,
  TimelineEntry,
  groupProcessRefs
} from '@/components/chat/rows'
import { ReplyDots } from '@/components/chat/chat-dots'
import { BubbleMenuHost } from '@/components/chat/chat-menu'
import { SessionMenu } from '@/components/chat/session-menu'
import { MemoryButton } from '@/components/memory/memory-button'
import { useChatStore, groupPositions, timelineKey } from '@/stores/chat-store'
import { useRagStore, type RagView } from '@/stores/rag-store'
import { AdminView } from '@/components/admin/admin-view'
import { notifyContentGrew, registerScrollElement } from '@/lib/chat-scroll'
import { bindThreadContainer, runThreadFlip } from '@/lib/chat-flip'

export function App() {
  const refs = useChatStore((s) => s.timelineRefs)
  // 最后一个 assistant 消息的 id：选择器返回原始值，chunk 改写消息内容不会触发重渲染，
  // 仅结构变化（refs 增删）时变化
  const lastAssistantId = useChatStore((s) => {
    for (let i = s.timelineRefs.length - 1; i >= 0; i--) {
      const ref = s.timelineRefs[i]
      if (ref.kind !== 'message') continue
      const message = s.messagesById[ref.id]
      if (message && message.role === 'assistant' && !message.summary) return message.id
    }
    return null
  })
  const awaitingReply = useChatStore((s) => s.awaitingReply)
  const notice = useChatStore((s) => s.notice)
  const applyChatChunk = useChatStore((s) => s.applyChatChunk)
  const applyChatStream = useChatStore((s) => s.applyChatStream)
  const applyChatTaskActivity = useChatStore((s) => s.applyChatTaskActivity)
  const applyChatNotice = useChatStore((s) => s.applyChatNotice)
  const applyChatTaskEvent = useChatStore((s) => s.applyChatTaskEvent)
  const applyChatCompaction = useChatStore((s) => s.applyChatCompaction)
  const applyChatHistory = useChatStore((s) => s.applyChatHistory)
  const applyChatThinking = useChatStore((s) => s.applyChatThinking)
  const applyChatSubagentStep = useChatStore((s) => s.applyChatSubagentStep)
  const view = useRagStore((s) => s.view)
  const setView = useRagStore((s) => s.setView)
  const applyRagImportEvent = useRagStore((s) => s.applyImportEvent)

  useEffect(() => window.api.onChatChunk(applyChatChunk), [applyChatChunk])
  useEffect(() => window.api.onChatStream(applyChatStream), [applyChatStream])
  useEffect(() => window.api.onChatTaskActivity(applyChatTaskActivity), [applyChatTaskActivity])
  useEffect(() => window.api.onChatNotice(applyChatNotice), [applyChatNotice])
  useEffect(() => window.api.onChatTaskEvent(applyChatTaskEvent), [applyChatTaskEvent])
  useEffect(() => window.api.onChatCompaction(applyChatCompaction), [applyChatCompaction])
  useEffect(() => window.api.onChatHistory(applyChatHistory), [applyChatHistory])
  useEffect(() => window.api.onChatThinking(applyChatThinking), [applyChatThinking])
  useEffect(() => window.api.onChatSubagentStep(applyChatSubagentStep), [applyChatSubagentStep])
  useEffect(() => window.api.onRagImportEvent(applyRagImportEvent), [applyRagImportEvent])
  useEffect(() => {
    window.api
      .getChatStatus()
      .then((s) => {
        useChatStore.setState({ thinkingTier: s.thinkingTier, availableTiers: s.availableTiers })
      })
      .catch(() => {})
  }, [])

  // 结构变更（长度+尾项+等待态）触发钉底滚动与线程 FLIP；chunk 内容增长由
  // 行级 ResizeObserver 经 scheduleThreadFlip 驱动（同帧 rAF 合并）
  const lastRef = refs[refs.length - 1]
  useEffect(() => {
    notifyContentGrew()
  }, [refs.length, lastRef])
  useLayoutEffect(() => {
    runThreadFlip()
  }, [refs.length, lastRef, awaitingReply])

  const groupPos = groupPositions(refs, useChatStore.getState().messagesById)
  const blocks = groupProcessRefs(refs)
  // 稳定引用：内联 ref 回调每次渲染都会被 React 以 null 重挂，会把滚动/线程容器打断
  const scrollerRef = useCallback((el: HTMLDivElement | null) => {
    registerScrollElement(el)
    bindThreadContainer(el)
  }, [])

  return (
    <div className="app-ui flex h-svh w-full flex-col overflow-hidden" data-test="app">
      <header className="titlebar flex h-12 shrink-0 items-center justify-between px-4" data-test="header">
        <span className="text-sm font-medium">Super Agent</span>
        <div className="titlebar-controls flex items-center gap-1" data-no-drag>
          <Button
            variant="text"
            size="small"
            icon={<MorphIcon icon={PenLine} size="1em" />}
            aria-label="新会话"
            data-test="new-session"
            onClick={() => void window.api.newChatSession()}
          />
          <SessionMenu />
          <DelegationChip />
          <div data-test="view-switch">
            <RadioGroup<RagView>
              size="small"
              theme="button"
              variant="default-filled"
              value={view}
              onChange={(v) => setView(v)}
              options={[
                { label: '聊天', value: 'chat' },
                { label: '后台', value: 'admin' }
              ]}
            />
          </div>
          <MemoryButton />
        </div>
      </header>
      {notice && (
        <Alert
          theme={notice.kind === 'router-error' ? 'error' : 'warning'}
          message={notice.message}
          className="app-notice"
          data-test="notice"
        />
      )}
      {view === 'admin' ? (
        <AdminView />
      ) : (
        <>
          <div className="chat-view relative flex min-h-0 flex-1 flex-col overflow-hidden" data-test="chat-view">
            <div
              ref={scrollerRef}
              className="chat-thread-scroll flex-1 overflow-y-auto px-12 py-6"
              data-test="timeline"
            >
              <div className="chat-thread mx-auto flex w-full flex-col" data-test="thread">
                {blocks.map((block) =>
                  block.kind === 'group' ? (
                    <ProcessGroup
                      key={`process:${block.anchor}:${timelineKey(block.entries[0]!.entry)}`}
                      entries={block.entries}
                    />
                  ) : (
                    <TimelineEntry
                      key={timelineKey(block.entry)}
                      entry={block.entry}
                      groupPos={groupPos[block.index] ?? null}
                      isLastAssistant={block.entry.kind === 'message' && block.entry.id === lastAssistantId}
                    />
                  )
                )}
                {awaitingReply && <ReplyDots />}
              </div>
            </div>
            <ChatInput onSend={useChatStore.getState().sendMessage} />
          </div>
          <SubagentDetailDrawer />
          <BubbleMenuHost />
        </>
      )}
    </div>
  )
}

export default App
