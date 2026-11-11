import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useChatStore, selectStreamingActive, groupPositions, selectDelegationChip } from './chat-store.ts'

function reset(): void {
  useChatStore.setState({
    timelineRefs: [],
    messagesById: {},
    toolLinesByKey: {},
    taskLinesById: {},
    compactionsBySeq: {},
    activityByTaskId: {},
    thinkingByKey: {},
    subagentRunsByKey: {},
    recentSubagentKey: null,
    detailSubagentKey: null,
    thinkingTier: 'low',
    availableTiers: ['low', 'high', 'max']
  })
}

test('thinking deltas append to one line without touching message content', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatThinking({ key: 'm1:0', phase: 'start' })
  store.applyChatThinking({ key: 'm1:0', phase: 'delta', delta: '先拆解' })
  store.applyChatThinking({ key: 'm1:0', phase: 'delta', delta: '，再作答' })
  store.applyChatThinking({ key: 'm1:0', phase: 'end' })

  const state = useChatStore.getState()
  assert.equal(state.thinkingByKey['m1:0']!.text, '先拆解，再作答')
  assert.equal(state.thinkingByKey['m1:0']!.phase, 'end')
  assert.equal(state.timelineRefs.filter((r) => r.kind === 'thinking').length, 1, 'one ref per thinking key')
  assert.equal(Object.keys(state.messagesById).length, 0, 'thinking never writes into messagesById')
})

test('history with thinking blocks restores the thinking row before the message', () => {
  reset()
  useChatStore.getState().applyChatHistory({
    messages: [
      { id: 'u', role: 'user', content: '问' },
      { id: 'a', role: 'assistant', content: '答', thinking: '推理文本' }
    ]
  })
  const state = useChatStore.getState()
  assert.equal(state.messagesById['a']!.content, '答')
  assert.equal(state.thinkingByKey['a:history']!.text, '推理文本')
  assert.equal(state.thinkingByKey['a:history']!.phase, 'end')
  assert.deepEqual(
    state.timelineRefs.map((r) => r.kind),
    ['message', 'thinking', 'message']
  )
})

test('thinking row lands before its assistant message when the chunk arrives first', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatChunk({ messageId: 'a1', delta: '答', done: false })
  store.applyChatThinking({ key: 'a1:0', phase: 'start', delta: '推理' })
  assert.deepEqual(
    useChatStore.getState().timelineRefs.map((r) => r.kind),
    ['thinking', 'message']
  )
})

test('reset:true clears the thinking plane', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatThinking({ key: 'm1:0', phase: 'delta', delta: '文本' })
  assert.equal(Object.keys(useChatStore.getState().thinkingByKey).length, 1)
  useChatStore.getState().applyChatHistory({ messages: [], reset: true })
  assert.equal(Object.keys(useChatStore.getState().thinkingByKey).length, 0)
  assert.equal(useChatStore.getState().timelineRefs.length, 0)
})

test('selectStreamingActive: live assistant stream until done', () => {
  reset()
  assert.equal(selectStreamingActive(useChatStore.getState()), false)
  useChatStore.getState().applyChatChunk({ messageId: 'm1', delta: '你', done: false })
  assert.equal(selectStreamingActive(useChatStore.getState()), true)
  useChatStore.getState().applyChatChunk({ messageId: 'm1', delta: '好', done: true, stopReason: 'stop' })
  assert.equal(selectStreamingActive(useChatStore.getState()), false)
})

test('selectStreamingActive: tool start/end flips the signal', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatStream({ kind: 'tool', key: 'm1:0', phase: 'start', toolName: 'write' })
  assert.equal(selectStreamingActive(useChatStore.getState()), true)
  store.applyChatStream({ kind: 'tool', key: 'm1:0', phase: 'end', summary: 'write' })
  assert.equal(selectStreamingActive(useChatStore.getState()), false)
})

