import {
  projectAnswerProcess,
  type AnswerProcessInput,
} from "@core/answer_process"
import { useState } from "react"
import { Check, CircleAlert, Minus, Sparkles, Square } from "lucide-react"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
} from "../primitives/trace"
import { Button } from "../primitives/button"
import { Separator } from "../primitives/separator"
interface AnswerProcessProps extends AnswerProcessInput {
  onReferenceClick: (referenceId: string) => void
}
const LABELS: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  degraded: "部分完成",
  failed: "未通过或未完成",
  cancelled: "已停止",
  incomplete: "未完成",
  recorded: "已记录",
}
export function AnswerProcess({
  onReferenceClick,
  ...input
}: AnswerProcessProps) {
  const process = projectAnswerProcess(input)
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  const expanded = expandedOverride ?? process.status === "running"
  if (!process.visible) return null
  return (
    <div
      data-answer-process
      data-process-status={process.status}
      className="mb-5 min-w-0 [overflow-wrap:anywhere]"
    >
      <TraceCollapsible open={expanded} onOpenChange={setExpandedOverride}>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={process.status === "running" ? "running" : undefined}
          >
            <TraceIcon>
              <Sparkles />
            </TraceIcon>
            <TraceTitle>回答过程 · {process.statusLabel}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="mt-1 text-xs text-muted-foreground"
        >
          {process.currentLabel}
        </p>
        <TraceCollapsibleContent>
          <Trace aria-label="已发生的处理步骤">
            {process.steps.map((step) => {
              const StatusIcon =
                step.status === "completed"
                  ? Check
                  : step.status === "failed" || step.status === "incomplete"
                    ? CircleAlert
                    : step.status === "cancelled"
                      ? Square
                      : Minus
              return (
                <div
                  key={step.key}
                  data-process-step={step.stage}
                  data-process-status={step.status}
                  className="flex min-w-0 flex-col gap-1"
                >
                  <TraceLine
                    status={
                      step.status === "running"
                        ? "running"
                        : step.status === "failed"
                          ? "error"
                          : undefined
                    }
                  >
                    <TraceIcon>
                      <StatusIcon />
                    </TraceIcon>
                    <TraceTitle>{step.label}</TraceTitle>
                    <TraceDescription>
                      {LABELS[step.status] ?? "已记录"}
                      {step.round !== undefined && step.round > 0
                        ? ` · 第 ${step.round} 轮`
                        : ""}
                    </TraceDescription>
                  </TraceLine>
                  <p className="pl-6 text-xs leading-relaxed">
                    {step.description}
                  </p>
                </div>
              )
            })}
          </Trace>
          {process.answerBasis ? (
            <div data-answer-basis className="mt-4 flex min-w-0 flex-col gap-2">
              <Separator />
              <p className="text-sm font-medium">依据摘要</p>
              <p className="whitespace-pre-wrap text-xs leading-relaxed">
                {process.answerBasis.text}
              </p>
              <div className="flex flex-wrap gap-2">
                {process.answerBasis.referenceIds.map((referenceId) => {
                  const index =
                    input.references?.findIndex(
                      (reference) => reference.id === referenceId,
                    ) ?? -1
                  return (
                    <Button
                      key={referenceId}
                      variant="link"
                      size="xs"
                      onClick={() => onReferenceClick(referenceId)}
                    >
                      查看来源{index >= 0 ? ` ${index + 1}` : ""}
                    </Button>
                  )
                })}
              </div>
            </div>
          ) : null}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </div>
  )
}
