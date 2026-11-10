---
name: verify-ingestion-retirement
description: "Check retirement while ingestion is pending or running. Use when changing IngestionLifecycle.runNext, TrackedStageExecution, TaskRepo.claimNext, DocumentRepo.activate, RetirementServiceImpl.retire, ArtifactCleanupService, or active-version filtering."
---

# Verify ingestion retirement

Run this check before and after changes to the covered code. Exit zero means the repaired model and real-code probe pass. The baseline code must fail.

## Run the check

Use Node 24 for the installed better-sqlite3 binding. Confirm that Java is available. The current workspace uses this bundled Node runtime.

```powershell
$env:PATH = 'C:\Users\14253\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
& '.\.agents\skills\verify-ingestion-retirement\run.ps1'
```

A nonzero exit is a failure. A successful run reports exhaustive model completion, four rejected baseline-model variants, and seven passing real-code scenarios. The script rejects a missing completion count and a Node version outside 24.

Run the script in the same PowerShell process as the PATH assignment. On another machine, locate Node 24 through the workspace dependency tool and use its containing directory.

The script uses Java and pinned tla2tools 1.7.4, which contains TLC 2.19. It checks SHA-256 `936A262061C914694DFD669A543BE24573C45D5AA0FF20A8B96B23D01E050E88`. Set `TLA2TOOLS` to an existing jar or use the script's `%LOCALAPPDATA%\nexuswiki-verify\` cache. Missing jars download from the pinned GitHub release, then the versioned Maven artifact. Generated configs are UTF-8 without a BOM so both Windows PowerShell 5.1 and PowerShell 7 can run them. Logs and TLC state directories use `%TEMP%\ingestion-retirement-*`.

## Interpret the result

The invariants protect these promises.

| Invariant | Promise and consequence of a violation |
| --- | --- |
| `TypeOK` | Every modeled value belongs to its stated finite domain. A violation invalidates the model result. |
| `CleanupOnlyAfterRetire` | Cleanup removes artifacts only after source retirement. Otherwise an active document loses evidence. |
| `CompletedOnlyAfterStages` | A completed document has finished all four stages. Otherwise completion can expose an unindexed document. |
| `NoCompleteAfterRetire` | Ingestion never completes after retirement commits. Otherwise a retired import reports success and rewrites completion facts. |
| `NoActivateAfterRetire` | Repository activation never accepts a retired source. Otherwise its active pointer can change after retirement. |
| `NoWriteAfterCleanup` | No artifact write follows cleanup, and every cleaned artifact remains cleaned. Otherwise deleted data returns after cleanup reports success. |
| `CleanupDoesNotOvertakeWrite` | Cleanup cannot be claimed or finished while an ingestion operation is outstanding. Otherwise deletion can race a non-cooperative write. |

A write already in flight may finish after retirement. The running ingest task remains the cleanup barrier until that operation settles. Stage return rejects retirement, the run terminates without retry, and cleanup can then drain all four operations.

Read every TLC result with the **statechart** skill. Its native Windows runner currently fails with `spawn /bin/sh ENOENT`. Raw TLC logs remain available. Do not treat that diagram failure as a model failure or a completed diagram report.

The repaired model passes with 8,728 generated states, 2,999 distinct states, and depth 33 on 2026-11-10. The integrated-branch run on 2026-11-11 reproduced the generated and distinct counts. The complete queue is empty. This is a safety check over the model, not a proof about all application executions.

The baseline model fails each property in a separate TLC run. Its shortest paths describe these defects.

- `NoCompleteAfterRetire` fails at state 17. Submit, claim, finish all four stages, retire, then complete.
- `NoActivateAfterRetire` fails at state 4. Submit, retire, then call repository activation.
- `NoWriteAfterCleanup` fails at state 8. Submit, claim, start an operation, retire, claim cleanup, finish cleanup, then finish the operation.
- `CleanupDoesNotOvertakeWrite` fails at state 6. Submit, claim, start an operation, retire, then claim cleanup.

