# BF-02 implementation evidence

Date: 2026-10-28. Ticket: `issues/BF-02-run-history-ownership.md` in the parent tracker. Worktree: `C:/Users/14253/.codex/bf-20261028/worktrees/bf-02`; branch: `codex/bf-02`.

## Change

The public run-history GET checks the trace's session against the authenticated tenant and subject in the existing conversation directory. The directory store exposes its existing ownership predicate independently of its optional assistant/knowledge lock, and existing directory assertions reuse that predicate. Unknown, foreign and orphaned runs return the literal existing `{ "error": "Answer run not found" }` with HTTP 404. Without an ownership store the router also refuses the read. The trace repository remains an unchanged trusted internal interface.

Production already injects the conversation history store into the chat router; no new server wiring or interface adapter was needed. Existing chat/transport fixtures now persist real owner directories instead of expecting an unowned trace to be publicly readable. Their pre-existing validation counters delegate to a real SQLite directory store. No branch truncation logic was changed.

## TDD record and commands

Every command ran in the assigned worktree. Tests use Node v26.8.1, isolated in-memory SQLite, synthetic identities/content and real HTTP on an ephemeral loopback port. The real access middleware processes a synthetic external identity adapter. No provider, business database, dependency, deployment, original checkout or shared tracker state was changed.

1. Before implementation:

   `node --import tsx --import ./scripts/test-env.ts --test --test-reporter=tap src/api/chat.run_history_ownership.test.ts`

   Exit 1, **0 passed / 1 failed**; cross-tenant request returned 200 instead of 404. Log: `red-cross-tenant.tap`.

2. After the minimal ownership guard, the same command passed **1/1**. Log: `green-cross-tenant.tap`.

3. Added the locked-owner control through the same HTTP seam: **2/2**. Log: `green-owner.tap`.

4. Added the unlocked-owner control: **3/3**. Log: `green-unlocked-owner.tap`.

5. Same HTTP command with all authorization controls: **9/9**, exit 0. Log: `green-http.tap`.

6. Affected regression command:

   `node --import tsx --import ./scripts/test-env.ts --test --test-reporter=tap --test-concurrency=4 src/api/chat.test.ts src/api/chat.transport.test.ts src/api/chat.session_binder.test.ts src/api/chat.conversation_scope.test.ts src/api/chat.run_history_ownership.test.ts src/answer/conversation_history.test.ts src/answer/conversation_store.test.ts src/answer/trace_repository.test.ts`

   Before correcting old unowned fixtures: **79 passed / 4 failed**, exit 1 (`related-before-fixtures.tap`). All four failures were expected history reads whose fixture had no real owner directory. After binding those fixtures: **83/83 passed**, 0 failed/skipped, exit 0 (`related-green.tap`). Authorization was preserved.

7. `npm run build`: exit 0 (TypeScript compile and DocReader proto postbuild). Final log: `build.log`.

8. `git diff --check`: exit 0.

## Acceptance mapping

| Acceptance | Behavioral evidence | Result |
| --- | --- | --- |
| BF-02-A1 | HTTP test “the owner restores the complete ordered events of a locked session”; exact response includes progress and terminal answer | pass |
| BF-02-A2 | HTTP test “another subject in the same tenant receives the same not-found response”; exact 404 error body contains no private event/reply | pass |
| BF-02-A3 | Cross-tenant denial, including same subject identifier across tenants; literal not-found body matches unknown-run body | pass |
| BF-02-A4 | Unknown and orphan traces return the same 404; missing identity returns existing 401; authenticated owner without chat scope returns existing 403 | pass |
| BF-02-A5 | Unlocked owner gets exact full history with 200; forged owner query fields and identity headers do not authorize a foreign user | pass |
| BF-02-A6 | Existing JSON/SSE/history and approved-answer-basis/frontend-consumption transport regressions; unchanged real trace repository tests | pass |
| BF-02-A7 | Initial cross-tenant red then green; dedicated HTTP 9/9; related history/chat/trace 83/83; all data synthetic | pass |

All seven ticket acceptance criteria are covered; none is incomplete. This evidence reports local offline verification, not a deployment or live-provider result. Integration-tip synchronization is recorded separately after the implementation commit.
