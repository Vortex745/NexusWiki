import { useEffect } from 'react'
import Button from 'tdesign-react/es/button'
import Popup from 'tdesign-react/es/popup'
import { Brain, LoaderCircle } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { useMemoryStore } from '@/stores/memory-store'
import { MemoryCard } from './memory-card'

// 长期记忆入口：header 右上角图标。整理中 LoaderCircle 旋转，完成后同槽变形为 Brain（morphicons）。
// 悬停出预览，点击打开浮动卡片；初始化与事件订阅挂在这里（组件常驻）
export function MemoryButton() {
  const status = useMemoryStore((s) => s.status)
  const content = useMemoryStore((s) => s.content)
  const updatedAt = useMemoryStore((s) => s.updatedAt)
  const pinned = useMemoryStore((s) => s.pinned)
  const cardOpen = useMemoryStore((s) => s.cardOpen)
  const init = useMemoryStore((s) => s.init)
  const applyEvent = useMemoryStore((s) => s.applyEvent)
  const setCardOpen = useMemoryStore((s) => s.setCardOpen)

  useEffect(() => {
    init()
    return window.api.onMemoryEvent(applyEvent)
  }, [init, applyEvent])

  const summarizing = status === 'summarizing'
  const preview =
    summarizing || !content ? (
      <span className="text-xs text-muted-foreground">
        {summarizing ? '正在整理记忆…' : '暂无记忆，开始对话后自动生成'}
      </span>
    ) : (
      <div className="max-w-72">
        <div className="mb-1 text-xs text-muted-foreground">
          更新于 {updatedAt ? new Date(updatedAt).toLocaleString() : '—'}
        </div>
        <div className="line-clamp-6 whitespace-pre-wrap text-xs">{content}</div>
      </div>
    )

  const button = (
    <Button
      variant="text"
      size="small"
      icon={<MorphIcon icon={summarizing ? LoaderCircle : Brain} size="1em" className={summarizing ? 'animate-spin' : undefined} />}
      aria-label="长期记忆"
      data-test="memory-button"
      onClick={() => setCardOpen(!cardOpen)}
    />
  )

  return (
    <>
      {/* 卡片打开/钉住时整块卸掉悬停预览：disabled 只是拦住触发，已弹出的浮层会继续盖住卡片标题栏 */}
      {cardOpen || pinned ? (
        button
      ) : (
        <Popup trigger="hover" placement="bottom-right" showArrow content={preview}>
          {button}
        </Popup>
      )}
      <MemoryCard />
    </>
  )
}