`findings.cfg` is a broken-model negative control. It is never the success definition. The wrapper runs one invariant per negative-control config, which keeps each shortest counterexample readable and avoids TLC's failing `-continue` path on this model.

## Replay the code

The probe uses in-memory SQLite and controlled stage and cleanup operations. It makes no provider or production-service requests. It exercises normal completion, retirement before claim, retirement before stages, an outstanding storage write, retirement after all stages, a transient error after retirement, and direct repository activation.

Every retired run remains failed, has no retry scheduled, and never activates. The four cleanup operations run after outstanding work settles. Repeated retirement queues no duplicate cleanup. Active-version filtering continues to hide retired sources.

The real-code oracle was exercised against baseline source and five individually broken repairs. Every variant exited 1, then the source files were restored byte-for-byte.

| Broken code | Observed failure |
| --- | --- |
| Baseline source | `retired ingestion cannot complete` |
| Cleanup claim predicate removed | `cleanup must wait for the outstanding execution` |
| Final transaction check removed | `retired ingestion cannot complete` |
| Activation lifecycle predicate removed | `repository activation rejects a retired source` |
| Initial runner check removed | `pending retired ingest never enters the runner` |
| Retirement retry override removed | The transient error leaves the task pending instead of failed. |

## Coverage and synchronization

The verified repair is committed on `codex/explicit-state-machines`, based on `748c73350d156f46fea90cc986b1e04d92534557`. `evidence/source-snapshot.json` records SHA-256 hashes of the verified implementation, model, probe, runner, and this skill. Compare a checkout against that snapshot before reusing the evidence.

| Code | Modeled boundary |
| --- | --- |
| `src/ingestion/lifecycle.ts`, `submit`, `TrackedStageExecution`, `runNext`, `retry` | Submit, start and finish a stage operation, accept its return, final transaction, terminal failure, retry. |
| `src/ingestion/tracking/task_repo.ts`, `claimNext`, `recordFailure`, `finalize` | Ingest claim, cleanup eligibility, terminal settlement. |
| `src/ingestion/tracking/doc_repo.ts`, `activate` | Direct activation and activation inside finalization. |
| `src/knowledge/retirement.ts`, `retire`, cleanup enqueue | Terminal source retirement and four idempotent cleanup tasks. |
| `src/knowledge/cleanup.ts`, `ArtifactCleanupService.run` | Each successful cleanup call removes its document artifacts. |
| `src/ingestion/tracking/active_version_repo.ts`, `getActiveDocIds` | Real-code retrieval isolation only. |

The model has one source, one document, one ingestion task, four ordered stages, and four cleanup operations. It splits asynchronous stage calls and cleanup calls into start and finish actions. It permits all four cleanups to overlap, which is broader than the default worker concurrency of two. It models the successful removal effect of each cleanup adapter.

The model omits these behaviors.

- Cancellation or stale recovery combined with an outstanding non-cooperative external write. Those paths can revoke task status or execution identity before the call settles. This retirement repair does not prove their cleanup ordering.
- Multiple processes, multiple documents or versions, reprocessing, source quarantine, retry counts, dead letters, service timeouts, detached background writes, and external-store transaction internals.
- Liveness or eventual provider response. The real-code probe verifies that all four cleanups drain when its controlled operations finish.
- Sync, Wiki, attachment, authentication, conversation, evaluation, FAQ, and handoff lifecycles.

Existing lifecycle, executor-fencing, and version tests retain cancellation, recovery, tenant, and version behavior. Their passing result does not extend the formal model's scope.

## Update after code changes

1. Compare the changed code with each corresponding action before editing the model.
2. Run the check. Treat a repaired-model invariant violation or real-code assertion as a regression until the trace proves a modeling error.
3. Reproduce a suspected violation against the real boundary. Do not weaken an invariant to remove a finding.
4. Run a temporary broken code variant. Confirm a nonzero result, restore the source, and confirm a passing result.
5. Refresh the content snapshot. Advance the sync commit only after confirming the model and probe describe that actual committed code.

Use `/maintain-formal-verification-skill` for changes merged without this check.
