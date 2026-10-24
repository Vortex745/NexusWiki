import { projectTraceEvents, type TraceEvent } from "@core/conversation"
import { Check, Circle, CircleAlert, Minus } from "lucide-react"
import { TRACE_PATH_STEPS, traceEventLabel } from "../../lib/constants"
import {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
} from "../primitives/trace"
export function TraceSteps({ events }: { events: readonly TraceEvent[] }) {
  const projected = projectTraceEvents(events as TraceEvent[])
  const settled = projected.some((item) => item.stage === "done")
  return (
    <Trace>
      {TRACE_PATH_STEPS.map((step) => {
        const event = [...projected]
          .reverse()
          .find((item) => item.stage === step.stage)
        const status = event?.status ?? (settled ? "skipped" : "pending")
        const StatusIcon =
          status === "completed"
            ? Check
            : status === "failed" || status === "cancelled"
              ? CircleAlert
              : status === "skipped"
                ? Minus
                : Circle
        return (
          <div
            key={step.stage}
            data-trace-status={status}
            className="flex flex-col gap-2 py-3"
          >
            <TraceLine
              status={
                status === "running"
                  ? "running"
                  : status === "failed" || status === "cancelled"
                    ? "error"
                    : status === "pending"
                      ? "pending"
                      : undefined
              }
            >
              <TraceIcon>
                <StatusIcon />
              </TraceIcon>
              <TraceTitle>{step.label}</TraceTitle>
              <TraceDescription>
                {status === "running"
                  ? "进行中"
                  : status === "completed"
                    ? "已完成"
                    : status === "degraded"
                      ? "部分完成"
                      : status === "failed"
                        ? "失败"
                        : status === "cancelled"
                          ? "已停止"
                          : ""}
              </TraceDescription>
            </TraceLine>
            <p className="pl-6 text-xs leading-relaxed text-muted-foreground">
              {event
                ? traceEventLabel(event)
                : settled
                  ? "本路径未使用"
                  : "等待处理"}
            </p>
          </div>
        )
      })}
    </Trace>
  )
}
