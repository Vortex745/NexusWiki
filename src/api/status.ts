import { Router, type Request, type Response } from "express"
import { spawn } from "node:child_process"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type OpenAI from "openai"
import type { AppConfig } from "../config"
import { resolveChunkIndexName } from "../config"

/**
 * Ticket 44 (DEMO-01C): the capability status surface.
 *
 * Coverage: Elasticsearch, Neo4j, Chat, Embedding, Rerank, parsers, MCP,
 * web search and optional Langfuse. Two honesty rules shape the response:
 *
 *   1. UNCONFIGURED is its own state. An optional service the deployment
 *      did not configure (rerank key, Tavily, Langfuse, MCP toggle) never
 *      appears failed OR successful — it reports `unconfigured`, and a
 *      configured-but-unprobed one reports `configured` (this page does not
 *      claim a liveness it did not measure).
 *   2. Diagnostics carry NO credential material. Config endpoints are
 *      reduced to their HOST (a credential pasted into a base URL never
 *      reaches the client), and every probe error is bounded text from the
 *      client library — no headers, no request dumps.
 */

interface ChannelStatus {
  status: "connected" | "degraded" | "disconnected" | "unconfigured" | "configured"
  detail: string
  responseTimeMs: number | null
  error: string | null
}

interface StatusResponse {
  checkedAt: string
  mode: "full" | "degraded"
  hasKnowledgeBaseContent: boolean
  channels: {
    elasticsearch: ChannelStatus
    neo4j: ChannelStatus
    chat: ChannelStatus
    embedding: ChannelStatus
    rerank: ChannelStatus
    parsers: ChannelStatus
    mcp: ChannelStatus
    webSearch: ChannelStatus
    langfuse: ChannelStatus
  }
  config: {
    esNodeHost: string
    neo4jUriHost: string
    chatBaseUrlHost: string
    chatModel: string
  }
}

// 知识库 chunk 索引名 — 与 ingestion/storage/store.ts、retrieval/search/searcher.ts 保持一致
async function probeKnowledgeBaseContent(client: Client, index: string): Promise<boolean> {
  try {
    const result = await client.count({ index })
    return (result.count ?? 0) > 0
  } catch {
    // 索引不存在、ES 不可达、权限不足等都视为"无内容"
    return false
  }
}

export interface StatusRouterDeps {
  config: AppConfig
  elasticsearch: Client
  neo4jDriver: Driver
  chatClient: OpenAI
  embeddingClient: OpenAI
}

async function time<T>(fn: () => Promise<T>, timeoutMs = 3500): Promise<{ value: T | null; ms: number; error: string | null }> {
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    return { value, ms: Date.now() - start, error: null }
  } catch (err) {
    return { value: null, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Host-only view of a configured URL — never the raw value. */
function hostOf(url: string): string {
  try {
    return new URL(url || "https://api.openai.com/v1").host
  } catch {
    return "(配置的地址不是合法 URL)"
  }
}

/**
 * Bound a probe error AND redact every configured secret from it. Provider
 * gateways echo request material back in error bodies — a key pasted into a
 * URL or an echo in a provider message must never reach the client.
 */
function sanitizeDiagnostic(message: string, config: AppConfig): string {
  let text = message.slice(0, 200)
  const secrets = [
    config.openaiApiKey,
    config.embeddingApiKey,
    config.rerankApiKey,
    config.tavilyApiKey,
    config.langfusePublicKey,
    config.langfuseSecretKey,
    config.openaiBaseUrl,
    config.esNode,
    config.neo4jUri,
  ].filter((value): value is string => typeof value === "string" && value.trim().length >= 8)
  for (const secret of secrets) {
    text = text.split(secret).join("***")
  }
  return text
}

async function pingElasticsearch(client: Client): Promise<ChannelStatus> {
  const result = await time(async () => {
    const ok = await client.ping()
    if (!ok) throw new Error("ping returned false")
  })
  return result.error
    ? { status: "disconnected", detail: "Elasticsearch 不可达", responseTimeMs: result.ms, error: result.error }
    : { status: "connected", detail: "Elasticsearch 可用", responseTimeMs: result.ms, error: null }
}

async function pingNeo4j(driver: Driver): Promise<ChannelStatus> {
  const result = await time(async () => {
    // Some drivers lazily negotiate on first call; this can take several
    // seconds. The 3.5s ceiling in `time` keeps the status response snappy.
    await driver.executeQuery("RETURN 1 AS n", {}, { database: undefined })
  })
  return result.error
    ? { status: "disconnected", detail: "Neo4j 不可达", responseTimeMs: result.ms, error: result.error }
    : { status: "connected", detail: "Neo4j 可用", responseTimeMs: result.ms, error: null }
}

async function pingModel(client: OpenAI, label: string, degradedDetail: string): Promise<ChannelStatus> {
  const result = await time(async () => {
    // OpenAI SDK: list models is the lightest connectivity check. Some
    // OpenAI-compatible providers (e.g. DeepSeek) may not expose /v1/models;
    // we treat the call as a connectivity probe and surface the error to the
    // caller so the UI can show "degraded".
    await client.models.list()
  })
  return result.error
    ? { status: "degraded", detail: degradedDetail, responseTimeMs: result.ms, error: result.error }
    : { status: "connected", detail: `${label} 可用`, responseTimeMs: result.ms, error: null }
}

/**
 * Parser availability WITHOUT executing the parser: a bounded PATH lookup
 * (`where`/`which`) per configured command. The child is KILLED when the
 * bound expires — a slow PATH must not leak a process per status poll.
 */
async function probeParsers(commands: string[]): Promise<ChannelStatus> {
  if (commands.length === 0) {
    return {
      status: "unconfigured",
      detail: "未配置任何文档解析器命令",
      responseTimeMs: null,
      error: null,
    }
  }
  const results = await Promise.all(
    commands.map(async (command) => {
      const lookup = await time(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.platform === "win32" ? "where" : "which",
              [command],
              { stdio: "ignore" }
            )
            const timer = setTimeout(() => {
              child.kill()
              reject(new Error("lookup timeout"))
            }, 2000)
            child.on("error", (error) => {
              clearTimeout(timer)
              reject(error)
            })
            child.on("close", (code) => {
              clearTimeout(timer)
              if (code === 0) resolve()
              else reject(new Error("not on PATH"))
            })
          }),
        2000
      )
      return { command, available: lookup.error === null }
    })
  )
  const available = results.filter((result) => result.available).map((result) => result.command)
  const missing = results.filter((result) => !result.available).map((result) => result.command)
  if (available.length === 0) {
    return {
      status: "disconnected",
      detail: `文档解析器均不可用（${missing.join("、")} 不在 PATH）`,
      responseTimeMs: null,
      error: null,
    }
  }
  return {
    status: "connected",
    detail: `可用：${available.join("、")}${missing.length > 0 ? `；缺失：${missing.join("、")}` : ""}`,
    responseTimeMs: null,
    error: null,
  }
}

