// 卷云点阵（第 5 节输入指示器）：6x6、约 48px，回复起始位置（AI 侧）。
// 沿慢圆周（2.2s 一圈）释放温暖：对每个单元格求过去一秒运动轨迹的高斯和，
// 随年龄渐宽渐淡——积分本身就是时间平均（运动模糊）。时间平滑函数，亮度连续变化。
import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/chat-spring'
import { DOTS_KEY, registerThreadRow, unregisterThreadRow } from '@/lib/chat-flip'

const N = 6
const CELL = 6
const GAP = 2 // 6*6 + 5*2 = 46 + 上下 1px 内边距 = 48px
const ORBIT_R = 11 // px
const ORBIT_PERIOD = 2.2 // s 一圈
const TRAIL_S = 1.0 // 过去一秒的沉积
const SAMPLES = 18

export function ReplyDots() {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    registerThreadRow(DOTS_KEY, ref.current!, { rise: false })
    return () => unregisterThreadRow(DOTS_KEY)
  }, [])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const cells = [...root.querySelectorAll<HTMLElement>('.cirrus-dot')]
    const centers = cells.map((_, i) => ({
      x: ((i % N) - (N - 1) / 2) * (CELL + GAP),
      y: (Math.floor(i / N) - (N - 1) / 2) * (CELL + GAP)
    }))
    if (prefersReducedMotion()) {
      // 第 7 节：点阵固定一帧
      const mid = cells[Math.floor(cells.length / 2)]
      if (mid) mid.style.opacity = '0.75'
      return
    }
    let raf = 0
    let last = performance.now()
    let clock = 0
    // 单元亮度 = Σ_k G(距离, t-Δk) ：轨迹点随年龄变宽（σ↑）变淡（w↓）
    const sigmaOf = (age: number): number => 2.0 + 3.4 * age
    const weightOf = (age: number): number => Math.exp(-age * 2.6)
    const tick = (now: number): void => {
      clock += Math.min(0.05, (now - last) / 1000)
      last = now
      for (let i = 0; i < cells.length; i++) {
        let b = 0
        for (let k = 0; k < SAMPLES; k++) {
          const age = (k / (SAMPLES - 1)) * TRAIL_S
          const angle = (2 * Math.PI * (clock - age)) / ORBIT_PERIOD
          const px = ORBIT_R * Math.cos(angle)
          const py = ORBIT_R * Math.sin(angle)
          const d = Math.hypot(centers[i]!.x - px, centers[i]!.y - py)
          const sigma = sigmaOf(age)
          b += weightOf(age) * Math.exp(-(d * d) / (2 * sigma * sigma))
        }
        b /= SAMPLES
        cells[i]!.style.opacity = String(Math.min(1, 0.05 + 5.5 * b))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div ref={ref} className="cirrus-dots" data-test="reply-dots" aria-label="正在回复">
      {Array.from({ length: N * N }, (_, i) => (
        <span key={i} className="cirrus-dot" />
      ))}
    </div>
  )
}
