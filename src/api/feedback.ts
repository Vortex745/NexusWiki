/**
 * Ticket 09 P6 + Ticket 29 (EVAL-02B) — Feedback HTTP API.
 *
 *   PUT   /chat/runs/:runId/feedback   submit/update YOUR rating of one answer
 *   GET   /feedback                    reviewer list (filters: status/rating/
 *                                      subjectId/runId)
 *   GET   /feedback/:id                one record, tenant-scoped
 *   PATCH /feedback/:id                move the review state
 *
 * Submission rules (ticket 29):
 *   - the body must name the answered message; malformed bodies are 400;
 *   - the run must exist, belong to the caller and have reached a terminal
 *     result — otherwise 404 (unknown or someone else's run, indistinguishable)
 *     or 409 (no answer yet);
 *   - the session recorded with the feedback is derived from the run's trace,
 *     never from the request body.
 *
 * Review rules: list/detail/state changes require the `review` or `admin`
 * scope, so a reader account cannot browse another user's feedback details.
 * Every read is tenant-scoped; a cross-tenant id answers 404.
 */

import { Router, type Request, type Response } from "express"
import {
  FEEDBACK_STATUSES,
  InvalidFeedbackReasonCodeError,
  InvalidFeedbackStatusError,
  type FeedbackStore,
  type FeedbackUpsertInput,
} from "../answer/feedback_store"
import type { FeedbackTargetResolver } from "../answer/feedback_target"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { FeedbackRating, FeedbackStatus } from "../types/answer"

const VALID_RATINGS: readonly FeedbackRating[] = ["up", "down"]

/** The browser owns message ids; the server only bounds their shape. */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/
const COMMENT_MAX = 2_000
const EVIDENCE_IDS_MAX = 50
const EVIDENCE_ID_MAX = 200

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

/** Spec L1550 pattern: reviewer surfaces need `review` or `admin`. */
function requireReviewOrAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("review") && !ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: review or admin" })
    return false
  }
  return true
}

interface FeedbackRequestBody {
  messageId?: unknown
  rating?: unknown
  reasonCode?: unknown
  comment?: unknown
  evidenceIds?: unknown
}

/**
 * Shape validation of the submitted body. Returns the normalized fields or an
 * issue list — nothing is stored when any of them is malformed.
 */
function validateBody(
  body: FeedbackRequestBody
): { ok: true; messageId: string; rating: FeedbackRating; reasonCode: unknown; comment: string | null; evidenceIds: string[] } | { ok: false; issues: string[] } {
  const issues: string[] = []
  if (typeof body.messageId !== "string" || !MESSAGE_ID_PATTERN.test(body.messageId)) {
    issues.push("messageId must be a message id (letters, digits, . _ : -; at most 100 characters)")
  }
  if (typeof body.rating !== "string" || !VALID_RATINGS.includes(body.rating as FeedbackRating)) {
    issues.push("rating must be \"up\" or \"down\"")
  }
  if (
    body.reasonCode !== undefined &&
    body.reasonCode !== null &&
    typeof body.reasonCode !== "string"
  ) {
    issues.push("reasonCode must be a string or null")
  }
  let comment: string | null = null
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== "string") issues.push("comment must be a string or null")
    else if (body.comment.length > COMMENT_MAX) {
      issues.push(`comment must be at most ${COMMENT_MAX} characters`)
    } else {
      comment = body.comment
    }
  }
  let evidenceIds: string[] = []
  if (body.evidenceIds !== undefined && body.evidenceIds !== null) {
    if (!Array.isArray(body.evidenceIds)) issues.push("evidenceIds must be an array of ids")
    else if (body.evidenceIds.length > EVIDENCE_IDS_MAX) {
      issues.push(`evidenceIds must hold at most ${EVIDENCE_IDS_MAX} ids`)
    } else if (
      body.evidenceIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > EVIDENCE_ID_MAX)
    ) {
      issues.push(`every evidence id must be a non-empty string of at most ${EVIDENCE_ID_MAX} characters`)
    } else {
      evidenceIds = body.evidenceIds as string[]
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    messageId: body.messageId as string,
    rating: body.rating as FeedbackRating,
    // The store validates the reason code itself; an absent field is the null
    // the "up" case requires (undefined would read as a set value).
    reasonCode: body.reasonCode ?? null,
    comment,
    evidenceIds,
  }
}

