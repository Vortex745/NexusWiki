/**
 * Ticket 43 (DEMO-01B) — export and dry-run portable non-secret configuration.
 *
 * Acceptance criteria exercised here:
 *   1. Export contains stable slugs and version metadata but no credentials,
 *      documents, vectors or sessions.
 *   2. Import dry-run reports every create, update, copy and conflict
 *      without mutating data.
 *   3. Conflicts reject by default until an administrator explicitly
 *      selects update or copy.
 *   4. References between knowledge bases, profiles and assistants resolve
 *      by stable slug rather than database ID (and round-trip: re-exporting
 *      an imported namespace yields the identical slugs).
 */

import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "../ingestion/tracking/db"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { AssistantService } from "../assistants/assistant_service"
import type { ModelProfile } from "../models/profiles"
import {
  DEMO_CONFIG_SCHEMA_VERSION,
  assistantIdFromSlug,
  assistantSlug,
  buildDemoConfigExport,
  importDemoConfig,
  knowledgeBaseIdFromSlug,
  knowledgeBaseSlug,
  type DemoConfigExport,
} from "./portable_config"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"
const TENANT = "demo"

/** In-memory profile registry stand-in (toggles only — no credentials). */
function fakeProfiles(initial: Array<{ id: string; enabled: boolean }> = []) {
  const enabled = new Map(initial.map((profile) => [profile.id, profile.enabled]))
  return {
    list(): ModelProfile[] {
      return [...enabled.entries()].map(([id, isEnabled]) => ({
        id: id as ModelProfile["id"],
        kind: id as ModelProfile["kind"],
        model: "test-model",
        baseUrlHost: "host.example",
        configured: true,
        enabled: isEnabled,
        selectable: isEnabled,
      }))
    },
    setEnabled(id: string, value: boolean): ModelProfile {
      if (!enabled.has(id)) throw new Error(`unknown profile ${id}`)
      enabled.set(id, value)
      return this.list().find((profile) => profile.id === id)!
    },
  }
}

interface Setup {
  db: DB
  kbService: KnowledgeBaseServiceImpl
  assistants: AssistantService
  profiles: ReturnType<typeof fakeProfiles>
}

function buildSetup(): Setup {
  const db = openDb(":memory:")
  const kbService = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  const assistants = new AssistantService(db, kbService)
  return { db, kbService, assistants, profiles: fakeProfiles([
    { id: "chat", enabled: true },
    { id: "embedding", enabled: true },
    { id: "rerank", enabled: false },
  ]) }
}

