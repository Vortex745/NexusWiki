# BF-05 verification

Completed: 2026-10-29 (Asia/Shanghai). Branch: `codex/bf-05`. Worktree: `C:/Users/14253/.codex/bf-20261028/worktrees/bf-05`.

Implementation commit: `70503ab`. Starting HEAD, integration tip and merge-base were all `33a21bde9e11ea6b9e363385182c1ae12a03ad81`; `git merge-base --is-ancestor codex/confirmed-bug-fixes HEAD` returned 0. The starting integration already included completed BF-04.

Current integration tip `a37d830e601fcb7c90152960735cfeeb9642291b` was merged via `34b5fe5c695a957e332bf4f5b49925b757f147a3`. It brought BF-01 retrieval changes and shared tracking/evidence; it did not change the PDF normalizer. The dedicated nine parser regressions were rerun after this merge and all passed. Aggregate integration verification belongs to the parent.

## Change and scope

Only `parseTableRow` changes in production code. A single row scan distinguishes escaped content from actual separators and a final optional border. It no longer strips the last pipe before examining escapes. BF-04 fence/paragraph logic and its regression file are untouched.

The fixture contract is explicit: an odd run of backslashes escapes the next pipe, consuming only its immediately preceding escape; other backslashes remain literal. An even run leaves the pipe structural and preserves every backslash. The same rule handles interior delimiters and final borders. Other Markdown escapes are not interpreted. There is no additional whole-document pass, dependency, parser framework, provider call, schema change or business-data operation.

No shared tracker or HANDOFF edits were authored by this task; those paths appear only as inherited integration changes. The original user checkout was not touched.

## TDD and exact commands

All new regressions call the public `DocReaderPdfParser.parse` with a controlled external DocReader response; no normalizer internals are mocked or tested directly.

```powershell
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 --test-reporter=tap src/ingestion/parser/docreader_pdf_tables.test.ts
```

| Slice | Red | Green |
| --- | --- | --- |
| Final escaped pipe, no border | 0 pass / 1 fail: actual final cell was A plus backslash, expected A plus pipe; red-01-final-escaped-pipe.tap | 1/1; green-01-final-escaped-pipe.tap |
| Even backslash parity at final border | 1 pass / 1 fail: actual consumed a literal backslash and retained the delimiter; red-02-slash-parity.tap | 2/2; green-02-slash-parity.tap |
| Full public table matrix and controls | Previously failing behavior is retained in the first two tests | 9/9; green-03-table-matrix.tap |
| After current integration merge | No new production parser changes | 9/9; green-after-integration.tap |

Passing targeted gates on the BF-05 implementation before merging the unrelated BF-01 retrieval update:

```powershell
npm run test:docreader
node --import tsx --import ./scripts/test-env.ts --test --test-concurrency=1 --test-reporter=tap src/ingestion/parser/router_type_compatibility.test.ts
npm run build
git diff --check
```

- DocReader suite: **47/47**, no failures/skips. Includes 27 original tests, BF-04's 11 regressions/shared-consumer tests and BF-05's 9 regressions. Evidence: `green-docreader-suite.log`.
- Existing parser selection/type-compatibility suite: **3/3**, no failures/skips. Evidence: `green-parser-routing.tap`.
- Build: **exit 0**, including TypeScript and postbuild. Evidence: `build.log`.
- `git diff --check`: **exit 0**. Stored TAP assertion output has trailing presentation whitespace removed for a clean evidence diff; test result content is unchanged.

These gates cover 50 unique tests. Repeated red/green or post-merge runs are not counted as additional coverage. Shared knowledge-import and attachment service wiring reuse the existing BF-04 tests in the DocReader suite, as allowed by the formal BF-05 issue; no duplicate wiring entry point was introduced.

## Acceptance mapping

| Criterion | Public behavior coverage | Result |
| --- | --- | --- |
| BF-05-A1 | Exact three-line sample, final cell `A|`, two headers/cells; Before/After and raw block text | passed |
| BF-05-A2 | Explicit outer border after escaped content; exact two-cell row, no extra cell | passed |
| BF-05-A3 | Interior escaped/unescaped pipes, leading escaped pipe, odd/even runs; whitespace after both escaped content and ordinary borders | passed |
| BF-05-A4 | Ordinary bordered/unbordered headers and rows, empty bordered cell and trimming; literal fixtures for one/two/three/four backslashes, interior and final | passed |
| BF-05-A5 | Exact table block text and prose; raw envelope markdown remains exact; normalizeRaw equals public parse output | passed |
| BF-05-A6 | Red-before-green public regressions; 47/47 DocReader suite includes shared import/attachment parser wiring; existing routing 3/3 | passed |
| BF-05-A7 | Offline synthetic input; injected external client; one row scan; no provider/dependency/whole-document preprocessing changes | passed |

Incomplete acceptance: none. Real provider requests: zero. The existing client suite uses its controlled loopback gRPC fixture. No real DocReader, OCR, model, Elasticsearch or business database was used.
