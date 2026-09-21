/**
 * Eval refactor Ticket 04 — evaluation HTTP API.
 *
 *   GET  /api/evaluation-datasets   built-in samples + default model info
 *   POST /api/evaluations           validate + register a task, return at once
 *   GET  /api/evaluations           list the caller's tasks in this process
 *   GET  /api/evaluations/:id       task detail (owned tasks only)
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
  EvaluationRequestError,
  type EvaluationService,
} from "../evaluation/service"
import { EvalDatasetValidationError } from "../evaluation/dataset"

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

export function createEvaluationsRouter(service: EvaluationService): Router {
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
    try {
      const summary = service.createTask(
        {
          ...("datasetId" in body ? { datasetId: body.datasetId } : {}),
          ...("dataset" in body ? { dataset: body.dataset } : {}),
          // Ticket 11: model ids only. The service validates them against this
          // server's allowlist; no other provider setting is ever read.
          ...("chatModel" in body ? { chatModel: body.chatModel } : {}),
          ...("rerankModel" in body ? { rerankModel: body.rerankModel } : {}),
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
      throw error
    }
  })

  router.get("/evaluations", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    res.json({ tasks: service.listTasks({ tenantId: ctx.tenantId, subjectId: ctx.subjectId }) })
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
