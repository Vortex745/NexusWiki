/**
 * Build the single-turn DeepEval dataset from the versioned release contract
 * (golden/demo-release-cases.v2.json, 20 cases over the deterministic demo
 * corpus).
 *
 * Why this source: the TS fixtures (src/evaluation/golden/fixtures.ts)
 * reference synthetic source IDs (source-onboarding-v2, ...) absent from the
 * live index, so knowledge questions over them always end in "insufficient
 * evidence" through no fault of the app. The demo-gate cases carry a real
 * message + knowledgeBaseIds scope + expected-behavior rule each — exactly
 * what a single-turn traced eval needs. Reuse of an existing reviewed
 * dataset, not hand-written goldens.
 *
 * v2 contract: each golden keeps the source kind/hard/scope/answer points,
 * the reviewed prohibited assertions, the memory constraints, the contract
 * version and the source digest. expected_output is composed from the kind
 * rule, the optional non-empty reason and every answer point; the converter
 * fails closed (non-zero exit, nothing written) on an invalid source.
 *
 * Output Golden fields: name (gate id, for -k filtering), input (message),
 * expected_output (kind rule + reason + answer points + prohibitions),
 * additional_metadata (scope, answer points, prohibitions, memory
 * constraints, contract version, source digest). A missing source scope
 * omits `scope` (server default); an explicit [] stays [] (no knowledge
 * context - the answer must be refused).
 *
 * Usage:
 *   npx tsx tests/evals/convert_demo_gate.mts [--source <path>] [--out <path>]
 *
 * The default output is tests/evals/.dataset.json (single-turn). The
 * conversational converter owns tests/evals/.conversational-dataset.json;
 * neither overwrites the other.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const KINDS = ["answer", "refuse", "memory-not-cited"] as const
type Kind = (typeof KINDS)[number]

interface MemoryConstraints {
  citationRule: string
  viewingRule: string
}

interface GateCase {
  id: string
  hard: boolean
  kind: Kind
  message: string
  knowledgeBaseIds?: string[]
  answerPoints?: string[]
  prohibitedAssertions?: string[]
  forbiddenReferenceContent?: string
  memoryConstraints?: MemoryConstraints
  reason?: string
}

interface GateDataset {
  schema: string
  version: number
  contract: {
    kindRules: Record<Kind, string>
    prohibitedAssertionsPolicy: string
    memoryConstraints?: MemoryConstraints
  }
  digest: {
    algorithm: string
    scope: string
    canonicalization: string
    value: string
  }
  cases: GateCase[]
}

interface Golden {
  name: string
  input: string
  expected_output: string
  additional_metadata: {
    gate_id: string
    kind: Kind
    hard: boolean
    scope?: string[]
    answer_points?: string[]
    prohibited_assertions: string[]
    forbidden_reference_content?: string
    memory_constraints?: MemoryConstraints
    contract_version: number
    source_digest: string
  }
}

class SourceError extends Error {}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..", "..")

function parseArgs(argv: string[]): { source: string; out: string } {
  let source = join(repoRoot, "golden", "demo-release-cases.v2.json")
  let out = join(scriptDir, ".dataset.json")
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--source" || arg === "--out") {
      const value = argv[i + 1]
      if (!value || value.startsWith("--")) {
        throw new SourceError(`missing value for ${arg}`)
      }
      if (arg === "--source") source = resolve(value)
      else out = resolve(value)
      i += 1
    } else {
      throw new SourceError(`unknown argument: ${arg}`)
    }
  }
  return { source, out }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function computeDatasetDigest(dataset: {
  version: number
  contract: unknown
  rules?: unknown
  cases: GateCase[]
}): string {
  const material = {
    version: dataset.version,
    contract: dataset.contract,
    rules: dataset.rules,
    cases: dataset.cases,
  }
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(material)), "utf8")
    .digest("hex")
}

function validateDataset(raw: unknown): GateDataset {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SourceError("source must be a JSON object")
  }
  const dataset = raw as Partial<GateDataset>
  if (dataset.version !== 2) {
    throw new SourceError(`unsupported dataset version: ${String(dataset.version)}`)
  }
  if (!dataset.contract || typeof dataset.contract !== "object") {
    throw new SourceError("source.contract is required")
  }
  if (!dataset.digest || typeof dataset.digest !== "object") {
    throw new SourceError("source.digest is required")
  }
  if (dataset.digest.algorithm !== "sha256") {
    throw new SourceError("source.digest.algorithm must be sha256")
  }
  if (!isStringArray(dataset.contract.kindRules ? Object.values(dataset.contract.kindRules) : undefined)) {
    throw new SourceError("source.contract.kindRules is required")
  }
  for (const kind of KINDS) {
    if (!isNonEmptyString(dataset.contract.kindRules?.[kind])) {
      throw new SourceError(`source.contract.kindRules.${kind} is required`)
    }
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new SourceError("source.cases must be a non-empty array")
  }

  const ids = new Set<string>()
  for (const [index, candidate] of dataset.cases.entries()) {
    const at = `cases[${index}]`
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new SourceError(`${at} must be an object`)
    }
    const gateCase = candidate as Partial<GateCase>
    if (!isNonEmptyString(gateCase.id)) {
      throw new SourceError(`${at}.id must be a non-empty string`)
    }
    if (ids.has(gateCase.id)) {
      throw new SourceError(`duplicate case id: ${gateCase.id}`)
    }
    ids.add(gateCase.id)
    if (!KINDS.includes(gateCase.kind as Kind)) {
      throw new SourceError(`${gateCase.id}: unknown kind ${String(gateCase.kind)}`)
    }
    if (typeof gateCase.hard !== "boolean") {
      throw new SourceError(`${gateCase.id}: hard must be a boolean`)
    }
    if (!isNonEmptyString(gateCase.message)) {
      throw new SourceError(`${gateCase.id}: message must be a non-empty string`)
    }
    if (gateCase.reason !== undefined && typeof gateCase.reason !== "string") {
      throw new SourceError(`${gateCase.id}: reason must be a string when present`)
    }
    if (
      gateCase.knowledgeBaseIds !== undefined &&
      (!isStringArray(gateCase.knowledgeBaseIds) ||
        gateCase.knowledgeBaseIds.some((entry) => entry.trim().length === 0))
    ) {
      throw new SourceError(
        `${gateCase.id}: knowledgeBaseIds must be an array of non-empty strings`
      )
    }
    if (gateCase.answerPoints !== undefined && !isStringArray(gateCase.answerPoints)) {
      throw new SourceError(
        `${gateCase.id}: answerPoints must be an array of non-empty strings`
      )
    }
    if (
      gateCase.kind === "answer" &&
      (!Array.isArray(gateCase.answerPoints) ||
        gateCase.answerPoints.length === 0 ||
        gateCase.answerPoints.some((entry) => entry.trim().length === 0))
    ) {
      throw new SourceError(`${gateCase.id}: answer case requires non-empty answerPoints`)
    }
    if (
      gateCase.answerPoints !== undefined &&
      gateCase.answerPoints.some((entry) => entry.trim().length === 0)
    ) {
      throw new SourceError(
        `${gateCase.id}: answerPoints must be an array of non-empty strings`
      )
    }
    if (
      gateCase.prohibitedAssertions !== undefined &&
      (!isStringArray(gateCase.prohibitedAssertions) ||
        gateCase.prohibitedAssertions.some((entry) => entry.trim().length === 0))
    ) {
      throw new SourceError(
        `${gateCase.id}: prohibitedAssertions must be an array of non-empty strings`
      )
    }
    if (
      gateCase.forbiddenReferenceContent !== undefined &&
      !isNonEmptyString(gateCase.forbiddenReferenceContent)
    ) {
      throw new SourceError(
        `${gateCase.id}: forbiddenReferenceContent must be a non-empty string`
      )
    }
    if (gateCase.memoryConstraints !== undefined) {
      const constraints = gateCase.memoryConstraints as Partial<MemoryConstraints>
      if (
        !constraints ||
        typeof constraints !== "object" ||
        !isNonEmptyString(constraints.citationRule) ||
        !isNonEmptyString(constraints.viewingRule)
      ) {
        throw new SourceError(
          `${gateCase.id}: memoryConstraints requires citationRule and viewingRule`
        )
      }
    }
    if (gateCase.kind === "answer") {
      if (!Array.isArray(gateCase.answerPoints) || gateCase.answerPoints.length === 0) {
        throw new SourceError(`${gateCase.id}: answer case requires non-empty answerPoints`)
      }
    }
    if (gateCase.kind === "memory-not-cited") {
      if (!isNonEmptyString(gateCase.forbiddenReferenceContent)) {
        throw new SourceError(
          `${gateCase.id}: memory-not-cited case requires forbiddenReferenceContent`
        )
      }
      if (!gateCase.memoryConstraints) {
        throw new SourceError(
          `${gateCase.id}: memory-not-cited case requires memoryConstraints`
        )
      }
    }
  }

  const expectedDigest = computeDatasetDigest(dataset as GateDataset)
  if (dataset.digest.value !== expectedDigest) {
    throw new SourceError(
      `source digest mismatch: expected ${expectedDigest}, found ${String(dataset.digest.value)}`
    )
  }

  return dataset as GateDataset
}

function composeExpectedOutput(dataset: GateDataset, gateCase: GateCase): string {
  const parts: string[] = [dataset.contract.kindRules[gateCase.kind]]
  const reason = gateCase.reason?.trim()
  if (reason) parts.push(`判定规则：${reason}`)
  if (gateCase.answerPoints?.length) {
    parts.push(`标准答案要点（须全部出现）：${gateCase.answerPoints.join("；")}`)
  }
  if (gateCase.prohibitedAssertions?.length) {
    parts.push(
      `禁止断言（出现任一即判失败）：${gateCase.prohibitedAssertions.join("；")}`
    )
  }
  return `${parts.join("。")}。`
}

function buildGolden(dataset: GateDataset, gateCase: GateCase): Golden {
  const metadata: Golden["additional_metadata"] = {
    gate_id: gateCase.id,
    kind: gateCase.kind,
    hard: gateCase.hard,
    prohibited_assertions: [...(gateCase.prohibitedAssertions ?? [])],
    contract_version: dataset.version,
    source_digest: `sha256:${dataset.digest.value}`,
  }
  if (gateCase.knowledgeBaseIds !== undefined) {
    metadata.scope = [...gateCase.knowledgeBaseIds]
  }
  if (gateCase.answerPoints !== undefined) {
    metadata.answer_points = [...gateCase.answerPoints]
  }
  if (gateCase.forbiddenReferenceContent !== undefined) {
    metadata.forbidden_reference_content = gateCase.forbiddenReferenceContent
  }
  if (gateCase.memoryConstraints !== undefined) {
    metadata.memory_constraints = { ...gateCase.memoryConstraints }
  }
  return {
    name: gateCase.id,
    input: gateCase.message,
    expected_output: composeExpectedOutput(dataset, gateCase),
    additional_metadata: metadata,
  }
}

function main(argv: string[]): number {
  try {
    const { source, out } = parseArgs(argv)
    const raw = JSON.parse(readFileSync(source, "utf8")) as unknown
    const dataset = validateDataset(raw)
    // Build every golden before writing so an invalid case never leaves a
    // partially converted dataset behind.
    const goldens = dataset.cases.map((gateCase) => buildGolden(dataset, gateCase))
    const payload = JSON.stringify(goldens, null, 2)
    if (payload.includes("undefined")) {
      throw new SourceError("refusing to write a dataset containing literal undefined")
    }
    writeFileSync(out, payload, "utf8")
    console.log(
      `wrote ${goldens.length} goldens (demo gate v${dataset.version}, sha256:${dataset.digest.value.slice(0, 12)})`
    )
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[convert-demo-gate] failed: ${message}`)
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))
