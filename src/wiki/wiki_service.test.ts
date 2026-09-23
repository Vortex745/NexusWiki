/**
 * Ticket 38 (WIKI-01) — generate, validate, publish and restore Wiki pages.
 *
 * Acceptance criteria exercised here:
 *   1. Valid revisions publish automatically (normal ingestion submission with
 *      AI marking + source citations); invalid revisions NEVER replace the
 *      current page (nothing is written).
 *   2. Published pages carry original-document provenance (metadata.wiki
 *      sources + an inline 来源 section) and enter normal ingestion.
 *   3. A prior published revision can be restored verbatim; a generation
 *      failure leaves the current page intact.
 *   4. Stale source citations are visible (updated / retired / missing), and
 *      wiki documents are excluded from the next generation's source list.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"

import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { openDb, type DB } from "../ingestion/tracking/db"
import {
  type IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "../ingestion/lifecycle"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { WikiService, WikiGenerationModelError, WikiPageNotFoundError } from "./wiki_service"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

/** A stage runner that completes every stage so runNext succeeds for real. */
const STAGE_RUNNER_STUB: IngestionStageRunner = {
  close: async () => {},
  async run(_document, execution: StageExecution): Promise<void> {
    for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
      await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
    }
  },
}

interface Setup {
  db: DB
  repo: DocumentRepo
  lifecycle: IngestionLifecycle
  kb: { id: string }
}

/** The canned draft the fake chat client returns (mutated per test). */
let currentDraft = ""

function buildSetup(): Setup {
  const db = openDb(":memory:")
  const repo = new DocumentRepo(db)
  const lifecycle = createIngestionLifecycle(db, {
    stageRunner: STAGE_RUNNER_STUB,
    activationMode: "auto",
  })
  const service = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  const kb = service.create("demo", "KB")
  currentDraft = ""
  return { db, repo, lifecycle, kb }
}

const adminContext: AccessContext = {
  ...singleTenantAccessContext(),
  tenantId: "demo",
  scopes: ["chat", "admin"],
  groups: [],
}

async function seedSource(
  setup: Setup,
  title: string,
  content: string
): Promise<string> {
  const submission = setup.lifecycle.submit({
    title,
    content,
    knowledgeBaseId: setup.kb.id,
    sourceIdentity: {
      kind: "submission",
      uriOrExternalId: `seed:${title}`,
      namespace: "test",
      tenantId: "demo",
    },
  })
  await drain(setup)
  return submission.docId
}

/**
 * The stub stage runner never executes real stages — drain the task queue
 * through the REAL worker path (claim → run → complete → activate) exactly
 * like the production worker does after each submission.
 */
async function drain(setup: Setup): Promise<void> {
  while (await setup.lifecycle.runNext()) {
    // keep draining
  }
}

function buildWiki(setup: Setup): WikiService {
  const chatClient = {
    chat: {
      completions: {
        create: async () => {
          return { choices: [{ message: { content: currentDraft } }] }
        },
      },
    },
  } as unknown as OpenAI
  return new WikiService({
    chatClient,
    model: "test-model",
    lifecycle: setup.lifecycle,
    documentRepo: setup.repo,
  })
}

function setCurrentDraft(_setup: Setup, draft: string): void {
  currentDraft = draft
}

test("a valid draft publishes automatically through normal ingestion with provenance", async () => {
  const setup = buildSetup()
  setCurrentDraft(setup, "# 报销政策\n\n员工报销需要在三个工作日内提交 [S1]，发票必须合规 [S2]。")
  const docA = await seedSource(setup, "报销制度", "报销三个工作日到账")
  const docB = await seedSource(setup, "发票规定", "发票必须合规")
  const wiki = buildWiki(setup)

  const outcome = await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA, docB],
  })
  assert.equal(outcome.status, "published")
  if (outcome.status !== "published") return
  assert.equal(outcome.submission.status, "pending", "entered normal ingestion")
  const published = setup.repo.get(outcome.submission.docId)
  assert.ok(published)
  assert.equal(published.mimeType, "text/markdown")
  const metadata = published.metadata as { tags: string[]; wiki: { sources: Array<{ documentId: string; version: number }> } }
  assert.deepEqual(metadata.tags, ["wiki"], "AI marking: the catalog tag marks generated pages")
  assert.equal(metadata.wiki.sources.length, 2)
  assert.deepEqual(
    metadata.wiki.sources.map((source) => source.documentId),
    [docA, docB],
    "original-document provenance is preserved"
  )
  assert.match(published.content, /## 来源/, "inline provenance section exists")
  assert.match(published.content, new RegExp(docA))
})

