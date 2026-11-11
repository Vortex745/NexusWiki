import { create } from 'zustand'
import type { MemoryEvent, MemoryState, MemoryStatus } from '../../../shared/protocol'

// 长期记忆状态：整理状态（图标动画的信号源）+ MEMORY.md 内容 + 浮动卡片钉住态与位置。
// 事件只推状态迁移，内容变化在 idle/error 时经 getMemoryState 回捞
interface MemoryStore {
  status: MemoryStatus
  content: string
  updatedAt: string | null
  pinned: boolean
  pos: { x: number; y: number } | null
  size: { w: number; h: number } | null
  error: string | null
  // 点击图标打开的卡片（钉住的卡片常驻，不受此开关控制）
  cardOpen: boolean
  init: () => void
  applyState: (state: MemoryState) => void
  applyEvent: (event: MemoryEvent) => void
  setCardOpen: (open: boolean) => void
  setPinned: (pinned: boolean, x?: number, y?: number, w?: number, h?: number) => void
  setPos: (pos: { x: number; y: number }) => void
  setSize: (size: { w: number; h: number }) => void
  run: () => void
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  status: 'idle',
  content: '',
  updatedAt: null,
  pinned: false,
  pos: null,
  size: null,
  error: null,
  cardOpen: false,
  init: () => {
    void window.api
      .getMemoryState()
      .then(get().applyState)
      .catch(() => {})
  },
  applyState: (state) =>
    set({
      status: state.status,
      content: state.content,
      updatedAt: state.updatedAt,
      pinned: state.pinned,
      pos: state.pos ?? null,
      size: state.size ?? null,
      error: state.error ?? null
    }),
  applyEvent: (event) => {
    set({ status: event.status })
    if (event.status === 'summarizing') return
    // 终态回捞全量状态（内容在成功后变了；失败时拿 error 文案）
    void window.api
      .getMemoryState()
      .then(get().applyState)
      .catch(() => {})
  },
  setCardOpen: (open) => set({ cardOpen: open }),
  setPinned: (pinned, x, y, w, h) => {
    set(
      x !== undefined && y !== undefined && w !== undefined && h !== undefined
        ? { pinned, pos: { x, y }, size: { w, h } }
        : { pinned }
    )
    void window.api.setMemoryPinned(pinned, x, y, w, h).catch(() => {})
  },
  setPos: (pos) => set({ pos }),
  setSize: (size) => set({ size }),
  run: () => {
    void window.api
      .runMemory()
      .then(get().applyState)
      .catch(() => {})
  }
}))
