/**
 * DR-21 — one aggregation entry point for the complete behaviour matrix.
 *
 * This driver does NOT re-implement any scenario. It reads the frozen manifest
 * (`scripts/dr21-matrix.json`), runs each referenced real HTTP / SQLite / MCP
 * test FILE exactly once with the repository's own test invocation, and maps
 * the observed test names back to matrix cells. Online rows are never run
 * here: `G-P0` and `G-RERANK-LIVE` stay `not_run` until they are accepted.
 *
 * Run:  node --import tsx scripts/dr21-behavior-matrix.ts
 *       node --import tsx scripts/dr21-behavior-matrix.ts --offline-only
 *
 * The local stdio MCP child intentionally inherits only the MCP SDK's safe
 * environment list, so the MCP tests need a `.env` beside the process cwd.
 * The driver therefore runs the tests from `.scratch/dr21-run/`, which holds a
 * CONTROLLED placeholder `.env` (dead local endpoints, no credential), rather
 * than touching the repository `.env`.
 *
 * Exit code is 0 only for `--offline-only` when every offline cell passed in
 * this run; without the flag an unconcluded online gate keeps it non-zero.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  evaluateMatrix,
  summarizeMatrix,
  type CapabilityCellSpec,
  type CellResult,
  type MatrixCellSpec,
  type OfflineCellSpec,
  type OnlineCellSpec,
  type RerankCapabilitySnapshot,
  type TestObservation,
} from "../src/evaluation/behavior_matrix"

interface ManifestCell {
  id: string
  caseKind: MatrixCellSpec["caseKind"]
  description: string
  ticket: string
  source: MatrixCellSpec["source"]
  tests?: Array<{ file: string; name: string }>
  gate?: string
  capability?: "rerank"
}

interface ManifestGroup {
  id: string
  title: string
  required: boolean
  cells: ManifestCell[]
}

interface Manifest {
  schema: string
  schemaVersion: number
  ticket: string
  groups: ManifestGroup[]
  rerank?: {
    onlineGate?: string
    modelExpectation?: string
    onlineAcceptance?: string
  }
}

interface FileRun {
  file: string
  exitCode: number | null
  tests: number
  passed: number
  failed: number
  durationMs: number
  note?: string
}

interface Options {
  manifestPath: string
  outPath: string
  offlineOnly: boolean
  capabilitySnapshotPath: string | null
}

function options(argv: readonly string[]): Options {
  const root = process.cwd()
  let manifestPath = join(root, "scripts", "dr21-matrix.json")
  let outPath = join(root, ".scratch", "dr21-behavior-matrix.json")
  let offlineOnly = false
  let capabilitySnapshotPath: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--offline-only") offlineOnly = true
    else if (argument === "--manifest") manifestPath = resolve(argv[(index += 1)])
    else if (argument === "--out") outPath = resolve(argv[(index += 1)])
    else if (argument === "--capability-snapshot") {
      capabilitySnapshotPath = resolve(argv[(index += 1)])
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  return { manifestPath, outPath, offlineOnly, capabilitySnapshotPath }
}

function git(...arguments_: string[]): string {
  const run = spawnSync("git", arguments_, { cwd: process.cwd(), encoding: "utf8" })
  return (run.stdout ?? "").trim()
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/")
}

/**
 * Parse the TAP stream of ONE test file. Every `ok/not ok N - name` line is an
 * observation; a file-level `not ok` (or a non-zero exit without any failing
 * test) makes every observation from that file unreliable.
 */
function parseTap(output: string): Map<string, TestObservation> {
  const observed = new Map<string, TestObservation>()
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const match = /^(not ok|ok)\s+\d+\s+-\s+(.*?)\s*$/.exec(line)
    if (!match) continue
    const name = match[2]
      .replace(/\s+#\s+(SKIP|TODO)\b.*$/i, "")
      .replace(/\\\\/g, "\\")
      .trim()
    if (!name || name.includes(".test.")) continue
    if (match[1] === "ok") {
      if (!observed.has(name)) observed.set(name, { status: "pass" })
    } else {
      observed.set(name, { status: "fail" })
    }
  }
  return observed
}

function isIoErrorFileLevel(line: string): boolean {
  return /^(not ok|ok)\s+\d+\s+-\s+.*\.test\.[cm]?[jt]sx?\s*$/.test(line)
}

/**
 * A controlled scratch cwd. The MCP child inherits only the MCP SDK's safe
 * environment list, so `dotenv/config` must find a `.env` here. Values are
 * placeholders and every endpoint is a dead local address: no external model
 * or service can be reached even if a test misroutes a call.
 */
