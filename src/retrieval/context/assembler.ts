import { tokenizers } from "@llamaindex/env/tokenizers"
import type { Chunk, RetrievalResult } from "../../types"

/**
 * Ticket 61 / 04 (spec §2 L1748): shared block framing used by BOTH the
 * deterministic `ContextAssemblerImpl` and the LLM-backed `ContextCompressor`.
 * Exported so the compressor produces byte-compatible INTRO/SUFFIX wrappers
 * when it assembles compressed blocks, and so the `ContextBudget` helper
 * computes the uncompressed token count using the same overhead constants.
 */
export const CONTEXT_INTRO = "以下是从知识库中找到的相关文档片段：\n"
export const CONTEXT_SUFFIX = "\n请基于以上文档片段回答用户的问题。如果信息不足，请明确说明。"

/** Backward-compat aliases used inside `assembler.ts` itself. */
const INTRO = CONTEXT_INTRO
const SUFFIX = CONTEXT_SUFFIX

/**
 * Ticket 22 (ATT-01): temporary attachment context is labelled as such, both
 * per group ("临时引用: 附件 <name>") and once up front, so neither the model
 * nor the reader can mistake it for knowledge-base membership.
 */
/**
 * Ticket 22 (ATT-01) / PT-06:AC04 — exported so the budget helper and the
 * compressor count the SAME fixed text the deterministic assembler pays for.
 */
export const TEMPORARY_CONTEXT_NOTE =
  "（标注为“临时引用”的片段来自本次会话的临时附件，不属于知识库。）\n"

function sourceLabel(group: { source: string; temporary?: boolean }): string {
  if (!group.temporary) return `来源: ${group.source}`
  const name = group.source.startsWith("附件:") ? group.source.slice("附件:".length) : group.source
  return `临时引用: 附件 ${name}`
}

const MODEL_TOKENIZER = tokenizers.tokenizer()

export interface ContextAssemblerOptions {
  maxContextTokens?: number
  maxParentTokens?: number
  countTokens?: (text: string) => number
}

// ---------------------------------------------------------------------------
// PT-06 — the shared MATERIAL representation.
//
// One implementation, consumed by the deterministic assembler, the budget
// helper and the compressor, so no layer ever measures the pipeline against a
// different number. Three counts are kept strictly apart (PT-06:AC02):
//   1. RAW       — the complete authorized parent block (`rawText`).
//   2. CANDIDATE — the text left after the per-parent window
//                  (`candidateText` / `candidateContextTokens`).
//   3. FINAL     — the exact formatted output handed to the generator
//                  (`context` / `tokenCount`, plus each `placedText`).
// The 600-char display preview (`Evidence.excerpt`) is NOT one of them and is
// never an upper bound on any of them — that conflation was F4.
// ---------------------------------------------------------------------------

/** Why a piece of authorized material did not reach the final context. */
export type ContextMaterialOmissionReason =
  | "budget_exhausted"
  | "window_excluded"
  | "unauthorized_parent"

export interface ContextMaterialCitation {
  evidenceId?: string
  chunkId: string
  documentId: string
  parentChunkId: string
  /** The COMPLETE authorized child snippet — never the display preview. */
  snippet: string
  /** True when the per-parent window really carries this snippet. */
  included: boolean
}

export interface ContextMaterialSource {
  key: string
  documentId: string
  parentChunkId: string
  /** The authorized source identity as framed in the context header. */
  source: string
  temporary: boolean
  /** Whether this group's block is inside `ContextMaterial.context`. */
  admitted: boolean
  /** COUNT 1 — the raw long parent block. */
  rawText: string
  rawTokens: number
  /** COUNT 2 — the candidate text after the per-parent window. */
  candidateText: string
  candidateTokens: number
  /** COUNT 2 with this group's header + trailing newline (what framing costs). */
  candidateContextTokens: number
  /**
   * The header text the budget walk reserved for this group — every citation
   * marker plus the authorized source identity. Exported because PT-06:AC04
   * requires the caller to be able to re-count it, and `formatMaterialBlock`
   * must never invent a different framing.
   */
  headerText: string
  /** COUNT 3 — the exact block placed in the final context, when admitted. */
  placedText?: string
  placedTokens?: number
  /** Index of `placedText` inside `ContextMaterial.context`. */
  placedStart?: number
  citations: ContextMaterialCitation[]
  omissionReason?: ContextMaterialOmissionReason
}

/**
 * One citation's contribution inside the final context: the exact text, where
 * it sits, and the full authorized material it was taken from (PT-06:AC05 —
 * span and order must correspond to the real output, and a snippet the window
 * dropped is never listed as adopted just because it has a candidate id).
 */
