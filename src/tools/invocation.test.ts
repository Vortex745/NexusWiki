/**
 * Ticket 34 (TOOL-01A) — the tool-invocation boundary.
 *
 * Strict schemas reject argument smuggling (identity and scope cannot travel
 * through args), the allowlist gates before anything executes, timeouts and
 * cancellations converge to one bounded outcome each, and every invocation —
 * executed or refused — leaves a trace record.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { z } from "zod"
import {
  ToolRegistry,
  ToolInvocationService,
  type ToolDefinition,
  type ToolEnvironment,
} from "./invocation"
import type { AccessContext } from "../access/context"

const context: AccessContext = {
  tenantId: "tenant-a",
  subjectId: "alice",
  groups: ["support"],
  scopes: ["chat"],
}

const env: ToolEnvironment = { accessContext: context }

const echoTool: ToolDefinition<{ text: string; extra?: string }, { text: string }> = {
  name: "echo",
  description: "echoes validated input",
  schema: z.strictObject({ text: z.string().min(1).max(100), extra: z.string().optional() }),
  summarize: (args) => `text=${args.text}`,
  execute: async (args) => ({ text: args.text }),
}

function service(allowedTools: readonly string[] = ["echo"], overrides: Partial<{ registry: ToolRegistry; timeoutMs: number }> = {}) {
  const registry = overrides.registry ?? new ToolRegistry().register(echoTool)
  return new ToolInvocationService({
    registry,
    allowedTools,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  })
}

test("Ticket 34: an unknown tool and a non-allowlisted tool never execute", async () => {
  const tool = service(["echo"])
  const unknown = await tool.invoke("nope", {}, env)
  assert.equal(unknown.outcome, "unknown_tool")
  assert.equal(unknown.result, undefined)
  assert.equal(unknown.trace.tool, "nope")

  // A registry that holds the tool but whose allowlist omits it.
  const gated = service(["other_tool"])
  const denied = await gated.invoke("echo", { text: "hi" }, env)
  assert.equal(denied.outcome, "policy_denied")
  assert.equal(denied.result, undefined)
  assert.ok(denied.trace.error)
  // An empty allowlist (toolPolicy "none") refuses everything.
  const none = service([])
  assert.equal((await none.invoke("echo", { text: "hi" }, env)).outcome, "policy_denied")
})

test("Ticket 34: strict schemas reject invalid args and argument smuggling", async () => {
  const tool = service()
  const missing = await tool.invoke("echo", {}, env)
  assert.equal(missing.outcome, "invalid_args")

  // Unknown keys are rejected: identity and scope cannot travel in args.
  const smuggled = await tool.invoke(
    "echo",
    { text: "hi", accessContext: { tenantId: "evil" }, retrievalScope: { knowledgeBaseIds: ["kb-x"] } },
    env
  )
  assert.equal(smuggled.outcome, "invalid_args")
  assert.equal(smuggled.result, undefined)

  // Non-string args never reach the tool.
  const wrongType = await tool.invoke("echo", { text: 42 }, env)
  assert.equal(wrongType.outcome, "invalid_args")

  // Valid args pass validated values only.
  const ok = await tool.invoke("echo", { text: "hi", extra: "x" }, env)
  assert.equal(ok.outcome, "ok")
  assert.deepEqual(ok.result, { text: "hi" })
  assert.equal(ok.trace.argsSummary, "text=hi")
  assert.ok(ok.trace.durationMs >= 0)
})

test("Ticket 34: a tool exceeding its deadline converges to the bounded timeout outcome", async () => {
  // A tool that hangs until its linked signal fires — the shape every
  // abort-aware tool has; the deadline must abort it.
  const slowTool: ToolDefinition<{ wait: boolean }, string> = {
    name: "slow",
    description: "hangs until aborted",
    schema: z.strictObject({ wait: z.boolean() }),
    summarize: () => "slow",
    execute: async (_args, toolEnv) =>
      new Promise<string>((_resolve, reject) => {
        toolEnv.signal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      }),
  }
  const tool = service(["slow"], { registry: new ToolRegistry().register(slowTool), timeoutMs: 60 })
  const outcome = await tool.invoke("slow", { wait: true }, env)
  assert.equal(outcome.outcome, "timeout")
  assert.ok(outcome.trace.error)
})

test("Ticket 34: the deadline is a race, not advisory — a signal-blind hung tool still converges", async () => {
  // Ignores its signal entirely (like a third-party MCP client): the 60ms
  // deadline must still bound the invocation instead of hanging the run.
  const blindTool: ToolDefinition<Record<string, never>, string> = {
    name: "blind",
    description: "hangs forever, ignores the signal",
    schema: z.strictObject({}),
    summarize: () => "blind",
    execute: () => new Promise<string>(() => {}),
  }
  const tool = service(["blind"], {
    registry: new ToolRegistry().register(blindTool),
    timeoutMs: 60,
  })
  const outcome = await tool.invoke("blind", {}, env)
  assert.equal(outcome.outcome, "timeout")
  assert.ok(outcome.trace.error)
})

test("Ticket 34: the run's signal cancels in-flight tools via AbortError", async () => {
  const controller = new AbortController()
  const cancelAware: ToolDefinition<Record<string, never>, string> = {
    name: "cancel_aware",
    description: "honors the linked signal",
    schema: z.strictObject({}),
    summarize: () => "",
    execute: async (_args, toolEnv) =>
      new Promise<string>((_resolve, reject) => {
        toolEnv.signal?.addEventListener("abort", () => {
          const error = new Error("cancelled")
          error.name = "AbortError"
          reject(error)
        })
      }),
  }
  const tool = service(["cancel_aware"], {
    registry: new ToolRegistry().register(cancelAware),
    timeoutMs: 5_000,
  })
  const pending = tool.invoke("cancel_aware", {}, { ...env, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error: Error) => error.name === "AbortError")
})

test("Ticket 34: a tool failure is a bounded outcome, not a crash", async () => {
  const failing: ToolDefinition<Record<string, never>, never> = {
    name: "fails",
    description: "throws",
    schema: z.strictObject({}),
    summarize: () => "",
    execute: async () => {
      throw new Error("backend exploded with sensitive details")
    },
  }
  const tool = service(["fails"], { registry: new ToolRegistry().register(failing) })
  const outcome = await tool.invoke("fails", {}, env)
  assert.equal(outcome.outcome, "failed")
  assert.ok(outcome.trace.error)
  // The trace is bounded — a provider error message cannot leak unbounded text.
  assert.ok(outcome.trace.error!.length <= 200)
})
