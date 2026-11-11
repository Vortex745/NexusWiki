import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import {
  CHAT_CHUNK_CHANNEL,
  CHAT_COMPACTION_CHANNEL,
  CHAT_HISTORY_CHANNEL,
  CHAT_LIST_SESSIONS_CHANNEL,
  CHAT_NEW_SESSION_CHANNEL,
  CHAT_NOTICE_CHANNEL,
  CHAT_REGENERATE_CHANNEL,
  CHAT_SEND_CHANNEL,
  CHAT_SET_THINKING_LEVEL_CHANNEL,
  CHAT_STOP_CHANNEL,
  CHAT_STATUS_CHANNEL,
  CHAT_STREAM_CHANNEL,
  CHAT_SUBAGENT_DETAIL_CHANNEL,
  CHAT_SUBAGENT_STEP_CHANNEL,
  CHAT_SWITCH_SESSION_CHANNEL,
  CHAT_TASK_ACTIVITY_CHANNEL,
  CHAT_TASK_EVENT_CHANNEL,
  CHAT_THINKING_CHANNEL,
  type AgentMode,
  type ChatCompactionEvent,
  type ChatListSessionsResponse,
  type ChatNoticeEvent,
  type ChatSendRequest,
  type ChatSendResponse,
  type ChatSetThinkingTierRequest,
  type ChatSetThinkingTierResponse,
  type ChatStatusResponse,
  type ChatStreamEvent,
  type ChatSubagentDetailRequest,
  type ChatSubagentDetailResponse,
  type ChatSubagentStepEvent,
  type ChatSwitchSessionRequest,
  type ChatTaskActivityEvent,
  type ChatTaskEvent,
  type ChatThinkingEvent,
  type ThinkingTier,
  SDK_LEVEL_BY_TIER,
  THINKING_TIERS,
  tierForSdkLevel
} from '../../shared/protocol.ts'
import {
  CHAT_CURRENT_SESSION_KEY,
  getSetting,
  getThinkingTierSetting,
  openDb,
  ROUTER_MODEL_KEY,
  setSetting,
  THINKING_TIER_KEY,
  WORKER_MODEL_KEY
} from '../db.ts'
import { searchKnowledgeDigest } from '../rag/retrieval.ts'
import { createRagClientFromSettings } from '../rag/siliconflow.ts'
import { listTasks, recoverInterruptedTasks } from '../tasks/store.ts'
import { createTaskDispatcher } from '../tasks/dispatcher.ts'
import { loadSubagentDetail } from '../tasks/subagent-detail.ts'
import { createRouter, type Router, type ThinkingStatus } from './router.ts'
import { createRouterSlot } from './router-slot.ts'

