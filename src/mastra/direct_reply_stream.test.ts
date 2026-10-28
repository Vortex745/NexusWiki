import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { DIRECT_REPLY_INSTRUCTIONS, createDirectReplyStream } from "./direct_reply_stream"

/**
 * P1 regression: the direct Agent default prompt is a Chinese
 * customer-service prompt that identifies the knowledge-base-backed
 * assistant. Key phrases only — wording may change.
 */
test("P1 regression: direct Agent defaults to the Chinese customer-service prompt", () => {
  assert.ok(
    typeof DIRECT_REPLY_INSTRUCTIONS === "string" && DIRECT_REPLY_INSTRUCTIONS.length > 0,
    "DIRECT_REPLY_INSTRUCTIONS must be a non-empty string"
  )
  assert.ok(
    DIRECT_REPLY_INSTRUCTIONS.includes("客服助手"),
    "DIRECT_REPLY_INSTRUCTIONS must identify the agent as a customer-service assistant"
  )
  assert.ok(
    DIRECT_REPLY_INSTRUCTIONS.includes("知识库"),
    "DIRECT_REPLY_INSTRUCTIONS must reference the knowledge base"
  )
  assert.ok(
    DIRECT_REPLY_INSTRUCTIONS.includes("引用证据"),
    "DIRECT_REPLY_INSTRUCTIONS must mention evidence citation"
  )
})

interface ProviderHandle {
  baseURL: string
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}

function chunkFrame(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "direct-test",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`
}

async function startProvider(
  handler: (body: Record<string, unknown>, res: http.ServerResponse) => void
): Promise<ProviderHandle> {
  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (part) => (raw += part))
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      requests.push(body)
      handler(body, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function tokensOf(stream: AsyncIterable<string>): Promise<string[]> {
  const tokens: string[] = []
  for await (const token of stream) tokens.push(token)
  return tokens
}

function completingProvider() {
  return startProvider((_body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(`${chunkFrame({ content: "好的" })}data: [DONE]\n\n`)
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

test("the direct stream carries the level, keeps the assistant prompt, and omits when unasked", async () => {
  const provider = await completingProvider()
  try {
    const stream = await createDirectReplyStream({
      model: "direct-test",
      apiKey: "test-key",
      baseURL: provider.baseURL,
      timeout: 5_000,
      maxRetries: 0,
    })
    for (const level of ["low", "high", "max"] as const) {
      const tokens = await tokensOf(
        stream("你好", new AbortController().signal, {
          systemPrompt: "专家提示",
          reasoningEffort: level,
        })
      )
      assert.deepEqual(tokens, ["好的"])
    }
    const omitted = await tokensOf(stream("你好", new AbortController().signal, { systemPrompt: "专家提示" }))
    assert.deepEqual(omitted, ["好的"])

    assert.deepEqual(
      provider.requests.map((body) => body["reasoning_effort"]),
      ["low", "high", "max", undefined]
    )
    assert.equal("reasoning_effort" in provider.requests[3], false)

    const messages = provider.requests[0]["messages"] as Array<{ role: string; content: string }>
    assert.deepEqual(messages, [
      { role: "system", content: "专家提示" },
      { role: "system", content: DIRECT_REPLY_INSTRUCTIONS },
      { role: "user", content: "你好" },
    ])
  } finally {
    await provider.close()
  }
})

test("the direct stream falls back to the exported default instructions", async () => {
  const provider = await completingProvider()
  try {
    const stream = await createDirectReplyStream({
      model: "direct-test",
      apiKey: "test-key",
      baseURL: provider.baseURL,
      maxRetries: 0,
    })
    await tokensOf(stream("你好", new AbortController().signal))
    const messages = provider.requests[0]["messages"] as Array<{ role: string; content: string }>
    assert.deepEqual(messages[0], { role: "system", content: DIRECT_REPLY_INSTRUCTIONS })
  } finally {
    await provider.close()
  }
})

test("the direct stream still honors the run's abort signal", { timeout: 10_000 }, async () => {
  let responseClosed = false
  const provider = await startProvider((_body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(chunkFrame({ reasoning_content: "思考中" }))
    // Never ends: only the signal can settle this read.
    res.on("close", () => {
      responseClosed = true
    })
  })
  try {
    const stream = await createDirectReplyStream({
      model: "direct-test",
      apiKey: "test-key",
      baseURL: provider.baseURL,
      maxRetries: 0,
    })
    const controller = new AbortController()
    const tokens: string[] = []
    const consuming = (async () => {
      for await (const token of stream("你好", controller.signal, { reasoningEffort: "high" })) {
        tokens.push(token)
      }
    })()
    setTimeout(() => controller.abort(), 25)
    const settled = await Promise.race([
      consuming.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
    ])
    assert.equal(settled, "settled", "the abort must settle the pending stream read")
    assert.deepEqual(tokens, [])
    assert.equal(controller.signal.aborted, true)
    assert.equal(await waitFor(() => responseClosed), true, "the provider connection was released by the abort")
  } finally {
    await provider.close()
  }
})
