"""Complete baseline reporting contracts (DR-08).

The operator-visible seam is one evaluation run plus the report it leaves on
disk: ``run_suite.execute_run`` / ``run_suite.main`` for execution and
``run_suite.rebuild_run`` for reconstructing the report from raw sample
records. A local HTTP stub is the Agent backend and the controlled offline
judge from ``test_judge_contract`` replaces Jev, so no external call is made.

What these tests require:
  * every planned case has a final record or an explicit error/not-started
  * behaviour (deterministic v2 gate), judge, error and capability results are
    reported separately; missing/not-applicable never becomes a pass
  * counts, thresholds, 0.5 judge threshold and the 0.7 retest trigger are
    public and recomputable from the raw records
  * a rebuild re-projects metrics, rubric, environment and the report from
    sample records instead of trusting a stale summary
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

import reporting  # noqa: E402
import run_suite  # noqa: E402
from metrics import RUBRIC_VERSION  # noqa: E402
from test_judge_contract import CASES, make_judge  # noqa: E402
from test_ledger import (  # noqa: E402
    TOKEN,
    all_run_text,
    read_json,
    stub_backend,
    write_dataset,
)

ANSWER_REFERENCE = {
    "id": "ref-1",
    "title": "评审参考资料",
    "excerpt": "评审参考资料",
}


def case_reply(golden: dict) -> tuple[str, list[dict]]:
    """A deterministic-passing reply for a v2 golden, plus its references."""
    metadata = golden["additional_metadata"]
    kind = metadata["kind"]
    if kind == "answer":
        points = metadata.get("answer_points") or []
        evidence = "；".join(points)
        return f"{evidence} [cite:ref-1]。", [
            {**ANSWER_REFERENCE, "excerpt": evidence}
        ]
    if kind == "refuse":
        return "根据现有知识库未找到相关证据，无法回答该问题。", []
    if kind == "memory-not-cited":
        return "你让我记住的是：演示记忆显示周五发布。", []
    raise AssertionError(f"unexpected kind {kind!r}")


def selected_dataset(tmp_path: Path, names: list[str]) -> Path:
    return write_dataset(
        tmp_path / "dataset.json", [copy.deepcopy(CASES[name]) for name in names]
    )


def selected_payloads(names: list[str]) -> tuple[dict, dict]:
    replies: dict[str, str] = {}
    references: dict[str, list[dict]] = {}
    for name in names:
        reply, refs = case_reply(CASES[name])
        replies[CASES[name]["input"]] = reply
        references[CASES[name]["input"]] = refs
    return replies, references


def run_cases(
    tmp_path: Path,
    names: list[str],
    *,
    baseline: bool = False,
    judge=None,
    dataset_path: Path | None = None,
    cases: list[str] | None = None,
    samples: int = 1,
) -> run_suite.RunOutcome:
    dataset = dataset_path or selected_dataset(tmp_path, names)
    replies, references = selected_payloads(names)
    with stub_backend(replies, references=references) as backend:
        return run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            cases=cases,
            samples=samples,
            judge=judge or make_judge(),
            base_url=backend.base_url,
            password="stub-password",
            baseline=baseline,
        )


def load_report(outcome: run_suite.RunOutcome) -> dict:
    assert outcome.run_dir is not None
    path = outcome.run_dir / "report.json"
    assert path.exists(), "run must leave a report.json"
    return read_json(path)


def test_report_lists_behaviour_judge_errors_capabilities_and_latency(
    tmp_path: Path,
) -> None:
    names = [
        "hard-04-faq-exact-answer",
        "hard-05-no-fabrication",
        "hard-06-memory-never-cited",
    ]
    outcome = run_cases(tmp_path, names)

    assert outcome.exit_code == 0, outcome.error
    report = load_report(outcome)

    # Public counts: every planned case is attempted and scored, and exactly
    # the memory-only Grounding metric is not_applicable.
    counts = report["counts"]
    assert counts["planned"] == 3
    assert counts["attempted"] == 3
    assert counts["scored"] == 3
    assert counts["error"] == 0
    assert counts["skipped"] == 0
    assert counts["not_started"] == 0
    assert counts["not_applicable"] == 1

    # Per-case behaviour (DR-03 deterministic gate) and per-metric judge
    # results with applicability are separate records.
    cases = {case["case_id"]: case for case in report["cases"]}
    assert set(cases) == set(names)
    for name in names:
        assert cases[name]["behaviour"]["passed"] is True
        assert cases[name]["behaviour"]["status"] == "passed"
    memory_metrics = {
        item["metric"]: item
        for item in report["sections"]["judge"]["metrics"]
        if item["case_id"] == "hard-06-memory-never-cited"
    }
    assert memory_metrics["Grounding"]["applicability"] == "not_applicable"
    assert memory_metrics["Grounding"]["score"] is None
    assert memory_metrics["Task Resolution"]["applicability"] == "applicable"
    assert memory_metrics["Task Resolution"]["score"] >= 0.5

    # Separate sections are all present and state what they measure.
    sections = report["sections"]
    for key in ("facts", "citations", "isolation", "judge", "capabilities", "latency"):
        assert key in sections
    assert sections["judge"]["threshold"] == 0.5
    assert sections["judge"]["retest_trigger"] == 0.7
    assert sections["capabilities"]["rerank"]["status"] == "not_configured"
    assert sections["latency"]["judge_excluded"] is True
    assert sections["latency"]["count"] == 3
    assert all(item["chat_ms"] >= 0 for item in sections["latency"]["cases"])

    # Frozen snapshots: dataset/rubric/model/config/scope without secrets.
    snapshots = report["snapshots"]
    expected_sha = hashlib.sha256(
        (tmp_path / "dataset.json").read_bytes()
    ).hexdigest()
    assert snapshots["dataset"]["sha256"] == expected_sha
    assert snapshots["rubric"]["version"] == RUBRIC_VERSION
    assert len(snapshots["rubric"]["digest"]) == 64
    assert snapshots["scope"]["cases"]
    assert snapshots["config"]["cache"]["reading"] == "disabled"
    assert snapshots["config"]["cache"]["writing"] == "disabled"
    assert snapshots["model"]["model_source"] == "injected"

    # Every sample used its own session, and the raw projection is enough to
    # recompute the counts.
    raw = report["raw"]["samples"]
    assert len(raw) == 3
    assert len({item["session_id"] for item in raw}) == 3
    assert sum(1 for item in raw if item["status"] == "scored") == counts["scored"]
    assert (
        sum(
            1
            for item in report["raw"]["metric_results"]
            if item["applicability"] == "not_applicable"
        )
        == counts["not_applicable"]
    )

    # No credential or raw answer body leaks into the report.
    text = (outcome.run_dir / "report.json").read_text(encoding="utf-8")
    assert TOKEN not in text
    assert "getenv" not in text.lower()


def test_rebuild_reprojects_metrics_rubric_environment_and_report(
    tmp_path: Path,
) -> None:
    names = [
        "hard-04-faq-exact-answer",
        "hard-05-no-fabrication",
        "hard-06-memory-never-cited",
    ]
    outcome = run_cases(tmp_path, names)
    assert outcome.exit_code == 0
    original = load_report(outcome)
    original_metrics = copy.deepcopy(original["raw"]["metric_results"])
    original_behaviour = {
        case["case_id"]: copy.deepcopy(case["behaviour"])
        for case in original["cases"]
    }
    sample_hashes = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (outcome.run_dir / "samples").glob("*.json")
    }

    # A maintainer may only have the sample records: the summary is destroyed.
    (outcome.run_dir / "summary.json").unlink()
    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.exit_code == 0, rebuilt.error
    payload = rebuilt.public_payload()
    assert payload["report"]["counts"] == original["counts"]
    assert payload["metrics"] == original_metrics
    assert payload["rubric"]["version"] == RUBRIC_VERSION
    assert payload["environment"]["configuration"]["base_url"].startswith("http://127.0.0.1:")
    assert payload["report"]["sections"]["judge"]["metrics"] == original[
        "sections"
    ]["judge"]["metrics"]
    assert {
        case["case_id"]: case["behaviour"]
        for case in payload["report"]["cases"]
    } == original_behaviour

    # Rebuilding never rewrites the raw samples.
    assert {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (outcome.run_dir / "samples").glob("*.json")
    } == sample_hashes
    assert read_json(outcome.run_dir / "report.json")["run_id"] == outcome.run_id


def test_complete_twenty_case_baseline_reports_product_failures_and_fresh_sessions(tmp_path: Path) -> None:
    outcome = run_cases(tmp_path, list(CASES), baseline=True)
    assert outcome.exit_code == 1, outcome.error
    report = load_report(outcome)
    assert report["counts"]["planned"] == 20
    assert report["counts"]["scored"] == 20
    assert report["counts"]["hard_cases"] == 6
    assert report["thresholds"]["hard"]["passed"] == 4
    assert report["thresholds"]["hard"]["met"] is False
    assert report["thresholds"]["others"]["passed"] == 14
    assert report["thresholds"]["overall"]["passed"] == 18
    assert report["gate"]["status"] == "failed"
    assert report["gate"]["incomplete"] is False
    assert len({item["session_id"] for item in report["raw"]["samples"]}) == 20


def test_baseline_rejects_partial_selection_before_creating_a_run(tmp_path: Path) -> None:
    dataset = selected_dataset(tmp_path, ["hard-04-faq-exact-answer"])
    outcome = run_suite.execute_run(
        tmp_path / "runs",
        dataset_path=dataset,
        judge=make_judge(),
        baseline=True,
    )
    assert outcome.exit_code == run_suite.EXIT_FATAL
    assert "all twenty" in outcome.error
    assert not (tmp_path / "runs").exists()


@pytest.mark.parametrize("damage", ["missing", "truncated", "skipped"])
def test_rebuild_marks_damaged_or_skipped_samples_incomplete(tmp_path: Path, damage: str) -> None:
    outcome = run_cases(tmp_path, ["hard-04-faq-exact-answer"])
    sample_path = next((outcome.run_dir / "samples").glob("*.json"))
    if damage == "missing":
        sample_path.unlink()
    elif damage == "truncated":
        sample_path.write_text('{"run_id":', encoding="utf-8")
    else:
        record = read_json(sample_path)
        record["status"] = "skipped"
        record["judge"] = {"status": "skipped", "score": None}
        sample_path.write_text(json.dumps(record), encoding="utf-8")
    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.exit_code != 0
    assert rebuilt.score is None
    report = load_report(rebuilt)
    assert report["gate"]["status"] == "incomplete"
    assert report["counts"]["scored"] == 0
    key = {"missing": "not_started", "truncated": "error", "skipped": "skipped"}[damage]
    assert report["counts"][key] == 1


def test_required_backend_errors_leave_all_records_and_never_score(tmp_path: Path) -> None:
    name = "hard-04-faq-exact-answer"
    dataset = selected_dataset(tmp_path, [name])
    calls = []
    with stub_backend({}, fail_messages={CASES[name]["input"]}) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs", dataset_path=dataset, judge=lambda *_: calls.append(1),
            base_url=backend.base_url, password="stub-password",
        )
    assert outcome.exit_code == 1
    assert outcome.score is None
    assert calls == []
    report = load_report(outcome)
    assert report["gate"]["status"] == "incomplete"
    assert report["counts"]["attempted"] == 1
    assert report["counts"]["error"] == 1
    assert report["counts"]["scored"] == 0
    assert TOKEN not in all_run_text(outcome.run_dir)


def test_rebuild_refuses_changed_environment_snapshot(tmp_path: Path) -> None:
    outcome = run_cases(tmp_path, ["hard-04-faq-exact-answer"])
    environment_path = outcome.run_dir / "environment.json"
    environment = read_json(environment_path)
    environment["configuration"]["cache"]["reading"] = "enabled"
    environment_path.write_text(json.dumps(environment), encoding="utf-8")
    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.exit_code != 0
    assert rebuilt.score is None


def test_connection_failure_accounts_for_every_planned_case(tmp_path: Path) -> None:
    names = ["hard-04-faq-exact-answer", "hard-05-no-fabrication"]
    dataset = selected_dataset(tmp_path, names)
    with stub_backend({}) as backend:
        closed_url = backend.base_url
    outcome = run_suite.execute_run(
        tmp_path / "runs", dataset_path=dataset, judge=make_judge(),
        base_url=closed_url, password="stub-password", chat_timeout_s=0.1,
    )
    assert outcome.exit_code == 1
    assert outcome.score is None
    report = load_report(outcome)
    assert report["counts"]["planned"] == 2
    assert report["counts"]["error"] == 2
    assert report["counts"]["scored"] == 0
    assert report["counts"]["not_started"] == 0
    assert len(list((outcome.run_dir / "samples").glob("*.json"))) == 2


@pytest.mark.parametrize("damage", ["missing", "duplicate", "unexpected", "applicability", "not_applicable"])
def test_rebuild_rejects_incomplete_metric_membership(tmp_path: Path, damage: str) -> None:
    outcome = run_cases(tmp_path, ["hard-06-memory-never-cited"])
    assert outcome.exit_code == 0
    sample_path = next((outcome.run_dir / "samples").glob("*.json"))
    record = read_json(sample_path)
    entries = record["judge"]["metrics"]
    # A stale mirror must never repair the authoritative metric list.
    record["judge"].setdefault("details", {})["metrics"] = copy.deepcopy(entries)
    if damage == "missing":
        entries[:] = [row for row in entries if row["metric"] != "Response Conduct"]
    elif damage == "duplicate":
        entries.append(copy.deepcopy(entries[0]))
    elif damage == "unexpected":
        entries.append({"metric": "Unknown", "applicability": "applicable", "score": 1})
    elif damage == "applicability":
        entries[0]["applicability"] = "not_applicable"
    else:
        entries[:] = [row for row in entries if row["metric"] != "Grounding"]
    sample_path.write_text(json.dumps(record), encoding="utf-8")
    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.incomplete is True
    assert rebuilt.exit_code != 0
    assert rebuilt.score is None
    report = load_report(rebuilt)
    assert report["gate"]["judge_passed"] is False
    assert report["cases"][0]["judge"]["score"] is None
    assert any(reason["kind"] == "metric_contract_invalid" for reason in report["gate"]["reasons"])
    assert read_json(outcome.run_dir / "manifest.json")["planned"][0]["expected_metrics"] == {
        "Task Resolution": "applicable", "Grounding": "not_applicable", "Response Conduct": "applicable"}
