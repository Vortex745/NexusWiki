/**
 * DR-23 — operator-run latency measurement command.
 *
 * Usage:
 *   npm run eval:latency -- [--base-url http://localhost:3001] \
 *       [--runs-root .tmp/latency-runs] [--timeout-ms 120000] \
 *       [--json-out path]
 *
 * The command always executes the fixed plan: one complete twenty-case warmup
 * (recorded and excluded), five complete twenty-case rounds at single
 * concurrency (100 samples), and a separate concurrent-3 pass. It calls the
 * real Chat HTTP endpoint, stores every sample before deriving statistics, and
 * never invokes a judge. It does not claim the real-provider p95 target; that
 * online acceptance belongs to DR-24.
 *
 * Exit codes: 0 gate passed, 1 gate failed/incomplete, 2 invalid usage or the
 * run could not start/write.
 */

import "dotenv/config"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  DEFAULT_TIMEOUT_MS,
  runLatencySuite,
  type LatencyGroupStats,
} from "../src/evaluation/latency_sampling"

function usage(): void {
  console.log(
    [
      "Usage: npm run eval:latency -- [options]",
      "",
      "  --base-url <url>     running Chat HTTP service (default: NEXUSRAG_BASE_URL or http://localhost:3001)",
      "  --runs-root <dir>    durable latency run directory (default: .tmp/latency-runs)",
      "  --timeout-ms <n>     per-request timeout in integer milliseconds (default: 120000)",
      "  --password <value>   demo password (default: DEMO_OIDC_PASSWORD)",
      "  --json-out <path>    also write the full report JSON here",
      "",
      "Fixed plan: 20 warmup samples excluded, 100 single-concurrency measured",
      "samples, and 20 separate concurrent-3 samples. No judge is invoked.",
    ].join("\n")
  )
}

interface Options {
  baseUrl: string
  runsRoot: string
  timeoutMs: number
  password?: string
  jsonOut?: string
}

function parseArgs(argv: string[]): Options | "help" | null {
  const options: Options = {
    baseUrl: (process.env.NEXUSRAG_BASE_URL || "http://localhost:3001").replace(
      /\/+$/,
      ""
    ),
    runsRoot: resolve(".tmp", "latency-runs"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return "help"
    if (arg === "--base-url") {
      const value = argv[index + 1]
      if (!value) {
        console.error("--base-url needs a value")
        process.exitCode = 2
        return null
      }
      options.baseUrl = value.replace(/\/+$/, "")
      index += 1
      continue
    }
    if (arg === "--runs-root") {
      const value = argv[index + 1]
      if (!value) {
        console.error("--runs-root needs a value")
        process.exitCode = 2
        return null
      }
      options.runsRoot = resolve(value)
      index += 1
      continue
    }
    if (arg === "--timeout-ms") {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value <= 0) {
        console.error("--timeout-ms needs a positive integer")
        process.exitCode = 2
        return null
      }
      options.timeoutMs = value
      index += 1
      continue
    }
    if (arg === "--password") {
      const value = argv[index + 1]
      if (!value) {
        console.error("--password needs a value")
        process.exitCode = 2
        return null
      }
      options.password = value
      index += 1
      continue
    }
    if (arg === "--json-out") {
      const value = argv[index + 1]
      if (!value) {
        console.error("--json-out needs a path")
        process.exitCode = 2
        return null
      }
      options.jsonOut = resolve(value)
      index += 1
      continue
    }
    console.error(`unknown argument: ${arg}`)
    process.exitCode = 2
    return null
  }
  return options
}

function summarize(stats: LatencyGroupStats) {
  return {
    denominator: stats.denominator,
    recorded: stats.recorded,
    n: stats.n,
    errors: stats.errors,
    p50_ms: stats.p50Ms,
    p95_ms: stats.p95Ms,
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  if (options === "help") {
    usage()
    return 0
  }
  if (!options) return 2

  const outcome = await runLatencySuite({
    baseUrl: options.baseUrl,
    runsRoot: options.runsRoot,
    timeoutMs: options.timeoutMs,
    ...(options.password ? { password: options.password } : {}),
  })

  if (!outcome.report) {
    console.error(`[latency-eval] could not run: ${outcome.error ?? "unknown error"}`)
    return 2
  }
  const report = outcome.report
  const summary = {
    ticket: "DR-23",
    exit_code: outcome.exitCode,
    run_id: outcome.runId,
    run_dir: outcome.runDir,
    gate: report.gate,
    counts: report.counts,
    groups: {
      single: {
        faq_direct: summarize(report.groups.single.faq_direct),
        non_faq_knowledge: summarize(report.groups.single.non_faq_knowledge),
        other: summarize(report.groups.single.other),
      },
      concurrent3: {
        faq_direct: summarize(report.groups.concurrent3.faq_direct),
        non_faq_knowledge: summarize(report.groups.concurrent3.non_faq_knowledge),
        other: summarize(report.groups.concurrent3.other),
      },
    },
    judge: report.judge,
    limits: report.limits,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (options.jsonOut) {
    writeFileSync(options.jsonOut, JSON.stringify(report, null, 2), "utf8")
  }
  return outcome.exitCode
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(
      "[latency-eval] failed:",
      error instanceof Error ? error.message : String(error)
    )
    process.exitCode = 2
  })
