import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { accessContext, requireOperator } from "./operator_guard"
import type { DB } from "../ingestion/tracking/db"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"
import { AssistantService } from "../assistants/assistant_service"
import type { ModelProfileRegistry } from "../models/profiles"
import {
  buildDemoConfigExport,
  importDemoConfig,
  type DemoConfigExport,
  type DemoConfigImportResolutions,
} from "../democonfig/portable_config"

/**
 * Ticket 43 (DEMO-01B): the portable, non-secret demo configuration surface.
 *
 *   GET  /demo-config/export
 *   POST /demo-config/import   { config, dryRun?, resolutions? }
 *
 * Operator-only (AC-01). The export is configuration (slugs, toggles,
 * assistant definitions with slug references) — never credentials,
 * documents, vectors or sessions. The import is a DRY RUN unless the caller
 * explicitly sends dryRun: false; conflicts reject the whole run until each
 * one carries an explicit update/copy resolution.
 */

export function createDemoConfigRouter(deps: {
  db: DB
  knowledgeBases: KnowledgeBaseService
  embeddingProfile: string
  modelProfiles: ModelProfileRegistry
  assistants: AssistantService
}): Router {
  const router = Router()

  router.get("/demo-config/export", (req: Request, res: Response) => {
    const ctx = accessContext(res)
    if (!requireOperator(res)) return
    try {
      const knowledgeBases = deps.knowledgeBases.list(ctx.tenantId)
      const assistants = deps.assistants.listForTenant(ctx.tenantId)
      const payload = buildDemoConfigExport(
        {
          knowledgeBases,
          modelProfiles: deps.modelProfiles.list(),
          assistants: assistants.map((assistant) => ({
            assistant,
            config: assistant.version.config,
          })),
        },
        new Date()
      )
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="demo-config-export.json"'
      )
      res.json(payload)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post("/demo-config/import", (req: Request, res: Response) => {
    const ctx = accessContext(res)
    if (!requireOperator(res)) return
    const body = (req.body ?? {}) as {
      config?: unknown
      dryRun?: unknown
      resolutions?: unknown
    }
    if (typeof body.config !== "object" || body.config === null) {
      res.status(400).json({ error: "body must be { config, dryRun?, resolutions? }" })
      return
    }
    const resolutions: DemoConfigImportResolutions = {}
    if (body.resolutions !== undefined) {
      if (typeof body.resolutions !== "object" || body.resolutions === null) {
        res.status(400).json({ error: "resolutions must map \"kind:slug\" to \"update\"|\"copy\"" })
        return
      }
      for (const [key, value] of Object.entries(body.resolutions as Record<string, unknown>)) {
        if (value !== "update" && value !== "copy") {
          res.status(400).json({
            error: `resolution for ${key} must be "update" or "copy"`,
          })
          return
        }
        resolutions[key] = value
      }
    }
    try {
      const report = importDemoConfig(
        {
          tenantId: ctx.tenantId,
          db: deps.db,
          knowledgeBases: deps.knowledgeBases,
          embeddingProfile: deps.embeddingProfile,
          modelProfiles: deps.modelProfiles,
          assistants: deps.assistants,
          actorId: ctx.subjectId,
          now: () => new Date(),
        },
        body.config as DemoConfigExport,
        { dryRun: body.dryRun !== false, resolutions }
      )
      res.json(report)
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  return router
}
