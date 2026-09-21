import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  resolveSourceIdentity,
  resolveStoredSourceIdentity,
  sourceIdentityKey,
  type SourceIdentityInput,
} from "./source_identity"
import { openDb } from "./tracking/db"

test("Ticket 05 P2: resolveSourceIdentity carries tenantId and allowedGroups when provided", () => {
  const identity = resolveSourceIdentity(
    {
      kind: "file",
      uriOrExternalId: "/data/report.pdf",
      namespace: "uploads",
      tenantId: "tenant-acme",
      allowedGroups: ["engineers", "support"],
    },
    undefined,
    "fallback-id"
  )
  assert.equal(identity.tenantId, "tenant-acme")
  assert.deepEqual(identity.allowedGroups, ["engineers", "support"])
})

test("Ticket 05 P2: resolveSourceIdentity defaults tenantId to 'default' and allowedGroups to [] when not provided (backward compat)", () => {
  const identity = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id"
  )
  assert.equal(identity.tenantId, "default")
  assert.deepEqual(identity.allowedGroups, [])
})

test("Ticket 05 P2: empty allowedGroups represents tenant-wide visibility, never cross-tenant public", () => {
  // Empty allowedGroups = see everything WITHIN the tenant, not public
  // across tenants. The invariant: tenantId is always set and non-empty,
  // so the source is always scoped to exactly one tenant.
  const identity = resolveSourceIdentity(
    {
      kind: "file",
      uriOrExternalId: "/data/report.pdf",
      tenantId: "tenant-acme",
      allowedGroups: [],
    },
    undefined,
    "fallback-id"
  )
  assert.equal(identity.tenantId, "tenant-acme")
  assert.deepEqual(identity.allowedGroups, [])
  assert.ok(
    identity.tenantId.length > 0,
    "tenantId must always be set — empty allowedGroups is tenant-wide, not cross-tenant public"
  )
})

test("sourceIdentityKey preserves the default-tenant legacy key and isolates non-default tenants", () => {
  const defaultIdentity = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id"
  )
  const idTenantA = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf", tenantId: "tenant-a" },
    undefined,
    "fallback-id"
  )
  const idTenantB = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf", tenantId: "tenant-b" },
    undefined,
    "fallback-id"
  )
  const legacyKey = createHash("sha256")
    .update(JSON.stringify([defaultIdentity.kind, defaultIdentity.uri, defaultIdentity.namespace]))
    .digest("hex")
  assert.equal(sourceIdentityKey(defaultIdentity), legacyKey)
  assert.notEqual(sourceIdentityKey(idTenantA), sourceIdentityKey(idTenantB))
  assert.notEqual(sourceIdentityKey(defaultIdentity), sourceIdentityKey(idTenantA))
})

test("Ticket 05 P2: resolveStoredSourceIdentity (legacy path) defaults tenantId and allowedGroups", () => {
  // Legacy callers pass a raw source string; they get the deterministic
  // single-tenant defaults so existing rows migrate cleanly.
  const identity = resolveStoredSourceIdentity("/data/legacy.pdf", "fallback-id")
  assert.equal(identity.tenantId, "default")
  assert.deepEqual(identity.allowedGroups, [])
})

test("Ticket 05 P2: sources table has tenant_id and allowed_groups columns after openDb migration", () => {
  const db = openDb(":memory:")
  const columns = db.pragma("table_info(sources)") as Array<{ name: string }>
  assert.ok(
    columns.some((c) => c.name === "tenant_id"),
    "sources table must have tenant_id column after migration"
  )
  assert.ok(
    columns.some((c) => c.name === "allowed_groups"),
    "sources table must have allowed_groups column after migration"
  )
})

test("Ticket 03 KB-02A: an omitted knowledge base resolves to the tenant default", () => {
  const defaultIdentity = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id"
  )
  assert.equal(defaultIdentity.knowledgeBaseId, "kb-default-default")
  assert.equal(
    resolveSourceIdentity(
      { kind: "file", uriOrExternalId: "/data/report.pdf", tenantId: "tenant-a" },
      undefined,
      "fallback-id"
    ).knowledgeBaseId,
    "kb-default-tenant-a"
  )
  // Legacy (no identity) callers go through the same default.
  assert.equal(
    resolveSourceIdentity(undefined, "/data/legacy.pdf", "fallback-id").knowledgeBaseId,
    "kb-default-default"
  )
  assert.equal(
    resolveStoredSourceIdentity("/data/legacy.pdf", "fallback-id").knowledgeBaseId,
    "kb-default-default"
  )
})

test("Ticket 03 KB-02A: the default knowledge base keeps the legacy key byte-identical", () => {
  const identity = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id"
  )
  const legacyKey = createHash("sha256")
    .update(JSON.stringify([identity.kind, identity.uri, identity.namespace]))
    .digest("hex")
  assert.equal(sourceIdentityKey(identity), legacyKey)
})

test("Ticket 03 KB-02A: the same file in two knowledge bases is two source identities", () => {
  const inKbA = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id",
    "kb-a"
  )
  const inKbB = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id",
    "kb-b"
  )
  const inDefault = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id"
  )
  assert.equal(inKbA.knowledgeBaseId, "kb-a")
  assert.equal(inKbB.knowledgeBaseId, "kb-b")
  assert.notEqual(sourceIdentityKey(inKbA), sourceIdentityKey(inKbB))
  assert.notEqual(sourceIdentityKey(inKbA), sourceIdentityKey(inDefault))
  // The same file re-imported into the same knowledge base is one identity,
  // regardless of the fallback id (idempotent re-import).
  assert.equal(
    sourceIdentityKey(inKbA),
    sourceIdentityKey(
      resolveSourceIdentity(
        { kind: "file", uriOrExternalId: "/data/report.pdf" },
        undefined,
        "another-fallback-id",
        "kb-a"
      )
    )
  )
})
