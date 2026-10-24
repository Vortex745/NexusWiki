import { createSimpleKnowledgeMastraRunner } from "./src/mastra/simple_knowledge_runner"
import { createMastraChatEventAdapter } from "./src/mastra/chat_event_adapter"
import { ContextAssemblerImpl } from "./src/retrieval/context/assembler"
import { buildEvidence } from "./src/answer/evidence"
import type { AgentMessage, RetrievalResult } from "./src/types"
import type { SearchOutcome } from "./src/retrieval/search/interface"

const TAIL_FACT = "超过六百字符之后的关键例外：特殊定制品下单后不可退款。"
const HEAD = "标准商品支持七日退款。"
const LONG_PARENT = `${HEAD}${"背景说明。".repeat(200)}${TAIL_FACT}`

function parentOnlyResult(index = 1, parent = LONG_PARENT): RetrievalResult {
  return {
    chunk: {
      id: `child-${index}`,
      documentId: `doc-${index}`,
      content: parent.slice(0, 120),
      childrenIds: [],
      metadata: { source: `kb-${index}` },
    },
    score: 0.9,
    source: "vector",
    wikilinks: [],
    parentChunk: {
      id: `parent-${index}`,
      documentId: `doc-${index}`,
      content: parent,
      childrenIds: [],
      metadata: { source: `kb-${index}` },
    },
  }
}

type Case = {
  name: string
  results: RetrievalResult[]
  gapResults?: RetrievalResult[]
  verdicts: { passed: boolean; hallucination: boolean; completeness: boolean; missingGap?: string }[]
  maxContextTokens?: number
  maxParentTokens?: number
  ordering?: SearchOutcome["ordering"]
  failDraftRound?: number
  abortDraftRound?: number
}

async function run(c: Case) {
  const evidence = buildEvidence(c.results)
  let searcherCalls = 0
  let draftCalls = 0
  const captured: string[] = []
  const controller = new AbortController()
  const searcher = {
    async search(): Promise<SearchOutcome> {
      searcherCalls += 1
      const useGap = c.gapResults && searcherCalls > 1
      return {
        status: useGap ? "ok" : c.results.length === 0 ? "insufficient" : "ok",
        results: useGap ? c.gapResults! : c.results,
        unavailableChannels: [],
        ...(c.ordering && !useGap ? { ordering: c.ordering } : {}),
      } as SearchOutcome
    },
  } as never
  let validatorCall = 0
  const runner = createSimpleKnowledgeMastraRunner({
    router: { async decide() { return "simple" } } as never,
    createSearcher: () => searcher,
    assembler: new ContextAssemblerImpl({
      maxContextTokens: c.maxContextTokens ?? 20_000,
      maxParentTokens: c.maxParentTokens ?? 20_000,
    }),
    validator: {
      async validate() {
        const verdict = c.verdicts[Math.min(validatorCall, c.verdicts.length - 1)]
        validatorCall += 1
        return verdict
      },
    } as never,
    replanner: { async replan() { return c.gapResults ? [{ text: "例外" }] : [] } } as never,
    streamAnswerDraft: async function* draft(messages: AgentMessage[]) {
      draftCalls += 1
      captured.push(messages[messages.length - 1].content)
      if (c.failDraftRound === draftCalls) throw new Error("provider down")
      if (c.abortDraftRound === draftCalls) {
        controller.abort()
        throw Object.assign(new Error("cancelled"), { name: "AbortError" })
      }
      yield `七日退款 [cite:${evidence[0]?.id ?? "ev_x"}]`
    },
  } as never)
  const events: unknown[] = []
  let thrown: unknown
  try {
    for await (const event of createMastraChatEventAdapter({ runner })("退款政策？", {
      runId: `run-${c.name}`,
      sessionId: "sess-probe",
      signal: controller.signal,
      accessContext: { tenantId: "t", subjectId: "s", groups: [], scopes: ["chat"] },
    } as never)) {
      events.push(event)
    }
  } catch (err) {
    thrown = err
  }
  const summary = events.map((raw) => {
    const e = raw as {
      type: string
      stage: string
      status: string
      round?: number
      data?: Record<string, unknown>
      result?: { status: string; references: unknown[]; reply: string }
    }
    if (e.type === "done") {
      return `done ${e.status} :: ${JSON.stringify({ status: e.result!.status, refs: e.result!.references.length })}`
    }
    if (e.type === "progress") {
      const keys = Object.keys(e.data ?? {}).sort()
      return `progress ${e.stage}/${e.status} r${e.round} keys=[${keys.join(",")}] snapshot=${
        e.data?.generationContext
          ? JSON.stringify({
              round: (e.data!.generationContext as { generationRound: number }).generationRound,
              entries: (e.data!.generationContext as { entries: unknown[] }).entries.length,
              omissions: (e.data!.generationContext as { omissions: unknown[] }).omissions,
              representation: (e.data!.generationContext as { representation: string }).representation,
            })
          : "none"
      } unavailable=${JSON.stringify(e.data?.generationContextUnavailable ?? null)}`
    }
    return `${e.type} ${e.stage}`
  })
  console.log(`\n### ${c.name}`)
  console.log(`draftCalls=${draftCalls} searcherCalls=${searcherCalls} thrown=${String(thrown)}`)
  for (const line of summary) console.log("  " + line)
  const retrieval = events.find(
    (raw) =>
      (raw as { data?: Record<string, unknown> }).data?.finalContextCandidates !== undefined
  ) as { data: Record<string, unknown> } | undefined
  if (retrieval) {
    console.log(
      "  CANDIDATES " + JSON.stringify(retrieval.data.finalContextCandidates)
    )
    console.log("  ORDERING " + JSON.stringify(retrieval.data.finalContextOrdering))
    console.log("  ROUND " + JSON.stringify(retrieval.data.finalContextRound))
  }
  const contextEvent = [...events]
    .reverse()
    .find(
      (raw) =>
        (raw as { stage?: string; data?: Record<string, unknown> }).stage === "context" &&
        Object.keys((raw as { data: Record<string, unknown> }).data ?? {}).length > 2
    ) as { data: Record<string, unknown> } | undefined
  if (contextEvent) {
    const { generationContext: _skip, ...rest } = contextEvent.data
    console.log("  CONTEXT-TRACE-WITHOUT-SNAPSHOT " + JSON.stringify(rest))
    if (generationContextRaw(contextEvent)) {
      console.log("  SNAPSHOT " + JSON.stringify(generationContextRaw(contextEvent)))
    }
  }
  console.log("  PROMPT-CAPTURE " + JSON.stringify(captured.map((p) => p.slice(0, 60))))
  if (captured[1]) console.log("  ROUND2-PROMPT-HEAD " + JSON.stringify(captured[1].slice(0, 120)))
}

