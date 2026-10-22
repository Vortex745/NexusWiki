"""DR-13: rerank coverage, fallback and answer correctness are reported apart.

The operator-visible seam is one evaluation run plus its ``report.json``. Agent
transport is a local HTTP stub; the judge is the controlled offline collaborator
from ``test_judge_contract``. No external model, rerank provider or service is
called. The reranker's own protocol/cancel semantics live in
``src/retrieval/search/dedicated_reranker.test.ts`` and are not re-implemented
here.

What these tests require:
  * a missing rerank configuration is ``not_configured``/skipped, never coverage,
    even when the answer text mentions rerank (case-10)
  * case-10 still runs its answer-point and prohibited-assertion checks
  * a configured provider that never ran is ``not_exercised``
  * a provider failure keeps the explicit fused/unavailable source
  * only the controlled report/protocol branch may be marked exercised, and it
    is never counted as an online pass
  * malformed ordering evidence cannot claim coverage, and credentials never
    reach any retained artifact
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

import run_suite  # noqa: E402
from test_judge_contract import CASES, make_judge  # noqa: E402
from test_ledger import all_run_text, stub_backend, write_dataset  # noqa: E402
from test_reporting import case_reply, load_report  # noqa: E402

CASE_10 = "case-10-fusion-rerank"
CASE_04 = "hard-04-faq-exact-answer"
SECRET = "synthetic-rerank-canary-DO-NOT-PERSIST"
RERANK_MODEL = "bge-reranker-v2-m3"


@pytest.fixture(autouse=True)
def _no_ambient_dot_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A local repo-root .env must not change what this module proves."""
    monkeypatch.setattr(run_suite, "_dot_env", lambda key: "")


def retrieval_event(ordering: dict, reasons: tuple[str, ...] = ()) -> dict:
    return {
        "type": "progress",
        "stage": "retrieval",
        "status": "completed",
        "round": 1,
        "data": {
            "resultCount": 2,
            "finalContextRound": 1,
            "finalContextCandidates": [
                {
                    "rank": 1,
                    "documentId": "doc-1",
                    "chunkId": "chunk-1",
                    "score": 0.9,
                    "channels": ["vector"],
                }
            ],
            "finalContextOrdering": ordering,
            "degradedReasons": list(reasons),
        },
    }


def done_event(rerank_model: str | None = None) -> dict:
    result: dict = {
        "status": "completed",
        "degradation": {"status": "none", "unavailableChannels": []},
    }
    if rerank_model is not None:
        result["modelProfile"] = {
            "chatModel": "stub-chat",
            "rerankModel": rerank_model,
            "embeddingProfile": "stub-embedding:1",
        }
    return {"type": "done", "stage": "done", "status": "completed", "result": result}


def run_case(
    tmp_path: Path,
    name: str,
    *,
    reply: str | None = None,
    events: list[dict] | None = None,
    extra_payload: dict | None = None,
) -> run_suite.RunOutcome:
    dataset = write_dataset(tmp_path / "dataset.json", [CASES[name]])
    golden_reply, references = case_reply(CASES[name])
    payload = {"events": list(events or [])}
    payload.update(extra_payload or {})
    with stub_backend(
        {CASES[name]["input"]: reply or golden_reply},
        references={CASES[name]["input"]: references},
    ) as backend:
        backend.server.extra_payload = payload
        return run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=make_judge(),
            base_url=backend.base_url,
            password="stub-password",
        )


def capability(report: dict) -> dict:
    return report["sections"]["capabilities"]["rerank"]


def test_case_10_answer_checks_run_while_a_rerank_mention_is_not_coverage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("RERANK_API_KEY", raising=False)

    outcome = run_case(tmp_path, CASE_10)
    assert outcome.exit_code == 0, outcome.error
    report = load_report(outcome)

    rerank = capability(report)
    assert rerank["status"] == "not_configured"
    assert rerank["skipped"] is True
    assert rerank["counted_as_pass"] is False
    assert rerank["coverage"]["status"] == "incomplete"
    assert all(
        row["status"] == "incomplete" and row["counted_as_pass"] is False
        for row in rerank["coverage"]["matrix"]
    )

    # The answer does mention 精排 (its answer point), but the answer-point and
    # prohibited-assertion checks still run against the real case definition.
    case = report["sections"]["facts"]["cases"][0]
    assert case["case_id"] == CASE_10
    assert case["checks"]["answer_points"]["passed"] is True
    assert case["checks"]["prohibited_assertions"]["passed"] is True
    assert case["passed"] is True
    assert report["gate"]["incomplete"] is False
    assert SECRET not in all_run_text(outcome.run_dir)


def test_case_10_prohibited_assertion_still_fails_when_rerank_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("RERANK_API_KEY", raising=False)

    outcome = run_case(
        tmp_path,
        CASE_10,
        reply="融合之后会进入精排。未配置重排因此不会精排。 [cite:ref-1]。",
    )
    report = load_report(outcome)

    case = report["sections"]["facts"]["cases"][0]
    assert case["checks"]["answer_points"]["passed"] is True
    assert case["checks"]["prohibited_assertions"]["passed"] is False
    assert case["passed"] is False
    assert capability(report)["status"] == "not_configured"
    assert report["gate"]["incomplete"] is False


