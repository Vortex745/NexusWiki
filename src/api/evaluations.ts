/**
 * Eval refactor Ticket 04 — evaluation HTTP API.
 *
 *   GET  /api/evaluation-datasets   built-in samples + default model info
 *   POST /api/evaluations           validate + register a task, return at once
 *   GET  /api/evaluations           list the caller's tasks in this process
 *   GET  /api/evaluations/:id       task detail (owned tasks only)
 *   POST /api/evaluations/:id/cancel  ticket 25: cancel a running task
 *   GET  /api/evaluations/:id/export  ticket 28: settled report as JSON/CSV
 *   POST /api/evaluations/compare     ticket 28: two configurations, one dataset
 *   POST /api/evaluations/comparison-example  ticket 28: built-in Rerank on/off
 *
 * The API only validates input, checks identity/scope, and submits/queries.
 * Every long-running step lives in the service (spec "API 只做输入校验、身份
 * 检查与任务提交/查询").
 *
 * Ownership: the task records the creating identity (tenant + subject) and a
 * read from another identity is a 404 — the search space is never revealed.
 * Creation requires the `admin` scope; in single-tenant mode the deterministic
 * local context holds it.
 */

import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import {
  EvaluationCapacityError,
  EvaluationComparisonConflictError,
  EvaluationRequestError,
  EvaluationShuttingDownError,
  type EvaluationService,
} from "../evaluation/service"
import { EvalDatasetValidationError } from "../evaluation/dataset"
import { EVAL_TASK_TERMINAL_STAGES } from "../evaluation/contracts"
import type { EvalAssistantSnapshot } from "../evaluation/contracts"
import { builtinEvalAssistantSnapshot } from "../evaluation/assistant_snapshots"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function requireAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: admin" })
    return false
  }
  return true
}

/**
 * Ticket 28 (EVAL-02A): resolve a request's assistant id into an immutable
 * snapshot. Built-in comparison ids resolve here; a stored assistant version is
 * resolved by the composition root (it owns the assistant service), which
 * answers `"archived"` for an archived assistant — the same 409 the chat path
 * gives.
 */
export interface EvaluationsRouterDeps {
  resolveAssistant?: (
    context: AccessContext,
    assistantId: string,
    version: unknown
  ) => EvalAssistantSnapshot | "archived" | null
}

