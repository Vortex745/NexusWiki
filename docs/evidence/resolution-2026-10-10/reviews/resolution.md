# Review resolution

Standards: P2 external diagnostic trust boundary fixed by 4a09bfc, verified plain Error/SDK/string/unrelated AggregateError do not expose supplied sensitive text. Trusted local migration error only; write-lock restore failure explicitly warns without cause material. P3 duplicated physical-index validator and float paths now use config/store public definitions.

Spec: P2 mixed empty+malformed OCR response now globally validates all structural types first; own mixed-page regression passes. Initial P1 write-freeze race and P2 lost response restore fixed by acknowledged addBlock and attempted mutation tracking, reproduced/green tests; real routed source/target fixture passed.

Transport followup: live Clef misleading HTTP400 reproduced; slash option labels→underscore acceptedHTTP200. Production parsing stays strict; v1 only viewed. Further regression failures were stale replay/UI/oldindex test fixtures, aligned without reducing acceptance.

No open code review finding. PDF semantic acceptance is OPEN: 6 falseaccept/9 falsereject in48 real runs, defaultOFF. TypeSafe completion is BLOCKED451. These are not silently treated as resolved by code review.