@pytest.mark.parametrize(
    "events",
    [
        [],
        [retrieval_event({"source": "fused", "reason": "below_threshold"}), done_event()],
    ],
    ids=["no_ordering_evidence", "below_threshold_not_called"],
)
def test_configured_but_never_called_is_not_exercised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, events: list[dict]
) -> None:
    monkeypatch.setenv("RERANK_API_KEY", SECRET)

    outcome = run_case(tmp_path, CASE_04, events=events)
    report = load_report(outcome)

    rerank = capability(report)
    assert rerank["status"] == "not_exercised"
    assert rerank["skipped"] is False
    assert rerank["counted_as_pass"] is False
    assert rerank["coverage"]["status"] == "incomplete"
    rows = {row["id"]: row for row in rerank["coverage"]["matrix"]}
    assert rows["provider_call"]["status"] == "incomplete"
    assert rows["provider_call"]["counted_as_pass"] is False
    assert rows["ordering"]["counted_as_pass"] is False
    assert SECRET not in all_run_text(outcome.run_dir)


def test_provider_failure_keeps_the_explicit_fused_degraded_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RERANK_API_KEY", SECRET)

    outcome = run_case(
        tmp_path,
        CASE_04,
        events=[
            retrieval_event(
                {"source": "fused", "reason": "unavailable"},
                reasons=("reranker_unavailable",),
            ),
            done_event(RERANK_MODEL),
        ],
    )
    report = load_report(outcome)

    rerank = capability(report)
    assert rerank["status"] == "degraded"
    assert rerank["source"] == "fused"
    assert rerank["degradation_reason"] == "unavailable"
    assert rerank["counted_as_pass"] is False
    assert rerank["coverage"]["status"] == "incomplete"
    assert rerank["coverage"]["counted_as_pass"] is False
    rows = {row["id"]: row for row in rerank["coverage"]["matrix"]}
    assert rows["ordering"]["status"] == "incomplete"
    assert rows["no_degradation"]["status"] == "incomplete"
    assert SECRET not in all_run_text(outcome.run_dir)


def test_controlled_dedicated_ordering_proves_only_the_protocol_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("RERANK_API_KEY", raising=False)
    monkeypatch.delenv("RERANK_MODEL", raising=False)
    # The recorded snapshot is pinned so the model-match row proves the branch
    # regardless of the machine's ambient model configuration.
    pinned_models = dict.fromkeys(run_suite.MODEL_ENV_NAMES)
    pinned_models["RERANK_MODEL"] = RERANK_MODEL
    monkeypatch.setattr(run_suite, "model_snapshot", lambda: dict(pinned_models))

    outcome = run_case(
        tmp_path,
        CASE_04,
        events=[
            retrieval_event({"source": "dedicated_rerank"}),
            done_event(RERANK_MODEL),
        ],
    )
    report = load_report(outcome)

    rerank = capability(report)
    assert rerank["status"] == "exercised"
    assert rerank["source"] == "dedicated_rerank"
    assert rerank["coverage"]["status"] == "complete"
    assert rerank["coverage_scope"] == "controlled"
    assert rerank["online_acceptance"] == "not_run"
    assert rerank["counted_as_pass"] is False
    assert rerank["coverage"]["counted_as_pass"] is False
    rows = {row["id"]: row for row in rerank["coverage"]["matrix"]}
    assert {row["status"] for row in rows.values()} == {"proven"}
    assert all(row["counted_as_pass"] for row in rows.values())

    # A rebuild re-derives the same honest projection from the raw record.
    rebuilt = run_suite.rebuild_run(outcome.run_dir)
    assert rebuilt.exit_code == 0, rebuilt.error
    assert capability(load_report(rebuilt))["status"] == "exercised"


def test_malformed_ordering_cannot_claim_coverage_and_keeps_credentials_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RERANK_API_KEY", SECRET)

    outcome = run_case(
        tmp_path,
        CASE_04,
        events=[
            # A fused source with no honest reason, plus a rerank model snapshot:
            # configuration presence and a model id must not become coverage.
            retrieval_event({"source": "fused"}),
            done_event(RERANK_MODEL),
        ],
        extra_payload={
            "debug": {
                "api_key": SECRET,
                "authorization": f"Bearer {SECRET}",
                "cookie": f"session={SECRET}",
            }
        },
    )
    report = load_report(outcome)

    rerank = capability(report)
    assert rerank["status"] == "invalid"
    assert rerank["counted_as_pass"] is False
    assert rerank["coverage"]["status"] == "incomplete"
    assert all(row["counted_as_pass"] is False for row in rerank["coverage"]["matrix"])
    assert SECRET not in all_run_text(outcome.run_dir)
    assert SECRET not in (outcome.run_dir / "report.md").read_text(encoding="utf-8")
