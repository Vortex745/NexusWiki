import type { DB } from "./db"
import type { PageIndexNode } from "../../types"
import { defaultKnowledgeBaseId } from "../../types/knowledge_base"

interface StoredRow {
  document_id: string
  node_id: string
  title: string
  section_path: string
  page_start: number | null
  page_end: number | null
  summary: string
  parent_id: string | null
  child_ids: string
  linked_chunk_ids: string
  tenant_id: string
  allowed_groups: string
  knowledge_base_id: string
}

/**
 * Ticket 06 P3: optional access metadata passed by the pipeline caller.
 * When omitted, SQLite NOT NULL DEFAULT kicks in ('default' / '[]').
 */
export interface PageIndexAccessMetadata {
  tenantId?: string
  allowedGroups?: string[]
  /**
   * Ticket 03 (KB-02A): the owning knowledge base. Optional so legacy callers
   * fall back to the tenant's deterministic default knowledge base — never to
   * an unowned row (criterion 4).
   */
  knowledgeBaseId?: string
}

/**
 * Ticket PT-10 (audit finding F1): the caller's eligibility axes for a bounded
 * node search.
 *
 * Retrieval used to take `limit` nodes first and drop the ineligible ones
 * afterwards, so a node the caller could never read still consumed one of the
 * five slots and pushed an eligible target out of the run. This type is the
 * seam that moves that decision INTO the query: SQLite resolves every axis
 * below before `ORDER BY … LIMIT`, and the caller's ceiling is spent only on
 * already-eligible nodes.
 *
 * Each axis mirrors an existing application-layer filter EXACTLY — no new rules
 * are introduced here:
 *
 * - `tenantId` — a hard axis, like `filterNodesByAccessContext` /
 *   `accessContextFilter`. Absent → no predicate, which is how a caller without
 *   an AccessContext (legacy single-tenant probes, evaluation scopes) reads
 *   today. It never widens an admin: identity always carries its own tenant.
 * - `callerGroups` — like `filterNodesByAccessContext`: an empty (or absent)
 *   caller group list means a tenant-wide reader, so no group predicate is
 *   added; otherwise a node is eligible when its OWN `allowed_groups` is empty
 *   (a tenant-wide node) or intersects the caller's groups.
 * - `knowledgeBaseIds` — like `filterByKnowledgeBase` / `knowledgeBaseFilter`:
 *   absent → no knowledge axis (legacy reads span every base, as before);
 *   non-empty → only rows tagged with a listed base, and a row without a tag
 *   cannot be authorized, so it stays refused (fail closed); EMPTY → nothing is
 *   eligible, never an unfiltered read.
 * - `restrictToActiveDocumentVersions` — like `activeTermsFilterFor`: the node's
 *   `document_id` must be the active version of a source, i.e. exactly the set
 *   `ActiveVersionRepository.getActiveDocIds()` returns (the `sources` table of
 *   the same database — both repositories are always built from one connection).
 *   The three states are deliberately distinguishable, because the two failures
 *   they describe are different:
 *     - axis absent (no active-version repository wired) → no predicate, the
 *       pre-existing default behavior an evaluation scope depends on;
 *     - axis present + a non-empty active set → only active versions;
 *     - axis present + an EMPTY active set → nothing is eligible (fail closed),
 *       which is NOT the same as the axis being absent.
 *
 * Bounded-parameter note (PT-10 AC08): the active axis carries NO parameter, so
 * its size cannot grow the bound-parameter count; the remaining axes bind one
 * value per caller group and per selected knowledge base, which is the same set
 * the Elasticsearch `terms` clauses already send.
 */
export interface PageIndexNodeEligibility {
  tenantId?: string
  callerGroups?: readonly string[]
  knowledgeBaseIds?: readonly string[]
  restrictToActiveDocumentVersions?: boolean
}