test('selectStreamingActive: thinking start/end flips the signal', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatThinking({ key: 'm1:0', phase: 'start' })
  assert.equal(selectStreamingActive(useChatStore.getState()), true)
  store.applyChatThinking({ key: 'm1:0', phase: 'end' })
  assert.equal(selectStreamingActive(useChatStore.getState()), false)
})

test('selectStreamingActive: restored history without stopReason is not live', () => {
  reset()
  useChatStore.getState().applyChatHistory({
    messages: [
      { id: 'u', role: 'user', content: '问' },
      { id: 'a', role: 'assistant', content: '答' }
    ]
  })
  assert.equal(selectStreamingActive(useChatStore.getState()), false)
})

test('dropLastAssistantTurn removes the last assistant turn with its thinking and tool rows', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatHistory({
    messages: [
      { id: 'u1', role: 'user', content: '第一问' },
      { id: 'a1', role: 'assistant', content: '第一答', thinking: '第一推理' }
    ]
  })
  store.applyChatStream({ kind: 'tool', key: 'a1:5', phase: 'end', toolName: 'write', summary: 'write' })
  store.applyChatChunk({ messageId: 'a2', delta: '第二', done: false })
  store.applyChatChunk({ messageId: 'a2', delta: '答', done: true, stopReason: 'stop' })
  store.applyChatThinking({ key: 'a2:0', phase: 'delta', delta: '第二推理' })
  store.applyChatStream({ kind: 'tool', key: 'a2:1', phase: 'end', toolName: 'read', summary: 'read' })

  useChatStore.getState().dropLastAssistantTurn()

  const state = useChatStore.getState()
  assert.equal(state.messagesById['a2'], undefined)
  assert.equal(state.thinkingByKey['a2:0'], undefined)
  assert.equal(state.toolLinesByKey['a2:1'], undefined)
  assert.equal(state.messagesById['u1']!.content, '第一问', 'user message kept')
  assert.equal(state.messagesById['a1']!.content, '第一答', 'earlier assistant turn kept')
  assert.equal(state.thinkingByKey['a1:history']!.text, '第一推理', 'earlier thinking row kept')
  assert.equal(state.toolLinesByKey['a1:5']!.phase, 'end', 'earlier tool row kept')
  assert.deepEqual(
    state.timelineRefs.map((r) => (r.kind === 'message' ? r.id : r.key)),
    ['u1', 'a1:history', 'a1', 'a1:5']
  )
})

test('dropLastAssistantTurn no-ops on an empty timeline', () => {
  reset()
  useChatStore.getState().dropLastAssistantTurn()
  const state = useChatStore.getState()
  assert.equal(state.timelineRefs.length, 0)
  assert.deepEqual(Object.keys(state.messagesById), [])
})

test('dropLastAssistantTurn no-ops without an assistant message and keeps summaries', () => {
  reset()
  useChatStore.getState().applyChatHistory({
    messages: [
      { id: 'u1', role: 'user', content: '问' },
      { id: 's1', role: 'assistant', content: '压缩摘要', summary: true }
    ]
  })
  useChatStore.getState().dropLastAssistantTurn()
  const state = useChatStore.getState()
  assert.equal(state.messagesById['s1']!.summary, true, 'summary entry is not a regenerable turn')
  assert.equal(state.messagesById['u1']!.content, '问')
  assert.equal(state.timelineRefs.length, 2)
})

test('awaitingReply flips on chunk/notice and deleteMessage removes the message with its rows', () => {
  reset()
  const store = useChatStore.getState()
  useChatStore.setState({ awaitingReply: true })
  store.applyChatChunk({ messageId: 'a1', delta: '第一段', done: false })
  let state = useChatStore.getState()
  assert.equal(state.awaitingReply, false, 'any chunk ends the waiting state')
  store.applyChatThinking({ key: 'a1:0', phase: 'start' })
  store.applyChatStream({ key: 'a1:tool', phase: 'start', toolName: 'write' })
  store.deleteMessage('a1')
  state = useChatStore.getState()
  assert.equal(state.messagesById['a1'], undefined)
  assert.equal(state.thinkingByKey['a1:0'], undefined, 'thinking rows of the deleted message go with it')
  assert.equal(state.toolLinesByKey['a1:tool'], undefined, 'tool rows of the deleted message go with it')
  assert.equal(state.timelineRefs.length, 0)
})

