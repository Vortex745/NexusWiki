# Actual Clef protocol correction

The first live v2 batch failed before semantics: the slash-delimited nine option IDs were rejected by the real provider. A controlled genuine table-grid page request produced:

`HTTP 400`, code `5006`, message `AiError: Bad input: Error: required properties at '/' are 'model,state,questions'`. The builder already had those three properties. The same request changed only option IDs from slash to underscore and the matching `pass_no_issue` wording; it returned `HTTP 200`, model `clef`, selected `fail_structure_loss`, confidence `0.0906`, all nine probabilities and usage `input_tokens=1932, output_tokens=0`.

The production builder now uses `pass_no_issue`, `fail_<issue>`, `uncertain_<issue>` and the parser strictly derives the same nine legal semantic pairs. The fully unmodified production request then returned HTTP 200 and parsed correctly. No credentials, headers, page image bytes or extracted text are stored in these reports.

Live schema read: https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json (saved as `clef-input-schema.json`). It describes option IDs as nonempty strings and omits this live slash restriction; the controlled actual response is the compatibility evidence. Root retained the original scrubbed 400 as `pdf-live/http400-probe.json`; corrected actual response is `clef-probe-current.json`, independent underscore probe is `clef-probe-underscore.json`.

Additional review correction: validate every page ID, textblock array and block label/text shape before classifying empty content. The public OCR page-text reader regression proved an earlier empty page must not swallow a malformed later page into `ocr_empty_page_unverified`.

Follow-up commit: `faeb8a1`.

Verification: 276 focused tests passed, zero failures/skips (`focused-test-protocol-fix.log`); backend build passed (`build-protocol-fix.log`); actual single-page HTTP 200. This is protocol validation, not semantic correctness evidence. Default fallback remains disabled.