export function createFeedbackRouter(
  feedbackStore: FeedbackStore,
  deps: { targetResolver: FeedbackTargetResolver }
): Router {
  const router = Router()

  router.put("/chat/runs/:runId/feedback", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const runId = String(req.params.runId)
    const body = (req.body ?? {}) as FeedbackRequestBody

    const validated = validateBody(body)
    if (!validated.ok) {
      res.status(400).json({ error: "invalid feedback body", issues: validated.issues })
      return
    }

    // Ticket 29: the target decides whether this submission may exist at all.
    const target = deps.targetResolver.resolve(runId, {
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
    })
    if (target.resolution === "unknown") {
      // Unknown run and another subject's run answer identically.
      res.status(404).json({ error: "run not found" })
      return
    }
    if (target.resolution === "incomplete") {
      res.status(409).json({ error: "the answer run has not completed yet" })
      return
    }

    const input: FeedbackUpsertInput = {
      runId,
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      messageId: validated.messageId,
      // Server-derived: the trace is the only owner of a run's session.
      sessionId: target.target.sessionId,
      rating: validated.rating,
      reasonCode: validated.reasonCode as FeedbackUpsertInput["reasonCode"],
      comment: validated.comment,
      evidenceIds: validated.evidenceIds,
    }

    try {
      const stored = feedbackStore.upsert(input)
      res.status(200).json(stored)
    } catch (err) {
      if (err instanceof InvalidFeedbackReasonCodeError) {
        res.status(400).json({
          error: "invalid reason code",
          rating: err.rating,
          reasonCode: err.reasonCode,
        })
        return
      }
      throw err
    }
  })

  // GET /feedback?status=&rating=&subjectId=&runId= — review surface (L1550).
  router.get("/feedback", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireReviewOrAdmin(ctx, res)) return

    const status = req.query.status
    if (status !== undefined && !FEEDBACK_STATUSES.includes(status as FeedbackStatus)) {
      res.status(400).json({ error: "invalid status filter", status })
      return
    }
    const rating = req.query.rating
    if (rating !== undefined && !VALID_RATINGS.includes(rating as FeedbackRating)) {
      res.status(400).json({ error: "invalid rating filter", rating })
      return
    }
    const asFilter = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined

    const feedback = feedbackStore.listForReview(ctx.tenantId, {
      ...(status !== undefined ? { status: status as FeedbackStatus } : {}),
      ...(rating !== undefined ? { rating: rating as FeedbackRating } : {}),
      ...(asFilter(req.query.subjectId) ? { subjectId: asFilter(req.query.subjectId)! } : {}),
      ...(asFilter(req.query.runId) ? { runId: asFilter(req.query.runId)! } : {}),
    })
    res.status(200).json({ feedback })
  })

  router.get("/feedback/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireReviewOrAdmin(ctx, res)) return
    const record = feedbackStore.getById(ctx.tenantId, String(req.params.id))
    if (!record) {
      // Unknown id OR another tenant's record — never reveal which.
      res.status(404).json({ error: "feedback not found" })
      return
    }
    res.status(200).json(record)
  })

  router.patch("/feedback/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireReviewOrAdmin(ctx, res)) return
    const body = (req.body ?? {}) as { status?: unknown }
    try {
      const updated = feedbackStore.review(ctx.tenantId, String(req.params.id), body.status)
      if (!updated) {
        res.status(404).json({ error: "feedback not found" })
        return
      }
      res.status(200).json(updated)
    } catch (err) {
      if (err instanceof InvalidFeedbackStatusError) {
        res.status(400).json({
          error: "invalid feedback status",
          status: err.status,
          supported: [...FEEDBACK_STATUSES],
        })
        return
      }
      throw err
    }
  })

  return router
}
