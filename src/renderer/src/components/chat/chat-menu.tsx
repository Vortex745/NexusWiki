// Cirrus 长按菜单（第 6 节）：在气泡下方、发送者一侧弹出，渐霜进入（backdrop 0→blur 36），
// 160-200ms ease-in 离开。经 App 级单例 host 挂 body portal——删除时气泡行整体卸载，
// 菜单的离场动画不受影响（openBubbleMenu/closeBubbleMenu 是模块级开关）。
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MorphIcon } from 'morphicons/react'
import { prefersReducedMotion } from '@/lib/chat-spring'
import { cn } from '@/lib/utils'

export interface BubbleMenuItem {
  key: string
  icon: typeof import('lucide').Copy
  label: string
  danger?: boolean
  onClick: () => void
}

const EXIT_MS = 180

interface ActiveMenu {
  anchor: DOMRect
  side: 'left' | 'right'
  items: BubbleMenuItem[]
  onClosed?: () => void
}

let active: ActiveMenu | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function openBubbleMenu(menu: ActiveMenu): void {
  active?.onClosed?.()
  active = menu
  notify()
}

export function closeBubbleMenu(): void {
  if (!active) return
  const { onClosed } = active
  active = null
  notify()
  onClosed?.()
}

export function isMenuOpen(): boolean {
  return active !== null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// App 树里挂一次；菜单开着时整线程变暗（第 6 节），按住的气泡带 cirrus-pressed 豁免
export function BubbleMenuHost() {
  const menu = useSyncExternalStore(subscribe, () => active)
  useEffect(() => {
    if (!menu) return
    const thread = document.querySelector('.chat-thread')
    thread?.classList.add('cirrus-dimming')
    return () => {
      thread?.classList.remove('cirrus-dimming')
    }
  }, [menu])
  if (!menu) return null
  return <BubbleMenu anchor={menu.anchor} side={menu.side} items={menu.items} onClosed={closeBubbleMenu} />
}

function BubbleMenu({
  anchor,
  side,
  items,
  onClosed
}: {
  anchor: DOMRect
  side: 'left' | 'right'
  items: BubbleMenuItem[]
  onClosed: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [closing, setClosing] = useState(false)

  useLayoutEffect(() => {
    if (!ref.current) return
    // 渐霜（第 6 节卷云菜单）：backdrop 模糊与色调 0→满值；reduced 只淡入
    if (prefersReducedMotion()) {
      ref.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' })
      return
    }
    ref.current.animate(
      [
        { backdropFilter: 'blur(0px) saturate(1)', opacity: 0 },
        { backdropFilter: 'blur(36px) saturate(1.3)', opacity: 1 }
      ],
      { duration: 560, easing: 'ease-out' }
    )
  }, [])

  const close = () => {
    setClosing((was) => {
      if (was) return was
      window.setTimeout(onClosed, EXIT_MS)
      return true
    })
  }

  useEffect(() => {
    if (closing) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onScroll = () => close()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={cn('cirrus-menu', side === 'left' ? 'cirrus-menu-left' : 'cirrus-menu-right', closing && 'cirrus-menu-closing')}
      style={{
        top: anchor.bottom + 8,
        ...(side === 'left'
          ? { left: anchor.left }
          : { right: Math.max(0, window.innerWidth - anchor.right) })
      }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={cn('cirrus-menu-item', item.danger && 'cirrus-menu-danger')}
          onClick={() => {
            close()
            item.onClick()
          }}
        >
          <MorphIcon icon={item.icon} className="h-3.5 w-3.5 shrink-0" />
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}
