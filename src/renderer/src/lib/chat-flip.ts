// 线程 FLIP（第 3 节）：自底向上布局的正文档流 + 连续布局快照。
// 每行记录容器内容坐标 top（随滚动不变）；布局跳变后把行放回视觉原位，
// 用水纹弹簧归零（0.46s/0.74）。只在 transform 上动，绝不动画 top/height/margin。
import { CIRRUS_THREAD, prefersReducedMotion, spring, type SpringCancel } from './chat-spring'

export const DOTS_KEY = '::dots' // 点阵行：新行不升起、不果冻

const RISE_PX = 40 // 第 4 节：发送的气泡从位置下方约 40px 升起
const CASCADE_FIRST_S = 0.06 // 第 6 节：离间隙最近者先约 60ms
const CASCADE_STEP_S = 0.065 // 其上方每行再晚 50-80ms
const BOUNCE = 0.45 // 水纹触底速度保留最多
const CONTACT_PX = 2 // 允许探入组间隙，但距下方消息 2px 处反弹

interface RowState {
  el: HTMLElement
  dy: number // 当前施加的 translateY（弹簧记账，中断续跑靠它）
  rise: boolean // 新行是否从下方 40px 升起（仅发送的用户气泡）
  cancel: SpringCancel | null
}

const rows = new Map<string, RowState>()
const keyByEl = new WeakMap<Element, string>()
const layoutTop = new Map<string, number>()
let container: HTMLElement | null = null
// undefined=无待处理；null=删除行上方无行；string=级联起点（被删行的上一行 key）
let cascadeFrom: string | null | undefined
// 用户主动触发的单次布局跳变（如展开思考正文）：下一次 run 只重建快照、不做 FLIP 补偿
let placeNext = false

function contentTop(el: HTMLElement): number {
  if (!container) return 0
  const cr = container.getBoundingClientRect()
  return el.getBoundingClientRect().top - cr.top + container.scrollTop
}

function clearRow(row: RowState): void {
  row.cancel?.()
  row.cancel = null
  row.dy = 0
  row.el.style.transform = ''
}

function applyTarget(row: RowState, target: number, delay: number): void {
  row.cancel?.()
  if (Math.abs(target) < 0.5) {
    row.cancel = null
    row.dy = 0
    row.el.style.transform = ''
    return
  }
  row.dy = target
  row.el.style.transform = `translateY(${target}px)`
  row.cancel = spring(0, CIRRUS_THREAD, {
    from: target,
    delay,
    onFrame: (v) => {
      row.dy = v
      row.el.style.transform = Math.abs(v) < 0.05 ? '' : `translateY(${v}px)`
    },
    // 只防下沉：删除填隙时行向下越过其下方邻居前钳位反弹（第 6 节）
    constrain: (v) => {
      if (v <= 0) return null
      const belowEl = row.el.nextElementSibling
      if (!(belowEl instanceof HTMLElement)) return null
      const belowKey = keyByEl.get(belowEl)
      const below = belowKey ? rows.get(belowKey) : undefined
      if (!below) return null
      // myLayout = contentTop(row.el) - row.dy（剥掉当前 transform）；下方视觉顶 = contentTop(below.el)
      const limit = contentTop(below.el) - CONTACT_PX - (contentTop(row.el) - row.dy) - row.el.offsetHeight
      if (v > limit) return { value: limit, bounce: BOUNCE }
      return null
    },
    onRest: () => {
      row.cancel = null
      row.dy = 0
      row.el.style.transform = ''
    }
  })
}

export function bindThreadContainer(el: HTMLElement | null): void {
  bindResize()
  // null 只在卸载/内联回调重挂时出现：保持现有容器，等新 el 再重绑（避免中途把 container 打空）
  if (!el) return
  container = el
  for (const row of rows.values()) clearRow(row)
  layoutTop.clear()
}

export function registerThreadRow(key: string, el: HTMLElement, opts?: { rise?: boolean }): void {
  keyByEl.set(el, key)
  rows.set(key, { el, dy: 0, rise: opts?.rise ?? false, cancel: null })
}

export function unregisterThreadRow(key: string): void {
  const row = rows.get(key)
  if (row) {
    row.cancel?.()
    rows.delete(key)
    layoutTop.delete(key)
  }
}

// 删除填隙的级联起点：被删行的上一行 key（无则 null）。下一次 run 消费一次。
export function notifyRemoval(prevKey: string | null): void {
  cascadeFrom = prevKey
}

// 用户主动展开/折叠等一次性布局跳变：清掉在途弹簧与旧快照，下一次 run 直接按新布局放置。
// 不这样做的话，展开会被当成「布局跳变」，FLIP 把上方各行反向拽住再滑回新位置——整块界面抖一下。
export function skipNextThreadFlip(): void {
  for (const row of rows.values()) clearRow(row)
  layoutTop.clear()
  cascadeFrom = undefined
  placeNext = true
}

// 高频触发（行级 ResizeObserver / 流式增长）的 rAF 合并入口：同帧多次只跑一次
let flipQueued = false
export function scheduleThreadFlip(): void {
  if (flipQueued) return
  flipQueued = true
  requestAnimationFrame(() => {
    flipQueued = false
    runThreadFlip()
  })
}

export function runThreadFlip(): void {
  if (!container || rows.size === 0) {
    cascadeFrom = undefined
    return
  }
  const cascade = cascadeFrom
  cascadeFrom = undefined

  // 主动折叠/展开：弹簧已清零，只重建布局快照，不补偿位移
  if (placeNext) {
    placeNext = false
    for (const [key, row] of rows) layoutTop.set(key, contentTop(row.el))
    return
  }

  if (prefersReducedMotion()) {
    // 第 7 节：线程一次性放置
    for (const row of rows.values()) clearRow(row)
    layoutTop.clear()
    for (const [key, row] of rows) layoutTop.set(key, contentTop(row.el))
    return
  }

  // 新行检测：缓存里没有的 key
  let freshCount = 0
  for (const key of rows.keys()) if (!layoutTop.has(key)) freshCount++
  const massPlace = freshCount > 2 // 历史整载/重置：一次性放置，不动画

  // 级联延迟：从级联起点行（含）往上每行 +65ms，起点行 60ms
  const delays = new Map<string, number>()
  if (cascade) {
    const aboveKeys: string[] = []
    for (const key of rows.keys()) {
      aboveKeys.push(key)
      if (key === cascade) break
    }
    for (let i = aboveKeys.length - 1, k = 0; i >= 0; i--, k++) {
      delays.set(aboveKeys[i], CASCADE_FIRST_S + k * CASCADE_STEP_S)
    }
  }

  for (const [key, row] of rows) {
    const newLayout = contentTop(row.el) - row.dy // 剥掉当前 transform 得新布局位
    const old = layoutTop.get(key)
    // 视觉连续：新 transform = 旧布局 + 当前 dy - 新布局；新行走入场路径
    const target = old === undefined ? (massPlace || !row.rise ? 0 : RISE_PX) : old + row.dy - newLayout
    layoutTop.set(key, newLayout)
    applyTarget(row, target, delays.get(key) ?? 0)
  }
  for (const key of [...layoutTop.keys()]) if (!rows.has(key)) layoutTop.delete(key)
}

// 视口尺寸变化让快照失真：全部就位并重建快照，下一次 run 从干净状态开始
let resizeBound = false
function bindResize(): void {
  if (resizeBound) return
  resizeBound = true
  window.addEventListener('resize', () => {
    for (const row of rows.values()) clearRow(row)
    layoutTop.clear()
  })
}
