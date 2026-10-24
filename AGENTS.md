# Session Navigation

- **Start here**: `HINTS.md` — environment variables, common commands, runtime conventions, repository navigation.
- **Current ticket state**: `.scratch/upload-integrity-tickets/README.md` (untracked scratch; UT-series work). Retro guardrail tickets: `.scratch/retro-guardrails/README.md`.
- **Pipeline repair tickets**: `.scratch/pipeline-contract-repair-tickets/README.md` (PT-01–10; ready-for-agent / not_started). `plans/006-pipeline-contract-repairs/` is the source specification, not a second execution queue.
- **Logging / OTel execution tickets**: `.scratch/logging-observability-tickets/README.md` (LO-01–20; ready-for-agent / not_started). Dependencies, coverage and G-COMPAT live in `final-ticket-plan.json`; initial frontier is LO-01/02/03. `plans/018-logging-observability/` retains the LG-01–09 parent specifications, not a second execution queue. Ticket publication does not start implementation.
- **DeepEval / Agent repair tickets**: `.scratch/deepeval-agent-repair-tickets/README.md` (DR-01–24; ready-for-agent / not_started). `final-ticket-plan.json` owns execution dependencies, coverage and G-P0 / G-RERANK-LIVE; initial frontier DR-01/02. `plans/019-deepeval-agent-repairs/` and the approved draft remain source references, not a second execution queue. Publication does not start implementation or online evaluation.
- **Contract assertions live in tests**: dependency contracts in `src/frontend/app.contract.test.ts`; dormant-surface policy (deliberately unwired modules) in `src/release/dormant_surface_audit.test.ts`. Check both before deleting anything.
- The old knowledge-graph MCP tooling was decommissioned (server config removed); explore with Grep/Glob/Read or `npm run check:dead`.