function prepareTestCwd(repoRoot: string): { cwd: string; envFile: string } {
  const cwd = join(repoRoot, ".scratch", "dr21-run")
  mkdirSync(cwd, { recursive: true })
  const envFile = join(cwd, ".env")
  writeFileSync(
    envFile,
    [
      "OPENAI_API_KEY=dr21-offline-placeholder",
      "OPENAI_BASE_URL=http://127.0.0.1:9/v1",
      "EMBEDDING_BASE_URL=http://127.0.0.1:9/v1",
      "RERANK_BASE_URL=http://127.0.0.1:9/v1",
      "",
    ].join("\n"),
    "utf8",
  )
  return { cwd, envFile }
}

function runFile(
  file: string,
  options: { repoRoot: string; testCwd: string; testEnv: string },
): {
  observed: Map<string, TestObservation>
  run: FileRun
} {
  const started = Date.now()
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      options.testEnv,
      "--test",
      "--test-reporter=tap",
      join(options.repoRoot, file),
    ],
    { cwd: options.testCwd, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  )
  const durationMs = Date.now() - started
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  const observed = parseTap(output)
  const failed = [...observed.values()].filter((entry) => entry.status === "fail").length
  const passed = observed.size - failed
  const exitCode = typeof result.status === "number" ? result.status : null
  const fileLevelFailure = output
    .split(/\r?\n/)
    .some((line) => isIoErrorFileLevel(line) && line.trim().startsWith("not ok"))
  const note =
    result.error instanceof Error
      ? result.error.message.slice(0, 160)
      : result.signal
        ? `signal ${result.signal}`
        : fileLevelFailure
          ? "the test file failed"
          : undefined

  // A file that exits non-zero (or reports a file-level not ok) cannot lend
  // passing evidence even if it printed some green lines before crashing.
  if ((exitCode !== 0 || fileLevelFailure) && failed === 0 && observed.size > 0) {
    for (const [name] of observed) observed.set(name, { status: "fail" })
  }
  return {
    observed,
    run: {
      file,
      exitCode,
      tests: observed.size,
      passed: failed === 0 && (exitCode !== 0 || fileLevelFailure) ? 0 : passed,
      failed: failed === 0 && (exitCode !== 0 || fileLevelFailure) ? observed.size : failed,
      durationMs,
      ...(note ? { note } : {}),
    },
  }
}

