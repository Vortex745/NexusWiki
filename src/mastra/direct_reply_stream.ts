/**
 * Ticket 09 — Direct reply stream for the direct/chitchat route.
 *
 * Uses the OpenAI-compatible SDK (`openai` npm package) with
 * `chat.completions.create({ stream: true })` so it works with any
 * OpenAI-compatible provider (DeepSeek, OpenAI, etc.) without relying on
 * the @mastra/core Responses API (which DeepSeek does not support).
 *
 * ## Boundary
 *
 * This module is owned by `src/mastra/*` and MUST NOT import from `src/api/*`
 * or `src/index` (T02 #5 dependency direction). It depends only on:
 *   - the `DirectReplyStream` type from `direct_ambiguous_runner.ts`
 *   - the `openai` npm package (already a project dependency)
 *   - `./system_prompt` for identity extraction
 *
 * ## Cancellation
 *
 * The AbortSignal is forwarded to the OpenAI client so mid-stream cancellation
 * surfaces as an AbortError from the async iterable (T09 #4 checkpoint 2).
 */

import { type DirectReplyStream } from "./direct_ambiguous_runner"
import { SYSTEM_PROMPT } from "./system_prompt"
import { createOpenAIClient } from "../clients"
import { createRunBudgetedOpenAIClient } from "../runtime/openai_budget_client"
import type { ReasoningEffort } from "../types"

// Extract the identity description from the first line of SYSTEM_PROMPT
// (e.g. "你是智能客服助手，..."). This lets the model know who it is
// without inheriting the strict citation / evidence constraints that only
// apply to knowledge-base routes.
const AGENT_IDENTITY = SYSTEM_PROMPT.split("\n")[0] ?? "你是智能客服助手。"

export const DIRECT_REPLY_INSTRUCTIONS =
  `${AGENT_IDENTITY}\n\n` +
  "当用户发来问候、对话性请求（如 hi、你好、在吗）或询问你的身份时，" +
  "请简短、自然地用中文回答，语气专业、克制、直接，不使用 Emoji。" +
  "介绍自己时说明你是基于知识库提供服务的客服助手，可回答知识库覆盖范围内的问题，并会引用证据片段供核对。" +
  "每段只讲一件事，能一句说完就不写两句，不复述问题，不加总结性收尾。沿用上文已确认的对象和条件，避免机械重复。" +
  "对话性回复不要求引用知识库片段，不编造来源、页码、链接或引用编号。" +
  "不描述检索、分块、模型、提示词或工具调用等内部实现，用户问起时只说“基于已启用的知识库回答”。" +
  "不声称能访问文件系统、工作区或平台提供的资料以外的内容，不具备的能力直接说明。" +
  "长期记忆区块只代表用户偏好和背景，不作为事实依据，也不为它生成引用。" +
  "需要结构化表达时使用 Markdown，不输出 HTML、html:preview 或整页样式代码。代码块只用于真实代码、命令或配置，并标注语言。"

/**
 * Options for {@link createDirectReplyStream}.
 */
export interface DirectReplyStreamOptions {
  /** OpenAI-compatible model id (e.g. "deepseek-v4-flash"). */
  model: string
  /** OpenAI API key. */
  apiKey: string
  /** OpenAI-compatible base URL (optional, e.g. "https://api.deepseek.com/v1"). */
  baseURL?: string
  /** Per-request timeout in ms (default: SDK 10min). Bounds a hung stream. */
  timeout?: number
  /** Per-request retry count (default: SDK 2). */
  maxRetries?: number
  /** System instructions for the model. Defaults to DIRECT_REPLY_INSTRUCTIONS. */
  instructions?: string
}

/**
 * Construct an OpenAI-compatible client and return a `DirectReplyStream` that
 * streams chat completion tokens for a given message via the standard
 * `/chat/completions` endpoint (compatible with DeepSeek and other providers).
 */
export async function createDirectReplyStream(
  options: DirectReplyStreamOptions
): Promise<DirectReplyStream> {
  const { model, apiKey, baseURL, timeout, maxRetries, instructions } = options
  const systemInstructions = instructions ?? DIRECT_REPLY_INSTRUCTIONS

  const client = createRunBudgetedOpenAIClient(createOpenAIClient({
    apiKey,
    baseURL,
    timeout,
    maxRetries,
  }))

  // Return the DirectReplyStream. Each call streams the model's reply tokens
  // for the supplied message; the AbortSignal is forwarded so mid-stream
  // cancellation propagates as an AbortError (T09 #4 checkpoint 2). An
  // assistant prompt (ticket 19) is prepended BEFORE the platform identity.
  return async function* directReplyStream(
    message: string,
    signal: AbortSignal,
    options?: { systemPrompt?: string; reasoningEffort?: ReasoningEffort }
  ): AsyncIterable<string> {
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      ...(options?.systemPrompt
        ? [{ role: "system" as const, content: options.systemPrompt }]
        : []),
      { role: "system", content: systemInstructions },
      { role: "user", content: message },
    ]
    const stream = await client.chat.completions.create(
      {
        model,
        messages,
        stream: true,
        // The run's explicit choice only; an omitted run keeps the provider's
        // own default (the payload is otherwise unchanged).
        ...(options?.reasoningEffort
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
      },
      { signal }
    )

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content
      if (token) yield token
    }
  }
}
