"""Bounded judge retries with a single retry layer (DR-05).

Every test runs the real judge runtime (DeepEval ``JevEval`` over
``TypeSafeModel``) against a local HTTP server that implements the TypeSafe
``/v1/systemone`` contract, so DeepEval's own retry decorator makes the
attempts. The Agent side is a local chat stub; no external model is called.

Invariants:
  * connection errors, timeouts, 429 and retryable 5xx retry within a
    3-attempt budget; the SDK does not add a second retry layer
  * permanent HTTP/region/invalid/low-score outcomes make exactly one request
    and are never converted into a pass
  * a judge retry never re-sends the chat request and the persisted Agent
    answer stays byte-identical and readable
  * request counts, per-attempt waits and the 10s/45s budget are in the run
    artifacts, and a previous success is never reused as this run's score
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

import fault_provider  # noqa: E402
import judge_runtime  # noqa: E402
import ledger  # noqa: E402
import run_suite  # noqa: E402
from test_ledger import case, read_json, stub_backend, write_dataset  # noqa: E402

ANSWER = "answer-a"
QUESTION = "question-a"


def run_judged(
    tmp_path: Path,
    steps: list[fault_provider.Step],
    *,
    default: fault_provider.Step | None = None,
    api_key: str = "test-typesafe-key",
    wrap_judge=None,
    **run_kwargs,
):
    """Run one sample through run_suite with the real judge on a fault server."""
    provider = fault_provider.FaultProvider(steps, default=default)
    dataset = write_dataset(
        tmp_path / "dataset.json", [case("case-a", QUESTION)]
    )
    judge = judge_runtime.make_judge(
        base_url=provider.base_url, api_key=api_key
    )
    if wrap_judge is not None:
        judge = wrap_judge(judge)
    with provider, stub_backend({QUESTION: ANSWER}) as backend:
        outcome = run_suite.execute_run(
            tmp_path / "runs",
            dataset_path=dataset,
            judge=judge,
            base_url=backend.base_url,
            password="stub-password",
            **run_kwargs,
        )
        backend_requests = backend.requests
    return outcome, provider, backend_requests


def judge_details(outcome) -> dict:
    sample_id = outcome.summary["samples"][0]["sample_id"]
    sample = read_json(outcome.run_dir / "samples" / f"{sample_id}.json")
    return sample["judge"]["details"]


def test_rate_limited_judge_retries_then_scores(tmp_path: Path) -> None:
    outcome, provider, chats = run_judged(
        tmp_path, [fault_provider.status(429), fault_provider.success(0.93)]
    )

    assert outcome.exit_code == 0
    assert outcome.incomplete is False
    assert outcome.score == pytest.approx(0.93, abs=1e-9)
    assert provider.request_count == 2
    assert all(item["path"] == "/v1/systemone" for item in provider.requests)
    assert len([item for item in chats if item["path"] == "/api/chat"]) == 1

    details = judge_details(outcome)
    assert details["request_count"] == 2
    assert [attempt["outcome"] for attempt in details["attempts"]] == [
        "http_error",
        "success",
    ]
    assert [attempt["http_status"] for attempt in details["attempts"]] == [429, 200]
    assert details["attempts"][1]["wait_before_ms"] > 0
    assert details["budget"]["max_attempts"] == 3
    assert details["budget"]["per_attempt_timeout_s"] == 10.0
    assert details["budget"]["task_timeout_s"] == 45.0
    assert details["budget"]["sdk_retries"] is False


@pytest.mark.parametrize(
    "name,steps,expected_outcomes",
    [
        (
            "connection-then-success",
            [fault_provider.drop(), fault_provider.success(0.8)],
            ["connection_error", "success"],
        ),
        (
            "429-then-success",
            [fault_provider.status(429), fault_provider.success(0.8)],
            ["http_error", "success"],
        ),
        (
            "503-then-success",
            [fault_provider.status(503), fault_provider.success(0.8)],
            ["http_error", "success"],
        ),
    ],
    ids=["connection", "429", "503"],
)
def test_transient_judge_failures_recover_within_three_attempts(
    tmp_path: Path, name: str, steps, expected_outcomes
) -> None:
    outcome, provider, _chats = run_judged(tmp_path, list(steps))

    assert outcome.exit_code == 0, outcome.error
    assert outcome.score == pytest.approx(0.8)
    assert provider.request_count <= 3
    details = judge_details(outcome)
    assert [attempt["outcome"] for attempt in details["attempts"]] == expected_outcomes
    assert details["request_count"] == len(expected_outcomes)
    assert details["termination"] == "scored"


def test_exhausted_retryable_5xx_stops_at_three_http_calls(tmp_path: Path) -> None:
    outcome, provider, _chats = run_judged(
        tmp_path, [fault_provider.status(503)]
    )

    assert outcome.exit_code == 1
    assert outcome.incomplete is True
    assert outcome.score is None
    assert provider.request_count == 3
    details = judge_details(outcome)
    assert details["request_count"] == 3
    assert len(details["attempts"]) == 3
    assert all(attempt["http_status"] == 503 for attempt in details["attempts"])
    assert details["error"]["error_class"] == "TypeSafeInternalServerError"
    assert details["termination"] == "attempts_exhausted"
    # No SDK retry header: a second retry layer would have produced more calls.
    assert all(
        "x-typesafe-retry-count" not in {key.lower() for key in item["headers"]}
        for item in provider.requests
    )


def assert_answer_still_readable(outcome) -> None:
    ledger_run = ledger.RunLedger.open(outcome.run_dir)
    sample_id = outcome.summary["samples"][0]["sample_id"]
    recovered = ledger_run.read_answer(sample_id)
    assert recovered["answer"] == ANSWER
    assert recovered["answer_sha256"] == hashlib.sha256(
        ANSWER.encode("utf-8")
    ).hexdigest()


def test_consecutive_connection_failures_end_in_an_explicit_error(tmp_path: Path) -> None:
    outcome, provider, _chats = run_judged(tmp_path, [fault_provider.drop()])

    assert outcome.exit_code == 1
    assert outcome.score is None
    assert provider.request_count == 3
    details = judge_details(outcome)
    assert details["request_count"] == 3
    assert details["error"]["error_family"] == "connection"
    assert details["error"]["error_class"] == "TypeSafeAPIConnectionError"
    assert details["error"]["wrapper_class"] == "RetryError"
    assert details["termination"] == "attempts_exhausted"
    assert all(attempt["outcome"] == "connection_error" for attempt in details["attempts"])
    # Observed waits between attempts are in the artifact and bounded.
    waits = [attempt["wait_before_ms"] for attempt in details["attempts"][1:]]
    assert len(waits) == 2
    assert all(0 < wait <= 6000 for wait in waits)
    assert details["total_ms"] <= 45_000
    assert_answer_still_readable(outcome)


def test_repeated_timeouts_respect_the_per_attempt_and_total_budget(
    tmp_path: Path,
) -> None:
    outcome, provider, _chats = run_judged(
        tmp_path, [fault_provider.hang(30.0)], default=fault_provider.hang(30.0)
    )

    assert outcome.exit_code == 1
    assert outcome.score is None
    assert provider.request_count == 3
    details = judge_details(outcome)
    assert details["request_count"] == 3
    assert details["error"]["error_family"] == "timeout"
    assert details["error"]["error_class"] in {
        "TimeoutError",
        "TypeSafeAPITimeoutError",
    }
    assert details["termination"] == "attempts_exhausted"
    assert details["budget"]["per_attempt_timeout_s"] == 10.0
    assert details["budget"]["task_timeout_s"] == 45.0
    # Each attempt was cut at the 10s per-attempt boundary, not left unbounded.
    # DeepEval's soft timeout and the SDK's 10s HTTP timeout coincide; either
    # may end an attempt first, so both sources are acceptable.
    for attempt in details["attempts"]:
        assert attempt["outcome"] == "timeout"
        assert attempt["duration_source"] in {
            "per_attempt_cap",
            "measured",
            "stopped_at_deadline",
        }
        assert 9_500 <= attempt["duration_ms"] <= 11_000, attempt
    assert details["total_ms"] < 45_000
    assert all(
        0 < attempt["wait_before_ms"] <= 6000 for attempt in details["attempts"][1:]
    )
    # A 45s metric budget bounds the whole call: no attempt arrives afterwards.
    count = provider.request_count
    time.sleep(0.5)
    assert provider.request_count == count
    assert_answer_still_readable(outcome)


def test_task_budget_stops_retries_before_the_attempt_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Same mechanism as the 10s/45s contract, tightened so the total cap, not
    # the attempt count, is what ends the call.
    monkeypatch.setenv("DEEPEVAL_RETRY_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS_OVERRIDE", "0.8")
    monkeypatch.setenv("DEEPEVAL_PER_TASK_TIMEOUT_SECONDS_OVERRIDE", "1.0")
    monkeypatch.setenv("DEEPEVAL_RETRY_CAP_SECONDS", "0")

    outcome, provider, _chats = run_judged(
        tmp_path, [fault_provider.hang(10.0)], default=fault_provider.hang(10.0)
    )

    assert outcome.exit_code == 1
    assert outcome.score is None
    details = judge_details(outcome)
    assert details["budget"]["max_attempts"] == 3
    assert details["budget"]["per_attempt_timeout_s"] == pytest.approx(0.8)
    assert details["budget"]["task_timeout_s"] == pytest.approx(1.0)
    assert details["error"]["error_family"] == "timeout"
    assert details["error"]["error_class"] == "TimeoutError"
    assert details["termination"] == "budget_stopped"
    assert details["request_count"] == 2
    assert provider.request_count == 2
    assert details["total_ms"] <= 1_500
    # The second attempt was cut by the remaining task budget (< per-attempt),
    # which is how a 45s total cap shortens later attempts.
    assert details["attempts"][1]["duration_source"] == "stopped_at_deadline"
    assert details["attempts"][1]["duration_ms"] < 500


@pytest.mark.parametrize(
    "code,error_class",
    [
        (401, "TypeSafeAuthenticationError"),
        (403, "TypeSafePermissionDeniedError"),
        (451, "TypeSafeAPIError"),
        (400, "TypeSafeBadRequestError"),
    ],
)
def test_permanent_judge_errors_make_exactly_one_request(
    tmp_path: Path, code: int, error_class: str
) -> None:
    outcome, provider, _chats = run_judged(tmp_path, [fault_provider.status(code)])

    assert outcome.exit_code == 1
    assert outcome.score is None
    assert provider.request_count == 1
    assert len([item for item in _chats if item["path"] == "/api/chat"]) == 1
    details = judge_details(outcome)
    assert details["request_count"] == 1
    assert details["termination"] == "not_retried"
    assert details["error"]["error_class"] == error_class
    assert details["error"]["error_family"] == "http"
    assert details["error"]["http_status"] == code
    assert len(details["attempts"]) == 1
    assert details["attempts"][0]["outcome"] == "http_error"
    assert details["attempts"][0]["http_status"] == code
    assert_answer_still_readable(outcome)


def test_low_judge_score_is_recorded_and_never_becomes_a_pass(tmp_path: Path) -> None:
    outcome, provider, _chats = run_judged(
        tmp_path, [fault_provider.success(0.05)]
    )

    assert outcome.exit_code == 0
    assert outcome.score == pytest.approx(0.05)
    assert provider.request_count == 1
    sample_id = outcome.summary["samples"][0]["sample_id"]
    sample = read_json(outcome.run_dir / "samples" / f"{sample_id}.json")
    assert sample["status"] == "scored"
    assert sample["judge"]["score"] == pytest.approx(0.05)
    assert sample["judge"]["success"] is False
    details = sample["judge"]["details"]
    assert details["threshold"] == 0.5
    assert details["request_count"] == 1
    assert details["termination"] == "scored"


def test_deterministic_invalid_response_is_not_retried(tmp_path: Path) -> None:
    outcome, provider, _chats = run_judged(
        tmp_path, [fault_provider.invalid_body()]
    )

    assert outcome.exit_code == 1
    assert outcome.score is None
    assert provider.request_count == 1
    details = judge_details(outcome)
    assert details["request_count"] == 1
    assert details["termination"] == "not_retried"
    assert details["error"]["error_class"] == "TypeSafeAPIResponseValidationError"
    assert_answer_still_readable(outcome)


def test_judge_has_exactly_one_retry_layer(tmp_path: Path) -> None:
    outcome, provider, _chats = run_judged(tmp_path, [fault_provider.status(500)])

    assert outcome.exit_code == 1
    # One DeepEval layer x one SDK attempt = 3 HTTP calls. A stacked SDK
    # retry layer (3 x 3) would show nine.
    assert provider.request_count == 3
    details = judge_details(outcome)
    assert details["request_count"] == 3
    assert details["budget"]["sdk_retries"] is False
    assert details["budget"]["sdk_retry_providers_set"] is False
    assert os.environ.get("DEEPEVAL_SDK_RETRY_PROVIDERS") is None
    assert all(
        "x-typesafe-retry-count" not in {key.lower() for key in item["headers"]}
        for item in provider.requests
    )


def test_sdk_retry_configuration_is_refused() -> None:
    for value in ("typesafe", "TYPESAFE", "*"):
        with pytest.raises(judge_runtime.JudgeConfigurationError):
            judge_runtime.configure_retry_environment(
                {"DEEPEVAL_SDK_RETRY_PROVIDERS": value}
            )
    applied = judge_runtime.configure_retry_environment({})
    assert applied["DEEPEVAL_RETRY_MAX_ATTEMPTS"] == "3"
    assert applied["DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS_OVERRIDE"] == "10"
    assert applied["DEEPEVAL_PER_TASK_TIMEOUT_SECONDS_OVERRIDE"] == "45"


def test_judge_retries_never_resend_chat_or_change_the_saved_answer(
    tmp_path: Path,
) -> None:
    snapshots: dict[str, bytes] = {}

    def observe(judge):
        def wrapped(record, context):
            snapshots["sample"] = Path(context["sample_path"]).read_bytes()
            snapshots["record"] = json.dumps(record, ensure_ascii=False).encode("utf-8")
            return judge(record, context)

        return wrapped

    outcome, provider, chats = run_judged(
        tmp_path,
        [fault_provider.status(503), fault_provider.status(503)],
        default=fault_provider.success(0.77),
        wrap_judge=observe,
    )

    assert outcome.exit_code == 0
    assert outcome.score == pytest.approx(0.77)
    assert provider.request_count == 3
    chat_calls = [item for item in chats if item["path"] == "/api/chat"]
    login_calls = [item for item in chats if item["path"] == "/api/auth/login"]
    assert len(chat_calls) == 1
    assert len(login_calls) == 1

    before = json.loads(snapshots["sample"].decode("utf-8"))
    assert before["agent"]["answer"] == ANSWER
    sample_id = outcome.summary["samples"][0]["sample_id"]
    after = read_json(outcome.run_dir / "samples" / f"{sample_id}.json")
    # The raw Agent record is unchanged by three judge attempts.
    assert after["agent"] == before["agent"]
    assert json.dumps(after["agent"], ensure_ascii=False).encode("utf-8") == json.dumps(
        before["agent"], ensure_ascii=False
    ).encode("utf-8")
    assert after["agent"]["answer_sha256"] == hashlib.sha256(
        ANSWER.encode("utf-8")
    ).hexdigest()
    assert after["judge"]["details"]["answer"]["source"] == "ledger.read_answer"
    assert after["judge"]["details"]["request_count"] == 3
    assert_answer_still_readable(outcome)


def test_a_previous_success_is_never_reused_and_artifacts_are_observable(
    tmp_path: Path,
) -> None:
    first, _provider, _chats = run_judged(tmp_path, [fault_provider.success(0.9)])
    assert first.exit_code == 0 and first.score == pytest.approx(0.9)
    first_summary = (first.run_dir / "summary.json").read_bytes()

    second, second_provider, _chats = run_judged(
        tmp_path, [fault_provider.status(400)]
    )
    assert second.run_dir != first.run_dir
    assert second.exit_code == 1
    assert second.score is None
    assert second.incomplete is True
    assert second_provider.request_count == 1
    assert (first.run_dir / "summary.json").read_bytes() == first_summary

    details = judge_details(second)
    assert details["request_count"] == 1
    assert details["attempts"][0]["http_status"] == 400
    assert details["waits_ms"] == []
    assert details["total_ms"] is not None
    assert details["budget"]["max_attempts"] == 3
    assert details["budget"]["per_attempt_timeout_s"] == 10.0
    assert details["budget"]["task_timeout_s"] == 45.0

    environment = read_json(second.run_dir / "environment.json")
    budgets = environment["configuration"]["budgets"]
    assert budgets["judge_attempts"] == 3
    assert budgets["judge_attempt_timeout_s"] == 10.0
    assert budgets["judge_task_timeout_s"] == 45.0
    assert budgets["judge_sdk_retries"] is False


def test_cli_judge_spec_drives_the_bounded_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = fault_provider.FaultProvider(
        [fault_provider.status(503)], default=fault_provider.success(0.66)
    )
    dataset = write_dataset(tmp_path / "dataset.json", [case("case-a", QUESTION)])
    env = {
        **os.environ,
        "DEMO_OIDC_PASSWORD": "stub-password",
        "TYPESAFE_API_KEY": "test-typesafe-key",
        "NEXUSRAG_JUDGE_BASE_URL": provider.base_url,
        "DEEPEVAL_TELEMETRY_OPT_OUT": "YES",
        "PYTHONIOENCODING": "utf-8",
    }
    with provider, stub_backend({QUESTION: ANSWER}) as backend:
        completed = subprocess.run(
            [
                sys.executable,
                str(EVAL_DIR / "run_suite.py"),
                "--runs-root",
                str(tmp_path / "runs"),
                "--dataset",
                str(dataset),
                "--case",
                "case-a",
                "--judge",
                f"{EVAL_DIR / 'judge_runtime.py'}:judge",
                "--base-url",
                backend.base_url,
            ],
            cwd=str(EVAL_DIR),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout.strip().splitlines()[-1])
    assert payload["score"] == pytest.approx(0.66)
    assert provider.request_count == 2
    sample_id = payload["samples"][0]["sample_id"]
    sample = read_json(Path(payload["run_dir"]) / "samples" / f"{sample_id}.json")
    assert sample["judge"]["details"]["request_count"] == 2
    assert [attempt["outcome"] for attempt in sample["judge"]["details"]["attempts"]] == [
        "http_error",
        "success",
    ]
