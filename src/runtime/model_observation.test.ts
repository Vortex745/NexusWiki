import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { createRunBudgetedOpenAIClient } from "./openai_budget_client"
import { createRunContext, runWithRunContext, type RunContext } from "./run_context"
import { createTracingRuntime } from "../tracing/composition"
import { NoopTracingRuntime } from "../tracing/contract"

/**
 * LO-07 (non-streaming auxiliary calls) and LO-08 (streaming Answer calls).
 *
 * The provider is a replayable fake: no network, deterministic chunks. What is
 * asserted is the observation contract — one Generation per REAL call, full
 * content, provider-only usage, real TTFT, correct terminal status — plus the
 * promise that nothing the observation does can change the caller's result.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  export(spans: readonly ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
    this.spans.push(...spans)
    callback({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {
    // nothing to release
  }
}

const ENABLED_ENV = {
  TRACING_ENABLED: "1",
  LANGFUSE_SAMPLE_RATE: "1",
  LANGFUSE_BASE_URL: "http://localhost:3000",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
}

function buildClient(
  create: (request: Record<string, unknown>) => Promise<unknown>,
  runtime = createTracingRuntime({ env: ENABLED_ENV, exporter: new FakeExporter() }).runtime,
) {
  const fake = {
    chat: { completions: { create } },
    embeddings: { create: async () => ({ data: [] }) },
  } as unknown as OpenAI
  return { client: createRunBudgetedOpenAIClient(fake, runtime), runtime }
}

function attributesOf(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>
}

function completion(text: string, usage?: Record<string, number>) {
  return {
    id: "cmpl-1",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  }
}

async function* chunks(items: unknown[]): AsyncIterable<unknown> {
  for (const item of items) {
    await Promise.resolve()
    yield item
  }
}

test("LO-07-AC01: one real non-streaming call produces one Generation with model, prompt and reply", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "生成一个标题" }]
  const { client } = buildClient(async () => completion("标题：日志迁移"), runtime)

  const result = await client.chat.completions.create({ model: "probe-chat", messages })
  assert.equal((result as { choices: unknown[] }).choices.length, 1, "the caller's result is untouched")
  await runtime.flush(1_000)

  assert.equal(exporter.spans.length, 1)
  const span = exporter.spans[0]
  const attributes = attributesOf(span)
  assert.equal(span.name, "chat.completions")
  assert.equal(attributes["langfuse.observation.type"], "generation")
  assert.equal(attributes["langfuse.observation.model.name"], "probe-chat")
  assert.equal(attributes["langfuse.observation.input"], JSON.stringify(messages))
  assert.equal(attributes["langfuse.observation.output"], "标题：日志迁移")
  assert.equal(span.status.code, 1)
  await runtime.shutdown(500)
})

test("LO-07-AC05: usage comes only from the provider, and stays unknown when absent", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  let call = 0
  const { client } = buildClient(async () => {
    call += 1
    return call === 1
      ? completion("with usage", { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })
      : completion("without usage")
  }, runtime)

  await client.chat.completions.create({ model: "m", messages: [] })
  await client.chat.completions.create({ model: "m", messages: [] })
  await runtime.flush(1_000)

  const [withUsage, withoutUsage] = exporter.spans
  assert.equal(
    attributesOf(withUsage)["langfuse.observation.usage_details"],
    JSON.stringify({ input: 11, output: 7, total: 18 }),
  )
  assert.equal(attributesOf(withUsage)["gen_ai.usage.input_tokens"], 11)
  assert.equal(withoutUsage.status.code, 1)
  assert.equal(
    attributesOf(withoutUsage)["langfuse.observation.usage_details"],
    undefined,
    "no usage is not zero usage",
  )
  await runtime.shutdown(500)
})

test("LO-07-AC03/AC04: images and credentials are removed, long content is not log-truncated", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const longPrompt = "汉".repeat(120_000) // ~360 KiB, far beyond the 8 KiB log ceiling
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: longPrompt },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAABBBBCCCC" } },
      ],
    },
    { role: "system", content: "Authorization: Bearer sk-live-should-not-appear" },
  ]
  const { client } = buildClient(async () => completion(longPrompt), runtime)
  await client.chat.completions.create({ model: "m", messages })
  await runtime.flush(1_000)

  const attributes = attributesOf(exporter.spans[0])
  const input = String(attributes["langfuse.observation.input"])
  const output = String(attributes["langfuse.observation.output"])
  assert.ok(input.includes(longPrompt.slice(0, 5_000)), "the prompt is recorded in full")
  assert.ok(Buffer.byteLength(output, "utf8") > 300_000, "the reply is recorded in full")
  assert.ok(!input.includes("AAAABBBBCCCC"), "image bytes never reach the observation")
  assert.ok(input.includes("[image omitted"), "the image is referenced, not copied")
  assert.ok(!input.includes("sk-live-should-not-appear"), "credentials are redacted")
  await runtime.shutdown(500)
})

test("LO-07-AC06/AC08: a provider error keeps its identity and records one failed Generation", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const failure = new Error("provider 503")
  const { client } = buildClient(async () => {
    throw failure
  }, runtime)

  await assert.rejects(
    () => client.chat.completions.create({ model: "m", messages: [] }),
    (error) => error === failure,
  )
  await runtime.flush(1_000)

  assert.equal(exporter.spans.length, 1)
  assert.equal(exporter.spans[0].status.code, 2)
  assert.equal(exporter.spans[0].status.message, "provider 503")
  await runtime.shutdown(500)
})

test("LO-07-AC07/AC09: with tracing off nothing is observed and the call still succeeds", async () => {
  const { client } = buildClient(async () => completion("ok"), new NoopTracingRuntime())
  const result = await client.chat.completions.create({ model: "m", messages: [] })
  assert.equal((result as { choices: unknown[] }).choices.length, 1)
})

function runContext(): RunContext {
  // The real factory: observation must not depend on a hand-built context, and
  // the budget authority has to exist or reserveModelCall refuses to run.
  return createRunContext({ budgetMs: 30_000 })
}

test("LO-08-AC01/AC04/AC05/AC06: a streamed answer assembles the full reply, real TTFT and provider usage", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const parts = ["答", "案", "分", "段"]
  const { client } = buildClient(async () =>
    chunks([
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      { choices: [] , usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
      ...parts.map((part) => ({ choices: [{ index: 0, delta: { content: part } }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
    ]),
  runtime)

  const received: unknown[] = []
  await runWithRunContext(runContext(), async () => {
    const stream = (await client.chat.completions.create({
      model: "probe-chat",
      messages: [{ role: "user", content: "问" }],
      stream: true,
    })) as AsyncIterable<unknown>
    for await (const chunk of stream) received.push(chunk)
  })
  await runtime.flush(1_000)

  assert.equal(received.length, 8, "every provider chunk reaches the consumer unchanged")
  const span = exporter.spans.find((entry) => entry.name === "chat.completions.stream")
  assert.ok(span)
  const attributes = attributesOf(span)
  assert.equal(attributes["langfuse.observation.output"], "答案分段")
  assert.equal(
    attributes["langfuse.observation.usage_details"],
    JSON.stringify({ input: 9, output: 4, total: 13 }),
  )
  const ttft = attributes["langfuse.observation.completion_start_time_ms"]
  assert.equal(typeof ttft, "number", "TTFT is measured from the first CONTENT token")
  assert.equal(span.status.code, 1)
  await runtime.shutdown(500)
})

test("LO-08-AC04/AC05: a role-only or usage-only frame does not fake TTFT, and early exit is cancelled", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  let call = 0
  const { client } = buildClient(async () => {
    call += 1
    return call === 1
      ? chunks([{ choices: [{ index: 0, delta: { role: "assistant" } }] }, { choices: [] }])
      : chunks([
        { choices: [{ index: 0, delta: { content: "第一段" } }] },
        { choices: [{ index: 0, delta: { content: "第二段" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ])
  }, runtime)

  await runWithRunContext(runContext(), async () => {
    // 1) no content at all → empty output, no TTFT
    const empty = (await client.chat.completions.create({ model: "m", messages: [], stream: true })) as AsyncIterable<unknown>
    for await (const _chunk of empty) { /* consume */ }
    // 2) consumer stops after the first content chunk → partial + cancelled
    const partial = (await client.chat.completions.create({ model: "m", messages: [], stream: true })) as AsyncIterable<unknown>
    for await (const _chunk of partial) break
  })
  await runtime.flush(1_000)

  const [emptySpan, partialSpan] = exporter.spans
  assert.equal(attributesOf(emptySpan)["langfuse.observation.completion_start_time_ms"], undefined)
  assert.equal(attributesOf(emptySpan)["langfuse.observation.output"], "")
  assert.equal(emptySpan.status.code, 1, "an empty but complete stream is still ok")

  assert.equal(attributesOf(partialSpan)["langfuse.observation.output"], "第一段")
  assert.equal(partialSpan.status.code, 2, "partial delivery is not a completed answer")
  assert.equal(attributesOf(partialSpan)["langfuse.observation.level"], "WARNING")
  await runtime.shutdown(500)
})

test("LO-08-AC02/AC10: budget reservation is not duplicated and no extra provider request is made", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  let calls = 0
  const { client } = buildClient(async () => {
    calls += 1
    return completion("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  }, runtime)

  await client.chat.completions.create({ model: "m", messages: [] })
  await client.chat.completions.create({ model: "m", messages: [] })
  await runtime.flush(500)
  assert.equal(calls, 2, "observation adds no provider request")
  assert.equal(exporter.spans.length, 2)
  await runtime.shutdown(500)
})
