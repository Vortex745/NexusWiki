/**
 * Ticket 35 (TOOL-01B) — the product-level MCP capability invocation surface.
 *
 * GET /api/capabilities invokes every discovered MCP capability tool through
 * the SAME schema-validated boundary the runs use (allowlist, 30s deadline,
 * bounded trace records) and reports only safe capability status: booleans,
 * identifiers, availability flags — never credentials or endpoints. The
 * route exists exactly when the composition wired the MCP bridge; MCP
 * failure degrades to per-tool failure outcomes here and never breaks chat.
 */

import { Router, type Request, type Response } from "express"

export interface McpCapabilityInvoker {
  status(): {
    enabled: boolean
    connected: boolean
    tools: string[]
    error?: string
  }
  invoke(
    name: string
  ): Promise<{
    outcome: string
    result?: unknown
    trace: { tool: string; argsSummary: string; outcome: string; durationMs: number; error?: string }
  }>
}

export function createCapabilitiesRouter(deps: { mcp: McpCapabilityInvoker }): Router {
  const router = Router()

  router.get("/capabilities", async (_req: Request, res: Response) => {
    const status = deps.mcp.status()
    // Every discovered tool is invoked through the boundary, in parallel,
    // each under its own deadline — a half-dead backend reports as that
    // tool's failure, not a route hang.
    const capabilities = await Promise.all(
      status.tools.map(async (tool) => {
        try {
          const invocation = await deps.mcp.invoke(tool)
          return {
            tool,
            outcome: invocation.outcome,
            // Only the tool's own safe status payload crosses the boundary.
            ...(invocation.outcome === "ok" ? { result: invocation.result } : {}),
            trace: invocation.trace,
          }
        } catch (error) {
          // Cancellation is the one rethrow the boundary keeps; on this
          // route it is simply a bounded failure for that tool.
          return {
            tool,
            outcome: "failed",
            trace: {
              tool,
              argsSummary: "",
              outcome: "failed",
              durationMs: 0,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
            },
          }
        }
      })
    )
    res.json({ mcp: status, capabilities })
  })

  return router
}
