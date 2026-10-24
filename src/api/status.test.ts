import assert from "node:assert/strict"
import test from "node:test"
import express from "express"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type OpenAI from "openai"
import { createStatusRouter } from "./status"
import type { AppConfig } from "../config"

/**
 * 覆盖 /api/status：
 *   - hasKnowledgeBaseContent 字段（ES 可达/计数/不可达四象限）
 *   - Ticket 44 (DEMO-01C)：状态覆盖 ES/Neo4j/Chat/Embedding/Rerank/解析器/
 *     MCP/网络搜索/Langfuse；未配置的可选能力是 unconfigured——绝不冒充
 *     失败或成功；诊断只暴露 HOST，绝不泄露凭据或原始 URL。
 */

function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    esNode: "http://localhost:9200",
    neo4jUri: "bolt://localhost:7687",
    openaiBaseUrl: "",
    openaiChatModel: "gpt-4o-mini",
    openaiApiKey: "sk-test",
    embeddingApiKey: "sk-test",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    rerankApiKey: "",
    mcpCapabilitiesEnabled: false,
    tavilyApiKey: undefined,
    langfusePublicKey: undefined,
    langfuseSecretKey: undefined,
    langfuseBaseUrl: undefined,
    markitdownCommand: "markitdown",
    markerCommand: "marker_single",
    mineruCommand: "mineru",
    ...overrides,
  } as unknown as AppConfig
}

function mockEsClient(opts: {
  pingOk: boolean
  count?: number
  countThrows?: boolean
}): Client {
  return {
    ping: async () => opts.pingOk,
    count: async () => {
      if (opts.countThrows) throw new Error("index_not_found")
      return { count: opts.count ?? 0 }
    },
  } as unknown as Client
}

function mockNeo4jDriver(ok: boolean): Driver {
  return {
    executeQuery: async () => {
      if (!ok) throw new Error("neo4j down")
    },
  } as unknown as Driver
}

function mockOpenAI(ok: boolean): OpenAI {
  return {
    models: {
      list: async () => {
        if (!ok) throw new Error("openai down")
        return { data: [] }
      },
    },
  } as unknown as OpenAI
}

async function callStatus(deps: {
  es: Client
  neo4j: Driver
  openai: OpenAI
  embedding?: OpenAI
  config?: AppConfig
}): Promise<Record<string, unknown>> {
  const app = express()
  app.use("/api", createStatusRouter({
    config: deps.config ?? mockConfig(),
    elasticsearch: deps.es,
    neo4jDriver: deps.neo4j,
    chatClient: deps.openai,
    embeddingClient: deps.embedding ?? deps.openai,
  }))
  const server = app.listen(0)
  await new Promise<void>((r) => server.once("listening", r))
  const port = (server.address() as { port: number }).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`)
    return await res.json() as Record<string, unknown>
  } finally {
    server.close()
  }
}

test("status: ES reachable and count > 0 → hasKnowledgeBaseContent=true", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 42 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, true)
})

test("status: ES reachable but count = 0 → hasKnowledgeBaseContent=false", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 0 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, false)
})

test("status: ES reachable but count throws (index missing) → hasKnowledgeBaseContent=false", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, countThrows: true }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, false)
})

test("status: ES unreachable → hasKnowledgeBaseContent=false (count not called)", async () => {
  let countCalled = false
  const es = {
    ping: async () => false,
    count: async () => { countCalled = true; return { count: 999 } },
  } as unknown as Client
  const body = await callStatus({
    es,
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, false)
  assert.equal(countCalled, false, "count should not be called when ES ping fails")
})

test("ticket 44: the status covers every capability the demo promises", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 42 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  const channels = body.channels as Record<string, { status: string }>
  for (const channel of [
    "elasticsearch",
    "neo4j",
    "chat",
    "embedding",
    "rerank",
    "parsers",
    "mcp",
    "webSearch",
    "langfuse",
  ]) {
    assert.ok(channels[channel], `the status covers ${channel}`)
    assert.ok(channels[channel].status, `${channel} carries a status`)
  }
  assert.equal(channels.chat.status, "connected")
  assert.equal(channels.embedding.status, "connected")
})

test("ticket 44: unconfigured optional services are unconfigured — never failed or successful", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 1 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  const channels = body.channels as Record<string, { status: string; detail: string }>
  assert.equal(channels.rerank.status, "unconfigured")
  assert.equal(channels.mcp.status, "unconfigured")
  assert.equal(channels.webSearch.status, "unconfigured")
  assert.equal(channels.langfuse.status, "unconfigured")
})

test("ticket 44: configured-but-unprobed capabilities report configured, not connected", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 1 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
    config: mockConfig({
      rerankApiKey: "sk-rerank",
      mcpCapabilitiesEnabled: true,
      tavilyApiKey: "tvly-test",
      langfusePublicKey: "pk-test",
      langfuseSecretKey: "sk-test",
    }),
  })
  const channels = body.channels as Record<string, { status: string }>
  assert.equal(channels.rerank.status, "configured")
  assert.equal(channels.mcp.status, "configured")
  assert.equal(channels.webSearch.status, "configured")
  assert.equal(channels.langfuse.status, "configured")
})

test("ticket 44: diagnostics expose HOSTS only — no credentials, no raw URLs", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 1 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
    config: mockConfig({
      esNode: "http://user:secret@es.internal:9200",
      neo4jUri: "bolt://user:secret@neo.internal:7687",
      openaiBaseUrl: "https://user:secret@provider.example/v1",
    }),
  })
  const serialized = JSON.stringify(body)
  assert.doesNotMatch(serialized, /secret|sk-test-key|sk-rerank|tvly-test|pk-test/)
  const config = body.config as Record<string, string>
  assert.equal(config.esNodeHost, "es.internal:9200")
  assert.equal(config.neo4jUriHost, "neo.internal:7687")
  assert.equal(config.chatBaseUrlHost, "provider.example")
})

test("ticket 44: probe errors are bounded AND redacted before leaving the server", async () => {
  const leaking = {
    models: {
      list: async () => {
        throw new Error(
          `401 at https://user:secret@provider.example/v1 — key sk-test-key-12345 rejected`
        )
      },
    },
  } as unknown as OpenAI
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 1 }),
    neo4j: mockNeo4jDriver(true),
    openai: leaking,
    config: mockConfig({
      openaiApiKey: "sk-test-key-12345",
      openaiBaseUrl: "https://user:secret@provider.example/v1",
    }),
  })
  const serialized = JSON.stringify(body)
  assert.doesNotMatch(serialized, /sk-test-key-12345/)
  assert.doesNotMatch(serialized, /provider\.example\/v1 — key/)
  const channels = body.channels as Record<string, { status: string; error: string | null }>
  assert.equal(channels.chat.status, "degraded")
  assert.match(channels.chat.error ?? "", /\*\*\*/, "the secret is redacted in place")
  assert.ok((channels.chat.error ?? "").length <= 200, "the error is bounded")
})

test("status counts only the selected physical index", async () => {
  const indices: string[] = []
  const body = await callStatus({
    config: mockConfig({ esChunkIndexName: "selected-v2" }),
    es: { ping: async () => true, count: async ({index}: {index: string}) => {
      indices.push(index)
      return {count: index === "selected-v2" ? 0 : 42}
    }} as unknown as Client,
    neo4j: mockNeo4jDriver(true), openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, false)
  assert.deepEqual(indices, ["selected-v2"])
})
