/**
 * Ticket 09 P6 + Ticket 29 (EVAL-02B) — Feedback HTTP API.
 *
 * Ticket 29 changed what a submission must prove: it names a message, its run
 * must belong to the caller and must have reached a terminal answer, and the
 * recorded session comes from the run's trace rather than the body. It also
 * added the reviewer surface (list/detail/state) behind review-or-admin.
 */
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { Request, Response, NextFunction } from "express"
import { createFeedbackRouter } from "./feedback"
import { SqliteFeedbackStore } from "../answer/feedback_store"
import {
  createFeedbackTargetResolver,
  type FeedbackTargetResolver,
} from "../answer/feedback_target"
import {
  SINGLE_TENANT_SUBJECT,
  SINGLE_TENANT_TENANT,
  type AccessContext,
  type Scope,
} from "../access/context"
import { openDb } from "../ingestion/tracking/db"
import type { AnswerRunEvent, AnswerTerminalStatus } from "../types"

const ALL_SCOPES: Scope[] = ["chat", "ingest", "review", "admin"]
const READER_SCOPES: Scope[] = ["chat", "ingest"]

/** A run the fake resolver knows about, with its owning identity. */
interface FakeRun {
  sessionId: string
  terminalStatus?: AnswerTerminalStatus
  ownerTenant: string
  ownerSubject: string
  /** True → no terminal event was ever persisted (still streaming / died). */
  streaming?: boolean
}

function doneEvent(runId: string, sessionId: string, status: AnswerTerminalStatus): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    eventId: `${runId}-done`,
    sequence: 2,
    createdAt: "2026-09-23T00:00:00.000Z",
    status,
    durationMs: 5,
    attempt: 1,
    round: 1,
    inputSummary: "in",
    outputSummary: "out",
    type: "done",
    stage: "done",
    result: {
      runId,
      status,
      reply: "answer",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
    },
  } as AnswerRunEvent
}

function progressEvent(runId: string, sessionId: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    eventId: `${runId}-progress`,
    sequence: 1,
    createdAt: "2026-09-23T00:00:00.000Z",
    status: "running",
    durationMs: null,
    attempt: 1,
    round: 1,
    inputSummary: "in",
    outputSummary: "out",
    type: "progress",
    stage: "retrieval",
    message: "retrieval",
  } as unknown as AnswerRunEvent
}

function resolverFrom(runs: Record<string, FakeRun>): FeedbackTargetResolver {
  return createFeedbackTargetResolver({
    getRun: (runId) => {
      const run = runs[runId]
      if (!run) return null
      return {
        sessionId: run.sessionId,
        events: run.streaming
          ? [progressEvent(runId, run.sessionId)]
          : [progressEvent(runId, run.sessionId), doneEvent(runId, run.sessionId, run.terminalStatus ?? "completed")],
      }
    },
    ownsSession: (sessionId, tenantId, subjectId) =>
      Object.values(runs).some(
        (run) =>
          run.sessionId === sessionId &&
          run.ownerTenant === tenantId &&
          run.ownerSubject === subjectId
      ),
  })
}

function buildApp(options: {
  runs?: Record<string, FakeRun>
  middleware?: (req: Request, res: Response, next: NextFunction) => void
} = {}) {
  const app = express()
  const db = openDb(":memory:")
  const feedbackStore = new SqliteFeedbackStore(db)
  const runs = options.runs ?? {
    // The default fixture: one answered run of the deterministic single-tenant
    // identity the bare router falls back to.
    "run-1": {
      sessionId: "session-1",
      ownerTenant: SINGLE_TENANT_TENANT,
      ownerSubject: SINGLE_TENANT_SUBJECT,
    },
  }
  app.use(express.json())
  if (options.middleware) app.use(options.middleware)
  app.use("/api", createFeedbackRouter(feedbackStore, { targetResolver: resolverFrom(runs) }))
  return { app, db, feedbackStore }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  }
}