export function createStatusRouter(deps: StatusRouterDeps): Router {
  const router = Router()

  router.get("/status", async (_req: Request, res: Response) => {
    const [es, neo4j, chat, embedding, parsers] = await Promise.all([
      pingElasticsearch(deps.elasticsearch),
      pingNeo4j(deps.neo4jDriver),
      pingModel(deps.chatClient, "Chat", "Chat 模型列表不可用（仍可正常回答）"),
      pingModel(deps.embeddingClient, "Embedding", "Embedding 模型列表不可用（导入将失败）"),
      probeParsers(
        [
          deps.config.markitdownCommand,
          deps.config.markerCommand,
          deps.config.mineruCommand,
          deps.config.pythonCommand,
        ].filter((command): command is string => typeof command === "string" && command.length > 0)
      ),
    ])

    // 仅当 ES 可达时探测 chunk 数量；ES 不可达时直接视为无内容
    const hasContent = es.status === "connected"
      ? await probeKnowledgeBaseContent(deps.elasticsearch, resolveChunkIndexName(undefined, deps.config))
      : false

    // 可选能力：未配置就是 unconfigured（不是失败，也不是成功）；已配置但
    // 本页不做实时探测的能力如实报告 configured。
    const rerank: ChannelStatus = deps.config.rerankApiKey.trim()
      ? { status: "configured", detail: "已配置 Rerank 凭据（本页不做实时探测）", responseTimeMs: null, error: null }
      : { status: "unconfigured", detail: "未配置 RERANK_API_KEY——检索融合不使用专用重排", responseTimeMs: null, error: null }
    const mcp: ChannelStatus = deps.config.mcpCapabilitiesEnabled
      ? { status: "configured", detail: "本地 MCP 能力服务器已启用（MCP_CAPABILITIES≠0）", responseTimeMs: null, error: null }
      : { status: "unconfigured", detail: "MCP 能力发现已停用（MCP_CAPABILITIES=0）", responseTimeMs: null, error: null }
    const webSearch: ChannelStatus = deps.config.tavilyApiKey
      ? { status: "configured", detail: "已配置 Tavily 网络搜索", responseTimeMs: null, error: null }
      : { status: "unconfigured", detail: "未配置 TAVILY_API_KEY——不使用网络证据", responseTimeMs: null, error: null }
    const langfuse: ChannelStatus =
      deps.config.langfusePublicKey && deps.config.langfuseSecretKey
        ? { status: "configured", detail: "已配置 Langfuse 追踪导出", responseTimeMs: null, error: null }
        : { status: "unconfigured", detail: "未配置 LANGFUSE_* —— 不导出追踪", responseTimeMs: null, error: null }

    // mode 只看两个核心基础设施通道（chat 探测即使 degraded，回答仍然工作，
    // 不据此拉低整个演示的状态）——Neo4j 挂掉必须显示降级。
    const mode: "full" | "degraded" =
      es.status === "connected" && neo4j.status === "connected" ? "full" : "degraded"

    // Ticket 44 review: probe error strings come from third-party clients and
    // can echo credential material back — bound them AND redact every
    // configured secret before the payload leaves the server.
    const channels = { elasticsearch: es, neo4j, chat, embedding, rerank, parsers, mcp, webSearch, langfuse }
    for (const channel of Object.values(channels)) {
      if (channel.error) channel.error = sanitizeDiagnostic(channel.error, deps.config)
    }

    const body: StatusResponse = {
      checkedAt: new Date().toISOString(),
      mode,
      hasKnowledgeBaseContent: hasContent,
      channels,
      config: {
        // HOST-ONLY diagnostics (ticket 44): a credential pasted into a base
        // URL never leaves the server.
        esNodeHost: hostOf(deps.config.esNode),
        neo4jUriHost: hostOf(deps.config.neo4jUri),
        chatBaseUrlHost: hostOf(deps.config.openaiBaseUrl),
        chatModel: deps.config.openaiChatModel,
      },
    }
    res.json(body)
  })

  return router
}
