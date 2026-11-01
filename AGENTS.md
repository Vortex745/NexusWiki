# Project Guide

- Start with `README.md`, `package.json`, and `.env.example` for setup, commands, and configuration. If this checkout contains a local `HANDOFF.md`, read it before starting work.
- Runtime entry points: `src/index.ts` (backend), `frontend/src/main.tsx` (web), and `src/ingestion/cli.ts` (ingestion). Shared conversation state lives in `src/frontend/`; React adapters live in `frontend/src/`.
- Build with `npm run build` and `npm run build:web`; check frontend types with `npm run typecheck:web`. Docker setup and optional observability are documented in `README.md`.
- When `.codegraph/` exists, use its index to locate code before text searches. Otherwise use normal file and text search.
- The public checkout contains runtime/build inputs and this guide plus `README.md`. Tests, fixtures, tickets, local handoffs, reports, browser profiles, and runtime data remain local. Do not reintroduce commands that depend on excluded files.
- `.gitignore` defines the public file boundary. Keep `.env.example` free of real credentials. Never force-add ignored environment files, databases, signing keys, browser profiles, or logs. Check staged filenames and content before committing.
- Preserve runtime compatibility and promotion checks. Some source modules intentionally remain dormant; do not delete or reconnect them just because they have no active caller. If local contract tests exist, consult `src/frontend/app.contract.test.ts` and `src/release/dormant_surface_audit.test.ts` before changing those boundaries.
- Keep secrets out of logs and responses. External providers, paid evaluations, migrations, resets, and production deployment require the corresponding task authorization; use isolated local data for verification.
