/**
 * P3.1 — Critic verdict schema and version pin.
 *
 * ValidatorImpl validates provider output against this versioned boundary.
 *
 * Versioning contract:
 *   - `CRITIC_VERDICT_SCHEMA_VERSION` is the current write version. The
 *     classifier explicitly supports v1 and v2; other versions are rejected.
 *   - Future schema changes MUST bump this constant and add a new
 *     `CriticVerdictSchemaV<n>` alongside the legacy schema, so P3.2 can
 *     dispatch by version without silent drift.
 *
 * Strictness contract (matches audit issue 04 acceptance criteria):
 *   - Required fields: `schemaVersion`, `passed`, `hallucination`,
 *     `completeness`. Missing any → `missing_required_field`.
 *   - Booleans are strict `boolean` (no string-form `"true"`/`"false"`,
 *     no `0`/`1`). Wrong type → `wrong_type`.
 *   - `missingGap` is optional; when present it MUST be `string | null`.
 *     Matches the ValidatorImpl LLM prompt
 *     (`"missingGap": string | null`) and the existing replanner semantics
 *     (`!verdict.missingGap` treats `null`/`undefined`/`""` as "no gap").
 *   - `suggestion` is optional; when present it MUST match the `Query`
 *     shape. `suggestion` is currently unused by production callers
 *     (replanner consumes `missingGap`), but it is part of the existing
 *     `CriticVerdict` type and is retained for forward compatibility.
 *   - Unknown top-level fields are rejected (`extra_dangerous_field`) so
 *     an attacker or model drift cannot smuggle fields past the boundary.
 *
 * Boundary: owned by `src/critic/schema/*`. MUST NOT import `src/api/*` or
 * `src/mastra/*` (dependency direction: Types -> ... -> Runtime -> UI).
 */

import { z } from "zod"

/**
 * Current write version. The v1 schema keeps its own literal pin.
 */
export const CRITIC_VERDICT_SCHEMA_VERSION = 2 as const

/**
 * Zod schema for the `Query`-shaped `suggestion` field. Mirrors the
 * `Query` type in `src/types/retrieval.ts` (duplicated here to avoid a
 * circular type import and to keep the schema module self-contained).
 * The two definitions are structurally identical.
 */
const QuerySchema = z.object({
  text: z.string(),
  subQueries: z.array(z.string()).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  coverageCriteria: z.array(z.string()).optional(),
})

/**
 * Zod schema for Critic verdict v1.
 *
 * `.strict()` rejects unknown top-level keys (extra dangerous fields).
 * Booleans use `z.boolean()` (not `z.coerce.boolean()`) so string-form
 * `"true"`/`"false"` and numeric `0`/`1` are rejected, not coerced.
 */
export const CriticVerdictSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    passed: z.boolean(),
    hallucination: z.boolean(),
    completeness: z.boolean(),
    missingGap: z.union([z.string(), z.null()]).optional(),
    suggestion: QuerySchema.optional(),
  })
  .strict()

const AnswerBasisSchema = z.object({
  text: z.string().trim().min(1).max(240),
  referenceIds: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
}).strict()

/** A malformed optional summary is discarded locally; base verdict checks stay strict. */
export const CriticVerdictSchemaV2 = CriticVerdictSchemaV1.extend({
  schemaVersion: z.literal(2),
  answerBasis: AnswerBasisSchema.optional().catch(undefined),
})

/**
 * The validated Critic verdict shape. This is the type P3.2 will require
 * `ValidatorImpl` to emit before its output reaches the replanner or any
 * publish decision.
 *
 * It extends the existing `CriticVerdict` (src/types/agent.ts) with a
 * required `schemaVersion` field; the two are intentionally distinct so
 * P3.1 can define the target without breaking current production callers
 * that consume the unversioned `CriticVerdict`.
 */
export type VersionedCriticVerdict =
  | z.infer<typeof CriticVerdictSchemaV1>
  | z.infer<typeof CriticVerdictSchemaV2>

/**
 * Maximum accepted raw response size in bytes (UTF-8). A Critic verdict is
 * a small structured JSON object; anything larger indicates model drift or
 * a DoS attempt. P3.2's enforcement layer rejects oversized payloads
 * before JSON parsing using this constant.
 *
 * 8 KiB is generous for the current schema (typical verdict < 200 bytes)
 * while bounding the parse cost.
 */
export const CRITIC_VERDICT_MAX_BYTES = 8 * 1024
