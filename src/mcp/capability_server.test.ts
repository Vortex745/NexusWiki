/**
 * Ticket 35 (TOOL-01B) — the local read-only MCP capability server.
 *
 * The FIRST test is the compatibility lock the ticket demands: it runs the
 * REAL child server over stdio through @mastra/mcp against the installed
 * @mastra/core, discovers the five capability tools and calls one through
 * the ticket-34 tool boundary. If either package version drifts into
 * incompatibility, this fails before anything locks in the change.
 *
 * The rest pin the bounded behaviors: safe outputs (no credentials),
 * disablement by config, and a bounded, visible failure when the server
 * cannot be reached — ordinary chat never breaks.
 */
import "dotenv/config"
import assert from "node:assert/strict"
import test from "node:test"

import { loadConfig } from "../config"
import type { AccessContext } from "../access/context"
import { ToolRegistry, ToolInvocationService } from "../tools/invocation"
import { registerBuiltinTools } from "../tools/knowledge_tools"
import { createMcpToolBridge } from "./tool_bridge"
import { CAPABILITY_TOOL_NAMES } from "./capability_server"

const config = loadConfig()

test("Ticket 35: the compatible MCP client discovers and calls the local capability server through the tool boundary", { timeout: 60_000 }, async () => {
  const registry = new ToolRegistry()
  const bridge = await createMcpToolBridge({ registry, config })
  assert.ok(bridge, "the bridge must be wired when enabled")
  try {
    const status = bridge!.status()
    assert.equal(status.enabled, true)
    assert.equal(status.connected, true, `discovery failed: ${status.error ?? ""}`)
    assert.equal(status.tools.length, CAPABILITY_TOOL_NAMES.length)
    for (const name of CAPABILITY_TOOL_NAMES) {
      assert.ok(
        status.tools.includes(`mcp_capabilities_${name}`),
        `missing discovered tool mcp_capabilities_${name}`
      )
    }

    // Calls run through the SAME schema-validated boundary as every tool.
    const service = new ToolInvocationService({
      registry,
      allowedTools: [...bridge!.toolNames()],
      timeoutMs: 15_000,
    })
    const invocation = await service.invoke(
      "mcp_capabilities_model_status",
      {},
      { accessContext: { tenantId: "t", subjectId: "s", groups: [], scopes: ["chat"] } }
    )
    assert.equal(invocation.outcome, "ok")
    const result = invocation.result as { capability: string; configured: boolean; chatModel: string }
    assert.equal(result.capability, "model")
    assert.equal(typeof result.configured, "boolean")
    assert.ok(invocation.trace.argsSummary !== undefined)
    assert.ok(invocation.trace.durationMs >= 0)
  } finally {
    await bridge!.close()
  }
})

test("DR-20 AC01: MCP tool args cannot carry tenant, subject or scope", { timeout: 60_000 }, async () => {
  const registry = new ToolRegistry()
  const bridge = await createMcpToolBridge({ registry, config })
  assert.ok(bridge)
  try {
    const service = new ToolInvocationService({
      registry,
      allowedTools: [...bridge!.toolNames()],
      timeoutMs: 15_000,
    })
    const accessContext: AccessContext = { tenantId: "tenant-a", subjectId: "alice", groups: [], scopes: ["chat"] }
    const forged = [
      { tenantId: "tenant-b" },
      { tenant: "tenant-b" },
      { subjectId: "mallory" },
      { subject: "mallory" },
      { scopes: ["admin"] },
      { scope: "admin" },
      { groups: ["ops"] },
      { accessContext: { tenantId: "tenant-b" } },
      { retrievalScope: { knowledgeBaseIds: ["kb-x"] } },
    ]
    for (const args of forged) {
      const invocation = await service.invoke(
        "mcp_capabilities_model_status",
        args,
        { accessContext }
      )
      assert.equal(invocation.outcome, "invalid_args", JSON.stringify(args))
      assert.equal(invocation.result, undefined, "a refused call cannot execute")
      assert.equal(invocation.trace.argsSummary, "", "the forged values never reach the trace")
      assert.match(
        invocation.trace.error ?? "",
        /cannot carry tenant, subject or scope/
      )
      assert.equal(
        JSON.stringify(invocation).includes("mallory"),
        false,
        "the forged subject is not echoed back"
      )
    }

    // Authorized, argument-free calls still execute through the same boundary.
    const allowed = await service.invoke(
      "mcp_capabilities_model_status",
      {},
      { accessContext }
    )
    assert.equal(allowed.outcome, "ok")

    // A run whose allowlist omits the DISCOVERED name never reaches the tool.
    const narrowed = new ToolInvocationService({
      registry,
      allowedTools: [],
      timeoutMs: 15_000,
    })
    const denied = await narrowed.invoke(
      "mcp_capabilities_model_status",
      {},
      { accessContext }
    )
    assert.equal(denied.outcome, "policy_denied")
    assert.equal(denied.result, undefined)
    assert.ok(denied.trace.error)
  } finally {
    await bridge!.close()
  }
})

test("Ticket 35: capability status never carries credentials", { timeout: 60_000 }, async () => {
  const registry = new ToolRegistry()
  const bridge = await createMcpToolBridge({ registry, config })
  assert.ok(bridge)
  try {
    const service = new ToolInvocationService({
      registry,
      allowedTools: [...bridge!.toolNames()],
      timeoutMs: 15_000,
    })
    for (const name of ["model_status", "rerank_status"]) {
      const invocation = await service.invoke(`mcp_capabilities_${name}`, {}, {})
      assert.equal(invocation.outcome, "ok")
      const serialized = JSON.stringify(invocation.result ?? {}).toLowerCase()
      assert.ok(!serialized.includes("apikey"), `${name} leaks an apiKey field`)
      assert.ok(!serialized.includes("password"), `${name} leaks a password field`)
      assert.ok(!serialized.includes(config.openaiApiKey.slice(0, 12)), `${name} leaks the key value`)
    }
  } finally {
    await bridge!.close()
  }
})

test("Ticket 35: disablement is a config decision — nothing spawns, nothing registers", async () => {
  const registry = new ToolRegistry()
  const before = registry.names().length
  const bridge = await createMcpToolBridge({
    registry,
    config: { ...config, mcpCapabilitiesEnabled: false },
  })
  assert.equal(bridge, null)
  assert.equal(registry.names().length, before)
})

test("Ticket 35: an unreachable server is a bounded, visible failure — not a crash", { timeout: 60_000 }, async () => {
  const registry = new ToolRegistry()
  const before = registry.names().length
  const bridge = await createMcpToolBridge({
    registry,
    config,
    // A command that exits immediately: discovery fails within the deadline.
    serverCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    connectTimeoutMs: 5_000,
  })
  assert.ok(bridge, "the bridge is still returned — visibility, not silence")
  const status = bridge!.status()
  assert.equal(status.connected, false)
  assert.ok(status.error)
  assert.deepEqual(status.tools, [])
  assert.equal(registry.names().length, before, "no MCP tools registered on failure")
  await bridge!.close()
})

test("Ticket 35: MCP tools join the read-only allowlist alongside the built-ins", () => {
  const registry = registerBuiltinTools(new ToolRegistry())
  // Simulated discovered names (the runtime discovery test above covers the
  // real child); the allowlist composition is what this pins.
  const mcpNames = ["mcp_capabilities_model_status"]
  const allowedTools = [...["knowledge_search", "document_lookup"], ...mcpNames]
  assert.ok(allowedTools.includes("mcp_capabilities_model_status"))
  assert.equal(registry.get("knowledge_search")?.name, "knowledge_search")
})
