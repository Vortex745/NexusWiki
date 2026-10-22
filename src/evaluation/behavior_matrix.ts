/**
 * Ticket DR-21 — honest status derivation for the complete behaviour matrix.
 *
 * This module owns the rules, not the evidence: the driver runs the real HTTP /
 * SQLite tests and feeds their observations in. A cell may claim
 * `pass/offline` only when every test it names was observed passing in THIS
 * run. Missing observations, failures, absent capability snapshots and online
 * gates are never promoted to a pass.
 */

export type CellStatus =
  | "pass/offline"
  | "not_run/online"
  | "not_configured"
  | "not_exercised"
  | "incomplete"
  | "error"

export type CaseKind = "normal" | "error" | "boundary" | "config" | "online"

export interface MatrixTestRef {
  file: string
  name: string
}

export interface TestObservation {
  status: "pass" | "fail"
  durationMs?: number
}

export interface OfflineCellSpec {
  id: string
  group: string
  caseKind: CaseKind
  description: string
  ticket: string
  source: "offline_test"
  tests: MatrixTestRef[]
}

export interface CapabilityCellSpec {
  id: string
  group: string
  caseKind: "config"
  description: string
  ticket: string
  source: "capability"
  capability: "rerank"
}

export interface OnlineCellSpec {
  id: string
  group: string
  caseKind: "online"
  description: string
  ticket: string
  source: "online"
  gate: string
}

export type MatrixCellSpec = OfflineCellSpec | CapabilityCellSpec | OnlineCellSpec

export interface RerankCapabilitySnapshot {
  status?: string
  configured?: boolean
  model?: { configured?: string | null; observed?: string[] }
}

export interface CellEvidence {
  file?: string
  test?: string
  result: "pass" | "fail" | "incomplete" | "not_run"
}

export interface CellResult {
  id: string
  group: string
  caseKind: CaseKind
  description: string
  ticket: string
  source: MatrixCellSpec["source"]
  status: CellStatus
  countedAsPass: boolean
  detail: string
  missing: string[]
  failed: string[]
  evidence: CellEvidence[]
  onlineAcceptance?: "not_run"
}

export interface MatrixSummary {
  status: "offline_complete" | "incomplete"
  offlineComplete: boolean
  onlineAcceptance: "not_run"
  blocking: string[]
  pending: string[]
  counts: Record<CellStatus, number>
  exitCode: 0 | 1
}

export function observationKey(ref: MatrixTestRef): string {
  return `${ref.file}::${ref.name}`
}

export function evaluateOfflineCell(
  cell: OfflineCellSpec,
  observed: ReadonlyMap<string, TestObservation>,
): CellResult {
  if (cell.tests.length === 0) {
    return result(cell, "incomplete", "the cell names no test, so it has no evidence for this run")
  }

  const evidence: CellEvidence[] = []
  const missing: string[] = []
  const failed: string[] = []
  for (const ref of cell.tests) {
    const observation = observed.get(observationKey(ref))
    if (!observation) {
      missing.push(ref.name)
      evidence.push({ file: ref.file, test: ref.name, result: "incomplete" })
      continue
    }
    if (observation.status === "fail") failed.push(ref.name)
    evidence.push({ file: ref.file, test: ref.name, result: observation.status })
  }

  if (missing.length > 0) {
    return result(
      cell,
      "incomplete",
      `missing this run's evidence: ${missing.join("; ")}`,
      evidence,
      { missing, failed },
    )
  }
  if (failed.length > 0) {
    return result(cell, "error", `failed this run: ${failed.join("; ")}`, evidence, {
      missing,
      failed,
    })
  }
  return result(cell, "pass/offline", `observed passing in this run: ${cell.tests.length} test(s)`, evidence)
}

export function evaluateOnlineCell(cell: OnlineCellSpec): CellResult {
  return result(
    cell,
    "not_run/online",
    `required online acceptance is not run; gate ${cell.gate} is not accepted`,
    [],
    {},
    "not_run",
  )
}