const putFeedback = (port: number, runId: string, body: unknown = {}, headers = {}) =>
  request(port, "PUT", `/api/chat/runs/${runId}/feedback`, body, headers)

/** Default valid submission: names run-1's message. */
const submission = (extra: Record<string, unknown> = {}) => ({
  messageId: "message-assistant-1",
  rating: "up",
  ...extra,
})

function multiTenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenant = (req.headers["x-test-tenant"] as string | undefined) ?? "default"
  res.locals.accessContext = {
    tenantId: tenant,
    subjectId: `user-${tenant}`,
    groups: [],
    scopes: ALL_SCOPES,
  } satisfies AccessContext
  next()
}

function readerMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.locals.accessContext = {
    tenantId: SINGLE_TENANT_TENANT,
    subjectId: SINGLE_TENANT_SUBJECT,
    groups: [],
    scopes: READER_SCOPES,
  } satisfies AccessContext
  next()
}

test("PUT /feedback: a submission names the answer's message and is stored with the run", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-1", submission({ evidenceIds: ["ev-1"] }))
    assert.equal(res.status, 200)
    assert.equal(res.json?.runId, "run-1")
    assert.equal(res.json?.messageId, "message-assistant-1")
    assert.equal(res.json?.sessionId, "session-1", "the session comes from the run's trace")
    assert.equal(res.json?.rating, "up")
    assert.equal(res.json?.reasonCode, null, "rating=up stores a null reason code")
    assert.equal(res.json?.comment, null)
    assert.deepEqual(res.json?.evidenceIds, ["ev-1"])
    assert.equal(res.json?.status, "open", "a new record is open for review")
    assert.ok(res.json?.id && res.json?.createdAt && res.json?.updatedAt)
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: rating=down with a valid reason code is stored", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(
      port,
      "run-1",
      submission({ rating: "down", reasonCode: "wrong_answer", comment: "答案错了" })
    )
    assert.equal(res.status, 200)
    assert.equal(res.json?.rating, "down")
    assert.equal(res.json?.reasonCode, "wrong_answer")
    assert.equal(res.json?.comment, "答案错了")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: resubmission updates the record in place and re-opens it", async () => {
  const { app, db, feedbackStore } = buildApp()
  const { server, port } = await listen(app)
  try {
    const first = await putFeedback(port, "run-1", submission({ comment: "first" }))
    const storedId = first.json?.id as string
    assert.equal(feedbackStore.review("default", storedId, "reviewed")?.status, "reviewed")

    const second = await putFeedback(
      port,
      "run-1",
      submission({ rating: "down", reasonCode: "incomplete", comment: "changed my mind" })
    )
    assert.equal(second.status, 200)
    assert.equal(second.json?.id, storedId, "the unique triple keeps one row")
    assert.equal(second.json?.createdAt, first.json?.createdAt)
    assert.equal(second.json?.rating, "down")
    assert.equal(second.json?.comment, "changed my mind")
    assert.equal(second.json?.status, "open", "a new rating re-opens the review state")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: malformed bodies are refused before anything is stored", async () => {
  const { app, db, feedbackStore } = buildApp()
  const { server, port } = await listen(app)
  try {
    const missingMessage = await putFeedback(port, "run-1", { rating: "up" })
    assert.equal(missingMessage.status, 400)
    assert.match(JSON.stringify(missingMessage.json?.issues), /messageId/)

    const badRating = await putFeedback(port, "run-1", submission({ rating: "sideways" }))
    assert.equal(badRating.status, 400)
    assert.match(JSON.stringify(badRating.json?.issues), /rating/)

    const longComment = await putFeedback(port, "run-1", submission({ comment: "x".repeat(2_001) }))
    assert.equal(longComment.status, 400)
    assert.match(JSON.stringify(longComment.json?.issues), /comment/)

    const badEvidence = await putFeedback(port, "run-1", submission({ evidenceIds: "ev-1" }))
    assert.equal(badEvidence.status, 400)
    assert.match(JSON.stringify(badEvidence.json?.issues), /evidenceIds/)

    const downNoReason = await putFeedback(port, "run-1", submission({ rating: "down" }))
    assert.equal(downNoReason.status, 400)
    assert.equal(downNoReason.json?.rating, "down", "the reason-code error names the rating")

    const upWithReason = await putFeedback(
      port,
      "run-1",
      submission({ rating: "up", reasonCode: "wrong_answer" })
    )
    assert.equal(upWithReason.status, 400)

    assert.deepEqual(feedbackStore.listForReview("default"), [], "no rejected body wrote a row")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: unknown and cross-user targets answer the same 404", async () => {
  const { app, db } = buildApp({
    runs: {
      "run-1": { sessionId: "session-1", ownerTenant: "default", ownerSubject: "subject-default" },
      "run-other": { sessionId: "session-2", ownerTenant: "default", ownerSubject: "someone-else" },
    },
    middleware: multiTenantMiddleware,
  })
  const { server, port } = await listen(app)
  try {
    // multiTenantMiddleware uses subjectId `user-<tenant>`; the fixture runs are
    // owned by other subjects — both answers must be indistinguishable.
    const unknown = await putFeedback(port, "no-such-run", submission())
    const foreign = await putFeedback(port, "run-other", submission())
    assert.equal(unknown.status, 404)
    assert.equal(foreign.status, 404)
    assert.deepEqual(foreign.json, unknown.json, "a foreign run never reveals that it exists")
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM feedback").get(), { n: 0 })
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: a run without a terminal answer is a 409, not a stored rating", async () => {
  const { app, db } = buildApp({
    runs: {
      "run-1": {
        sessionId: "session-1",
        ownerTenant: SINGLE_TENANT_TENANT,
        ownerSubject: SINGLE_TENANT_SUBJECT,
        streaming: true,
      },
    },
  })
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-1", submission())
    assert.equal(res.status, 409)
    assert.match(String(res.json?.error), /not completed/)
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM feedback").get(), { n: 0 })
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: the recorded session can never come from the body", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(
      port,
      "run-1",
      submission({ sessionId: "someone-elses-session", tenantId: "another-tenant" })
    )
    assert.equal(res.status, 200)
    assert.equal(res.json?.sessionId, "session-1", "the trace owns the session")
    assert.equal(res.json?.tenantId, "default", "the identity owns the tenant")
  } finally {
    server.close()
    db.close()
  }
})

