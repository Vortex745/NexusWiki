import type OpenAI from "openai"
import type { ModelCallScope, ModelUsage, TracingRuntime } from "../tracing/contract"
import {
  getCurrentRunContext,
  recordModelUsage,
  reserveModelCall,
  runBudgetRequiresUsage,
  type ModelUsage as BudgetModelUsage,
} from "./run_context"

type UnknownRecord = Record<string, unknown>
type CreateMethod = (...args: unknown[]) => Promise<unknown>



/**
 * Instrument the two OpenAI SDK model-call surfaces used by this process.
 *
 * Two concerns share this seam on purpose:
 *   - budget/usage reservation (pre-existing behaviour, untouched);
 *   - model observation (LO-07/LO-08): every REAL provider call becomes one
 *     Generation with the full prompt, the complete reply, provider-reported
 *     usage and (for streams) a real TTFT.
 *
 * Observation never changes the result, never adds a provider request, never
 * retries, and never replaces a business error. Outside an Answer Run the
 * budget part is a pass-through, but observation still applies — an auxiliary
 * call with no run context is decided by the runtime's own root policy
 * (LG-07-AC12).
 */
export function createRunBudgetedOpenAIClient(client: OpenAI, tracing?: TracingRuntime): OpenAI {
  const chat = client.chat?.completions
    ? proxyResource(client.chat, "completions", (create) =>
      async function budgetedChatCreate(...args: unknown[]): Promise<unknown> {
        const ctx = getCurrentRunContext()
        const request = asRecord(args[0])
        const model = stringField(request, "model")
        const streaming = request.stream === true

        if (!ctx) {
          const observation = startObservation(tracing, streaming, model, request)
          try {
            const result = await create(...args)
            // No budget reservation outside a run, but the provider's usage is
            // still the only source for the observation (LG-07-AC08).
            return observeResult(result, observation, extractUsage(result))
          } catch (error) {
            observation?.end({ status: "error", message: messageOf(error) })
            throw error
          }
        }

        // Reserve BEFORE observing: a budget refusal means no provider call
        // happened, so it must not leave a Generation behind (LG-08-AC04).
        const reservation = reserveModelCall(ctx, { kind: "chat", model })
        const observation = startObservation(tracing, streaming, model, request)
        const forwardedArgs = [...args]
        if (streaming && runBudgetRequiresUsage(ctx)) {
          forwardedArgs[0] = {
            ...request,
            stream_options: {
              ...asRecord(request.stream_options),
              include_usage: true,
            },
          }
        }

        let result: unknown
        try {
          result = await create(...forwardedArgs)
        } catch (error) {
          observation?.end({ status: "error", message: messageOf(error) })
          throw error
        }

        if (isAsyncIterable(result)) {
          return settleStream(result, ctx, reservation, observation)
        }
        const usage = extractUsage(result)
        recordModelUsage(ctx, reservation, usage)
        return observeResult(result, observation, usage)
      }
    )
    : client.chat

  const embeddingResource = (client as unknown as {
    embeddings?: { create?: unknown }
  }).embeddings
  const embeddings = embeddingResource && typeof embeddingResource.create === "function"
    ? new Proxy(client.embeddings, {
      get(target, property, receiver) {
        if (property !== "create") return Reflect.get(target, property, receiver)
        const create = target.create.bind(target) as CreateMethod
        return async (...args: unknown[]): Promise<unknown> => {
          const ctx = getCurrentRunContext()
          if (!ctx) return create(...args)
          const request = asRecord(args[0])
          const reservation = reserveModelCall(ctx, {
            kind: "embedding",
            model: stringField(request, "model"),
          })
          const result = await create(...args)
          recordModelUsage(ctx, reservation, extractUsage(result))
          return result
        }
      },
    })
    : client.embeddings

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "chat") return chat
      if (property === "embeddings") return embeddings
      return Reflect.get(target, property, receiver)
    },
  })
}

function startObservation(
  tracing: TracingRuntime | undefined,
  streaming: boolean,
  model: string,
  request: UnknownRecord,
): ModelCallScope | undefined {
  if (!tracing) return undefined
  try {
    return tracing.observeModel({
      name: streaming ? "chat.completions.stream" : "chat.completions",
      model,
      provider: "openai",
      input: request["messages"] ?? request["prompt"] ?? null,
      stream: streaming,
    })
  } catch {
    // Observation must never break a model call.
    return undefined
  }
}

function observeResult(
  result: unknown,
  observation: ModelCallScope | undefined,
  usage: ModelUsage | undefined,
): unknown {
  if (!observation) return result
  try {
    const output = messageOutput(result)
    observation.end({
      output,
      ...(usage ? { usage } : {}),
      status: "ok",
    })
  } catch {
    // ignore observation failures
  }
  return result
}

const MAX_TEXT_CHARS_PER_CHUNK = 20_000

interface StreamAccumulator {
  text: string
  reasoning: string
  toolCalls: unknown[]
  usage: BudgetModelUsage | undefined
  ttftMs: number | undefined
  finished: boolean
}

