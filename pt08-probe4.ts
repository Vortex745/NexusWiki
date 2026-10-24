import { createSimpleKnowledgeMastraRunner } from "./src/mastra/simple_knowledge_runner"
import { createMastraChatEventAdapter } from "./src/mastra/chat_event_adapter"
import { ContextAssemblerImpl } from "./src/retrieval/context/assembler"
import type { RetrievalResult } from "./src/types"
import type { SearchOutcome } from "./src/retrieval/search/interface"
import type { AnswerRunEvent } from "./src/types"

async function main() {
  for (const status of ["insufficient", "ok"] as const) {
    const results: RetrievalResult[] = []
    const searcher = { async search(): Promise<SearchOutcome> { return { status, results, unavailableChannels: ["vector"] } as SearchOutcome } } as never
    const runner = createSimpleKnowledgeMastraRunner({
      router: { async decide() { return "simple" } } as never,
      createSearcher: () => searcher,
      assembler: new ContextAssemblerImpl({ maxContextTokens: 20_000, maxParentTokens: 20_000 }),
      validator: { async validate() { return { passed: true, hallucination: false, completeness: true } } } as never,
      replanner: { async replan() { return [] } } as never,
      streamAnswerDraft: async function* () { yield "不应到达这里" },
    } as never)
    const output = await runner({ message: "退款政策？", runId: `run-${status}`, sessionId: "s", signal: new AbortController().signal, accessContext: { tenantId: "t", subjectId: "s", groups: [], scopes: ["chat"] } } as never)
    console.log(`### searcher=${status}`)
    console.log("  status", output.status, "degradation", JSON.stringify(output.degradation))
    console.log("  contextTrace", JSON.stringify(output.contextTrace), "keys", Object.keys(output.contextTrace).length)
    console.log("  retrievalTrace", JSON.stringify(output.retrievalTrace))
    console.log("  references", JSON.stringify(output.references))
    const events: AnswerRunEvent[] = []
    for await (const e of createMastraChatEventAdapter({ runner })(`${status}问题`, { runId: `run-ev-${status}`, sessionId: "s" } as never)) events.push(e)
    console.log("  context events:", events.filter((e) => e.stage === "context").length, "any snapshot:", events.some((e) => "generationContext" in (e.data ?? {})))
    const done = events.find((e) => e.type === "done") as Extract<AnswerRunEvent, { type: "done" }> | undefined
    console.log("  done:", JSON.stringify({ status: done?.status, refs: done?.result.references.length, reply: done?.result.reply }))
  }
}
main().then(() => console.log("done"), (e) => { console.error(e); process.exitCode = 1 })
