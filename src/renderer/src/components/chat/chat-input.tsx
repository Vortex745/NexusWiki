import { useRef, useState } from 'react'
import ChatSender from '@tdesign-react/chat/es/chat-sender'
import Select from 'tdesign-react/es/select'
import { SendIcon } from '@animateicons/react/lucide/send-icon'
import { CircleStopIcon } from '@animateicons/react/lucide/circle-stop-icon'
import { useChatStore, selectStreamingActive } from '@/stores/chat-store'
import type { ThinkingTier } from '../../../../shared/protocol.ts'

// 非受控 sender：文本留在 WC 内（受控回写会在中文 IME 组合期打断输入），React 只镜像
// 「有无草稿」驱动发送键禁用态。发送键走 actions 自定义节点（animateicons 动画图标），
// 点击调用 sender.clickSend()——与 Enter 共用 WC 的 loading→stop / 否则→send 路由，
// send/stop 事件仍是唯一出口。锚点留在自控包装节点上。
export function ChatInput({ onSend }: { onSend: (text: string) => void }) {
  const loading = useChatStore(selectStreamingActive)
  const thinkingTier = useChatStore((s) => s.thinkingTier)
  const availableTiers = useChatStore((s) => s.availableTiers)
  const changeThinkingTier = useChatStore((s) => s.changeThinkingTier)
  const senderRef = useRef<HTMLElement | null>(null)
  const [hasDraft, setHasDraft] = useState(false)
  return (
    <div className="chat-input-form px-4 py-2" data-test="chat-input-form">
      <div className="chat-input-shell mx-auto w-full max-w-3xl" data-test="chat-input">
        <ChatSender
          ref={senderRef}
          autosize={{ minRows: 1, maxRows: 6 }}
          loading={loading}
          textareaProps={{ autofocus: true }}
          onChange={(e) => setHasDraft(String(e.detail ?? '').trim().length > 0)}
          onSend={(e) => {
            setHasDraft(false)
            const text = e.detail.value.trim()
            if (!text) return
            onSend(text)
          }}
          onStop={() => void window.api.stopChat()}
          actions={
            <button
              type="button"
              className="chat-send-btn"
              data-test={loading ? 'chat-stop' : 'chat-send'}
              aria-label={loading ? '停止生成' : '发送'}
              disabled={!loading && !hasDraft}
              onClick={() => (senderRef.current as { clickSend(): void } | null)?.clickSend()}
            >
              {loading ? <CircleStopIcon size={18} /> : <SendIcon size={18} />}
            </button>
          }
        >
          {availableTiers.length > 1 && (
            <div slot="footer-prefix" data-test="thinking-tier">
              <Select
                className="tier-select"
                size="small"
                borderless
                autoWidth
                value={thinkingTier}
                onChange={(value) => changeThinkingTier(value as ThinkingTier)}
                options={availableTiers.map((tier) => ({ label: tier, value: tier }))}
              />
            </div>
          )}
        </ChatSender>
      </div>
    </div>
  )
}
