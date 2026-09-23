/**
 * Ticket 46 (DEMO-02B) — the 20-case quality gate.
 *
 * Drives the RUNNING local demo (DEMO_OIDC=1) through the versioned case
 * file `golden/demo-release-cases.v1.json` over the real chat entry, then
 * decides pass/fail ONLY by the prewritten rules:
 *
 *   - answer cases: the reply must contain every answer point (normalized);
 *   - refuse cases: the run ends in an honest refusal (terminal status
 *     insufficient_retrieval / clarification_required / rejected, or the
 *     reply carries the refusal marker) — a fabricated answer FAILS;
 *   - memory-not-cited: the done event's references never contain the
 *     memory content.
 *
 * HARD cases (isolation/refusal) must ALL pass; at least 10 of the other 14
 * and at least 16 overall. BLEU/ROUGE and the retrieval metrics are NOT
 * consulted — they stay diagnostic (evaluation tickets 06-08).
 *
 * Usage:
 *   npm run release:quality-gate                 # writes release-quality-results.json
 *
 * Exit codes: 0 gate passed, 1 gate failed / run error, 2 invalid usage.
 */

import "dotenv/config"
import { readFileSync, writeFileSync } from "node:fs"

interface GateCase {
  id: string
  hard: boolean
  kind: "answer" | "refuse" | "memory-not-cited"
  message: string
  knowledgeBaseIds: string[]
  answerPoints?: string[]
  forbiddenReferenceContent?: string
  reason?: string
}

interface GateDataset {
  schema: string
  version: number
  rules: { hardMustPass: string; othersMinPass: number; overallMinPass: number }
  cases: GateCase[]
}

interface CaseResult {
  id: string
  hard: boolean
  kind: string
  pass: boolean
  terminalStatus: string | null
  replyExcerpt: string
  referenceCount: number
  missingAnswerPoints?: string[]
  detail: string
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
}

const REFUSAL_MARKERS = [
  "未找到相关证据",
  "无法生成可靠回答",
  "无法回答",
  "无法作答",
  "证据不足",
  "未能找到",
  "根据现有知识库",
]

