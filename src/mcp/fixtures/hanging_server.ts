/**
 * DR-20 test fixture — a local stdio MCP server whose only tool never settles.
 *
 * It exists so the tool boundary can be proven against a REAL MCP child: the
 * server speaks the protocol (discovery succeeds) but never answers the tool
 * invocation, exactly like a wedged local server. The test spawns this file
 * through the bridge's `serverCommand` seam; production never loads it.
 */

import path from "node:path"
import { MCPServer } from "@mastra/mcp"
import { createTool } from "@mastra/core/tools"
import { z } from "zod"

export const HANGING_TOOL_NAME = "hanging_status"

export function createHangingServer(): MCPServer {
  return new MCPServer({
    name: "dr20-hanging",
    version: "1.0.0",
    tools: {
      [HANGING_TOOL_NAME]: createTool({
        id: HANGING_TOOL_NAME,
        description: "Never answers: the fixture for a timed-out MCP call.",
        inputSchema: z.strictObject({}),
        execute: () => new Promise(() => {}),
      }),
    },
  })
}

// Start the stdio server ONLY when this file is the child entry; importing it
// from the test (to read the tool name) must not start anything.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void createHangingServer().startStdio()
}