export interface ContextMaterialContribution {
  evidenceId: string
  documentId: string
  chunkId: string
  parentChunkId: string
  source: string
  temporary: boolean
  /** Exact slice of `ContextMaterial.context` this citation contributes. */
  text: string
  tokens: number
  /** COUNT 1 of the parent it came from, for full/partial coverage. */
  fullMaterialText: string
  /** Index of `text` inside `context` — the real output order. */
  offset: number
}

export interface ContextMaterialOmission {
  documentId: string
  parentChunkId: string
  chunkId?: string
  evidenceId?: string
  reason: ContextMaterialOmissionReason
}

export interface ContextMaterial {
  /** COUNT 3 — the exact string handed to the generator / compressor caller. */
  context: string
  tokenCount: number
  /** COUNT 1 — every authorized parent block, in full. */
  rawTokens: number
  /** COUNT 2 — every per-parent candidate window (text only). */
  candidateTokens: number
  /** COUNT 2 + all fixed framing — the number the budget decision uses. */
  candidateContextTokens: number
  /** INTRO (+ temporary-attachment note) + SUFFIX, counted. */
  framingTokens: number
  /**
   * PT-06:AC04 — the material carries session attachments, so the fixed
   * temporary-attachment note is part of EVERY representation of it (the
   * compressor must repeat the note, never drop it).
   */
  temporaryAttachment: boolean
  maxContextTokens: number
  maxParentTokens: number
  sources: ContextMaterialSource[]
  /** Admitted citations in real output order — the generation snapshot input. */
  contributions: ContextMaterialContribution[]
  omissions: ContextMaterialOmission[]
}

export interface ContextMaterialOptions {
  /**
   * PT-06:AC08 — a parent block only enters the material when the authorized
   * child vouches for it. The default is the identity pair `loadParents`
   * re-checks AccessContext + knowledge scope on (`documentId` match): a
   * foreign parent never contributes text, the child stands in for it, and the
   * refusal is recorded as an `unauthorized_parent` omission.
   */
  authorizeParent?: (child: Chunk, parent: Chunk) => boolean
}

interface MaterialGroup {
  key: string
  documentId: string
  parentChunkId: string
  content: string
  source: string
  temporary?: boolean
  matches: Array<{ content: string; citationId?: string; chunkId: string }>
}

interface MatchPlacement {
  /** The snippet this placement carries. */
  snippet: string
  /** The exact text placed in the context for it (the snippet, or its window). */
  text: string
  /** Index of `text` inside the window content. */
  offset: number
}

interface WindowDetail {
  content: string
  includedMatches: string[]
  placements: MatchPlacement[]
}

function defaultAuthorizeParent(child: Chunk, parent: Chunk): boolean {
  return parent.documentId === child.documentId
}

function buildCitationHeader(
  group: { source: string; temporary?: boolean },
  matches: Array<{ content: string; citationId?: string }>,
  isIncluded: (match: { content: string; citationId?: string }) => boolean
): string {
  const citations = matches
    .flatMap((match) => (isIncluded(match) && match.citationId ? [`[cite:${match.citationId}]`] : []))
    .join(" ")
  return `${citations}${citations ? " " : ""}[${sourceLabel(group)}]\n`
}

export class ContextAssemblerImpl {
  private maxContextTokens: number
  private maxParentTokens: number
  private countTokens: (text: string) => number

  constructor(options: ContextAssemblerOptions = {}) {
    this.maxContextTokens = options.maxContextTokens ?? 6_000
    this.maxParentTokens = options.maxParentTokens ?? 4_500
    this.countTokens = options.countTokens ?? modelTokenCount
  }

  /**
   * PT-06:AC09 — the legacy string entry point. It is now a thin delegate over
   * the material result, so a string consumer (the complex loop adapter, an
   * older caller, a test fixture) gets byte-identical output while the real
   * counts live in exactly one place.
   */
  async assemble(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>
  ): Promise<string> {
    return (await this.assembleMaterial(results, citationIds)).context
  }

