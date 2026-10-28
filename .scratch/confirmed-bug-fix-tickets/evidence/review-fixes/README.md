# Review finding closure — 2026-10-29

Worktree: `C:/Users/14253/.codex/bf-20261028/worktrees/review-fixes`
Branch: `codex/bf-review-fixes`
Base/integration tip: `d3cf4b8949cd2ca98581dba198ff2c426e8c4094` (`codex/confirmed-bug-fixes`).
The requested worktree was already provisioned and clean at this commit. Verified
`git merge-base --is-ancestor codex/confirmed-bug-fixes HEAD` (exit 0).
`git merge --no-edit codex/confirmed-bug-fixes` succeeded: already up to date.

Read the integration worktree's `evidence/review/standards.md` (one P3 heuristic
duplicated-code finding) and `evidence/review/spec.md` (zero findings), plus
`C:/Users/14253/.agents/skills/code-review/SKILL.md` and the neighboring TDD skill.
This is the review-stage refactor described by those skills; existing public
tests remain the verification seam, with no new implementation-mirroring tests.

The single finding is closed by sharing `createFakeDocReaderParser` in
`src/ingestion/parser/docreader_pdf.test.fixtures.ts`. Both regression suites
reuse its existing fake client, one metadata frame, limits, timeout, and no-op
close. The fences suite retains its bbox default and custom Unicode/page source
blocks; the tables suite retains its page-only source block. Both still use
code-point lengths. All test bodies and behavioral assertions are unchanged.
The fixture name does not match the standalone `*.test.ts` test glob.

Changed source paths:

- `src/ingestion/parser/docreader_pdf_fences.test.ts`
- `src/ingestion/parser/docreader_pdf_tables.test.ts`
- `src/ingestion/parser/docreader_pdf.test.fixtures.ts`

Validation (all commands run in this worktree):

- Before refactor: `npm run test:docreader` — exit 0; 47 passed, 0 failed,
  cancelled, skipped, or todo; duration 11646.5628 ms (`docreader-before.log`).
- After refactor: `npm run test:docreader` — exit 0; 47 passed, 0 failed,
  cancelled, skipped, or todo; duration 11233.6479 ms (`docreader-after.log`).
- `npm run build` — exit 0; TypeScript compilation and proto-copy postbuild
  succeeded (`build.log`).
- `git diff --check` — exit 0, no output.

No production source, API, parser behavior, dependencies, or test seams changed.
Tests use controlled services and in-memory SQLite; no real provider or business
database was accessed. Full regression, tracker/docs, and the actual integration
merge remain with the parent. The original checkout was not modified.