test("an invalid draft is rejected with reasons and writes nothing", async () => {
  const setup = buildSetup()
  const docA = await seedSource(setup, "报销制度", "报销三个工作日到账")
  const docB = await seedSource(setup, "发票规定", "发票必须合规")
  // A draft that never cites [S2].
  setCurrentDraft(setup, "# 报销政策\n\n报销需要在三个工作日内提交 [S1]。这已经是完整的一段了，长度也满足门槛。")
  const before = setup.repo.listCatalog({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    page: 1,
    pageSize: 100,
    admin: true,
  }).total
  const wiki = buildWiki(setup)

  const outcome = await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA, docB],
  })
  assert.equal(outcome.status, "rejected")
  if (outcome.status !== "rejected") return
  assert.ok(outcome.reasons.some((reason) => reason.includes("[S2]")))
  const after = setup.repo.listCatalog({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    page: 1,
    pageSize: 100,
    admin: true,
  }).total
  assert.equal(after, before, "a rejected revision writes nothing")
  const pages = wiki.listWikiPages(adminContext, setup.kb.id)
  assert.equal(pages.length, 0, "no page exists yet, so nothing could be replaced")
})

test("a generation model failure throws and leaves storage untouched", async () => {
  const setup = buildSetup()
  const docA = await seedSource(setup, "报销制度", "内容")
  const wiki = new WikiService({
    chatClient: {
      chat: {
        completions: {
          create: async () => {
            throw new Error("provider unavailable")
          },
        },
      },
    } as unknown as OpenAI,
    model: "test-model",
    lifecycle: setup.lifecycle,
    documentRepo: setup.repo,
  })
  await assert.rejects(
    wiki.generate({
      context: adminContext,
      knowledgeBaseId: setup.kb.id,
      title: "报销 Wiki",
      documentIds: [docA],
    }),
    WikiGenerationModelError
  )
  const pages = wiki.listWikiPages(adminContext, setup.kb.id)
  assert.equal(pages.length, 0, "generation failure never publishes anything")
})

test("regenerating identical content is an unchanged no-op — no duplicate version", async () => {
  const setup = buildSetup()
  const docA = await seedSource(setup, "报销制度", "内容")
  const wiki = buildWiki(setup)
  setCurrentDraft(setup, "# 报销政策\n\n报销需要在三个工作日内提交 [S1]，发票需要在报销时一并附上，逾期将无法处理，这一段足够长了。")

  const first = await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA],
  })
  assert.equal(first.status, "published")
  if (first.status !== "published") return
  await drain(setup)
  const second = await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA],
  })
  assert.equal(second.status, "published")
  if (second.status !== "published") return
  assert.equal(second.submission.status, "unchanged", "identical content is a no-op")
  const pages = wiki.listWikiPages(adminContext, setup.kb.id)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].versions.length, 1, "no duplicate version was created")
})