  /**
   * PT-06:AC01/AC02/AC04/AC05 — assemble the COMPLETE authorized material and
   * report every count separately: the raw parent blocks, the per-parent
   * candidate windows, and the final formatted context with ALL fixed text
   * (INTRO, the temporary-attachment note, per-group headers, citation markers,
   * SUFFIX) inside the budget. Nothing that was left out is silent: every
   * exclusion is an explicit `omissions` entry with a reason.
   */
  async assembleMaterial(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>,
    options: ContextMaterialOptions = {}
  ): Promise<ContextMaterial> {
    const authorizeParent = options.authorizeParent ?? defaultAuthorizeParent
    const groups = new Map<string, MaterialGroup>()
    const omissions: ContextMaterialOmission[] = []

    for (const r of results) {
      let contextChunk = r.chunk
      if (r.parentChunk) {
        if (authorizeParent(r.chunk, r.parentChunk)) {
          contextChunk = r.parentChunk
        } else {
          // An unauthorized parent never contributes text; the authorized
          // child stands in for it and the refusal stays visible.
          omissions.push({
            documentId: r.chunk.documentId,
            parentChunkId: r.parentChunk.id,
            chunkId: r.chunk.id,
            reason: "unauthorized_parent",
          })
        }
      }
      const key = `${contextChunk.documentId}\0${contextChunk.id}`
      const citationId = citationIds?.get(
        `${r.chunk.documentId}\0${r.chunk.id}`
      )
      const group = groups.get(key) ?? {
        key,
        documentId: contextChunk.documentId,
        parentChunkId: contextChunk.id,
        content: contextChunk.content,
        source: (contextChunk.metadata?.source as string) || "unknown",
        // Ticket 22 (ATT-01): provenance decides the header, so a temporary
        // attachment is never presented as knowledge-base membership.
        ...(contextChunk.metadata?.origin === "attachment" ? { temporary: true } : {}),
        matches: [],
      }
      if (!group.matches.some((match) =>
        match.content === r.chunk.content && match.citationId === citationId
      )) {
        group.matches.push({ content: r.chunk.content, citationId, chunkId: r.chunk.id })
      }
      groups.set(key, group)
    }

    const groupList = [...groups.values()]
    // Ticket 22 (ATT-01): one honest note when the context carries temporary
    // attachments at all — the reader must never take them for knowledge.
    const hasTemporary = groupList.some((group) => group.temporary)
    const introText = hasTemporary ? `${INTRO}${TEMPORARY_CONTEXT_NOTE}` : INTRO
    // PT-06:AC04 — the framing that is always paid for, note included.
    const framingTokens = this.countTokens(`${introText}${SUFFIX}`)

    // COUNT 1 + COUNT 2 are measured for EVERY group, including the ones the
    // budget walk below never admits: the material the run was entitled to look
    // at is a fact about the retrieval, not an artifact of the truncation.
    const measurements = groupList.map((group) => {
      const provisionalHeader = buildCitationHeader(group, group.matches, () => true)
      const wrapperTokens = this.countTokens(`${provisionalHeader}\n`)
      const candidate = this.parentWindowDetail(
        group.content,
        group.matches.map(({ content: match }) => match),
        this.maxParentTokens
      )
      return {
        group,
        provisionalHeader,
        wrapperTokens,
        rawTokens: this.countTokens(group.content),
        candidate,
        candidateContextTokens: this.countTokens(
          `${provisionalHeader}${candidate.content}\n`
        ),
      }
    })

    const parts: string[] = [introText]
    const sources: ContextMaterialSource[] = []
    const contributions: ContextMaterialContribution[] = []
    // The budget walk is byte-identical to the legacy `assemble()` — only the
    // bookkeeping around it is new.
    let remaining = this.maxContextTokens - framingTokens
    let stopped = false
    let placedStart = introText.length

    /** Record every citation of a group that could not enter the context. */
    const recordExcluded = (
      group: MaterialGroup,
      reason: ContextMaterialOmissionReason
    ): void => {
      if (group.matches.length === 0) {
        omissions.push({
          documentId: group.documentId,
          parentChunkId: group.parentChunkId,
          reason,
        })
        return
      }
      for (const match of group.matches) {
        omissions.push({
          documentId: group.documentId,
          parentChunkId: group.parentChunkId,
          chunkId: match.chunkId,
          ...(match.citationId ? { evidenceId: match.citationId } : {}),
          reason,
        })
      }
    }

    for (const measurement of measurements) {
      const group = measurement.group
      const refuse = (): void => {
        stopped = true
        sources.push(this.describeSource(measurement, null))
        recordExcluded(group, "budget_exhausted")
      }
      if (stopped || remaining <= 0) {
        refuse()
        continue
      }
      const contentBudget = Math.min(
        this.maxParentTokens,
        Math.max(0, remaining - measurement.wrapperTokens)
      )
      if (contentBudget <= 0) {
        refuse()
        continue
      }
      // The candidate window is reused when the walk allows the full per-parent
      // cap; otherwise the admitted window is computed at the shrinking budget.
      const window = contentBudget === this.maxParentTokens
        ? measurement.candidate
        : this.parentWindowDetail(
            group.content,
            group.matches.map(({ content: match }) => match),
            contentBudget
          )
      const included = new Set(window.includedMatches)
      const header = buildCitationHeader(
        group,
        group.matches,
        (match) => included.has(match.content)
      )
      const part = `${header}${window.content}\n`
      const partTokens = this.countTokens(part)
      if (partTokens > remaining) {
        refuse()
        continue
      }

      parts.push(part)
      remaining -= partTokens
      sources.push(this.describeSource(measurement, {
        part,
        window,
        start: placedStart,
      }))
      const bodyStart = placedStart + header.length
      for (const match of group.matches) {
        const placement = window.placements.find(
          (candidate) => candidate.snippet === match.content
        )
        if (!included.has(match.content) || placement === undefined) {
          omissions.push({
            documentId: group.documentId,
            parentChunkId: group.parentChunkId,
            chunkId: match.chunkId,
            ...(match.citationId ? { evidenceId: match.citationId } : {}),
            reason: "window_excluded",
          })
          continue
        }
        // PT-06:AC05 — a snippet only counts as contributed when the window
        // really carries it AND it has a citation identity; a candidate id whose
        // text the window left out is never listed as adopted.
        if (!match.citationId) continue
        contributions.push({
          evidenceId: match.citationId,
          documentId: group.documentId,
          chunkId: match.chunkId,
          parentChunkId: group.parentChunkId,
          source: group.source,
          temporary: group.temporary === true,
          text: placement.text,
          tokens: this.countTokens(placement.text),
          fullMaterialText: group.content,
          offset: bodyStart + placement.offset,
        })
      }
      placedStart += part.length
    }

    parts.push(SUFFIX)
    const context = parts.join("")
    contributions.sort((left, right) => left.offset - right.offset)

    return {
      context,
      tokenCount: this.countTokens(context),
      rawTokens: measurements.reduce((sum, m) => sum + m.rawTokens, 0),
      candidateTokens: measurements.reduce(
        (sum, m) => sum + this.countTokens(m.candidate.content),
        0
      ),
      candidateContextTokens: framingTokens + measurements.reduce(
        (sum, m) => sum + m.candidateContextTokens,
        0
      ),
      framingTokens,
      temporaryAttachment: hasTemporary,
      maxContextTokens: this.maxContextTokens,
      maxParentTokens: this.maxParentTokens,
      sources,
      contributions,
      omissions,
    }
  }

