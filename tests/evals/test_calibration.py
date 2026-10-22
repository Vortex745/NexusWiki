"""Offline contract tests for the live Jev calibration driver (DR-07).

No test here calls TypeSafe/Jev. A fake judge returns the DR-06 verdict shape
(or raises ``JudgeFailure``) while the real offline applicability plan from
``metrics.build_case_metrics`` is used to shape per-metric entries. The tests
prove the caller-visible calibration contract:

  * rubric version/digest and every sample digest are frozen in a manifest
    BEFORE the first scoring call, and the manifest cannot be rewritten;
  * all three attempts per sample are retained in a raw attempts log, even a
    first-attempt false positive followed by passes (no latest-success pick);
  * each sample is compared with its frozen human truth (>= 0.5 for a
    positive, < 0.5 for a negative), the memory sample requires document
    Grounding not_applicable, and every false positive/negative, grounding
    mismatch and external error is reported;
  * a missing required sample or a mutated fixture stops calibration before
    any scoring and never mutates the frozen truth;
  * the threshold stays 0.5.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

import calibrate_judge  # noqa: E402
import judge_runtime  # noqa: E402
import metrics  # noqa: E402

FIXTURE = EVAL_DIR / "fixtures" / "judge-calibration.json"
MANIFEST_NAME = calibrate_judge.MANIFEST_FILENAME
ATTEMPTS_PER_SAMPLE = calibrate_judge.ATTEMPTS_PER_SAMPLE


def load_fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def write_fixture(tmp_path: Path, payload: dict, name: str = "fixture.json") -> Path:
    path = tmp_path / name
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path


def _sample_by_id(fixture: dict, sample_id: str) -> dict:
    return next(sample for sample in fixture["samples"] if sample["id"] == sample_id)


def _attempts(out_dir: Path) -> list[dict]:
    paths = sorted(out_dir.glob("judge-calibration.attempts-*.jsonl"))
    assert len(paths) == 1, paths
    lines = paths[0].read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


class FakeJudge:
    """Offline judge shaped like ``judge_runtime.Judge``; no network.

    ``schedule`` maps a sample id to per-attempt case scores. ``overrides``
    applies one score to every attempt. A score defaults to 1.0 for a
    pass-truth sample and 0.0 for a fail-truth sample.
    """

    def __init__(
        self,
        fixture: dict,
        *,
        out_dir: Path | None = None,
        fixture_path: Path | None = None,
        schedule: dict[str, list[float]] | None = None,
        overrides: dict[str, float] | None = None,
        error_ids: set[str] | None = None,
        grounding_override: dict[str, str] | None = None,
    ) -> None:
        self.fixture = copy.deepcopy(fixture)
        self.by_id = {sample["id"]: sample for sample in self.fixture["samples"]}
        self.out_dir = out_dir
        self.fixture_path = fixture_path
        self.schedule = schedule or {}
        self.overrides = overrides or {}
        self.error_ids = error_ids or set()
        self.grounding_override = grounding_override or {}
        self.calls: list[str] = []
        self.counts: dict[str, int] = {}
        self.manifest_seen_at_first_call: bool | None = None

    # -- provenance checks ------------------------------------------------
    def _observe_manifest_once(self) -> None:
        if self.manifest_seen_at_first_call is not None:
            return
        self.manifest_seen_at_first_call = False
        if self.out_dir is None:
            return
        path = self.out_dir / MANIFEST_NAME
        if not path.exists():
            return
        manifest = json.loads(path.read_text(encoding="utf-8"))
        expected_fixture = (
            hashlib.sha256(self.fixture_path.read_bytes()).hexdigest()
            if self.fixture_path is not None
            else manifest["fixture"]["sha256"]
        )
        self.manifest_seen_at_first_call = (
            manifest["rubric"]["version"] == metrics.RUBRIC_VERSION
            and manifest["rubric"]["digest"] == metrics.rubric_digest()
            and manifest["rubric"]["threshold"] == 0.5
            and manifest["fixture"]["sha256"] == expected_fixture
            and [item["id"] for item in manifest["samples"]]
            == [item["id"] for item in self.fixture["samples"]]
        )

    # -- judge callable ---------------------------------------------------
    def __call__(self, record, context=None) -> dict:
        sample_id = record["case_id"]
        self.calls.append(sample_id)
        self.counts[sample_id] = self.counts.get(sample_id, 0) + 1
        self._observe_manifest_once()
        sample = self.by_id[sample_id]

        if sample_id in self.error_ids:
            raise judge_runtime.JudgeFailure(
                "simulated Jev outage",
                {
                    "error": {
                        "error_class": "ConnectError",
                        "error_family": "connection",
                        "wrapper_class": "ConnectError",
                        "http_status": None,
                        "message": "simulated Jev outage",
                    },
                    "metrics": [
                        {
                            "metric": "Task Resolution",
                            "applicability": "applicable",
                            "score": None,
                            "success": False,
                            "error": {
                                "error_class": "ConnectError",
                                "message": "simulated Jev outage",
                            },
                            "attempted": True,
                            "request_count": 1,
                            "attempts": [
                                {
                                    "attempt": 1,
                                    "wait_before_ms": None,
                                    "duration_ms": 1,
                                    "duration_source": "measured",
                                    "outcome": "connection_error",
                                    "http_status": None,
                                    "error_class": "ConnectError",
                                }
                            ],
                            "termination": "not_retried",
                            "breakdown": None,
                        }
                    ],
                    "request_count": 1,
                    "attempts": [
                        {
                            "attempt": 1,
                            "wait_before_ms": None,
                            "duration_ms": 1,
                            "duration_source": "measured",
                            "outcome": "connection_error",
                            "http_status": None,
                            "error_class": "ConnectError",
                        }
                    ],
                    "termination": "not_retried",
                    "rubric": {
                        "version": metrics.RUBRIC_VERSION,
                        "digest": metrics.rubric_digest(),
                        "plan_digest": None,
                        "evidence_scope": metrics.EVIDENCE_SCOPE,
                    },
                },
            )

        metadata = context["metadata"] if context else sample
        expected_output = (
            context["expected_output"] if context else sample["expected_output"]
        )
        plan = metrics.build_case_metrics(metadata, case_id=sample_id)
        score = self._score_for(sample, sample_id)
        entries = []
        for item in plan.applicability:
            status = item.status
            if item.metric == "Grounding":
                status = self.grounding_override.get(sample_id, status)
            if status != "applicable":
                entries.append(
                    {
                        "metric": item.metric,
                        "applicability": "not_applicable",
                        "reason": item.reason,
                        "threshold": None,
                        "score": None,
                        "success": None,
                        "error": None,
                        "attempted": False,
                        "model_source": None,
                        "request_count": 0,
                        "attempts": [],
                        "termination": "not_applicable",
                        "breakdown": None,
                    }
                )
                continue
            entries.append(
                {
                    "metric": item.metric,
                    "applicability": "applicable",
                    "reason": item.reason,
                    "threshold": 0.5,
                    "score": score,
                    "success": score >= 0.5,
                    "error": None,
                    "attempted": True,
                    "model_source": "fake",
                    "request_count": 1,
                    "attempts": [
                        {
                            "attempt": 1,
                            "wait_before_ms": None,
                            "duration_ms": 1,
                            "duration_source": "measured",
                            "outcome": "success",
                            "http_status": 200,
                            "error_class": None,
                        }
                    ],
                    "termination": "scored",
                    "breakdown": [
                        {
                            "question": "fake calibration question",
                            "type": "noul",
                            "weight": 1.0,
                            "value": score,
                            "applicable": True,
                            "probabilities": {"true": score, "false": 1.0 - score},
                            "confidence": 0.9,
                        }
                    ],
                }
            )
        applicable = [entry for entry in entries if entry["applicability"] == "applicable"]
        case_score = min(entry["score"] for entry in applicable) if applicable else None
        all_attempts = []
        for entry in applicable:
            for attempt in entry["attempts"]:
                all_attempts.append({**attempt, "metric": entry["metric"]})
        rubric = {
            "version": plan.rubric_version,
            "digest": plan.rubric_digest,
            "plan_digest": plan.plan_digest,
            "evidence_scope": plan.evidence_scope,
        }
        return {
            "score": case_score,
            "metric": "per-case metrics",
            "success": all(entry["success"] for entry in applicable),
            "reason": "fake judge verdict",
            "metrics": entries,
            "applicability": plan.applicability_map(),
            "rubric": rubric,
            "evidence_scope": plan.evidence_scope,
            "details": {
                "model": "fake-jev",
                "base_url": "https://example.invalid",
                "model_source": "fake",
                "request_count": len(all_attempts),
                "attempts": all_attempts,
                "termination": "scored",
                "score": case_score,
                "success": True,
                "error": None,
                "rubric": rubric,
                "metrics": entries,
                "expected_output_present": bool(expected_output),
            },
        }

    def _score_for(self, sample: dict, sample_id: str) -> float:
        if sample_id in self.schedule:
            index = min(self.counts[sample_id], len(self.schedule[sample_id])) - 1
            return float(self.schedule[sample_id][index])
        if sample_id in self.overrides:
            return float(self.overrides[sample_id])
        return 1.0 if sample["human_truth"]["verdict"] == "pass" else 0.0


# ---------------------------------------------------------------------------
# all correct
# ---------------------------------------------------------------------------


def test_all_correct_calibration_freezes_manifest_before_scoring_and_retains_every_attempt(
    tmp_path: Path,
) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    judge = FakeJudge(fixture, out_dir=out_dir, fixture_path=FIXTURE)

    outcome = calibrate_judge.run_calibration(FIXTURE, out_dir, judge=judge)

    assert outcome.exit_code == 0, outcome.report
    assert outcome.report["complete"] is True
    assert len(judge.calls) == len(fixture["samples"]) * ATTEMPTS_PER_SAMPLE
    # The manifest existed, with this rubric and fixture digest, before the
    # first scoring call.
    assert judge.manifest_seen_at_first_call is True

    manifest_path = out_dir / MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["rubric"] == {
        "version": metrics.RUBRIC_VERSION,
        "digest": metrics.rubric_digest(),
        "threshold": 0.5,
    }
    assert manifest["attempts_per_sample"] == 3
    assert [item["id"] for item in manifest["samples"]] == [
        sample["id"] for sample in fixture["samples"]
    ]
    for entry, sample in zip(manifest["samples"], fixture["samples"]):
        assert entry["sample_sha256"] == calibrate_judge.sample_digest(sample)
        assert entry["human_truth"]["verdict"] == sample["human_truth"]["verdict"]
        assert entry["grounding"] == sample["grounding_applicability"]
    assert outcome.report["fixture"]["sha256_before"] == outcome.report["fixture"][
        "sha256_after"
    ]
    assert outcome.report["threshold"] == 0.5

    attempts = _attempts(out_dir)
    assert len(attempts) == len(fixture["samples"]) * ATTEMPTS_PER_SAMPLE
    for sample in fixture["samples"]:
        rows = [row for row in attempts if row["sample_id"] == sample["id"]]
        assert [row["attempt"] for row in rows] == [1, 2, 3]
        for row in rows:
            assert row["rubric"]["digest"] == metrics.rubric_digest()
            assert row["rubric"]["matches_frozen"] is True
            assert row["error"] is None
            assert isinstance(row["score"], float)
            assert isinstance(row["confidence"], float)
            assert row["probabilities"]
            # One Jev HTTP request per applicable metric in the DR-06 plan.
            applicable = [
                item for item in row["metrics"] if item["applicability"] == "applicable"
            ]
            assert row["request"]["request_count"] == len(applicable) >= 2
            assert all(
                item["http_status"] == 200 for item in row["request"]["attempts"]
            )
    memory_rows = [
        row for row in attempts if row["sample_id"] == "cal-09-memory-grounding-not-applicable"
    ]
    assert all(
        row["grounding"]["observed"] == "not_applicable" for row in memory_rows
    )
    assert all(row["grounding"]["score"] is None for row in memory_rows)

    report = outcome.report
    assert report["sample_counts"]["planned"] == len(fixture["samples"])
    assert report["sample_counts"]["attempted"] == len(fixture["samples"]) * 3
    assert report["sample_counts"]["retained"] == len(fixture["samples"]) * 3
    assert report["sample_counts"]["misclassified"] == 0
    assert report["external_errors"] == []
    matrix = {row["sample_id"]: row for row in report["matrix"]}
    assert set(matrix) == {sample["id"] for sample in fixture["samples"]}
    assert all(row["matched"] for row in matrix.values())
    assert all(len(row["attempts"]) == 3 for row in matrix.values())


# ---------------------------------------------------------------------------
# misclassification and no cherry-picking
# ---------------------------------------------------------------------------


def test_false_negative_is_reported_and_not_hidden(tmp_path: Path) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    judge = FakeJudge(
        fixture, overrides={"cal-01-correct-demo-citation": 0.4}
    )

    outcome = calibrate_judge.run_calibration(FIXTURE, out_dir, judge=judge)

    assert outcome.exit_code == 1
    assert outcome.report["complete"] is False
    misses = [
        item
        for item in outcome.report["misclassifications"]
        if item["sample_id"] == "cal-01-correct-demo-citation"
    ]
    assert len(misses) == 3
    assert {item["type"] for item in misses} == {"false_negative"}
    assert all(item["score"] < 0.5 for item in misses)
    assert len(_attempts(out_dir)) == len(fixture["samples"]) * 3


def test_false_positive_is_reported_and_not_hidden(tmp_path: Path) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    judge = FakeJudge(
        fixture, overrides={"cal-03-wrong-unit": 0.9}
    )

    outcome = calibrate_judge.run_calibration(FIXTURE, out_dir, judge=judge)

    assert outcome.exit_code == 1
    misses = [
        item
        for item in outcome.report["misclassifications"]
        if item["sample_id"] == "cal-03-wrong-unit"
    ]
    assert len(misses) == 3
    assert {item["type"] for item in misses} == {"false_positive"}
    assert all(item["score"] >= 0.5 for item in misses)


def test_first_attempt_false_positive_is_kept_and_not_replaced_by_later_passes(
    tmp_path: Path,
) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    schedule = {"cal-02-wrong-number": [0.8, 0.2, 0.2]}
    judge = FakeJudge(fixture, schedule=schedule)

    outcome = calibrate_judge.run_calibration(FIXTURE, out_dir, judge=judge)

    assert outcome.exit_code == 1
    rows = [
        item
        for item in outcome.report["misclassifications"]
        if item["sample_id"] == "cal-02-wrong-number"
    ]
    assert len(rows) == 1
    assert rows[0]["type"] == "false_positive"
    assert rows[0]["attempt"] == 1
    attempts = [
        row for row in _attempts(out_dir) if row["sample_id"] == "cal-02-wrong-number"
    ]
    assert [row["attempt"] for row in attempts] == [1, 2, 3]
    assert [row["score"] for row in attempts] == [0.8, 0.2, 0.2]
    matrix = next(
        row
        for row in outcome.report["matrix"]
        if row["sample_id"] == "cal-02-wrong-number"
    )
    assert matrix["matched"] is False
    assert [item["matched"] for item in matrix["attempts"]] == [False, True, True]


def test_threshold_stays_half_at_the_boundary(tmp_path: Path) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    schedule = {
        "cal-01-correct-demo-citation": [0.5, 0.5, 0.5],
        "cal-02-wrong-number": [0.49, 0.49, 0.49],
    }
    judge = FakeJudge(fixture, schedule=schedule)

    outcome = calibrate_judge.run_calibration(FIXTURE, out_dir, judge=judge)

    assert calibrate_judge.THRESHOLD == 0.5
    assert outcome.exit_code == 0
    assert outcome.report["threshold"] == 0.5
    assert outcome.report["rubric"]["threshold"] == 0.5
    assert all(row["matched"] for row in outcome.report["matrix"])

    below = tmp_path / "below"
    judge_below = FakeJudge(
        fixture, schedule={"cal-01-correct-demo-citation": [0.499, 0.499, 0.499]}
    )
    outcome_below = calibrate_judge.run_calibration(FIXTURE, below, judge=judge_below)
    assert outcome_below.exit_code == 1
    assert {
        item["type"] for item in outcome_below.report["misclassifications"]
    } == {"false_negative"}


# ---------------------------------------------------------------------------
# external errors and memory applicability
# ---------------------------------------------------------------------------


def test_external_error_retains_all_attempts_and_never_counts_as_pass(
    tmp_path: Path,
) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    judge = FakeJudge(fixture, error_ids={"cal-03-wrong-unit"})

    outcome = calibrate_judge.run_calibration(FIXTURE, out_dir, judge=judge)

    assert outcome.exit_code == 1
    assert outcome.report["complete"] is False
    errors = [
        item
        for item in outcome.report["external_errors"]
        if item["sample_id"] == "cal-03-wrong-unit"
    ]
    assert len(errors) == 3
    assert all(item["error"]["error_class"] == "ConnectError" for item in errors)
    rows = [
        row for row in _attempts(out_dir) if row["sample_id"] == "cal-03-wrong-unit"
    ]
    assert [row["attempt"] for row in rows] == [1, 2, 3]
    assert all(row["score"] is None for row in rows)
    assert all(row["error"] is not None for row in rows)
    assert all(row["request"]["attempts"][0]["outcome"] == "connection_error" for row in rows)
    matrix = next(
        row
        for row in outcome.report["matrix"]
        if row["sample_id"] == "cal-03-wrong-unit"
    )
    assert matrix["matched"] is False
    assert all(item["status"] == "error" for item in matrix["attempts"])
    assert len(_attempts(out_dir)) == len(fixture["samples"]) * 3


def test_memory_sample_requires_grounding_not_applicable(tmp_path: Path) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    judge = FakeJudge(
        fixture,
        grounding_override={"cal-09-memory-grounding-not-applicable": "applicable"},
    )

    outcome = calibrate_judge.run_calibration(FIXTURE, out_dir, judge=judge)

    assert outcome.exit_code == 1
    misses = [
        item
        for item in outcome.report["misclassifications"]
        if item["sample_id"] == "cal-09-memory-grounding-not-applicable"
    ]
    assert len(misses) == 3
    assert {item["type"] for item in misses} == {"grounding_mismatch"}
    rows = [
        row
        for row in _attempts(out_dir)
        if row["sample_id"] == "cal-09-memory-grounding-not-applicable"
    ]
    assert all(row["grounding"]["observed"] == "applicable" for row in rows)
    assert all(row["grounding"]["expected"] == "not_applicable" for row in rows)
    # The case score itself can be good; the applicability is still wrong.
    assert all(row["score"] >= 0.5 for row in rows)


# ---------------------------------------------------------------------------
# missing sample and frozen truth/manifest
# ---------------------------------------------------------------------------


def test_missing_required_sample_stops_before_any_scoring(tmp_path: Path) -> None:
    fixture = load_fixture()
    fixture["samples"] = [
        sample
        for sample in fixture["samples"]
        if "negated_conclusion" not in sample["coverage"]
    ]
    fixture_path = write_fixture(tmp_path, fixture)
    out_dir = tmp_path / "calibration"
    judge = FakeJudge(fixture)

    outcome = calibrate_judge.run_calibration(fixture_path, out_dir, judge=judge)

    assert outcome.exit_code == 2
    assert judge.calls == []
    assert outcome.report["complete"] is False
    assert "negated_conclusion" in json.dumps(outcome.report, ensure_ascii=False)
    assert not (out_dir / MANIFEST_NAME).exists()
    assert not list(out_dir.glob("judge-calibration.attempts-*.jsonl"))


def test_frozen_manifest_and_truth_cannot_change_after_scoring(tmp_path: Path) -> None:
    fixture = load_fixture()
    out_dir = tmp_path / "calibration"
    first = calibrate_judge.run_calibration(
        FIXTURE, out_dir, judge=FakeJudge(fixture)
    )
    assert first.exit_code == 0

    manifest_path = out_dir / MANIFEST_NAME
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8"))

    # Rewriting the manifest with a different rubric is refused and leaves
    # the frozen bytes untouched.
    with pytest.raises(calibrate_judge.FrozenArtifactError):
        calibrate_judge.write_frozen_manifest(
            manifest_path,
            {
                **manifest,
                "rubric": {**manifest["rubric"], "digest": "0" * 64},
            },
        )
    assert manifest_path.read_bytes() == manifest_bytes

    # Changing the fixture's human truth after the first calibration is
    # refused before any new scoring, and the frozen truth is not rewritten.
    mutated = load_fixture()
    _sample_by_id(mutated, "cal-01-correct-demo-citation")["human_truth"][
        "verdict"
    ] = "fail"
    mutated_path = write_fixture(tmp_path, mutated, name="mutated.json")
    second_judge = FakeJudge(mutated)
    second = calibrate_judge.run_calibration(
        mutated_path, out_dir, judge=second_judge
    )

    assert second.exit_code == 2
    assert second_judge.calls == []
    assert "frozen" in json.dumps(second.report, ensure_ascii=False).lower()
    assert manifest_path.read_bytes() == manifest_bytes
    assert len(_attempts(out_dir)) == len(fixture["samples"]) * 3
    assert json.loads(mutated_path.read_text(encoding="utf-8")) == mutated
    assert first.report["manifest"]["sha256"] == hashlib.sha256(
        manifest_bytes
    ).hexdigest()
