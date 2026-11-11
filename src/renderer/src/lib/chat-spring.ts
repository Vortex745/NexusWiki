// 水纹材质动画基元：全局单 rAF 循环的单值弹簧积分器。
// 只驱动 transform/opacity 数值，绝不触发布局属性（第 7 节）。
// 新目标从当前位置续跑（中断而非等待）；constrain 支撑删除填隙的触底反弹。

export interface SpringConfig {
  response: number // 自然周期（秒）
  damping: number // 阻尼比，<1 过冲
}

// 线程弹簧（第 3 节卷云 0.5s/0.88）；开泡软弹簧 640ms；长按压抬用快速档
export const CIRRUS_THREAD: SpringConfig = { response: 0.5, damping: 0.88 }
export const CIRRUS_SOFT: SpringConfig = { response: 0.64, damping: 0.8 }
export const CIRRUS_SNAPPY: SpringConfig = { response: 0.22, damping: 0.8 }

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface SpringOptions {
  from?: number
  velocity?: number
  delay?: number // 秒
  onFrame?: (value: number) => void
  onRest?: () => void
  // 每步位置约束：返回 { value, bounce } 时钳位并按 bounce 反接速度（第 6 节「落在下方消息上」）
  constrain?: (value: number) => { value: number; bounce?: number } | null
}

export type SpringCancel = () => void

interface Running {
  x: number
  v: number
  to: number
  k: number
  c: number
  startAt: number
  opts: SpringOptions
}

const running = new Set<Running>()
let rafId: number | null = null
let lastNow = 0

function tick(now: number): void {
  const dt = Math.min(0.05, (now - lastNow) / 1000)
  lastNow = now
  for (const s of running) {
    try {
      if (now < s.startAt) continue
      for (let i = 0; i < 2; i++) {
        const h = dt / 2
        s.v += (-s.k * (s.x - s.to) - s.c * s.v) * h
        s.x += s.v * h
      }
      const limited = s.opts.constrain?.(s.x)
      if (limited && limited.value !== s.x) {
        s.x = limited.value
        s.v = limited.bounce ? -s.v * limited.bounce : 0
      }
      s.opts.onFrame?.(s.x)
      if (Math.abs(s.x - s.to) < 0.1 && Math.abs(s.v) < 8) {
        running.delete(s)
        s.opts.onFrame?.(s.to)
        s.opts.onRest?.()
      }
    } catch (error) {
      // 单个弹簧的回调异常不得杀死整条 rAF 链（否则所有动画冻在中途）
      running.delete(s)
      console.error('chat-spring frame error', error)
    }
  }
  rafId = running.size > 0 ? requestAnimationFrame(tick) : null
}

export function spring(to: number, cfg: SpringConfig, opts: SpringOptions = {}): SpringCancel {
  if (prefersReducedMotion()) {
    opts.onFrame?.(to)
    opts.onRest?.()
    return () => {}
  }
  const stiffness = (2 * Math.PI / cfg.response) ** 2
  const item: Running = {
    x: opts.from ?? 0,
    v: opts.velocity ?? 0,
    to,
    k: stiffness,
    c: 2 * cfg.damping * Math.sqrt(stiffness),
    startAt: performance.now() + (opts.delay ?? 0) * 1000,
    opts
  }
  opts.onFrame?.(item.x)
  running.add(item)
  if (rafId === null) {
    lastNow = performance.now()
    rafId = requestAnimationFrame(tick)
  }
  return () => {
    running.delete(item)
  }
}