  /**
   * Describe one group's three counts. `placed` is the block actually written
   * into the context — absent when the budget walk never admitted the group, in
   * which case only the raw block and the candidate window exist.
   */
  private describeSource(
    measurement: {
      group: MaterialGroup
      candidate: WindowDetail
      candidateContextTokens: number
      rawTokens: number
      provisionalHeader: string
    },
    placed: { part: string; window: WindowDetail; start: number } | null
  ): ContextMaterialSource {
    const group = measurement.group
    const effective = placed?.window ?? measurement.candidate
    return {
      key: group.key,
      documentId: group.documentId,
      parentChunkId: group.parentChunkId,
      source: group.source,
      temporary: group.temporary === true,
      admitted: placed !== null,
      rawText: group.content,
      rawTokens: measurement.rawTokens,
      candidateText: measurement.candidate.content,
      candidateTokens: this.countTokens(measurement.candidate.content),
      candidateContextTokens: measurement.candidateContextTokens,
      headerText: measurement.provisionalHeader,
      ...(placed !== null
        ? {
            placedText: placed.part,
            placedTokens: this.countTokens(placed.part),
            placedStart: placed.start,
          }
        : { omissionReason: "budget_exhausted" as const }),
      citations: group.matches.map((match) => ({
        ...(match.citationId ? { evidenceId: match.citationId } : {}),
        chunkId: match.chunkId,
        documentId: group.documentId,
        parentChunkId: group.parentChunkId,
        snippet: match.content,
        included: effective.includedMatches.includes(match.content),
      })),
    }
  }

