"""DR-22: the degradation status matrix keeps terminal and stage reasons apart.

The operator-visible seam is one evaluation run plus its ``report.json``. The
Agent backend is the local HTTP stub and the judge is the controlled offline
collaborator from ``test_judge_contract``. No external model, rerank provider
or service is called.

What these tests require:
  * every offline row keeps the original request, terminal status and stage
    reasons, so a refusal, an empty scope, a missing rerank configuration and a
    provider failure are distinguishable
  * the offline controlled column and the online column are listed separately;
    the online column can only be ``pending``/``not_run``
  * a completed answer whose retrieval degraded is a failed matrix, never a
    silent success
  * a missing rerank configuration is not counted as a degradation or as
    coverage
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

import run_suite  # noqa: E402
from test_judge_contract import CASES, make_judge  # noqa: E402
from test_ledger import stub_backend, write_dataset  # noqa: E402
from test_reporting import case_reply, load_report  # noqa: E402

CASE = "hard-04-faq-exact-answer"


def retrieval_event(reasons: tuple[str, ...] = (), ordering: dict | None = None) -> dict:
    data: dict = {"resultCount": 2, "degradedReasons": list(reasons)}
    if ordering is not None:
        data["finalContextOrdering"] = ordering
    return {"type": "progress", "stage": "retrieval", "status": "completed", "data": data}


def done_event(status: str, degradation: dict) -> dict:
    return {
        "type": "done",
        "stage": "done",
        "status": status,
        "result": {"status": status, "degradation": degradation},
    }


def run_case(tmp_path: Path, events: list[dict]) -> run_suite.RunOutcome:
    dataset = write_dataset(tmp_path / "dataset.json", [CASES[CASE]])
    reply, references = case_reply(CASES[CASE])
    with stub_backend(
        {CASES[CASE]["input"]: reply},
        references={CASES[CASE]["input"]: references},
    ) as backend:
        backend.server.extra_payload = {"events": events}
        return run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=make_judge(),
            base_url=backend.base_url,
            password="stub-password",
        )


def matrix(report: dict) -> dict:
    return report["sections"]["degradation_status"]


def row(report: dict) -> dict:
    rows = matrix(report)["offline"]["results"]
    assert len(rows) == 1
    return rows[0]


def test_matrix_columns_keep_raw_request_terminal_and_stage_reason(tmp_path: Path) -> None:
    outcome = run_case(
        tmp_path,
        [
            retrieval_event(reasons=("no_knowledge_scope",)),
            done_event(
                "insufficient_retrieval",
                {"status": "insufficient", "unavailableChannels": []},
            ),
        ],
    )
    report = load_report(outcome)

    result = row(report)
    assert matrix(report)["schema"] == "degradation-status-matrix-v1"
    assert result["case_id"] == CASE
    assert result["request"]["message"] == CASES[CASE]["input"]
    assert result["terminal_status"] == "insufficient_retrieval"
    assert result["degradation"]["status"] == "insufficient"
    assert result["stage_reasons"] == ["no_knowledge_scope"]
    assert result["classification"] == "empty_scope"
    assert result["offline"]["status"] == "observed"
    assert result["offline"]["degraded"] is False


def test_offline_and_online_columns_are_listed_separately_and_online_stays_pending(
    tmp_path: Path,
) -> None:
    outcome = run_case(
        tmp_path,
        [
            retrieval_event(
                reasons=("reranker_not_configured",),
                ordering={"source": "fused", "reason": "not_configured"},
            ),
            done_event("completed", {"status": "none", "unavailableChannels": []}),
        ],
    )
    report = load_report(outcome)
    section = matrix(report)

    assert section["offline"]["status"] == "controlled"
    assert section["offline"]["counted_as_pass"] is False
    assert section["offline"]["results"]
    assert section["online"]["status"] == "not_run"
    assert section["online"]["results"] == []
    assert section["online"]["counted_as_pass"] is False
    for item in section["offline"]["results"]:
        assert item["online"]["status"] == "pending"
        assert item["online"]["evidence"] is None
    assert section["counted_as_pass"] is False


def test_silent_rerank_degradation_fails_the_matrix(tmp_path: Path) -> None:
    outcome = run_case(
        tmp_path,
        [
            retrieval_event(
                reasons=("reranker_unavailable",),
                ordering={"source": "fused", "reason": "unavailable"},
            ),
            # A completed answer that reports no degradation while its
            # retrieval says the reranker failed — the conflation DR-22 closes.
            done_event("completed", {"status": "none", "unavailableChannels": []}),
        ],
    )
    report = load_report(outcome)
    section = matrix(report)

    assert section["silent_degradation"]["failed"] is True
    assert row(report)["sample_id"] in section["silent_degradation"]["sample_ids"]
    assert section["gate"]["status"] == "failed"
    assert section["gate"]["passed"] is False
    assert section["gate"]["counted_as_pass"] is False
    assert report["gate"]["degradation_passed"] is False
    assert any(
        reason.get("kind") == "silent_degradation"
        for reason in report["gate"]["reasons"]
    )


def test_unconfigured_rerank_is_not_counted_as_degraded_or_as_coverage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("RERANK_API_KEY", raising=False)

    outcome = run_case(
        tmp_path,
        [
            retrieval_event(
                reasons=("reranker_not_configured",),
                ordering={"source": "fused", "reason": "not_configured"},
            ),
            done_event("completed", {"status": "none", "unavailableChannels": []}),
        ],
    )
    report = load_report(outcome)
    section = matrix(report)
    result = row(report)

    assert result["classification"] == "rerank_not_configured"
    assert result["offline"]["degraded"] is False
    assert section["silent_degradation"]["failed"] is False
    assert section["gate"]["status"] == "passed"
    rerank = report["sections"]["capabilities"]["rerank"]
    assert rerank["status"] == "not_configured"
    assert rerank["counted_as_pass"] is False


def test_provider_failure_is_not_a_refusal_nor_no_cited_claims(tmp_path: Path) -> None:
    outcome = run_case(
        tmp_path,
        [
            done_event(
                "provider_error",
                {"status": "insufficient", "unavailableChannels": []},
            ),
        ],
    )
    report = load_report(outcome)
    result = row(report)

    assert result["terminal_status"] == "provider_error"
    assert result["classification"] == "provider_error"
    assert result["degradation"].get("reason") is None
    assert result["offline"]["degraded"] is False
    assert matrix(report)["gate"]["status"] == "passed"
