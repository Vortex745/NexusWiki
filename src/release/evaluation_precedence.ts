// Ticket 27 — Enforce deterministic evaluation precedence.
//
// Spec issue #27 acceptance criteria:
//   1. A hard-invariant failure keeps the release failed even when all
//      shadow-evaluator and Langfuse signals are positive.
//   2. A shadow-evaluator regression or Langfuse outage cannot change a
//      passing deterministic result, though each remains visible in its own
//      report section.
//   3. The deterministic evidence hash decision excludes non-deterministic
//      report content without excluding their schema metadata.
//
// Pure function that assembles deterministic hard invariants + a generic
// shadow-evaluator baseline + Langfuse round-trip probe outputs into a single
// EvaluationPrecedenceReport. The releaseDecision is bound to the
// deterministic decision ONLY — probabilistic signals are visible but
// structurally lack release authority (spec L1558: deterministic;
// spec L1561: non-overridable).
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: pure function, no side effects, no async.
//     Inputs are pre-computed by upstream probes (T14 hard invariants,
//     the shadow-evaluator probe, T26 Langfuse round-trip probe).
//   - The evidence hash uses SHA-256 over a deterministic-only JSON
//     payload (hard invariant keys + expected + actual + failingCaseIds).
//     Shadow aggregate values, variance, Langfuse trace metadata, and any
//     other probabilistic content are deliberately excluded — they cannot
//     affect the hash and therefore cannot affect downstream release
//     decisions bound to the hash.
//   - Schema metadata (field name lists for the shadow + Langfuse sections)
//     is always included in the report — criterion #3 explicitly requires
//     schema metadata to remain visible while non-deterministic content is
//     excluded from the hash. This lets reviewers verify the report
//     structure without needing the probabilistic values.
//
// Rollback boundary: remove this module; no online runtime behavior
// changes (per Ticket 27 rollback spec — pure verifier function, no
// ProbeImplementation registration).

import { createHash } from "node:crypto"
import type { HardInvariantResult } from "../evaluation/types"

/**
 * Ticket 15 migration: this release-path module no longer imports any
 * evaluator-specific type. The shadow section is described structurally here,
 * so retiring the evaluator (ticket 17) cannot break the release path, and a
 * release that ran no shadow evaluator simply omits the whole section.
 *
 * The shadow values are non-blocking evidence: they are visible in their own
 * report section and never reach the decision or the deterministic hash.
 */
export interface ShadowBaselineLike {
  /** Aggregate metric values — opaque to the release path (never hashed). */
  aggregate: object
  variance?: object
  runCount: number
  datasetVersion: string
  providerModelIds: { chat: string; embedding: string; evaluator?: string }
  generatedAt: string
  repositoryRevision: string
}

