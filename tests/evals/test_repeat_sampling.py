"""DR-09 operator seams: campaign command, durable rebuild and distributions.

Controlled HTTP Agent and judge providers exercise the same command used by
live sampling. Literal worked statistics are independent expected results.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import repeat_sampling
import run_suite
from test_judge_contract import CASES
from test_ledger import read_json, stub_backend, write_dataset
from test_reporting import selected_payloads


def test_distribution_keeps_first_failure_and_uses_sample_variance():
    rows = [
        {"status": "scored", "score": score, "applicability": "applicable"}
        for score in [0.2, 0.8, 0.9]
    ]
    result = repeat_sampling.distribution(rows)
    assert result["n"] == 3
    assert result["mean"] == pytest.approx(0.6333333333333333)
    assert result["sample_variance"] == pytest.approx(0.1433333333333333)
    assert result["min"] == 0.2 and result["max"] == 0.9
    assert result["scoring_failure_rate"] == pytest.approx(1 / 3)
    assert result["execution_error_rate"] == 0
    assert result["unstable"] is True
    assert result["values"] == [0.2, 0.8, 0.9]


@pytest.mark.parametrize("rows, expected", [
    ([], {"n": 0, "mean": None, "attempted": 0, "scoring_failure_rate": None,
          "execution_error_rate": None, "incomplete": False}),
    ([{"status": "scored", "score": 0.8}],
     {"n": 1, "mean": 0.8, "attempted": 1, "scoring_failure_rate": 0.0}),
    ([{"status": "judge_error", "error": "timeout"}] * 3,
     {"n": 0, "attempted": 3, "error": 3, "scoring_failure_rate": None,
      "execution_error_rate": 1.0, "incomplete": True}),
    ([{"status": "scored", "score": None, "applicability": "not_applicable"}] * 3,
     {"n": 0, "attempted": 3, "not_applicable": 3, "error": 0, "incomplete": False}),
    ([{"status": "scored", "score": 0.2}, {"status": "error", "error": "bad"},
      {"status": "not_started"}, {"status": "skipped"}],
     {"n": 1, "planned": 4, "attempted": 2, "error": 1, "scoring_failure_rate": 1.0,
      "execution_error_rate": 0.5, "skipped": 1, "not_started": 1, "incomplete": True}),
])
def test_distribution_accounts_for_absent_inapplicable_and_error_rows(rows, expected):
    result = repeat_sampling.distribution(rows)
    for key, value in expected.items():
        assert result[key] == value
    assert result["sample_variance"] is None
    assert "n < 2" in result["variance_reason"]


def test_selection_includes_preselected_low_applicable_metrics_and_behaviour_failure():
    def record(name, score=0.9, *, behaviour=True, metric="Task Resolution", applicable="applicable"):
        return {"case_id": name, "behaviour": {"passed": behaviour}, "judge": {
            "metrics": [{"metric": metric, "score": score, "applicability": applicable}]
        }}
    records = [record("hard-03-clarify"), record("hard-04-exact"), record("hard-06-memory"),
               record("case-16-memory"), record("low-tr", 0.6),
               record("low-ground", 0.69, metric="Grounding"),
               record("behaviour", behaviour=False), record("na", 0, applicable="not_applicable"),
               record("other", 0.1, metric="Other"), record("pass", 0.7)]
    result = repeat_sampling.select_retests(records)
    assert [item["case_id"] for item in result] == [
        "hard-03-clarify", "hard-04-exact", "hard-06-memory", "case-16-memory",
        "low-tr", "low-ground", "behaviour"]


def controlled_judge():
    calls = {}
    rubric = run_suite.rubric_snapshot()

    def judge(record, context):
        name = record["case_id"]
        index = calls.get(name, 0)
        calls[name] = index + 1
        score = [0.2, 0.8, 0.9, 0.8, 0.9][min(index, 4)] if name.startswith("hard-04") else 0.9
        assert context["read_answer"]()["answer_sha256"] == record["agent"]["answer_sha256"]
        return {"score": score, "success": score >= 0.5, "rubric": rubric,
                "metrics": [
                    {"metric": "Task Resolution", "applicability": "applicable", "score": score, "error": None},
                    {"metric": "Grounding", "applicability": "not_applicable" if
                     context["metadata"]["kind"] == "memory-not-cited" else "applicable",
                     "score": None if context["metadata"]["kind"] == "memory-not-cited" else 0.9, "error": None},
                    {"metric": "Response Conduct", "applicability": "applicable", "score": 0.7, "error": None}],
                "details": {"model": "controlled", "model_source": "injected"}}
    return judge


def baseline_run(tmp_path, backend, judge):
    dataset = write_dataset(tmp_path / "dataset.json", copy.deepcopy(list(CASES.values())))
    outcome = run_suite.execute_run(tmp_path / "baseline-runs", dataset_path=dataset,
        judge=judge, base_url=backend.base_url, password="stub-password", baseline=True)
    assert outcome.incomplete is False, outcome.error
    return outcome


def test_campaign_freezes_plan_and_retains_three_separate_observations(tmp_path):
    replies, references = selected_payloads(list(CASES))
    failed = "hard-04-faq-exact-answer"
    original_reply = replies[CASES[failed]["input"]]
    replies[CASES[failed]["input"]] = "missing the required facts"
    judge = controlled_judge()
    with stub_backend(replies, references=references) as backend:
        baseline = baseline_run(tmp_path, backend, judge)
        backend.server.replies[CASES[failed]["input"]] = original_reply
        # Mutating the original dataset after baseline must not change repeats.
        (tmp_path / "dataset.json").write_text("[]", encoding="utf-8")
        report = repeat_sampling.run_campaign(baseline.run_dir, tmp_path / "campaign",
            judge=judge, base_url=backend.base_url, password="stub-password")
        manifest = read_json(tmp_path / "campaign" / "manifest.json")
        selected = manifest["selection"]
        assert backend.chat_requests == 20 + 2 * len(selected)
        sessions = [request["body"]["sessionId"] for request in backend.requests if request["path"] == "/api/chat"]
        assert len(set(sessions)) == len(sessions)
    assert report["incomplete"] is False
    agent = report["groups"]["independent_agent"]["cases"][failed]
    fixed = report["groups"]["fixed_answer_judge"]["cases"][failed]
    assert agent["metrics"]["Task Resolution"]["values"] == [0.2, 0.8, 0.9]
    assert fixed["metrics"]["Task Resolution"]["values"] == [0.2, 0.8, 0.9]
    assert agent["metrics"]["Task Resolution"]["sample_variance"] == pytest.approx(0.1433333333333333)
    assert len({row["session_id"] for row in agent["samples"]}) == 3
    assert len({row["answer_sha256"] for row in fixed["samples"]}) == 1
    assert agent["behaviour"]["failed_samples"]
    assert agent["unstable"] is True
    assert fixed["unstable"] is True
    assert report["product_gate"]["passed"] is False
    assert report["p0"]["status"] == "pending_evidence"
    assert manifest["frozen"] is True
    assert manifest["groups"]["independent_agent"]["samples_per_case"] == 3
    assert manifest["groups"]["fixed_answer_judge"]["samples_per_case"] == 3
    assert report["snapshots"]["config"]["cache"]["reading"] == "disabled"
    assert agent["metrics"]["Response Conduct"]["values"] == [0.7, 0.7, 0.7]


def test_rebuild_accounts_for_truncated_record_without_replacing_source(tmp_path):
    replies, references = selected_payloads(list(CASES))
    judge = controlled_judge()
    with stub_backend(replies, references=references) as backend:
        baseline = baseline_run(tmp_path, backend, judge)
        report = repeat_sampling.run_campaign(baseline.run_dir, tmp_path / "campaign",
            judge=judge, base_url=backend.base_url, password="stub-password")
    original = (tmp_path / "campaign" / "baseline.json").read_bytes()
    root = Path(report["raw"]["observation_ledger"])
    victim = next(root.glob("samples/independent_agent-*.json"))
    row = read_json(victim)
    victim.write_text('{"truncated":', encoding="utf-8")
    rebuilt = repeat_sampling.rebuild_campaign(tmp_path / "campaign")
    assert rebuilt["incomplete"] is True
    stats = rebuilt["groups"]["independent_agent"]["cases"][row["case_id"]]["metrics"]["Task Resolution"]
    assert stats["planned"] == 3
    assert stats["scored"] == 2
    assert stats["not_started"] == 1
    assert (tmp_path / "campaign" / "baseline.json").read_bytes() == original
    assert victim.read_text(encoding="utf-8") == '{"truncated":'
    assert repeat_sampling.main(["--out", str(tmp_path / "campaign"), "--rebuild"]) == 1


def test_rebuild_refuses_changed_frozen_answer_and_campaign_overwrite(tmp_path):
    replies, references = selected_payloads(list(CASES))
    judge = controlled_judge()
    with stub_backend(replies, references=references) as backend:
        baseline = baseline_run(tmp_path, backend, judge)
        repeat_sampling.run_campaign(baseline.run_dir, tmp_path / "campaign",
            judge=judge, base_url=backend.base_url, password="stub-password")
        calls = backend.chat_requests
        with pytest.raises(FileExistsError):
            repeat_sampling.run_campaign(baseline.run_dir, tmp_path / "campaign",
                judge=judge, base_url=backend.base_url, password="stub-password")
        assert backend.chat_requests == calls
    source = tmp_path / "campaign" / "baseline.json"
    source.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="snapshot digest changed"):
        repeat_sampling.rebuild_campaign(tmp_path / "campaign")
    assert read_json(tmp_path / "campaign" / "report.json")["incomplete"] is True
    assert repeat_sampling.main(["--out", str(tmp_path / "campaign"), "--rebuild"]) == 2


def test_campaign_external_agent_failure_keeps_fixed_answer_judge_independent(tmp_path):
    replies, references = selected_payloads(list(CASES))
    judge = controlled_judge()
    with stub_backend(replies, references=references) as backend:
        baseline = baseline_run(tmp_path, backend, judge)
        backend.server.fail_messages.update(replies)
        report = repeat_sampling.run_campaign(baseline.run_dir, tmp_path / "campaign",
            judge=judge, base_url=backend.base_url, password="stub-password")
    assert report["incomplete"] is True
    for case in report["groups"]["independent_agent"]["cases"].values():
        stats = case["metrics"]["Task Resolution"]
        assert stats["planned"] == stats["attempted"] == 3
        assert stats["scored"] == 1
        assert stats["error"] == 2
        assert stats["execution_error_rate"] == pytest.approx(2 / 3)
        assert stats["scoring_failure_rate"] in {0, 1}
        assert case["unstable"] is True
    for case in report["groups"]["fixed_answer_judge"]["cases"].values():
        stats = case["metrics"]["Task Resolution"]
        assert stats["scored"] == 3
        assert stats["execution_error_rate"] == 0
        assert case["incomplete"] is False


def test_failed_first_metric_does_not_count_later_unstarted_metrics_as_attempted(tmp_path):
    replies, references = selected_payloads(list(CASES))
    with stub_backend(replies, references=references) as backend:
        baseline = baseline_run(tmp_path, backend, controlled_judge())

        def judge_unavailable(record, context):
            error = RuntimeError("HTTP451 region unavailable")
            error.details = {"metrics": [
                {"metric": "Task Resolution", "applicability": "applicable", "score": None,
                 "error": "HTTP451", "attempted": True, "termination": "not_retried"},
                {"metric": "Grounding", "applicability": "not_applicable" if
                 context["metadata"]["kind"] == "memory-not-cited" else "applicable",
                 "score": None, "error": None, "attempted": True, "termination": None},
                {"metric": "Response Conduct", "applicability": "applicable", "score": None,
                 "error": None, "attempted": True, "termination": None}]}
            raise error

        report = repeat_sampling.run_campaign(baseline.run_dir, tmp_path / "campaign",
            judge=judge_unavailable, base_url=backend.base_url, password="stub-password")
    for group in report["groups"].values():
        for case in group["cases"].values():
            task = case["metrics"]["Task Resolution"]
            assert task["scored"] == 1 and task["error"] == 2
            conduct = case["metrics"]["Response Conduct"]
            assert conduct["attempted"] == 1
            assert conduct["not_started"] == 2
            assert conduct["n"] == 1
            assert conduct["sample_variance"] is None
    assert report["incomplete"] is True
