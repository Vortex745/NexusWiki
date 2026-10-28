# BF-01 implementation evidence

Worktree: `C:/Users/14253/.codex/bf-20261028/worktrees/bf-01`.
Branch: `codex/bf-01`. Integration: `codex/confirmed-bug-fixes`.
Issue: `../../issues/BF-01-retired-source-retrieval.md`.

The human implementation instruction confirms S1–S4. The agreed BF-01 seam is real ingestion/lifecycle/retirement followed by `SearcherImpl` with real `RuntimeSearchOperations`, isolated SQLite and controlled external storage/Elasticsearch/embedding/rerank adapters. PageIndex is also checked through its public repository methods. No interface was added for testing.

## Branch baseline and scope

- Before any edit, `git merge-base HEAD codex/confirmed-bug-fixes` and `git rev-parse codex/confirmed-bug-fixes` both returned `98846175afef3dad15005169cbb55493456eb423`; the branch was clean.
- The integration branch subsequently gained baseline documentation/evidence only. `git merge --no-edit codex/confirmed-bug-fixes` fast-forwarded this branch to `ef02c84eb26e9e6c75b1cdf045f6e4d8b0a59980`; see `integration-sync.log`. The affected tests were rerun after synchronization.
- After implementation commit `f6a43499181e348b9debed0bfda90af6a6185d8e`, the final synchronization also merged integration tip `33a21bde9e11ea6b9e363385182c1ae12a03ad81` (BF-02/BF-04) without conflicts. Merge commit `fad9d05e4e3d37eb20be8f8f32bc124ebbdacb3e` has that integration tip as its second parent. All 232 affected tests and the full TypeScript build passed again on the merged source; see `affected-tests-after-merge.tap` and `build-after-merge.log`.
- Product edits are two predicates: the existing active-version read and PageIndex's existing active-version subquery now require `lifecycle_state = 'active'`. The retained active pointer/history and async cleanup protocol remain intact.
- This adds no database statement, per-hit read, schema change, external call, dependency, background task or in-flight cancellation protocol. Existing unconfigured/evaluation behavior is unchanged.
- No original checkout writes, business database use, real provider calls, deployment or dependency changes were performed.

## Red → green record

All commands below ran in the worktree above. The red/green slice command was:

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 src/retrieval/search/searcher.retirement.test.ts
```

| Phase | State at execution | Result | Output |
| --- | --- | --- | --- |
| BM25 red | One new behavior test; both product predicates unchanged | 0 pass / 1 fail, retired document still returned after real retirement | `red-bm25.tap` |
| BM25 green | Only generic active eligibility fixed | 1 pass / 0 fail | `green-bm25.tap` |
| PageIndex red | Second behavior test added; PageIndex predicate still unchanged | 1 pass / 1 fail, retired navigation node still returned | `red-pageindex.tap` |
| PageIndex green | PageIndex predicate fixed | 2 pass / 0 fail | `green-pageindex.tap` |
| Additional behavior controls | Vector empty-set, pending/failed cleanup and scope/version controls | 5 pass / 0 fail | `green-regressions.tap` |

The slice files use Node's default test reporter despite the `.tap` extension. `affected-tests*.tap` explicitly use the TAP reporter. Reporter output has trailing whitespace normalized for Git; messages, counts and failure values are preserved. Two initial build attempts found only typing errors in the new controlled-index fixture; those were corrected and the final build passed (`build-initial.log`, `build-types.log`, `build.log`). These compile errors are not counted as the defect's red tests.

## Acceptance mapping

| Criterion | Behavioral evidence | Status |
| --- | --- | --- |
| BF-01-A1 | `BM25 and assembled parents exclude a retired source before cleanup`: both documents visible before retirement; afterwards only the live document and its real loaded parent remain. Retired pointer still exists; cleanup task is pending. | pass |
| BF-01-A2 | The same real searcher is exercised by the three-channel cleanup regression; vector child and assembled parent both belong to the live document. `vector results and parents stay hidden with an empty active set` verifies fail-closed retrieval when the only document retires. | pass |
| BF-01-A3 | `PageIndex navigation and hydrated context exclude retirement while nodes remain stored`: public navigation and runtime PageIndex-to-index hydration return only the live document and parent. Stored retired node still exists. | pass |
| BF-01-A4 | `delayed and failed cleanup cannot restore BM25, vector or PageIndex visibility`: first pass leaves all tasks pending; four real cleanup tasks then fail at the controlled storage boundary. All three channels plus public PageIndex navigation are rechecked after each failure, with retained index/node data. | pass |
| BF-01-A5 | `lifecycle filtering preserves version, tenant, group and knowledge-base exclusions`: a real superseded version, retired document, foreign tenant, disallowed group, other KB, quarantined source and pending candidate all have physical artifacts; only the current eligible version reaches results and parents. Candidate artifacts use the public chunker and PageIndex builder. Existing attachment search regressions also pass. | pass |
| BF-01-A6 | The two red runs fail on actual returned document/node identities, not SQL snapshots. The controlled ES adapter evaluates actual submitted BM25/kNN/hydration predicates and never consults lifecycle state on its own. Old child/parent data remain indexed and retired PageIndex nodes remain stored. Socket and fetch guards assert zero network attempts in all five new cases. | pass |
| BF-01-A7 | Product diff changes two predicates inside existing reads. Affected lifecycle, retirement, search, PageIndex and sync suites: 232 pass / 0 fail / 0 skipped. `npm run build`: exit 0. | pass |

No BF-01 acceptance item is left incomplete. Tests concern new searches after committed retirement, as scoped by the issue; they do not claim cancellation of already-running answers or real-service integration/performance measurements.

## Final checks

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-reporter=tap --test-concurrency=1 src/retrieval/search/searcher.retirement.test.ts src/retrieval/search/searcher.test.ts src/retrieval/search/searcher.attachments.test.ts src/retrieval/search/searcher.web.test.ts src/knowledge/source_lifecycle_store.test.ts src/knowledge/retirement.test.ts src/ingestion/tracking/page_index_repo.test.ts src/ingestion/lifecycle.test.ts src/ingestion/lifecycle.p6_1.test.ts src/ingestion/lifecycle.p6_2.test.ts src/ingestion/lifecycle.p6_3.test.ts src/ingestion/lifecycle.t52.test.ts src/sync/sync_retirement.test.ts
npm run build
git diff --cached --check
```

Outputs before the final integration merge: `affected-tests.tap` (232/232), `build.log` (exit 0). Final merged-source verification: `affected-tests-after-merge.tap` (232/232, 0 skipped), `build-after-merge.log` (exit 0), and `diff-check.log` (exit 0). The newly added regression file is explicitly included in the test command. Original sequential reproduction and inputs remain documented in `plans/022-confirmed-bug-fixes/evidence.md`; the durable new tests do not depend on temporary audit scripts.
