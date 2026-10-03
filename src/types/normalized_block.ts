export type ParserType = "markitdown" | "marker" | "mineru" | "builtin-pdf" | "direct-txt"

export type NormalizedBlockType =
  | "heading"
  | "paragraph"
  | "table"
  | "code"
  | "image"
  | "equation"

export interface ParserProvenance {
  parser: ParserType
  adapter: "cli" | "script" | "in-process"
}

export interface NormalizedBlock {
  id: string
  index: number
  type: NormalizedBlockType
  text: string
  headingLevel?: number
  page?: number
  sectionPath: string[]
  boundingBox?: [number, number, number, number]
  table?: Record<string, unknown>
  image?: Record<string, unknown>
  metadata: Record<string, unknown>
  provenance: ParserProvenance
}
