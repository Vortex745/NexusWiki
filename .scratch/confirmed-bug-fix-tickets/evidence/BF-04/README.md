# BF-04 verification

Date: 2026-10-28. Branch: `codex/bf-04`. Worktree: `C:/Users/14253/.codex/bf-20261028/worktrees/bf-04`.

Implementation commit: `38535e8`. Integration tip merged: `ef02c84eb26e9e6c75b1cdf045f6e4d8b0a59980`, via merge commit `632f872`. The merge brought documentation and baseline evidence only; no implementation/test changes required a repeated gate.

The initial merge-base and integration tip both resolved to `98846175afef3dad15005169cbb55493456eb423` before implementation. The original user checkout was not modified. Only the assigned normalizer, dedicated regression suite and this evidence directory were authored here; shared tracker state and HANDOFF were not edited by this task.

## Behavior

- Use one opening-fence recognizer for code parsing and paragraph boundaries.
- Match closing backticks at least as long as the opening run; shorter runs remain code content.
- Preserve the language and any additional info string in `metadata.fenceInfo`.
- Keep the existing raw paragraph fallback and `docreader_unclosed_code_fence` warning for unfinished fences.
- `parseTableRow` is unchanged. No dependencies, database schema, provider settings or production data changed.

## Red / green

The first vertical slice was written and run before implementation: one four-backtick public-parser test failed with `TypeError: Cannot read properties of undefined (reading 'end')` (`red-01-four-backticks.tap`). After the minimal fence-length fix, it passed (`green-01-four-backticks.tap`).

The attribute slice was added next and failed its content/block assertion (`red-02-info-attributes.tap`, 1 pass / 1 fail). After preserving the info string and aligning the recognizer, both passed (`green-02-info-attributes.tap`, 2/2).

Command for these slices:

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 src/ingestion/parser/docreader_pdf_fences.test.ts
```

Both exact trigger cases were additionally qualified against the original normalizer at `98846175afef3dad15005169cbb55493456eb423`; both failed with the original TypeError (`red-baseline-both-triggers.tap`, 0 pass / 2 fail). The owned source bytes were saved, the original normalizer was loaded from `git show`, the two public-parser tests were run, and the saved bytes were restored in a `finally` block. The baseline qualification child process had a 40-second timeout.

Baseline test command:

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 --test-timeout=30000 --test-reporter=tap --test-name-pattern="four-backtick PDF code fences retain|PDF code fences with attributes retain" src/ingestion/parser/docreader_pdf_fences.test.ts
```

## Passing gates

| Command / scope | Result | Evidence |
| --- | --- | --- |
| Dedicated parser controls, with `--test-timeout=30000` | 9/9 | green-03-parser-controls.tap |
| Dedicated suite including real pipeline and attachment service | 11/11 | green-04-shared-wiring.tap |
| `npm run test:docreader` | 38/38, no skips | green-docreader-suite.log |
| Existing API attachment, attachment service and DocReader extraction evidence suites | 17/17, no skips | green-affected-wiring.log |
| Actual parser selection / type compatibility suite | 3/3, no skips | green-parser-routing.log |
| `npm run build` (TypeScript and postbuild) | exit 0 | build.log |
| `git diff --check` | exit 0 | terminal check before commit |

Dedicated suite command:

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 --test-timeout=30000 src/ingestion/parser/docreader_pdf_fences.test.ts
```

Existing wiring gate was invoked with:

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 --test-timeout=60000 src/ingestion/parser/router.test.ts src/ingestion/docreader_extraction_evidence.test.ts src/attachments/session_attachment.test.ts src/api/attachments.test.ts
```

`router.test.ts` did not exist and contributed no tests; the 17 count covers only the three existing files. The actual routing suite was then explicitly run and passed:

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 --test-timeout=60000 src/ingestion/parser/router_type_compatibility.test.ts
```

The DocReader gate contains the 11 new tests plus 27 pre-existing tests. The 17 wiring and 3 routing tests are additional existing regressions: 58 unique tests across these gates. Intermediate runs are not additional test coverage.

## Acceptance mapping

| Criterion | Observable coverage | Result |
| --- | --- | --- |
| BF-04-A1 | Public `parse`: four-backtick typescript yields Before / code / After, with language | passed |
| BF-04-A2 | Public `parse`: python attributes yield readable code and exact `fenceInfo` | passed |
| BF-04-A3 | Both trigger regressions assert exact nonempty block content including Before / After | passed |
| BF-04-A4 | Ordinary triple fence keeps exact metadata contract; unfinished triple and extended fences preserve raw rest + existing warning | passed |
| BF-04-A5 | 64 adjacent samples, unsupported info containing backticks, empty consecutive fences; 320 expected blocks and bounded runner/test timeouts | passed |
| BF-04-A6 | Unicode page offsets, ratio locators, absent point bounding boxes, exact raw markdown/source blocks, stable parse/normalizeRaw output; real memory-SQLite pipeline and attachment public service | passed |
| BF-04-A7 | Original-baseline two-trigger TypeError evidence; both green; 38/38 DocReader gate | passed |

Incomplete acceptance: none. No real DocReader, OCR, model, Elasticsearch or other provider was contacted. The existing DocReader client suite uses its controlled loopback gRPC fixture; new regressions inject only the external client and storage boundaries and use isolated in-memory SQLite. Aggregate suites and final integration review remain the parent's responsibility.