/** A namespace whose KBs carry DETERMINISTIC ids (like the demo seed pins). */
function seedDeterministicNamespace(setup: Setup): DemoConfigExport {
  const repo = new SqliteKnowledgeBaseRepo(setup.db)
  for (const [index, base] of [
    { id: "kb-demo-project", name: "演示项目文档", description: "项目知识库" },
    { id: "kb-demo-policy", name: "演示虚构政策", description: "虚构政策知识库" },
  ].entries()) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    repo.insertIfAbsent({
      id: base.id,
      tenantId: TENANT,
      name: base.name,
      description: base.description,
      status: "active",
      embeddingProfile: EMBEDDING_PROFILE,
      folderId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }
  setup.assistants.create(TENANT, "demo-admin", {
    id: "assistant-demo-helper",
    name: "演示助手",
    description: "绑定两个知识库的演示助手",
    config: {
      systemPrompt: "你是演示助手。",
      knowledgeBaseIds: ["kb-demo-project", "kb-demo-policy"],
      chatModelProfileId: "chat",
      rerankModelProfileId: null,
      toolPolicy: "read_only_retrieval",
      memoryEnabled: false,
    },
  })
  const exportDeps = {
    knowledgeBases: setup.kbService.list(TENANT),
    modelProfiles: setup.profiles.list(),
    assistants: setup.assistants.listForTenant(TENANT).map((assistant) => ({
      assistant,
      config: assistant.version.config,
    })),
  }
  return buildDemoConfigExport(exportDeps, new Date("2026-09-23T00:00:00.000Z"))
}

test("the export carries stable slugs and version metadata but no secrets or content", () => {
  const setup = buildSetup()
  const payload = seedDeterministicNamespace(setup)

  // Version metadata.
  assert.equal(payload.schema, DEMO_CONFIG_SCHEMA_VERSION)
  assert.equal(payload.application, "kefu-rag")
  assert.match(payload.applicationVersion, /^\d+\.\d+\.\d+|^unknown$/)
  assert.ok(payload.exportedAt)

  // Stable slugs: the deterministic seed ids map to their stable slugs.
  assert.deepEqual(
    payload.knowledgeBases.map((base) => base.slug),
    ["demo-project", "demo-policy"]
  )
  assert.deepEqual(
    payload.assistants.map((assistant) => assistant.slug),
    ["demo-helper"]
  )
  // References between entities travel by slug, never by database id.
  assert.deepEqual(
    payload.assistants[0].config.knowledgeBaseSlugs,
    ["demo-project", "demo-policy"]
  )

  // No credentials: profiles are toggles only; no URL/host/key field exists.
  const serialized = JSON.stringify(payload)
  assert.deepEqual(payload.modelProfiles, [
    { profileId: "chat", enabled: true },
    { profileId: "embedding", enabled: true },
    { profileId: "rerank", enabled: false },
  ])
  assert.doesNotMatch(serialized, /apiKey|api_key|baseUrl|baseUrlHost|password|token/i)
  // No documents, vectors or sessions.
  assert.doesNotMatch(serialized, /documents|vectors|chunks|sessions|conversation/i)
})

test("the import dry-run reports creates without mutating anything", () => {
  const setup = buildSetup()
  const payload = seedDeterministicNamespace(setup)
  const fresh = buildSetup()

  const plan = importDemoConfig(depsOf(fresh), payload, { dryRun: true })

  assert.equal(plan.dryRun, true)
  const actions = new Map(plan.entries.map((entry) => [`${entry.kind}:${entry.slug}`, entry.action]))
  assert.equal(actions.get("knowledgeBase:demo-project"), "create")
  assert.equal(actions.get("knowledgeBase:demo-policy"), "create")
  assert.equal(actions.get("assistant:demo-helper"), "create")
  // Nothing was written.
  assert.equal(fresh.kbService.list(TENANT).length, 0)
  assert.equal(fresh.assistants.listForTenant(TENANT).length, 0)
})

test("a confirmed import creates slug-derived ids and resolves references; re-import is unchanged", () => {
  const source = buildSetup()
  const payload = seedDeterministicNamespace(source)

  // The import runs against a FRESH namespace.
  const setup = buildSetup()
  const applied = importDemoConfig(depsOf(setup), payload, { dryRun: false })
  assert.equal(applied.rejectedReason, undefined)
  const actions = new Map(applied.entries.map((entry) => [`${entry.kind}:${entry.slug}`, entry.action]))
  assert.equal(actions.get("knowledgeBase:demo-project"), "create")
  assert.equal(actions.get("knowledgeBase:demo-policy"), "create")
  assert.equal(actions.get("assistant:demo-helper"), "create")
  assert.ok(
    applied.entries
      .filter((entry) => entry.kind === "modelProfile")
      .every((entry) => entry.action === "unchanged"),
    "toggles that already match are unchanged"
  )

  // Deterministic ids derived from the slugs.
  assert.ok(setup.kbService.getById(knowledgeBaseIdFromSlug("demo-project"), TENANT))
  const assistant = setup.assistants.get(assistantIdFromSlug("demo-helper"), TENANT)
  assert.ok(assistant)
  // The reference resolved to the CREATED knowledge base ids (by slug).
  assert.deepEqual(assistant!.version.config.knowledgeBaseIds, [
    knowledgeBaseIdFromSlug("demo-project"),
    knowledgeBaseIdFromSlug("demo-policy"),
  ])

  // A re-import over the identical namespace: everything unchanged.
  const second = importDemoConfig(depsOf(setup), payload, { dryRun: true })
  assert.ok(second.entries.every((entry) => entry.action === "unchanged"))
})

test("conflicts reject by default until an administrator selects update or copy", () => {
  const source = buildSetup()
  const payload = seedDeterministicNamespace(source)

  // Import once into a fresh namespace, then change the payload: the same
  // slugs now carry DIFFERENT content → conflict on the next import.
  const setup = buildSetup()
  importDemoConfig(depsOf(setup), payload, { dryRun: false })
  const changed: DemoConfigExport = {
    ...payload,
    knowledgeBases: payload.knowledgeBases.map((base) =>
      base.slug === "demo-project" ? { ...base, name: "改名后的项目库" } : base
    ),
    assistants: payload.assistants.map((assistant) =>
      assistant.slug === "demo-helper"
        ? {
            ...assistant,
            config: { ...assistant.config, systemPrompt: "改过的提示词。" },
          }
        : assistant
    ),
  }

  // Dry-run names the conflicts.
  const plan = importDemoConfig(depsOf(setup), changed, { dryRun: true })
  const actions = new Map(plan.entries.map((entry) => [`${entry.kind}:${entry.slug}`, entry.action]))
  assert.equal(actions.get("knowledgeBase:demo-project"), "conflict")
  assert.equal(actions.get("assistant:demo-helper"), "conflict")

  // The SAME dry-run WITH explicit resolutions reports the actions a
  // confirmed run would take — update in place, or copy under a fresh slug.
  const planned = importDemoConfig(depsOf(setup), changed, {
    dryRun: true,
    resolutions: {
      "knowledgeBase:demo-project": "copy",
      "assistant:demo-helper": "update",
    },
  })
  const plannedActions = new Map(
    planned.entries.map((entry) => [`${entry.kind}:${entry.slug}`, entry])
  )
  assert.equal(plannedActions.get("knowledgeBase:demo-project")?.action, "copy")
  assert.equal(plannedActions.get("assistant:demo-helper")?.action, "update")
  // A dry-run mutates nothing even with resolutions attached.
  assert.equal(
    setup.kbService.getById(knowledgeBaseIdFromSlug("demo-project-copy"), TENANT),
    null,
    "the dry-run's planned copy slug was NOT created"
  )

  // DEFAULT: a confirmed run with no resolutions REJECTS — nothing changed.
  const rejected = importDemoConfig(depsOf(setup), changed, { dryRun: false })
  assert.match(rejected.rejectedReason ?? "", /conflict/)
  assert.equal(
    setup.kbService.getById(knowledgeBaseIdFromSlug("demo-project"), TENANT)!.name,
    "演示项目文档",
    "the rejected import mutated nothing"
  )
  const assistantBefore = setup.assistants.get(assistantIdFromSlug("demo-helper"), TENANT)!
  assert.equal(assistantBefore.version.config.systemPrompt, "你是演示助手。")

  // Explicit UPDATE: overwrite in place (the assistant edit inserts a new
  // immutable version — version 2 — never a rewrite of version 1).
  importDemoConfig(depsOf(setup), changed, {
    dryRun: false,
    resolutions: {
      "knowledgeBase:demo-project": "update",
      "knowledgeBase:demo-policy": "update",
      "modelProfile:chat": "update",
      "modelProfile:embedding": "update",
      "modelProfile:rerank": "update",
      "assistant:demo-helper": "update",
    },
  })
  assert.equal(
    setup.kbService.getById(knowledgeBaseIdFromSlug("demo-project"), TENANT)!.name,
    "改名后的项目库"
  )
  const assistantAfter = setup.assistants.get(assistantIdFromSlug("demo-helper"), TENANT)!
  assert.equal(assistantAfter.version.config.systemPrompt, "改过的提示词。")
  assert.equal(assistantAfter.version.version, 2, "an update is a NEW immutable version")

  // Explicit COPY: import a DIFFERENT variant of the same slug and resolve
  // the conflict as copy — a fresh entity under a deduped slug.
  const variant: DemoConfigExport = {
    ...payload,
    knowledgeBases: payload.knowledgeBases.map((base) =>
      base.slug === "demo-project" ? { ...base, name: "复制版项目库" } : base
    ),
    assistants: payload.assistants.map((assistant) =>
      assistant.slug === "demo-helper"
        ? { ...assistant, name: "复制版助手" }
        : assistant
    ),
  }
  const copied = importDemoConfig(depsOf(setup), variant, {
    dryRun: false,
    resolutions: {
      "knowledgeBase:demo-project": "copy",
      "knowledgeBase:demo-policy": "update",
      "modelProfile:chat": "update",
      "modelProfile:embedding": "update",
      "modelProfile:rerank": "update",
      "assistant:demo-helper": "copy",
    },
  })
  const copiedKb = setup.kbService.getById(knowledgeBaseIdFromSlug("demo-project-copy"), TENANT)
  assert.ok(copiedKb)
  assert.equal(copiedKb!.name, "复制版项目库")
  const copiedAssistant = setup.assistants.get(assistantIdFromSlug("demo-helper-copy"), TENANT)
  assert.ok(copiedAssistant)
  assert.equal(copiedAssistant!.name, "复制版助手")
  assert.equal(
    copied.entries.find((entry) => entry.kind === "assistant")?.slug,
    "demo-helper-copy"
  )
})

test("a reference to a knowledge base outside the payload always rejects", () => {
  const source = buildSetup()
  const payload = seedDeterministicNamespace(source)
  const setup = buildSetup()
  const dangling: DemoConfigExport = {
    ...payload,
    knowledgeBases: payload.knowledgeBases.filter((base) => base.slug !== "demo-project"),
    assistants: payload.assistants,
  }

  const rejected = importDemoConfig(depsOf(setup), dangling, {
    dryRun: false,
    resolutions: { "assistant:demo-helper": "update" },
  })
  assert.match(rejected.rejectedReason ?? "", /assistant:demo-helper/)
  assert.equal(
    setup.assistants.listForTenant(TENANT).length,
    0,
    "the hard conflict rejected the import — nothing was created"
  )
})

test("slug helpers are involutive and the round-trip re-export is identical", () => {
  assert.equal(knowledgeBaseSlug(knowledgeBaseIdFromSlug("demo-project")), "demo-project")
  assert.equal(assistantSlug(assistantIdFromSlug("demo-helper")), "demo-helper")

  // Export → import into a fresh namespace → re-export: the slugs and the
  // assistant references are byte-identical (only the timestamp differs).
  const source = buildSetup()
  const payload = seedDeterministicNamespace(source)
  importDemoConfig(depsOf(source), payload, { dryRun: false })

  const target = buildSetup()
  importDemoConfig(depsOf(target), payload, { dryRun: false })
  const reExported = buildDemoConfigExport(
    {
      knowledgeBases: target.kbService.list(TENANT),
      modelProfiles: target.profiles.list(),
      assistants: target.assistants.listForTenant(TENANT).map((assistant) => ({
        assistant,
        config: assistant.version.config,
      })),
    },
    new Date("2026-09-24T00:00:00.000Z")
  )
  assert.deepEqual(
    reExported.knowledgeBases.map((base) => base.slug),
    payload.knowledgeBases.map((base) => base.slug)
  )
  assert.deepEqual(
    reExported.assistants.map((assistant) => assistant.config.knowledgeBaseSlugs),
    payload.assistants.map((assistant) => assistant.config.knowledgeBaseSlugs)
  )
})

function depsOf(setup: Setup) {
  return {
    tenantId: TENANT,
    db: setup.db,
    knowledgeBases: setup.kbService,
    embeddingProfile: EMBEDDING_PROFILE,
    modelProfiles: setup.profiles,
    assistants: setup.assistants,
    actorId: "demo-admin",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
  }
}
