import assert from "node:assert/strict"
import test from "node:test"
import type { EvalResidueClients } from "./residue"
import { listEvalResidue, sweepEvalResidue } from "./residue"

/**
 * Eval refactor Ticket 14 — crash-residue sweep.
 *
 * The external boundary is faked (ES index list/delete + a tiny Neo4j session
 * that carries relation provenance), because the point of these tests is the
 * SWEEP's reach: it must derive names from the eval prefixes only, refuse
 * anything that is not an eval scope, keep a business tenant's provenance
 * entries (and the relation itself), never delete entity nodes, and stay
 * idempotent when run twice.
 */

const SCOPE_A = "eval-3f6c1d9a4b7e4c2f8a1d5b6e0c3f7a92"
const SCOPE_B = "eval-9b1e4d7c2a5f8036e9c4b7d1a2f5e830"
const INDEX_A = `kefu-rag-chunks-eval-${SCOPE_A.slice("eval-".length)}`
const INDEX_B = `kefu-rag-chunks-eval-${SCOPE_B.slice("eval-".length)}`
const BUSINESS_INDEX = "kefu-rag-chunks"
const BUSINESS_TENANT = "business-tenant"

/** One relation's stored provenance (the writer's JSON-array entries). */
interface Relation {
  rid: string
  provenance: string[]
}

function entry(
  documentId: string,
  chunkId: string,
  tenantId: string,
  weight?: number
): string {
  return JSON.stringify([
    documentId,
    chunkId,
    tenantId,
    [],
    ...(weight === undefined ? [] : [weight]),
  ])
}

function buildClients(options: {
  indices?: string[]
  relations?: Relation[]
  /** Make the next delete of this index answer 404 (already released). */
  deleteStatusOverride?: number
}): {
  clients: EvalResidueClients
  /** Every delete call, including the ones that answered 404. */
  deleteAttempts: string[]
  /** Indices actually removed (a delete that 404s removes nothing). */
  deletedIndices: string[]
  deletedRelations: string[]
  updates: Array<{ rid: string; remaining: string[]; maxWeight?: number }>
  relations: Relation[]
} {
  const indices = new Set(options.indices ?? [])
  const relations = options.relations ?? []
  const deleteAttempts: string[] = []
  const deletedIndices: string[] = []
  const deletedRelations: string[] = []
  const updates: Array<{ rid: string; remaining: string[]; maxWeight?: number }> = []

  const es = {
    indices: {
      get: async () =>
        Object.fromEntries([...indices].map((name) => [name, {}])),
      delete: async ({ index }: { index: string }) => {
        deleteAttempts.push(index)
        const status = options.deleteStatusOverride
        if (status || !indices.has(index)) {
          const error = Object.assign(new Error("index_not_found_exception"), {
            meta: { statusCode: status ?? 404 },
          })
          throw error
        }
        indices.delete(index)
        deletedIndices.push(index)
        return { acknowledged: true }
      },
    },
  }

  const session = {
    run: async (query: string, params: Record<string, unknown> = {}) => {
      if (query.includes("RETURN elementId(r) AS rid")) {
        const needle = String(params.needle ?? "")
        const matched = relations.filter((relation) =>
          relation.provenance.some((raw) => raw.includes(needle))
        )
        return {
          records: matched.map((relation) => ({
            get: (key: string) =>
              key === "rid" ? relation.rid : relation.provenance,
          })),
        }
      }
      if (query.includes("DELETE r")) {
        const rid = String(params.rid)
        deletedRelations.push(rid)
        const at = relations.findIndex((relation) => relation.rid === rid)
        if (at >= 0) relations.splice(at, 1)
        return { records: [] }
      }
      if (query.includes("SET r.provenance = $remaining, r.weight = $maxWeight")) {
        const rid = String(params.rid)
        updates.push({
          rid,
          remaining: params.remaining as string[],
          maxWeight: params.maxWeight as number,
        })
        const relation = relations.find((item) => item.rid === rid)
        if (relation) relation.provenance = params.remaining as string[]
        return { records: [] }
      }
      if (query.includes("SET r.provenance = $remaining")) {
        const rid = String(params.rid)
        updates.push({ rid, remaining: params.remaining as string[] })
        const relation = relations.find((item) => item.rid === rid)
        if (relation) relation.provenance = params.remaining as string[]
        return { records: [] }
      }
      throw new Error(`unexpected query: ${query}`)
    },
    close: async () => {},
  }

  return {
    clients: {
      es: es as unknown as EvalResidueClients["es"],
      graphDriver: {
        session: () => session,
      } as unknown as EvalResidueClients["graphDriver"],
    },
    deleteAttempts,
    deletedIndices,
    deletedRelations,
    updates,
    relations,
  }
}

