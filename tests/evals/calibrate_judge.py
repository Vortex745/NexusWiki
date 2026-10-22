"""Live Jev calibration against frozen, pre-labelled samples (DR-07).

The driver freezes two things before the first judge request:

  * the DR-06 rubric identity (``metrics.RUBRIC_VERSION`` + digest + 0.5
    threshold), and
  * every calibration sample (its canonical digest, kind, grounding
    applicability and human verdict) in an exclusive ``manifest`` file.

Only then does it score each sample three times through the REAL DR-06 path
(``judge_runtime.Judge`` -> per-case ``metrics.build_case_metrics`` ->
``TypeSafeModel`` / TypeSafe Jev). Every attempt is appended to a raw JSONL
log (score, confidence, per-question probabilities, reason, error, HTTP
request outcome); nothing is replaced, so a later success cannot hide an
earlier false positive. Each attempt is compared with the frozen human truth:
a positive must score >= 0.5, a negative < 0.5, and the memory-only sample
must report document Grounding ``not_applicable`` (not a pass, a failure or a
zero).

The command exits non-zero unless every sample matched on all three attempts
with no external error and the fixture and manifest still carry their frozen
digests. A missing required sample, a mutated fixture, a rubric digest change
or a manifest rewrite is refused BEFORE scoring (exit 2) without touching the
frozen truth. There is no threshold change and no truth mutation.

Offline tests inject a fake judge; the CLI uses ``judge_runtime.Judge()``
with no model factory, i.e. the real TypeSafe path.

Usage:
  python tests/evals/calibrate_judge.py --out .tmp/judge-calibration
  python tests/evals/calibrate_judge.py \\
      --fixture tests/evals/fixtures/judge-calibration.json \\
      --out C:/Users/14253/dr-wt/evidence/DR-07-live

Exit codes: 0 calibrated (all samples matched on all 3 attempts), 1 scoring
ran but the calibration is incomplete (misclassification or external error),
2 setup/validation/integrity failure (no claim of calibration).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

EVAL_DIR = Path(__file__).resolve().parent
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import judge_runtime  # noqa: E402
import ledger  # noqa: E402
import metrics  # noqa: E402

TICKET = "DR-07"
FIXTURE_SCHEMA = "jev-calibration-samples"
MANIFEST_SCHEMA = "jev-calibration-manifest"
ATTEMPT_SCHEMA = "jev-calibration-attempt"
REPORT_SCHEMA = "jev-calibration-report"
MANIFEST_FILENAME = "judge-calibration.manifest.json"
ATTEMPTS_PER_SAMPLE = 3
THRESHOLD = 0.5
DEFAULT_FIXTURE = EVAL_DIR / "fixtures" / "judge-calibration.json"
DEFAULT_OUT = EVAL_DIR.parent.parent / ".tmp" / "judge-calibration"

# Ticket DR-07 minimum scenarios. A fixture that drops one of these is
# incomplete and must not be scored.
MINIMUM_COVERAGE = (
    "correct_demo_citation",
    "wrong_number",
    "wrong_unit",
    "negated_conclusion",
    "fabricated_policy",
    "case10_unsupported_inference",
    "generic_clarification",
    "empty_scope_refusal",
    "memory_grounding_not_applicable",
)

KINDS = frozenset({"answer", "refuse", "memory-not-cited"})
VERDICTS = frozenset({"pass", "fail"})
GROUNDING_STATUSES = frozenset({"applicable", "not_applicable"})


class CalibrationError(RuntimeError):
    """The calibration cannot start or its frozen contract was broken."""


class FixtureValidationError(CalibrationError):
    """A sample is missing, malformed or does not cover a required scenario."""


class FrozenArtifactError(CalibrationError):
    """The frozen manifest or fixture changed after it was recorded."""


@dataclass
class CalibrationOutcome:
    exit_code: int
    report: dict
    report_json: Path | None = None
    report_markdown: Path | None = None
    attempts_path: Path | None = None
    manifest_path: Path | None = None


# ---------------------------------------------------------------------------
# digests and small helpers
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _session_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{stamp}-{secrets.token_hex(3)}"


def _canonical_digest(payload: Any) -> str:
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sample_digest(sample: Mapping[str, Any]) -> str:
    """Stable digest of one frozen calibration sample (truth included)."""
    return _canonical_digest(sample)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _score(value: Any) -> float | None:
    number = _number(value)
    if number is None or not 0.0 <= number <= 1.0:
        return None
    return number


def _scrub(value: Any) -> Any:
    scrubber = ledger.SecretScrubber.from_environment()
    if isinstance(value, str):
        return scrubber.scrub(value)
    if isinstance(value, Mapping):
        return {str(key): _scrub(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_scrub(item) for item in value]
    return value


# ---------------------------------------------------------------------------
# fixture loading and validation
# ---------------------------------------------------------------------------


def load_fixture(path: str | os.PathLike[str]) -> dict:
    fixture_path = Path(path)
    try:
        payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FixtureValidationError(f"cannot read fixture {fixture_path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FixtureValidationError(
            f"fixture {fixture_path} is not valid JSON: {exc}"
        ) from exc
    validate_fixture(payload)
    return payload


def _require_text(sample: Mapping[str, Any], key: str, errors: list[str]) -> str:
    value = sample.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{sample.get('id', '<unknown>')}: {key} must be non-empty text")
        return ""
    return value


def validate_fixture(fixture: Any) -> None:
    errors: list[str] = []
    if not isinstance(fixture, Mapping):
        raise FixtureValidationError("fixture must be a JSON object")
    if fixture.get("schema") != FIXTURE_SCHEMA:
        errors.append(f"fixture schema must be {FIXTURE_SCHEMA!r}")
    if not isinstance(fixture.get("version"), int):
        errors.append("fixture version must be an integer")
    samples = fixture.get("samples")
    if not isinstance(samples, list) or not samples:
        errors.append("fixture samples must be a non-empty array")
        samples = []

    required = fixture.get("required_coverage")
    if not isinstance(required, list) or not all(
        isinstance(item, str) and item.strip() for item in required
    ):
        errors.append("required_coverage must be an array of non-empty strings")
        required = []
    missing_required = [item for item in MINIMUM_COVERAGE if item not in required]
    if missing_required:
        errors.append(
            "fixture does not declare every DR-07 required scenario: "
            + ", ".join(missing_required)
        )

    seen_ids: set[str] = set()
    covered: set[str] = set()
    for index, sample in enumerate(samples):
        if not isinstance(sample, Mapping):
            errors.append(f"sample #{index} is not an object")
            continue
        sample_id = sample.get("id")
        if not isinstance(sample_id, str) or not sample_id.strip():
            errors.append(f"sample #{index} has no stable id")
            sample_id = f"<sample-{index}>"
        elif sample_id in seen_ids:
            errors.append(f"duplicate sample id {sample_id!r}")
        seen_ids.add(sample_id)

        _require_text(sample, "input", errors)
        _require_text(sample, "expected_output", errors)
        _require_text(sample, "actual_output", errors)
        _require_text(sample, "provenance", errors)
        _require_text(sample, "source_case", errors)

        kind = sample.get("kind")
        if kind not in KINDS:
            errors.append(f"{sample_id}: kind must be one of {sorted(KINDS)}")

        scope = sample.get("scope")
        if not isinstance(scope, list) or not all(
            isinstance(item, str) for item in scope
        ):
            errors.append(f"{sample_id}: scope must be an array of strings")

        truth = sample.get("human_truth")
        if not isinstance(truth, Mapping) or truth.get("verdict") not in VERDICTS:
            errors.append(f"{sample_id}: human_truth.verdict must be pass or fail")
        elif not isinstance(truth.get("rationale"), str) or not truth[
            "rationale"
        ].strip():
            errors.append(f"{sample_id}: human_truth.rationale must be non-empty")

        grounding = sample.get("grounding_applicability")
        if grounding not in GROUNDING_STATUSES:
            errors.append(
                f"{sample_id}: grounding_applicability must be applicable or "
                "not_applicable"
            )
        if kind == "memory-not-cited" and grounding != "not_applicable":
            errors.append(
                f"{sample_id}: a memory-only sample must mark document Grounding "
                "not_applicable"
            )
        if kind in {"answer", "refuse"} and grounding != "applicable":
            errors.append(
                f"{sample_id}: a document-fact sample must keep document Grounding "
                "applicable"
            )

        coverage = sample.get("coverage")
        if not isinstance(coverage, list) or not coverage or not all(
            isinstance(item, str) and item.strip() for item in coverage
        ):
            errors.append(f"{sample_id}: coverage must be a non-empty string array")
        else:
            covered.update(coverage)
            for item in coverage:
                if item not in required:
                    errors.append(
                        f"{sample_id}: coverage {item!r} is not in required_coverage"
                    )

        if kind == "answer":
            points = sample.get("answer_points")
            if not isinstance(points, list) or not points or not all(
                isinstance(item, str) and item.strip() for item in points
            ):
                errors.append(
                    f"{sample_id}: an answer sample requires non-empty answer_points"
                )
            references = sample.get("retrieval_context")
            if not isinstance(references, list) or not references:
                errors.append(
                    f"{sample_id}: an answer sample requires at least one cited "
                    "reference"
                )
        elif kind == "refuse":
            points = sample.get("answer_points")
            if points not in (None, []):
                errors.append(
                    f"{sample_id}: a refuse sample must not declare answer_points"
                )
            references = sample.get("retrieval_context")
            if not isinstance(references, list):
                errors.append(
                    f"{sample_id}: a refuse sample requires an explicit reference "
                    "array (possibly empty)"
                )
        elif kind == "memory-not-cited":
            if sample.get("retrieval_context") is not None:
                errors.append(
                    f"{sample_id}: a memory-only sample must not carry a "
                    "retrieval_context (no fabricated evidence)"
                )
            if not isinstance(sample.get("forbidden_reference_content"), str) or not sample[
                "forbidden_reference_content"
            ].strip():
                errors.append(
                    f"{sample_id}: a memory-only sample requires "
                    "forbidden_reference_content"
                )
            if not isinstance(sample.get("memory_constraints"), Mapping):
                errors.append(
                    f"{sample_id}: a memory-only sample requires memory_constraints"
                )

        references = sample.get("retrieval_context")
        if isinstance(references, list):
            for reference_index, reference in enumerate(references):
                if not isinstance(reference, Mapping):
                    errors.append(
                        f"{sample_id}: reference #{reference_index} is not an object"
                    )
                    continue
                for key in ("id", "title", "excerpt"):
                    if not isinstance(reference.get(key), str) or not reference[key].strip():
                        errors.append(
                            f"{sample_id}: reference #{reference_index} needs a "
                            f"non-empty {key}"
                        )

    missing_coverage = [item for item in MINIMUM_COVERAGE if item not in covered]
    if missing_coverage:
        errors.append(
            "no sample covers required DR-07 scenario(s): "
            + ", ".join(missing_coverage)
        )

    if errors:
        raise FixtureValidationError("; ".join(errors))


# ---------------------------------------------------------------------------
# manifest freeze
# ---------------------------------------------------------------------------


def build_metadata(sample: Mapping[str, Any]) -> dict:
    """The case metadata the real DR-06 judge builds its metrics from."""
    metadata: dict[str, Any] = {
        "calibration_sample_id": sample["id"],
        "gate_id": sample["id"],
        "source_case": sample.get("source_case"),
        "kind": sample["kind"],
        "scope": list(sample.get("scope") or []),
        "answer_points": list(sample.get("answer_points") or []),
        "prohibited_assertions": list(sample.get("prohibited_assertions") or []),
    }
    if sample.get("forbidden_reference_content"):
        metadata["forbidden_reference_content"] = sample["forbidden_reference_content"]
    if isinstance(sample.get("memory_constraints"), Mapping):
        metadata["memory_constraints"] = dict(sample["memory_constraints"])
    return metadata


def build_record(sample: Mapping[str, Any]) -> dict:
    """One judge input record shaped like a persisted run sample."""
    answer = sample["actual_output"]
    references = list(sample.get("retrieval_context") or [])
    metadata = build_metadata(sample)
    return {
        "sample_id": f"{sample['id']}-s0",
        "case_id": sample["id"],
        "sample_index": 0,
        "status": "pending_judge",
        "agent": {
            "answer": answer,
            "answer_sha256": hashlib.sha256(answer.encode("utf-8")).hexdigest(),
            "references": references,
            "request": {
                "message": sample["input"],
                "scope": list(sample.get("scope") or []),
                "stream": False,
            },
        },
        "planned": {
            "input_sha256": hashlib.sha256(sample["input"].encode("utf-8")).hexdigest(),
            "scope": list(sample.get("scope") or []),
            "metadata": metadata,
            "expected_output": sample["expected_output"],
        },
    }


def build_manifest(
    fixture: Mapping[str, Any],
    *,
    fixture_path: Path,
    fixture_sha256: str,
) -> dict:
    if metrics.DEFAULT_THRESHOLD != THRESHOLD:
        raise CalibrationError(
            "the DR-06 threshold changed to "
            f"{metrics.DEFAULT_THRESHOLD!r}; DR-07 requires 0.5 and never adjusts it"
        )
    return {
        "schema": MANIFEST_SCHEMA,
        "ticket": TICKET,
        "created_at": _utc_now(),
        "fixture": {
            "path": str(fixture_path),
            "sha256": fixture_sha256,
            "schema": fixture.get("schema"),
            "version": fixture.get("version"),
            "frozen_at": fixture.get("frozen_at"),
        },
        "rubric": {
            "version": metrics.RUBRIC_VERSION,
            "digest": metrics.rubric_digest(),
            "threshold": THRESHOLD,
        },
        "attempts_per_sample": ATTEMPTS_PER_SAMPLE,
        "required_coverage": list(fixture.get("required_coverage") or []),
        "samples": [
            {
                "id": sample["id"],
                "source_case": sample.get("source_case"),
                "kind": sample["kind"],
                "sample_sha256": sample_digest(sample),
                "human_truth": dict(sample["human_truth"]),
                "grounding": sample["grounding_applicability"],
                "coverage": list(sample.get("coverage") or []),
            }
            for sample in fixture["samples"]
        ],
    }


def _frozen_projection(manifest: Mapping[str, Any]) -> dict:
    """Fields that must never change once the manifest is written."""
    return {
        "fixture": {
            key: manifest.get("fixture", {}).get(key)
            for key in ("sha256", "schema", "version")
        },
        "rubric": dict(manifest.get("rubric") or {}),
        "attempts_per_sample": manifest.get("attempts_per_sample"),
        "required_coverage": list(manifest.get("required_coverage") or []),
        "samples": [
            {
                "id": item.get("id"),
                "kind": item.get("kind"),
                "sample_sha256": item.get("sample_sha256"),
                "human_truth": item.get("human_truth"),
                "grounding": item.get("grounding"),
                "coverage": item.get("coverage"),
            }
            for item in manifest.get("samples") or []
        ],
    }


def write_frozen_manifest(path: Path, manifest: Mapping[str, Any]) -> str:
    """Create the manifest once, or refuse any change to its frozen fields."""
    payload = json.loads(json.dumps(manifest, ensure_ascii=False))
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FrozenArtifactError(
                f"existing manifest {path} cannot be read back: {exc}"
            ) from exc
        if _frozen_projection(existing) != _frozen_projection(payload):
            raise FrozenArtifactError(
                f"frozen manifest conflict at {path}: the fixture, rubric or human "
                "truth differs from what was recorded before scoring"
            )
        return sha256_file(path)

    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "x", encoding="utf-8", newline="\n") as handle:
            json.dump(
                payload, handle, ensure_ascii=False, indent=2, sort_keys=True
            )
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        return write_frozen_manifest(path, payload)
    except OSError as exc:
        raise CalibrationError(f"cannot write the frozen manifest {path}: {exc}") from exc

    try:
        read_back = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CalibrationError(
            f"frozen manifest {path} did not read back: {exc}"
        ) from exc
    if read_back != payload:
        raise CalibrationError(f"frozen manifest {path} read-back differs")
    return sha256_file(path)


# ---------------------------------------------------------------------------
# attempt extraction
# ---------------------------------------------------------------------------


def _metric_records(entries: Sequence[Any]) -> list[dict]:
    records: list[dict] = []
    for entry in entries or []:
        if not isinstance(entry, Mapping):
            continue
        breakdown = entry.get("breakdown")
        if not isinstance(breakdown, list):
            breakdown = []
        confidences = [
            value
            for item in breakdown
            if isinstance(item, Mapping)
            and (value := _number(item.get("confidence"))) is not None
        ]
        probabilities = [
            {
                key: item.get(key)
                for key in (
                    "question",
                    "type",
                    "weight",
                    "value",
                    "applicable",
                    "probabilities",
                    "confidence",
                )
            }
            for item in breakdown
            if isinstance(item, Mapping)
        ]
        records.append(
            {
                "metric": entry.get("metric"),
                "applicability": entry.get("applicability"),
                "threshold": entry.get("threshold"),
                "score": _score(entry.get("score")),
                "success": entry.get("success")
                if isinstance(entry.get("success"), bool)
                else None,
                "reason": _scrub(entry.get("reason")),
                "error": _scrub(entry.get("error")),
                "attempted": bool(entry.get("attempted")),
                "request_count": entry.get("request_count"),
                "attempts": _scrub(entry.get("attempts") or []),
                "termination": entry.get("termination"),
                "confidence": min(confidences) if confidences else None,
                "probabilities": probabilities,
                "breakdown": _scrub(breakdown),
            }
        )
    return records


def _request_summary(details: Mapping[str, Any], records: Sequence[dict]) -> dict:
    attempts = details.get("attempts")
    if not isinstance(attempts, list) or not attempts:
        attempts = [
            {**attempt, "metric": record.get("metric")}
            for record in records
            for attempt in (record.get("attempts") or [])
            if isinstance(attempt, Mapping)
        ]
    request_count = details.get("request_count")
    if not isinstance(request_count, int):
        request_count = len(attempts)
    return {
        "model": details.get("model"),
        "model_source": details.get("model_source"),
        "base_url": _scrub(details.get("base_url")),
        "request_count": request_count,
        "attempts": _scrub(attempts),
        "termination": details.get("termination"),
        "total_ms": details.get("total_ms"),
        "budget": _scrub(details.get("budget")),
    }


def build_attempt(
    *,
    session_id: str,
    sample: Mapping[str, Any],
    attempt: int,
    manifest: Mapping[str, Any],
    result: Mapping[str, Any] | None = None,
    error: BaseException | None = None,
    started_at: str,
    finished_at: str,
    duration_ms: int,
) -> dict:
    """One retained attempt; success and failure share the same shape."""
    frozen_rubric = manifest["rubric"]
    details: Mapping[str, Any] = {}
    raw_metrics: Sequence[Any] = []
    score: float | None = None
    success: bool | None = None
    reason: str | None = None
    error_payload: dict | None = None

    if error is not None:
        details = getattr(error, "details", None) or {}
        if not isinstance(details, Mapping):
            details = {}
        raw_metrics = details.get("metrics") or []
        score = _score(details.get("score"))
        success = details.get("success") if isinstance(details.get("success"), bool) else None
        error_payload = _scrub(
            details.get("error")
            or {
                "error_class": type(error).__name__,
                "error_family": "other",
                "wrapper_class": None,
                "http_status": None,
                "message": str(error)[:1500],
            }
        )
        score = None  # an errored attempt never carries a score
    elif result is not None:
        details = result.get("details") or {}
        if not isinstance(details, Mapping):
            details = {}
        raw_metrics = result.get("metrics") or details.get("metrics") or []
        score = _score(result.get("score"))
        success = result.get("success") if isinstance(result.get("success"), bool) else None
        reason = _scrub(result.get("reason"))
        if score is None:
            error_payload = {
                "error_class": "MissingJudgeScore",
                "error_family": "other",
                "wrapper_class": None,
                "http_status": None,
                "message": "the judge returned no numeric score in [0, 1]",
            }
            score = None
    else:
        error_payload = {
            "error_class": "MissingJudgeResult",
            "error_family": "other",
            "wrapper_class": None,
            "http_status": None,
            "message": "the judge returned neither a verdict nor an error",
        }

    records = _metric_records(raw_metrics)
    rubric = details.get("rubric") if isinstance(details, Mapping) else None
    if not isinstance(rubric, Mapping):
        rubric = (result or {}).get("rubric") if isinstance(result, Mapping) else None
    if not isinstance(rubric, Mapping):
        rubric = {}
    rubric_record = {
        "version": rubric.get("version"),
        "digest": rubric.get("digest"),
        "plan_digest": rubric.get("plan_digest"),
        "evidence_scope": rubric.get("evidence_scope"),
        "matches_frozen": (
            rubric.get("version") == frozen_rubric["version"]
            and rubric.get("digest") == frozen_rubric["digest"]
        ),
    }

    ground = next(
        (record for record in records if record.get("metric") == "Grounding"), None
    )
    grounding = {
        "expected": sample["grounding_applicability"],
        "observed": (ground or {}).get("applicability") or "missing",
        "score": (ground or {}).get("score"),
        "attempted": (ground or {}).get("attempted"),
        "error": (ground or {}).get("error"),
    }

    confidences = [
        record["confidence"]
        for record in records
        if record.get("confidence") is not None
    ]
    probabilities = [
        {"metric": record.get("metric"), **item}
        for record in records
        for item in (record.get("probabilities") or [])
    ]
    return {
        "schema": ATTEMPT_SCHEMA,
        "ticket": TICKET,
        "session_id": session_id,
        "sample_id": sample["id"],
        "attempt": attempt,
        "attempts_per_sample": manifest["attempts_per_sample"],
        "kind": sample["kind"],
        "human_truth": sample["human_truth"]["verdict"],
        "rubric": rubric_record,
        "score": score,
        "success": success,
        "confidence": min(confidences) if confidences else None,
        "probabilities": probabilities,
        "reason": reason,
        "error": error_payload,
        "request": _request_summary(details, records),
        "metrics": records,
        "grounding": grounding,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
    }


# ---------------------------------------------------------------------------
# truth comparison
# ---------------------------------------------------------------------------


def classify_attempt(sample: Mapping[str, Any], attempt: Mapping[str, Any]) -> dict:
    """Compare one attempt with the frozen human truth."""
    reasons: list[str] = []
    types: list[str] = []
    truth = sample["human_truth"]["verdict"]
    score = attempt.get("score")

    if attempt.get("error") is not None:
        types.append("external_error")
        reasons.append(
            "external judge error: "
            + str(attempt["error"].get("error_class") or "unknown")
        )
    elif score is None:
        types.append("missing_score")
        reasons.append("the attempt produced no score")
    elif truth == "pass" and score < THRESHOLD:
        types.append("false_negative")
        reasons.append(f"false negative: score {score} < {THRESHOLD}")
    elif truth == "fail" and score >= THRESHOLD:
        types.append("false_positive")
        reasons.append(f"false positive: score {score} >= {THRESHOLD}")

    grounding = attempt.get("grounding") or {}
    expected = grounding.get("expected")
    observed = grounding.get("observed")
    if expected == "not_applicable":
        if observed != "not_applicable":
            types.append("grounding_mismatch")
            reasons.append(
                "memory view expected document Grounding not_applicable, observed "
                f"{observed}"
            )
        elif grounding.get("score") is not None or grounding.get("attempted"):
            types.append("grounding_mismatch")
            reasons.append(
                "memory view's document Grounding must not be scored or attempted"
            )
    elif expected == "applicable" and observed != "applicable":
        types.append("grounding_mismatch")
        reasons.append(
            f"document facts expected Grounding applicable, observed {observed}"
        )

    if attempt.get("rubric", {}).get("matches_frozen") is not True:
        types.append("rubric_mismatch")
        reasons.append(
            "the rubric version/digest used for this attempt does not match the "
            "frozen manifest"
        )

    if not reasons:
        status = "matched"
    elif "external_error" in types:
        status = "error"
    else:
        status = types[0] if types else "unmatched"
    return {
        "matched": not reasons,
        "types": types,
        "reasons": reasons,
        "status": status,
    }


# ---------------------------------------------------------------------------
# report writing
# ---------------------------------------------------------------------------


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # Windows can transiently refuse os.replace while another handle is
        # closing (antivirus/indexer); retry briefly instead of losing a report.
        last_error: OSError | None = None
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                break
            except PermissionError as exc:
                last_error = exc
                time.sleep(0.05 * (attempt + 1))
        else:
            raise last_error or OSError(f"cannot replace {path}")
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def _atomic_write_json(path: Path, payload: Any) -> None:
    _atomic_write_text(
        path, json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    )


def _markdown_report(report: Mapping[str, Any]) -> str:
    lines = [
        "# DR-07 judge calibration report",
        "",
        f"- complete: **{'yes' if report.get('complete') else 'no'}**",
        f"- exit_code: {report.get('exit_code')}",
        f"- session: `{report.get('session_id')}`",
        f"- fixture: `{report.get('fixture', {}).get('path')}`",
        f"- fixture sha256 before/after: `{report.get('fixture', {}).get('sha256_before')}` / "
        f"`{report.get('fixture', {}).get('sha256_after')}`",
        f"- rubric: {report.get('rubric', {}).get('version')} "
        f"`{report.get('rubric', {}).get('digest')}`",
        f"- threshold: {report.get('threshold')}",
        f"- attempts per sample: {report.get('attempts_per_sample')}",
        f"- manifest: `{report.get('manifest', {}).get('path')}` "
        f"`{report.get('manifest', {}).get('sha256')}`",
        f"- raw attempts: `{report.get('attempts_file')}`",
        "",
        "## Sample matrix",
        "",
        "| sample | truth | grounding expected/observed | attempts (score) | matched |",
        "|---|---|---|---|---|",
    ]
    for row in report.get("matrix") or []:
        scores = ", ".join(
            "error" if item.get("status") == "error" else f"{item.get('score')} ({item.get('status')})"
            for item in row.get("attempts") or []
        )
        grounding = row.get("grounding") or {}
        lines.append(
            f"| {row.get('sample_id')} | {row.get('human_truth')} | "
            f"{grounding.get('expected')} / {grounding.get('observed')} | "
            f"{scores} | {'yes' if row.get('matched') else 'NO'} |"
        )

    lines += ["", "## Misclassifications", ""]
    misses = report.get("misclassifications") or []
    if not misses:
        lines.append("None.")
    for item in misses:
        lines.append(
            f"- {item.get('sample_id')} attempt {item.get('attempt')}: "
            f"**{item.get('type')}** (truth {item.get('human_truth')}, score "
            f"{item.get('score')}) - {'; '.join(item.get('reasons') or [])}"
        )

    lines += ["", "## External errors", ""]
    errors = report.get("external_errors") or []
    if not errors:
        lines.append("None.")
    for item in errors:
        lines.append(
            f"- {item.get('sample_id')} attempt {item.get('attempt')}: "
            f"{item.get('error', {}).get('error_class')} - "
            f"{item.get('error', {}).get('message')}"
        )

    if report.get("error"):
        lines += ["", "## Setup/integrity error", "", str(report["error"])]
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# calibration run
# ---------------------------------------------------------------------------


def _default_judge() -> Callable[..., dict]:
    # No model factory: the real TypeSafeModel / Jev HTTP path.
    return judge_runtime.Judge()


def _append_attempt(path: Path, attempt: Mapping[str, Any]) -> None:
    line = json.dumps(attempt, ensure_ascii=False, sort_keys=True)
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _read_attempts(path: Path) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    errors: list[str] = []
    if not path.exists():
        return rows, [f"attempts file {path} is missing"]
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        return rows, [f"attempts file {path} is unreadable: {exc}"]
    for index, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            errors.append(f"attempt line {index} is corrupt: {exc}")
    return rows, errors


def _write_failure_reports(
    out_dir: Path,
    session_id: str,
    report: dict,
) -> CalibrationOutcome:
    json_path = out_dir / f"judge-calibration.report-{session_id}.json"
    md_path = out_dir / f"judge-calibration.report-{session_id}.md"
    try:
        _atomic_write_json(json_path, report)
        _atomic_write_text(md_path, _markdown_report(report))
    except OSError as exc:
        report.setdefault("notes", []).append(f"cannot write report: {exc}")
        return CalibrationOutcome(report.get("exit_code", 2), report)
    return CalibrationOutcome(
        report["exit_code"], report, report_json=json_path, report_markdown=md_path
    )


def run_calibration(
    fixture_path: str | os.PathLike[str] = DEFAULT_FIXTURE,
    out_dir: str | os.PathLike[str] = DEFAULT_OUT,
    *,
    judge: Callable[..., Any] | None = None,
    judge_factory: Callable[[], Callable[..., Any]] | None = None,
) -> CalibrationOutcome:
    """Freeze the rubric/truth, score every sample three times, compare."""
    fixture_path = Path(fixture_path).resolve()
    out_dir = Path(out_dir).resolve()
    session_id = _session_id()
    started_at = _utc_now()
    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "ticket": TICKET,
        "session_id": session_id,
        "started_at": started_at,
        "finished_at": None,
        "complete": False,
        "exit_code": 2,
        "threshold": THRESHOLD,
        "attempts_per_sample": ATTEMPTS_PER_SAMPLE,
        "fixture": {"path": str(fixture_path)},
        "rubric": {},
        "manifest": {},
        "attempts_file": None,
        "sample_counts": {
            "planned": 0,
            "attempted": 0,
            "retained": 0,
            "errors": 0,
            "misclassified": 0,
            "matched_samples": 0,
        },
        "matrix": [],
        "misclassifications": [],
        "external_errors": [],
        "notes": [],
    }

    try:
        fixture = load_fixture(fixture_path)
        if metrics.DEFAULT_THRESHOLD != THRESHOLD:
            raise CalibrationError(
                "the DR-06 threshold is not 0.5; DR-07 never changes it"
            )
        fixture_sha_before = sha256_file(fixture_path)
        manifest = build_manifest(
            fixture, fixture_path=fixture_path, fixture_sha256=fixture_sha_before
        )
        out_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = out_dir / MANIFEST_FILENAME
        manifest_sha = write_frozen_manifest(manifest_path, manifest)
        frozen_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if _frozen_projection(frozen_manifest) != _frozen_projection(manifest):
            raise FrozenArtifactError("the frozen manifest changed during setup")
        # Keep the exact frozen truth beside the run for auditability. This is
        # a copy; the source fixture is never written.
        frozen_copy = out_dir / f"judge-calibration.fixture-{session_id}.json"
        _atomic_write_text(frozen_copy, fixture_path.read_text(encoding="utf-8"))
    except CalibrationError as exc:
        report["error"] = str(exc)
        report["finished_at"] = _utc_now()
        report["exit_code"] = 2
        return _write_failure_reports(out_dir, session_id, report)
    except OSError as exc:
        report["error"] = f"setup failed: {exc}"
        report["finished_at"] = _utc_now()
        report["exit_code"] = 2
        return _write_failure_reports(out_dir, session_id, report)

    report["fixture"].update(
        {
            "sha256_before": fixture_sha_before,
            "schema": fixture.get("schema"),
            "version": fixture.get("version"),
            "frozen_at": fixture.get("frozen_at"),
            "sample_count": len(fixture["samples"]),
        }
    )
    report["rubric"] = {
        "version": frozen_manifest["rubric"]["version"],
        "digest": frozen_manifest["rubric"]["digest"],
        "threshold": frozen_manifest["rubric"]["threshold"],
    }
    report["manifest"] = {
        "path": str(manifest_path),
        "sha256": manifest_sha,
        "created_at": frozen_manifest.get("created_at"),
    }
    report["sample_counts"]["planned"] = len(fixture["samples"])

    if judge is None:
        factory = judge_factory or _default_judge
        try:
            judge = factory()
        except Exception as exc:
            report["error"] = (
                f"cannot construct the judge: {type(exc).__name__}: {exc}"
            )
            report["finished_at"] = _utc_now()
            report["exit_code"] = 2
            return _write_failure_reports(out_dir, session_id, report)

    attempts_path = out_dir / f"judge-calibration.attempts-{session_id}.jsonl"
    report["attempts_file"] = str(attempts_path)

    for sample in fixture["samples"]:
        record = build_record(sample)
        context = {
            "sample_id": record["sample_id"],
            "metadata": record["planned"]["metadata"],
            "expected_output": sample["expected_output"],
        }
        for attempt_number in range(1, ATTEMPTS_PER_SAMPLE + 1):
            started = time.monotonic()
            attempt_started_at = _utc_now()
            result: Mapping[str, Any] | None = None
            failure: BaseException | None = None
            try:
                produced = judge(record, context)
                if not isinstance(produced, Mapping):
                    raise CalibrationError(
                        f"judge returned {type(produced).__name__}, not a verdict mapping"
                    )
                result = produced
            except Exception as exc:  # every attempt is retained
                failure = exc
            attempt_finished_at = _utc_now()
            row = build_attempt(
                session_id=session_id,
                sample=sample,
                attempt=attempt_number,
                manifest=frozen_manifest,
                result=result,
                error=failure,
                started_at=attempt_started_at,
                finished_at=attempt_finished_at,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            try:
                _append_attempt(attempts_path, row)
            except OSError as exc:
                report["notes"].append(
                    f"cannot persist attempt {attempt_number} for {sample['id']}: {exc}"
                )
            report["sample_counts"]["attempted"] += 1

    rows, parse_errors = _read_attempts(attempts_path)
    expected_attempts = len(fixture["samples"]) * ATTEMPTS_PER_SAMPLE
    report["sample_counts"]["retained"] = len(rows)
    attempts_by_sample: dict[str, list[dict]] = {}
    for row in rows:
        attempts_by_sample.setdefault(str(row.get("sample_id")), []).append(row)

    for sample in fixture["samples"]:
        sample_rows = sorted(
            attempts_by_sample.get(sample["id"], []), key=lambda item: item.get("attempt") or 0
        )
        matrix_attempts: list[dict] = []
        sample_matched = True
        for row in sample_rows:
            verdict = classify_attempt(sample, row)
            matrix_attempts.append(
                {
                    "attempt": row.get("attempt"),
                    "score": row.get("score"),
                    "error": row.get("error"),
                    "status": verdict["status"],
                    "matched": verdict["matched"],
                    "reasons": verdict["reasons"],
                }
            )
            if verdict["matched"]:
                continue
            sample_matched = False
            if row.get("error") is not None:
                report["external_errors"].append(
                    {
                        "sample_id": sample["id"],
                        "attempt": row.get("attempt"),
                        "human_truth": sample["human_truth"]["verdict"],
                        "error": row.get("error"),
                        "request": row.get("request"),
                        "reasons": verdict["reasons"],
                    }
                )
            else:
                report["misclassifications"].append(
                    {
                        "sample_id": sample["id"],
                        "attempt": row.get("attempt"),
                        "type": verdict["status"],
                        "types": verdict["types"],
                        "human_truth": sample["human_truth"]["verdict"],
                        "human_truth_rationale": sample["human_truth"].get("rationale"),
                        "score": row.get("score"),
                        "confidence": row.get("confidence"),
                        "grounding": row.get("grounding"),
                        "reasons": verdict["reasons"],
                    }
                )
        if len(sample_rows) != ATTEMPTS_PER_SAMPLE:
            sample_matched = False
        observed = sorted(
            {
                str((row.get("grounding") or {}).get("observed"))
                for row in sample_rows
            }
        )
        report["matrix"].append(
            {
                "sample_id": sample["id"],
                "source_case": sample.get("source_case"),
                "kind": sample["kind"],
                "coverage": sample.get("coverage"),
                "human_truth": sample["human_truth"]["verdict"],
                "human_truth_rationale": sample["human_truth"].get("rationale"),
                "grounding": {
                    "expected": sample["grounding_applicability"],
                    "observed": observed[0] if len(observed) == 1 else observed,
                },
                "attempts": matrix_attempts,
                "matched": sample_matched,
            }
        )
        if sample_matched:
            report["sample_counts"]["matched_samples"] += 1

    report["sample_counts"]["errors"] = len(report["external_errors"])
    report["sample_counts"]["misclassified"] = len(report["misclassifications"])

    fixture_sha_after = sha256_file(fixture_path)
    report["fixture"]["sha256_after"] = fixture_sha_after
    manifest_sha_after = sha256_file(manifest_path)
    report["manifest"]["sha256_after"] = manifest_sha_after

    integrity_errors: list[str] = list(parse_errors)
    if fixture_sha_after != fixture_sha_before:
        integrity_errors.append("the frozen fixture changed during calibration")
    if manifest_sha_after != manifest_sha:
        integrity_errors.append("the frozen manifest changed during calibration")
    if len(rows) != expected_attempts:
        integrity_errors.append(
            f"expected {expected_attempts} retained attempts, found {len(rows)}"
        )
    for row in rows:
        if row.get("rubric", {}).get("matches_frozen") is not True:
            integrity_errors.append(
                f"{row.get('sample_id')} attempt {row.get('attempt')} used a "
                "different rubric than the frozen manifest"
            )
            break

    report["complete"] = (
        not integrity_errors
        and not report["external_errors"]
        and not report["misclassifications"]
        and report["sample_counts"]["matched_samples"] == len(fixture["samples"])
        and len(rows) == expected_attempts
    )
    if integrity_errors:
        report["error"] = "; ".join(integrity_errors)
        report["exit_code"] = 2
    elif report["complete"]:
        report["exit_code"] = 0
    else:
        report["exit_code"] = 1
    report["finished_at"] = _utc_now()

    json_path = out_dir / f"judge-calibration.report-{session_id}.json"
    md_path = out_dir / f"judge-calibration.report-{session_id}.md"
    try:
        _atomic_write_json(json_path, report)
        _atomic_write_text(md_path, _markdown_report(report))
    except OSError as exc:
        report["notes"].append(f"cannot write report: {exc}")
        if report["exit_code"] == 0:
            report["exit_code"] = 2
            report["complete"] = False
        return CalibrationOutcome(report["exit_code"], report)

    return CalibrationOutcome(
        report["exit_code"],
        report,
        report_json=json_path,
        report_markdown=md_path,
        attempts_path=attempts_path,
        manifest_path=manifest_path,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _summary_payload(outcome: CalibrationOutcome) -> dict:
    report = outcome.report
    return {
        "ticket": TICKET,
        "session_id": report.get("session_id"),
        "complete": report.get("complete"),
        "exit_code": report.get("exit_code"),
        "error": report.get("error"),
        "rubric": report.get("rubric"),
        "threshold": report.get("threshold"),
        "fixture_unchanged": report.get("fixture", {}).get("sha256_before")
        == report.get("fixture", {}).get("sha256_after"),
        "counts": report.get("sample_counts"),
        "matrix": [
            {
                "sample_id": row.get("sample_id"),
                "human_truth": row.get("human_truth"),
                "attempts": [
                    {
                        "attempt": item.get("attempt"),
                        "score": item.get("score"),
                        "status": item.get("status"),
                    }
                    for item in row.get("attempts") or []
                ],
                "matched": row.get("matched"),
            }
            for row in report.get("matrix") or []
        ],
        "misclassifications": report.get("misclassifications"),
        "external_errors": report.get("external_errors"),
        "manifest": report.get("manifest"),
        "attempts_file": report.get("attempts_file"),
        "report_json": str(outcome.report_json) if outcome.report_json else None,
        "report_markdown": str(outcome.report_markdown)
        if outcome.report_markdown
        else None,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the frozen DR-07 Jev calibration against the real TypeSafe model"
    )
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    outcome = run_calibration(args.fixture, args.out)
    print(json.dumps(_summary_payload(outcome), ensure_ascii=False, indent=2))
    print(
        "CALIBRATION COMPLETE" if outcome.exit_code == 0 else "CALIBRATION INCOMPLETE",
        file=sys.stdout,
    )
    return outcome.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