function generationContextRaw(event: { data: Record<string, unknown> }): unknown {
  return event.data.generationContext
}

async function main(): Promise<void> {
  await run({
    name: "no-results-no-generation",
    results: [],
    verdicts: [{ passed: true, hallucination: false, completeness: true }],
  })

  await run({
    name: "normal-single",
    results: [parentOnlyResult()],
    verdicts: [{ passed: true, hallucination: false, completeness: true }],
  })

  await run({
    name: "two-cut-second",
    results: [parentOnlyResult(1), parentOnlyResult(2)],
    verdicts: [{ passed: true, hallucination: false, completeness: true }],
    maxContextTokens: 200,
    maxParentTokens: 120,
    ordering: { source: "dedicated_rerank" },
  })

  await run({
    name: "multi-round",
    results: [parentOnlyResult(1)],
    gapResults: [parentOnlyResult(3, `定制品例外条款。${"补充。".repeat(20)}${TAIL_FACT}`)],
    verdicts: [
      { passed: false, hallucination: false, completeness: false, missingGap: "例外" },
      { passed: true, hallucination: false, completeness: true },
    ],
  })

  await run({
    name: "same-parent-two-children",
    results: [
      { ...parentOnlyResult(1), chunk: { ...parentOnlyResult(1).chunk, id: "child-1a", content: HEAD } },
      { ...parentOnlyResult(1), chunk: { ...parentOnlyResult(1).chunk, id: "child-1b", content: TAIL_FACT } },
    ],
    verdicts: [{ passed: true, hallucination: false, completeness: true }],
  })

  await run({
    name: "provider-error-round-2",
    results: [parentOnlyResult(1)],
    gapResults: [parentOnlyResult(3)],
    verdicts: [
      { passed: false, hallucination: false, completeness: false, missingGap: "例外" },
      { passed: true, hallucination: false, completeness: true },
    ],
    failDraftRound: 2,
  })

  await run({
    name: "abort-round-2",
    results: [parentOnlyResult(1)],
    gapResults: [parentOnlyResult(3)],
    verdicts: [
      { passed: false, hallucination: false, completeness: false, missingGap: "例外" },
      { passed: true, hallucination: false, completeness: true },
    ],
    abortDraftRound: 2,
  })

  await run({
    name: "provider-error-round-1",
    results: [parentOnlyResult(1)],
    verdicts: [{ passed: true, hallucination: false, completeness: true }],
    failDraftRound: 1,
  })
}

main().then(
  () => console.log("\nprobe done"),
  (err) => {
    console.error("probe failed", err)
    process.exitCode = 1
  }
)