  /**
   * PT-06:AC02 — the per-parent window. Returns the placed text AND the exact
   * placement of every snippet it carries, so the caller can distinguish "the
   * raw parent block" from "the candidate window" from "what was formatted".
   */
  private parentWindowDetail(
    parent: string,
    matches: string[],
    budget: number
  ): WindowDetail {
    const uniqueMatches = [...new Set(matches)].filter(Boolean)
    const estimatedParentTokens = estimatedTokenCount(parent)
    if (estimatedParentTokens <= budget
      && this.countTokens(parent) <= budget) {
      return {
        content: parent,
        includedMatches: uniqueMatches,
        placements: uniqueMatches.map((snippet) => ({
          snippet,
          text: snippet,
          offset: Math.max(0, parent.indexOf(snippet)),
        })),
      }
    }
    if (uniqueMatches.length === 0) {
      return {
        content: this.truncate(parent, budget),
        includedMatches: [],
        placements: [],
      }
    }

    const separator = "\n...\n"
    const separatorTokens = this.countTokens(separator)
    const selected: string[] = []
    let selectedTokens = 0
    for (const match of uniqueMatches) {
      const nextTokens = this.countTokens(match)
        + (selected.length > 0 ? separatorTokens : 0)
      if (selectedTokens + nextTokens > budget) continue
      selected.push(match)
      selectedTokens += nextTokens
    }
    if (selected.length === 0) {
      return {
        content: this.truncate(parent, budget),
        includedMatches: [],
        placements: [],
      }
    }

    const extraPerMatch = Math.floor((budget - selectedTokens) / selected.length)
    const placements: MatchPlacement[] = []
    let windowStart = 0
    const windows = selected.map((match) => {
      const text = this.windowAround(
        parent,
        match,
        this.countTokens(match) + extraPerMatch,
        estimatedParentTokens
      )
      const insideMatch = text.includes(match)
      placements.push({
        snippet: match,
        text: insideMatch ? match : text,
        offset: windowStart + (insideMatch ? text.indexOf(match) : 0),
      })
      windowStart += text.length + separator.length
      return text
    })
    return {
      content: windows.join(separator),
      includedMatches: selected,
      placements,
    }
  }

  private windowAround(
    parent: string,
    match: string,
    budget: number,
    parentTokens: number
  ): string {
    const matchIndex = parent.indexOf(match)
    if (matchIndex < 0) return this.truncate(match, budget)
    if (this.countTokens(match) > budget) return this.truncate(match, budget)

    let targetLength = Math.max(
      match.length,
      Math.floor(parent.length * budget / parentTokens)
    )
    let best = match
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const radius = Math.max(0, Math.floor((targetLength - match.length) / 2))
      const start = Math.max(0, matchIndex - radius)
      const end = Math.min(parent.length, matchIndex + match.length + radius)
      const candidate = parent.slice(start, end)
      const candidateTokens = this.countTokens(candidate)
      if (candidateTokens <= budget) {
        best = candidate
        if (candidateTokens === budget || end - start === parent.length) break
      }
      targetLength = Math.max(
        match.length,
        Math.floor(targetLength * budget / Math.max(1, candidateTokens))
      )
    }
    return best
  }

  private truncate(text: string, budget: number): string {
    const estimatedTotal = estimatedTokenCount(text)
    if (estimatedTotal <= budget && this.countTokens(text) <= budget) return text
    let targetLength = Math.max(
      1,
      Math.floor(text.length * budget / Math.max(1, estimatedTotal))
    )
    let best = ""
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = text.slice(0, targetLength)
      const candidateTokens = this.countTokens(candidate)
      if (candidateTokens <= budget) best = candidate
      if (candidateTokens === budget) break
      targetLength = Math.max(
        1,
        Math.floor(targetLength * budget / Math.max(1, candidateTokens))
      )
    }
    return best
  }
}

/**
 * Ticket 61 / 04 (spec §2 L1748): shared token-counting function used by
 * the deterministic assembler, the `ContextBudget` helper, and the
 * `ContextCompressor`. Chinese text → UTF-8 byte length (matches the
 * determinstic assembler's behavior); ASCII text → llamaindex tokenizer
 * token count. Exported so the compressor and budget helper compute token
 * counts consistent with the assembler's budget enforcement.
 */
export function modelTokenCount(text: string): number {
  if (/[^\x00-\x7f]/.test(text)) return Buffer.byteLength(text, "utf8")
  return MODEL_TOKENIZER.encode(text).length
}

/**
 * CJK-aware estimate used by the conversation-context meter: CJK (and other
 * non-ASCII) characters count one each, ASCII counts a quarter. Deliberately
 * NOT `modelTokenCount` — that charges Chinese text by UTF-8 byte length, which
 * would report a Chinese conversation at roughly three times its real size.
 */
export function estimatedTokenCount(text: string): number {
  let tokens = 0
  let asciiRun = 0
  const flushAscii = (): void => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4)
    asciiRun = 0
  }
  for (const character of text) {
    if (/^[\x20-\x7e]$/.test(character)) {
      asciiRun += 1
    } else {
      flushAscii()
      if (!/\s/u.test(character)) tokens += 1
    }
  }
  flushAscii()
  return tokens
}
