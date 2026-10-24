import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { useConversation } from "../../conversation/useConversation"
import { useMediaQuery } from "../../lib/hooks"
import { Button } from "../primitives/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../primitives/tabs"
import { Drawer, DrawerContent } from "../arc/drawer/drawer"
import { EmptyState } from "../ui/Controls"
import { TraceSteps } from "./TraceSteps"
import { ReferencesPanel, useReferenceHighlight } from "../thread/References"
export function TracePanel({
  open,
  messageId,
  onClose,
  initialTab = "trace",
  referenceId,
}: {
  open: boolean
  messageId: string | null
  onClose: () => void
  initialTab?: "sources" | "trace"
  referenceId?: string
}) {
  const { messages } = useConversation()
  const returnFocus = useRef<HTMLElement | null>(null)
  const isMobile = useMediaQuery("(max-width: 1023px)")
  const [tab, setTab] = useState<string>(initialTab)
  const { rootRef, highlightedId, focusReference } = useReferenceHighlight()
  const message =
    (messageId
      ? messages.find(
          (item) => item.id === messageId && item.role === "assistant",
        )
      : null) ??
    [...messages].reverse().find((item) => item.role === "assistant") ??
    null
  const events = message?.traceEvents ?? []
  useEffect(() => setTab(initialTab), [initialTab, messageId, referenceId])
  useEffect(() => {
    if (open && referenceId) focusReference(referenceId)
  }, [open, referenceId, focusReference])
  const body = (showClose: boolean) => (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <TabsList>
          <TabsTrigger value="sources">
            参考来源 {message?.references.length ?? 0}
          </TabsTrigger>
          <TabsTrigger value="trace">执行链路</TabsTrigger>
        </TabsList>
        {showClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭追踪面板"
            onClick={onClose}
          >
            <X data-icon="inline-start" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <TabsContent value="sources" className="m-0">
          {message?.references.length ? (
            <ReferencesPanel
              references={message.references}
              rootRef={rootRef}
              open
              onToggle={() => {}}
              highlightedId={highlightedId}
            />
          ) : (
            <EmptyState message="本次回答尚无可引用的来源" />
          )}
        </TabsContent>
        <TabsContent value="trace" className="m-0">
          {events.length ? (
            <TraceSteps events={events} />
          ) : (
            <EmptyState
              message={
                message?.status === "running"
                  ? "正在准备回答步骤…"
                  : "发起提问后将实时展示回答步骤"
              }
            />
          )}
        </TabsContent>
      </div>
    </Tabs>
  )
  if (isMobile)
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
      >
        <DrawerContent
          title="回答来源与执行链路"
          closeLabel="关闭追踪面板"
          bodyStyle={{ padding: 0, display: "flex", minHeight: 0, flex: 1 }}
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault()
              returnFocus.current.focus()
            }
          }}
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md"
        >
          {body(false)}
        </DrawerContent>
      </Drawer>
    )
  return open ? (
    <aside
      data-material="evidence-panel"
      aria-label="回答来源与执行链路"
      className="w-88 min-w-0 shrink-0 border-l bg-card xl:w-96"
    >
      {body(true)}
    </aside>
  ) : null
}