export function createEvaluationsRouter(
  service: EvaluationService,
  deps: EvaluationsRouterDeps = {}
): Router {
  const router = Router()

  router.get("/evaluation-datasets", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    res.json(service.describeDatasets())
  })

  router.post("/evaluations", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const assistantResolution = resolveAssistant(deps, ctx, body)
    if ("status" in assistantResolution) {
      res.status(assistantResolution.status).json(assistantResolution.body)
      return
    }
    try {
      const summary = service.createTask(
        {
          ...("datasetId" in body ? { datasetId: body.datasetId } : {}),
          ...("dataset" in body ? { dataset: body.dataset } : {}),
          // Ticket 11: model ids only. The service validates them against this
          // server's allowlist; no other provider setting is ever read.
          ...("chatModel" in body ? { chatModel: body.chatModel } : {}),
          ...("rerankModel" in body ? { rerankModel: body.rerankModel } : {}),
          // Ticket 28: the resolved immutable assistant configuration.
          ...(assistantResolution.assistant
            ? { assistant: assistantResolution.assistant }
            : {}),
        },
        { tenantId: ctx.tenantId, subjectId: ctx.subjectId }
      )
      // 202: accepted and running in the background — the client polls.
      res.status(202).json(summary)
    } catch (error) {
      if (error instanceof EvalDatasetValidationError) {
        res.status(400).json({ error: error.message, issues: error.issues })
        return
      }
      if (error instanceof EvaluationRequestError) {
        res.status(400).json({ error: error.message, issues: error.issues })
        return
      }
      if (error instanceof EvaluationCapacityError) {
        res.status(429).json({ error: error.message })
        return
      }
      if (error instanceof EvaluationShuttingDownError) {
        // Ticket 14: the process is stopping — retry against the restarted
        // service instead of treating this as a bad request.
        res.status(503).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.get("/evaluations", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    res.json({ tasks: service.listTasks({ tenantId: ctx.tenantId, subjectId: ctx.subjectId }) })
  })

  /**
   * Ticket 28: download a settled report. The response is explicitly an
   * attachment (the page never renders it) and the filename is sent both as an
   * ASCII fallback and as an RFC 5987 UTF-8 name, because dataset names are
   * user text and may be Chinese.
   */
  router.get("/evaluations/:id/export", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    try {
      const exported = service.exportTask(
        String(req.params.id),
        { tenantId: ctx.tenantId, subjectId: ctx.subjectId },
        req.query.format ?? "json"
      )
      if (!exported) {
        res.status(404).json({ error: "evaluation task not found in this process" })
        return
      }
      res.setHeader("Content-Type", exported.contentType)
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="evaluation-${String(req.params.id).slice(0, 8)}.${exported.format}"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`
      )
      res.send(exported.body)
    } catch (error) {
      if (error instanceof EvaluationRequestError) {
        res.status(400).json({ error: error.message, issues: error.issues })
        return
      }
      if (error instanceof EvaluationComparisonConflictError) {
        res.status(409).json({ error: error.message, ...error.detail })
        return
      }
      throw error
    }
  })

  /**
   * Ticket 28: side-by-side comparison of two settled tasks. The service owns
   * the premise (same dataset digest, every case settled) and reports a state
   * conflict as 409 with both digests, so the page can explain it.
   */
  router.post("/evaluations/compare", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const leftTaskId = body.leftTaskId
    const rightTaskId = body.rightTaskId
    if (
      typeof leftTaskId !== "string" ||
      !leftTaskId.trim() ||
      typeof rightTaskId !== "string" ||
      !rightTaskId.trim()
    ) {
      res.status(400).json({
        error: "leftTaskId and rightTaskId are required",
        issues: ["leftTaskId", "rightTaskId"],
      })
      return
    }
    try {
      const comparison = service.compareTasks(leftTaskId, rightTaskId, {
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
      })
      if (!comparison) {
        res.status(404).json({ error: "evaluation task not found in this process" })
        return
      }
      res.json(comparison)
    } catch (error) {
      if (error instanceof EvaluationComparisonConflictError) {
        res.status(409).json({ error: error.message, ...error.detail })
        return
      }
      throw error
    }
  })

  /** Ticket 28: run the built-in Rerank enabled/disabled example pair. */
  router.post("/evaluations/comparison-example", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const created = service.createComparisonExample(
        { tenantId: ctx.tenantId, subjectId: ctx.subjectId },
        {
          ...("datasetId" in body ? { datasetId: body.datasetId } : {}),
        }
      )
      // 202: both tasks are running in the background — the client polls them
      // and then asks for the comparison.
      res.status(202).json(created)
    } catch (error) {
      if (error instanceof EvalDatasetValidationError) {
        res.status(400).json({ error: error.message, issues: error.issues })
        return
      }
      if (error instanceof EvaluationRequestError) {
        res.status(400).json({ error: error.message, issues: error.issues })
        return
      }
      if (error instanceof EvaluationCapacityError) {
        res.status(429).json({ error: error.message })
        return
      }
      if (error instanceof EvaluationShuttingDownError) {
        res.status(503).json({ error: error.message })
        return
      }
      throw error
    }
  })

  /**
   * Ticket 25 (EVAL-01A): cancel a running task. 404 for an unknown or
   * foreign id (same answer as GET), 409 when the task already reached a
   * terminal stage (its result is settled and a cancel may not rewrite it),
   * and 202 with the current state otherwise — the client keeps polling and
   * sees the one terminal state the run converges to.
   */
  router.post("/evaluations/:id/cancel", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const before = service.getTask(String(req.params.id), {
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
    })
    if (!before) {
      res.status(404).json({ error: "evaluation task not found in this process" })
      return
    }
    if (EVAL_TASK_TERMINAL_STAGES.includes(before.stage)) {
      res.status(409).json({ error: "evaluation task already finished", stage: before.stage })
      return
    }
    const detail = service.cancelTask(String(req.params.id), {
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
    })
    if (!detail) {
      res.status(404).json({ error: "evaluation task not found in this process" })
      return
    }
    res.status(202).json(detail)
  })

  router.get("/evaluations/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const detail = service.getTask(String(req.params.id), {
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
    })
    if (!detail) {
      // Unknown id OR another identity's task — never reveal which.
      res.status(404).json({ error: "evaluation task not found in this process" })
      return
    }
    res.json(detail)
  })

  return router
}

type AssistantResolution =
  | { assistant?: EvalAssistantSnapshot }
  | { status: number; body: Record<string, unknown> }

function resolveAssistant(
  deps: EvaluationsRouterDeps,
  ctx: AccessContext,
  body: Record<string, unknown>
): AssistantResolution {
  const rawId = body.assistantId
  if (rawId === undefined || rawId === null || rawId === "") return {}
  if (typeof rawId !== "string" || !rawId.trim()) {
    return { status: 400, body: { error: "assistantId must be a non-empty string", issues: ["assistantId"] } }
  }
  const rawVersion = body.assistantVersion
  if (
    rawVersion !== undefined &&
    rawVersion !== null &&
    (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1)
  ) {
    return {
      status: 400,
      body: { error: "assistantVersion must be a positive integer", issues: ["assistantVersion"] },
    }
  }
  const id = rawId.trim()
  const builtin = builtinEvalAssistantSnapshot(id)
  if (builtin) {
    if (rawVersion === undefined || rawVersion === null || rawVersion === builtin.version) {
      return { assistant: { ...builtin } }
    }
    return { status: 404, body: { error: "assistant version not found" } }
  }
  const resolved = deps.resolveAssistant?.(ctx, id, rawVersion) ?? null
  if (resolved === "archived") {
    return { status: 409, body: { error: "assistant is archived" } }
  }
  if (!resolved) {
    return { status: 404, body: { error: "assistant not found in this tenant" } }
  }
  return { assistant: resolved }
}