async function login(baseUrl: string): Promise<string> {
  const password = process.env.DEMO_OIDC_PASSWORD
  if (!password) throw new Error("DEMO_OIDC_PASSWORD must be set for the gate")
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "admin", password }),
  })
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`)
  const body = (await response.json()) as { accessToken: string }
  return body.accessToken
}

interface DoneEvent {
  status?: string
  reply?: string
  references?: Array<{
    content?: string
    excerpt?: string
    title?: string
    origin?: string
    docId?: string
  }>
  memoryUsed?: { ids?: string[]; count?: number }
}

/** Send one chat turn and resolve the SSE stream's terminal done event. */
async function runCase(
  baseUrl: string,
  token: string,
  cs: GateCase
): Promise<{ done: DoneEvent | null; error: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: cs.message,
        sessionId: `gate-${cs.id}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 100),
        knowledgeBaseIds: cs.knowledgeBaseIds,
      }),
    })
    if (!response.ok || !response.body) {
      return { done: null, error: `chat failed: HTTP ${response.status}` }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let done: DoneEvent | null = null
    for (;;) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        try {
          // The transport nests the run event: data: {sessionId, runId, event:{type, result}}.
          const payload = JSON.parse(line.slice(5).trim()) as {
            event?: { type?: string; result?: DoneEvent }
          }
          if (payload.event?.type === "done" && payload.event.result) {
            done = {
              status: payload.event.result.status,
              reply: payload.event.result.reply,
              references: payload.event.result.references,
              memoryUsed: payload.event.result.memoryUsed,
            }
          }
        } catch {
          // partial frame — the next chunk completes it
        }
      }
    }
    return { done, error: done ? null : "the stream ended without a done event" }
  } catch (error) {
    return {
      done: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function judge(cs: GateCase, done: DoneEvent | null, error: string | null): CaseResult {
  const base: CaseResult = {
    id: cs.id,
    hard: cs.hard,
    kind: cs.kind,
    pass: false,
    terminalStatus: done?.status ?? null,
    replyExcerpt: (done?.reply ?? "").slice(0, 160),
    referenceCount: done?.references?.length ?? 0,
  }
  if (error || !done) {
    return { ...base, detail: `run error: ${error ?? "no done event"}` }
  }
  const reply = normalize(done.reply ?? "")
  const status = (done.status ?? "").toLowerCase()

  if (cs.kind === "memory-not-cited") {
    const forbidden = normalize(cs.forbiddenReferenceContent ?? "")
    const cited = (done.references ?? []).some((reference) =>
      normalize(`${reference.content ?? ""} ${reference.excerpt ?? ""} ${reference.title ?? ""}`).includes(
        forbidden
      )
    )
    return {
      ...base,
      pass: !cited,
      detail: cited
        ? "FAIL: the long-term memory content appeared in the references"
        : "memory content is absent from the references (it may inform the prompt, never a citation)",
    }
  }

  if (cs.kind === "refuse") {
    const refused =
      REFUSAL_MARKERS.some((marker) => reply.includes(normalize(marker))) ||
      status === "insufficient_retrieval" ||
      status === "clarification_required" ||
      status === "rejected"
    return {
      ...base,
      pass: refused && reply.length < 1200,
      detail: refused
        ? "honest refusal observed"
        : `FAIL: expected a refusal, got an answer (status ${status || "none"})`,
    }
  }

  // kind === "answer": every prewritten answer point must appear.
  const missing = (cs.answerPoints ?? [])
    .map((point) => normalize(point))
    .filter((point) => !reply.includes(point))
  return {
    ...base,
    pass: missing.length === 0,
    missingAnswerPoints: missing.length > 0 ? missing : undefined,
    detail:
      missing.length === 0
        ? "all answer points present"
        : `FAIL: missing answer points: ${missing.join(" | ")}`,
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    console.error("usage: npm run release:quality-gate")
    return 2
  }
  const baseUrl = process.env.GATE_BASE_URL ?? "http://localhost:3001"
  const dataset = JSON.parse(
    readFileSync("golden/demo-release-cases.v1.json", "utf8")
  ) as GateDataset

  console.log(`release quality gate: ${dataset.cases.length} cases (dataset v${dataset.version})`)
  const token = await login(baseUrl)

  const results: CaseResult[] = []
  for (const [index, cs] of dataset.cases.entries()) {
    const { done, error } = await runCase(baseUrl, token, cs)
    const result = judge(cs, done, error)
    results.push(result)
    console.log(
      `  [${index + 1}/${dataset.cases.length}] ${result.pass ? "PASS" : "FAIL"} ${cs.id}${cs.hard ? " (HARD)" : ""} — ${result.detail}`
    )
  }

  const hard = results.filter((result) => result.hard)
  const others = results.filter((result) => !result.hard)
  const hardPassed = hard.filter((result) => result.pass).length
  const othersPassed = others.filter((result) => result.pass).length
  const overallPassed = results.filter((result) => result.pass).length

  const passed =
    hardPassed === hard.length &&
    othersPassed >= dataset.rules.othersMinPass &&
    overallPassed >= dataset.rules.overallMinPass

  const report = {
    schema: "release-quality-results",
    datasetVersion: dataset.version,
    checkedAt: new Date().toISOString(),
    rules: dataset.rules,
    summary: {
      hardPassed,
      hardTotal: hard.length,
      othersPassed,
      othersTotal: others.length,
      overallPassed,
      overallTotal: results.length,
      gate: passed ? "passed" : "failed",
    },
    results,
  }
  writeFileSync("release-quality-results.json", JSON.stringify(report, null, 2))
  console.log(
    `hard ${hardPassed}/${hard.length} · others ${othersPassed}/${others.length} · overall ${overallPassed}/${results.length} → gate ${passed ? "PASSED" : "FAILED"}`
  )
  console.log("results written to release-quality-results.json")
  return passed ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(
      "[release-quality-gate] failed:",
      error instanceof Error ? error.message : String(error)
    )
    process.exitCode = 1
  })