test("GET /feedback: reviewers list and filter by status and provenance", async () => {
  const { app, db } = buildApp({
    runs: {
      "run-1": {
        sessionId: "session-1",
        ownerTenant: SINGLE_TENANT_TENANT,
        ownerSubject: SINGLE_TENANT_SUBJECT,
      },
      "run-2": {
        sessionId: "session-2",
        ownerTenant: SINGLE_TENANT_TENANT,
        ownerSubject: SINGLE_TENANT_SUBJECT,
      },
    },
  })
  const { server, port } = await listen(app)
  try {
    // One record per (tenant, subject, run): two runs, two records.
    await putFeedback(port, "run-1", submission({ messageId: "m-up" }))
    await putFeedback(
      port,
      "run-2",
      submission({ rating: "down", reasonCode: "other", messageId: "m-down" })
    )
    const stored = (await request(port, "GET", "/api/feedback")).json?.feedback as Array<
      Record<string, unknown>
    >
    const downId = stored.find((item) => item.rating === "down")?.id as string
    assert.equal((await request(port, "PATCH", `/api/feedback/${downId}`, { status: "dismissed" })).status, 200)

    const all = await request(port, "GET", "/api/feedback")
    assert.equal(all.status, 200)
    assert.equal((all.json?.feedback as unknown[]).length, 2, "the list is the whole tenant view")

    const dismissed = await request(port, "GET", "/api/feedback?status=dismissed")
    assert.deepEqual(
      (dismissed.json?.feedback as Array<Record<string, unknown>>).map((item) => item.id),
      [downId]
    )
    const down = await request(port, "GET", "/api/feedback?rating=down")
    assert.deepEqual(
      (down.json?.feedback as Array<Record<string, unknown>>).map((item) => item.id),
      [downId]
    )
    const byRun = await request(port, "GET", "/api/feedback?runId=run-1")
    assert.equal((byRun.json?.feedback as unknown[]).length, 1, "the run filter is exact")
    assert.equal((byRun.json?.feedback as Array<Record<string, unknown>>)[0].messageId, "m-up")
    const bySubject = await request(port, "GET", "/api/feedback?subjectId=nobody")
    assert.deepEqual(bySubject.json?.feedback, [])

    const byId = await request(port, "GET", `/api/feedback/${downId}`)
    assert.equal(byId.status, 200)
    assert.equal(byId.json?.messageId, "m-down", "the detail carries the run/message provenance")
    assert.equal(byId.json?.sessionId, "session-2")

    assert.equal((await request(port, "GET", "/api/feedback?status=bogus")).status, 400)
    assert.equal((await request(port, "GET", "/api/feedback?rating=bogus")).status, 400)
    assert.equal((await request(port, "PATCH", `/api/feedback/${downId}`, { status: "bogus" })).status, 400)
    assert.equal((await request(port, "GET", "/api/feedback/unknown-id")).status, 404)
    assert.equal((await request(port, "PATCH", "/api/feedback/unknown-id", { status: "reviewed" })).status, 404)
  } finally {
    server.close()
    db.close()
  }
})

