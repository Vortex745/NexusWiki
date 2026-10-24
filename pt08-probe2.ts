import { ContextAssemblerImpl } from "./src/retrieval/context/assembler"
import { buildEvidence, citationIdsByChunk } from "./src/answer/evidence"
import type { RetrievalResult } from "./src/types"

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
  for (const ctxTok of [700, 900, 1000, 1200] as const) {
    const material = await new ContextAssemblerImpl({ maxContextTokens: ctxTok, maxParentTokens: 20_000 }).assembleMaterial(results, citationIdsByChunk(evidence))
    console.log(`ctxTok=${ctxTok} len=${material!.context.length} tokens=${material!.tokenCount} raw=${material!.rawTokens} cand=${material!.candidateTokens} omissions=${JSON.stringify(material!.omissions.map(o => [o.evidenceId, o.reason]))} contributions=${material!.contributions.length}`)
    console.log("  CTX " + JSON.stringify(material!.context))
  }
}
main().then(() => console.log("ok"))