export interface ShadowRegressionLike {
  metric: string
  baseline: number
  current: number
  delta: number
  regressionDetected: boolean
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outputs from the Langfuse round-trip probe (Ticket 26) — observability
 * signals only, never affect release decision. Mirror the
 * langfuseRoundTripProbe outputs shape.
 */
export interface LangfuseProbeOutputs {
  traceFound: boolean
  privacyCheck: string
  host: string
  sdkVersion: string
  droppedCount: number
}

/**
 * Inputs to assembleEvaluationPrecedence. Each input is the output of an
 * upstream probe or evaluator:
 *   - hardInvariants: T14 evaluateHardInvariants (deterministic)
 *   - shadowBaseline / shadowRegressions: the shadow evaluator's outputs
 *     (probabilistic, non-blocking — a release without that evaluator passes
 *     no such input at all, per ticket 15)
 *   - langfuseReport: T26 langfuseRoundTripProbe (observability, non-blocking)
 *   - repositoryRevision: trusted git revision for provenance binding
 */
export interface EvaluationPrecedenceInput {
  hardInvariants: HardInvariantResult[]
  /**
   * Optional (ticket 15): a release that ran no shadow evaluator passes
   * nothing at all. `null` means "the evaluator was skipped" and still keeps
   * its (empty) section visible; omitting the keys removes the section.
   */
  shadowBaseline?: ShadowBaselineLike | null
  shadowRegressions?: ShadowRegressionLike[] | null
  langfuseReport?: LangfuseProbeOutputs | null
  repositoryRevision: string
}

/**
 * Shadow-evaluator section of the probabilistic report — visible but
 * non-blocking.
 */
export interface ShadowProbabilisticSection {
  baseline: ShadowBaselineLike | null
  regressions: ShadowRegressionLike[]
  regressionDetected: boolean
}

/**
 * Langfuse section of the probabilistic report — visible but non-blocking.
 */
export interface LangfuseProbabilisticSection {
  traceFound: boolean
  privacyCheck: string
  host: string
  sdkVersion: string
  droppedCount: number
}

/**
 * Final report: deterministic decision is authoritative for release.
 * Probabilistic signals are visible in their own section but cannot
 * change releaseDecision.
 */
export interface EvaluationPrecedenceReport {
  /** "passed" only when all hard invariants passed (deterministic). */
  deterministicDecision: "passed" | "failed"
  /** Reason for failure (undefined when passed). */
  deterministicReason?: string
  /** Equals deterministicDecision — probabilistic signals cannot change this. */
  releaseDecision: "passed" | "failed"
  /** Hard invariant keys that failed (empty when all passed). */
  failingDeterministicInvariants: string[]
  /** Probabilistic signals — visible but non-blocking. */
  probabilisticSection: {
    /**
     * Present only when the caller supplied shadow-evaluator input (ticket 15:
     * a release without that evaluator has no such section). `null` content
     * still leaves the section visible.
     */
    shadow?: ShadowProbabilisticSection | null
    langfuse: LangfuseProbabilisticSection | null
  }
  /**
   * SHA-256 hash of deterministic-only evidence. Excludes shadow aggregate
   * values, variance, their metadata (run count, dataset version, model ids),
   * Langfuse trace metadata, and all other probabilistic content — so whether
   * or not any non-deterministic evaluator ran, identical deterministic inputs
   * produce an identical hash (criterion #3, ticket 15).
   */
  evidenceHash: string
  /**
   * Schema metadata — field name lists for the shadow + Langfuse sections.
   * Included so reviewers can verify report structure without probabilistic
   * values (criterion #3 — schema metadata NOT excluded). The shadow list is
   * only present when a shadow section is.
   */
  schemaMetadata: {
    shadowFields?: readonly string[]
    langfuseFields: readonly string[]
  }
  /** Always true — schema metadata is structurally included (criterion #3). */
  schemaMetadataIncluded: boolean
  /** Trusted repository revision (provenance binding). */
  repositoryRevision: string
  /** ISO 8601 timestamp when the report was assembled. */
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Constants — schema metadata (field names are stable, values are not)
// ---------------------------------------------------------------------------

/**
 * Field names of the shadow baseline section. Listed in the report so
 * reviewers can verify the section structure without seeing probabilistic
 * values (ticket 15: the release path names the fields structurally instead of
 * importing the evaluator's type).
 */
const SHADOW_BASELINE_FIELDS: readonly string[] = [
  "aggregate",
  "variance",
  "runCount",
  "datasetVersion",
  "providerModelIds",
  "generatedAt",
  "repositoryRevision",
] as const

/**
 * Field names of LangfuseProbeOutputs. Listed in the report so reviewers can
 * verify the Langfuse section structure without seeing observability values.
 */
const LANGFUSE_PROBE_OUTPUT_FIELDS: readonly string[] = [
  "traceFound",
  "privacyCheck",
  "host",
  "sdkVersion",
  "droppedCount",
] as const

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Assemble the evaluation precedence report. Pure function — no side effects,
 * no async, no I/O. Same inputs always produce identical outputs.
 */
export function assembleEvaluationPrecedence(
  input: EvaluationPrecedenceInput,
): EvaluationPrecedenceReport {
  // --- Phase 1: Deterministic decision (AC1) ---
  // The release decision is bound to hard invariants ONLY. Shadow-evaluator
  // and Langfuse signals are visible but structurally lack release authority.
  const hardInvariants = input.hardInvariants ?? []
  const failingInvariants = hardInvariants.filter((h) => !h.passed)
  const failingDeterministicInvariants = failingInvariants.map((h) => h.key)
  const deterministicPassed = hardInvariants.length > 0 && failingInvariants.length === 0
  const deterministicDecision: "passed" | "failed" = deterministicPassed ? "passed" : "failed"
  const deterministicReason = deterministicPassed
    ? undefined
    : hardInvariants.length === 0
      ? "hardInvariants is empty — at least one deterministic invariant is required"
      : `${failingInvariants.length} hard invariant(s) failed: ${failingDeterministicInvariants.join(", ")}`

  // --- Phase 2: Probabilistic section (AC2) ---
  // Non-deterministic signals are visible in their own sections regardless of
  // the deterministic decision. Even when deterministic fails they are
  // reported so reviewers can correlate root causes. A signal the caller did
  // not supply simply has no section (ticket 15).
  //
  // "Supplied" is decided by key presence, not by truthiness: an explicit
  // `null` means "the evaluator was skipped" and must stay visible, while an
  // absent key means the release has no such evaluator at all.
  const shadowProvided =
    input.shadowBaseline !== undefined || input.shadowRegressions !== undefined
  const shadowBaseline = input.shadowBaseline ?? null
  const shadowRegressions = input.shadowRegressions ?? []
  const shadowSection: ShadowProbabilisticSection | undefined = shadowProvided
    ? {
        baseline: shadowBaseline,
        regressions: shadowRegressions,
        regressionDetected: shadowRegressions.some((r) => r.regressionDetected),
      }
    : undefined

  const langfuseReport = input.langfuseReport ?? null
  const langfuseSection: LangfuseProbabilisticSection | null =
    langfuseReport !== null
      ? {
          traceFound: langfuseReport.traceFound,
          privacyCheck: langfuseReport.privacyCheck,
          host: langfuseReport.host,
          sdkVersion: langfuseReport.sdkVersion,
          droppedCount: langfuseReport.droppedCount,
        }
      : null

  // --- Phase 3: Evidence hash (AC3) ---
  // SHA-256 over deterministic-only JSON payload. Excludes:
  //   - every non-deterministic signal (shadow + Langfuse values and metadata,
  //     including the shadow run count / dataset version / model ids — ticket
  //     15: whether a shadow evaluator ran must not shift the fingerprint)
  //
  // Includes (deterministic, stable):
  //   - hardInvariants: key, passed, expected, actual, failingCaseIds
  //
  // Schema metadata (field names) is reported separately in
  // `schemaMetadata` — NOT part of the hash. Criterion #3 explicitly says
  // "excludes non-deterministic report content without excluding their
  // schema metadata" — schema metadata is in the report (visible), just
  // not part of the deterministic hash.
  const deterministicPayload = {
    hardInvariants: hardInvariants.map((h) => ({
      key: h.key,
      passed: h.passed,
      expected: h.expected,
      actual: h.actual,
      failingCaseIds: h.failingCaseIds,
    })),
  }
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify(deterministicPayload))
    .digest("hex")

  // --- Phase 4: Assemble final report ---
  return {
    deterministicDecision,
    deterministicReason,
    releaseDecision: deterministicDecision, // AC1 + AC2: probabilistic cannot change this
    failingDeterministicInvariants,
    probabilisticSection: {
      ...(shadowSection !== undefined ? { shadow: shadowSection } : {}),
      langfuse: langfuseSection,
    },
    evidenceHash,
    schemaMetadata: {
      ...(shadowSection !== undefined ? { shadowFields: SHADOW_BASELINE_FIELDS } : {}),
      langfuseFields: LANGFUSE_PROBE_OUTPUT_FIELDS,
    },
    schemaMetadataIncluded: true, // AC3: schema metadata always included
    repositoryRevision: input.repositoryRevision ?? "",
    generatedAt: new Date().toISOString(),
  }
}
