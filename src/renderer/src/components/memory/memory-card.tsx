import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Button from 'tdesign-react/es/button'
import { LoaderCircle, Pin, PinOff, RefreshCw, X } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { useMemoryStore } from '@/stores/memory-store'
import { Markdown } from '@/components/chat/markdown'

const CARD_WIDTH = 320
const CARD_HEIGHT = 320
const CARD_MIN_WIDTH = 220
const CARD_MIN_HEIGHT = 180
const CARD_MARGIN = 8
// 卡片顶边距视口底的最小留量：保证标题栏（拖动把手+动作键）始终可达
const CARD_BOTTOM_SPACE = 80
// 折射带参数与 index.css 的 .memory-glass 半径一致（rounded-xl）
const CARD_RADIUS = 14
const LENS_EDGE = 44
// feDisplacementMap scale：1.1 倍边宽，边缘实际位移约 scale/2 ≈ 24px
const LENS_SCALE = 48.4

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

// 位移贴图：圆角矩形 SDF，边缘 44px 环带内沿法线向内压，越靠边压得越狠，中间保持平整。
// R 通道控 X 位移、G 通道控 Y 位移，128 为零位移；返回 PNG dataURL 供 feImage 使用
function buildLensMap(width: number, height: number, radius: number, edge: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const image = ctx.createImageData(width, height)
  const data = image.data
  const bx = width / 2 - radius
  const by = height / 2 - radius
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const qx = Math.abs(px + 0.5 - width / 2) - bx
      const qy = Math.abs(py + 0.5 - height / 2) - by
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
      // 圆角矩形 SDF 取负：边缘 0，向内增大
      const depth = radius - outside - Math.min(Math.max(qx, qy), 0)
      const i = (py * width + px) * 4
      let r = 128
      let g = 128
      if (depth > 0 && depth < edge) {
        const falloff = 1 - depth / edge
        const sx = px + 0.5 < width / 2 ? -1 : 1
        const sy = py + 0.5 < height / 2 ? -1 : 1
        let nx = 0
        let ny = 0
        if (qx > 0 && qy > 0) {
          // 角区：法线沿角圆指向外，折射绕角转弯
          const len = Math.hypot(qx, qy)
          nx = (sx * qx) / len
          ny = (sy * qy) / len
        } else if (qx > 0) {
          nx = sx
        } else {
          ny = sy
        }
        r = Math.round(128 + nx * 127 * falloff)
        g = Math.round(128 + ny * 127 * falloff)
      }
      data[i] = r
      data[i + 1] = g
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

// 边缘折射滤镜：同一张贴图按 1.15 / 1.0 / 0.85 三档位移拆出 RGB 三通道再 screen 合成，
// 红光比蓝光多弯一点形成色散。滤镜区外扩 15% 让边缘能采到卡片外的背景
function GlassLensDefs({ map, width, height }: { map: string; width: number; height: number }) {
  return (
    <svg aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
      <filter id="memory-glass-lens" x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
        <feImage href={map} x={0} y={0} width={width} height={height} preserveAspectRatio="none" result="map" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={LENS_SCALE * 1.15}
          xChannelSelector="R"
          yChannelSelector="G"
          result="dispRed"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={LENS_SCALE}
          xChannelSelector="R"
          yChannelSelector="G"
          result="dispGreen"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={LENS_SCALE * 0.85}
          xChannelSelector="R"
          yChannelSelector="G"
          result="dispBlue"
        />
        <feColorMatrix
          in="dispRed"
          type="matrix"
          values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
          result="redOnly"
        />
        <feColorMatrix
          in="dispGreen"
          type="matrix"
          values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
          result="greenOnly"
        />
        <feColorMatrix
          in="dispBlue"
          type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
          result="blueOnly"
        />
        <feBlend in="redOnly" in2="greenOnly" mode="screen" result="redGreen" />
        <feBlend in="redGreen" in2="blueOnly" mode="screen" />
      </filter>
    </svg>
  )
}

// 浮动记忆卡片：钉住时常驻可拖动（位置持久化），未钉住是点击图标打开的临时浮层（点外部关闭）。
// 标题栏是唯一拖动把手，正文区滚动不受影响
export function MemoryCard() {
  const status = useMemoryStore((s) => s.status)
  const content = useMemoryStore((s) => s.content)
  const updatedAt = useMemoryStore((s) => s.updatedAt)
  const pinned = useMemoryStore((s) => s.pinned)
  const pos = useMemoryStore((s) => s.pos)
  const size = useMemoryStore((s) => s.size)
  const error = useMemoryStore((s) => s.error)
  const cardOpen = useMemoryStore((s) => s.cardOpen)
  const setCardOpen = useMemoryStore((s) => s.setCardOpen)
  const setPinned = useMemoryStore((s) => s.setPinned)
  const setPos = useMemoryStore((s) => s.setPos)
  const setSize = useMemoryStore((s) => s.setSize)
  const run = useMemoryStore((s) => s.run)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ px: number; py: number; bx: number; by: number } | null>(null)
  const resize = useRef<{ px: number; py: number; bw: number; bh: number } | null>(null)
  // 缩放期间跳过贴图重建：buildLensMap 逐像素扫整张卡片，每帧重建会拖垮拖动
  const resizingRef = useRef(false)
  const [map, setMap] = useState<{ url: string; width: number; height: number } | null>(null)

  const width = clamp(size?.w ?? CARD_WIDTH, CARD_MIN_WIDTH, window.innerWidth - 2 * CARD_MARGIN)
  const x = clamp(pos?.x ?? window.innerWidth - width - 24, CARD_MARGIN, window.innerWidth - width - CARD_MARGIN)
  const y = clamp(pos?.y ?? 56, CARD_MARGIN, window.innerHeight - CARD_BOTTOM_SPACE)
  const height = clamp(size?.h ?? CARD_HEIGHT, CARD_MIN_HEIGHT, window.innerHeight - y - CARD_MARGIN)

  const rebuildMap = useCallback(() => {
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    const w = Math.round(rect.width)
    const h = Math.round(rect.height)
    // 太矮时收窄折射带宽，避免整面都泡在透镜里；窄到没意义就退回纯模糊
    const edge = Math.min(LENS_EDGE, (Math.min(w, h) - 8) / 2)
    if (w <= 0 || h <= 0 || edge < 8) return
    const url = buildLensMap(w, h, CARD_RADIUS, edge)
    if (!url) return
    // 先解码再挂滤镜，躲开 feImage 异步加载的首帧空贴图位移
    const probe = new Image()
    probe.onload = () => setMap({ url, width: w, height: h })
    probe.src = url
  }, [])

  // 位移贴图随卡片实际尺寸重建。卡片关闭时本组件渲染 null，ref 为空——
  // 所以挂 RO 必须跟着「卡片可见」走，不能只挂一次（ResizeObserver 首次 observe 即回调）
  const cardShown = pinned || cardOpen
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !cardShown) return
    const observer = new ResizeObserver(() => {
      if (resizingRef.current) return
      rebuildMap()
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [cardShown, rebuildMap])

  useEffect(() => {
    if (pinned) return
    const onDown = (e: PointerEvent): void => {
      const card = cardRef.current
      if (card && !card.contains(e.target as Node)) setCardOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [pinned, setCardOpen])

  if (!pinned && !cardOpen) return null

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // 拖动是钉住态的能力：临时卡片位置固定，防止拖一下就把 pinned 静默持久化
    if (!pinned) return
    // 按钮上的按下不进拖动：setPointerCapture 会把后续 click 重定向到标题栏，
    // 取消钉住/重新整理就永远点不到（真机实锤过的 bug）
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { px: e.clientX, py: e.clientY, bx: x, by: y }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const base = drag.current
    if (!base) return
    setPos({
      x: clamp(base.bx + e.clientX - base.px, CARD_MARGIN, window.innerWidth - width - CARD_MARGIN),
      y: clamp(base.by + e.clientY - base.py, CARD_MARGIN, window.innerHeight - CARD_BOTTOM_SPACE)
    })
  }
  const onPointerUp = (): void => {
    if (!drag.current) return
    drag.current = null
    setPinned(true, x, y, width, height)
  }

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizingRef.current = true
    resize.current = { px: e.clientX, py: e.clientY, bw: width, bh: height }
  }
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const base = resize.current
    if (!base) return
    setSize({
      w: clamp(base.bw + e.clientX - base.px, CARD_MIN_WIDTH, window.innerWidth - x - CARD_MARGIN),
      h: clamp(base.bh + e.clientY - base.py, CARD_MIN_HEIGHT, window.innerHeight - y - CARD_MARGIN)
    })
  }
  const onResizeUp = (): void => {
    if (!resize.current) return
    resize.current = null
    resizingRef.current = false
    rebuildMap()
    if (pinned) {
      const latest = useMemoryStore.getState().size
      setPinned(true, x, y, latest?.w ?? width, latest?.h ?? height)
    }
  }

  return (
    <>
      {map && <GlassLensDefs map={map.url} width={map.width} height={map.height} />}
      <div
        ref={cardRef}
        data-test="memory-card"
        className={`memory-glass${map ? '' : ' memory-glass-fallback'} fixed z-50 flex flex-col rounded-xl`}
        style={{ left: x, top: y, width, height }}
      >
        <div
          className={`flex shrink-0 items-center gap-1 border-b border-black/5 px-3 py-2 dark:border-white/10${
            pinned ? ' cursor-grab active:cursor-grabbing' : ''
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="memory-glass-ink flex-1 truncate text-xs font-medium">长期记忆</span>
          {updatedAt && <span className="memory-glass-sub text-xs">{new Date(updatedAt).toLocaleString()}</span>}
          <Button
            variant="text"
            size="small"
            aria-label="重新整理"
            data-test="memory-rerun"
            disabled={status === 'summarizing'}
            onClick={run}
          >
            <MorphIcon
              icon={status === 'summarizing' ? LoaderCircle : RefreshCw}
              size="1em"
              className={status === 'summarizing' ? 'animate-spin' : undefined}
            />
          </Button>
          <Button
            variant="text"
            size="small"
            aria-label={pinned ? '取消钉住' : '钉住'}
            data-test="memory-pin"
            // 取消钉住即关闭：钉住卡片的唯一出口，不留在临时态再要一次单独关闭
            onClick={() => (pinned ? (setPinned(false), setCardOpen(false)) : setPinned(true, x, y, width, height))}
          >
            {/* Pin↔PinOff 是状态对：DESIGN 规则 2 静态渲染，key 重挂载禁掉 morph 动画 */}
            <MorphIcon key={pinned ? 'pin-off' : 'pin'} icon={pinned ? PinOff : Pin} size="1em" />
          </Button>
          {!pinned && (
            <Button variant="text" size="small" aria-label="关闭" data-test="memory-close" onClick={() => setCardOpen(false)}>
              <MorphIcon icon={X} size="1em" />
            </Button>
          )}
        </div>
        <div className="memory-glass-ink memory-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {status === 'summarizing' ? (
            <p className="memory-glass-sub text-xs">正在整理记忆…</p>
          ) : content ? (
            <Markdown content={content} />
          ) : (
            <p className="memory-glass-sub text-xs">暂无记忆，开始对话后自动生成</p>
          )}
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
        <div
          className="memory-resize"
          data-test="memory-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      </div>
    </>
  )
}