function sendToWindow(getWindow: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

// SDK 状态 → 产品档位状态：只暴露被三档覆盖的可用档位，UI 据此决定是否显示控件
function toTierStatus(status: ThinkingStatus): ChatStatusResponse {
  return {
    thinkingTier: tierForSdkLevel(status.thinkingLevel),
    availableTiers: THINKING_TIERS.filter((tier) => status.availableLevels.includes(SDK_LEVEL_BY_TIER[tier]))
  }
}

export function registerChatIpc(getWindow: () => BrowserWindow | null): {
  flushToRenderer: (win: BrowserWindow) => void
  rebuildRouterIfIdle: () => void
} {
  const pendingNotices: ChatNoticeEvent[] = []
  const pendingTaskEvents: ChatTaskEvent[] = []
  const pendingCompactions: ChatCompactionEvent[] = []
  let rendererLoaded = false
  const routerSlot = createRouterSlot<Router>()
  // 下一次 createRouter 的会话目标（chat:new-session → new；chat:switch-session → resumeId）；getRouter 取走即清
  let nextRouterTarget: { new: true } | { resumeId: string } | null = null

  const db = openDb()
  // agentDir 与会话文件同目录（userData/pi-agent），不写用户 ~/.pi
  const agentDir = join(app.getPath('userData'), 'pi-agent')
  // 产品只有真实模型一条路；脚本化假模型仅保留给测试与离线验收（SUPER_AGENT_MODE=fake 时启用）
  const agentMode: AgentMode = process.env.SUPER_AGENT_MODE === 'fake' ? 'fake' : 'real'
  // 知识检索客户端只建一次，所有 search_knowledge 调用复用
  const ragClient = createRagClientFromSettings(db)

  // 渲染层就绪后事件直发不再入缓冲（缓冲只在启动窗口期存在，有界）；就绪前入缓冲等 flush 补发
  const onNotice = (event: ChatNoticeEvent): void => {
    if (rendererLoaded) {
      sendToWindow(getWindow, CHAT_NOTICE_CHANNEL, event)
      return
    }
    pendingNotices.push(event)
  }

  // 任务落账由 dispatcher 直写 tasks 表（单一写者）；壳层只缓冲/推渲染层，就绪前入缓冲等 flush 补发
  const onTaskEvent = (event: ChatTaskEvent): void => {
    if (rendererLoaded) {
      sendToWindow(getWindow, CHAT_TASK_EVENT_CHANNEL, event)
      return
    }
    pendingTaskEvents.push(event)
  }

  // 与 notice/task-event 同款缓冲：渲染层就绪前压缩事件入缓冲，flush 时补发
  const onCompaction = (event: ChatCompactionEvent): void => {
    if (rendererLoaded) {
      sendToWindow(getWindow, CHAT_COMPACTION_CHANNEL, event)
      return
    }
    pendingCompactions.push(event)
  }

  // 工具生命周期事件直发不缓冲：只产自活跃 run（用户驱动或任务汇报注入后），启动窗口期不存在
  const onStreamEvent = (event: ChatStreamEvent): void => {
    sendToWindow(getWindow, CHAT_STREAM_CHANNEL, event)
  }

  // 思考内容同样只产自活跃 run：与 chunk 一样高频，但独立通道，delta 绝不双发
  const onThinking = (event: ChatThinkingEvent): void => {
    sendToWindow(getWindow, CHAT_THINKING_CHANNEL, event)
  }

  // 活动预览就绪前直接丢弃不缓冲：预览是瞬时状态，补发旧预览没有意义（任务终态事件会清行）
  const onTaskActivity = (event: ChatTaskActivityEvent): void => {
    if (rendererLoaded) {
      sendToWindow(getWindow, CHAT_TASK_ACTIVITY_CHANNEL, event)
    }
  }

  const onSubagentStep = (event: ChatSubagentStepEvent): void => {
    if (rendererLoaded) {
      sendToWindow(getWindow, CHAT_SUBAGENT_STEP_CHANNEL, event)
    }
  }

  // 任务派发器：dispatch_task 工具的落点，负责任务落账、Worker 生命周期与结果回注
  const dispatcher = createTaskDispatcher({
    db,
    workspaceRoot: join(app.getPath('userData'), 'workspace'),
    agentDir,
    workerMode: agentMode,
    workerModel: getSetting(db, WORKER_MODEL_KEY),
    onTaskEvent,
    onNotice,
    onActivity: onTaskActivity,
    onSubagentStep
  })

  // 启动恢复：Worker 不跨进程存活，重启时仍 running/queued 的任务（幽灵）标记 interrupted，事件随缓冲等渲染层就绪后补发
  recoverInterruptedTasks(db, onTaskEvent)

  const createRouterPromise = async (): Promise<Router> => {
    const target = nextRouterTarget
    nextRouterTarget = null
    // db 里记的当前会话 id 是启动恢复的真相源，不赌 continueRecent 的 mtime 序：
    // mtime 只说明文件最近被写过（外部同步/恢复工具都可能碰它），不说明它就是用户正在用的会话
    const isNewTarget = target !== null && 'new' in target
    const resumeSessionId =
      target && 'resumeId' in target
        ? target.resumeId
        : isNewTarget
          ? undefined
          : (getSetting(db, CHAT_CURRENT_SESSION_KEY) ?? undefined)
    const router = await createRouter({
      mode: agentMode,
      // 假模型流间隔（毫秒）：离线验收需要可观测的流式窗口（停流断言），产品路径恒 0
      fakeStreamDelayMs: Number(process.env.SUPER_AGENT_FAKE_DELAY ?? 0),
      agentDir,
      cwd: app.getPath('userData'),
      sessionDir: agentDir,
      newSession: isNewTarget,
      resumeSessionId,
      realModelId: getSetting(db, ROUTER_MODEL_KEY),
      thinkingLevel: SDK_LEVEL_BY_TIER[getThinkingTierSetting(db)],
      onDispatchTask: (input) => dispatcher.handleDispatch(input),
      onInterruptTask: (taskId) => dispatcher.interrupt(taskId),
      onTaskStatus: (taskId) => listTasks(db, taskId),
      onSearchKnowledge: (query) => searchKnowledgeDigest(db, ragClient, query),
      onChunk: (event) => sendToWindow(getWindow, CHAT_CHUNK_CHANNEL, event),
      onStreamEvent,
      onThinking,
      onNotice,
      onCompaction
    })
    // 每次创建成功都落账当前会话 id：下次启动按它精确恢复，切会话/新会话后 current 标记也以它为准
    setSetting(db, CHAT_CURRENT_SESSION_KEY, router.getSessionId())
    dispatcher.attachRouter(router)
    return router
  }
  const getRouter = (): Promise<Router> => routerSlot.ensure(createRouterPromise)

  ipcMain.handle(CHAT_SEND_CHANNEL, async (_event, request: unknown): Promise<ChatSendResponse> => {
    if (typeof request !== 'object' || request === null || typeof (request as ChatSendRequest).text !== 'string') {
      throw new Error(`invalid ${CHAT_SEND_CHANNEL} request`)
    }
    const router = await getRouter()
    return { messageId: await router.send((request as ChatSendRequest).text) }
  })

  ipcMain.handle(CHAT_STATUS_CHANNEL, async (): Promise<ChatStatusResponse> => {
    const fallback: ChatStatusResponse = {
      thinkingTier: getThinkingTierSetting(db),
      availableTiers: []
    }
    try {
      const router = await getRouter()
      return toTierStatus(router.getThinkingStatus())
    } catch {
      // Router 尚未就绪或创建失败时，档位仍需可读；可用档位为空时 UI 隐藏控件
      return fallback
    }
  })

  // 档位即时生效：写全局设置后调 session.setThinkingLevel，不重建 Router（避免丢掉会话与运行中的流）。
  // SDK 会 clamp 到模型能力并写一条 thinking_level_change，返回实际生效值供 UI 校准。
  ipcMain.handle(
    CHAT_SET_THINKING_LEVEL_CHANNEL,
    async (_event, request: unknown): Promise<ChatSetThinkingTierResponse> => {
      const raw = typeof request === 'object' && request !== null
        ? (request as ChatSetThinkingTierRequest).tier
        : undefined
      const tier: ThinkingTier | undefined = THINKING_TIERS.find((candidate) => candidate === raw)
      if (tier === undefined) {
        throw new Error(`invalid ${CHAT_SET_THINKING_LEVEL_CHANNEL} request`)
      }
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(THINKING_TIER_KEY, tier)
      const router = await getRouter()
      router.setThinkingLevel(SDK_LEVEL_BY_TIER[tier])
      return toTierStatus(router.getThinkingStatus())
    }
  )

  // 新会话：重建 Router 并强制下一次创建走 SessionManager.create（旧会话文件保留在磁盘，此后 continueRecent 只会挑到最新这个）
  ipcMain.handle(CHAT_NEW_SESSION_CHANNEL, async (): Promise<void> => {
    nextRouterTarget = { new: true }
    const captured = routerSlot.current()
    const current = await captured?.catch(() => undefined)
    if (current) routerSlot.release(captured, current, (router) => {
      dispatcher.attachRouter(null)
      router.dispose()
    })
    await getRouter()
    sendToWindow(getWindow, CHAT_HISTORY_CHANNEL, { messages: [], reset: true })
  })

  // 会话列表：SessionManager.list 读本地 jsonl 头（快），modified 降序；current 按 db 键比对
  ipcMain.handle(CHAT_LIST_SESSIONS_CHANNEL, async (): Promise<ChatListSessionsResponse> => {
    const sessions = await SessionManager.list(app.getPath('userData'), agentDir)
    const currentId = getSetting(db, CHAT_CURRENT_SESSION_KEY)
    const summaries = sessions.map((session) => ({
      id: session.id,
      title: session.name?.trim() || session.firstMessage.trim().slice(0, 32) || '（空会话）',
      messageCount: session.messageCount,
      modified: session.modified.toISOString(),
      current: session.id === currentId
    }))
    summaries.sort((a, b) => b.modified.localeCompare(a.modified))
    return { sessions: summaries }
  })

  // 切换会话：dispose 前先 findById 校验（不存在的 id 不重建、不动现有 Router）；
  // dispose 与 reset 推送序列逐字镜像 new-session，区别是 reset 清屏后还要补推目标会话的历史
  ipcMain.handle(CHAT_SWITCH_SESSION_CHANNEL, async (_event, request: unknown): Promise<void> => {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof (request as ChatSwitchSessionRequest).id !== 'string'
    ) {
      throw new Error(`invalid ${CHAT_SWITCH_SESSION_CHANNEL} request`)
    }
    const id = (request as ChatSwitchSessionRequest).id
    // 切到当前会话 no-op：省一次 Router 重建
    if (id === getSetting(db, CHAT_CURRENT_SESSION_KEY)) return
    if (!SessionManager.findById(app.getPath('userData'), id, agentDir)) {
      throw new Error(`会话不存在：${id}`)
    }
    nextRouterTarget = { resumeId: id }
    const captured = routerSlot.current()
    const current = await captured?.catch(() => undefined)
    if (current) routerSlot.release(captured, current, (router) => {
      dispatcher.attachRouter(null)
      router.dispose()
    })
    await getRouter()
    sendToWindow(getWindow, CHAT_HISTORY_CHANNEL, { messages: [], reset: true })
    void getRouter().then((router) => {
      sendToWindow(getWindow, CHAT_HISTORY_CHANNEL, { messages: router.getHistory() })
    })
  })

  // 用户叫停当前回复：Router 空闲时是 no-op，活跃时被叫停的消息以 stopReason='aborted' 终结（非错误）
  ipcMain.handle(CHAT_STOP_CHANNEL, async (): Promise<void> => {
    const router = await getRouter()
    await router.stopRun()
  })

  // 重新生成当前回复：Router 忙碌或无可重发时 handler 抛错，渲染层以 invoke rejection 呈现
  ipcMain.handle(CHAT_REGENERATE_CHANNEL, async (): Promise<string> => {
    const router = await getRouter()
    return router.regenerate()
  })

  ipcMain.handle(
    CHAT_SUBAGENT_DETAIL_CHANNEL,
    async (_event, request: unknown): Promise<ChatSubagentDetailResponse> => {
      if (
        typeof request !== 'object' ||
        request === null ||
        typeof (request as ChatSubagentDetailRequest).taskId !== 'string' ||
        typeof (request as ChatSubagentDetailRequest).callId !== 'string'
      ) {
        throw new Error(`invalid ${CHAT_SUBAGENT_DETAIL_CHANNEL} request`)
      }
      const detail = request as ChatSubagentDetailRequest
      return loadSubagentDetail({ agentDir, taskId: detail.taskId, callId: detail.callId })
    }
  )

  // 启动即建 Router（常驻，持久会话），未配置模型时提示事件先入缓冲，等窗口加载完成再补发
  void getRouter().catch((err) => console.error('[chat] router init failed:', err))

  // 记忆整理完成后的热重建：Router 空闲才重建（resumeSessionId 精确续接同一会话，历史不变，渲染层无需重推）；
  // 忙碌时跳过——新记忆下次启动或切会话生效。不碰 nextRouterTarget（用户挂起的新建/切换意图保持原样）
  const rebuildRouterIfIdle = (): void => {
    void (async () => {
      const captured = routerSlot.current()
      const current = await captured?.catch(() => undefined)
      if (!current || !current.isIdle()) return
      const released = routerSlot.release(captured, current, (router) => {
        dispatcher.attachRouter(null)
        router.dispose()
      })
      if (!released) return
      await getRouter().catch((err) => console.error('[chat] memory rebuild failed:', err))
    })()
  }

  return {
    rebuildRouterIfIdle,
    flushToRenderer: (win: BrowserWindow) => {
      // 幂等守卫：did-finish-load 可能多次触发（如页面重载），二次调用不重放 notice/task-event/history
      if (rendererLoaded) return
      rendererLoaded = true
      for (const notice of pendingNotices.splice(0)) {
        if (!win.isDestroyed()) win.webContents.send(CHAT_NOTICE_CHANNEL, notice)
      }
      for (const event of pendingTaskEvents.splice(0)) {
        if (!win.isDestroyed()) win.webContents.send(CHAT_TASK_EVENT_CHANNEL, event)
      }
      for (const event of pendingCompactions.splice(0)) {
        if (!win.isDestroyed()) win.webContents.send(CHAT_COMPACTION_CHANNEL, event)
      }
      // 历史恢复：渲染层就绪后把恢复会话的消息一次性推给渲染层，此后新消息仍走 chat:chunk
      void getRouter()
        .then((router) => {
          if (!win.isDestroyed()) win.webContents.send(CHAT_HISTORY_CHANNEL, { messages: router.getHistory() })
        })
        .catch((err) => console.error('[chat] history push failed:', err))
    }
  }
}
