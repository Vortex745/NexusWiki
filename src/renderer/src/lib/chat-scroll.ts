// 聊天钉底滚动（模块级单例）：pinned 判定（距底 <48px）只在 scroll 事件里读 DOM；
// notifyContentGrew 在 pinned 时经 rAF 写 scrollTop——渲染路径只写不读，无强制布局
let el: HTMLDivElement | null = null
let pinned = true
let frame: number | null = null

const PINNED_GAP_PX = 48

function handleScroll(): void {
  if (!el) return
  pinned = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_GAP_PX
}

export function registerScrollElement(next: HTMLDivElement | null): void {
  el?.removeEventListener('scroll', handleScroll)
  el = next
  el?.addEventListener('scroll', handleScroll)
  pinned = true
}

export function notifyContentGrew(): void {
  if (!el || !pinned || frame !== null) return
  frame = requestAnimationFrame(() => {
    frame = null
    if (!el || !pinned) return
    el.scrollTop = el.scrollHeight
  })
}
