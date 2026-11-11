// 卷云材质气泡效果（第 2/4/6 节 Cirrus 列）：渐霜入场、长按压抬、淡出退场。
// 行级位移由 chat-flip 负责，两层互不干扰。
// 只动 transform/opacity（平底定稿后不再需要 filter/backdrop-filter）。
import { CIRRUS_SNAPPY, prefersReducedMotion, spring, type SpringCancel } from './chat-spring'

// ---- 渐霜（第 4 节发送）：::before 颗粒/色调 0→满值 560ms ease-out（CSS 类），
//      缩放 0.94→1 在 420ms（200ms 处完成淡入）。
//      平底上 backdrop 模糊无像素可采样，原 backdrop 关键帧已删（省每帧全屏重采样）
export function playFrostIn(el: HTMLElement): void {
  el.classList.add('cirrus-frosting')
  window.setTimeout(() => el.classList.remove('cirrus-frosting'), 600)
  if (prefersReducedMotion()) {
    // 第 7 节：保留淡入，移除模糊与缩放
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' })
    return
  }
  el.animate(
    [
      { transform: 'scale(0.94)', opacity: 0, offset: 0 },
      { opacity: 1, offset: 200 / 420 },
      { transform: 'scale(1)', opacity: 1, offset: 1 }
    ],
    { duration: 420, easing: 'ease-out' }
  )
}

// ---- 长按压抬（第 6 节）：快速弹簧，同元素重复调用从当前值续跑
const pressState = new WeakMap<HTMLElement, { value: number; cancel: SpringCancel | null }>()

export function pressBubble(el: HTMLElement, target: number): void {
  const st = pressState.get(el) ?? { value: 1, cancel: null }
  pressState.set(el, st)
  st.cancel?.()
  if (prefersReducedMotion()) {
    st.value = 1
    return
  }
  st.cancel = spring(target, CIRRUS_SNAPPY, {
    from: st.value,
    onFrame: (v) => {
      st.value = v
      el.style.transform = Math.abs(v - 1) < 0.002 ? '' : `scale(${v.toFixed(4)})`
    },
    onRest: () => {
      st.cancel = null
    }
  })
}

// ---- 删除幽灵（第 6 节卷云）：淡出 420ms；行已移出布局，视觉由克隆接管
export function playGhostMelt(bubble: HTMLElement): void {
  const rect = bubble.getBoundingClientRect()
  const ghost = bubble.cloneNode(true) as HTMLElement
  ghost.removeAttribute('data-gpos')
  ghost.style.cssText = [
    'position:fixed',
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    'margin:0',
    'z-index:60',
    'pointer-events:none',
    'transform-origin:center'
  ].join(';')
  document.body.appendChild(ghost)
  const reduced = prefersReducedMotion()
  const anim = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: reduced ? 160 : 420,
    easing: 'ease-out',
    fill: 'forwards'
  })
  anim.finished.then(() => ghost.remove()).catch(() => ghost.remove())
}
