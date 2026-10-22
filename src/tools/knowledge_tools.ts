/**
 * Ticket 34 (TOOL-01A) — the built-in read-only tools.
 *
 * `knowledge_search` unifies the three read-only retrieval tools the simple
 * and complex routes already expose (hybrid / graph / pageindex) behind ONE
 * schema-validated tool; `document_lookup` opens a document's active version
 * — tenant, knowledge scope and group visibility are checked against the
 * run's environment, never against anything the caller supplied.
 *
 * Tool output is EVIDENCE: it flows back as retrieval results (citable,
 * subject to the same citation checks as every other context source). It can
 * never replace system instructions — the invocation boundary returns data,
 * and only the prompt builders touch messages.
 */

import { z } from "zod"
import type { Searcher } from "../retrieval/search/interface"
import { toolToSearchOptions } from "../retrieval/tool_selector"
import type { AccessContext } from "../access/context"
import type { DocumentRepo } from "../ingestion/tracking/doc_repo"
import type { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import type { RetrievalResult } from "../types"
import type { DB } from "../ingestion/tracking/db"
import { registerWikiTools } from "../wiki/tools"
import {
  boundedQuery,
  type ToolDefinition,
  type ToolEnvironment,
  type ToolRegistry,
} from "./invocation"

const MAX_QUERY_CHARS = 2_000
const MAX_SEEDS = 10
const MAX_DOC_EXCERPT = 4_000
const ADMIN_SCOPE = "admin"

function requireSearcher(env: ToolEnvironment): Searcher {
  if (!env.searcher) throw new Error("no searcher is bound to this run")
  return env.searcher as Searcher
}

async function runKnowledgeSearch(
  tool: "semantic_lexical_hybrid" | "graph_navigation" | "pageindex_hierarchy",
  args: { query: string; seeds?: string[] },
  env: ToolEnvironment
): Promise<{
  results: RetrievalResult[]
  unavailableChannels: string[]
  resultCount: number
  degradationReasons?: string[]
}> {
  const searcher = requireSearcher(env)
  const outcome = await searcher.search(
    { text: args.query },
    {
      ...toolToSearchOptions({
        tool,
        args: { query: args.query, ...(args.seeds ? { seeds: args.seeds } : {}) },
      }),
      // Ticket 34: server identity + scope come from the run environment —
      // the args carry no authority and the schemas cannot accept any.
      accessContext: env.accessContext,
      ...(env.retrievalScope ? { retrievalScope: env.retrievalScope } : {}),
      ...(env.signal ? { signal: env.signal } : {}),
      // PT-02 / PT-03: the same rule covers the run's two non-knowledge
      // channels. The bound session and the web opt-in come from the
      // environment, so a tool call searches exactly what the run itself may
      // read — this session's temporary attachments and, only when the run
      // opted in, allowed Web evidence. Neither is part of the channel
      // selection, and an absent field opens no channel at all.
      ...(env.attachments ? { attachments: env.attachments } : {}),
      ...(env.webRequested === true ? { webRequested: true } : {}),
    }
  )
  return {
    results: outcome.results,
    unavailableChannels: outcome.unavailableChannels,
    resultCount: outcome.results.length,
    ...(outcome.degradationReasons?.length
      ? { degradationReasons: outcome.degradationReasons }
      : {}),
  }
}

/**
 * The document-level group rule shared with the document catalog: admins and
 * zero-group viewers see everything; a group-restricted caller sees a
 * document only when the two sets intersect or the document is unrestricted.
 */
function groupVisible(allowedGroups: string[], context: AccessContext): boolean {
  return (
    context.scopes.includes(ADMIN_SCOPE) ||
    context.groups.length === 0 ||
    allowedGroups.length === 0 ||
    allowedGroups.some((group) => context.groups.includes(group))
  )
}

/**
 * Register the built-in read-only tools. `knowledge_search` binds to the
 * RUN's own searcher (env.searcher) so it always reads the exact scope the
 * run retrieved with; `document_lookup` binds to the process repositories.
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  deps: { documentRepo?: DocumentRepo; pageIndexRepo?: PageIndexRepository; db?: DB } = {}
): ToolRegistry {
  registry.register({
    name: "knowledge_search",
    description:
      "Read-only retrieval over the run's knowledge scope: hybrid semantic/lexical search, " +
      "graph navigation, or PageIndex hierarchy traversal. Returns ranked evidence.",
    schema: z.strictObject({
      query: boundedQuery(MAX_QUERY_CHARS),
      /** knowledge_search unifies the three retrieval tools of tickets 07/08. */
      mode: z.enum(["semantic_lexical_hybrid", "graph_navigation", "pageindex_hierarchy"])
        .default("semantic_lexical_hybrid"),
      seeds: z.array(z.string().trim().min(1).max(200)).max(MAX_SEEDS).optional(),
    }),
    summarize: (args) =>
      `mode=${args.mode}; query="${args.query.slice(0, 80)}"${args.seeds ? `; seeds=${args.seeds.length}` : ""}`,
    execute: async (args, env) =>
      runKnowledgeSearch(
        args.mode,
        { query: args.query, ...(args.seeds ? { seeds: args.seeds } : {}) },
        env
      ),
  })

  if (deps.documentRepo && deps.pageIndexRepo) {
    const documentRepo = deps.documentRepo
    const pageIndexRepo = deps.pageIndexRepo
    registry.register({
      name: "document_lookup",
      description:
        "Read-only lookup of one document's active version inside the run's knowledge scope: " +
        "metadata, a bounded content excerpt and its PageIndex section outline.",
      schema: z.strictObject({
        documentId: z.string().trim().min(1).max(200),
      }),
      summarize: (args) => `documentId=${args.documentId.slice(0, 80)}`,
      execute: async (args, env) => {
        // The tool reads nothing without server identity — fail closed.
        if (!env.accessContext) return { found: false as const }
        const doc = documentRepo.get(args.documentId)
        // Unknown, foreign-tenant, out-of-scope and group-invisible documents
        // are the same "not found": the tool cannot be used to probe.
        const inScope =
          doc &&
          doc.tenantId === env.accessContext.tenantId &&
          (!env.retrievalScope ||
            (doc.knowledgeBaseId !== undefined &&
              env.retrievalScope.knowledgeBaseIds.includes(doc.knowledgeBaseId))) &&
          groupVisible(doc.allowedGroups ?? [], env.accessContext)
        if (!doc || !inScope) {
          return { found: false as const }
        }
        const outline = pageIndexRepo
          .getNodesByDocument(doc.id)
          .slice(0, 20)
          .map((node) => ({
            nodeId: node.nodeId,
            title: node.title.slice(0, 200),
            sectionPath: node.sectionPath,
          }))
        return {
          found: true as const,
          document: {
            id: doc.id,
            title: doc.title.slice(0, 200),
            source: doc.source.slice(0, 200),
            version: doc.version,
            knowledgeBaseId: doc.knowledgeBaseId,
            excerpt: doc.content.slice(0, MAX_DOC_EXCERPT),
          },
          outline,
        }
      },
    })
  }
  if (deps.db) registerWikiTools(registry, deps.db)
  return registry
}
