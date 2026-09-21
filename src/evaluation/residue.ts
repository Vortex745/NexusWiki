/**
 * Eval refactor Ticket 14 — crash-residue sweep.
 *
 * A hard kill (SIGKILL, power loss) can leave what the process never got to
 * release: a dedicated ES index and this scope's graph provenance. Task records
 * are memory-only by design, so nothing can be "recovered" and this module does
 * not pretend otherwise: it works from the naming/ownership rules only, never
 * from a durable task list (none exists — and this adds none).
 *
 * The reach is structural, not conventional:
 *   - only names derived from `EVAL_ES_INDEX_PREFIX` / `EVAL_TENANT_PREFIX` are
 *     considered, and every candidate is re-validated against
 *     `EVAL_SCOPE_PATTERN` before anything is touched (`refused` otherwise);
 *   - the business chunk index (`kefu-rag-chunks`) cannot match the eval
 *     prefix, and the graph strip is the same per-tenant provenance rule the
 *     live dispose applies — a relation a business tenant also owns keeps its
 *     entries and stays alive.
 * Every step is idempotent: running the sweep twice is the same as running it
 * once, and a vanished index is reported as `not_found`, not as an error.
 */

import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import {
  EVAL_ES_INDEX_PREFIX,
  EVAL_SCOPE_PATTERN,
  EVAL_TENANT_PREFIX,
  findEvalTenants,
  stripProvenanceForTenant,
} from "./isolated_resources"

/** The shared clients the live service writes through. Never closed here. */
export interface EvalResidueClients {
  es: Client
  graphDriver: Driver
}

/** What a crashed process left behind, before anything is deleted. */
export interface EvalResidueListing {
  /** Dedicated eval indices found in the cluster. */
  esIndices: string[]
  /** Scope ids that still own graph provenance — `eval-<sanitized task id>`. */
  scopeIds: string[]
}

export interface EvalResidueSweepReport {
  scopeId: string
  esIndex: "deleted" | "not_found" | "failed" | "refused"
  graphProvenance: "cleaned" | "failed" | "refused"
  esError?: string
  graphError?: string
}

/** `kefu-rag-chunks-eval-<sanitized>` → `eval-<sanitized>`, or null if it is
 * not a valid eval scope name. */
function scopeIdForIndex(index: string): string | null {
  if (!index.startsWith(EVAL_ES_INDEX_PREFIX)) return null
  const scopeId = `${EVAL_TENANT_PREFIX}${index.slice(EVAL_ES_INDEX_PREFIX.length)}`
  return EVAL_SCOPE_PATTERN.test(scopeId) ? scopeId : null
}

function indexForScopeId(scopeId: string): string {
  return `${EVAL_ES_INDEX_PREFIX}${scopeId.slice(EVAL_TENANT_PREFIX.length)}`
}

/** Read-only: what is left in the cluster and in the graph. */
export async function listEvalResidue(
  clients: EvalResidueClients
): Promise<EvalResidueListing> {
  const esIndices: string[] = []
  try {
    const response = await clients.es.indices.get({
      index: `${EVAL_ES_INDEX_PREFIX}*`,
      allow_no_indices: true,
      ignore_unavailable: true,
    })
    for (const name of Object.keys(response)) {
      if (scopeIdForIndex(name)) esIndices.push(name)
    }
  } catch (error) {
    // A wildcard with no match answers 404 on some versions: "no residue",
    // not a failure. Anything else is a real error and must surface.
    if ((error as { meta?: { statusCode?: number } })?.meta?.statusCode !== 404) {
      throw error
    }
  }

  const session = clients.graphDriver.session()
  let scopeIds: string[] = []
  try {
    scopeIds = (await findEvalTenants(session)).filter((tenant) =>
      EVAL_SCOPE_PATTERN.test(tenant)
    )
  } finally {
    await session.close()
  }
  for (const index of esIndices) {
    const scopeId = scopeIdForIndex(index)
    if (scopeId && !scopeIds.includes(scopeId)) scopeIds.push(scopeId)
  }
  return { esIndices: esIndices.sort(), scopeIds: scopeIds.sort() }
}

/**
 * Delete what the scopes left behind. `scopeIds` limits the sweep to those
 * scopes (each is still re-validated); omitted → everything the listing found.
 * Never touches anything outside the eval naming, never throws for a missing
 * resource, and reports per scope so an operator sees exactly what happened.
 */
export async function sweepEvalResidue(
  clients: EvalResidueClients,
  options: { scopeIds?: readonly string[] } = {}
): Promise<{ scopes: EvalResidueSweepReport[] }> {
  const requested = options.scopeIds
    ? [...new Set(options.scopeIds)]
    : (await listEvalResidue(clients)).scopeIds
  const scopes: EvalResidueSweepReport[] = []
  const session = clients.graphDriver.session()
  try {
    for (const scopeId of requested) {
      if (!EVAL_SCOPE_PATTERN.test(scopeId)) {
        const refusal = "not an eval scope id — nothing was deleted for it"
        scopes.push({
          scopeId,
          esIndex: "refused",
          graphProvenance: "refused",
          esError: refusal,
          graphError: refusal,
        })
        continue
      }
      const report: EvalResidueSweepReport = {
        scopeId,
        esIndex: "not_found",
        graphProvenance: "cleaned",
      }
      try {
        await clients.es.indices.delete({ index: indexForScopeId(scopeId) })
        report.esIndex = "deleted"
      } catch (error) {
        const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode
        if (status !== 404) {
          report.esIndex = "failed"
          report.esError = error instanceof Error ? error.message : String(error)
        }
      }
      try {
        // Same rule as dispose: only this tenant's provenance entries go, and
        // a relation a business tenant owns keeps its entries and its weight.
        await stripProvenanceForTenant(session, scopeId)
      } catch (error) {
        report.graphProvenance = "failed"
        report.graphError = error instanceof Error ? error.message : String(error)
      }
      scopes.push(report)
    }
  } finally {
    await session.close()
  }
  return { scopes }
}