function parsePath(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function toNode(row: StoredRow): PageIndexNode {
  return {
    documentId: row.document_id,
    nodeId: row.node_id,
    title: row.title,
    sectionPath: parsePath(row.section_path),
    pageStart: row.page_start,
    pageEnd: row.page_end,
    summary: row.summary,
    parentId: row.parent_id,
    childIds: parsePath(row.child_ids),
    linkedChunkIds: parsePath(row.linked_chunk_ids),
    tenantId: row.tenant_id,
    allowedGroups: parsePath(row.allowed_groups),
    knowledgeBaseId: row.knowledge_base_id,
  }
}

export class PageIndexRepository {
  constructor(private db: DB) {}

  replaceNodes(
    documentId: string,
    nodes: PageIndexNode[],
    accessMetadata?: PageIndexAccessMetadata
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM page_index_nodes WHERE document_id = ?").run(documentId)
      const insert = this.db.prepare(
        `INSERT INTO page_index_nodes (
          document_id, node_id, title, section_path, page_start, page_end,
          summary, parent_id, child_ids, linked_chunk_ids,
          tenant_id, allowed_groups, knowledge_base_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const tenantId = accessMetadata?.tenantId ?? "default"
      const allowedGroups = JSON.stringify(accessMetadata?.allowedGroups ?? [])
      const knowledgeBaseId = accessMetadata?.knowledgeBaseId ??
        defaultKnowledgeBaseId(tenantId)
      for (const node of nodes) {
        insert.run(
          node.documentId,
          node.nodeId,
          node.title,
          JSON.stringify(node.sectionPath),
          node.pageStart,
          node.pageEnd,
          node.summary,
          node.parentId,
          JSON.stringify(node.childIds),
          JSON.stringify(node.linkedChunkIds),
          tenantId,
          allowedGroups,
          knowledgeBaseId
        )
      }
    })
    tx()
  }

  getNodesByDocument(documentId: string): PageIndexNode[] {
    const rows = this.db.prepare(
      "SELECT * FROM page_index_nodes WHERE document_id = ? ORDER BY node_id"
    ).all(documentId) as StoredRow[]
    return rows.map(toNode)
  }

  /**
   * The bounded node lookup.
   *
   * PT-10 (audit finding F1): every eligibility axis in `eligibility` is
   * resolved by SQLite inside this one statement — before
   * `ORDER BY document_id, node_id LIMIT ?` — so material the caller cannot read
   * never occupies one of the `limit` slots an eligible target is competing for.
   * The ceiling, the stable order and the unscoped legacy shape are unchanged:
   * with no `eligibility` the query is exactly the pre-existing one.
   */
  searchNodes(query: string, limit: number, eligibility?: PageIndexNodeEligibility): PageIndexNode[] {
    const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`
    const conditions: string[] = [
      "(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')",
    ]
    const params: Array<string | number> = [pattern, pattern]

    if (eligibility?.tenantId !== undefined) {
      conditions.push("tenant_id = ?")
      params.push(eligibility.tenantId)
    }

    // Group visibility mirrors filterNodesByAccessContext: it only applies when
    // the caller HAS groups, and an unrestricted (empty) node is tenant-wide.
    // Malformed JSON degrades to "unrestricted" exactly like the repository's
    // own parser (parsePath → []), so a damaged tag column can neither hide a
    // tenant-wide node nor abort the statement.
    const callerGroups = eligibility?.callerGroups ?? []
    if (callerGroups.length > 0) {
      conditions.push(
        `(json_valid(allowed_groups) = 0
           OR json_array_length(allowed_groups) = 0
           OR EXISTS (
             SELECT 1 FROM json_each(page_index_nodes.allowed_groups) ag
             WHERE ag.value IN (${callerGroups.map(() => "?").join(", ")})))`
      )
      params.push(...callerGroups)
    }

    // Knowledge scope mirrors filterByKnowledgeBase: untagged rows cannot be
    // authorized under an explicit scope, and an explicit EMPTY scope selects
    // nothing rather than everything.
    const knowledgeBaseIds = eligibility?.knowledgeBaseIds
    if (knowledgeBaseIds !== undefined) {
      if (knowledgeBaseIds.length === 0) {
        conditions.push("0")
      } else {
        conditions.push(
          `knowledge_base_id IN (${knowledgeBaseIds.map(() => "?").join(", ")})`
        )
        params.push(...knowledgeBaseIds)
      }
    }

    // Active-version axis: the same set ActiveVersionRepository.getActiveDocIds()
    // returns, expressed as a subquery so the size of the active set never
    // becomes a bound parameter (and never becomes a list read into memory).
    if (eligibility?.restrictToActiveDocumentVersions) {
      conditions.push(
        "EXISTS (SELECT 1 FROM sources s WHERE s.active_doc_id = page_index_nodes.document_id)"
      )
    }

    const rows = this.db.prepare(
      `SELECT * FROM page_index_nodes
       WHERE ${conditions.join(" AND ")}
       ORDER BY document_id, node_id
       LIMIT ?`
    ).all(...params, limit) as StoredRow[]
    return rows.map(toNode)
  }
}
