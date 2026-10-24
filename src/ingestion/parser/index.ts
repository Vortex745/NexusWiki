import type { NormalizedBlock, ParserType } from "../../types"
import type { ParseDocumentInput } from "./markitdown"

export interface Parser {
  type: ParserType
  parse(input: ParseDocumentInput): Promise<NormalizedBlock[]>
  /**
   * Ticket UT-09 truth seams: parsers that can split extraction from
   * normalization expose the raw CLI output (pre-cleaning) so the pipeline
   * can persist durable extraction evidence. Optional — parsers whose
   * verification is artifact-coupled (mineru) stay on parse().
   */
  parseRaw?(input: Omit<ParseDocumentInput, "documentId">): Promise<string>
  normalizeRaw?(raw: string, documentId: string): NormalizedBlock[]
  /**
   * Ticket UT-10: extraction-level provenance (decode evidence, allowed
   * transforms, review flags) captured by the last parseRaw. The pipeline
   * merges `metadata` into document metadata.system and `warnings` into the
   * durable evidence record. Optional — parsers without decode decisions
   * omit it.
   */
  extractionProvenance?(): { metadata: Record<string, unknown>; warnings: string[] } | null
}

export type { ParserType } from "../../types"
export { MarkItDownParser } from "./markitdown"
// Historical offline adapters/normalizers: production routing never selects
// these runtimes. Keep persisted provenance and diagnostic fixtures readable.
export { MarkerParser, normalizeMarker } from "./marker"
export type { MarkerParserOptions } from "./marker"
export { MinerUParser, normalizeMinerU } from "./mineru"
export type { MinerUParserOptions } from "./mineru"
export { BuiltinPdfParser, normalizeBuiltinPdf, analyzeStructureRisks } from "./builtin_pdf"
export type { BuiltinPdfParserOptions, StructureRiskFlags } from "./builtin_pdf"
export type {
  MarkItDownParserOptions,
  ParseDocumentInput,
} from "./markitdown"
export { normalizeMarkItDown } from "./normalize"
export { runBoundedProcess } from "./process"
export { DirectTextParser, decodeTextBytes } from "./direct_text"
export { OcrApiParser } from "./ocr_api"
export type { OcrApiParserOptions } from "./ocr_api"
export type { TextDecodeProvenance } from "./direct_text"
export type { BoundedProcessInput } from "./process"
export { isParserOverride, selectParser, selectParserRoute } from "./router"
export type {
  ParserDecision,
  ParserRouteInfo,
  ParserSelectionInput,
} from "./router"
