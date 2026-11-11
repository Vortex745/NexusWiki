import { useCallback, useEffect, useState } from 'react'
import Button from 'tdesign-react/es/button'
import Dropdown from 'tdesign-react/es/dropdown'
import { History } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import type { ChatSessionSummary } from '../../../../shared/protocol.ts'

// 相对时间弱化展示：列表读本地 jsonl 头，打开时现算，不引时间库
function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  return `${Math.floor(minutes / 1440)} 天前`
}

// 历史会话下拉：每次点开都拉最新列表（list 读 jsonl 头很快），初次 mount 也拉一次；
// 切换成功后刷新以更新 current 标记。空/单条列表照常，不做空态特殊 UI。
export function SessionMenu() {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const refresh = useCallback(() => {
    window.api.listChatSessions().then((r) => setSessions(r.sessions)).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  return (
    <Dropdown
      trigger="click"
      maxColumnWidth={320}
      options={sessions.map((session) => ({
        value: session.id,
        content: (
          <div className="flex w-64 items-center justify-between gap-4">
            <span className={`truncate ${session.current ? 'font-semibold' : ''}`}>{session.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(session.modified)}</span>
          </div>
        )
      }))}
      onClick={(item) => {
        window.api.switchChatSession(item.value as string).then(refresh).catch(() => {})
      }}
    >
      <Button
        variant="text"
        size="small"
        icon={<MorphIcon icon={History} size="1em" />}
        aria-label="历史会话"
        data-test="session-history"
        onClick={refresh}
      />
    </Dropdown>
  )
}