test('dropLastAssistantTurn enters the waiting state for the regenerated turn', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatChunk({ messageId: 'a1', delta: '旧答', done: true, stopReason: 'stop' })
  useChatStore.setState({ awaitingReply: false })
  store.dropLastAssistantTurn()
  assert.equal(useChatStore.getState().awaitingReply, true, 'regenerate shows the dots until the new turn starts')
})

test('notice clears the waiting state', () => {
  reset()
  useChatStore.setState({ awaitingReply: true })
  useChatStore.getState().applyChatNotice({ kind: 'model-not-configured', message: '未配置模型' })
  assert.equal(useChatStore.getState().awaitingReply, false)
})

test('tool stream merges update and end into one line and ignores late events', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatStream({ kind: 'tool', key: 'a1:tool', phase: 'start', toolName: 'bash', label: '终端命令', input: 'echo hi' })
  store.applyChatStream({ kind: 'tool', key: 'a1:tool', phase: 'update', output: 'hi\n' })
  store.applyChatStream({
    kind: 'tool',
    key: 'a1:tool',
    phase: 'end',
    output: 'hi\n',
    isError: false,
    durationMs: 12
  })

  const line = useChatStore.getState().toolLinesByKey['a1:tool']!
  assert.equal(line.phase, 'end')
  assert.equal(line.label, '终端命令')
  assert.equal(line.input, 'echo hi')
  assert.equal(line.output, 'hi\n')
  assert.equal(line.isError, false)
  assert.equal(line.durationMs, 12)
  assert.equal(
    useChatStore.getState().timelineRefs.filter((r) => r.kind === 'tool').length,
    1,
    'start/update/end share one timeline row'
  )

  store.applyChatStream({ kind: 'tool', key: 'a1:tool', phase: 'end', output: 'changed' })
  assert.equal(useChatStore.getState().toolLinesByKey['a1:tool']!.output, 'hi\n', 'late terminal event ignored')
})

test('subagent steps form one run and the chip follows recent visibility', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatSubagentStep({
    taskId: 't1',
    seq: 1,
    callId: 'c1',
    phase: 'start',
    agent: 'delegate',
    task: 'say hi'
  })
  store.applyChatSubagentStep({
    taskId: 't1',
    seq: 2,
    callId: 'c1',
    phase: 'update',
    agent: 'delegate',
    progress: { currentTool: 'write', recentOutput: ['ok'], toolCount: 1, tokens: 12 }
  })

  const running = selectDelegationChip(useChatStore.getState())
  assert.equal(running?.text, '正在调用 delegate 子智能体')
  assert.equal(running?.tone, 'running')
  const run = useChatStore.getState().subagentRunsByKey['t1:c1']!
  assert.equal(run.phase, 'running')
  assert.equal(run.progress?.currentTool, 'write')
  assert.equal(run.progress?.toolCount, 1)

  store.applyChatSubagentStep({
    taskId: 't1',
    seq: 3,
    callId: 'c1',
    phase: 'end',
    agent: 'delegate',
    finalOutput: 'done',
    isError: false
  })
  const done = selectDelegationChip(useChatStore.getState())
  assert.equal(done?.text, '子智能体已完成 · delegate')
  assert.equal(done?.tone, 'done')
  assert.equal(useChatStore.getState().subagentRunsByKey['t1:c1']!.finalOutput, 'done')

  store.dismissRecentSubagent()
  assert.equal(selectDelegationChip(useChatStore.getState()), null)
})

