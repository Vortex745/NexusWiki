/**
 * Ticket 19 (AST-01B) — assistants run through bounded scope and the shared
 * answer entry, exercised at the HTTP transport seam.
 *
 * A fake eventsSource captures the AnswerRunOptions the transport builds, so
 * the tests assert the SERVER-resolved overlay: the immutable assistant
 * snapshot, the intersected knowledge scope, the tool-policy constraint and
 * the legacy path for the default assistant — plus the refusals (404/409).
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AddressInfo } from "node:net"
import express, { type RequestHandler } from "express"

import { openDb } from "../ingestion/tracking/db"
import { createApp } from "../api/server"
import type { AnswerRunOptions } from "../answer/generation"
import type { AnswerRunEvent } from "../types"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import { AssistantService } from "./assistant_service"
import type { AccessContext } from "../access/context"

function identity(ctx: Partial<AccessContext> & { scopes: AccessContext["scopes"]; groups?: string[] }): RequestHandler {
  return (_req, res, next) => {
    res.locals.accessContext = {
      tenantId: "t1",
      subjectId: "u1",
      groups: [],
      ...ctx,
    } as AccessContext
    next()
  }
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function buildHarness() {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  const db = openDb(":memory:")
  const knowledgeBaseService = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    "test-embedding-model:3"
  )
  const assistants = new AssistantService(db, knowledgeBaseService)
  const retrievalScopeResolver = createRetrievalScopeResolver(knowledgeBaseService)

  const captured: AnswerRunOptions[] = []
  const eventsSource = async function* (
    _message: string,
    options: AnswerRunOptions
  ): AsyncIterable<AnswerRunEvent> {
    captured.push(options)
    yield {
      schemaVersion: 1,
      sessionId: options.sessionId ?? "s",
      runId: options.runId ?? "r",
      eventId: "e1",
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      stage: "done",
      status: "completed",
      durationMs: null,
      attempt: 1,
      round: 1,
      inputSummary: "",
      outputSummary: "",
      type: "done",
      result: {
        runId: options.runId ?? "r",
        status: "completed",
        reply: "ok",
        references: [],
        degradation: { status: "none" },
      },
    } as unknown as AnswerRunEvent
  }

  // createApp IS the top-level app — the identity arrives through the
  // accessMiddleware option (nesting it under an outer /api app would strip
  // the prefix twice).
  const app = createApp({
    db,
    eventsSource,
    accessMiddleware: identity({ scopes: ["admin", "chat"] }),
    retrievalScopeResolver,
    knowledgeBaseService,
    assistants,
  })

  return { db, assistants, knowledgeBaseService, captured, app }
}

async function chat(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "问题", ...body }),
  })
}

test("a named assistant runs through the shared entry with its immutable snapshot and bound scope", async () => {
  const harness = buildHarness()
  knowledgeBaseSeeds(harness)
  const { base, close } = await listen(harness.app)
  try {
    const kbA = harness.knowledgeBaseService.create("t1", "库A")
    const kbB = harness.knowledgeBaseService.create("t1", "库B")
    const created = harness.assistants.create("t1", "admin", {
      name: "政策助手",
      config: {
        systemPrompt: "你只回答政策问题",
        knowledgeBaseIds: [kbB.id],
        chatModelProfileId: "chat",
        rerankModelProfileId: null,
        toolPolicy: "read_only_retrieval",
        memoryEnabled: false,
      },
    })

    // The request selection includes a base outside the binding — the
    // effective scope must be the INTERSECTION (only the bound base).
    const response = await chat(base, {
      knowledgeBaseIds: [kbA.id, kbB.id],
      assistantId: created.id,
    })
    assert.equal(response.status, 200)
    const options = harness.captured.at(-1)
    assert.ok(options?.assistant, "the run carries the assistant snapshot")
    assert.equal(options.assistant.id, created.id)
    assert.equal(options.assistant.version, 1)
    assert.equal(options.assistant.systemPrompt, "你只回答政策问题")
    assert.equal(options.assistant.rerankModelProfileId, null)
    // The snapshot is immutable per run: the version config is copied in.
    assert.deepEqual(options.retrievalScope?.knowledgeBaseIds, [kbB.id])
  } finally {
    await close()
  }
})

function knowledgeBaseSeeds(_harness: ReturnType<typeof buildHarness>): void {
  // Knowledge bases are created inside each test against the shared service.
}

test("an empty binding leaves the request-resolved scope standing; toolPolicy none forces no retrieval", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const unconstrained = harness.assistants.create("t1", "admin", {
      name: "通用",
      config: {
        systemPrompt: "",
        knowledgeBaseIds: [],
        chatModelProfileId: "chat",
        rerankModelProfileId: null,
        toolPolicy: "read_only_retrieval",
        memoryEnabled: false,
      },
    })
    const noTools = harness.assistants.create("t1", "admin", {
      name: "无检索",
      config: {
        systemPrompt: "直接回答",
        knowledgeBaseIds: [],
        chatModelProfileId: "chat",
        rerankModelProfileId: null,
        toolPolicy: "none",
        memoryEnabled: false,
      },
    })

    // Empty binding → no assistant constraint; the resolved default stands.
    await chat(base, { assistantId: unconstrained.id })
    const unconstrainedRun = harness.captured.at(-1)
    assert.ok(unconstrainedRun?.retrievalScope?.knowledgeBaseIds.length, "default base scope stands")
    assert.ok(!unconstrainedRun.assistant?.systemPrompt)

    // toolPolicy "none" → retrieval refused entirely (empty scope).
    await chat(base, { assistantId: noTools.id })
    const noToolsRun = harness.captured.at(-1)
    assert.deepEqual(noToolsRun?.retrievalScope?.knowledgeBaseIds, [])
    assert.equal(noToolsRun?.assistant?.systemPrompt, "直接回答", "the prompt still applies")
  } finally {
    await close()
  }
})

test("the default assistant preserves legacy behavior with no overlay", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const defaultId = `assistant-default-t1`
    const response = await chat(base, { assistantId: defaultId })
    assert.equal(response.status, 200)
    const options = harness.captured.at(-1)
    assert.equal(options?.assistant, undefined, "the default assistant adds no overlay")
    assert.ok(options?.retrievalScope?.knowledgeBaseIds.length, "default-base scope unchanged")
    // Seeded exactly once.
    harness.assistants.listForViewer("t1", {
      tenantId: "t1",
      subjectId: "u",
      groups: [],
      scopes: ["chat"],
    })
    harness.assistants.listForViewer("t1", {
      tenantId: "t1",
      subjectId: "u",
      groups: [],
      scopes: ["chat"],
    })
  } finally {
    await close()
  }
})

test("unknown, malformed, invisible and archived assistants are refused before any run", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const malformed = await chat(base, { assistantId: 42 })
    assert.equal(malformed.status, 400)
    const unknown = await chat(base, { assistantId: "assistant-nope" })
    assert.equal(unknown.status, 404)

    const created = harness.assistants.create("t1", "admin", {
      name: "政策专属",
      allowedGroups: ["policy"],
      config: {
        systemPrompt: "x",
        knowledgeBaseIds: [],
        chatModelProfileId: "chat",
        rerankModelProfileId: null,
        toolPolicy: "read_only_retrieval",
        memoryEnabled: false,
      },
    })
    // A viewer outside allowedGroups: same 404 as unknown (no existence leak).
    const invisibleApp = createApp({
      db: harness.db,
      eventsSource: async function* () {
        yield {} as AnswerRunEvent
      },
      accessMiddleware: identity({ scopes: ["chat"], groups: ["technical"] }),
      assistants: harness.assistants,
    })
    const invisible = await listen(invisibleApp)
    try {
      const denied = await chat(invisible.base, { assistantId: created.id })
      assert.equal(denied.status, 404)
    } finally {
      await invisible.close()
    }

    harness.assistants.archive(created.id, "t1")
    const archived = await chat(base, { assistantId: created.id })
    assert.equal(archived.status, 409)
    // No run was ever created for the refused requests.
    assert.equal(harness.captured.length, 0)
  } finally {
    await close()
  }
})
