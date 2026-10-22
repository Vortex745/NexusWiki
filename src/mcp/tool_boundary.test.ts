/**
 * DR-20 (T1-AC07 / T1-AC09) — the MCP tool boundary under failure.
 *
 * A REAL local stdio MCP child is discovered and called through the shared
 * tool boundary; the boundary's deadline bounds a tool that never answers, and
 * an ordinary HTTP chat run still reaches its terminal while an MCP server is
 * unreachable or an MCP tool has timed out. No remote service is involved.
 */

import "dotenv/config"
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import path from "node:path"
import test from "node:test"
import express from "express"

import { loadConfig } from "../config"
import type { AccessContext } from "../access/context"
import { ToolRegistry, ToolInvocationService } from "../tools/invocation"
import { createMcpToolBridge } from "./tool_bridge"
import { HANGING_TOOL_NAME } from "./fixtures/hanging_server"
import { createChatRouter } from "../api/chat"
import {
  createMastraChatEventAdapter,
  type MastraRunner,
  type MastraRunnerOutput,
} from "../mastra/chat_event_adapter"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb } from "../ingestion/tracking/db"
import type { AnswerRunEvent } from "../types"

const config = loadConfig()
const HANGING_SERVER = path.resolve(__dirname, "fixtures", "hanging_server.ts")
const hangingServerCommand = {
  command: process.execPath,
  args: ["--import", "tsx", "--import", "dotenv/config", HANGING_SERVER],
}
const accessContext: AccessContext = {
  tenantId: "tenant-a",
  subjectId: "alice",
  groups: [],
  scopes: ["chat"],
}

function completedAnswer(reply: string): MastraRunnerOutput {
  return {
    reply,
    status: "completed",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
    tokens: [reply],
    routeTrace: { decision: "simple" },
    retrievalTrace: {},
    contextTrace: {},
    validationTrace: {},
  }
}

function buildChatApp(runner: MastraRunner) {
  const db = openDb(":memory:")
  const repository = new AnswerTraceRepository(db)
  const source = createMastraChatEventAdapter({ runner, traceObserver: repository })
  const app = express()
  app.use(express.json())
  app.use("/api", createChatRouter(repository, source))
  return { app, db }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function terminals(events: AnswerRunEvent[]) {
  return events.filter((event) => event.type === "done")
}

test("DR-20 AC02: a local MCP tool that never answers is bounded by the invocation deadline", { timeout: 60_000 }, async () => {
  const registry = new ToolRegistry()
  const bridge = await createMcpToolBridge({
    registry,
    config,
    serverCommand: hangingServerCommand,
    connectTimeoutMs: 20_000,
  })
  assert.ok(bridge)
  try {
    assert.equal(bridge!.status().connected, true, `discovery failed: ${bridge!.status().error ?? ""}`)
    const service = new ToolInvocationService({
      registry,
      allowedTools: [...bridge!.toolNames()],
      timeoutMs: 400,
    })
    const started = Date.now()
    const invocation = await service.invoke(
      `mcp_capabilities_${HANGING_TOOL_NAME}`,
      {},
      { accessContext }
    )
    const elapsed = Date.now() - started
    assert.equal(invocation.outcome, "timeout")
    assert.ok(elapsed < 5_000, `the call must converge, took ${elapsed}ms`)
    assert.match(invocation.trace.error ?? "", /400ms deadline/)
  } finally {
    await bridge!.close()
  }
})

test("DR-20 AC02/AC03: ordinary HTTP chat still answers a timed-out MCP tool call", { timeout: 90_000 }, async () => {
  const registry = new ToolRegistry()
  const bridge = await createMcpToolBridge({
    registry,
    config,
    serverCommand: hangingServerCommand,
    connectTimeoutMs: 20_000,
  })
  assert.ok(bridge)
  const service = new ToolInvocationService({
    registry,
    allowedTools: [...bridge!.toolNames()],
    timeoutMs: 400,
  })
  let toolOutcome: string | undefined
  const runner: MastraRunner = async (input) => {
    const invocation = await service.invoke(
      `mcp_capabilities_${HANGING_TOOL_NAME}`,
      {},
      { accessContext: input.accessContext, signal: input.signal }
    )
    toolOutcome = invocation.outcome
    return completedAnswer(
      invocation.outcome === "timeout"
        ? "MCP 能力查询超时，已继续回答这条普通问题。"
        : `unexpected:${invocation.outcome}`
    )
  }
  const { app, db } = buildChatApp(runner)
  const { server, port } = await listen(app)
  try {
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "退货期限是多久？",
        stream: false,
        runId: "dr20-timeout-chat",
        sessionId: "dr20-timeout-chat",
      }),
    })
    const elapsed = Date.now() - started
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      reply: string
      status: string
      events: AnswerRunEvent[]
    }
    assert.equal(elapsed < 10_000, true, `chat must not hang: ${elapsed}ms`)
    assert.equal(body.status, "completed")
    assert.match(body.reply, /MCP 能力查询超时/)
    assert.equal(toolOutcome, "timeout")
    const done = terminals(body.events)
    assert.equal(done.length, 1, "exactly one bounded terminal")
    assert.equal(body.events.at(-1)?.type, "done")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    await bridge!.close()
  }
})

test("DR-20 AC02: an unreachable MCP server leaves ordinary HTTP chat answering, with a visible status", { timeout: 60_000 }, async () => {
  const bridge = await createMcpToolBridge({
    registry: new ToolRegistry(),
    config,
    serverCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    connectTimeoutMs: 5_000,
  })
  assert.ok(bridge)
  const { app, db } = buildChatApp(async () => completedAnswer("普通问答正常回答。"))
  const { server, port } = await listen(app)
  try {
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "退货期限是多久？",
        stream: false,
        runId: "dr20-unreachable-chat",
        sessionId: "dr20-unreachable-chat",
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(Date.now() - started < 10_000, true, "chat must not hang")
    const body = (await response.json()) as { status: string; events: AnswerRunEvent[] }
    assert.equal(body.status, "completed")
    assert.equal(terminals(body.events).length, 1)
    // The failure is VISIBLE, not silence: the bridge reports it and registers
    // nothing, so no unreachable tool ever joins the run's allowlist.
    const status = bridge!.status()
    assert.equal(status.connected, false)
    assert.ok(status.error)
    assert.deepEqual(status.tools, [])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    await bridge!.close()
  }
})
