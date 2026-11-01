/**
 * Long-term memory (2026-10-30) — turn a finished session into an updated
 * account profile.
 *
 * The frontend calls this when the owner starts a new conversation. The
 * previous session's transcript (owner-checked by the history store) and the
 * profile's current text go to the account's own chat model in ONE bounded
 * call. The model returns the three updated sections as strict JSON; code
 * validates, clamps and persists them.
 *
 * Failure boundaries:
 *  - Session not owned by the caller → the history store throws; the route
 *    reports the same 404 as an unknown session.
 *  - No usable chat model → MemorySummaryModelUnavailableError (caller 409).
 *  - Provider error, empty content or unparseable JSON → MemorySummaryError
 *    (caller 502). The stored profile is never overwritten on failure.
 *  - An unchanged session (same fingerprint) is a no-op: no provider call.
 */

import { createHash } from "node:crypto"
import type OpenAI from "openai"
import type { AccessContext } from "../access/context"
import {
  MEMORY_PROFILE_LIMITS,
  MEMORY_SECTION_KEYS,
  MemoryProfileStore,
  type MemoryProfile,
} from "./memory_profile_store"

export const MEMORY_SUMMARY_LIMITS = {
  /** Transcript characters sent to the model (newest turns win). */
  maxTranscriptChars: 12_000,
  /** Output budget: three 800-character Chinese sections plus JSON keys. */
  maxOutputTokens: 2_600,
  /** Per-call provider timeout. */
  timeoutMs: 30_000,
} as const

export interface MemoryTranscriptTurn {
  role: "user" | "assistant"
  content: string
  createdAt: string
  /** Assistant turns only: a non-completed terminal is skipped. */
  terminalStatus?: string | null
}

/** The history read used by the summarizer (owner-checked by its store). */
export interface MemoryTranscriptReader {
  getTurns(sessionId: string, tenantId: string, subjectId: string): MemoryTranscriptTurn[]
}

export interface MemoryChatModel {
  client: OpenAI
  model: string
}

export type ResolveMemoryChatModel = (tenantId: string) => MemoryChatModel | null

export class MemorySummaryModelUnavailableError extends Error {
  constructor(message = "no chat model is configured for this account") {
    super(message)
    this.name = "MemorySummaryModelUnavailableError"
  }
}

export class MemorySummaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemorySummaryError"
  }
}

export interface SessionMemorySummarizer {
  summarize(
    context: AccessContext,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<MemoryProfile>
}

export interface SessionMemorySummarizerOptions {
  profiles: MemoryProfileStore
  history: MemoryTranscriptReader
  resolveChatModel: ResolveMemoryChatModel
}

const SYSTEM_PROMPT = [
  "你是用户长期记忆整理器。输入包含该用户已有的长期画像和一段刚刚结束的会话。",
  "请输出更新后的长期画像，只输出一个 JSON 对象，不要任何前缀、解释或代码围栏。",
  'JSON 固定三个字符串字段："workBackground"、"personalBackground"、"recentActivity"。',
  "workBackground：职业、行业、职责、项目、技术栈与工作方式。",
  "personalBackground：称呼、语言、表达偏好、长期习惯与稳定约束。",
  "recentActivity：最近 1 到 3 项仍在进行的任务、关注点或近期变化；过时内容删除，确属长期事实的可移入前两段。",
  "只保留会话中明确出现或可可靠推断的信息，不要编造。没有新信息的段落保留原有内容。",
  "每段不超过 800 个字符。",
].join("\n")

function transcriptOf(turns: MemoryTranscriptTurn[]): string {
  const max = MEMORY_SUMMARY_LIMITS.maxTranscriptChars
  const lines: string[] = []
  let remaining = max
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (!turn) continue
    const content = turn.content.trim()
    if (!content) continue
    if (turn.role === "assistant" && turn.terminalStatus && turn.terminalStatus !== "completed") {
      // A failed/cancelled/refused assistant turn is not conversation content
      // worth remembering; only validated completed answers survive here.
      continue
    }
    const line = `${turn.role === "user" ? "用户" : "助手"}: ${content}`
    if (remaining <= 0) break
    if (line.length >= remaining) {
      const tail = line.slice(-remaining)
      if (tail) lines.unshift(tail)
      break
    }
    lines.unshift(line)
    remaining -= line.length + 1
  }
  return lines.join("\n")
}

function fingerprintOf(turns: MemoryTranscriptTurn[]): string {
  const last = turns[turns.length - 1]
  return createHash("sha256")
    .update(`${turns.length}\u0000${last?.createdAt ?? ""}\u0000${last?.content ?? ""}`)
    .digest("hex")
}

/** Tolerant JSON object extraction: fences and stray preface are ignored. */
function parseSummaryObject(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) throw new MemorySummaryError("summary response was empty")
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  const start = unfenced.indexOf("{")
  const end = unfenced.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new MemorySummaryError("summary response was not a JSON object")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    throw new MemorySummaryError("summary response was not valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemorySummaryError("summary response was not a JSON object")
  }
  return parsed as Record<string, unknown>
}

export function createSessionMemorySummarizer(
  options: SessionMemorySummarizerOptions
): SessionMemorySummarizer {
  return {
    async summarize(context, sessionId, signal) {
      const current = options.profiles.get(context.tenantId, context.subjectId)
      const turns = options.history.getTurns(
        sessionId,
        context.tenantId,
        context.subjectId
      )
      if (turns.length === 0) return current

      const fingerprint = fingerprintOf(turns)
      const meta = options.profiles.summaryMeta(context.tenantId, context.subjectId)
      if (meta.lastSessionId === sessionId && meta.lastSessionFingerprint === fingerprint) {
        return current
      }

      const transcript = transcriptOf(turns)
      if (!transcript) return current

      const chat = options.resolveChatModel(context.tenantId)
      if (!chat) throw new MemorySummaryModelUnavailableError()

      const existing = {
        workBackground: current.workBackground,
        personalBackground: current.personalBackground,
        recentActivity: current.recentActivity,
      }
      let completion: OpenAI.Chat.Completions.ChatCompletion
      try {
        completion = await chat.client.chat.completions.create(
          {
            model: chat.model,
            max_tokens: MEMORY_SUMMARY_LIMITS.maxOutputTokens,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: `现有画像：\n${JSON.stringify(existing)}\n\n本次会话：\n${transcript}`,
              },
            ],
          },
          { ...(signal ? { signal } : {}), timeout: MEMORY_SUMMARY_LIMITS.timeoutMs }
        )
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error
        throw new MemorySummaryError(
          `summary provider failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      const raw = completion.choices?.[0]?.message?.content ?? ""
      const parsed = parseSummaryObject(raw)
      const sections = {} as Record<string, string>
      for (const key of MEMORY_SECTION_KEYS) {
        const value = parsed[key]
        if (value === undefined || value === null) {
          // A missing/null field means "no new information for this section";
          // keep the owner's current text instead of failing the whole update.
          sections[key] = existing[key]
          continue
        }
        if (typeof value !== "string") {
          throw new MemorySummaryError(`summary field ${key} was not a string`)
        }
        // TypeSafe decision (jev-1.14.0, 2026-10-30, choice=clamp 0.93): keep
        // the new personalization and cut an over-limit section, rather than
        // rejecting the whole update and losing the other valid sections.
        sections[key] = value.slice(0, MEMORY_PROFILE_LIMITS.maxSectionChars).trim()
      }

      return options.profiles.recordSummary(
        context.tenantId,
        context.subjectId,
        sections,
        { sessionId, fingerprint }
      )
    },
  }
}