test('selectDelegationChip counts concurrent runs and reports failures', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatSubagentStep({ taskId: 't1', seq: 1, callId: 'c1', phase: 'start', agent: 'a' })
  store.applyChatSubagentStep({ taskId: 't2', seq: 1, callId: 'c2', phase: 'start', agent: 'b' })
  const many = selectDelegationChip(useChatStore.getState())
  assert.equal(many?.text, '2 个子智能体运行中')
  assert.equal(many?.tone, 'running')

  store.applyChatSubagentStep({ taskId: 't1', seq: 2, callId: 'c1', phase: 'end', agent: 'a', isError: false })
  const oneLeft = selectDelegationChip(useChatStore.getState())
  assert.equal(oneLeft?.text, '正在调用 b 子智能体', 'a finished run does not mask the running one')

  store.applyChatSubagentStep({ taskId: 't2', seq: 2, callId: 'c2', phase: 'end', agent: 'b', isError: true })
  const failed = selectDelegationChip(useChatStore.getState())
  assert.equal(failed?.text, '子智能体失败 · b')
  assert.equal(failed?.tone, 'failed')

  store.applyChatSubagentStep({ taskId: 't2', seq: 3, callId: 'c2', phase: 'update', agent: 'b', progress: { toolCount: 9 } })
  const run = useChatStore.getState().subagentRunsByKey['t2:c2']!
  assert.equal(run.phase, 'failed')
  assert.equal(run.progress?.toolCount, undefined, 'late update ignored after the terminal step')
})

test('reset: true clears tool lines and every subagent plane', () => {
  reset()
  const store = useChatStore.getState()
  store.applyChatStream({ kind: 'tool', key: 'a1:tool', phase: 'end', toolName: 'write', output: 'x' })
  store.applyChatSubagentStep({ taskId: 't1', seq: 1, callId: 'c1', phase: 'start', agent: 'delegate' })
  store.applyChatSubagentStep({
    taskId: 't1',
    seq: 2,
    callId: 'c1',
    phase: 'end',
    agent: 'delegate',
    finalOutput: 'ok',
    isError: false
  })
  store.openSubagentDetail('t1:c1')
  assert.equal(useChatStore.getState().detailSubagentKey, 't1:c1')

  useChatStore.getState().applyChatHistory({ messages: [], reset: true })
  const state = useChatStore.getState()
  assert.deepEqual(state.subagentRunsByKey, {})
  assert.equal(state.recentSubagentKey, null)
  assert.equal(state.detailSubagentKey, null)
  assert.deepEqual(state.toolLinesByKey, {})
})

test('openSubagentDetail ignores a key without a run', () => {
  reset()
  useChatStore.getState().openSubagentDetail('missing:run')
  assert.equal(useChatStore.getState().detailSubagentKey, null, 'no run means no drawer')
})

test('groupPositions marks adjacent same-role bubbles first/mid/last and singles', () => {
  const messages = {
    u1: { id: 'u1', role: 'user', content: '1', streaming: false },
    u2: { id: 'u2', role: 'user', content: '2', streaming: false },
    u3: { id: 'u3', role: 'user', content: '3', streaming: false },
    a1: { id: 'a1', role: 'assistant', content: 'A', streaming: false },
    s1: { id: 's1', role: 'assistant', content: '摘要', streaming: false, summary: true }
  } as Record<string, import('./chat-store.ts').ChatMessage>
  const refs = [
    { kind: 'message', id: 'u1' },
    { kind: 'message', id: 'u2' },
    { kind: 'message', id: 'u3' },
    { kind: 'message', id: 'a1' },
    { kind: 'message', id: 's1' }
  ] as import('./chat-store.ts').TimelineRef[]
  assert.deepEqual(groupPositions(refs, messages), ['first', 'mid', 'last', 'single', null])
  // 中间插入思考/工具行即断组
  const broken = [
    { kind: 'message', id: 'u1' },
    { kind: 'thinking', key: 't' },
    { kind: 'message', id: 'u2' }
  ] as import('./chat-store.ts').TimelineRef[]
  assert.deepEqual(groupPositions(broken, messages), ['single', null, 'single'])
})