export function evaluateCapabilityCell(
  cell: CapabilityCellSpec,
  snapshot: RerankCapabilitySnapshot | null | undefined,
): CellResult {
  if (!snapshot) {
    return result(
      cell,
      "not_configured",
      "no rerank capability snapshot was recorded; configuring a provider is not coverage",
      [],
      {},
      "not_run",
    )
  }

  const stored = (snapshot.status ?? "").trim()
  const configured =
    Boolean(snapshot.configured) ||
    (stored !== "" && stored !== "not_configured" && stored !== "skipped")

  if (stored === "invalid") {
    return result(
      cell,
      "incomplete",
      "the retained ordering evidence is malformed or unrecognized; coverage is not claimed",
    )
  }
  if (stored === "exercised") {
    const observed = (snapshot.model?.observed ?? []).filter((value) => value.trim() !== "")
    const configuredModel = snapshot.model?.configured ?? null
    const modelMatches =
      observed.length > 0 &&
      (configuredModel === null || (observed.length === 1 && observed[0] === configuredModel))
    if (!modelMatches) {
      return result(
        cell,
        "incomplete",
        "a controlled run published dedicated ordering without a matching model snapshot",
      )
    }
    return result(
      cell,
      "pass/offline",
      "controlled run published dedicated_rerank ordering with a matching model snapshot; this proves the protocol/report branch only",
      [],
      {},
      "not_run",
    )
  }
  if (stored === "degraded") {
    return result(
      cell,
      "not_exercised",
      "the provider failed and the published ranking kept the explicit fused/degraded source; not dedicated coverage",
      [],
      {},
      "not_run",
    )
  }
  if (configured) {
    return result(
      cell,
      "not_exercised",
      "a rerank provider is configured but no sample proves a provider call; configuration is not coverage",
      [],
      {},
      "not_run",
    )
  }
  return result(
    cell,
    "not_configured",
    "no rerank provider is configured; the capability is skipped",
    [],
    {},
    "not_run",
  )
}

export function evaluateMatrix(
  cells: readonly MatrixCellSpec[],
  observed: ReadonlyMap<string, TestObservation>,
  snapshot: RerankCapabilitySnapshot | null | undefined,
): CellResult[] {
  return cells.map((cell) => {
    if (cell.source === "offline_test") return evaluateOfflineCell(cell, observed)
    if (cell.source === "online") return evaluateOnlineCell(cell)
    return evaluateCapabilityCell(cell, snapshot)
  })
}

export function summarizeMatrix(
  results: readonly CellResult[],
  options: { offlineOnly: boolean },
): MatrixSummary {
  const counts: Record<CellStatus, number> = {
    "pass/offline": 0,
    "not_run/online": 0,
    not_configured: 0,
    not_exercised: 0,
    incomplete: 0,
    error: 0,
  }
  for (const result of results) counts[result.status] += 1

  const blocked = results.filter(
    (result) => result.status === "incomplete" || result.status === "error",
  )
  const pending = results.filter(
    (result) =>
      result.status === "not_run/online" ||
      result.status === "not_configured" ||
      result.status === "not_exercised",
  )
  const offlineCells = results.filter((result) => result.source === "offline_test")
  const offlineComplete =
    offlineCells.length > 0 &&
    offlineCells.every((result) => result.status === "pass/offline") &&
    blocked.length === 0

  // Without --offline-only, anything still pending keeps the whole matrix
  // incomplete; the flag only states that the offline deliverable is done.
  const complete = blocked.length === 0 && pending.length === 0
  const status = options.offlineOnly
    ? offlineComplete
      ? "offline_complete"
      : "incomplete"
    : complete
      ? "offline_complete"
      : "incomplete"

  return {
    status,
    offlineComplete,
    onlineAcceptance: "not_run",
    blocking: blocked.map((result) => result.id),
    pending: pending.map((result) => result.id),
    counts,
    exitCode: status === "offline_complete" ? 0 : 1,
  }
}

function result(
  cell: MatrixCellSpec,
  status: CellStatus,
  detail: string,
  evidence: CellEvidence[] = [],
  extra: { missing?: string[]; failed?: string[] } = {},
  onlineAcceptance?: "not_run",
): CellResult {
  return {
    id: cell.id,
    group: cell.group,
    caseKind: cell.caseKind,
    description: cell.description,
    ticket: cell.ticket,
    source: cell.source,
    status,
    countedAsPass: status === "pass/offline",
    detail,
    missing: extra.missing ?? [],
    failed: extra.failed ?? [],
    evidence,
    ...(onlineAcceptance ? { onlineAcceptance } : {}),
  }
}