async function* settleStream(
  stream: AsyncIterable<unknown>,
  ctx: NonNullable<ReturnType<typeof getCurrentRunContext>>,
  reservation: ReturnType<typeof reserveModelCall>,
  observation: ModelCallScope | undefined,
): AsyncIterable<unknown> {
  const accumulator: StreamAccumulator = {
    text: "",
    reasoning: "",
    toolCalls: [],
    usage: undefined,
    ttftMs: undefined,
    finished: false,
  }
  const startedAt = process.hrtime.bigint()
  let completed = false
  let failure: unknown
  let ttftReported = false
  try {
    for await (const chunk of stream) {
      absorbChunk(chunk, accumulator, startedAt)
      if (!ttftReported && accumulator.ttftMs !== undefined) {
        ttftReported = true
        try {
          observation?.setAttributes({
            "langfuse.observation.completion_start_time_ms": Math.round(accumulator.ttftMs * 1000) / 1000,
          })
        } catch {
          // ignore observation failures
        }
      }
      yield chunk
    }
    completed = true
  } catch (error) {
    failure = error
    throw error
  } finally {
    const aborted = ctx.signal.aborted
    if (completed || (runBudgetRequiresUsage(ctx) && !aborted)) {
      recordModelUsage(ctx, reservation, accumulator.usage)
    }
    if (observation) {
      try {
        // Only a run that reached the end is `ok`. A consumer that stopped
        // early (break/abort) leaves a partial reply — recorded as cancelled
        // with whatever actually arrived, never as a completed answer.
        const status = failure ? "error" : completed ? "ok" : "cancelled"
        observation.end({
          output: accumulator.text,
          ...(accumulator.reasoning ? { reasoning: accumulator.reasoning } : {}),
          ...(accumulator.toolCalls.length > 0 ? { toolCalls: accumulator.toolCalls } : {}),
          ...(accumulator.usage ? { usage: accumulator.usage } : {}),
          status,
          ...(status === "cancelled" ? { message: "stream stopped before the terminal chunk" } : {}),
          ...(status === "error" ? { message: messageOf(failure) } : {}),
        })
      } catch {
        // ignore observation failures
      }
    }
  }
}

function absorbChunk(chunk: unknown, accumulator: StreamAccumulator, startedAt: bigint): void {
  const usage = extractUsage(chunk)
  if (usage) accumulator.usage = usage

  const choices = asRecord(chunk)["choices"]
  if (!Array.isArray(choices) || choices.length === 0) return
  const delta = asRecord(asRecord(choices[0])["delta"])

  const text = textOf(delta["content"])
  if (text.length > 0) {
    accumulator.text += text
    markFirstToken(accumulator, startedAt)
  }
  const reasoning = textOf(delta["reasoning_content"] ?? delta["reasoning"])
  if (reasoning.length > 0) {
    accumulator.reasoning += reasoning
    markFirstToken(accumulator, startedAt)
  }
  const toolCalls = delta["tool_calls"]
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    accumulator.toolCalls.push(...toolCalls)
    markFirstToken(accumulator, startedAt)
  }
  const finishReason = asRecord(choices[0])["finish_reason"]
  if (typeof finishReason === "string" && finishReason.length > 0) accumulator.finished = true
}

/**
 * TTFT is the first OUTPUT token, not the first frame: a role-only delta, an
 * empty choices array and a usage-only tail frame must not count (LG-07-AC09).
 */
function markFirstToken(accumulator: StreamAccumulator, startedAt: bigint): void {
  if (accumulator.ttftMs !== undefined) return
  accumulator.ttftMs = Number(process.hrtime.bigint() - startedAt) / 1e6
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part)
        return typeof record["text"] === "string" ? record["text"] as string : ""
      })
      .join("")
  }
  return ""
}

function messageOutput(result: unknown): unknown {
  const choices = asRecord(result)["choices"]
  if (!Array.isArray(choices) || choices.length === 0) return ""
  const message = asRecord(asRecord(choices[0])["message"])
  const content = message["content"]
  const text = textOf(content)
  const toolCalls = message["tool_calls"]
  const reasoning = textOf(message["reasoning_content"] ?? message["reasoning"])
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return { content: text, tool_calls: toolCalls, ...(reasoning ? { reasoning } : {}) }
  }
  return text.length > 0 ? text : content ?? ""
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "model call failed"
}

function proxyResource<T extends object>(
  resource: T,
  childKey: keyof T,
  wrapCreate: (create: CreateMethod) => CreateMethod
): T {
  const child = resource[childKey] as object & { create: CreateMethod }
  const proxiedChild = new Proxy(child, {
    get(target, property, receiver) {
      if (property === "create") {
        return wrapCreate(target.create.bind(target))
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return new Proxy(resource, {
    get(target, property, receiver) {
      if (property === childKey) return proxiedChild
      return Reflect.get(target, property, receiver)
    },
  })
}

function extractUsage(value: unknown): BudgetModelUsage | undefined {
  const usage = asRecord(asRecord(value).usage)
  const promptTokens = numberField(usage, "prompt_tokens")
  const totalTokens = numberField(usage, "total_tokens")
  if (promptTokens === undefined || totalTokens === undefined) return undefined
  return {
    promptTokens,
    completionTokens: numberField(usage, "completion_tokens") ?? 0,
    totalTokens,
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? value as UnknownRecord
    : {}
}

function stringField(record: UnknownRecord, field: string): string {
  return typeof record[field] === "string" ? record[field] as string : "unknown"
}

function numberField(record: UnknownRecord, field: string): number | undefined {
  return typeof record[field] === "number" ? record[field] as number : undefined
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value
}