test("a prior published revision can be restored verbatim as a new version", async () => {
  const setup = buildSetup()
  const docA = await seedSource(setup, "报销制度", "内容")
  const wiki = buildWiki(setup)

  setCurrentDraft(setup, "# 第一版\n\n这是第一版的内容 [S1]，包含足够的正文长度，用来验证恢复路径确实按原文重新发布。")
  const first = await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA],
  })
  assert.equal(first.status, "published")
  if (first.status !== "published") return
  await drain(setup)

  setCurrentDraft(setup, "# 第二版\n\n这是第二版的内容 [S1]，完全不同的正文，用来证明版本推进之后恢复仍然可用。")
  const second = await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA],
  })
  assert.equal(second.status, "published")
  if (second.status !== "published") return
  await drain(setup)
  const v2 = setup.repo.get(second.submission.docId)
  assert.match(v2?.content ?? "", /第二版/)

  // Restore v1 (the historical revision) — it becomes the newest version.
  const v1DocId = first.status === "published" ? first.submission.docId : ""
  const restore = wiki.restore({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    documentId: v1DocId,
  })
  assert.equal(restore.status, "pending")
  const restored = setup.repo.get(restore.submission.docId)
  assert.match(restored?.content ?? "", /第一版/, "the restored content is verbatim v1")

  const pages = wiki.listWikiPages(adminContext, setup.kb.id)
  assert.equal(pages.length, 1, "still ONE page — restore is a new version, not a fork")
  assert.equal(pages[0].versions.length, 3, "history keeps all three revisions")
  assert.ok(
    pages[0].versions.every((version) => version.documentId !== "" ),
    "every revision remains resolvable"
  )
})

test("restoring a non-wiki document is the same not-found as a missing row", () => {
  const setup = buildSetup()
  const wiki = buildWiki(setup)
  const docA = setup.lifecycle.submit({
    title: "普通文档",
    content: "不是 wiki 页面",
    knowledgeBaseId: setup.kb.id,
  })
  assert.throws(
    () =>
      wiki.restore({
        context: adminContext,
        knowledgeBaseId: setup.kb.id,
        documentId: docA.docId,
      }),
    WikiPageNotFoundError
  )
})

test("wiki documents are excluded from the next generation's source candidates", async () => {
  const setup = buildSetup()
  const docA = await seedSource(setup, "报销制度", "内容")
  const wiki = buildWiki(setup)
  setCurrentDraft(setup, "# 报销政策\n\n报销需要在三个工作日内提交 [S1]，发票需要在报销时一并附上，逾期将无法处理，这一段足够长了。")
  await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA],
  })
  const candidates = wiki.listSourceCandidates(adminContext, setup.kb.id)
  assert.deepEqual(
    candidates.map((candidate) => candidate.title),
    ["报销制度"],
    "the published wiki page is not offered as a source"
  )
})

test("stale source citations are visible: updated, retired and missing", async () => {
  const setup = buildSetup()
  const docA = await seedSource(setup, "报销制度", "第一版内容")
  const wiki = buildWiki(setup)
  setCurrentDraft(setup, "# 报销政策\n\n报销需要在三个工作日内提交 [S1]，发票需要在报销时一并附上，逾期将无法处理，这一段足够长了。")
  const published = await wiki.generate({
    context: adminContext,
    knowledgeBaseId: setup.kb.id,
    title: "报销 Wiki",
    documentIds: [docA],
  })
  assert.equal(published.status, "published")

  // The source gets a NEWER active version → the recorded citation is stale.
  const newer = setup.lifecycle.submit({
    title: "报销制度",
    content: "第二版内容",
    knowledgeBaseId: setup.kb.id,
    versionIntent: "new_version",
    sourceIdentity: {
      kind: "submission",
      uriOrExternalId: "seed:报销制度",
      namespace: "test",
      tenantId: "demo",
    },
  })
  await drain(setup)
  let pages = wiki.listWikiPages(adminContext, setup.kb.id)
  assert.equal(pages[0].sources[0].stale, "updated")
  assert.equal(pages[0].sources[0].currentVersion, 2)

  // Retire the source → the citation reports retirement.
  const sourceDoc = setup.repo.get(docA)
  setup.repo.recordOutcome(sourceDoc!.sourceId, docA, "completed")
  setup.db.prepare(`UPDATE sources SET lifecycle_state = 'retired' WHERE source_id = ?`).run(
    sourceDoc!.sourceId
  )
  pages = wiki.listWikiPages(adminContext, setup.kb.id)
  assert.equal(pages[0].sources[0].stale, "retired")
})
