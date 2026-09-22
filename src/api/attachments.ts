/**
 * Ticket 22 (ATT-01) — the session attachment routes.
 *
 * Mounted under the chat identity gate (/api/chat), so every request is an
 * authorized chat caller. The routes add exactly the two rules the transport
 * owns: the session must belong to the caller (session binder / ownership),
 * and PROMOTION additionally requires the ingestion capability — reading a
 * temporary attachment is chat work, filing it into a knowledge base is
 * import work.
 *
 * Sizes map to honest statuses: 413 for the per-file (20 MB) and session
 * (50 MB) limits, 400 for the five-file cap and empty files, 415 for types
 * outside the supported text set. Parsing is per file: a rejected or failed
 * file never hides the accepted ones.
 */

import express, { Router, type Request, type Response } from "express"

import {
  AttachmentNotPromotableError,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENT_BYTES,
  SessionAttachmentNotFoundError,
  SUPPORTED_ATTACHMENT_EXTENSIONS,
  type AttachmentRejectionKind,
  type SessionAttachmentService,
} from "../attachments/session_attachment_service"
import { SameNameIntentRequiredError } from "../ingestion/lifecycle"
import type { SqliteSessionBinder } from "../access/session_binder"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"

/** 1 MB of slack above the exact 20 MB rule, which the service enforces. */
const RAW_ATTACHMENT_LIMIT = "21mb"

const REJECTION_STATUS: Record<AttachmentRejectionKind, number> = {
  count: 400,
  empty: 400,
  unsupported_type: 415,
  file_size: 413,
  session_size: 413,
}

