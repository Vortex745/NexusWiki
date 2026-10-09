# Full-suite fixture alignment and observed semantic limit

Alignment commit `9645600` was merged into integration. Root full regression had ten failing leaf tests: four PDF complex-content replay tests, three stale frontend progress wording assertions, three ES live integration tests. This follow-up owns the first seven only; root handles ES.

The corpus adapter was emitting v1 independent observations while declaring v2. It now scripts the authored semantic pair as an explicit deterministic joint Choice. This fixture distribution is not presented as a measured provider joint probability, and original corpus probability/confidence remain in their original records. The regression verifies that low original marginal numbers do not get repackaged as joint model confidence. Production v2 validation remains unchanged.

Frontend assertions now reflect the preexisting aggregate page wording and service guidance, retaining exact underlying page reason codes. No product UI implementation changed.

Verification: all **46 corpus and frontend tests passed**, zero skip/failure (`corpus-frontend-regression.log`), using `PYTHON_COMMAND=E:/miniconda3/python.exe`; backend build passed (`build-fixture-alignment.log`). Initial worktree checkout had Git text conversion in two intentionally damaged textual PDFs (755 vs original 730 bytes, 136 vs 132). Exact HEAD blob bytes were restored only in this worker checkout for validation. Those two files were never staged. `.gitattributes` could prevent future PDF checkout conversion; root owns deciding that configuration.

## Semantic limitation: preserve default off

Root actual v2 three-round evaluation records `partially-rasterized` as local pass/completed on every round, choosing `pass_no_issue=0.3649` vs `fail_missing_content=0.3266`, joint confidence `0.164`. No probability threshold is permitted to overturn the actual Choice.

Independent page image inspection clearly reads the omitted raster line: `混排页第三行：这一行只存在于图像里，校验词 缺-3。`. The builtin parser's actual raw extraction contains only the first two text-layer lines and caption `图 1：上方插图在文本层里没有对应物。`; the raster line is missing.

Current v2 prompt already directs visible words/digits/units within embedded images and says captions/nonempty text layers do not establish coverage. A separate unchanged-production one-page probe hit a fetch transport fault with no HTTP status; its nonreusable diagnostic and zero downstream writes are captured in `partial-single-production.json`. That failed probe is no semantic evidence. Root's three successful-request rounds remain the relevant false-acceptance evidence.

Recommendation: preserve `PDF_OCR_FALLBACK_ENABLED=false` and report the critical semantic miss. Do not tune a prompt post hoc to this benchmark, lower probability thresholds, retry until pass, or claim automatic activation readiness. Software protocol repairs are verified; semantic model acceptance criterion remains unmet.