test("GET /feedback: a reader account cannot browse another user's feedback", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const submitted = await putFeedback(port, "run-1", submission())
    const id = submitted.json?.id as string

    const readerApp = buildApp({ middleware: readerMiddleware })
    const reader = await listen(readerApp.app)
    try {
      assert.equal((await request(reader.port, "GET", "/api/feedback")).status, 403)
      assert.equal((await request(reader.port, "GET", `/api/feedback/${id}`)).status, 403)
      assert.equal(
        (await request(reader.port, "PATCH", `/api/feedback/${id}`, { status: "reviewed" })).status,
        403
      )
    } finally {
      reader.server.close()
      readerApp.db.close()
    }
  } finally {
    server.close()
    db.close()
  }
})

test("GET /feedback: a foreign tenant sees its own empty list and a 404 detail", async () => {
  const runs = {
    "run-1": { sessionId: "session-1", ownerTenant: "tenant-a", ownerSubject: "user-tenant-a" },
  }
  const { app, db } = buildApp({ runs, middleware: multiTenantMiddleware })
  const { server, port } = await listen(app)
  try {
    const submitted = await putFeedback(port, "run-1", submission(), { "x-test-tenant": "tenant-a" })
    assert.equal(submitted.status, 200)
    const id = submitted.json?.id as string

    const alien = await request(port, "GET", `/api/feedback/${id}`, undefined, {
      "x-test-tenant": "tenant-b",
    })
    assert.equal(alien.status, 404, "a cross-tenant id is never revealed")
    const alienList = await request(port, "GET", "/api/feedback", undefined, {
      "x-test-tenant": "tenant-b",
    })
    assert.deepEqual(alienList.json?.feedback, [], "the list stays tenant-scoped")
    assert.equal(alienList.status, 200)
    const alienPatch = await request(
      port,
      "PATCH",
      `/api/feedback/${id}`,
      { status: "reviewed" },
      { "x-test-tenant": "tenant-b" }
    )
    assert.equal(alienPatch.status, 404, "a cross-tenant record cannot be moved")
  } finally {
    server.close()
    db.close()
  }
})
