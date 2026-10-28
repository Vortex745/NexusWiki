Standards review — 2026-10-29

Worktree: C:/Users/14253/.codex/worktrees/confirmed-bug-fixes/Agentic RAG; branch: codex/confirmed-bug-fixes.
Fixed point: 57dbc29459adac5ef737556a1542c9be5e707f0c. Reviewed HEAD: d3cf4b8949cd2ca98581dba198ff2c426e8c4094.
Diff: `git diff 57dbc29459adac5ef737556a1542c9be5e707f0c...HEAD`.

Reviewed only newly introduced changes. Standards sources: applicable ancestor/root AGENTS.md, HINTS.md and docs/agents/issue-tracker.md; HANDOFF.md, MEMORY.md and approved BF-01–05 sources supplied context. No additional applicable CODING_STANDARDS.md or CONTRIBUTING.md was found. Repository rules override smell heuristics; tooling-enforced checks were excluded.

Documented-standard violations: **0**.

1. **[P3, heuristic judgment] Possible Duplicated Code.** `src/ingestion/parser/docreader_pdf_fences.test.ts:10–43` and `src/ingestion/parser/docreader_pdf_tables.test.ts:8–36` introduce substantially identical `parser()` factories. Both repeat `address: "fake-docreader"`, `timeoutMs: 1_000`, input/output limits, and `clientFactory: () => ({` with `async *readStream()` yielding `markdown_content: markdown`. Only source-block construction differs. Future changes to the controlled DocReader frame/configuration must be maintained twice. Optional improvement: share the reusable fake-client setup in a test fixture while preserving each suite's explicit source-block values and behavioral assertions. This is a maintenance judgment, not a documented-rule breach or production defect. A shared fixture would have multiple callers and therefore would not conflict with AGENTS.md rule 12 against premature single-use helpers.

**Exact count: 1 finding — 0 hard violations, 1 non-blocking heuristic judgment.** No other baseline smells identified. No implementation or tracker edits; no tests/builds rerun. The parent's running regression/build is outside this review's result.
