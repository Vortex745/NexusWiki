import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { RetrievalScopeResolver } from "../retrieval/scope"
import { SearcherImpl, type SearchOperations } from "../retrieval/search/searcher"
import type { RetrievalChannel, SearchOptions } from "../retrieval/search/interface"
import { validateChannelSelection } from "../retrieval/search/interface"
import { resolveScopeOrRespond } from "./scope_http"

/**
 * Ticket 14 (RET-01): the read-only retrieval-debug endpoint.
 *
 *   POST /api/retrieval-debug
 *   { query, channels?, knowledgeBaseIds?, hypothesis? }
 *
 * Contract:
 * - The SAME search implementation and configuration chat uses: the searcher
 *   is built from the shared SearchOperations (clients + dedicated reranker),
 *   the knowledge selection is resolved by the SAME server-side scope
 *   resolver as chat, and the caller's AccessContext constrains every channel
 *   — so what a caller sees here is exactly what chat would retrieve.
 * - The operation generates no answer and mutates nothing.
 * - The response distinguishes raw per-channel ranks, the fused order (RRF,
 *   which is also the dedup point), the reranked order and elapsed times.
 * - Unauthorized candidates are absent: authorization happens inside the
 *   channels (tenant + groups + knowledge scope), not by filtering afterwards.
 */

interface DebugRequestBody {
  query?: unknown
  channels?: unknown
  knowledgeBaseIds?: unknown
  hypothesis?: unknown
}

const MAX_QUERY_LENGTH = 2000

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createRetrievalDebugRouter(options: {
  /** Built from the shared SearchOperations — same config as chat. */
  searchOperations?: SearchOperations
  retrievalScopeResolver?: RetrievalScopeResolver
}): Router {
  const { searchOperations, retrievalScopeResolver } = options
  const router = Router()

  router.post("/retrieval-debug", async (req: Request, res: Response) => {
    if (!searchOperations) {
      res.status(503).json({ error: "retrieval-debug is not wired in this deployment" })
      return
    }
    const context = accessContext(res)
    const body = req.body as DebugRequestBody

    const queryText = typeof body.query === "string" ? body.query.trim() : ""
    if (!queryText || queryText.length > MAX_QUERY_LENGTH) {
      res.status(400).json({ error: `query is required (1-${MAX_QUERY_LENGTH} characters)` })
      return
    }
    let channels: RetrievalChannel[]
    try {
      channels = validateChannelSelection(body.channels as RetrievalChannel[] | undefined)
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
      return
    }

    // Same server-side scope resolution as chat (ticket 05): a missing field
    // selects the caller's authorized default knowledge base, `[]` is an
    // explicit "no knowledge context", unknown/cross-tenant ids are 404.
    let retrievalScope
    if (retrievalScopeResolver) {
      const resolved = resolveScopeOrRespond(res, retrievalScopeResolver, context, body.knowledgeBaseIds)
      if (!resolved) return
      retrievalScope = resolved
    } else if (body.knowledgeBaseIds !== undefined) {
      res.status(400).json({ error: "a knowledge selection cannot be honored here" })
      return
    }

    let hypothesis: string | undefined
    if (typeof body.hypothesis === "string") {
      hypothesis = body.hypothesis.trim()
      if (hypothesis.length > MAX_QUERY_LENGTH) {
        res.status(400).json({ error: `hypothesis must be 1-${MAX_QUERY_LENGTH} characters` })
        return
      }
    }

    const searchOptions: SearchOptions = {
      ...(hypothesis ? { hypothesis } : {}),
      accessContext: context,
      channels,
      ...(retrievalScope ? { retrievalScope } : {}),
      debug: true,
    }
    // A fresh SearcherImpl per run — exactly what the chat runners do.
    const searcher = new SearcherImpl(searchOperations)
    const outcome = await searcher.search({ text: queryText }, searchOptions)
    // The outcome's results carry parent chunks with full content; the debug
    // trace payload carries bounded excerpts only.
    res.json({
      status: outcome.status,
      ordering: outcome.ordering ?? null,
      unavailableChannels: outcome.unavailableChannels,
      ...(outcome.unselectedChannels ? { unselectedChannels: outcome.unselectedChannels } : {}),
      ...(outcome.degradationReasons ? { degradationReasons: outcome.degradationReasons } : {}),
      ...(outcome.graphBudget ? { graphBudget: outcome.graphBudget } : {}),
      debug: outcome.debug ?? null,
    })
  })

  return router
}
