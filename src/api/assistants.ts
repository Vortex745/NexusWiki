/**
 * Ticket 18 (AST-01A) — assistant workspace HTTP API.
 *
 *   GET    /api/assistants                 visible list (reader payload omits config)
 *   POST   /api/assistants                 admin — create with validated config (version 1)
 *   GET    /api/assistants/:id             visible member (admin gets config)
 *   PATCH  /api/assistants/:id             admin — metadata edit and/or new immutable version
 *   POST   /api/assistants/:id/archive     admin
 *   POST   /api/assistants/:id/restore     admin
 *   DELETE /api/assistants/:id            admin — physical delete (default assistant → 409)
 *   PUT    /api/assistants/:id/sidebar-visible  admin — sidebar curation flag (default → 409)
 *   GET    /api/assistants/:id/versions    visible member (admin sees configs)
 *   GET    /api/assistants/:id/versions/:version  visible member (admin sees config)
 *
 * Reader payloads deliberately omit the execution configuration (prompt,
 * knowledge bindings, model/tool policy) — that is server-executed
 * configuration, not reader-visible content. Unknown id, another tenant's id
 * and a group-invisible id are the same 404.
 */

import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import {
  AssistantArchivedError,
  AssistantDefaultError,
  AssistantNotFoundError,
  InvalidAssistantCommandError,
  type Assistant,
  type AssistantService,
  type AssistantVersion,
} from "../assistants/assistant_service"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function isAdmin(ctx: AccessContext): boolean {
  return ctx.scopes.includes("admin")
}

function requireAdmin(ctx: AccessContext, res: Response): boolean {
  if (!isAdmin(ctx)) {
    res.status(403).json({ error: "missing scope: admin" })
    return false
  }
  return true
}

interface AssistantBody {
  id: string
  name: string
  description: string
  status: Assistant["status"]
  sidebarVisible: boolean
  currentVersion: number
  createdAt: string
  updatedAt: string
  allowedGroups?: string[]
  config?: Record<string, unknown>
  version?: { version: number; createdAt: string; createdBy: string }
}

function toBody(assistant: Assistant, admin: boolean): AssistantBody {
  const withVersion = assistant as Assistant & {
    version?: AssistantVersion
  }
  const body: AssistantBody = {
    id: assistant.id,
    name: assistant.name,
    description: assistant.description,
    status: assistant.status,
    sidebarVisible: assistant.sidebarVisible,
    currentVersion: assistant.currentVersion,
    createdAt: assistant.createdAt,
    updatedAt: assistant.updatedAt,
  }
  if (admin) {
    body.allowedGroups = assistant.allowedGroups
    if (withVersion.version) {
      body.config = withVersion.version.config as unknown as Record<string, unknown>
      body.version = {
        version: withVersion.version.version,
        createdAt: withVersion.version.createdAt,
        createdBy: withVersion.version.createdBy,
      }
    }
  }
  return body
}