test("the listing reports eval-owned names only, never business data", async () => {
  const fake = buildClients({
    indices: [
      INDEX_A,
      BUSINESS_INDEX,
      // Over-broad match on purpose: an invalid suffix is never residue.
      "kefu-rag-chunks-eval-Ab1",
    ],
    relations: [
      {
        rid: "r1",
        provenance: [
          entry("d1", "c1", SCOPE_A, 0.9),
          entry("d2", "c2", BUSINESS_TENANT, 0.4),
        ],
      },
    ],
  })

  const listing = await listEvalResidue(fake.clients)

  assert.deepEqual(listing.esIndices, [INDEX_A], "the business index is not residue")
  assert.deepEqual(listing.scopeIds, [SCOPE_A], "only the eval tenant owns provenance")
})

test("the sweep deletes the eval index and releases only this scope's provenance", async () => {
  const fake = buildClients({
    indices: [INDEX_A, BUSINESS_INDEX],
    relations: [
      {
        rid: "r-shared",
        provenance: [
          entry("d1", "c1", SCOPE_A, 0.9),
          entry("d2", "c2", BUSINESS_TENANT, 0.4),
        ],
      },
    ],
  })

  const { scopes } = await sweepEvalResidue(fake.clients)

  assert.deepEqual(fake.deletedIndices, [INDEX_A], "only the dedicated index goes")
  assert.deepEqual(scopes.map((scope) => scope.esIndex), ["deleted"])
  assert.deepEqual(fake.deletedRelations, [], "a shared relation is not deleted")
  assert.deepEqual(fake.updates, [
    { rid: "r-shared", remaining: [entry("d2", "c2", BUSINESS_TENANT, 0.4)], maxWeight: 0.4 },
  ])
  assert.equal(
    /Entity/.test(fake.deletedRelations.join()),
    false,
    "entity nodes are never part of the sweep"
  )
})

test("a relation only the scope owned is deleted", async () => {
  const fake = buildClients({
    indices: [INDEX_A],
    relations: [
      { rid: "r-own", provenance: [entry("d1", "c1", SCOPE_A, 0.2)] },
      { rid: "r-other", provenance: [entry("d1", "c1", SCOPE_B, 0.3)] },
    ],
  })

  await sweepEvalResidue(fake.clients, { scopeIds: [SCOPE_A] })

  assert.deepEqual(fake.deletedRelations, ["r-own"], "only this scope's relation goes")
  assert.equal(fake.relations.some((item) => item.rid === "r-other"), true)
})

test("the sweep refuses anything that is not an eval scope id", async () => {
  const fake = buildClients({ indices: [INDEX_A], relations: [] })

  const { scopes } = await sweepEvalResidue(fake.clients, {
    scopeIds: [BUSINESS_INDEX, "eval-short"],
  })

  assert.deepEqual(
    scopes.map((scope) => [scope.esIndex, scope.graphProvenance]),
    [
      ["refused", "refused"],
      ["refused", "refused"],
    ],
    "an unknown name is refused, not deleted"
  )
  assert.deepEqual(fake.deletedIndices, [], "nothing was deleted for a refused id")
})

test("running the sweep twice is harmless", async () => {
  const fake = buildClients({
    indices: [INDEX_A],
    relations: [{ rid: "r-own", provenance: [entry("d1", "c1", SCOPE_A, 0.2)] }],
  })

  const first = await sweepEvalResidue(fake.clients)
  // Re-listing after the sweep finds nothing at all.
  assert.deepEqual((await listEvalResidue(fake.clients)).scopeIds, [])
  // Asked to sweep the same scope again, the answer is "already gone", not an
  // error — and nothing is written a second time.
  const second = await sweepEvalResidue(fake.clients, { scopeIds: [SCOPE_A] })

  assert.equal(first.scopes[0].esIndex, "deleted")
  assert.equal(second.scopes[0].esIndex, "not_found", "a released index is not an error")
  assert.equal(second.scopes[0].graphProvenance, "cleaned")
  assert.deepEqual(fake.deletedRelations, ["r-own"], "the relation is deleted once")
  assert.deepEqual(fake.deletedIndices, [INDEX_A], "the index is deleted once")
  assert.deepEqual(
    fake.deleteAttempts,
    [INDEX_A, INDEX_A],
    "the second run only asks again — it removes nothing"
  )
})