function accessContextOf(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

/** The chat gate already ran; this re-checks the import capability. */
function allowsPromotion(context: AccessContext): boolean {
  return context.scopes.includes("ingest") || context.scopes.includes("admin")
}

export function createAttachmentsRouter(
  service: SessionAttachmentService,
  sessionBinder?: SqliteSessionBinder,
  knowledgeBases?: KnowledgeBaseService
): Router {
  const router = Router()
  const base = "/chat/sessions/:sessionId/attachments"

  const sessionOf = (req: Request): string => String(req.params.sessionId)

  /**
   * The session must be the caller's. Without a binder (bare mounts) the
   * ownership check still happens on every attachment read/write, because the
   * service scopes by the full (session, tenant, subject) triple.
   */
  const bindSession = (req: Request, res: Response, context: AccessContext): boolean => {
    if (!sessionBinder) return true
    const bound = sessionBinder.bindOrCheck(sessionOf(req), context.tenantId, context.subjectId)
    if (!bound.ok) {
      res.status(409).json({ error: "session binding conflict", sessionId: sessionOf(req) })
      return false
    }
    return true
  }

  router.post(
    base,
    // One file per request, octet-stream — the same transport the knowledge
    // import uses, so no multipart dependency enters the chat path.
    (req, res, next) => {
      express.raw({ type: () => true, limit: RAW_ATTACHMENT_LIMIT })(req, res, (error?: unknown) => {
        if (error && (error as { type?: string }).type === "entity.too.large") {
          res.status(413).json({
            error: {
              kind: "file_size",
              message: `the file exceeds the ${MAX_ATTACHMENT_BYTES} byte per-file limit`,
            },
          })
          return
        }
        if (error) {
          next(error)
          return
        }
        next()
      })
    },
    async (req: Request, res: Response) => {
      const context = accessContextOf(res)
      if (!bindSession(req, res, context)) return
      const name = req.header("x-file-name")?.trim()
      if (!name) {
        res.status(400).json({ error: "x-file-name header is required" })
        return
      }
      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const outcomes = await service.submit(sessionOf(req), context.tenantId, context.subjectId, [
        {
          name,
          ...(req.header("x-file-mime-type")
            ? { mimeType: req.header("x-file-mime-type") as string }
            : {}),
          content,
        },
      ])
      const [outcome] = outcomes
      if (outcome.ok) {
        res.status(201).json({ attachment: outcome.attachment })
        return
      }
      res.status(REJECTION_STATUS[outcome.error.kind]).json({
        error: { kind: outcome.error.kind, message: outcome.error.message },
      })
    }
  )

  router.get(base, (req: Request, res: Response) => {
    const context = accessContextOf(res)
    if (!bindSession(req, res, context)) return
    const attachments = service.list(sessionOf(req), context.tenantId, context.subjectId)
    res.json({
      attachments,
      limits: {
        maxFiles: MAX_ATTACHMENTS_PER_SESSION,
        maxFileBytes: MAX_ATTACHMENT_BYTES,
        maxSessionBytes: MAX_SESSION_ATTACHMENT_BYTES,
        supportedExtensions: [...SUPPORTED_ATTACHMENT_EXTENSIONS],
      },
      usage: {
        live: attachments.filter(
          (attachment) => attachment.status === "parsing" || attachment.status === "ready"
        ).length,
        bytes: attachments
          .filter((attachment) => attachment.status === "parsing" || attachment.status === "ready")
          .reduce((sum, attachment) => sum + attachment.bytes, 0),
      },
    })
  })

  router.post(`${base}/:attachmentId/promote`, (req: Request, res: Response) => {
    const context = accessContextOf(res)
    if (!allowsPromotion(context)) {
      res.status(403).json({ error: "promotion requires the ingest capability" })
      return
    }
    if (!bindSession(req, res, context)) return
    const body = (req.body ?? {}) as { knowledgeBaseId?: unknown; versionIntent?: unknown }
    if (typeof body.knowledgeBaseId !== "string" || body.knowledgeBaseId.trim().length === 0) {
      res.status(400).json({ error: "knowledgeBaseId is required" })
      return
    }
    if (
      body.versionIntent !== undefined &&
      body.versionIntent !== "new_version" &&
      body.versionIntent !== "new_document"
    ) {
      res.status(400).json({ error: "versionIntent must be new_version or new_document" })
      return
    }
    // The target is authorized HERE: it must be the caller's tenant's base and
    // it must be active. A promotion never grows its own scope.
    if (knowledgeBases) {
      const target = knowledgeBases.getById(body.knowledgeBaseId.trim(), context.tenantId)
      if (!target) {
        res.status(404).json({ error: "knowledge base not found" })
        return
      }
      if (target.status === "archived") {
        res.status(409).json({ error: "knowledge base is archived" })
        return
      }
    }
    try {
      const promotion = service.promote(
        String(req.params.attachmentId),
        sessionOf(req),
        context.tenantId,
        context.subjectId,
        {
          knowledgeBaseId: body.knowledgeBaseId.trim(),
          ...(body.versionIntent
            ? { versionIntent: body.versionIntent as "new_version" | "new_document" }
            : {}),
        },
        context.subjectId
      )
      res.status(201).json({
        attachment: promotion.attachment,
        submission: promotion.submission,
      })
    } catch (error) {
      if (error instanceof SessionAttachmentNotFoundError) {
        res.status(404).json({ error: "attachment not found" })
        return
      }
      if (error instanceof AttachmentNotPromotableError) {
        res.status(409).json({ error: error.message, status: error.status })
        return
      }
      if (error instanceof SameNameIntentRequiredError) {
        res.status(409).json({
          error: error.message,
          activeDocId: error.activeDocId,
          activeVersion: error.activeVersion,
          intentRequired: true,
        })
        return
      }
      throw error
    }
  })

  router.delete(`${base}/:attachmentId`, (req: Request, res: Response) => {
    const context = accessContextOf(res)
    if (!bindSession(req, res, context)) return
    try {
      service.remove(String(req.params.attachmentId), sessionOf(req), context.tenantId, context.subjectId)
      res.status(204).end()
    } catch (error) {
      if (error instanceof SessionAttachmentNotFoundError) {
        res.status(404).json({ error: "attachment not found" })
        return
      }
      if (error instanceof AttachmentNotPromotableError) {
        res.status(409).json({
          error: "a promoted attachment belongs to a knowledge base and cannot be removed here",
        })
        return
      }
      throw error
    }
  })

  router.delete(base, (req: Request, res: Response) => {
    const context = accessContextOf(res)
    if (!bindSession(req, res, context)) return
    const report = service.retire(sessionOf(req), context.tenantId, context.subjectId)
    res.json(report)
  })

  return router
}
