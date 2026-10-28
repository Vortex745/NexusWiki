# BF-03 implementation evidence

Date: 2026-10-29 (Asia/Shanghai). Ticket: `issues/BF-03-branch-pending-clarification.md` in the parent tracker. Worktree: `C:/Users/14253/.codex/bf-20261028/worktrees/bf-03`; branch: `codex/bf-03`.

## Change

The existing successful branch-truncation transaction now deletes the actual `pending_clarification` conversation turns for the selected session and tenant. This is one additional scoped SQL statement, six source lines. The existing legacy pending-table deletion remains. The ownership predicate, anchor lookup/no-op, inclusive/exclusive cutoff, validated/history deletion counts and rolling-summary invalidation are unchanged. BF-02 behavior was retained.

## Testing boundary

The primary S3 regression makes real HTTP requests through createApp, the real session binder, event adapter, RouterImpl, route dispatcher, direct/ambiguous runner and memory adapter. Isolated in-memory SQLite stores the actual pending and display history. Only the external identity/classification/generation adapters are synthetic. The dispatcher effective message is observed in the external classification payload and direct generation input; public conversation history independently shows the removed branch.

The HTTP owner uses the legitimate deterministic default/local identity so the bare app's conversation-read fallback and authenticated chat identity refer to the same directory. Other subject and tenant identities are authenticated by the real access middleware, and the real binder refuses their truncation requests. Store controls additionally exercise the same session identifier in another tenant and another session in the same tenant.

The first test-fixture attempt used a custom chat identity without a corresponding bare conversation-read identity and stopped at a 404 in its setup. That fixture was corrected before changing production code. The persisted red below is the genuine stale-pending failure after the old branch was visibly removed.

All commands ran in the assigned worktree. No real provider, business database, dependency, deployment, original checkout, shared tracker state or HANDOFF was changed. The SQLite rollback test uses an isolated trigger only to inject a failure, then checks recovery through public store methods.

## Commands and results

1. Before the production fix:

   `node --import tsx --import ./scripts/test-env.ts --test --test-reporter=tap src/api/chat.branch_pending.test.ts`

   Exit 1; **0 passed / 1 failed**. Actual effective input: `旧问题：帮我查退款 新问题：介绍产品`; expected: `新问题：介绍产品`. Log: `red-edit.tap`.

2. The same command after the six-line fix: exit 0, **1/1 passed** (`green-edit.tap`). Added HTTP controls: **5/5 passed** (`green-http.tap`).

3. `node --import tsx --import ./scripts/test-env.ts --test --test-reporter=tap src/answer/conversation_history.pending.test.ts`

   Exit 0, **6/6 passed** (`green-store.tap`).

4. Related regression command:

   `node --import tsx --import ./scripts/test-env.ts --test --test-reporter=tap --test-concurrency=4 src/api/chat.branch_pending.test.ts src/answer/conversation_history.pending.test.ts src/api/chat.conversation_scope.test.ts src/answer/conversation_history.test.ts src/answer/conversation_store.test.ts src/mastra/route_dispatch_runner.test.ts src/api/chat.run_history_ownership.test.ts`

   Exit 0, **88/88 passed**, 0 failed/skipped (`related-green.tap`). This includes the 11 new BF-03 controls and the completed BF-02 authenticated ownership regressions.

5. `npm run build`: exit 0 (TypeScript compile and DocReader proto postbuild), captured in `build.log`.

6. `git diff --check`: exit 0. TAP diagnostic trailing whitespace is normalized for committing evidence; test values and outcomes are unchanged.

## Acceptance mapping

| Acceptance | Behavioral evidence | Result |
| --- | --- | --- |
| BF-03-A1 | Editing HTTP regression removes old display rows; real classification and answer-generation inputs contain only the new request | pass |
| BF-03-A2 | Regeneration HTTP regression classifies the original question once, returns clarification_required and displays only the replacement run | pass |
| BF-03-A3 | Other subject/tenant HTTP requests remain refused; owner subsequently continues the unchanged pending. Store control preserves another session and same-id other-tenant pending | pass |
| BF-03-A4 | Both unknown-anchor modes return zero counts with exact validated/displayed/pending/summary snapshots unchanged | pass |
| BF-03-A5 | From/after controls retain the expected anchor rows, exact validated/history counts and summary invalidation; pending deletion is not added to counts | pass |
| BF-03-A6 | Normal HTTP continuation merges the original pending and supplement. A pending-delete database failure rolls back validated/history deletion and summary invalidation in the same transaction | pass |
| BF-03-A7 | Genuine specified-message red before fix, green after fix, and 88/88 related regressions | pass |

All seven acceptance criteria are covered; none is incomplete. Parent owns aggregate suites and final review.
