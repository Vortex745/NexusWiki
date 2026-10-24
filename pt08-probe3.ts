import { createSimpleKnowledgeMastraRunner } from "./src/mastra/simple_knowledge_runner"
import { ContextAssemblerImpl } from "./src/retrieval/context/assembler"
import { buildEvidence, citationIdsByChunk } from "./src/answer/evidence"
import type { AgentMessage, RetrievalResult } from "./src/types"
import type { SearchOutcome } from "./src/retrieval/search/interface"

const TAIL_FACT = "超过六百字符之后的关键例外：特殊定制品下单后不可退款。"
const HEAD = "标准商品支持七日退款。"
const LONG_PARENT = `${HEAD}${"背景说明。".repeat(200)}${TAIL_FACT}`
function parentOnlyResult(index = 1): RetrievalResult {
  return {
    chunk: { id: `child-${index}`, documentId: `doc-${index}`, content: LONG_PARENT.slice(0, 120), childrenIds: [], metadata: { source: `kb-${index}` } },
    score: 0.9, source: "vector", wikilinks: [],
    parentChunk: { id: `parent-${index}`, documentId: `doc-${index}`, content: LONG_PARENT, childrenIds: [], metadata: { source: `kb-${index}` } },
  }
}
async function main() {
  const results = [parentOnlyResult(1), parentOnlyResult(2)]
  const evidence = buildEvidence(results)
  const assembler = new ContextAssemblerImpl({ maxContextTokens: 1200, maxParentTokens: 20_000 })
  const searcher = { async search(): Promise<SearchOutcome> { return { status: "ok", results, unavailableChannels: [], ordering: { source: "dedicated_rerank" } } } } as never
  const runner = createSimpleKnowledgeMastraRunner({
    router: { async decide() { return "simple" } } as never,
    createSearcher: () => searcher,
    assembler,
    validator: { async validate() { return { passed: true, hallucination: false, completeness: true } } } as never,
    replanner: { async replan() { return [] } } as never,
    streamAnswerDraft: async function* (messages: AgentMessage[]) {
      void messages
      yield `七日退款 [cite:${evidence[0].id}]`
    },
  } as never)
  const output = await runner({ message: "退款政策？", runId: "run-x", sessionId: "s", signal: new AbortController().signal, accessContext: { tenantId: "t", subjectId: "s", groups: [], scopes: ["chat"] } } as never)
  const { generationContext, ...rest } = output.contextTrace
  console.log("TRACE-WITHOUT-SNAPSHOT", JSON.stringify(rest, null, 1))
  console.log("SNAPSHOT", JSON.stringify(generationContext, null, 1))
  console.log("CANDIDATES", JSON.stringify(output.retrievalTrace.finalContextCandidates))
  console.log("ORDERING", JSON.stringify(output.retrievalTrace.finalContextOrdering), "ROUND", output.retrievalTrace.finalContextRound)
  console.log("REFERENCES", JSON.stringify(output.references.map(r => ({ id: r.id, chunkId: r.chunkId, documentId: r.documentId }))))
  console.log("EVIDENCE-IDS", JSON.stringify(evidence.map(e => e.id)))
  const material = await assembler.assembleMaterial(results, citationIdsByChunk(evidence))
  console.log("MATERIAL", JSON.stringify({ len: material!.context.length, tokenCount: material!.tokenCount, raw: material!.rawTokens, cand: material!.candidateTokens, omissions: material!.omissions.map(o => [o.evidenceId, o.reason]) }))
}
main().then(() => console.log("done"), (e) => { console.error(e); process.exitCode = 1 })
