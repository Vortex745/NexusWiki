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
}

export type { ParserType } from "../../types"
export { MarkItDownParser } from "./markitdown"
export { MarkerParser, normalizeMarker } from "./marker"
export type { MarkerParserOptions } from "./marker"
export { MinerUParser, normalizeMinerU } from "./mineru"
export type { MinerUParserOptions } from "./mineru"
export { BuiltinPdfParser, normalizeBuiltinPdf } from "./builtin_pdf"
export type { BuiltinPdfParserOptions } from "./builtin_pdf"
export type {
  MarkItDownParserOptions,
  ParseDocumentInput,
} from "./markitdown"
export { normalizeMarkItDown } from "./normalize"
export { runBoundedProcess } from "./process"
export type { BoundedProcessInput } from "./process"
export { isParserOverride, selectParser, selectParserRoute } from "./router"
export type {
  ParserDecision,
  ParserRouteInfo,
  ParserSelectionInput,
} from "./router"