export function createAssistantsRouter(deps: { service: AssistantService }): Router {
  const router = Router()

  router.get("/assistants", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const assistants = deps.service.listForViewer(ctx.tenantId, ctx)
    res.json({ assistants: assistants.map((a) => toBody(a, isAdmin(ctx))) })
  })

  router.post("/assistants", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const created = deps.service.create(ctx.tenantId, ctx.subjectId, {
        name: body.name,
        description: body.description,
        allowedGroups: body.allowedGroups,
        config: body.config,
      })
      res.status(201).json({ assistant: toBody(created, true) })
    } catch (error) {
      if (error instanceof InvalidAssistantCommandError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.get("/assistants/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const assistant = deps.service.get(String(req.params.id), ctx.tenantId)
    // Unknown, cross-tenant and group-invisible are the same 404.
    if (!assistant || !deps.service.visibleTo(assistant, ctx)) {
      res.status(404).json({ error: "assistant not found" })
      return
    }
    res.json({ assistant: toBody(assistant, isAdmin(ctx)) })
  })

  router.patch("/assistants/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const edited = deps.service.edit(String(req.params.id), ctx.tenantId, ctx.subjectId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.allowedGroups !== undefined ? { allowedGroups: body.allowedGroups } : {}),
        ...(body.config !== undefined ? { config: body.config } : {}),
      })
      res.json({ assistant: toBody(edited, true) })
    } catch (error) {
      if (error instanceof InvalidAssistantCommandError) {
        res.status(400).json({ error: error.message })
        return
      }
      if (error instanceof AssistantNotFoundError) {
        res.status(404).json({ error: "assistant not found" })
        return
      }
      if (error instanceof AssistantArchivedError) {
        res.status(409).json({ error: "assistant is archived" })
        return
      }
      throw error
    }
  })

  for (const action of ["archive", "restore"] as const) {
    router.post(`/assistants/:id/${action}`, (req: Request, res: Response) => {
      const ctx = resolveContext(res)
      if (!requireAdmin(ctx, res)) return
      try {
        const assistant =
          action === "archive"
            ? deps.service.archive(String(req.params.id), ctx.tenantId)
            : deps.service.restore(String(req.params.id), ctx.tenantId)
        res.json({ assistant: toBody(assistant, true) })
      } catch (error) {
        if (error instanceof AssistantNotFoundError) {
          res.status(404).json({ error: "assistant not found" })
          return
        }
        throw error
      }
    })
  }

  router.delete("/assistants/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    try {
      deps.service.remove(String(req.params.id), ctx.tenantId)
      res.status(204).end()
    } catch (error) {
      if (error instanceof AssistantDefaultError) {
        res.status(409).json({ error: "默认助手不可删除" })
        return
      }
      if (error instanceof AssistantNotFoundError) {
        res.status(404).json({ error: "assistant not found" })
        return
      }
      throw error
    }
  })

  router.put("/assistants/:id/sidebar-visible", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const body = (req.body ?? {}) as { visible?: unknown }
    if (typeof body.visible !== "boolean") {
      res.status(400).json({ error: "visible must be a boolean" })
      return
    }
    try {
      const updated = deps.service.setSidebarVisible(String(req.params.id), ctx.tenantId, body.visible)
      res.json({ assistant: toBody(updated, true) })
    } catch (error) {
      if (error instanceof AssistantDefaultError) {
        res.status(409).json({ error: "默认助手始终显示，不可取消上架" })
        return
      }
      if (error instanceof AssistantNotFoundError) {
        res.status(404).json({ error: "assistant not found" })
        return
      }
      throw error
    }
  })

  router.get("/assistants/:id/versions", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const assistant = deps.service.get(String(req.params.id), ctx.tenantId)
    if (!assistant || !deps.service.visibleTo(assistant, ctx)) {
      res.status(404).json({ error: "assistant not found" })
      return
    }
    const versions = deps.service.listVersions(String(req.params.id), ctx.tenantId)
    const admin = isAdmin(ctx)
    res.json({
      versions: versions.map((version) => ({
        version: version.version,
        createdAt: version.createdAt,
        createdBy: version.createdBy,
        ...(admin ? { config: version.config } : {}),
      })),
    })
  })

  router.get("/assistants/:id/versions/:version", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const assistant = deps.service.get(String(req.params.id), ctx.tenantId)
    if (!assistant || !deps.service.visibleTo(assistant, ctx)) {
      res.status(404).json({ error: "assistant not found" })
      return
    }
    const versionNumber = Number(req.params.version)
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      res.status(400).json({ error: "version must be a positive integer" })
      return
    }
    const version = deps.service.getVersion(String(req.params.id), ctx.tenantId, versionNumber)
    if (!version) {
      res.status(404).json({ error: "assistant version not found" })
      return
    }
    const admin = isAdmin(ctx)
    res.json({
      version: {
        version: version.version,
        createdAt: version.createdAt,
        createdBy: version.createdBy,
        ...(admin ? { config: version.config } : {}),
      },
    })
  })

  return router
}