function readSnapshot(path: string | null): RerankCapabilitySnapshot | null {
  if (!path) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as
      | RerankCapabilitySnapshot
      | { rerank: RerankCapabilitySnapshot }
    if (parsed && typeof parsed === "object" && "rerank" in parsed) {
      return (parsed as { rerank: RerankCapabilitySnapshot }).rerank
    }
    return parsed as RerankCapabilitySnapshot
  } catch (error) {
    throw new Error(
      `cannot read capability snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function spec(cell: ManifestCell): MatrixCellSpec {
  if (cell.source === "offline_test") {
    if (!cell.tests || cell.tests.length === 0) {
      throw new Error(`offline cell ${cell.id} names no tests`)
    }
    return {
      id: cell.id,
      group: "",
      caseKind: cell.caseKind,
      description: cell.description,
      ticket: cell.ticket,
      source: "offline_test",
      tests: cell.tests,
    } satisfies OfflineCellSpec
  }
  if (cell.source === "online") {
    if (!cell.gate) throw new Error(`online cell ${cell.id} names no gate`)
    return {
      id: cell.id,
      group: "",
      caseKind: "online",
      description: cell.description,
      ticket: cell.ticket,
      source: "online",
      gate: cell.gate,
    } satisfies OnlineCellSpec
  }
  return {
    id: cell.id,
    group: "",
    caseKind: "config",
    description: cell.description,
    ticket: cell.ticket,
    source: "capability",
    capability: cell.capability ?? "rerank",
  } satisfies CapabilityCellSpec
}

function groupSummary(cells: readonly CellResult[]): {
  status: "complete" | "incomplete"
  offlineStatus: "pass/offline" | "incomplete"
  counts: Record<string, number>
} {
  const counts: Record<string, number> = {}
  for (const cell of cells) counts[cell.status] = (counts[cell.status] ?? 0) + 1
  const offline = cells.filter((cell) => cell.source !== "online")
  const offlineStatus =
    offline.length > 0 && offline.every((cell) => cell.status === "pass/offline")
      ? "pass/offline"
      : "incomplete"
  return {
    status:
      cells.every((cell) => cell.status === "pass/offline") ? "complete" : "incomplete",
    offlineStatus,
    counts,
  }
}

function main(): void {
  const parsed = options(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(parsed.manifestPath, "utf8")) as Manifest
  const snapshot = readSnapshot(parsed.capabilitySnapshotPath)

  const allCells: MatrixCellSpec[] = []
  for (const group of manifest.groups) {
    for (const cell of group.cells) {
      allCells.push({ ...spec(cell), group: group.id })
    }
  }

  const files = [
    ...new Set(
      allCells
        .filter((cell): cell is OfflineCellSpec => cell.source === "offline_test")
        .flatMap((cell) => cell.tests.map((test) => test.file)),
    ),
  ].sort()

  const observations = new Map<string, TestObservation>()
  const fileRuns: FileRun[] = []
  const repoRoot = process.cwd()
  const testCwd = prepareTestCwd(repoRoot)
  const testEnv = pathToFileURL(join(repoRoot, "scripts", "test-env.ts")).href
  for (const file of files) {
    const outcome = runFile(normalizeFile(file), { repoRoot, testCwd: testCwd.cwd, testEnv })
    fileRuns.push(outcome.run)
    for (const [name, entry] of outcome.observed) {
      observations.set(`${normalizeFile(file)}::${name}`, entry)
    }
  }

  // Tests must be keyed the same way the manifest names them.
  for (const cell of allCells) {
    if (cell.source !== "offline_test") continue
    cell.tests = cell.tests.map((test) => ({ ...test, file: normalizeFile(test.file) }))
  }

  const results = evaluateMatrix(allCells, observations, snapshot)
  const summary = summarizeMatrix(results, { offlineOnly: parsed.offlineOnly })

  const commit = git("rev-parse", "HEAD")
  const branch = git("rev-parse", "--abbrev-ref", "HEAD")
  const dirty = git("status", "--porcelain").trim() !== ""
  const generatedAt = new Date().toISOString()
  const runIdentity = {
    commit,
    branch,
    generatedAt,
    dirty,
    evidencePath: parsed.outPath,
  }
  const withRun = (cell: CellResult) => ({ ...cell, run: runIdentity })

  const groups = manifest.groups.map((group) => {
    const cells = results.filter((cell) => cell.group === group.id).map(withRun)
    return {
      id: group.id,
      title: group.title,
      required: group.required,
      ...groupSummary(cells),
      cells,
    }
  })

  const report = {
    schema: "dr21-behavior-matrix-run",
    schemaVersion: 1,
    run: {
      ticket: "DR-21",
      generatedAt,
      commit,
      branch,
      dirty,
      node: process.version,
      platform: process.platform,
      command: process.argv.join(" "),
      offlineOnly: parsed.offlineOnly,
      evidencePath: parsed.outPath,
      manifest: parsed.manifestPath,
      capabilitySnapshot: parsed.capabilitySnapshotPath,
      testCwd: testCwd.cwd,
      controlledTestEnv: testCwd.envFile,
      testFiles: fileRuns,
    },
    gates: {
      "G-P0": "not_accepted",
      "G-RERANK-LIVE": "not_run",
    },
    rerank: {
      snapshot: snapshot ?? null,
      configurationMatch:
        snapshot === null
          ? "not_run/online: no capability snapshot in this run"
          : `${snapshot.model?.configured ?? "unknown"} vs observed ${(
              snapshot.model?.observed ?? []
            ).join(",") || "none"}`,
      onlineAcceptance: "not_run",
    },
    summary,
    groups,
    cells: results.map(withRun),
  }

  mkdirSync(dirname(parsed.outPath), { recursive: true })
  writeFileSync(parsed.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

  console.log(
    `DR-21 matrix  commit=${commit || "unknown"} branch=${branch || "unknown"} dirty=${dirty} ` +
      `node=${process.version} offline-only=${parsed.offlineOnly}`,
  )
  for (const group of groups) {
    console.log(
      `${group.id.padEnd(24)} offline=${group.offlineStatus.padEnd(12)} ` +
        `cells=${group.cells.length} ${JSON.stringify(group.counts)}`,
    )
    for (const cell of group.cells) {
      if (cell.status !== "pass/offline") {
        console.log(`  ${cell.status.padEnd(15)} ${cell.id}: ${cell.detail}`)
      }
    }
  }
  console.log(
    `summary: status=${summary.status} offlineComplete=${summary.offlineComplete} ` +
      `onlineAcceptance=${summary.onlineAcceptance} blocking=${summary.blocking.length} ` +
      `pending=${summary.pending.length}`,
  )
  console.log(`evidence: ${parsed.outPath}`)
  process.exitCode = summary.exitCode
}

try {
  main()
} catch (error) {
  console.error("DR-21 matrix failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
}
