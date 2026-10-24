import { Router, type Request, type Response } from "express"
import type { Client } from "@elastic/elasticsearch"
import { resolveChunkIndexName } from "../config"
import type { Driver } from "neo4j-driver"
import { int as neo4jInt } from "neo4j-driver"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"
import type { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import {
  accessContextFilter,
  childFilter,
  filterByKnowledgeBase,
  filterProvenanceByAccessContext,
  knowledgeBaseFilter,
  parseGraphProvenance,
} from "../retrieval/search/searcher"

/**
 * Ticket 37 (GRAPH-01): browse knowledge-scoped graph relations and their
 * provenance.
 *
 *   GET /knowledge-bases/:id/graph/entities?query&limit&offset
 *   GET /knowledge-bases/:id/graph/relations?entity&limit&offset
 *
 * Contract the acceptance criteria live in:
 *
 * 1. Knowledge scope + server-side node limits: the tenant ALWAYS comes from
 *    the AccessContext; an unknown or cross-tenant knowledge base is the same
 *    404 a missing row would be (ticket 08 semantics). Every Neo4j query is
 *    bounded (entity page window, per-entity relation slice, relation page
 *    window) and the ES hydration is bounded — a hub entity cannot freeze
 *    the interface.
 *
 * 2. Shared same-name entities cannot leak another knowledge base's
 *    relations: an entity/relation is visible only when at least one
 *    provenance record authorizes it against (tenant, groups, this ONE
 *    knowledge base) — the SAME parse + filter functions the graph retrieval
 *    channel uses (single source of truth in searcher.ts).
 *
 * 3. Provenance resolves to an authorized chunk or reports unavailable: each
 *    relation's in-scope provenance pairs are hydrated against the chunk
 *    index with the retrieval semantics (child kind + active version + tenant
 *    + groups + knowledge scope). A pair that does not resolve is returned as
 *    `{ available: false }` — never silently dropped, never presented as a
 *    resolvable citation.
 *
 * Read-only: nothing mutates.
 */

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
/** Hard per-entity relation slice inside Neo4j (server-side, not user input). */
const PER_ENTITY_RELATION_SLICE = 25
const MAX_ENTITY_NAME_CHARS = 200
const MAX_QUERY_CHARS = 200
const MAX_PROVENANCE_PAIRS_PER_PAGE = 100

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

interface ProvenancePair {
  documentId: string
  chunkId: string
}

interface ProvenanceRecord {
  documentId: string
  chunkId: string
  available: boolean
  title?: string
  documentVersion?: number
}

interface BrowsableRelation {
  sourceName: string
  targetName: string
  relation: string
  weight: number
  provenance: ProvenancePair[]
}

/**
 * The stored fact is "<sourceId>-><targetId>:<relation>" (Neo4jStore MERGE).
 */
function parseFact(fact: string): { sourceEntityId: string; targetEntityId: string; relation: string } | null {
  const separator = fact.indexOf(":")
  if (separator < 0) return null
  const direction = fact.slice(0, separator).split("->")
  if (direction.length !== 2) return null
  return {
    sourceEntityId: direction[0],
    targetEntityId: direction[1],
    relation: fact.slice(separator + 1),
  }
}

/** Parse + authorize one edge's provenance against (context, one KB id). */
function inScopeProvenance(
  rawProvenance: unknown,
  context: AccessContext,
  knowledgeBaseId: string
): ProvenancePair[] {
  const parsed = filterByKnowledgeBase(
    filterProvenanceByAccessContext(parseGraphProvenance(rawProvenance), context),
    { knowledgeBaseIds: [knowledgeBaseId] }
  )
  return parsed.map(({ documentId, chunkId }) => ({ documentId, chunkId }))
}

function boundedWeight(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(0, Math.min(1, raw))
    : 0.5
}

export function createGraphBrowseRouter(options: {
  knowledgeBaseService: KnowledgeBaseService
  /** Absent (bare mounts) → 503: graph browsing needs Neo4j. */
  neo4jDriver?: Driver
  /** Chunk hydration for provenance; absent → provenance reports unavailable. */
  es?: Client
  indexName?: string
  activeVersionRepo?: ActiveVersionRepository
}): Router {
  const { knowledgeBaseService, neo4jDriver, es, activeVersionRepo } = options
  const indexName = resolveChunkIndexName(options.indexName)
  const router = Router()

  const requireKb = (req: Request, res: Response): AccessContext | null => {
    const context = accessContext(res)
    const known = knowledgeBaseService
      .list(context.tenantId)
      .some((base) => base.id === req.params.id)
    if (!known) {
      res.status(404).json({ error: "knowledge base not found" })
      return null
    }
    return context
  }

  const parsePage = (req: Request, res: Response): { limit: number; offset: number } | null => {
    const limit = Number.parseInt(String(req.query.limit ?? String(DEFAULT_PAGE_SIZE)), 10)
    const offset = Number.parseInt(String(req.query.offset ?? "0"), 10)
    if (
      !Number.isFinite(limit) || limit < 1 || limit > MAX_PAGE_SIZE ||
      !Number.isFinite(offset) || offset < 0
    ) {
      res.status(400).json({
        error: `limit must be between 1 and ${MAX_PAGE_SIZE} and offset >= 0`,
      })
      return null
    }
    return { limit, offset }
  }

  /**
   * Hydrate provenance pairs against the chunk index with the retrieval
   * semantics (child kind + active version + tenant + groups + knowledge
   * scope). Returns the identities that resolved to authorized chunks.
   */
  const resolveProvenance = async (
    context: AccessContext,
    knowledgeBaseId: string,
    pairs: ProvenancePair[]
  ): Promise<Map<string, { title: string; documentVersion: number | null }>> => {
    const resolved = new Map<string, { title: string; documentVersion: number | null }>()
    if (!es || pairs.length === 0) return resolved
    const activeDocIds = activeVersionRepo ? activeVersionRepo.getActiveDocIds() : []
    const activeTerms =
      activeDocIds.length > 0 ? [{ terms: { documentId: activeDocIds } }] : []
    const result = await es.search({
      index: indexName,
      size: pairs.length,
      query: {
        bool: {
          minimum_should_match: 1,
          should: pairs.map(({ documentId, chunkId }) => ({
            bool: {
              must: [
                { term: { documentId } },
                { term: { id: chunkId } },
              ],
            },
          })),
          filter: [
            childFilter(),
            ...activeTerms,
            ...accessContextFilter(context),
            ...knowledgeBaseFilter({ knowledgeBaseIds: [knowledgeBaseId] }),
          ],
        },
      },
      _source: true,
    })
    for (const hit of result.hits.hits as Array<{ _source?: Record<string, unknown> }>) {
      const source = hit._source
      if (!source) continue
      const metadata = (source.metadata && typeof source.metadata === "object"
        ? source.metadata : {}) as Record<string, unknown>
      resolved.set(`${String(source.documentId)}\0${String(source.id)}`, {
        title: typeof metadata.title === "string" ? metadata.title.slice(0, 200) : "Untitled",
        documentVersion: Number.isInteger(metadata.documentVersion) &&
            (metadata.documentVersion as number) > 0
          ? metadata.documentVersion as number
          : null,
      })
    }
    return resolved
  }

  const toProvenanceRecords = (
    pairs: ProvenancePair[],
    resolved: Map<string, { title: string; documentVersion: number | null }>
  ): ProvenanceRecord[] =>
    pairs.map(({ documentId, chunkId }) => {
      const hit = resolved.get(`${documentId}\0${chunkId}`)
      return hit
        ? {
            documentId,
            chunkId,
            available: true,
            title: hit.title,
            ...(hit.documentVersion !== null ? { documentVersion: hit.documentVersion } : {}),
          }
        : { documentId, chunkId, available: false }
    })

  router.get(
    "/knowledge-bases/:id/graph/entities",
    async (req: Request, res: Response) => {
      const context = requireKb(req, res)
      if (!context) return
      if (!neo4jDriver) {
        res.status(503).json({ error: "graph browse is not wired in this deployment" })
        return
      }
      const page = parsePage(req, res)
      if (!page) return
      const query =
        typeof req.query.query === "string" ? req.query.query.trim().slice(0, MAX_QUERY_CHARS) : ""

      const session = neo4jDriver.session()
      try {
        // Bounded page window + a hard per-entity relation slice. The
        // relation visibility decision (KB scope) happens in Node on the
        // provenance records, because the graph stores provenance as JSON
        // strings on the edges — unparseable for a Cypher-side filter.
        const result = await session.run(
          `MATCH (e:Entity)
           WHERE $query = ''
              OR toLower(e.name) CONTAINS toLower($query)
              OR any(a IN e.aliases WHERE toLower(a) CONTAINS toLower($query))
           WITH e ORDER BY e.name
           SKIP $offset LIMIT $pageLimit
           OPTIONAL MATCH (e)-[r]-(related:Entity)
           WITH e, related, r ORDER BY coalesce(r.weight, 0.5) DESC
           WITH e, collect({related: related.name, fact: r.fact, weight: r.weight, provenance: r.provenance})[0..${PER_ENTITY_RELATION_SLICE}] AS relations
           RETURN e.name AS name, e.type AS type, e.aliases AS aliases, relations`,
          {
            query,
            // Neo4j SKIP/LIMIT parameters must be driver Integers.
            offset: neo4jInt(page.offset),
            pageLimit: neo4jInt(page.limit),
          }
        )
        const entities = result.records.map((record) => {
          const rawRelations = record.get("relations") as unknown[]
          const visibleCount = rawRelations.filter((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) return false
            const entry = row as { fact?: unknown; provenance?: unknown }
            if (typeof entry.fact !== "string") return false
            return inScopeProvenance(entry.provenance, context, String(req.params.id)).length > 0
          }).length
          return {
            name: String(record.get("name") ?? ""),
            type: String(record.get("type") ?? ""),
            aliases: Array.isArray(record.get("aliases"))
              ? (record.get("aliases") as unknown[]).filter((a): a is string => typeof a === "string")
              : [],
            relationCount: visibleCount,
          }
        }).filter((entity) => entity.relationCount > 0)
        res.json({
          entities,
          page: { limit: page.limit, offset: page.offset, truncated: entities.length === page.limit },
        })
      } finally {
        await session.close()
      }
    }
  )

  router.get(
    "/knowledge-bases/:id/graph/relations",
    async (req: Request, res: Response) => {
      const context = requireKb(req, res)
      if (!context) return
      if (!neo4jDriver) {
        res.status(503).json({ error: "graph browse is not wired in this deployment" })
        return
      }
      const page = parsePage(req, res)
      if (!page) return
      const entityName = typeof req.query.entity === "string" ? req.query.entity.trim() : ""
      if (!entityName || entityName.length > MAX_ENTITY_NAME_CHARS) {
        res.status(400).json({ error: `entity is required (1-${MAX_ENTITY_NAME_CHARS} characters)` })
        return
      }

      const session = neo4jDriver.session()
      try {
        // Bounded page: one extra row detects "more exist" without a count
        // query. Rows are ordered server-side by weight so a truncated
        // neighborhood is the STRONGEST one.
        const result = await session.run(
          `MATCH (e:Entity)
           WHERE toLower(e.name) = toLower($entity)
           WITH e LIMIT 1
           OPTIONAL MATCH (e)-[r]-(related:Entity)
           WITH e, related, r
           ORDER BY coalesce(r.weight, 0.5) DESC, related.name
           SKIP $offset LIMIT $pageRows
           RETURN e.id AS entityId, e.name AS name, e.type AS type, e.aliases AS aliases,
                  related.id AS relatedId, related.name AS relatedName,
                  r.fact AS fact, r.weight AS weight, r.provenance AS provenance`,
          {
            entity: entityName,
            offset: neo4jInt(page.offset),
            pageRows: neo4jInt(page.limit + 1),
          }
        )
        const entity = result.records.length > 0
          ? {
              name: String(result.records[0].get("name") ?? ""),
              type: String(result.records[0].get("type") ?? ""),
              aliases: Array.isArray(result.records[0].get("aliases"))
                ? (result.records[0].get("aliases") as unknown[]).filter((a): a is string => typeof a === "string")
                : [],
            }
          : null
        if (!entity) {
          res.status(404).json({ error: "entity not found" })
          return
        }

        const relations: BrowsableRelation[] = []
        let outOfScopeRows = 0
        for (const record of result.records.slice(0, page.limit)) {
          const fact = typeof record.get("fact") === "string" ? (record.get("fact") as string) : ""
          if (!fact) continue
          const parsed = parseFact(fact)
          const provenance = inScopeProvenance(record.get("provenance"), context, String(req.params.id))
          if (!parsed || provenance.length === 0) {
            outOfScopeRows += 1
            continue
          }
          const entityId = String(record.get("entityId") ?? "")
          const entityDisplayName = String(record.get("name") ?? "")
          const relatedName = String(record.get("relatedName") ?? "")
          // The stored fact carries the direction; map the endpoint ids back
          // to display names through the matched nodes.
          relations.push({
            sourceName:
              parsed.sourceEntityId === entityId ? entityDisplayName : relatedName,
            targetName:
              parsed.targetEntityId === entityId ? entityDisplayName : relatedName,
            relation: parsed.relation,
            weight: boundedWeight(record.get("weight")),
            provenance,
          })
        }

        // One bounded hydration for the whole page.
        const pairs = [
          ...new Map(relations.flatMap((relation) => relation.provenance).map((pair) => [
            `${pair.documentId}\0${pair.chunkId}`,
            pair,
          ])).values(),
        ].slice(0, MAX_PROVENANCE_PAIRS_PER_PAGE)
        const resolved = await resolveProvenance(context, String(req.params.id), pairs)

        res.json({
          entity,
          relations: relations.map((relation) => ({
            sourceName: relation.sourceName,
            targetName: relation.targetName,
            relation: relation.relation,
            weight: relation.weight,
            provenance: toProvenanceRecords(relation.provenance, resolved),
          })),
          page: {
            limit: page.limit,
            offset: page.offset,
            truncated: result.records.length > page.limit,
            ...(outOfScopeRows > 0 ? { outOfScopeRows } : {}),
          },
        })
      } finally {
        await session.close()
      }
    }
  )

  return router
}
